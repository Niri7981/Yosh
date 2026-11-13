# Yosh Codex plugin development

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
> 2026-11-12：当前日常开发入口统一为 Yosh Dev 0.2.0，固定插件 ID `yosh-local-dev@yosh-standalone-testing`。不按 Mainnet/Devnet 拆分插件；下文独立 App/Offline 架构是历史阶段记录。当前交付、更新和验收规则见 [单一 Dev 插件交付](yosh-dev-unified-delivery-20261112.md)。

This is an isolated local preview on `codex/yosh-codex-plugin`, based on
`d170d74d25c5d47f3e012cb3e22301a96a6add3d`. It does not replace stable Yosh,
its wallet, existing Codex MCP connection, or historical frozen release builds.

## Runtime identity

| Property | Plugin Dev |
| --- | --- |
| App | `Yosh Codex Plugin Dev.app` |
| Bundle identifier | `com.yosh.codex-plugin-dev` |
| Required bundle flags | `YoshPayDevelopment`, `YoshCodexPluginDevelopment` |
| Data | Current OS user's `Library/Application Support/Yosh Codex Plugin Dev` |
| Backend / merchant / RPC | Loopback only, `14449 / 14450 / 14451` |
| Management / Agent credentials | New private files in the Dev directory |
| PIN Keychain service | `com.yosh.codex-plugin-dev.app-lock.v1`; normal Dev session does not load a PIN |
| Networks | Offline fixtures or status-only Simulation; live Devnet and Mainnet rejected |

Offline generates its own local test signer and simulated merchant/chain state.
It does not copy any stable wallet, Keychain item, Grant or ledger. Native App
owns backend startup, supervision and graceful shutdown. Plugin termination ends
only its MCP child, never the backend's original-payment lifecycle.

## Reproducible build

Requirements: Apple Silicon macOS, Xcode/macOS SDK, Python 3.9+, installed Rust/Cargo,
and Node/npm for development. The delivered App supplies Node 24.21.0 and both Rust
binaries; the plugin launcher needs only macOS tools and that App's Node.

Explicit inputs:

- Pay `402f67c44dd8d41d7d1584fcb5d868006ce8c891` (#530), whose lock pins
  pay-kit `7f1369180ca4b047aadff1bea77aed4525e10039`.
- A matching clean pay-kit checkout including pinned submodules and offline Cargo
  vendor sources. Vendored pay-kit source bytes must match the selected checkout.
- Current repository `integration/release-candidate/pay-overlay/` files, separately
  hashed alongside their historical frozen hashes.
- Official `node-v24.21.0-darwin-arm64.tar.xz`, SHA-256
  `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe`.
- `package-lock.json` and a fresh `npm ci --ignore-scripts --no-audit --no-fund`.

Run from this worktree, substituting verified absolute input paths:

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 -B scripts/build-codex-plugin-dev.py check \
  --pay /absolute/pinned-pay --pay-kit /absolute/pinned-pay-kit \
  --cargo-home /absolute/offline-cargo-home --node-archive /absolute/node-archive.tar.xz
python3 -B scripts/build-codex-plugin-dev.py build \
  --output build.noindex/codex-plugin-dev-delivery \
  --pay /absolute/pinned-pay --pay-kit /absolute/pinned-pay-kit \
  --cargo-home /absolute/offline-cargo-home --node-archive /absolute/node-archive.tar.xz
python3 -B scripts/build-codex-plugin-dev.py verify \
  --output build.noindex/codex-plugin-dev-delivery
```

`prepare` is also available separately. The builder exports the pinned Pay Git
objects, applies only the two declared current overlays, compiles both Rust
binaries offline/locked, bundles backend/MCP with `__YOSH_PLUGIN_DEV__`, builds
the native shell, signs locally and verifies the complete artifact inventory.
No cached executable is an input. Preparation locks source/dependency bytes;
source changes require a fresh output directory. Build sandbox denies network,
Keychain, product data and formal Codex config access. It never installs or launches.

The earlier stable precheck failed because cached Pay carried the frozen overlay
while current Yosh includes two subsequent Devnet flag changes. The quote fixture
matched. This Dev entry records that distinction; historical frozen builders,
`final-source-lock.json`, and their validation rules remain unchanged.

## Install and start the separate Dev App

Use the verified staged `Yosh Codex Plugin Dev.app`. Copy it to the current OS
user's `Applications/Yosh Codex Plugin Dev.app`, preserving the existing formal
`Yosh.app`. Preserve any earlier Dev artifact; quit only Dev normally and wait for
all three Dev listeners to stop before replacing a Dev installation. Local builds
are ad hoc signed, not notarized public releases.

Open the separate App. `Connection → Connect` enables its isolated Agent
capability without writing the formal MCP entry. Grants, budgets and pauses stay
behind the existing authenticated native management interface. Do not give the
plugin management credentials. Closing the window keeps the backend alive;
quitting safely stops it.

The launcher validates App identity/signature, private data/descriptor ownership,
fixed origin/member/connection scope, and authenticated Agent readiness. It opens
only that Dev App when necessary, waits for readiness, then launches its
`Runtime/mcp.cjs → pay-mcp`; it never launches `npm run mcp` or a separate wallet.
An explicit `YOSH_CODEX_PLUGIN_APP` is supported when launching directly; the
host must explicitly pass it through its supported environment configuration.

## Plugin package and host validation

```sh
python3 -B scripts/package-codex-plugin.py
python3 -B scripts/accept-codex-plugin-dev.py install \
  --app "$HOME/Applications/Yosh Codex Plugin Dev.app"
python3 -B scripts/accept-codex-plugin-dev.py probe \
  --app "$HOME/Applications/Yosh Codex Plugin Dev.app"
python3 -B scripts/accept-codex-plugin-dev.py call \
  --app "$HOME/Applications/Yosh Codex Plugin Dev.app" --tool get_spending_status
```

The deterministic ZIP and file manifest are under
`build.noindex/codex-plugin-package/`. The repo marketplace is
`.agents/plugins/marketplace.json`; selector `yosh-dev@yosh-development`.
The acceptance helper installs into its own `build.noindex/.../codex-home`,
starts the installed Codex app-server, inspects actual tools/Skills and calls real
MCP tools without a model turn, login, desktop restart or formal config edits.
`--state` selects a fresh isolated installation for each package revision.
Changing a local source does not prove the installed cache was refreshed.

The portable MCP schema differs from `config.toml`: use bare `bash`, relative
plugin paths and supported `env` maps. `/bin/bash` and `env_vars` caused this
Codex version to silently omit the MCP server; packaging rejects both now.
The App path is not embedded in the distributable plugin.

Offline tools are exactly `curl`, `get_spending_status`, `get_purchase`,
`get_purchase_delivery`, `quote_x402_resource`, `discover_x402_resource`, and
`register_x402_resource`. Discovery accepts only backend-declared GET test URLs
returned by `get_spending_status.discoveryUrls`. It uses the existing Agent-bound
discovery credentials and registry transaction. Each newly registered resource
requires its own Grant; historical fixture Grants cannot authorize it. The fixed
test routes are distinct from legacy fixture paths, whose existing Grants and
purchase identities remain unchanged. Upstream catalog, top-up, sale, balance and Skill-writing tools are
filtered and direct calls rejected. Simulation exposes only spending status.

Purchase queries enforce Agent ownership and expose bounded, whitelisted facts,
never signing payloads. `curl` reports the durable rejection reason from that
operation, rather than guessing from today's global readiness. Payment and
delivery states remain separate. `recover_payment` may execute payment and is
not an Offline query tool. Explicitly authorized Offline recovery reuses the
original request/operation ID; no replacement payment is created.

## Test evidence and remaining boundaries

Automated tests cover compile/runtime isolation, malformed credentials and
scope, original-owner queries, refusal mapping, wrapper allowlists, launcher
failures, original transaction accounting and restart recovery. Required
`typecheck`, `lint`, Next build, native build, signing and artifact checks run
separately. Prepared-Rust integration stays outside ordinary `npm test`:

```sh
python3 -B scripts/test-codex-plugin-integration.py \
  --output build.noindex/codex-plugin-dev-delivery
```

This verifies the staged App first and uses its pinned runtime dependencies with
fresh temporary profiles. Next build currently reports existing broad filesystem tracing
warnings in `pay-mainnet-control.ts`; browser chunks must not contain signing
implementation or private inputs.

Actual installed Codex app-server evidence is kept as sanitized private JSON
under `build.noindex/codex-plugin-host-final/evidence`. The scenario run exercised
25 steps including no Grant, quote, purchase, chunked delivery, repeats,
concurrency, pause, budget denial, unknown payment and paid-but-undelivered
recovery. Both faults recovered after authenticated Dev backend restart and
Codex child restart using the original transaction; transaction counts did not
increase on recovery. These are local simulated funds, not blockchain payments.
Fixture authority was prepared with the isolated authenticated management API.
Separately, the user confirmed native Grant creation; a real Codex read verified
Active, total `1000000`, per transaction `200000`, and paused status. Neither
authority setup nor registration creates permission for another resource.

Operator-only fault file:
`<PluginDevRoot>/simulator/offline-fault.json`, private owner/0600, schema
`{"version":1,"mode":"none"}`. Other fixed modes are
`lose-paid-response-and-rpc` and `delivery-unavailable`. Only plugin Offline reads
it; no Agent/MCP route controls faults. Unknown payments retain reservations.
Clear the fault and query/recover the same operation; do not delete records.

Not established by this preview: arbitrary public merchant compatibility, live
funds, an actual Desktop GUI plugin installation/restart, natural-language model
routing, public directory approval or notarized distribution. Offline discovery
and registration cover only the backend's declared test merchant GET endpoints;
production HTTPS/SSRF rules are unchanged. Successful new resource lifecycle
acceptance is recorded separately from the earlier 25-step core scenario.
These limits are explicit in Skills and plugin presentation. Formal connection
migration or stable App upgrade requires the user's separate instruction.
