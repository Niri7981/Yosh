# MPP Solana Charge: standalone plugin acceptance

Date: November 17, 2026. This record follows [PR #7](https://github.com/Niri7981/Yosh/pull/7), which delivered the isolated MPP implementation. It records the subsequent Mainnet plugin integration, real-purchase fixes and Grant UI work. It is not a public release announcement or permission for further spending.

## Real-payment result

With Yosh.app closed, the installed 0.2.11 plugin used the existing Mainnet wallet, Keychain signer, user-confirmed MPP Grant, shared daily allowance and ledger to purchase AgentFeed SOL Price via `GET https://x402.ochinimus.app/api/sol-price`.

| Evidence | Observed result |
| --- | --- |
| Protocol | MPP / Solana / Charge; native USDC |
| Payment | 0.001 USDC (1,000 atomic units) |
| Network fee | 5,001 lamports; authorized cap 10,000 lamports |
| Original chain evidence | Finalized original transaction, matching transfer, one debit |
| Persisted outcome | `PAID / COMPLETE`; 226 bytes of JSON delivery |
| Native MCP reads | Spending status, purchase ID lookup, operation ID lookup and stored delivery all passed in a new Codex session |

[Original Solana transaction](https://solscan.io/tx/3u5uUPe9BV8CACbLYZ5dTCCG7cdbGcjBiLECcWFBZH9ne97oQESFvW3Z7oTGzNCBNdYDgtLRtJLR8ctZrNmkks74).

The first attempt failed before submission and had no original signed-payment payload. An unsigned reproduction found `MPP_INVALID_LIFETIME`; the original exception was not persisted, so that reproduction is not asserted to be its exact historical error. That attempt was not replayed. The later authorized purchase above is the successful payment evidence.

## Independent verification

| Round | Result and follow-up |
| --- | --- |
| 1 | FAIL: advisory merchant blockhash handling, missing execution diagnostics, x402-specific readiness and MPP operation-ID lookup required fixes. |
| 2 | Payment and code PASS, including 80 focused tests; native host FAIL because that session retained a stale connection (`LOCAL_TOOL_UNAVAILABLE`). |
| 3 | PASS for four native read calls in a fresh independent Codex session, with host metadata confirming `gpt-6-astra` / `high`. No new payment or recovery was performed. |

The third round verified native host reads, not another chain payment or a new code-test run. The rounds' scopes are distinct. Private source snapshots, complete diffs including new files, test logs, installation identities and independent reports remain in local ignored acceptance artifacts; credentials, database files and signed payment payloads are not published.

## Source and regression validation

- Final pre-PR `npm test -- --maxWorkers 4`: **142 files / 1,509 tests passed**. This is isolated automated regression, not Mainnet payment evidence.
- `npm run typecheck`, `npm run lint` and `npm run build` passed for the delivered frontend/runtime source.
- Pinned actual SDK integration: **3 files / 53 tests passed** against isolated merchant/RPC fixtures. These opt-in tests are separate from the default suite.
- Release/runtime and App-isolation checks: **14 passed**. The App isolation test uses a disposable App fixture, not production App replacement.
- Fee/protocol frontend regression: **61 focused tests passed**, including exact SOL conversion, protocol filtering, selection resets, empty states and stale-selection rejection. These are a subset of the default suite, not additional coverage counts.

The MPP SDK source pins and artifact provenance checks are documented in the [architecture record](../architecture/mpp-solana-charge.md). The Mainnet execution sources remained unchanged after the independent code review; subsequent work updated the local authorization UI and package version.

## Installed package versus running runtime

The real purchase used plugin **0.2.11**. Its verified Mainnet runtime digest was `fa92784690bb0217a8b9c0ff96793d8db20d6584251c260bf7f5cb5e3563816d`.

The local package and Grant frontend subsequently advanced to **0.2.13**. The already-accepted Mainnet backend was retained during these UI updates; a newer package number is not evidence that a running payment backend was replaced. The page now selects network → protocol → API and displays SOL fee presets/custom input. Frozen scope and exact integer fee validation remain in the backend.

## Remaining boundaries

- The original App bundle and financial state are preserved. Its pre-MPP reader is not yet compatible with MPP records; native App delivery remains a separate stage. This acceptance does not claim old-App compatibility.
- A refreshed authorization page can lose its short-lived page session. The Grant remains persisted; session-refresh UX still needs work.
- MPP support is limited to the explicitly validated Solana Charge/GET/native-USDC shape. No real card payments, MPP sessions/channels or cross-protocol retry fallback.
- Recovery regression uses the original payment identity and evidence. This purchase did not exercise live merchant delivery recovery.
- Distribution remains a local development plugin. Public listing, clean-machine onboarding and native App compatibility are not implied by this result.
