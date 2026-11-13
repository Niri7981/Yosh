# Native macOS App guide

Yosh.app remains an optional native entry point for wallet visibility, API review, permissions, budgets and purchase activity. These instructions describe the existing App workflow. The [Plugin Edition](../../README.md#plugin-edition) runs independently and does not require opening Yosh.app.

The stable native App identity is **0.1.1, build 7**. Its existing wallet, Keychain, Grant, ledger, MCP and payment/recovery paths are preserved. The App currently starts its own backend; it does not attach its UI to an already-running standalone backend. Stop standalone normally before switching to this App workflow. Never force a second backend onto the same data.

Use the matching verified plugin package to request a graceful Mainnet stop:

```sh
/absolute/path/to/yosh-local-dev/runtime/node \
  /absolute/path/to/yosh-local-dev/runtime/mainnet.cjs stop
```

Wait for `stopped: true` before opening Yosh.app. The command drains the owned standalone backend and preserves payment data; it refuses to stop an App-owned backend. If it reports an incomplete stop, keep the original data and resolve that condition before switching.

## Historical Beta download / Installation

The following public download describes v0.1.0 Beta. For the current stable
App identity, state continuity and canonical build/install entry, use the
[v0.1.1 stable release record](../releases/v0.1.1.md).

**[Download Yosh](https://2049-web.vercel.app/)** from the official website. That historical **v0.1.0 Beta** download is for **Apple Silicon Macs (M1 or later), macOS 15 or later**; Intel Macs are not supported by this download. You do not need Node.js, Homebrew, Xcode, or the source code to run it.

1. Visit the website and download the macOS DMG, `Yosh-0.1.0-beta-arm64.dmg`.
2. Open the DMG and drag **Yosh.app** onto the **Applications** shortcut. Wait for copying to finish, then eject the disk image.
3. Open **Applications → Yosh** in Finder, or find Yosh with Spotlight. Run the installed copy rather than the copy inside the DMG.
4. If macOS says the developer cannot be verified or Apple cannot check the app, only proceed if you trust the download's source. After attempting to open Yosh, go to **System Settings → Privacy & Security**, find the Yosh message, choose **Open Anyway**, then confirm **Open** and authenticate if asked. See [Apple's per-app opening instructions](https://support.apple.com/en-us/102445). Managed Macs may require help from an administrator.

**This Beta is ad hoc signed; it has no Developer ID signature and is not Apple-notarized.** Do not disable Gatekeeper or remove quarantine attributes. If macOS reports malware or a damaged app, stop and obtain a verified download instead of overriding that warning. Keychain access dialogs are separate: review and complete legitimate Yosh prompts in the macOS system dialog, never in an Agent chat.

DMG integrity and local runtime checks have passed; installation on a clean Mac and first launch after an internet download remain unverified. See the [release and verification notes](../releases/v0.1.0-beta-verification.md) for the test boundaries.

## Getting started

### 1. Open Yosh and check the Mainnet wallet

On first launch, follow **Create your Yosh PIN** and **Confirm your Yosh PIN** if prompted. This PIN unlocks the app; it is separate from your macOS password and wallet keys.

Open **Settings → WALLETS**. If a **Mainnet** wallet is available, click its row to copy the full public address. To fund it, send **native USDC on Solana Mainnet** from an external wallet to that address, checking the network and asset before confirming the transfer. Devnet test tokens do not fund Mainnet purchases.

**Fresh-install limitation:** the current app can only display existing Yosh wallets. It has no **Create New Wallet** or **Import Wallet** screen, and launching it does not create a Mainnet wallet. If Mainnet shows **No wallet**, payment setup requires developer-assisted provisioning; you cannot complete it entirely in the app yet. If it shows **Keychain unavailable**, resolve the system access prompt or seek support before continuing with payments. Never give an Agent your private key or recovery phrase.

In **Authority → Execution**, select **Mainnet**. Leave **Mainnet execution** off until the limits and Grant below are ready. Fresh configuration starts with real execution disabled. This page also identifies the network and USDC mint; **Authority → the large available amount** opens **Daily Authority**, where you can check the wallet balance.

### 2. Connect Codex

1. Install and open Codex on the same Mac; it is the currently verified Agent host.
2. In Yosh, select **Codex** in the top Agent selector, open **Connection**, and click **Connect**. Yosh configures its bundled MCP bridge for Codex.
3. Open or continue a Codex chat to load the tools. If needed, start a new chat or restart Codex. **Waiting for Codex** means configuration is ready; wait for Yosh to show **Connected** before purchasing.

You can ask Codex to check Yosh's spending status first. Connecting alone grants no spending permission and does not create a wallet.

### 3. Set Daily Authority

In **Authority**, click the **large available amount** to open **Daily Authority**. Enter a small **Limit** in USDC and click **Save**. This daily limit is shared across all Agents and Resources, includes paid and reserved amounts, and is separate from your wallet balance. There is no automatic spending allowance; an unset or zero limit blocks new purchases.

### 4. Register and review a Resource

A **Resource** is the specific API and permitted request inputs you want the Agent to use. For a first purchase, choose a small GET request from a provider you trust. Give Codex the API endpoint and ask:

> Inspect this API with Yosh and, if compatible, register it. Tell me its Resource ID, price quote, and required inputs. Do not purchase yet.

Codex uses Yosh's discovery and registration tools; this does not pay or grant spending permission. In Yosh, open **Settings → Registered APIs**, select the API, and review its endpoint, method, network, asset, input constraints, samples, and any **Unconfirmed** details. For JSON POST discovery, use **Add API** to review the exact outbound request and explicitly confirm **Send POST** before it is sent.

### 5. Create a Spend Grant

With **Codex** selected, return to **Authority** and click the **SPEND GRANT / PER TRANSACTION** row. Under **Create Spend Grant**:

1. Choose the Resource in **Registered API**. Use **View API Details** to check its scope; supply valid sample inputs if requested.
2. Set **Total authorized**, **Per transaction**, and **Expires**. Use small limits that cover the quoted purchase and match what you are willing to spend.
3. Click **Create Spend Grant** and check that it is active. Yosh checks a fresh unpaid quote; a POST Resource also requires native request approval before the Grant is created.

The Grant applies only to that Agent and Resource. Its total covers the Grant's lifetime and does not reset each day; the shared Daily Authority also applies. Registering an API or enabling payments does not replace this Grant.

### 6. Make the first controlled purchase and check the result

When the wallet is funded, Codex is connected, and the limit and Grant are ready:

1. Open **Authority → Execution**, turn on **Mainnet execution**, and confirm **Enable Mainnet execution**. This enables real-money payments within your permissions.
2. Return to **Authority** and set **Payments** to **On**. To pause new purchases later, turn it off.
3. Ask Codex to buy once, filling in the Resource ID, inputs, purpose, and maximum price: “Use Yosh to purchase Resource [ID] once with [inputs] for [purpose], spending at most [amount] USDC within my Spend Grant and daily limit. Report the purchase ID, payment status, and delivered result. If the outcome is uncertain, check the same purchase rather than creating another.”
4. In Yosh, open **Authority → Activity**, then select the purchase. Check **Payment** and **Delivery** separately, and use **View transaction on Solana Explorer** when available. **Allowed** is a policy decision; **Paid** confirms payment; **Delivered** means Yosh recorded successful delivery. Codex can retrieve the stored result with `get_purchase_delivery`.

If a prerequisite or price check fails, resolve the reported blocker before trying again. If payment is pending or unknown, keep the original purchase ID and check its status; do not create a second purchase to recover the result. Keep Yosh running while Codex uses it: closing the window leaves the service running, while quitting Yosh stops it safely.

## Build from Source (developers)

Requirements: **macOS 15 or later**, **Node.js 24.5 or later**, npm, and Xcode with macOS build tools.

For the current stable release, follow the pinned Pay source recovery and
isolated staging build in [Yosh v0.1.1](../releases/v0.1.1.md). The active entry is:

```sh
python3 -B scripts/build-stable-release.py check --pay build.noindex/stable-inputs/pay
```

Build and accept the staged `Yosh.app` before using `scripts/install-macos-app.sh --stable-app /absolute/staging/Yosh.app`. The installed App contains its backend, Node runtime and Pay MCP. Before switching Apps, quit Yosh normally and wait for its backend to stop. The installer's no-argument path and the Beta CI/DMG workflow are historical v0 tooling and do not reproduce Pay v1.

Local builds use ad hoc signing by default. macOS may request Keychain access confirmation; complete it through the system prompt. Building from source does not add wallet onboarding. See the [runtime guide](../architecture/product-startup-runtime.md), [payment configuration](../architecture/payment-product-configuration.md), [MCP registration guide](../architecture/resources/agent-mcp-registration.md), and [macOS release guide](../releasing-macos.md) for development and packaging details.
