import { expect, it } from 'vitest';
import { filterMainnetTools, permittedMainnetCall } from '../../src/modules/mcp/mainnet-plugin-scope';

const allowed = ['get_spending_status', 'get_balance', 'list_catalog', 'search_catalog', 'get_catalog_entry',
  'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource', 'curl', 'recover_payment',
  'get_purchase', 'get_purchase_delivery'];
const forbidden = ['topup', 'sell_inference', 'create_skill', 'setup', 'export_wallet', 'sign_transaction',
  'set_daily_limit', 'set_paused', 'create_grant', 'unknown_future_pay_tool'];
const call = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

it('lists exactly the established Mainnet Agent surface plus read-only purchase retrieval', () => {
  const inventory = [...allowed, ...forbidden].map(name => ({ name, description: `Fixture ${name}` }));
  expect(filterMainnetTools([...inventory, null, [], { name: 1 }, {}])).toEqual(inventory.slice(0, allowed.length));
  expect(inventory).toHaveLength(allowed.length + forbidden.length);
});

it.each(allowed)('permits the declared Mainnet tool %s', name => {
  expect(permittedMainnetCall(call(name))).toBe(true);
});

it.each(forbidden)('rejects a guessed %s call even when the client skips tools/list', name => {
  expect(permittedMainnetCall(call(name))).toBe(false);
});

it('preserves initialization, notifications, inventory, pings and protocol replies', () => {
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'ping']) {
    expect(permittedMainnetCall({ jsonrpc: '2.0', id: 1, method })).toBe(true);
  }
  expect(permittedMainnetCall({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
});

it('rejects malformed tool calls and batches that could conceal an unlisted call', () => {
  for (const message of [null, false, 'tools/call', [call('curl'), call('topup')],
    { method: 'tools/call' }, { method: 'tools/call', params: [] }, call(null), call({ name: 'curl' })]) {
    expect(permittedMainnetCall(message)).toBe(false);
  }
});
