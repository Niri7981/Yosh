# Yosh × Pay — 2026-10-21 source archive

This archive preserves the completed MCP-first work and its actual funded
acceptance source. It does not authorize a payment, switch Mainnet execution,
change Pause, deploy an App, or migrate live data. No funded test was repeated
while creating the Git archive. Private receipts and the live Ledger remain local.

## Actual funded source

The explicitly authorized Agent402 purchase cost **0.001 native USDC on Solana
Mainnet**. Its transaction finalized, Yosh recorded **PAID / CONFIRMED /
COMPLETE**, and purchased API data was returned. The public transaction identifier
and source fingerprints are recorded in [source-manifest.json](source-manifest.json).
This records the earlier acceptance, not a fresh runtime observation.

| Component | Exact archived source | Evidence |
| --- | --- | --- |
| Yosh backend and MCP wrapper | `cfb4b1add680bbfdf0487ce86d487c9a64bdf118` | All 107 backend and 27 wrapper product TypeScript inputs loaded from the Git commit rebuild to the installed SHA-256 values. |
| Pay MCP functional source | `df1f0eecb0353af7f78dc6b3d77c957ee361e167` | Ten inspected source fingerprints match the funded host/controller build provenance. Machine-local Cargo mappings are excluded. No byte-identical Rust rebuild claim. |
| pay-kit unsigned preparation | `c27d6b59f5ff31c0ba7575505e4a35eac5702685` | The production-linked `exact/payment.rs` bytes match the archived additive SDK seam. |
| pay-kit focused tests/docs | `837e6deebaeaef2999d57c50cfba6338a4b7a8a6` | Same runtime source plus five unsigned tests and custody documentation. |

The funded package was **Yosh Pay Dev.app**, not the formal Yosh.app. The
original source was the isolated `pay-mcp-first-integration` workspace, with
adjacent `pay` and the packaged `pay-kit-current` crate. The older PoC kit and
original Pay research checkout are not the funded implementation.

## Later source retained separately

The following work existed after the funded package was built and is archived
without installing it:

- Yosh `538345d`: signer-free unsigned preflight using Pay's actual classifier
  and SDK builder, plus explicit provider/resource/URL binding in v2 receipts.
- Pay `6e0a21b`: the corresponding read-only unsigned entry point. The subsequent
  merge retains the already published `51b23a7` URL-credential safety fix and its
  original author/history.
- Reviewed source documents, public policy, archive hygiene and this provenance.

The installed funded package used **v1** one-operation consent. Archive HEAD's
**v2** receipt tightening is not evidence of a later deployed or funded run.
App confirmation popovers are not required for this Dev acceptance: Yosh App
configures authority; Codex initiates the exact purchase through Pay MCP. The
user reviewed and explicitly authorized the strict one-use CLI confirmation.
Expired or changed terms still require new human review. No saved receipt in
this repository can approve a payment.

## Validation and rebuilding

The archive validation passed 1169 Yosh tests (one opt-in live test skipped),
15 separate protocol-production cases and three installer/configuration tests.
Typecheck, ESLint, Next production build, native launch configuration checks
and a separate macOS Release build passed. The production build retains two
existing dynamic filesystem tracing warnings. The native build reported Xcode
CoreDevice/Simulator diagnostics and skipped optional AppIntents metadata;
macOS compilation succeeded. No App was installed, stopped or launched.

Pay verification passed 145 MCP, 18 External Authority and 11 HTTP tests,
plus its quote-selection regression; one existing worker remains ignored.
Kit verification passed 34 exact-payment, 22 transaction and two signing tests.
Tests used isolated temporary state with external network and real Keychain
denied. Full private logs and local hash evidence stay under `build.noindex`.

For ordinary Yosh checks after installing the locked Node dependencies:

```sh
npm run typecheck
npm run lint
npm run build
python3 scripts/test-pay-integration.py --all
bash tests/native/backend-launch-configuration.sh
```

The full isolated test runner also expects the prepared Pay/protocol test
binaries and local vendored Rust dependencies described in the dated integration
records. It is not a clean-checkout bootstrap command by itself.

`source-baselines.json` and the strict build helper intentionally retain the
original pre-archive HEAD/fingerprint guard. Do not remove that guard to make a
new archive checkout pass. For another reviewed source layout, supply an explicit
fresh `--baseline` manifest to `scripts/build-pay-mcp-first.py`, or build the
reviewed Cargo workspace with its locked dependency mapping and an isolated
`CARGO_TARGET_DIR`. The absolute local vendor overlay and `../../pay-kit-current`
path used during acceptance are not portable source dependencies. The Pay and
kit archive branches must be obtained together with their reviewed SDK pin.
Building this source is separate from authorizing installation or Mainnet use.

## Local material deliberately excluded

Only reviewed allowlists were staged. Live wallet literals in newly archived
preflight examples were replaced with placeholders or deterministic fixtures.
No wallet configuration, seed, private key, Keychain data, connection credential,
private confirmation, signed payment header, actual database or raw acceptance
capture was added. Public chain transaction identifiers are not signing payloads.

Historical JSON/JSONL/TXT state dumps, patch exports, proposed local MCP config,
image-generation prompts, baselines, build outputs and caches remain local.
The source-only compatibility tar and its hash manifest are intentional test
fixtures; their members were inspected separately for sensitive data.

The dirty original Desktop and older production worktrees are preserved. Their
shared completed changes are represented in the new archive; no source was
reset, overwritten or committed from those other worktrees.
