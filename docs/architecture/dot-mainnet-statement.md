# Dot reads the Yosh Mainnet statement

Dot accesses the original Mainnet account statement through a private ChatGPT MCP plugin. OpenAI forwards each tool request through the tunnel to `tunnel-client` on the Mac. The client forwards to the loopback Yosh MCP endpoint at `http://127.0.0.1:13449/api/agent/remote-mcp`.

The connection uses two credentials. The restricted OpenAI key lets `tunnel-client` use the tunnel. Yosh issues a separate, revocable statement credential after native Mac confirmation. The client attaches it on the loopback hop. Yosh verifies the active pairing, the pinned Mainnet wallet identity and the requested scope on each call. The remote connection exposes only `list_account_purchases`.

Follow the [host plugin guide](../guides/host-plugins.md#dot-in-chatgpt) to set up a private ChatGPT plugin. Keep access to the tunnel private because callers through it share the same Yosh statement identity.

## Manage a pairing

From the directory that contains the verified `runtime/`:

```sh
runtime/node runtime/mainnet.cjs remote-statement list
runtime/node runtime/mainnet.cjs remote-statement revoke --id PAIRING_UUID
```

Revocation takes effect on subsequent reads. The local standalone runtime must be running and match the package used to manage the pairing.

## Acceptance

On November 22, 2026, Dot used a private ChatGPT plugin and OpenAI Tunnel to retrieve three records from an existing Mainnet ledger. This verified the cloud request and reply, native statement consent and the local tunnel startup on one Mac. A separate Codex session read the same ledger. The runtime upgrade preserved all existing values for 13 historical purchases.

Automated coverage checks the statement-only tool list, wallet scope, denied consent, revocation and rejection of purchase calls. Fresh-account Mainnet onboarding, public distribution and other cloud bots are separate acceptance tasks.
