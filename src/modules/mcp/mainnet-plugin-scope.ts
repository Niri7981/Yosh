// The standalone entry has the same Agent surface as the original App bridge,
// plus the generic wrapper's two read-only original-purchase queries.
const allowedTools = new Set(['get_spending_status', 'get_balance', 'list_catalog', 'search_catalog',
  'get_catalog_entry', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource',
  'curl', 'recover_payment', 'get_purchase', 'get_purchase_delivery']);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inventory filtering is not authorization: guessed tool calls are checked too. */
export function permittedMainnetCall(message: unknown): boolean {
  if (!object(message)) return false;
  if (message.method !== 'tools/call') return true;
  return object(message.params) && typeof message.params.name === 'string' && allowedTools.has(message.params.name);
}

export function filterMainnetTools(tools: unknown[]): unknown[] {
  return tools.filter(tool => object(tool) && typeof tool.name === 'string' && allowedTools.has(tool.name));
}
