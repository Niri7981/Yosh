---
name: buy-with-yosh
description: Use Yosh Dev to inspect and purchase a supported paid API for the user's task within existing authorization. Use when a task requires a paid API through Yosh.
---

Use this plugin's MCP tools. This Dev plugin is an isolated offline/simulated preview; show that context when discussing amounts or results.

Read `get_spending_status` for backend-reported readiness and the declared Offline `discoveryUrls`. Only those fixed GET test endpoints support discovery: call `discover_x402_resource`, then pass its `discoveryId` plus identity labels to `register_x402_resource`. Use the returned Resource ID for `quote_x402_resource` and native Grant setup. Registration does not authorize spending; a legacy fixture Grant does not cover a newly registered resource. Quotes also support the existing built-in fixture IDs. Any Offline scope rejection is a support boundary: stop and explain it; do not retry arbitrary URLs, fabricate discovery IDs or claim registration succeeded. Simulation provides status only. If a Grant or budget is missing, direct the user to Yosh Codex Plugin Dev for the corresponding action; do not grant authority through conversation or tools.

For an authorized purchase, call Pay `curl` using the exact supported request and a **stable `operation_id`** for that economic operation. Save its `purchaseId`/`operationId` and use them when explaining or checking the outcome. A retry of the same purchase keeps the original operation ID and request. Never change an ID to get around a denial or unresolved result.

Treat payment and delivery separately. Read the original operation with `get_purchase({operationId})` after an incomplete response; use `get_purchase_delivery({purchaseId,offset:0})` and its `nextOffset` for available delivery chunks. Querying does not resume payment.

Check the actual tool list before attempting recovery. Offline does not expose `recover_payment`: first query the original purchase; only after explicit recovery instructions may the original `curl` request and operation ID be reused. `recover_payment`, when available, **can execute the original payment** and requires explicit recovery authorization plus backend recoverability. For unknown/pending payment, retain the original operation and reservation, report the returned state, and stop before any replacement purchase. A timeout, HTTP 200 or transaction identifier alone does not prove completion. Do not infer a denial cause from an error string when durable backend facts are unavailable.
