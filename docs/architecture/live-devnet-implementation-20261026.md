# Live Devnet — implementation and acceptance (2026-10-26)

This feature connects `live_devnet` to the existing Yosh × Pay controlled payment architecture. `live_mainnet` retains its production gate and additional economic confirmation. `simulated` has no signer or on-chain submission; its MCP exposes status only, not fabricated paid delivery. Legacy `offline` remains compatible and is not Live Devnet.

## Scope and shared implementation

The original blockers were Offline/Mainnet-only native selection, an unwired controlled-Devnet flag, Mainnet-only runtime/executor/adapter admission, Demo-based Devnet configuration, and Mainnet-only discovery/registered-resource routing.

The feature reuses AppRuntime, SpendingAuthority #514, ControlledExecution #530, Consent, Daily Authority, SpendGrant, per-transaction limits, PurchaseLedger, atomic reservation, unsigned-transaction validation, custody, reconciliation and paid-resource recovery. There is no second payment engine, ledger or state machine. The `createMainnetPayExecution` compatibility entry point remains available; both live networks use `createPayExecution` with explicit network configuration. Neither upstream #514/#530 nor the pinned Pay SDK revision (`7f1369180ca4b047aadff1bea77aed4525e10039`) changes.

Changes are grouped into runtime/profile isolation, shared live-network payment wiring, native/MCP delivery wiring, and this acceptance record. Native files shared with earlier local UI work were reconstructed from the remote-main baseline with functional hunks only. Earlier visual polish, inline Daily Limit editing and unrelated settings/layout changes are excluded.

## Isolation and switching

- Mainnet, Devnet and Simulation use separate `Mainnet/`, `Devnet/` and `Simulated/` stores, management credentials, backend HOME directories, authority and accounting scopes.
- Devnet uses its own `.wallet.devnet.v1` Keychain namespace. Devnet wallet status does not query Mainnet/Offline credentials. Simulation does not open a signing credential. Private keys are not copied, migrated or exported.
- Existing logical wallet slots and immutable public-key/credential-reference binding remain intact. Resources must match the active canonical network/mint pair; discovery, quote, Grant and Purchase share that binding.
- The v1 selection retains the original Mainnet `rpcUrl` and adds optional `devnetRpcUrl`. Genesis, network, mint, signer and transaction checks remain mandatory.
- Native switching checks active/UNKNOWN purchases and reservations, drains and stops the owned backend, then starts the target. It invalidates cached credentials and refreshes the member roster. Failure rolls back only after safe shutdown; failed authentication never authorizes force-kill. No two payment owners run in parallel.
- Native fixture-port overrides require a disposable HOME. The backend fixture entry rejects Mainnet/Offline and real Application Support state. Tests do not use the installed application's ports or financial data.

## Compatibility fixes and safety boundaries

Devnet factory tests originally failed with `PAY_MAINNET_CONFIGURATION_REQUIRED`; sponsor-bound Devnet preflight was also rejected by a Mainnet-only fee-payer condition. Network-specific admission now selects the same validated execution path. Mainnet confirmation and production controls remain Mainnet-specific; general authorization and transaction checks remain shared.

Real public Devnet RPC returned HTTP 429. The new transport retries only an explicit allowlist of read-only methods, only for opted-in Live Devnet, at most twice, respecting caller cancellation/deadline. Mainnet remains single-attempt. `sendTransaction`, transport errors and uncertain responses are never retried by this transport. Recovery still reconciles the original transaction.

PayAI Echo returned `transactionId` and `signature` aliases alongside the standard receipt `transaction`. The receipt schema accepts those aliases only when each equals `transaction`. Conflicting signatures, unknown fields, wrong network/payer and other receipt/economic mismatches remain rejected. The original invalid-receipt Purchase was not repaired or rewritten.

## Actual Devnet acceptance

Machine-readable, allowlisted evidence: [live-devnet-acceptance-20261026.json](../demo/live-devnet-acceptance-20261026.json). It records both Purchase identities/statuses, public transaction signatures, independent finalized-chain observations, paused restart replay and SHA-256 hashes of the original local evidence files. It contains no database, Keychain value, private configuration or raw signed payload.

Acceptance used the isolated Devnet wallet `8qTWAR1H5woXt8JyJrKVnyWaLvBTNEMqVFBL7bdK7q43`, funded by the user with Circle faucet Test USDC. The merchant was PayAI Echo, GET `https://x402.payai.network/api/solana-devnet/paid-content`, on network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Two distinct purchases each spent 10000 atomic Test USDC (0.01). The final authorized daily/gross spending cap was 20000 atomic. They were driven through the real Yosh Pay MCP wrapper and pinned Pay binary by an MCP SDK client, **not an interactive Codex Desktop conversation**.

1. [First transaction](https://explorer.solana.com/tx/2JFPDPb2LFT4jcddJ3CJiYPSTs8AuvfjsREEbaWxib3r8EbGiLdp6EuyYaUmKxGpPRrPpBaBHDbgtH3fGiQw8KDh?cluster=devnet): finalized, `err=null`, `PAID`, receipt `INVALID`, delivery `UNSUPPORTED`. The historical failure remains unchanged.
2. [Second transaction](https://explorer.solana.com/tx/28dKHRBMMCXZdedrFzpL5oZi7sd5Tr27V3JsDr6F7eFuQhiWCnHcuzPGEhYPuVozK679QHDjWDWdf8D8boYn36nW?cluster=devnet): new Purchase after the strict alias fix, finalized, `err=null`, `PAID`, receipt `CONFIRMED`, delivery `COMPLETE`.

Independent transaction observations show the buyer's token balance decreasing from 20000000 to 19990000 on each transaction with the authorized mint. Echo's demonstration refunds do not erase gross spending: the ledger retained `paid=20000`, `reserved=0`, `remaining=0`.

After backend restart with Payments paused, replay of the successful Purchase through the real MCP returned COMPLETE with unchanged Purchase count, signature, original evidence hash and paid total. No new payment was made. The acceptance profile was left paused and its backend stopped.

This PR preparation did not repeat paid acceptance or send any Mainnet payment. Original local acceptance artifacts were hash-checked without mutation. Automated fixtures below use mock chain/merchant outcomes and ephemeral signers; they are not additional chain acceptance.

## Clean feature-tree validation

The feature was extracted into an independent `feat/live-devnet` worktree based on verified `origin/main` commit `845345b3eb11351b5957e9d03f696178f7d56e0b`. Original working files and index were preserved separately and left unchanged. Payment/runtime sources match the accepted implementation; mixed native files contain only feature wiring.

Completed from that feature tree:

| Check | Result |
| --- | --- |
| `npm test` | 108 files / 1178 tests passed |
| Controlled Mainnet/Devnet and targeted safety suites | 10 files / 199 tests passed |
| Release builder unit regressions | 21 passed |
| `npm run typecheck`, `npm run lint`, `npm run build` | Passed |
| Native launch configuration | Passed; installation-port probes deliberately skipped |
| Native isolated profile lifecycle | Passed: busy gate, credential generations, stale-token rejection, rollback and quit ordering |
| Native Execution, Spend Grant, Settings fixtures | Passed |
| Release configuration native Dev bundle build | Passed; independent preview, not installed |
| Packaged backend through NativeServiceRuntime | Devnet → Simulation → Devnet passed with disposable HOME / port 13048; no provisioning/payment |
| `git diff --check` | Passed |

The controlled suites use the real frozen Pay dependency with this feature's Yosh overlay rebuilt offline/locked, mocked RPC/merchant and ephemeral signers. Coverage includes authorization/budget/Pause rejection, network/economic mismatches, idempotency, one-signature execution, UNKNOWN reservation retention, restart recovery, strict receipt aliases and read-only retry/cancellation boundaries. Local logs and generated bundles stay under ignored `build.noindex/live-devnet-pr-validation/` and are not committed. Existing Vite config and Next dynamic-file-tracing warnings remain; compilation and tests pass.

## Release provenance

Stable v0.1.1 and rc.5 historical source freezes, `final-source-lock.json`, earlier source-lock/manifests, archive snapshots and frozen release builders are unchanged. Those historical builders bind exact inventories/hashes and must continue to reject newer feature sources outside their promotion scope. The later Devnet changes are **not** evidence of an accepted historical Stable build.

`integration/release-candidate/pay-overlay/yosh-controlled-mcp.rs` is the existing location of Yosh's overlay; its new Devnet admission is subsequent feature development. It changes neither upstream ControlledExecution nor its locked SDK. Reproducing the historical release requires its frozen source revision/manifest, not this feature branch's overlay.

`scripts/build-yosh-pay-dev.sh` builds a separate preview and records `feature: live-devnet-preview-not-stable-release`, overlay digest and packaged binary/backend/wrapper hashes. The legacy rc.5 development identity remains a Dev-profile compatibility identifier, not release provenance. No new Stable promotion, version freeze, signing/notarized release or installation is claimed. A future release needs a new reviewed source freeze and release acceptance; do not rewrite old manifests to make the feature pass a historical promotion check.

## Remaining limits

- Interactive **Codex Desktop host reconnection is still unverified**. SDK-host and native-owner fixtures do not satisfy that acceptance item.
- The installed Stable `Yosh.app` was not replaced, started or upgraded for this PR. Safe selection was verified in the independent native test/preview path; it is not a claim about the installed Stable UI.
- Public Devnet RPC availability/rate limits vary. Bounded read-only backoff cannot guarantee provider availability and never relaxes safety preflight.
- Simulation currently exposes status through MCP and does not pretend to deliver paid resources.
