//! Trusted Yosh custody host for the real PayMcp. No account or signer exists.
use pay_mcp::{
    ApprovalPolicy, CallScope, PayContext, PayMcp,
    authority::{
        AuthorityBinding, AuthorityDecision, AuthorityUnavailable, SpendRequest, SpendingAuthority,
    },
    controlled::{ControlledExecution, ControlledRequest, ControlledResponse, ExecutionPlan, UnsignedPayment},
};
use rmcp::{
    ServiceExt,
    service::{Peer, RequestContext, RoleServer},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::Future, io::Read, pin::Pin, sync::Arc, time::Duration};
// JSON byte arrays may expand each public response byte to four wire bytes.
const MAX_CONTROLLED_BRIDGE_RESPONSE_BYTES: usize = 4 * 64 * 1024 * 1024 + 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    origin: String,
    token: String,
    caller: String,
    timeout_ms: u64,
}
struct Bridge(Config);
impl Bridge {
    fn failure(&self, code: &'static str, path: &str, body: &Value, status: Option<u16>) -> pay_core::Error {
        // Fixed classifications and correlation only; never emit HTTP bodies,
        // request headers, URLs, tokens or reqwest's credential-bearing errors.
        eprintln!("{}", json!({"target":"yosh_controller", "version":1,
            "callerId":self.0.caller, "operationId":body["facts"]["operation_id"],
            "attemptId":body["facts"]["attempt_id"], "stage":if path == "/pay/plan" { "plan" } else { "execute" },
            "code":code,"httpStatus":status}));
        pay_core::Error::PaymentRejected(code.into())
    }
    fn post(&self, path: &str, body: Value) -> pay_core::Result<Value> {
        let response = reqwest::blocking::Client::builder()
            .no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60))
            .build().map_err(|_| self.failure("CONTROLLED_TRANSPORT_UNAVAILABLE", path, &body, None))?
            .post(format!("{}{path}", self.0.origin)).bearer_auth(&self.0.token).json(&body).send()
            .map_err(|error| self.failure(if error.is_timeout() { "CONTROLLED_TIMEOUT" } else { "CONTROLLED_TRANSPORT_UNAVAILABLE" }, path, &body, None))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(self.failure("CONTROLLED_BACKEND_REJECTED", path, &body, Some(status)));
        }
        let mut bytes = Vec::new();
        response.take(MAX_CONTROLLED_BRIDGE_RESPONSE_BYTES as u64 + 1).read_to_end(&mut bytes)
            .map_err(|_| self.failure("CONTROLLED_RESPONSE_READ_FAILED", path, &body, Some(status)))?;
        if bytes.len() > MAX_CONTROLLED_BRIDGE_RESPONSE_BYTES {
            return Err(self.failure("CONTROLLED_RESPONSE_TOO_LARGE", path, &body, Some(status)));
        }
        serde_json::from_slice(&bytes).map_err(|_| self.failure("CONTROLLED_RESPONSE_INVALID", path, &body, Some(status)))
    }
}
fn rejected() -> pay_core::Error {
    pay_core::Error::PaymentRejected("CONTROLLED_RESPONSE_INVALID".into())
}

impl SpendingAuthority for Bridge {
    fn authorize(
        &self,
        request: SpendRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AuthorityDecision, AuthorityUnavailable>> + Send + '_>>
    {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| AuthorityUnavailable)?;
            let response = client
                .post(format!("{}/pay/authorize", self.0.origin))
                .bearer_auth(&self.0.token)
                .json(&request)
                .send()
                .await
                .map_err(|_| AuthorityUnavailable)?;
            let success = response.status().is_success();
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| AuthorityUnavailable)? {
                if bytes.len() + chunk.len() > 1024 {
                    return Err(AuthorityUnavailable);
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| AuthorityUnavailable)?;
            // Only this exact, authenticated provider decision releases the
            // upstream pre-execution fence. HTTP/parse/transport errors do not.
            if success && value == json!({"decision": "RejectBeforeExecution"}) {
                return Ok(AuthorityDecision::RejectBeforeExecution);
            }
            if success && value == json!({"allow": true}) {
                Ok(AuthorityDecision::Allow)
            } else if success && value == json!({"allow": false}) {
                Ok(AuthorityDecision::Deny)
            } else {
                Err(AuthorityUnavailable)
            }
        })
    }
}
impl ControlledExecution for Bridge {
    fn plan(&self, request: &ControlledRequest) -> pay_core::Result<ExecutionPlan> {
        let body = json!({"facts": custody_facts(request)});
        let value = self.post("/pay/plan", body.clone())?;
        let malformed = || self.failure("CONTROLLED_PLAN_INVALID", "/pay/plan", &body, None);
        match value.get("action").and_then(Value::as_str) {
            Some("replay") => Ok(ExecutionPlan::Replay { response: serde_json::from_value(value["response"].clone()).map_err(|_| malformed())? }),
            Some("build") => {
                let lifetime = value.get("lifetime").filter(|v| !v.is_null()).map(|v| {
                    Ok::<_, pay_core::Error>(pay_mcp::controlled::ControlledLifetime {
                        recent_blockhash: v["recentBlockhash"].as_str().ok_or_else(malformed)?.into(),
                        last_valid_block_height: v["lastValidBlockHeight"].as_str().ok_or_else(malformed)?.parse().map_err(|_| malformed())?,
                    })
                }).transpose()?;
                Ok(ExecutionPlan::Build { payer: value["payer"].as_str().ok_or_else(malformed)?.into(),
                    rpc_url: value["rpc_url"].as_str().ok_or_else(malformed)?.into(), lifetime })
            },
            _ => Err(malformed()),
        }
    }
    fn execute(
        &self,
        request: &ControlledRequest,
        unsigned: UnsignedPayment,
    ) -> pay_core::Result<ControlledResponse> {
        let body = json!({"facts":custody_facts(request),"unsigned":custody_unsigned(unsigned)?});
        serde_json::from_value(self.post("/pay/execute", body.clone())?)
            .map_err(|_| self.failure("CONTROLLED_RESPONSE_INVALID", "/pay/execute", &body, None))
    }
}
fn custody_facts(request: &ControlledRequest) -> Value {
    let mut facts = serde_json::to_value(&request.spend).expect("serializable spend facts");
    facts["payment_required"] = request.payment_required.clone();
    facts
}
fn custody_unsigned(unsigned: UnsignedPayment) -> pay_core::Result<Value> {
    let lifetime = unsigned.lifetime.ok_or_else(rejected)?;
    Ok(json!({"transaction": unsigned.transaction, "recentBlockhash": lifetime.recent_blockhash,
        "lastValidBlockHeight": lifetime.last_valid_block_height.to_string()}))
}
// Read-only compatibility entry point. Uses the pinned SDK classifier/builder;
// it owns no signer, account store, authority or credential-bearing transport.
fn unsigned_preflight(input: Value) -> Result<Value, &'static str> {
    use base64::Engine;
    use std::str::FromStr;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input { payer: String, rpc_url: String, lifetime: Lifetime, url: String, payment_required: Value }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lifetime { recent_blockhash: String, last_valid_block_height: String }
    let input: Input = serde_json::from_value(input).map_err(|_| "INVALID_PREFLIGHT_INPUT")?;
    for raw in [&input.url, &input.rpc_url] {
        let url = reqwest::Url::parse(raw).map_err(|_| "INVALID_URL")?;
        let test_rpc = raw == &input.rpc_url && std::env::var("NODE_ENV").as_deref() == Ok("test") && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
        if (url.scheme() != "https" && !test_rpc) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("INVALID_URL"); }
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&input.payment_required).map_err(|_| "INVALID_CHALLENGE")?);
    let pay_core::client::runner::RunOutcome::X402Challenge { challenge, .. } = pay_core::client::runner::classify_402(
        &[("payment-required".into(), encoded)], None, &input.url) else { return Err("UNSUPPORTED_CHALLENGE"); };
    if challenge.x402_version != 2 || challenge.siwx.is_some() { return Err("UNSUPPORTED_CHALLENGE"); }
    let accepted = challenge.requirements.to_accepted_value();
    let mut requirement = challenge.requirements;
    let height: u64 = input.lifetime.last_valid_block_height.parse().map_err(|_| "INVALID_LIFETIME")?;
    if height == 0 || height > 9_007_199_254_740_991 || height.to_string() != input.lifetime.last_valid_block_height { return Err("INVALID_LIFETIME"); }
    solana_pubkey::Pubkey::from_str(&input.lifetime.recent_blockhash).map_err(|_| "INVALID_BLOCKHASH")?;
    if requirement.recent_blockhash.as_ref().is_some_and(|v| v != &input.lifetime.recent_blockhash) { return Err("CHALLENGE_BLOCKHASH_MISMATCH"); }
    requirement.recent_blockhash = Some(input.lifetime.recent_blockhash.clone());
    let payer = solana_pubkey::Pubkey::from_str(&input.payer).map_err(|_| "INVALID_PAYER")?;
    let rpc = pay_kit::x402::solana_rpc_client::rpc_client::RpcClient::new_with_timeout(input.rpc_url, Duration::from_secs(5));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "RUNTIME_UNAVAILABLE")?;
    // The Yosh custody validator and signer currently accept V0 transactions.
    // Advertise that ceiling without rewriting the merchant's accepted offer.
    let transaction = runtime.block_on(pay_kit::x402::client::exact::prepare_unsigned_payment(
        &payer, &rpc, &requirement, Some(pay_kit::core::tx::TxVersion::V0),
    )).map_err(|_| "UNSIGNED_PREPARE_FAILED")?;
    if transaction.signatures.iter().any(|v| v.as_ref().iter().any(|b| *b != 0)) { return Err("SIGNED_TRANSACTION_FORBIDDEN"); }
    let transaction = pay_kit::core::tx::encode(&transaction).map_err(|_| "WIRE_ENCODING_FAILED")?;
    Ok(json!({"accepted": accepted, "unsigned": {"transaction": transaction, "recentBlockhash": input.lifetime.recent_blockhash, "lastValidBlockHeight": height.to_string()}}))
}
struct NoSigner;
impl ApprovalPolicy for NoSigner {
    fn gate(&self, _: Option<&Peer<RoleServer>>) -> pay_core::signer::AuthOverride {
        panic!("PAY_SIGNER_FORBIDDEN")
    }
}
impl PayContext for Bridge {
    fn scope(&self, _: &RequestContext<RoleServer>) -> Result<CallScope, rmcp::ErrorData> {
        Ok(CallScope {
            accounts: Arc::new(pay_core::accounts::MemoryAccountsStore::new()),
            network_override: None,
            account_override: None,
            rpc_url_override: None,
            approval: Arc::new(NoSigner),
            payment_permissions: None,
            body_files: false,
            outbound_policy: if std::env::var("YOSH_PAY_MCP_MAINNET").as_deref() == Ok("1")
                || std::env::var("YOSH_PAY_MCP_DEVNET").as_deref() == Ok("1") {
                pay_core::client::fetch::OutboundPolicy::PublicInternetOnly
            } else {
                pay_core::client::fetch::OutboundPolicy::Unrestricted
            },
        })
    }
    fn spending_authority(
        &self,
        _: &RequestContext<RoleServer>,
    ) -> Result<Option<AuthorityBinding>, rmcp::ErrorData> {
        let bridge = Arc::new(Bridge(Config {
            origin: self.0.origin.clone(),
            token: self.0.token.clone(),
            caller: self.0.caller.clone(),
            timeout_ms: self.0.timeout_ms,
        }));
        Ok(Some(
            AuthorityBinding::new(&self.0.caller, bridge.clone())
                .with_timeout(Duration::from_millis(self.0.timeout_ms))
                .with_controlled_execution(bridge),
        ))
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--unsigned-preflight") {
        if std::env::args().len() != 2 {
            return Err("INVALID_PREFLIGHT_ARGUMENTS".into());
        }
        let result = tokio::task::spawn_blocking(|| {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(131_073)
                .read_to_end(&mut bytes)
                .map_err(|_| "PREFLIGHT_INPUT_UNAVAILABLE")?;
            if bytes.len() > 131_072 {
                return Err("PREFLIGHT_INPUT_TOO_LARGE");
            }
            let input = serde_json::from_slice(&bytes).map_err(|_| "INVALID_PREFLIGHT_INPUT")?;
            unsigned_preflight(input)
        })
        .await?;
        let output = match result {
            Ok(value) => json!({"ok": true, "result": value}),
            Err(code) => json!({"ok": false, "code": code}),
        };
        println!("{output}");
        return Ok(());
    }
    // Only the fixed execution-stage fields are exported; other libraries may
    // log requests or credentials and must remain disabled in this host.
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("off,pay_execution=info")
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let development = std::env::var("YOSH_PAY_DEV").as_deref() == Ok("1");
    if std::env::var("NODE_ENV").as_deref() != Ok("test")
        && !development
        && std::env::var("YOSH_PAY_MCP_MAINNET").as_deref() != Ok("1")
        && std::env::var("YOSH_PAY_MCP_DEVNET").as_deref() != Ok("1")
    {
        return Err("ISOLATED_TEST_ONLY".into());
    }
    let config_path = std::env::args().nth(1).ok_or("CONFIG_REQUIRED")?;
    let metadata = std::fs::symlink_metadata(&config_path)?;
    if !metadata.is_file() || metadata.len() > 16_384 {
        return Err("PRIVATE_CONFIG_REQUIRED".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("PRIVATE_CONFIG_REQUIRED".into());
        }
    }
    let config: Config = serde_json::from_slice(&std::fs::read(config_path)?)?;
    let url = reqwest::Url::parse(&config.origin)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("LOOPBACK_ONLY".into());
    }
    PayMcp::with_context(Arc::new(Bridge(config)))
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await?
        .waiting()
        .await?;
    Ok(())
}


#[cfg(test)]
mod bridge_diagnostics_tests {
    use super::*;
    use std::io::Write;
    fn bridge(origin: String) -> Bridge { Bridge(Config { origin, token: "NEVER_LOG_THIS_TOKEN".into(),
        caller: "8c697f80-b9e3-43f9-bddb-6174416573b7".into(), timeout_ms: 5000 }) }
    fn response(wire: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || { let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0; 8192]; let _ = socket.read(&mut bytes); socket.write_all(wire).unwrap(); });
        origin
    }
    #[test]
    fn bridge_classifies_backend_json_and_read_failures() {
        for (wire, code) in [
            (&b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"[..], "CONTROLLED_BACKEND_REJECTED"),
            (&b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx"[..], "CONTROLLED_RESPONSE_INVALID"),
            (&b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx"[..], "CONTROLLED_RESPONSE_READ_FAILED"),
        ] {
            let error = bridge(response(wire)).post("/pay/plan", json!({})).unwrap_err().to_string();
            assert!(error.contains(code), "{error}"); assert!(!error.contains("NEVER_LOG_THIS_TOKEN"));
        }
    }
    #[test]
    fn refused_connection_is_transport_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap()); drop(listener);
        assert!(bridge(origin).post("/pay/plan", json!({})).unwrap_err().to_string().contains("CONTROLLED_TRANSPORT_UNAVAILABLE"));
    }
    #[test]
    fn malformed_plan_is_distinct() {
        let request = ControlledRequest { spend: SpendRequest {
            caller_id: "8c697f80-b9e3-43f9-bddb-6174416573b7".into(), operation_id: "test".into(),
            attempt_id: "0d445c54-261a-4cc1-becb-56e2b977abda".into(),
            request: pay_mcp::authority::ImmutableRequest { method: "GET".into(), url: "https://example.com".into(), headers: vec![], body: None },
            network: "solana:mainnet".into(), asset: "USDC".into(), amount_atomic: "1000".into(),
            recipient: "recipient".into(), accepted: json!({}), execution_network: "mainnet".into()
        }, payment_required: json!({}) };
        let error = bridge(response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"))
            .plan(&request).err().unwrap().to_string();
        assert!(error.contains("CONTROLLED_PLAN_INVALID"));
    }
}

// Exercise the prepared Pay module as well as this binary's preflight entry.
// Both paths must respect the transaction formats the Yosh custody host accepts.
#[cfg(test)]
use pay_mcp::authority;
#[cfg(test)]
#[path = "../controlled.rs"]
mod controlled;

#[cfg(test)]
mod custody_version_tests {
    use super::*;
    use pay_kit::core::tx::{self, TxVersion};
    use std::{io::Write, sync::atomic::{AtomicUsize, Ordering}};

    fn envelope(versions: &[u8]) -> Value {
        json!({"x402Version":2,"resource":{"url":"https://example.com/data"},
            "accepts":[{"scheme":"exact","network":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                "asset":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"1000",
                "payTo":"J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg","maxTimeoutSeconds":60,
                "extra":{"decimals":6,"transactionVersions":versions}}]})
    }

    fn rpc() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let len = socket.read(&mut chunk).unwrap();
                assert!(len > 0 && request.len() + len <= 8192);
                request.extend_from_slice(&chunk[..len]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..end]);
                    let length: usize = header.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    }).unwrap();
                    if request.len() >= end + 4 + length {
                        let input: Value = serde_json::from_slice(&request[end + 4..]).unwrap();
                        assert_eq!(input["method"], "isBlockhashValid");
                        break;
                    }
                }
            }
            let body = r#"{"jsonrpc":"2.0","id":0,"result":{"context":{"slot":1},"value":true}}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        url
    }

    fn assert_unsigned_v0(wire: &str) {
        let transaction = tx::decode(wire).unwrap();
        assert_eq!(TxVersion::of(&transaction.message).unwrap(), TxVersion::V0);
        assert!(transaction.signatures.iter().all(|s| s.as_ref().iter().all(|b| *b == 0)));
    }

    #[test]
    fn preflight_uses_only_versions_the_custody_host_accepts() {
        assert_eq!(std::env::var("NODE_ENV").as_deref(), Ok("test"));
        for versions in [&[0, 1][..], &[0][..], &[1][..]] {
            let payment_required = envelope(versions);
            let result = unsigned_preflight(json!({"payer":"11111111111111111111111111111111",
                "rpcUrl":rpc(),"lifetime":{"recentBlockhash":"11111111111111111111111111111111","lastValidBlockHeight":"5000"},
                "url":"https://example.com/data","paymentRequired":payment_required}));
            if versions == [1] {
                assert_eq!(result.unwrap_err(), "UNSIGNED_PREPARE_FAILED");
            } else {
                let result = result.unwrap();
                assert_unsigned_v0(result["unsigned"]["transaction"].as_str().unwrap());
                assert_eq!(result["accepted"], payment_required["accepts"][0]);
            }
        }
    }

    struct Controller { rpc_url: String, executes: AtomicUsize }
    impl controlled::ControlledExecution for Controller {
        fn plan(&self, _: &controlled::ControlledRequest) -> pay_core::Result<controlled::ExecutionPlan> {
            Ok(controlled::ExecutionPlan::Build { payer: "11111111111111111111111111111111".into(),
                rpc_url: self.rpc_url.clone(), lifetime: Some(controlled::ControlledLifetime {
                    recent_blockhash: "11111111111111111111111111111111".into(), last_valid_block_height: 5000 }) })
        }
        fn execute(&self, request: &controlled::ControlledRequest, unsigned: controlled::UnsignedPayment) -> pay_core::Result<controlled::ControlledResponse> {
            self.executes.fetch_add(1, Ordering::SeqCst);
            assert_unsigned_v0(&unsigned.transaction);
            assert_eq!(request.spend.accepted, request.payment_required["accepts"][0]);
            Ok(controlled::ControlledResponse { status: 200, headers: vec![], body: b"fixture".to_vec() })
        }
    }

    #[test]
    fn controlled_purchase_uses_v0_and_rejects_v1_only_before_execute() {
        for versions in [&[0, 1][..], &[0][..], &[1][..]] {
            let raw = envelope(versions);
            let challenge = pay_core::client::x402::parse(&[], Some(&raw.to_string())).unwrap();
            let controller = Controller { rpc_url: rpc(), executes: AtomicUsize::new(0) };
            let spend = SpendRequest { operation_id: "fixture".into(), attempt_id: "fixture".into(), caller_id: "fixture".into(),
                request: authority::ImmutableRequest { method: "GET".into(), url: "https://example.com/data".into(), headers: vec![], body: None },
                amount_atomic: "1000".into(), asset: challenge.requirements.currency.clone(), network: challenge.requirements.network.clone(),
                recipient: challenge.requirements.recipient.clone(), accepted: raw["accepts"][0].clone(), execution_network: "mainnet".into() };
            let result = controlled::run(&controller, spend, Some(raw), &challenge);
            if versions == [1] {
                assert!(result.err().unwrap().to_string().contains("UNSIGNED_PREPARE_FAILED"));
                assert_eq!(controller.executes.load(Ordering::SeqCst), 0);
            } else {
                assert!(result.is_ok(), "versions {versions:?}: {}", result.err().unwrap());
                assert_eq!(controller.executes.load(Ordering::SeqCst), 1);
            }
        }
    }
}
