//! Internal, zero-custody protocol process. It never accepts a signer or payment proof.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::str::FromStr;
use std::time::Duration;

use base64::Engine;
use pay_core::client::runner::{RunOutcome, classify_402};
use pay_kit::x402::exact::{PaymentRequirements, SOLANA_DEVNET, SOLANA_MAINNET};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_INPUT: usize = 65_536;
const MAX_RESPONSE: usize = 65_536;
const MAINNET_USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Input {
    Quote {
        url: String,
        method: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        body: Option<String>,
    },
    Prepare {
        payer: String,
        #[serde(rename = "rpcUrl")]
        rpc_url: String,
        requirement: Value,
    },
    Interpret {
        status: u16,
        headers: BTreeMap<String, String>,
    },
}

type SafeResult<T> = Result<T, &'static str>;

fn loopback_url(raw: &str) -> SafeResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw).map_err(|_| "INVALID_URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("LOOPBACK_ONLY");
    }
    Ok(url)
}

fn client() -> SafeResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "HTTP_CLIENT_UNAVAILABLE")
}

fn read_bounded(response: reqwest::blocking::Response) -> SafeResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE as u64)
    {
        return Err("RESPONSE_TOO_LARGE");
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "RESPONSE_UNREADABLE")?;
    if bytes.len() > MAX_RESPONSE {
        return Err("RESPONSE_TOO_LARGE");
    }
    Ok(bytes)
}

fn validate_requirement(requirement: &PaymentRequirements) -> SafeResult<()> {
    let mint = match requirement.network.as_str() {
        SOLANA_MAINNET => MAINNET_USDC,
        SOLANA_DEVNET => DEVNET_USDC,
        _ => return Err("UNSUPPORTED_NETWORK"),
    };
    let amount = requirement
        .amount
        .parse::<u64>()
        .map_err(|_| "INVALID_AMOUNT")?;
    if amount == 0 || amount.to_string() != requirement.amount {
        return Err("INVALID_AMOUNT");
    }
    let accepted = requirement.to_accepted_value();
    let extra = accepted
        .get("extra")
        .and_then(Value::as_object)
        .ok_or("INVALID_REQUIREMENT_EXTRA")?;
    for (key, supported) in [
        ("paymentFlow", "authorization"),
        ("assetTransferMethod", "default"),
    ] {
        if extra
            .get(key)
            .is_some_and(|value| !value.is_null() && value.as_str() != Some(supported))
        {
            return Err("UNSUPPORTED_PAYMENT_TERMS");
        }
    }
    if requirement
        .token_program
        .as_deref()
        .is_some_and(|value| value != TOKEN_PROGRAM)
    {
        return Err("UNSUPPORTED_TOKEN_PROGRAM");
    }
    if requirement.max_age.is_none_or(|age| age == 0 || age > 600) {
        return Err("INVALID_QUOTE_TIMEOUT");
    }
    if extra.get("memo").is_some_and(|value| {
        value
            .as_str()
            .is_none_or(|memo| memo.is_empty() || memo.len() > 256)
    }) {
        return Err("INVALID_QUOTE_MEMO");
    }
    let fee_payer = extra
        .get("feePayer")
        .and_then(Value::as_str)
        .ok_or("INVALID_FEE_PAYER")?;
    solana_pubkey::Pubkey::from_str(fee_payer).map_err(|_| "INVALID_FEE_PAYER")?;
    // Reject legacy alias fields that would make the Rust builder consume
    // different terms from the exact canonical accepted object Yosh authorizes.
    if requirement.fee_payer != Some(true)
        || requirement.fee_payer_key.as_deref() != Some(fee_payer)
        || accepted.get("network").and_then(Value::as_str) != Some(requirement.network.as_str())
        || accepted.get("amount").and_then(Value::as_str) != Some(requirement.amount.as_str())
        || accepted.get("asset").and_then(Value::as_str) != Some(requirement.currency.as_str())
        || accepted.get("payTo").and_then(Value::as_str) != Some(requirement.recipient.as_str())
    {
        return Err("NONCANONICAL_REQUIREMENT");
    }
    if requirement.currency != mint
        || requirement.decimals != Some(6)
        || requirement
            .to_accepted_value()
            .get("scheme")
            .and_then(Value::as_str)
            != Some("exact")
        || requirement
            .transaction_versions
            .as_ref()
            .is_some_and(|versions| !versions.contains(&pay_kit::core::tx::TxVersion::V0))
    {
        return Err("UNSUPPORTED_EXACT_USDC_REQUIREMENT");
    }
    solana_pubkey::Pubkey::from_str(&requirement.recipient).map_err(|_| "INVALID_RECIPIENT")?;
    Ok(())
}

fn quote(
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
) -> SafeResult<Value> {
    let target = loopback_url(&url)?;
    let method = match method.as_str() {
        "GET" if body.is_none() => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err("UNSUPPORTED_METHOD"),
    };
    if body.as_ref().is_some_and(|value| value.len() > 16_384) {
        return Err("REQUEST_TOO_LARGE");
    }
    let mut request = client()?.request(method, target);
    for (name, value) in headers {
        // The protocol child never receives or forwards caller credentials.
        if !["accept", "content-type"].contains(&name.to_ascii_lowercase().as_str())
            || value.len() > 1024
        {
            return Err("REQUEST_HEADER_FORBIDDEN");
        }
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().map_err(|_| "CHALLENGE_FETCH_FAILED")?;
    if response.status().as_u16() != 402 {
        return Err("PAYMENT_CHALLENGE_REQUIRED");
    }
    let header = response
        .headers()
        .get("payment-required")
        .and_then(|value| value.to_str().ok())
        .ok_or("V2_HEADER_REQUIRED")?;
    if header.len() > 24_576 {
        return Err("CHALLENGE_TOO_LARGE");
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(header)
        .map_err(|_| "INVALID_CHALLENGE")?;
    let challenge: Value = serde_json::from_slice(&raw).map_err(|_| "INVALID_CHALLENGE")?;
    if challenge.get("x402Version").and_then(Value::as_u64) != Some(2)
        || challenge
            .get("extensions")
            .is_some_and(|value| !value.is_null())
        || challenge
            .get("accepts")
            .and_then(Value::as_array)
            .is_none_or(|values| values.is_empty() || values.len() > 16)
    {
        return Err("UNSUPPORTED_CHALLENGE");
    }
    let headers = vec![("payment-required".to_string(), header.to_string())];
    let body = read_bounded(response)?;
    let text = std::str::from_utf8(&body).map_err(|_| "INVALID_CHALLENGE_BODY")?;
    let classified = classify_402(&headers, Some(text), &url);
    // Preserve the real protocol classifier's fail-closed outcome. Its SDK
    // prefers Mainnet when offered, but also recognizes Devnet-only fixtures.
    let (mut requirement, classifier) = match classified {
        RunOutcome::X402Challenge { challenge, .. } => {
            if challenge.x402_version != 2
                || challenge.siwx.is_some()
                || challenge.extensions.is_some()
            {
                return Err("UNSUPPORTED_CHALLENGE");
            }
            (challenge.requirements, "pay-core")
        }
        _ => return Err("UNSUPPORTED_CHALLENGE"),
    };
    validate_requirement(&requirement)?;
    // Keep request identity explicit even when the parser's requirement lacked resource.
    requirement.resource = url;
    Ok(
        json!({"challenge":challenge,"requirement":requirement.to_accepted_value(),"classifier":classifier}),
    )
}

fn prepare(payer: String, rpc_url: String, requirement: Value) -> SafeResult<Value> {
    let target = loopback_url(&rpc_url)?;
    let mut requirement: PaymentRequirements =
        serde_json::from_value(requirement).map_err(|_| "INVALID_REQUIREMENT")?;
    validate_requirement(&requirement)?;
    let payer = solana_pubkey::Pubkey::from_str(&payer).map_err(|_| "INVALID_PAYER")?;
    // Bound and validate the RPC transport ourselves. The SDK sees a supplied
    // blockhash and therefore cannot initiate a hidden redirect/proxy RPC request.
    let response = client()?.post(target).json(&json!({"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}))
        .send().map_err(|_| "BLOCKHASH_FETCH_FAILED")?;
    if !response.status().is_success() {
        return Err("BLOCKHASH_FETCH_FAILED");
    }
    let result: Value =
        serde_json::from_slice(&read_bounded(response)?).map_err(|_| "INVALID_RPC_RESPONSE")?;
    if result.get("error").is_some() {
        return Err("RPC_REJECTED");
    }
    let value = result
        .get("result")
        .and_then(|value| value.get("value"))
        .ok_or("INVALID_RPC_RESPONSE")?;
    let blockhash = value
        .get("blockhash")
        .and_then(Value::as_str)
        .ok_or("INVALID_RPC_RESPONSE")?;
    let height = value
        .get("lastValidBlockHeight")
        .and_then(Value::as_u64)
        .ok_or("INVALID_RPC_RESPONSE")?;
    if requirement
        .recent_blockhash
        .as_deref()
        .is_some_and(|expected| expected != blockhash)
    {
        return Err("CHALLENGE_BLOCKHASH_MISMATCH");
    }
    requirement.recent_blockhash = Some(blockhash.to_string());
    let rpc = pay_kit::x402::solana_rpc_client::rpc_client::RpcClient::new_with_timeout(
        rpc_url,
        Duration::from_secs(5),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "RUNTIME_UNAVAILABLE")?;
    let transaction = runtime
        .block_on(pay_kit::x402::client::exact::prepare_unsigned_payment(
            &payer,
            &rpc,
            &requirement,
            Some(pay_kit::core::tx::TxVersion::V0),
        ))
        .map_err(|_| "UNSIGNED_PREPARE_FAILED")?;
    if transaction
        .signatures
        .iter()
        .any(|signature| signature.as_ref().iter().any(|byte| *byte != 0))
    {
        return Err("SIGNED_TRANSACTION_FORBIDDEN");
    }
    let transaction =
        pay_kit::core::tx::encode(&transaction).map_err(|_| "WIRE_ENCODING_FAILED")?;
    Ok(
        json!({"transaction":transaction,"recentBlockhash":blockhash,"lastValidBlockHeight":height.to_string()}),
    )
}

fn interpret(status: u16, headers: BTreeMap<String, String>) -> SafeResult<Value> {
    if !(100..=599).contains(&status) {
        return Err("INVALID_STATUS");
    }
    let mut safe_headers = Vec::new();
    for (name, value) in headers {
        // This operation is given only sanitized protocol observations, never a
        // PAYMENT-SIGNATURE, signed transaction or arbitrary response reflection.
        if !["payment-response", "content-type"].contains(&name.to_ascii_lowercase().as_str())
            || value.len() > 8192
        {
            return Err("RESPONSE_HEADER_FORBIDDEN");
        }
        safe_headers.push((name, value));
    }
    let receipt = pay_core::client::receipt::decode_response_receipt(&safe_headers);
    let receipt = match receipt {
        Some(receipt) if receipt.protocol.as_str() == "x402" => {
            let network = receipt
                .network
                .filter(|value| [SOLANA_DEVNET, SOLANA_MAINNET].contains(&value.as_str()));
            let success = receipt.decoded.get("success").and_then(Value::as_bool);
            if network.is_none() || success.is_none() {
                return Err("INVALID_RECEIPT");
            }
            if receipt.decoded.as_object().is_none_or(|value| {
                value
                    .keys()
                    .any(|key| !["success", "network", "payer", "amount"].contains(&key.as_str()))
            }) {
                return Err("UNSAFE_RECEIPT_FIELDS");
            }
            let payer = receipt
                .decoded
                .get("payer")
                .and_then(Value::as_str)
                .filter(|value| solana_pubkey::Pubkey::from_str(value).is_ok());
            let mut observation = json!({"network":network,"success":success});
            if let Some(payer) = payer {
                observation["payer"] = json!(payer);
            }
            observation
        }
        Some(_) => return Err("UNSUPPORTED_RECEIPT"),
        None => Value::Null,
    };
    Ok(json!({"receipt":receipt,"repeatedPaymentRequired":status == 402}))
}

fn execute(input: Input) -> SafeResult<Value> {
    match input {
        Input::Quote {
            url,
            method,
            headers,
            body,
        } => quote(url, method, headers, body),
        Input::Prepare {
            payer,
            rpc_url,
            requirement,
        } => prepare(payer, rpc_url, requirement),
        Input::Interpret { status, headers } => interpret(status, headers),
    }
}

fn main() {
    let mut raw = Vec::new();
    let result = std::io::stdin()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "INPUT_UNREADABLE")
        .and_then(|_| {
            if raw.len() > MAX_INPUT {
                return Err("INPUT_TOO_LARGE");
            }
            serde_json::from_slice::<Input>(&raw).map_err(|_| "INVALID_INPUT")
        })
        .and_then(execute);
    let output = match result {
        Ok(Value::Object(mut value)) => {
            value.insert("ok".to_string(), Value::Bool(true));
            Value::Object(value)
        }
        Ok(_) => json!({"ok":false,"error":"INVALID_OUTPUT"}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    if let Ok(bytes) = serde_json::to_vec(&output) {
        let _ = std::io::stdout().write_all(&bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_and_credentialed_urls_are_rejected() {
        for url in [
            "https://api.example.com/x",
            "http://localhost:80/x",
            "http://127.0.0.1:81/x#fragment",
            "http://user@127.0.0.1:81/x",
        ] {
            assert!(loopback_url(url).is_err());
        }
        assert!(loopback_url("http://127.0.0.1:12345/x").is_ok());
    }

    #[test]
    fn signed_inputs_and_arbitrary_headers_are_rejected() {
        assert!(serde_json::from_value::<Input>(json!({"operation":"prepare","payer":"x","rpcUrl":"http://127.0.0.1:12345","requirement":{},"signature":"secret"})).is_err());
        assert_eq!(
            interpret(
                200,
                BTreeMap::from([("payment-signature".to_string(), "secret".to_string())])
            ),
            Err("RESPONSE_HEADER_FORBIDDEN")
        );
    }

    #[test]
    fn malformed_receipts_never_become_economic_success() {
        assert_eq!(
            interpret(
                200,
                BTreeMap::from([("payment-response".to_string(), "untrusted".to_string())])
            ),
            Err("INVALID_RECEIPT")
        );
        assert_eq!(
            interpret(402, BTreeMap::new()).unwrap()["repeatedPaymentRequired"],
            true
        );
        assert!(interpret(200, BTreeMap::new()).unwrap()["receipt"].is_null());
        let encoded =
            |value: Value| base64::engine::general_purpose::STANDARD.encode(value.to_string());
        let safe = encoded(json!({"success":true,"network":SOLANA_DEVNET,"amount":"200000"}));
        assert_eq!(
            interpret(
                200,
                BTreeMap::from([("payment-response".to_string(), safe)])
            )
            .unwrap()["receipt"]["success"],
            true
        );
        let unsafe_receipt = encoded(
            json!({"success":true,"network":SOLANA_DEVNET,"transaction":"retained-credential"}),
        );
        assert_eq!(
            interpret(
                200,
                BTreeMap::from([("payment-response".to_string(), unsafe_receipt)])
            ),
            Err("UNSAFE_RECEIPT_FIELDS")
        );
    }
}
