# Pay quote compatibility evidence — 2026-10-20

Only the isolated Pay worktree was edited. Baseline copies are under Yosh `build.noindex/mainnet-quote-rpc-baseline/pay/`; the independent incremental patch is `pay-quote-compatibility.patch` and reverse apply-check passed. No commit, push, App installation, production Keychain access, Ledger access, or public payment was performed by this subtask.

## Actual pinned SDK semantics

Inspected the compiled local `pay-kit-current/src/x402/client/exact/payment.rs` and `protocol/schemes/exact/types.rs` (`solana-pay-kit` 0.10.0, the already prepared SDK source used by the workspace):

- `payment_required_envelope` chooses the first valid base64 PAYMENT-REQUIRED envelope, then valid legacy single-requirement header, then body. `parse_x402_challenge_for_network` selects native Solana using the original SDK selector. Its result alone loses unused alternatives and richer resource fields.
- `PaymentRequiredEnvelope::with_resource_on_accepts` attaches resource metadata to requirements. The resource is declaration metadata; it does not replace the immutable final HTTP request URL. The wire may therefore advertise a queryless route for a concrete parameterized GET.
- `PaymentRequirements::to_accepted_value` retains the original canonical accepted object, including extra. Unsigned transaction generation consumes selected terms and extra (including memo), not top-level bazaar or builder-code metadata.
- `PaymentExtensions::echoing` retains unknown top-level extensions, but its typed payment-identifier representation can normalize missing info or lose unknown nested fields. The controlled profile now requires its roundtrip to equal the raw extensions and rejects required client-generated identifiers. The actual quote has `info.required:false`, which roundtrips exactly. No payment identifier generation was added.
- SDK `ResourceInfo` only carries URL/description/mimeType. Capturing only that typed struct would lose the real serviceName/tags/iconUrl fields. We preserve the whole original wire envelope separately.

## Minimal implementation

- `pay-core/client/x402.rs::payment_required_value`: captures the full original selected wire envelope using SDK source precedence, without projection/normalization. Existing payment/default selection behavior is unchanged.
- `authority.rs::SpendRequest.payment_required`: optional full envelope, present only with ControlledExecution. `skip_serializing_if=None` preserves the optional Authority-only Hook wire contract when custody is absent.
- `authority.rs::controlled_envelope`: SDK reparse verifies the same accepted offer/resource/extensions; exactly one original offer must equal selected accepted. Resource must have the same origin/path as the immutable request, no credentials/fragment; a nonempty resource query must equal the complete original query. Missing/ambiguous envelopes, alternate paths/origins/queries, malformed extensions, SDK-normalizing extensions, and required generated payment IDs fail before Authority invocation.
- `curl.rs::do_paid_fetch`: replaced the blanket “all extensions or route URL differences are unsupported” admission with the validated full binding above. Original probing, classification, selected economics, Authority invocation, ControlledExecution, response interpretation and no-fallback boundaries remain intact.
- No change to `controlled.rs::prepare` or its loopback-only RPC policy, no production signer enablement, no new payment interface or Ledger.

## Reproduction and regression

- `pay-route-red.log`: new original MCP route-metadata success assertion failed before the fix (1 failed). This reproduced the exact prior guard.
- Public full quote fixture: `rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json`, copied from the fresh safe HTTPS quote. It preserves 13 alternatives, full resource metadata and all extension payload/schema data. The loopback merchant changes only resource URL to its local route; one test compares the full resulting Authority envelope byte-value-for-value.
- Actual MCP initialized/tools-call tests reach the unchanged do_paid_fetch and SDK selector, preserving full query in immutable request and queryless route in original quote. Controller Replay is a contract fixture here; these tests do not claim a real Yosh economic authorization or Mainnet purchase. Every new compatibility case has zero account reads, wallet approval calls, and paid HTTP requests.
- Negative cases: required identifier, malformed required type, SDK-normalizing unknown nested fields, different resource origin/path/query, duplicate accepted offer. All deny before Authority and custody access.
- Default noncontrolled serialized facts omit payment_required. Existing SDK offline fixture paid-path tests still pass.
- Core test `captured_wire_envelope_uses_the_sdk_selected_source_without_projection`: valid header beats conflicting body, malformed header falls back to body, valid legacy header prevents binding an unrelated v2 body, rich metadata remains preserved.

Final results:

- `pay-regression-final.log`: 143 library + 11 curl HTTP + 15 external Authority tests passed; 1 existing ignored helper; no failures.
- `pay-core-x402.log`: 41 relevant core x402 tests passed.
- `pay-clippy.log`: all-targets -D warnings passed.
- `pay-connect.log`: downstream pay-connect check passed.
- `pay-fmt.log`: fmt check passed.
- `git diff --check` and independent patch reverse apply-check passed.

An early regression command used the wrong existing target name (`curl_http_methods`); the command was corrected to `curl_http_e2e`. A newly added test initially compared serde_json Value against &String and was corrected to an explicit string comparison before the final successful regression. These were test invocation/compile issues, not hidden product failures.

Root owns the real Yosh Authority, durable-envelope/replay binding tests and fresh live no-funds preflight. These Pay tests are parser/admission/transport contract evidence only. Mainnet execution remains blocked until its separately authorized real signer/final-send/upgrade path is implemented and accepted.
