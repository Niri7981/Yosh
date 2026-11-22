# <img src="plugins/yosh-dev/assets/icon.png" alt="" width="48" height="48" align="absmiddle"> Yosh

> Give your agent a card, not your wallet.

Yosh lets AI agents buy APIs within spending limits you set. It keeps the wallet on your Mac, checks every purchase against the agent's permissions and the account budget, and records payment and delivery in a shared ledger.

<a name="get-started-with-the-plugin"></a>

## Get started

| Edition | How to use it | Release branch |
| --- | --- | --- |
| **Local install** | Run the standalone installer on Apple Silicon macOS. It detects Codex, Claude Code and Grok CLI and registers the hosts you select. [Local installation guide](docs/guides/local-install.md) | [`release/local-install`](https://github.com/Niri7981/Yosh/tree/release/local-install) |
| **Host plugin** | Use the Yosh plugin in Codex or connect Dot in ChatGPT over an OpenAI Tunnel. Local hosts can request purchases with user authorization. Dot can read the Mainnet statement. [Host plugin guide](docs/guides/host-plugins.md) | [`release/host-plugin`](https://github.com/Niri7981/Yosh/tree/release/host-plugin) |
| **macOS App** | Use the optional native interface for the App workflow, including wallet setup and spending controls. [macOS App guide](docs/guides/native-app-getting-started.md) | [`release/app`](https://github.com/Niri7981/Yosh/tree/release/app) |

`main` is the shared development branch. The installer and host plugin branches point to the [0.2.20 preview source](https://github.com/Niri7981/Yosh/releases/tag/v0.2.20-preview). The App branch points to the source for [v0.1.1, build 7](docs/releases/v0.1.1.md). The public DMG is the [v0.1.0 beta](https://github.com/Niri7981/Yosh/releases/tag/v0.1.0-beta).

Standalone and plugin packages are **0.2.20 developer previews**. Mainnet currently uses an existing compatible Yosh wallet, ledger and spending configuration. A fresh Mac can run the independent Devnet setup. First-time standalone Mainnet wallet setup and public plugin distribution still need release acceptance.

After connecting a host, ask it to “Use Yosh to show my three most recent purchases.”

## One wallet, separate agent permissions

| Capability | What Yosh handles |
| --- | --- |
| Shared account | Local agents and approved read-only connections can see a common purchase statement. Wallet keys stay in macOS Keychain. |
| Spend Grants | A Grant ties spending to a specific agent, API, payment conditions, amount limits and expiry. |
| Daily limits and pause | The backend checks paid and reserved amounts against the shared daily allowance before signing. |
| Payment and delivery | The statement records both states. If a payment is uncertain, Yosh retains the original purchase ID and payment evidence for recovery. |

Codex, Claude Code and Grok CLI connect directly to the local runtime through MCP. Dot's ChatGPT plugin sends its query over an OpenAI Tunnel to the Mac. Yosh verifies Dot's separate, revocable permission and exposes the statement tool. Each wallet ledger has one active backend owner. The App and standalone entry points share the authority, signing and ledger code.

## What has been verified

- **Dot** read the shared Mainnet account statement in ChatGPT through a private Yosh plugin. The test returned paid and failed purchase records. [Dot architecture and acceptance](docs/architecture/dot-mainnet-statement.md)
- **Local agents** include a real Grok CLI purchase and a Claude Code statement read against the existing shared Mainnet account. Grok Bot and MUSE are separate cloud integrations. [Shared wallet acceptance](plan.md)
- **Payments** include native USDC purchases on Solana Mainnet using x402 V2 `exact` and MPP Solana `charge`. MPP is available in a verified MPP-enabled standalone build. [MPP acceptance and limits](docs/demo/mpp-mainnet-plugin-20261117.md)
- **macOS App** has a separate release history. The current App reader predates Mainnet MPP records. Follow the App guide for its supported workflow. [App release record](docs/releases/v0.1.1.md)

## Development

See the [local package build](docs/guides/local-install.md#build-from-source), [architecture index](docs/architecture/README.md) and [contribution rules](AGENTS.md). Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` before submitting source changes.

Yosh builds on the [Pay Spending Authority interface](https://github.com/solana-foundation/pay/pull/514), [Pay Kit transaction preparation](https://github.com/solana-foundation/pay-kit/pull/393) and [host-controlled execution](https://github.com/solana-foundation/pay/pull/530). Build inputs are pinned and verified. [Dependency and build notes](docs/architecture/codex-plugin-dev.md#reproducible-build)

## Maintainer

<a href="https://github.com/Niri7981"><img src="https://avatars.githubusercontent.com/u/236018306?v=4&amp;s=80" width="40" height="40" alt="Niri's GitHub avatar"></a>

[Niri · @Niri7981](https://github.com/Niri7981)
