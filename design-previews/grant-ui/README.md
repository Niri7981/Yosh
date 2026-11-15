# Grant UI design preview

The accepted visual prototype is preserved separately from the live authorization service. Start it from the repository root with the existing Node/tsx toolchain:

```sh
node --import tsx design-previews/grant-ui/serve.ts
# Optional alternate port:
node --import tsx design-previews/grant-ui/serve.ts 18764
```

Open the printed loopback URL. Authorization opens with Shared budget expanded; use **New Grant → Review** for the graphical Grant summary, or switch to Wallet and Activity. Labels in this prototype are Chinese.

| Layer | Included behavior |
| --- | --- |
| Live frontend source (`src/modules/authority/local-*view.ts`, motion and icons) | Network-scoped authorization, native review dialog, wallet identity/state, read-only purchase details, keyboard/reduced-motion behavior. |
| `wallet-assets.*` | Sample SOL/USDC/USDT portfolio, token details and official local token SVGs. No real holdings or price query. |
| `shared-budget.*` | Example shared daily remaining plus Agent/API Grant remaining. No real Agent enumeration or allocation. |
| `grant-review.*` | Graphical Agent → API review, USDC amount, single limit, exact expiry/timezone, expandable recipient facts and visible footer. |
| `liquid-melt.*` | Preview-only merging shapes for tab/page transitions; keyboard/reduced-motion paths and interruption cleanup. |
| `preview-fixture.js`, `serve.ts` | Synthetic data and prepared review. Confirmation stays disabled. No mutation is forwarded to a runtime. |

## Data boundaries

All values, Agents, resources and purchases in the prototype are examples. The preview imports the HTML/CSS/script renderer only; it does not initialize Yosh, connect to an installed runtime, read user configuration, open a database or access Keychain. The server binds only `127.0.0.1`, serves an explicit file allowlist and rejects every mutation except a fake preview session. The browser handles synthetic review/cancel locally and rejects all other API paths.

The sample daily pool is 9 USDC with payments paused. Codex has no Grant and displays **— / 未授权**, while two other sample Agent/API Grants have 6 and 4 USDC remaining. These values cannot be added into a spendable pool. A Spend Grant spans its lifetime; the daily pool is shared. Neither is a wallet balance, and pause continues to block purchases.

Real asset inventory/prices and cross-Agent Grant data remain follow-up integration work. These overlays are not imported by the production authorization service or standalone runtime.

## Assets and verification

Currency SVG provenance and checksums: [token-icons/SOURCES.md](token-icons/SOURCES.md). Agent icons reuse the [native App assets](../../apps/macos/Yosh/YoshApp/ProviderIcons.md): Codex uses the Activity sprite, Claude the clay mark, and Gemini the existing monochrome template. Marks identify their respective products and do not imply endorsement. Original font and Yosh artwork remain in the shared web-assets directory.

Validated locally in Chrome: sample asset/detail/back flows, absent Grant vs zero, scope/pause labels, exact amount precision, network switching, recipient disclosure, 320 px layout, footer visibility, keyboard focus, rapid motion interruption, reduced motion and no outgoing payment/management calls. Headless checks establish behavior, not a real-device frame-rate guarantee. No private runtime evidence or browser profiles are included.
