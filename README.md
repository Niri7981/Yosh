# Yosh

> Give your agent a card, not your wallet.

**Yosh lets AI agents make real payments without giving them access to your private keys.**

Yosh is a native macOS app and an economic authority layer between agents and payment infrastructure. Agents request purchases; users set permissions and budgets; a local backend authorizes and signs supported x402 payments.

**[Download Yosh for macOS](https://2049-web.vercel.app/)** · Apple Silicon · macOS 15+ · Beta

## The problem

Agents increasingly need to buy API access, data, and services to complete their work. Unrestricted wallet access gives them too much authority. Manually approving every individual payment makes useful automation difficult.

Yosh separates the ability to request a purchase from the authority to spend. A user can authorize a specific Agent to use a specific API within explicit limits, while retaining control of the wallet.

## How Yosh works

1. **Discover.** The Agent finds an x402 API and inspects its unpaid challenge with `discover_x402_resource`.
2. **Register.** It calls `register_x402_resource` with Yosh's validated discovery record. The API appears in the app for review; registration grants no spending permission.
3. **Authorize.** The user creates a **Spend Grant** for that Agent and Resource, setting a total amount, per-transaction limit, and expiration. Sample inputs provide quotes for dynamic resources.
4. **Request.** The Agent calls `request_purchase` with the Resource, permitted inputs, purpose, and stable request ID.
5. **Check.** Yosh validates the fresh quote, checks permissions and budget, atomically reserves the amount, and rechecks authorization before signing.
6. **Pay.** The official x402 SDK handles the supported payment flow, using Yosh's local signer and the merchant's settlement infrastructure.
7. **Deliver.** The Agent receives the result; stored content is also available through `get_purchase_delivery`.
8. **Record.** Yosh records payment and delivery separately: payment confirmation alone does not prove delivery.

JSON POST discovery requires separate native user confirmation of the exact outbound request before it is sent. An Agent cannot supply that approval itself.

## Yosh × pay.sh integration

Yosh keeps pay.sh's MCP and x402 request flow while using three upstream extension interfaces to keep spending authority and custody in the host:

- [Pay #514 — External Spending Authority](https://github.com/solana-foundation/pay/pull/514) lets Pay submit the selected payment terms to a trusted host policy before execution. Yosh checks the Agent's Resource Grant, shared Daily Authority, and purchase reservation.
- [pay-kit #393 — unsigned exact transaction preparation](https://github.com/solana-foundation/pay-kit/pull/393) separates construction of the supported x402 exact transaction from signing, so Yosh can validate it and use its backend signer.
- [Pay #530 — host-controlled x402 exact execution](https://github.com/solana-foundation/pay/pull/530) adds an opt-in controller path for the host to authorize and carry out the exact payment flow. Pay's normal behavior remains available when the controller is not configured.

Together, Pay handles its MCP request flow and x402 offer selection, while Yosh remains responsible for authorization, budgets, signing, payment records, and recovery. These upstream PRs are still open as of October 24, 2026; Yosh v0.1.1 uses pinned and validated sources, recorded in the [final source record](docs/releases/v0.1.1-rc.5-final-source.md), rather than relying on the PRs having merged.

## Core capabilities

- **Scoped Spend Grants:** revocable spending authority for a specific Agent and Resource.
- **Daily Authority:** shared daily limits across Agents and Resources, covering paid and reserved amounts, with a pause control.
- **Resource Registry:** persistent API definitions with validated fixed or dynamic GET/JSON POST inputs.
- **Local custody:** Solana wallet secrets in macOS Keychain; signing inside the backend.
- **Durable tracking:** idempotent purchases, separate payment/delivery records, and recovery of the original purchase.
- **Native visibility:** API review, permission management, and purchase outcomes.

## Download / Installation

**[Download Yosh](https://2049-web.vercel.app/)** from the official website. The current **v0.1.0 Beta** is for **Apple Silicon Macs (M1 or later), macOS 15 or later**; Intel Macs are not supported by this download. You do not need Node.js, Homebrew, Xcode, or the source code to run it.

1. Visit the website and download the macOS DMG, `Yosh-0.1.0-beta-arm64.dmg`.
2. Open the DMG and drag **Yosh.app** onto the **Applications** shortcut. Wait for copying to finish, then eject the disk image.
3. Open **Applications → Yosh** in Finder, or find Yosh with Spotlight. Run the installed copy rather than the copy inside the DMG.
4. If macOS says the developer cannot be verified or Apple cannot check the app, only proceed if you trust the download's source. After attempting to open Yosh, go to **System Settings → Privacy & Security**, find the Yosh message, choose **Open Anyway**, then confirm **Open** and authenticate if asked. See [Apple's per-app opening instructions](https://support.apple.com/en-us/102445). Managed Macs may require help from an administrator.

**This Beta is ad hoc signed; it has no Developer ID signature and is not Apple-notarized.** Do not disable Gatekeeper or remove quarantine attributes. If macOS reports malware or a damaged app, stop and obtain a verified download instead of overriding that warning. Keychain access dialogs are separate: review and complete legitimate Yosh prompts in the macOS system dialog, never in an Agent chat.

DMG integrity and local runtime checks have passed; installation on a clean Mac and first launch after an internet download remain unverified. See the [release and verification notes](docs/releases/v0.1.0-beta-verification.md) for the test boundaries.

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

## Architecture

The native app provides user-controlled permissions and transaction visibility. The bundled backend keeps wallet custody, policy, and signing independent of the Agent. App and MCP requests share the same business logic.

| Component | Responsibility |
| --- | --- |
| Native macOS App | User review, permissions, budgets, and transaction visibility. |
| Bundled local backend | Authenticated channels, purchase orchestration, and supervised runtime, including Node. |
| MCP integration | A restricted stdio bridge for discovery, registration, quotes, purchase requests, and delivery retrieval. |
| Resource Registry | API identity, request constraints, samples, and delivery declarations. |
| Economic Authority / Spend Grants | Bind an Agent's permission to a Resource and its economic scope. |
| Daily Authority | Enforce shared daily limits and pause across active Grants. |
| Solana wallet and signing boundary | Verify and use the expected Keychain wallet inside the backend; isolate Mainnet and test wallets. |
| Official x402 SDK | Supported x402 V2 protocol and `exact` payment construction. |
| SQLite ledger | Atomic reservations, idempotency, payment/delivery state, and durable recovery progress. |

Policies and records persist locally across restarts. The installed bundle runs without the source checkout, a separately installed Node runtime, or a developer `.env.local`.

## Build from Source (developers)

Requirements: **macOS 15 or later**, **Node.js 24.5 or later**, npm, and Xcode with macOS build tools.

From the repository root:

```sh
npm ci
./scripts/install-macos-app.sh
```

The script installs `~/Applications/Yosh.app` with its backend, Node runtime, and MCP bridge. Launch it from Finder or Spotlight. Before rebuilding, quit Yosh normally and wait for its backend to stop.

Local builds use ad hoc signing by default. macOS may request Keychain access confirmation; complete it through the system prompt. Building from source does not add wallet onboarding. See the [runtime guide](docs/architecture/product-startup-runtime.md), [payment configuration](docs/architecture/payment-product-configuration.md), [MCP registration guide](docs/architecture/resources/agent-mcp-registration.md), and [macOS release guide](docs/releasing-macos.md) for development and packaging details.

## Supported capabilities and limitations

| Area | Current scope |
| --- | --- |
| Protocol and payment | x402 V2, Solana Mainnet, native USDC, supported `exact` flow. Other networks, assets, and schemes are outside the current scope. |
| HTTP resources | Static/parameterized GET and fixed/parameterized JSON POST with constrained inputs and POST consent. GET has live purchase evidence; POST has automated coverage, without a recorded real Mainnet purchase. |
| Delivery | Bounded JSON and declared text, including HTTP 200/201. No arbitrary media or streaming. |
| Agent compatibility | Actual Codex MCP host verified; other hosts await validation. |
| Recovery | Original-payment recovery and bounded delivery retries implemented and tested. Replay requires explicit merchant support; live recovery has not been verified. |

Discovery inspects candidate endpoints, rather than searching the web or operating an API marketplace. Refunds are unsupported. Wallet creation/import is not available in the app; the Beta is unnotarized and clean-Mac installation remains unverified.

## Security model

- **Local keys:** Keychain secrets are used by the backend signer. The frontend and MCP expose neither private-key export nor arbitrary signing.
- **Separate authority:** authenticated Agent access confers no management privileges or permission to approve its own purchases.
- **Backend policy:** missing, expired, revoked, or out-of-scope Grants, pause, insufficient budget, and invalid quotes block new payments. Amounts use integer asset units.
- **Stable purchase identity:** atomic reservations and execution claims guard against duplicate execution. Unknown outcomes retain reservations and original evidence; delivery recovery reuses original payment credentials without creating another payment.
- **Untrusted APIs:** validated requests enforce HTTPS, network-target, redirect, timeout, and response-size restrictions.

Local custody does not eliminate host compromise or merchant risk. Yosh records uncertain outcomes and cannot guarantee third-party delivery or recovery.

## Demo and links

On **October 8, 2026**, an actual desktop Codex MCP session bought BTC, ETH, and SOL price data from Agent402 for **0.001 native USDC on Solana Mainnet**. The project record documents `PAID`, a `CONFIRMED` receipt, `COMPLETE` delivery, and the same transaction in the original-payment record.

Read the [purchase and delivery evidence](docs/demo/first-mainnet-purchase-20261008.md) and its recorded [Solana Explorer transaction](https://explorer.solana.com/tx/5CA2dyAxJq7Q7XPxRHMD475NYwDa1AkFrQQLb5VtYqqLsni8jwwz1JAZWfMh8gCPFRKai6Fn2WjEJWJ3sfW6n9gM). This verifies one GET purchase and initial delivery. It is not evidence of a real POST purchase, merchant recovery, or independently audited finalization.

Further reading: [documentation index](docs/README.md), [architecture](docs/architecture/README.md), and [resource lifecycle](docs/architecture/resources/agent-purchase-lifecycle.md).

## Roadmap

The following are future directions, not released capabilities:

- Verify signed, notarized DMG distribution and improve first-time wallet onboarding.
- Validate more Agent hosts and MCP integrations.
- Expand reproducible merchant compatibility tests, including live JSON POST and recovery scenarios.
- Explore economic authority for tokenized real-world assets (**RWA**). Yosh currently supports API purchases, not RWA custody, trading, or settlement.

Collaborators working on Agent integrations, merchant compatibility, and local security boundaries are welcome.
