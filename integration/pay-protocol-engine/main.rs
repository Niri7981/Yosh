//! Internal protocol process. It never accepts a signer or submits a payment.
//! MPP credential encoding accepts signed wire bytes only to format the SDK envelope;
//! all MPP operations are offline and the host retains authorization and egress.
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
    #[serde(rename = "mpp_parse")]
    MppParse { header: String },
    #[serde(rename = "mpp_prepare")]
    MppPrepare {
        header: String,
        payer: String,
        #[serde(rename = "hostValidatedLifetime")]
        host_validated_lifetime: HostValidatedLifetime,
    },
    #[serde(rename = "mpp_encode")]
    MppEncode { header: String, transaction: String },
    #[serde(rename = "mpp_receipt")]
    MppReceipt { header: String },
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostValidatedLifetime {
    recent_blockhash: String,
    last_valid_block_height: String,
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

// This is a policy guard over the SDK parser, not a replacement parser. In
// particular the pinned SDK drops the newer `header` selector, so reject it
// before parsing instead of silently sending a credential to the wrong field.
fn mpp_parameter_policy(header: &str) -> SafeResult<()> {
    if header.len() > 24_576 || header.contains(['\r', '\n']) {
        return Err("MPP_INVALID_CHALLENGE");
    }
    let bytes = header.as_bytes();
    if bytes.len() < 8 || !bytes[..7].eq_ignore_ascii_case(b"Payment") || bytes[7] != b' ' {
        return Err("MPP_INVALID_CHALLENGE");
    }
    let mut index = 8;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        // Repeated HTTP authentication fields may be joined by the transport.
        // Check raw parameter names in every offer before the SDK can discard
        // unknown fields; challenge splitting and decoding remain SDK-owned.
        if bytes.get(index..index + 8).is_some_and(|value| value.eq_ignore_ascii_case(b"Payment ")) {
            index += 8;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_alphabetic() { index += 1; }
        let key = &header[start..index];
        if !["id", "realm", "method", "intent", "request", "expires", "description", "opaque"].contains(&key)
            || bytes.get(index) != Some(&b'=') || bytes.get(index + 1) != Some(&b'"') {
            return Err("MPP_UNSUPPORTED_CHALLENGE_PARAMETER");
        }
        index += 2;
        let mut closed = false;
        while index < bytes.len() {
            match bytes[index] {
                b'\\' => { index += 2; }
                b'"' => { index += 1; closed = true; break; }
                _ => index += 1,
            }
        }
        if !closed { return Err("MPP_INVALID_CHALLENGE"); }
        while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        if index == bytes.len() { break; }
        if bytes[index] != b',' { return Err("MPP_INVALID_CHALLENGE"); }
        index += 1;
        if index == bytes.len() { return Err("MPP_INVALID_CHALLENGE"); }
    }
    Ok(())
}

fn mpp_challenge(header: &str) -> SafeResult<(pay_kit::mpp::PaymentChallenge, pay_kit::mpp::ChargeRequest, pay_kit::mpp::protocol::solana::MethodDetails)> {
    mpp_parameter_policy(header)?;
    let challenge = pay_kit::mpp::parse_www_authenticate(header).map_err(|_| "MPP_INVALID_CHALLENGE")?;
    if challenge.method.as_str() != "solana" || challenge.intent.as_str() != "charge" {
        return Err("MPP_UNSUPPORTED_METHOD_INTENT");
    }
    let expires = challenge.expires.as_deref().ok_or("MPP_EXPIRY_REQUIRED")?;
    // Admit UTC RFC3339 seconds or milliseconds only, then let the SDK validate
    // the calendar/time and reject expired values. This bounds the quote window.
    if ![20, 24].contains(&expires.len()) || !expires.is_ascii() || !expires.ends_with('Z')
        || challenge.is_expired() || expires[..19] > pay_kit::mpp::expires::seconds(600)[..19] {
        return Err("MPP_INVALID_EXPIRY");
    }
    let request_value: Value = challenge.request.decode().map_err(|_| "MPP_INVALID_REQUEST")?;
    let object = request_value.as_object().ok_or("MPP_INVALID_REQUEST")?;
    if object.keys().any(|key| !["amount", "currency", "recipient", "description", "externalId", "methodDetails"].contains(&key.as_str())) {
        return Err("MPP_UNSUPPORTED_REQUEST_FIELD");
    }
    let request: pay_kit::mpp::ChargeRequest = serde_json::from_value(request_value).map_err(|_| "MPP_INVALID_REQUEST")?;
    let amount = request.amount.parse::<u64>().map_err(|_| "MPP_INVALID_AMOUNT")?;
    if amount == 0 || amount.to_string() != request.amount { return Err("MPP_INVALID_AMOUNT"); }
    let details_value = request.method_details.as_ref().ok_or("MPP_METHOD_DETAILS_REQUIRED")?;
    let details_object = details_value.as_object().ok_or("MPP_INVALID_METHOD_DETAILS")?;
    if details_object.keys().any(|key| !["network", "decimals", "tokenProgram", "feePayer", "recentBlockhash", "transactionVersions"].contains(&key.as_str())) {
        return Err("MPP_UNSUPPORTED_METHOD_DETAILS");
    }
    let details: pay_kit::mpp::protocol::solana::MethodDetails = serde_json::from_value(details_value.clone()).map_err(|_| "MPP_INVALID_METHOD_DETAILS")?;
    let mint = match details.network.as_deref() {
        Some("mainnet") => MAINNET_USDC,
        Some("devnet") => DEVNET_USDC,
        _ => return Err("MPP_UNSUPPORTED_NETWORK"),
    };
    if request.currency != mint || details.decimals != Some(6) || details.token_program.as_deref() != Some(TOKEN_PROGRAM)
        || details.fee_payer == Some(true) || details_object.get("feePayer").is_some_and(Value::is_null)
        || details.transaction_versions.as_ref().is_some_and(|versions| versions.as_slice() != [pay_kit::core::tx::TxVersion::V0])
        || details_object.get("transactionVersions").is_some_and(Value::is_null) {
        return Err("MPP_UNSUPPORTED_PAYMENT_TERMS");
    }
    let recipient = request.recipient.as_deref().ok_or("MPP_RECIPIENT_REQUIRED")?;
    solana_pubkey::Pubkey::from_str(recipient).map_err(|_| "MPP_INVALID_RECIPIENT")?;
    if let Some(memo) = request.external_id.as_deref() {
        if memo.is_empty() || memo.len() > 256 { return Err("MPP_INVALID_MEMO"); }
    }
    if let Some(blockhash) = details.recent_blockhash.as_deref() {
        solana_pubkey::Pubkey::from_str(blockhash).map_err(|_| "MPP_INVALID_BLOCKHASH")?;
    }
    Ok((challenge, request, details))
}

fn mpp_parse(header: String) -> SafeResult<Value> {
    mpp_parameter_policy(&header)?;
    let offers = pay_kit::mpp::parse_www_authenticate_all([header.as_str()]);
    if offers.len() > 16 { return Err("MPP_INVALID_CHALLENGE"); }
    let mut selected = None;
    for offer in offers {
        let challenge = offer.map_err(|_| "MPP_INVALID_CHALLENGE")?;
        if challenge.method.as_str() != "solana" || challenge.intent.as_str() != "charge" { continue; }
        if selected.is_some() { return Err("MPP_AMBIGUOUS_CHALLENGE"); }
        selected = Some(challenge);
    }
    let selected = selected.ok_or("MPP_UNSUPPORTED_METHOD_INTENT")?;
    let header = pay_kit::mpp::format_www_authenticate(&selected).map_err(|_| "MPP_INVALID_CHALLENGE")?;
    let (challenge, request, _) = mpp_challenge(&header)?;
    Ok(json!({"header":header,"challenge":challenge,"request":request}))
}

/// This sender attests only the host-provided lifetime, already validated by
/// Yosh against its configured network. It has no HTTP transport or fallback.
struct HostValidatedBlockhashSender(String);
impl pay_kit::mpp::solana_rpc_client::rpc_sender::RpcSender for HostValidatedBlockhashSender {
    fn send<'life0, 'async_trait>(
        &'life0 self,
        request: pay_kit::mpp::solana_rpc_client::api::request::RpcRequest,
        params: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = pay_kit::mpp::solana_rpc_client::api::client_error::Result<Value>> + Send + 'async_trait>>
    where 'life0: 'async_trait, Self: 'async_trait {
        Box::pin(async move {
            use pay_kit::mpp::solana_rpc_client::api::{client_error::ErrorKind, request::RpcRequest};
            if request != RpcRequest::IsBlockhashValid || params != json!([self.0, {"commitment":"confirmed"}]) {
                return Err(ErrorKind::Custom("HOST_VALIDATED_RPC_REQUEST_FORBIDDEN".into()).into());
            }
            Ok(json!({"context":{"slot":0},"value":true}))
        })
    }
    fn get_transport_stats(&self) -> pay_kit::mpp::solana_rpc_client::rpc_sender::RpcTransportStats { Default::default() }
    fn url(&self) -> String { "host-validated-lifetime:no-network".into() }
}

fn mpp_prepare(header: String, payer: String, lifetime: HostValidatedLifetime) -> SafeResult<Value> {
    let (_, request, mut details) = mpp_challenge(&header)?;
    let payer = solana_pubkey::Pubkey::from_str(&payer).map_err(|_| "MPP_INVALID_PAYER")?;
    solana_pubkey::Pubkey::from_str(&lifetime.recent_blockhash).map_err(|_| "MPP_INVALID_BLOCKHASH")?;
    let height = lifetime.last_valid_block_height.parse::<u64>().map_err(|_| "MPP_INVALID_LIFETIME")?;
    if height == 0 || height > 9_007_199_254_740_991 || height.to_string() != lifetime.last_valid_block_height {
        return Err("MPP_INVALID_LIFETIME");
    }
    // Solana Charge recentBlockhash is advisory. Use the host's fresh, exact
    // RPC lifetime so signing never invents an expiry height for a merchant hash.
    // Only this local construction copy changes; the credential echoes the
    // original challenge, including its unmodified request and challenge ID.
    details.recent_blockhash = Some(lifetime.recent_blockhash.clone());
    let rpc = pay_kit::mpp::solana_rpc_client::rpc_client::RpcClient::new_sender(
        HostValidatedBlockhashSender(lifetime.recent_blockhash.clone()), Default::default());
    let options = pay_kit::mpp::client::BuildChargeTransactionOptions {
        max_tx_version: Some(pay_kit::core::tx::TxVersion::V0),
        external_id: request.external_id.clone(),
        payer_funded_ata_creation: pay_kit::mpp::client::PayerFundedAtaCreation::Decline,
        ..Default::default()
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "RUNTIME_UNAVAILABLE")?;
    let prepared = runtime.block_on(pay_kit::mpp::client::build_prepared_charge(payer, &rpc,
        request.amount.parse().map_err(|_| "MPP_INVALID_AMOUNT")?, &request.currency,
        request.recipient.as_deref().ok_or("MPP_RECIPIENT_REQUIRED")?, &details, &options))
        .map_err(|_| "MPP_UNSIGNED_PREPARE_FAILED")?;
    if prepared.transaction.signatures.iter().any(|signature| signature.as_ref().iter().any(|byte| *byte != 0)) {
        return Err("SIGNED_TRANSACTION_FORBIDDEN");
    }
    let transaction = pay_kit::core::tx::encode(&prepared.transaction).map_err(|_| "WIRE_ENCODING_FAILED")?;
    Ok(json!({"transaction":transaction,"recentBlockhash":lifetime.recent_blockhash,"lastValidBlockHeight":lifetime.last_valid_block_height}))
}

fn mpp_encode(header: String, transaction: String) -> SafeResult<Value> {
    let (challenge, _, _) = mpp_challenge(&header)?;
    if transaction.len() > 1644 { return Err("MPP_INVALID_TRANSACTION"); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&transaction).map_err(|_| "MPP_INVALID_TRANSACTION")?;
    if bytes.len() > 1232 || base64::engine::general_purpose::STANDARD.encode(&bytes) != transaction {
        return Err("MPP_INVALID_TRANSACTION");
    }
    pay_kit::core::tx::decode_bytes(&bytes).map_err(|_| "MPP_INVALID_TRANSACTION")?;
    let credential = pay_kit::mpp::PaymentCredential::new(challenge.to_echo(),
        pay_kit::mpp::protocol::solana::CredentialPayload::Transaction { transaction });
    let authorization = pay_kit::mpp::format_authorization(&credential).map_err(|_| "MPP_CREDENTIAL_ENCODING_FAILED")?;
    Ok(json!({"authorization":authorization}))
}

fn mpp_receipt(header: String) -> SafeResult<Value> {
    if header.len() > 16_384 { return Err("MPP_INVALID_RECEIPT"); }
    let parsed = pay_kit::mpp::parse_receipt(&header).map_err(|_| "MPP_INVALID_RECEIPT")?;
    let pay_kit::mpp::ReceiptKind::Charge(receipt) = parsed else { return Err("MPP_UNSUPPORTED_RECEIPT"); };
    if receipt.method.as_str() != "solana" || !receipt.is_success() || receipt.reference.is_empty() || receipt.reference.len() > 128 {
        return Err("MPP_INVALID_RECEIPT");
    }
    Ok(json!({"receipt":{"method":"solana","status":"success","timestamp":receipt.timestamp,"reference":receipt.reference}}))
}

fn execute(input: Input) -> SafeResult<Value> {
    match input {
        Input::MppParse { header } => mpp_parse(header),
        Input::MppPrepare { header, payer, host_validated_lifetime } => mpp_prepare(header, payer, host_validated_lifetime),
        Input::MppEncode { header, transaction } => mpp_encode(header, transaction),
        Input::MppReceipt { header } => mpp_receipt(header),
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
    fn host_validated_sender_accepts_only_the_pinned_hash_and_commitment() {
        use pay_kit::mpp::solana_rpc_client::{api::request::RpcRequest, rpc_sender::RpcSender};
        let sender = HostValidatedBlockhashSender("11111111111111111111111111111111".into());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(runtime.block_on(sender.send(RpcRequest::IsBlockhashValid,
            json!(["11111111111111111111111111111111", {"commitment":"confirmed"}]))).is_ok());
        for (request, params) in [
            (RpcRequest::GetLatestBlockhash, json!([])),
            (RpcRequest::GetAccountInfo, json!([])),
            (RpcRequest::SendTransaction, json!(["forbidden"])),
            (RpcRequest::IsBlockhashValid, json!(["other", {"commitment":"confirmed"}])),
            (RpcRequest::IsBlockhashValid, json!(["11111111111111111111111111111111", {"commitment":"processed"}])),
        ] {
            assert!(runtime.block_on(sender.send(request, params)).is_err());
        }
    }

    #[test]
    fn mpp_does_not_accept_an_rpc_url_or_a_signer() {
        for field in ["rpcUrl", "signer", "privateKey"] {
            let mut input = json!({"operation":"mpp_prepare","header":"Payment x", "payer":"public",
                "hostValidatedLifetime":{"recentBlockhash":"public", "lastValidBlockHeight":"1"}});
            input[field] = json!("forbidden");
            assert!(serde_json::from_value::<Input>(input).is_err());
        }
    }

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
