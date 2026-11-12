import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({ isolated: true }));
vi.mock('../../src/modules/pay-dev/profile', () => ({ IS_CODEX_PLUGIN_DEVELOPMENT: true,
  PAY_DEVELOPMENT_PROFILE: { backendPort: 14449 } }));
vi.mock('../../src/modules/pay-dev/isolation', () => ({ isPayDevelopmentDirectory: () => state.isolated }));
import { readPluginOfflineQuote } from '../../src/modules/pay-dev/codex-plugin-resource-tools';

beforeEach(() => { state.isolated = true; });
it('uses only the existing fixed-fixture quote service without granting authority or accepting arbitrary request inputs', async () => {
  const principal = { cardMemberId: randomUUID(), connectionId: randomUUID(), connectionGeneration: 1 };
  const app = { directory: '/fixture/Yosh Codex Plugin Dev', quoteRegisteredResource: vi.fn().mockRejectedValue(new Error('REGISTERED_RESOURCE_REQUIRED')), quotePaidResources: vi.fn().mockResolvedValue({ resources: [
    { resourceId: 'market-snapshot', resourceUrl: '/api/paid/sol-market-snapshot?asset=SOL', amount: '200000', decimals: 6,
      display: '0.20 test USDC', asset: 'test-mint', network: 'solana:fixture', payTo: 'fixture-merchant' },
    { resourceId: 'new-registered-resource', quoteStatus: 'unavailable', code: 'RESOURCE_QUOTE_UNAVAILABLE' }], testEnvironment: true }) };
  const result = await readPluginOfflineQuote(app, 'http://127.0.0.1:14449', { resourceId: 'market-snapshot' }, principal);
  expect(result).toMatchObject({ resourceId: 'market-snapshot', amount: '200000', testOnly: true,
    paymentSent: false, spendingAuthorityCreated: false,
    request: { method: 'GET', url: 'http://127.0.0.1:14449/api/paid/sol-market-snapshot?asset=SOL' } });
  expect(app.quotePaidResources).toHaveBeenCalledWith('http://127.0.0.1:14449', principal.cardMemberId);
  app.quotePaidResources.mockClear();
  for (const input of [{ resourceId: 'unregistered-api' }, { resourceId: 'market-snapshot', url: 'http://127.0.0.1:13449/private' },
    { resourceId: 'market-snapshot', sample: { query: { target: 'arbitrary' } } }, { resourceId: 'market-snapshot', approved: true }])
    await expect(readPluginOfflineQuote(app, 'http://127.0.0.1:14449', input, principal)).rejects.toThrow();
  await expect(readPluginOfflineQuote(app, 'http://127.0.0.1:13449', { resourceId: 'market-snapshot' }, principal)).rejects.toThrow('PAY_PROFILE_MISMATCH');
  state.isolated = false;
  await expect(readPluginOfflineQuote(app, 'http://127.0.0.1:14449', { resourceId: 'market-snapshot' }, principal)).rejects.toThrow('OFFLINE_RESOURCE_TOOL_UNAVAILABLE');
  expect(app.quotePaidResources).not.toHaveBeenCalled();
});
