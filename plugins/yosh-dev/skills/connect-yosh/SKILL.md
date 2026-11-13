---
name: connect-yosh
description: Check or troubleshoot the connection to the Yosh Dev plugin and explain the next setup action. Use for Yosh Dev setup or connection requests.
---

Use the Yosh plugin's `get_spending_status` tool. The plugin opens only **Yosh Codex Plugin Dev** when necessary; its backend uses isolated offline or simulated data and no real funds.

Report the returned environment, connection and readiness facts. A working connection does not establish a valid Spend Grant or spending permission. If setup is incomplete, give the relevant next action:

- `YOSH_PLUGIN_APP_NOT_INSTALLED`: install the separate Yosh Codex Plugin Dev app, then reconnect this plugin.
- `YOSH_PLUGIN_BACKEND_NOT_READY`: open or unlock that Dev app, let startup finish, then reconnect.
- `YOSH_PLUGIN_CONNECTION_REQUIRED`: enable this Agent's connection in the Dev app, then reconnect.
- `YOSH_PLUGIN_CONNECTION_REVOKED`: the captured connection no longer works; the user must enable a connection in the Dev app before a new session.
- Identity, directory, environment or scope mismatch: stop and report the exact code. Do not substitute the formal Yosh app or another directory.

Use available plugin tools directly. Do not inspect source, private configuration or management tokens to complete setup; do not change Codex's MCP configuration, create Grants, adjust limits or enable live networks.
