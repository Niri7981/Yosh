# Yosh Plugin Edition 0.2.4: standalone Mainnet

The plugin is an independent product. Yosh.app is an optional management interface. This completes the independent Mainnet runtime for the same Plugin Edition introduced in [PR #5](https://github.com/Niri7981/Yosh/pull/5), preserving its unified Grant page, explicit network selection, purchase queries and diagnostics. It makes the existing Mainnet installation usable without launching or reading Yosh.app, while preserving its wallet, authorization and payment core.

## Scope

1. Package and start a standalone Mainnet backend on demand from the plugin.
2. Reuse the existing Keychain wallet, stable CardMember, Spend Grants, monetary controls, ledger and original-payment recovery.

This stage requires an existing configured Mainnet installation. New-user wallet setup, additional Mainnet management screens, automatic Mainnet runtime upgrades, public distribution and native App attachment to an already-running standalone backend are separate work. Engineering acceptance used read-only calls; the user subsequently completed the separately authorized real purchase documented below.

## Runtime and ownership

The local plugin candidate is version **0.2.4**. Its dedicated Mainnet bundles compile with the existing RC5 profile. The isolated Devnet bundle retains its existing profile and data contract; Mainnet is not enabled by weakening the Devnet sandbox.

The verified Mainnet subset is installed under `~/Library/Application Support/Yosh Mainnet Runtime/<manifest SHA256>`. It contains its own Node, Mainnet backend and MCP wrappers, Pay binaries, sandbox profile and licenses. Plugin cache removal does not remove the running service's files. The manifest records source and dependency provenance; these local development artifacts are not a notarized public distribution.

The Mainnet sandbox denies access to `.app` bundles. This is an App-dependency check, not a general filesystem or Keychain security sandbox. Existing backend authentication and policy remain authoritative.

The launcher reads the original OS account's Mainnet configuration with ownership, permission, schema and identity checks. It does not accept an alternate data directory or inherited signer configuration. macOS's current HTTPS proxy is passed before Node starts; a proxy change between launch and backend initialization fails closed. This does not promise that a proxy or RPC provider will be reliable.

On every Mainnet tool dispatch, the plugin checks authenticated backend readiness. It reuses a matching original App backend when present, or starts one standalone owner. A startup lock serializes concurrent launches. The standalone service lock and original backend/ledger writer locks remain held through payment drain. An unavailable or unauthenticated listener is not treated as an absent backend. A different standalone runtime digest is rejected, including after shutdown; compatible automatic Mainnet upgrades are not implemented here.

Shutdown requests bind to the receiving process's PID, hosting kind and runtime digest before `prepareQuit`. The standalone stop command cannot stop an original App backend. Repeated signals and owner-metadata write failures must not bypass the payment drain. A closed listener alone is insufficient to report completed shutdown.

## Existing economic identity

The service opens the existing `Yosh Pay Dev v0.1.1-rc.5/Mainnet` directory. It does not copy a database, create a wallet, alter a Keychain ACL, reset a Grant or change monetary controls. Existing signer-selection rules and wallet/public-key matching remain in the original backend.

Both product entries use the same AppRuntime and Pay execution/recovery implementation. Standalone hosting only supplies the verified package's recovery binary location and hosting metadata. It skips App-owned Codex MCP migration/registration. The original App MCP configuration and default App behavior remain intact.

The plugin's Mainnet MCP adapter restricts tools using an allowlist. Read-only purchase and delivery queries are included. Wallet mutation, arbitrary signing and policy-management tools are not exposed. `recover_payment` remains an execution-capable operation requiring its existing authorization rules; it is never used by this read-only acceptance.

## Verification

Automated coverage includes configuration and legacy signer selection, preserved execution flags, malformed/private storage, HTTP proxy startup semantics using a loopback-only fixture, authenticated original-backend attachment, concurrent cold starts, version fences, safe stop/drain, port replacement, tool filtering, controlled Mainnet payments and original-payment recovery. Tests use temporary data and fixture signers, not the real wallet.

The final combined regression command passed **13 files / 199 tests**, and the Python packaging suite passed **10 tests**. `npm run typecheck`, `npm run lint` and `npm run build` pass. The build retains the existing dynamic-filesystem tracing warning in `pay-mainnet-control.ts`. The first build attempt rejected a cross-worktree `node_modules` symlink; a local dependency copy resolved it without changing source or lockfiles.

Engineering acceptance on 2026-11-13 established:

- The installed App exited normally before standalone launch. The independent service listened alone on `127.0.0.1:13449`, from its own content-addressed Node path.
- Two concurrent cold starts returned the same PID. Standalone stop drained successfully; a subsequent restart succeeded.
- The original App was reopened after stopping standalone. Its original bundled backend and existing MCP entry still read the original wallet, CardMember, Grant and purchase evidence; it then exited normally again.
- The original wallet address, Grant ID/version, CardMember, integer balance and previous confirmed purchase matched before and after the ownership handoff. There were no unresolved payments or reserved funds before handoff.
- The sandbox rejected an attempted read of the installed App's public `Info.plist`.
- Final comparison preserved all 22 installed App files, nine protected configuration files and ten economic/evidence table fingerprints across standalone/App handoffs and plugin installation.
- Two fresh real Codex app-server hosts installed the verified ZIP into a private Codex home. Each used the actual 0.2.4 cache, with zero App-bundled executables in its process descendants. The first host cold-started Mainnet; the second reused the same standalone PID. Closing either host did not stop the backend. Both called only `get_spending_status` and `get_purchase`; all 16 checked economic/evidence tables remained unchanged.
- The combined Devnet runtime used its existing explicit compatible-upgrade path. Eight Devnet economic tables and protected control files stayed unchanged after upgrade and fresh-host runs. No wallet, Grant or budget was created.
- The daily local marketplace and plugin cache were updated to 0.2.4 through the existing plugin installer; the previous marketplace source was preserved. Original Codex configuration and App MCP registration remained unchanged. The current Desktop chat's already-connected MCP process was not restarted or claimed to be 0.2.4.

The reusable host probe is `scripts/test-mainnet-standalone-host.py`. It distinguishes unrelated old MCP clients from the fresh host's process tree. For a stopped WAL-mode database whose normal read-only query requires missing sidecars, it permits an immutable snapshot only under the existing backend ownership lock, with no listener, no nonempty WAL and unchanged file metadata. It never writes economic tables or calls payment/recovery tools.

Private local evidence is in `build.noindex/mainnet-standalone-acceptance-20261113/final-evidence.json` and `build.noindex/mainnet-standalone-host-024-20261113-r3/evidence.json`. The final independent owner was PID 21361; this is an observation at acceptance time, not a persistent process identifier.

Final package identities:

| Artifact | SHA256 |
| --- | --- |
| Mainnet manifest | `3528acd8305f5a9ca27efac74dd10a070f28b0c02f2c391a4a7b0f637443f169` |
| Combined runtime manifest | `4d2214517cfcca9c14b16e23199596a7dbc8ea0b4e30e1b2756b093bb70b8852` |
| Plugin ZIP | `0c28756ca2bc0bb483c3fba63e782907977d64c6bc8bac2b5f3ba7ca8d82be1b` |

The accepted package was built from merged plugin base `cdd8283` plus the changes subsequently organized in this PR; all 680 bundled source inputs and three license hashes were verified. Its recorded source HEAD alone does not identify the accepted artifact: use the manifest, input hashes and package identities above. Git archival does not replace the already accepted local runtime. Build and operational evidence stays under ignored `build.noindex/`; private configuration, ledger contents and credentials are not committed.

## User acceptance: real Mainnet purchase

On 2026-11-13, the user confirmed that Yosh.app remained closed throughout a new plugin session: they created a new Mainnet Grant through the authorization page, approved one Agent402 crypto-price purchase, and received the API result. Their screenshot reports a 0.001 USDC payment with `PAID` and `COMPLETE`, returning BTC, ETH and SOL price data. The screenshot is user-supplied acceptance evidence; it is not committed as a local desktop capture.

Subsequent read-only plugin calls to `get_spending_status` and `get_purchase` independently matched the durable purchase record:

| Field | Recorded value |
| --- | --- |
| Resource | `agent402-crypto-price` |
| Network / asset | Solana Mainnet / native USDC, 6 decimals |
| Amount | `1000` atomic units (0.001 USDC) |
| Purchase ID | `pay_4b69cafe76bfe50d2347ee565dcdd948cd222b578553b7354d7e82a82900` |
| Payment / delivery / receipt | `PAID` / `COMPLETE` / `CONFIRMED` |
| Authorization | New Spend Grant, version 6 |
| Policy result | `AUTHORITY_BUDGET_AND_GRANT_PASSED` |
| Transaction | [View on Solana Explorer](https://explorer.solana.com/tx/3Tvtzari1cyviE73Hci5pJMQe98tAgn8CBK4LtMpXLwStaXfXGLNpiLGduKhLcLesY8cwXsrBDytJAMSSwfEKKvS) |

The unchanged-table checks above apply to the earlier read-only engineering acceptance. The later user-authorized Grant and purchase legitimately changed those records. This archival/README task made no new purchase, recovery or authorization call. `CONFIRMED` here is the backend's persisted receipt status; no separate fresh chain verification is claimed. This is evidence for one GET purchase, not for live recovery, POST purchases, clean-machine onboarding or guaranteed RPC availability.

## Compatibility boundary

The original App binary is unchanged and was not replaced. The existing App does not yet attach its native UI to an already-running standalone service; its port-conflict guard still prevents competing backends. To switch back to that App version, stop standalone normally before opening App. The plugin itself does not require this switch or any App process.

Runtime source, packaged files, a running backend, and a host's already-connected MCP process are distinct versions. A newly installed plugin does not prove an existing Codex chat has reconnected. Fresh-host results and the current Desktop session must be reported separately.
