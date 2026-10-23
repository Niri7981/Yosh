# RC.5 controller contract investigation — 2026-10-23

No Mainnet purchase, recovery call, new live operation, consent update, signer use or submission was performed. #514/#530 and the Rust bridge were not modified. Financial state was read only. Both historical operations 001 and 002 remain EXPIRED / provenance AUTHORIZED.

## Execute: confirmed body-size contract failure

The installed Dev management server first allowed 131072 bytes at the socket, then called smallJson(request) with its ordinary 8192-byte default. The production Next controlled route already explicitly allowed 131072 bytes. Correlation was established only after smallJson, so this failure produced no backend-correlated diagnostic.

Reconstructing the original 002 immutable facts from read-only durable records gives a compact serialized plan request of 7565 bytes. The actual installed Rust binary, run against a local fixture RPC with the original public multi-offer challenge and buyer public key, produced an unsigned wire string of 664 characters. Adding this wire and a Mainnet-length lifetime produces an execute envelope of 8359 bytes. The local regression first reproduced RequestBodyError at the old parser, then passed with the controller-specific 131072-byte cap. This changes neither transaction validation nor ordinary management limits.

| Contract | Actual serialization | Backend input | Difference |
|---|---|---|---|
| plan | `{facts: ...}` | strict object, facts required, unsigned optional | none |
| execute | `{facts: ..., unsigned: ...}` | same strict object | total JSON exceeded inner body cap |
| facts identifiers | caller_id, operation_id, attempt_id strings | same snake_case fields; UUID / operation pattern checks | none found |
| request | GET, URL, header tuples, body=null | same; body must be null | none found |
| economic facts | amount_atomic string; network/asset/recipient strings; accepted and payment_required objects | same | none found |
| unsigned | transaction string, recentBlockhash string, lastValidBlockHeight decimal string | same exact keys/types; strict shape | none found |
| lifetime | plan's recentBlockhash + lastValidBlockHeight strings; Rust converts height to integer internally then back to decimal string for execute | same bound lifetime | none found |
| recover HTTP | `{operationId: string}` | same strict camelCase shape | none found |

The recover HTTP JSON is serialized by Yosh's JavaScript MCP wrapper, not yosh-controlled-mcp.rs. Rust has plan/execute bridge calls and an unsigned-preflight subcommand; it does not serialize /pay/recover.

## Recovery: historical lower-level failure still unavailable

The historical 002 record proves execution lease renewal followed by HTTP 400 / CONTROLLER_INPUT_INVALID. It does not include the original Zod paths or builder error result. Normal original-challenge unsigned output from the installed Rust binary was accepted in a local deterministic RPC fixture. Existing normal recovery tests still reach the mock signing boundary while reusing the same Purchase/reservation.

Two injected negative fixtures deterministically reproduce CONTROLLER_INPUT_INVALID after lease renewal: an unsigned builder result `{ok:false, code:UNSIGNED_PREPARE_FAILED}`, and a successful result containing an invalid unsigned shape. These demonstrate distinct possible failure sites, not which occurred historically. A later live read-only RPC probe returned HTTP 403 before reaching unsigned construction; that does not establish the cause of the historical recovery error or the App's current RPC behavior.

No recovery state classification or resume semantics was changed. The historical Zod root remains unknown, and no new acceptance/payment is declared passed or ready as a complete chain.

## Diagnostics and changes

Internal diagnostics now support endpoint, operation/attempt correlation, validation stage (http_input, facts, rpc_lifetime, unsigned_result, execute_unsigned), stable backend classification, bounded Zod issue paths/codes and safe expected type categories. An unsigned failure result preserves only its finite known error code. Unrecognized path components are redacted; arbitrary Zod messages, unknown object keys, request values, credentials, consent and transaction contents are never logged. Public MCP errors remain bounded and unchanged.

Changed in this task:
- src/modules/pay-dev/management-server.ts: controller body cap and input diagnostics, including equivalent validation in both authority routes.
- src/modules/payment/pay-controller-diagnostics.ts: bounded diagnostic metadata and stage-aware parsing.
- src/modules/payment/pay-authority-adapter.ts: validation-stage annotations only.
- tests/unit/pay-controller-contract.test.ts
- tests/unit/pay-controller-diagnostics.test.ts
- tests/integration/pay-mainnet-controlled.test.ts
- tests/integration/pay-dev-environments.test.ts

## Verification and delivery

Final sandboxed targeted regression: 6 files, 81 tests passed. Includes actual HTTP strict rejection above the old body cap, 128 KiB rejection, no signing before invalid input, one Purchase/reservation across recovery, original-payment fencing and real stdio wrapper integration. Typecheck, lint, Next production build and git diff --check passed. Next retained its pre-existing dynamic filesystem tracing warnings.

Reused the existing rc.5 Dev overlay packaging process; the formal install-macos-app.sh targets the unrelated production Yosh.app and was not used. The same rc.5 bundle was staged, backend/MCP bundles rebuilt with __YOSH_RC5__=true, provenance overlay updated, signed, and copied to the same installed path after normal quit and listener shutdown. No native/UI source or Rust binary was rebuilt or changed. Installed/staged contents and strict/deep signature verification passed. App PID 37921 and backend PID 37924 run from /Users/irin/Applications/Yosh Pay Dev v0.1.1-rc.5.app. Only 127.0.0.1:13449 is listening; lifecycle reports managementAuthenticated, coreReady and walletAvailable.

Ten financial-history tables were fingerprinted before and after installation/restart: all unchanged, including purchases, events, immutable provenance, execution leases, authority claims, grants/events, monetary controls and original payment/signature records. No commit or push.

ROOT CAUSE STILL NOT OBSERVABLE — execute cause identified and fixed; historical recovery validation path not recoverable from existing evidence.
