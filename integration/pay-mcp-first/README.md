# Pay MCP-first — isolated round 1

Real Pay MCP → real Yosh authority/ledger → controlled exact preparation/signing/HTTP → API data has passed without funds. Production remains **BLOCKED**. Nothing is installed, enabled, committed, pushed or sent to Mainnet.

The adjacent isolated worktrees are `../pay` (PR #514 HEAD `9f9c342`) and this Yosh checkout (`f65c9bd` plus the current, preserved Phase 2 working changes). The original Pay checkout remains at `df57843`. PR #514 pins pay-kit `bd3ad25`, newer than the archived PoC kit `f8ef055`; the unsigned seam was ported onto that actual pinned source in `../pay-kit-current`. The old PoC Gate/Mock Authority is not used.

Actual execution:

```text
MCP SDK stdio client → real PayMcp tools/call(curl)
→ PayContext host identity → curl::run → do_paid_fetch
→ original HTTP fetch / classify_402 / SDK exact selection / YAML gate
→ #514 SpendingAuthority → authenticated Yosh adapter
→ real requestPaidResourcePurchase(deferExecution), SpendGrant / Daily Authority / PurchaseLedger.reserve
→ ControlledExecution.plan → original pay-kit exact::prepare_unsigned_payment
→ Yosh adapter → executeApprovedPayment → atomic claim
→ existing strict unsigned validator + simulation → Yosh offline signer
→ original evidence save → generation/Pause check → submission marker → Yosh HTTP
→ Yosh original-transaction RPC verification → persisted API delivery
→ credential-free controlled response → Pay raw_to_outcome → original interpret_retry → MCP API data
```

`ControlledExecution` is an optional host-configured public interface in Pay MCP. Its Build and Replay plans never return a buyer signature or payment header. The controlled branch returns before Pay account loading, wallet approval, signing, and paid retry. Errors cannot fall through. Disabled-mode behavior stays on the original branch and is covered by Pay regressions. Preparation currently deliberately permits only loopback RPC; unsupported protocols/extensions cannot use the controller as a fallback.

`pay-authority-adapter.ts` uses real Yosh services and the sole PurchaseLedger. `deferExecution` separates live authorization/reservation from execution without simulation or a no-op payment mock. `AppRuntime.runExternalPaymentOperation` places external authorization, in-flight HTTP and accounting inside the existing shutdown barrier. The test host authenticates its backend-only connection token on every bridge call; `caller_id` must match the resulting CardMember. MCP clientInfo and tool arguments do not establish identity. `operation_id` is a caller-scoped idempotency key, never approval: Yosh hashes caller + operation into the stable purchase key and binds the immutable request/terms and attempt. Existing records cannot create another execution; completed data can be replayed from a new Pay process.

The existing Phase 2 unsigned validator, signer custody, original-payment evidence, submission gate, reconciliation and delivery recovery are reused. Its inspected fixes remain intact: generation capture before awaited preflight; sanitized interpreter observation; persist original delivery before awaiting advisory interpretation. The merchant response stays in Yosh; Pay receives validated persisted API data, not raw credential-bearing headers/body. Direct buyer-signature reflection in base58/base64/hex is rejected. This is a constrained JSON Resource profile, not a claim that arbitrary merchant-controlled encodings can be made safe by general redaction.

The isolated fixture supports the existing registered Devnet test Resources (GET, x402 V2 exact, native test USDC). Fake merchant/RPC/facilitator and an offline generated buyer/sponsor are the only external boundaries. Real Connection authentication, Grants, Budget, Ledger, claim, Pause, signing validation, evidence and recovery are not mocked. Fault injection is used for failure/race tests. No second ledger, production data migration or production activation exists.

Run here, on this Mac, using the preserved adjacent sources and local dependencies:

```sh
python3 scripts/build-pay-protocol-engine.py --archive /Users/irin/Desktop/open-source/yosh-pay-integration-poc --test
python3 scripts/build-pay-mcp-first.py --test
python3 integration/pay-protocol-engine/check-hostile-challenges.py
python3 scripts/test-pay-integration.py
python3 scripts/test-pay-integration.py --all
npm run typecheck
npm run lint
npm run build
```

Both runners deny external network, Keychain and production state with macOS OS sandbox rules. Rust uses vendored dependencies, `--offline --locked`, a private HOME and an empty Cargo home. Build provenance and verification logs are under `build.noindex/pay-mcp-target`; Yosh logs are under `build.noindex`. The build checks that the original HEADs and their previously uncommitted files remain unchanged.

Reviewable patches are split into `pay-controlled-execution.patch` (generic Pay interface/original-branch changes and tests), `pay-kit-unsigned.patch` (only the additive builder separation on the actual #514 kit pin), and `pay-isolated-host.patch` (test host, not an upstream CLI activation feature). Local Cargo source/vendor overlays are intentionally outside those candidate upstream patches. `round1-files.json` distinguishes this round from inherited user/Phase 2 changes; `source-baselines.json` records the observed originals.

The Pay MCP suite covers real authorization and budget denials; provider deny/timeout/failure; same-operation concurrency and new-process replay; trusted-identity mismatch and independent Agent Grants; repriced facts/modified unsigned transfer; Pause versus claim, old epochs, signer, signed evidence and already-started HTTP; lost controller/merchant ACK; interpretation failure and retained data; signature reflection; actual SIGKILL between marker and HTTP; and shutdown waiting for original accounting. Shutdown retains the existing policy of stopping new delivery claims: payment is confirmed before exit and delivery is recovered from original credentials after reopen.

Cross-restart evidence is for the current isolated code and temporary database, including actual SIGKILL, new AppRuntime/adapter and new Pay process. The real Pay server and real MCP SDK transport were exercised; installed-App / real Codex-conversation Pay registration was not performed. Persistent external provenance, durable execution epochs, and old-writer/rollback-version fencing are still absent. Same-version original-payment recovery does not prove cross-version safety. This adapter refuses production/Mainnet admission; production must stay **BLOCKED**.

Final verification: 22 new real Pay MCP cases; 87 Yosh TypeScript files / 1072 tests plus 3 Node native tests; 163 Pay Rust tests (one existing subprocess helper remains ignored); 3 protocol-helper unit tests and 7 hostile-input checks passed. Typecheck, lint, production build, Rust fmt/clippy and pay-connect compatibility passed. All three patches apply cleanly; original HEADs, working-change file sets and bytes are unchanged; frontend output contains no new signing/adapter identifiers. See `validation.json` and the actual local logs.

During validation, the old kit/modern #514 mismatch was corrected by using the inspected #514 kit pin. A first Rust test command used the build-only network-denying profile; it was rerun under the proper loopback-only test profile and all cases passed. The new shutdown test first demonstrated that external work was missing from the runtime quit barrier; that code was fixed, followed by complete regression and build validation. The preserved Phase 2 engine was freshly rebuilt and its source/vendor hashes verified, rather than relying solely on historical results.
