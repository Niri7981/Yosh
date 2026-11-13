# Yosh

> Give your agent a card, not your wallet.

**Let your agent buy APIs within the limits you set.** Yosh keeps wallet keys in macOS Keychain, checks each purchase against your permissions and budget, and records both payment and delivery.

Use Yosh directly as a plugin in Codex. The plugin starts its own local payment backend; **Yosh.app does not need to be open**. The native macOS App remains an optional management interface, backed by the same payment core.

## Plugin Edition

**Plugin Edition 0.2.4** combines API discovery, Spend Grants, controlled Mainnet purchases and purchase queries in one plugin. Mainnet uses the existing Yosh wallet and records. Devnet uses separate test funds and state. Every wallet, API and purchase call selects its network explicitly.

| Entry point | Version and availability |
| --- | --- |
| Plugin Edition | **0.2.4**, locally packaged and accepted in Codex on macOS. Not yet published in the public Codex plugin directory. |
| Native macOS App | **0.1.1, build 7**. See the [stable App release record](docs/releases/v0.1.1.md) and [App guide](docs/guides/native-app-getting-started.md). |
| Historical public download | The [website download](https://2049-web.vercel.app/) is **0.1.0 Beta**, not the 0.2.4 plugin package. |

**Mainnet setup boundary:** the current plugin requires an existing configured Yosh Mainnet installation, including its Keychain wallet and monetary controls. It does not yet provide fresh Mainnet wallet creation/import or complete first-time onboarding. Once that setup exists, the plugin can authorize and purchase without launching the App.

On **November 13, 2026**, user acceptance completed a new Grant and a **0.001 USDC** Agent402 purchase with Yosh.app closed throughout. The purchase returned `PAID` and `COMPLETE` with the API result. See the [standalone runtime and acceptance record](docs/architecture/mainnet-standalone-runtime-20261113.md). This follows the [0.2.3 plugin milestone](docs/architecture/plugin-milestone-20261112.md), which used an App-hosted Mainnet backend.

## Get started with the plugin

The verified host is Codex on Apple Silicon macOS. The local plugin package includes Node, Pay MCP and its backend; using the package does not require a source checkout or a separate Node installation.

### 1. Install the local package

Use a verified Plugin Edition package supplied by the project or [build one from source](#development). After extracting its ZIP, add the included local marketplace and install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/yosh-standalone-marketplace
codex plugin add yosh-local-dev@yosh-standalone-testing
```

The current development UI name is **Yosh Dev — 开发验收版**. `yosh-local-dev@yosh-standalone-testing` is the single plugin identity for both Mainnet and Devnet. These commands install from the local marketplace you supplied; another account will not find this package by searching the public directory.

For an existing local installation, follow its version-specific upgrade procedure. Replacing a plugin cache alone does not upgrade a running backend, and automatic Mainnet runtime upgrades are not implemented. An incompatible runtime is rejected. See the [runtime record](docs/architecture/mainnet-standalone-runtime-20261113.md) for the current boundary.

### 2. Start with a status check

Keep Yosh.app closed and start a new Codex chat, or reconnect the plugin after an update. Confirm that the host loaded the installed version, then ask:

> Use the Yosh plugin on Mainnet to check my wallet, balance, daily allowance, Grant and latest purchase. Only read status; do not purchase or recover a payment.

The plugin starts or connects its independent backend on demand. Closing a chat does not stop that backend or discard payment state. `get_spending_status` reports readiness and blockers; it does not grant permission to spend.

### 3. Choose an API and authorize it

For a new API, first ask Yosh to inspect and register it without purchasing:

> On Mainnet, inspect [API URL] and register it if supported. Report its Resource ID, quote and required inputs. Do not purchase yet.

A **Resource** identifies the API and its permitted request inputs. Registration creates no spending authority. JSON POST discovery requires separate user confirmation of the exact outbound request before it is sent.

Next, ask for the Mainnet authorization page:

> Open Yosh's Mainnet authorization settings so I can review and create a Spend Grant for [Resource ID].

`open_local_settings` returns the local page. Review the API, network, asset, recipient constraints, total limit, per-purchase limit and expiration, then confirm through the system confirmation window. The Agent cannot confirm for you. After confirmation, ask Yosh to refresh the Grant status.

A Grant covers one Agent and Resource. Its total applies across the Grant's lifetime. **Daily Authority** is a separate shared daily limit that includes both paid and reserved amounts; neither allowance is your wallet balance. The existing Mainnet daily limit and pause state are preserved by the plugin. This version's Mainnet Grant page does not edit them.

### 4. Buy once and check the result

When the wallet, Grant, daily allowance and execution settings are ready, give a specific purchase instruction:

> Use Yosh on Mainnet to purchase Resource [ID] once with [inputs], for [purpose], spending at most [amount] USDC. Report the purchase ID, payment status, delivery status and result. If the outcome is uncertain, check the original purchase instead of creating another.

Yosh checks a fresh quote, reserves the amount atomically, and rechecks authorization before signing. A successful purchase should have evidence for **both payment and delivery**. Use `get_purchase` to inspect the original purchase and `get_purchase_delivery` to read its stored result.

If an outcome is pending or unknown, keep its purchase/operation ID. Status and delivery queries are read-only. `recover_payment` can execute the original payment and is a separate operation; recovery must not create a replacement purchase or charge again for an already-paid delivery.

## What Yosh controls

| Capability | What it means |
| --- | --- |
| Spend Grants | Revocable authority scoped to an Agent, API, payment conditions, amount limits and expiration. |
| Daily Authority | Shared daily spending limits and pause, with atomic reservations before execution. |
| Local custody | Keys remain in macOS Keychain; the backend verifies the expected wallet and signs. |
| Resource Registry | Validated API definitions, constrained GET/JSON POST inputs, samples and delivery declarations. |
| Purchase records | Stable purchase identity, separate payment/delivery states and bounded stored results. |
| Original-payment recovery | Durable evidence and retry progress for the original purchase, subject to merchant support. |
| Runtime ownership | One backend owns a given ledger; concurrent plugin connections cannot start competing payment owners. |

## One payment core, two entry points

The plugin and native App share authorization, signing, accounting and recovery code. The plugin supplies an independent runtime; the App supplies a native control surface. Neither gives the Agent a management token, private key or arbitrary signing capability.

| Layer | Responsibility |
| --- | --- |
| Plugin / MCP | Explicit network selection, API discovery, purchase requests and bounded queries. |
| Authorization page / native App | User review and trusted confirmation of permitted changes. |
| Local backend | Authentication, Grants, budgets, exclusive execution, Keychain signing and the SQLite ledger. |
| Pay and official x402 SDK | MCP request flow, offer selection and supported payment protocol handling. |

The existing App and its data are preserved. **The current native App does not attach its UI to an already-running standalone backend.** To switch back to that App version, stop standalone normally before opening it. See the [native App guide](docs/guides/native-app-getting-started.md) for its existing workflow.

### Pay integration

Yosh uses the external [Spending Authority interface](https://github.com/solana-foundation/pay/pull/514), [unsigned transaction preparation](https://github.com/solana-foundation/pay-kit/pull/393) and [host-controlled execution](https://github.com/solana-foundation/pay/pull/530) to keep user authority and custody in the local backend while reusing Pay's protocol implementation.

Builds use pinned, verified Pay/pay-kit sources. The [source record](docs/releases/v0.1.1-rc.5-final-source.md) and [plugin build notes](docs/architecture/codex-plugin-dev.md#reproducible-build) identify those inputs; the links above explain the interfaces without implying a particular upstream merge state.

## Current scope

| Area | Verified scope and remaining work |
| --- | --- |
| Mainnet payments | Solana Mainnet, native USDC, supported x402 V2 `exact` flow. |
| API requests | Constrained GET and JSON POST. GET has real purchase evidence; live POST purchase acceptance remains outstanding. |
| Delivery | Bounded JSON and declared text, including HTTP 200/201. No arbitrary media or streaming. |
| Recovery | Automated coverage for original-payment and delivery recovery. Actual merchant recovery remains unverified. |
| Mainnet onboarding | Existing wallet/configuration reuse works. Fresh wallet creation/import and complete first-time setup remain future work. |
| Distribution | Local macOS development package. Public plugin listing, notarized distribution and clean-machine acceptance remain future work. |
| Other hosts and payment methods | Codex is the verified host. Other hosts, networks, assets and payment schemes need separate validation. |

Missing or expired authorization, pause, insufficient allowance, invalid quotes and signer mismatch block new payments. Unknown outcomes retain their reservation and evidence. API discovery inspects endpoints supplied to it; it is not a global API marketplace. Refunds are not supported, and third-party delivery cannot be guaranteed.

## Development

Plugin development requires Apple Silicon macOS, Node.js 24.5+, npm, Python 3.9+, Rust/Cargo, and Xcode/macOS build tools. Dependency builds use pinned Pay/pay-kit checkouts, offline Cargo inputs and the verified Node archive listed in the [build notes](docs/architecture/codex-plugin-dev.md#reproducible-build).

From a verified dependency artifact, build and package the combined Mainnet/Devnet plugin in new output directories:

```sh
python3 -B scripts/build-standalone-dependencies.py verify \
  --output build.noindex/standalone-dependencies
python3 -B scripts/build-standalone-dev.py \
  --dependencies build.noindex/standalone-dependencies \
  --local-authorization --output build.noindex/plugin-runtime
python3 -B scripts/package-standalone-plugin.py \
  --runtime-package build.noindex/plugin-runtime \
  --output build.noindex/plugin-package
```

The first command verifies an artifact already produced by `build-standalone-dependencies.py build`; it does not download or create dependencies. Packaging produces a local `marketplace/`, plugin ZIP and checksum evidence under `build.noindex/plugin-package/`. These build commands do not install the plugin, start a backend, create a wallet or authorize a payment.

Run `npm run typecheck`, `npm run lint`, `npm run build` and the relevant tests before delivery. Mainnet acceptance is separate from fixture testing and requires explicit purchase authorization. [Standalone acceptance](docs/architecture/mainnet-standalone-runtime-20261113.md) documents the host checks and evidence boundaries. Native App builds retain their [stable release process](docs/releases/v0.1.1.md).

## Documentation

- [Documentation index](docs/README.md)
- [Plugin 0.2.4 runtime and acceptance](docs/architecture/mainnet-standalone-runtime-20261113.md)
- [Plugin 0.2.3 milestone](docs/architecture/plugin-milestone-20261112.md)
- [Native macOS App guide](docs/guides/native-app-getting-started.md)
- [Resource and purchase lifecycle](docs/architecture/resources/agent-purchase-lifecycle.md)
- [Architecture index](docs/architecture/README.md)

Contributions to wallet onboarding, reproducible merchant compatibility, plugin distribution and additional Agent hosts are welcome.
