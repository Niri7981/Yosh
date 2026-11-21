# Yosh

> Give your agent a card, not your wallet.

**Let your agent buy APIs within the limits you set.** Yosh keeps wallet keys in macOS Keychain, checks each purchase against your permissions and budget, and records both payment and delivery.

Connect Codex, Claude Code or Grok CLI to the same Yosh installation on your Mac. Each agent has its own identity and spending permissions. The wallet and account statement are shared. **Yosh.app can stay closed.**

## Plugin Edition

The local MCP lets a registered agent read the shared statement, inspect a registered GET resource and request a purchase. The owner can grant statement access independently. A purchase requires an applicable Grant for the calling agent and resource, or native confirmation for that order. The local first-use tools use Mainnet. Tools that offer a choice of network require an explicit selection.

| Entry point | Version and availability |
| --- | --- |
| Plugin Edition | **0.2.17** was tested on a Mac with a real Grok purchase. Current source builds **0.2.18** with an optional per-order price ceiling. Packages are distributed locally. |
| Native macOS App | **0.1.1, build 7**. See the [stable App release record](docs/releases/v0.1.1.md) and [App guide](docs/guides/native-app-getting-started.md). |
| Historical public download | The [website download](https://2049-web.vercel.app/) is **0.1.0 Beta**, not the current plugin package. |

**Mainnet setup boundary:** the current plugin requires an existing configured Yosh Mainnet installation, including its Keychain wallet and monetary controls. It does not yet provide fresh Mainnet wallet creation/import or complete first-time onboarding. Once that setup exists, the plugin can authorize and purchase without launching the App.

On **November 13, 2026**, user acceptance completed a new Grant and a **0.001 USDC** Agent402 purchase with Yosh.app closed throughout. The purchase returned `PAID` and `COMPLETE` with the API result. See the [standalone runtime and acceptance record](docs/architecture/mainnet-standalone-runtime-20261113.md). This follows the [0.2.3 plugin milestone](docs/architecture/plugin-milestone-20261112.md), which used an App-hosted Mainnet backend.

On **November 17, 2026**, the standalone plugin completed a **0.001 USDC MPP Solana Charge** purchase from AgentFeed, with **5,001 lamports** in network fees, while Yosh.app stayed closed. Original chain evidence and persisted delivery confirmed `PAID / COMPLETE`; a fresh independent Codex session verified the native MCP read tools. See the [MPP acceptance record and remaining limits](docs/demo/mpp-mainnet-plugin-20261117.md).

## Get started with the plugin

On Apple Silicon macOS, the local package includes Node, Pay MCP and the Yosh backend. The existing Mainnet wallet stays on the Mac.

### 1. Install the local package

Use a verified Plugin Edition package supplied by the project or [build one from source](#development). Extract the ZIP and run the included `Install.command` to register the shared MCP with installed CLI hosts. Start a fresh host session and ask “Use Yosh to show my Mainnet statement.” On first statement access, confirm the agent name and scope on the Mac.

To also install the full Codex plugin from the extracted marketplace, run

```sh
codex plugin marketplace add /absolute/path/to/yosh-standalone-marketplace
codex plugin add yosh-local-dev@yosh-standalone-testing
```

For a purchase, ask for one registered API and give the agent a maximum amount. The agent can use `describe_purchase_resource` to see the fields before placing the order. For example, a 0.001 USDC cap on `request_purchase` is `maximumAmountAtomic: "1000"`. Each receipt records payment and delivery separately.

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

The page selects **network → payment protocol → API**, filtering APIs to x402 or MPP. MPP Grants also require an explicit per-payment SOL network-fee limit, shown as SOL presets or a custom SOL amount. The backend validates the exact integer lamport limit independently. An existing x402 Grant does not authorize MPP charges.

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
| Pay / pinned protocol SDKs | MCP request flow, offer selection and supported x402 or MPP protocol handling; signing and submission stay in Yosh. |

The existing App and its data are preserved. **The current native App does not attach its UI to an already-running standalone backend, and its pre-MPP reader has not been updated for MPP records.** Keep the old App out of the MPP workflow until that compatibility update is delivered; stopping standalone alone does not resolve this reader limitation. Existing runtime ownership locks remain in place. See the [native App guide](docs/guides/native-app-getting-started.md) for its existing workflow.

### Pay integration

Yosh uses the external [Spending Authority interface](https://github.com/solana-foundation/pay/pull/514), [unsigned transaction preparation](https://github.com/solana-foundation/pay-kit/pull/393) and [host-controlled execution](https://github.com/solana-foundation/pay/pull/530) to keep user authority and custody in the local backend while reusing Pay's protocol implementation.

Builds use pinned, verified Pay/pay-kit sources. The [source record](docs/releases/v0.1.1-rc.5-final-source.md) and [plugin build notes](docs/architecture/codex-plugin-dev.md#reproducible-build) identify those inputs; the links above explain the interfaces without implying a particular upstream merge state.

## Current scope

| Area | Verified scope and remaining work |
| --- | --- |
| Mainnet payments | Solana Mainnet, native USDC, supported x402 V2 `exact` and MPP Solana `charge` flows. MPP requires a verified capability-bearing standalone artifact. |
| API requests | x402: constrained GET and JSON POST. MPP: GET only. Both have real GET purchase evidence; live POST purchase acceptance remains outstanding. |
| Delivery | Bounded JSON and declared text, including HTTP 200/201. No arbitrary media or streaming. |
| Recovery | Automated coverage for original-payment and delivery recovery. Actual merchant recovery remains unverified. |
| Mainnet onboarding | Existing wallet/configuration reuse works. Fresh wallet creation/import and complete first-time setup remain future work. |
| Distribution | Local macOS development package. Public plugin listing, notarized distribution and clean-machine acceptance remain future work. |
| Other hosts | Grok CLI completed a Mainnet purchase on the shared wallet. Claude Code connected and read the Mainnet ledger. Claude real-payment and Dot cloud-host acceptance were deferred. |
| Remote access | The development relay supports scoped statement and saved-result reads. Remote purchases run against the isolated simulated wallet. See [remote reads](docs/architecture/remote-read-p1-20261119.md) and [sandbox purchases](docs/architecture/remote-purchase-p2-20261119.md). |

MPP Session/channel payments, card payments, sponsored fees, splits and ATA creation are outside this version's supported scope. The [MPP architecture record](docs/architecture/mpp-solana-charge.md) documents protocol restrictions, pinned SDK inputs and recovery behavior.

Missing or expired authorization, pause, insufficient allowance, invalid quotes and signer mismatch block new payments. Unknown outcomes retain their reservation and evidence. API discovery inspects endpoints supplied to it; it is not a global API marketplace. Refunds are not supported, and third-party delivery cannot be guaranteed.

## Development

Plugin development requires Apple Silicon macOS, Node.js 24.5+, npm, Python 3.9+, Rust/Cargo, and Xcode/macOS build tools. Dependency builds use pinned Pay/pay-kit checkouts, offline Cargo inputs and the verified Node archive listed in the [build notes](docs/architecture/codex-plugin-dev.md#reproducible-build).

To build the 0.2.18 package with first-use registration and Mainnet MPP, use the verified dependencies and the [MPP protocol artifact](docs/architecture/mpp-solana-charge.md). Set the artifact path to your verified build.

```sh
python3 -B scripts/build-standalone-dependencies.py verify \
  --output build.noindex/standalone-dependencies
python3 -B scripts/build-standalone-dev.py \
  --dependencies build.noindex/standalone-dependencies \
  --local-authorization --mainnet-mpp --mpp-artifact /path/to/verified-mpp-artifact \
  --output build.noindex/plugin-runtime
python3 -B scripts/package-standalone-plugin.py \
  --runtime-package build.noindex/plugin-runtime \
  --output build.noindex/plugin-package
```

The first command verifies an artifact already produced by `build-standalone-dependencies.py build`; it does not download or create dependencies. Packaging produces a local `marketplace/`, plugin ZIP and checksum evidence under `build.noindex/plugin-package/`. These build commands do not install the plugin, start a backend, create a wallet or authorize a payment.

To upgrade an existing Mainnet runtime, follow the owner handoff in the [runtime record](docs/architecture/mainnet-standalone-runtime-20261113.md). It verifies the installed service and waits for active operations to finish.

Run `npm run typecheck`, `npm run lint`, `npm run build` and the relevant tests before delivery. Mainnet acceptance is separate from fixture testing and requires explicit purchase authorization. [Standalone acceptance](docs/architecture/mainnet-standalone-runtime-20261113.md) documents the host checks and evidence boundaries. Native App builds retain their [stable release process](docs/releases/v0.1.1.md).

### Grant UI design preview

The latest frontend design can be opened independently of Yosh.app or a payment runtime:

```sh
node --import tsx design-previews/grant-ui/serve.ts
```

This preview includes the asset portfolio, per-Agent Grant summary, liquid transitions and graphical authorization review. All financial data is synthetic and confirmation is disabled. See the [preview guide](design-previews/grant-ui/README.md) for the boundary between live frontend source and design-only overlays; real portfolio and cross-Agent data integration remain separate work.

## Documentation

- [Documentation index](docs/README.md)
- [MPP Mainnet plugin acceptance and limits](docs/demo/mpp-mainnet-plugin-20261117.md)
- [Plugin 0.2.4 runtime and acceptance](docs/architecture/mainnet-standalone-runtime-20261113.md)
- [Plugin 0.2.3 milestone](docs/architecture/plugin-milestone-20261112.md)
- [Native macOS App guide](docs/guides/native-app-getting-started.md)
- [Resource and purchase lifecycle](docs/architecture/resources/agent-purchase-lifecycle.md)
- [Architecture index](docs/architecture/README.md)

Contributions to wallet onboarding, reproducible merchant compatibility, plugin distribution and additional Agent hosts are welcome.
