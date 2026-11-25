# Connect a host plugin

Install the [local Yosh runtime](local-install.md) first. Local CLI hosts and ChatGPT can use the same Mainnet statement. A host has its own Yosh identity and permissions, and the backend owns the shared wallet and ledger.

## Codex

From an extracted developer preview, install the local marketplace and Yosh plugin:

```sh
codex plugin marketplace add /absolute/path/to/marketplace
codex plugin add yosh-local-dev@yosh-standalone-testing
```

Open a new Codex session so it loads the installed version. Use an explicit network when the tool offers a choice. A first check you can paste into Codex:

> Use Yosh to show my Mainnet account statement. Only read the statement.

The preview package is installed from the marketplace you supplied. Public directory listing is pending.

## Claude Code and Grok CLI

The local installer detects supported executables and accepts `--host claude` and `--host grok`. Use the [local installation guide](local-install.md#install-a-verified-preview-package) to preview and register your choices. Grok CLI has been verified with a Mainnet purchase. Claude Code has been verified with a Mainnet statement read. Grok Bot and MUSE have their own cloud integration paths and still need acceptance.

## Dot in ChatGPT

Use an existing Yosh Mainnet account, Python 3 and the standalone runtime with the remote statement capability. Create an [OpenAI Tunnel](https://platform.openai.com/settings/organization/tunnels) and associate it with your ChatGPT workspace. Create a restricted [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels → Read + Use** for that tunnel.

Run the package's `Connect-Dot.command` from the extracted directory:

```sh
./Connect-Dot.command --tunnel-id tunnel_YOUR_ID
```

The connector uses an installed `tunnel-client` when it finds one. On Apple Silicon, it can also download the pinned OpenAI client and verify the archive checksum and macOS signatures before using it. Pass `--tunnel-client` to select a specific installed executable, or `--proxy` to configure an outbound HTTP proxy. [OpenAI tunnel-client release](https://github.com/openai/tunnel-client/releases/tag/v0.0.21)

When prompted, enter the OpenAI key in the terminal and confirm the **statement-only** pairing on the Mac. The script checks that Yosh exposes exactly one tool for this pairing and that a read returns the Mainnet statement. Leave the terminal open for foreground mode, or add `--login-start` to start the tunnel at macOS login. After a Yosh runtime upgrade, rerun the updated package with `--login-start` to refresh the runtime path.

In ChatGPT, add a custom MCP server, choose **Tunnel**, select the tunnel you created, and set authentication to **No authentication**. The Mac tunnel client attaches the Yosh credential to the request. Install the plugin privately in the workspace. Access to the same tunnel uses the same Yosh statement identity.

> Use Yosh to show my three most recent purchases with their time, merchant and amount.

The Mac, local Yosh runtime and tunnel client must be online for a Dot request. See [the Dot architecture and revoke instructions](../architecture/dot-mainnet-statement.md).

## Purchases from a local host

Use `describe_purchase_resource` to inspect the request fields and prepare a quote. The local authorization page can create a Spend Grant after you review the agent, API, network, asset, recipient constraints, limits and expiry. For MPP, review the separate SOL network fee limit.

In the local authorization page, select **主网 → 每日共享额度** to view the wallet’s daily USDC limit and remaining allowance across all agents. Enter the new limit, choose **核对额度变更**, and confirm the amount on your Mac. The page reads back the saved limit and today’s remaining allowance. Each purchase still requires its own applicable Spend Grant.

Give the local agent one explicit purchase instruction with the resource, inputs, purpose and maximum amount. Yosh rechecks the quote and reserves budget before signing. Confirm both the payment and delivery results. If the outcome is uncertain, keep the original purchase ID. A read of the original status is safe to repeat. `recover_payment` is an execution operation that requires its own instruction.

For x402 and MPP, a merchant can deliver a result while Yosh is still checking the original transaction on chain. When `deliveryStatus` is `COMPLETE`, use `get_purchase_delivery` with the original purchase ID to read the saved result. Yosh keeps the amount reserved until it resolves the payment.

[Back to Yosh](../../README.md)
