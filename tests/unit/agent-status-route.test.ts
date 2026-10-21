import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authenticate: vi.fn(),
  overview: vi.fn(),
  memberOverview: vi.fn(),
  balance: vi.fn(),
}));

vi.mock('@/modules/app/app-runtime', () => ({
  appRuntime: () => ({ authenticateAgent: state.authenticate, memberOverview: state.memberOverview, overview: state.overview, readAuthorityBalance: state.balance }),
}));

import { GET } from '../../src/app/api/agent/route';

beforeEach(() => {
  vi.clearAllMocks();
  state.authenticate.mockReturnValue({ cardMemberId: 'member-1' });
  state.balance.mockResolvedValue({ amount: null, display: '暂时无法读取', available: false });
});

function overview(purchaseMode: 'simulated' | 'live_devnet') {
  return {
    service: { purchaseMode, paymentEnabled: purchaseMode === 'live_devnet' }, wallet: { address: 'buyer' }, budget: { paid: '0' },
    grant: { status: 'ACTIVE' }, connection: { enabled: true, access: 'purchase_intent' },
  };
}

it.each([
  ['simulated', false],
  ['live_devnet', true],
] as const)('reports paymentEnabled from the %s purchase mode', async (purchaseMode, paymentEnabled) => {
  state.overview.mockResolvedValueOnce(overview(purchaseMode));
  state.memberOverview.mockReturnValueOnce({ purchases: [], grant: { status: 'ACTIVE' }, connection: { enabled: true },
    authority: { readiness: { transactionExecution: { eligible: paymentEnabled, quotePreflightRequired: true } } } });
  const response = await GET(new Request('http://127.0.0.1:3049/api/agent?operation=status'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ paymentEnabled, spendingAuthorized: paymentEnabled, recentPurchases: [] });
});

it('does not equate purchase-intent capability with spending authorization after Grant revoke', async () => {
  state.overview.mockResolvedValueOnce({ ...overview('live_devnet'), grant: { status: 'REVOKED' } });
  state.memberOverview.mockReturnValueOnce({ purchases: [], grant: { status: 'REVOKED' }, connection: { enabled: true },
    authority: { readiness: { transactionExecution: { eligible: false, code: 'SPEND_GRANT_REVOKED' } } } });
  const response = await GET(new Request('http://127.0.0.1:3049/api/agent?operation=status'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ spendingAuthorized: false, paymentEnabled: true });
});

it('does not claim spending authorization from an active grant when a local preflight prerequisite fails', async () => {
  state.overview.mockResolvedValueOnce(overview('live_devnet'));
  state.memberOverview.mockReturnValueOnce({ purchases: [], grant: { status: 'ACTIVE' }, connection: { enabled: true },
    authority: { readiness: { facilitator: { ready: false, code: 'FACILITATOR_CONFIGURATION_INVALID' },
      transactionExecution: { eligible: false, code: 'FACILITATOR_CONFIGURATION_INVALID', quotePreflightRequired: true } } } });
  const response = await GET(new Request('http://127.0.0.1:3049/api/agent?operation=status'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ spendingAuthorized: false,
    readiness: { transactionExecution: { code: 'FACILITATOR_CONFIGURATION_INVALID' } } });
});
