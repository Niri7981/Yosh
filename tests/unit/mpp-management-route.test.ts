import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { serveDevelopmentRuntime } from '../../src/modules/pay-dev/management-server';
import { requireLocalRequest } from '../../src/modules/http/local-request';

const state = vi.hoisted(() => ({ purchase: vi.fn(), quote: vi.fn(), start: vi.fn(), quit: vi.fn(), close: vi.fn() }));
vi.mock('@/modules/app/app-runtime', () => ({
  AppRuntime: class { start = state.start; prepareQuit = state.quit; close = state.close; },
  appRuntime: () => ({
    authenticateAgent(request: Request) {
      requireLocalRequest(request);
      if (request.headers.get('authorization') !== 'Bearer isolated-fixture') throw new Error('AGENT_UNAUTHORIZED');
      return { cardMemberId: 'fixture-member', connectionId: 'fixture-connection', connectionGeneration: 1 };
    },
    requestMppPurchase: state.purchase, quoteMppResource: state.quote,
  }),
}));
afterEach(() => vi.resetAllMocks());

it('routes real loopback MPP requests through Agent auth and the product handler', async () => {
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
  await new Promise<void>(done => socket.close(() => done()));
  const origin = `http://127.0.0.1:${address.port}`;
  const server = await serveDevelopmentRuntime({ app: new AppRuntime(), origin, port: address.port,
    descriptor: { memberId: 'fixture-member' }, cleanup: async () => {} });
  const input = { requestId: 'mpp-host-001', resourceId: 'fixture-mpp', reason: 'Mock acceptance' };
  const call = (authorization?: string, body: unknown = input) => fetch(`${origin}/api/agent/mpp/purchases`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const quote = (authorization?: string, body: unknown = { resourceId: input.resourceId }) => fetch(`${origin}/api/agent/mpp/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
    expect((await quote()).status).toBe(401);
    expect((await quote('Bearer isolated-fixture', { resourceId: input.resourceId, amount: '1' })).status).toBe(422);
    expect(state.quote).not.toHaveBeenCalled();
    state.quote.mockResolvedValue({ amount: '1000', protocol: 'mpp' });
    expect((await quote('Bearer isolated-fixture')).status).toBe(200);
    expect(state.quote).toHaveBeenCalledExactlyOnceWith(input.resourceId, {}, 'fixture-member');
    expect(state.purchase).not.toHaveBeenCalled();
    const denied = await call();
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ code: 'AGENT_UNAUTHORIZED' });
    expect(state.purchase).not.toHaveBeenCalled();
    expect((await call('Bearer isolated-fixture', { ...input, approved: true })).status).toBe(400);
    expect(state.purchase).not.toHaveBeenCalled();
    state.purchase.mockResolvedValue({ purchaseId: input.requestId, status: 'PAID', deliveryStatus: 'COMPLETE' });
    const accepted = await call('Bearer isolated-fixture');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ purchaseId: input.requestId });
    expect(state.purchase).toHaveBeenCalledExactlyOnceWith(input, origin, expect.objectContaining({ cardMemberId: 'fixture-member' }));
    state.purchase.mockRejectedValue(new Error('MPP_MAINNET_ACCEPTANCE_REQUIRED'));
    const gated = await call('Bearer isolated-fixture');
    expect(gated.status).toBe(400);
    expect(await gated.json()).toMatchObject({ code: 'MPP_MAINNET_ACCEPTANCE_REQUIRED' });
  } finally { await server.close(); }
});
