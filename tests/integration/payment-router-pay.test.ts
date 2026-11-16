// Adapted from the preserved payment-router worktree; fixtures remain offline.
import { afterEach, expect, it, vi } from 'vitest';
import * as routing from '../../src/modules/payment/payment-router';
import { productionPayFixture, TEST_DELIVERY } from '../helpers/pay-production-fixture';

afterEach(() => vi.restoreAllMocks());

it('real Pay MCP reaches the router after reservation and preserves one claim, signature and payment across replay', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const original = routing.routeApprovedPayment;
    const routed = vi.spyOn(routing, 'routeApprovedPayment').mockImplementation((args) => {
      expect(f.payRecord('router-existing')).toMatchObject({ status: 'APPROVED' });
      expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '200000', paid: '0' });
      return original(args);
    });
    const claimed = vi.spyOn(f.app.ledger, 'claim');
    expect((await f.callPay(await f.connectPay(), 'router-existing')).isError).not.toBe(true);
    expect(routed).toHaveBeenCalledOnce(); expect(claimed).toHaveBeenCalledOnce();
    expect(f.payRecord('router-existing')).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: TEST_DELIVERY });
    await f.reopenWithoutPayExecutor();
    expect((await f.callPay(await f.connectPay(), 'router-existing')).isError).not.toBe(true);
    expect(routed).toHaveBeenCalledOnce();
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
  } finally { await f.close(); }
}, 30_000);

it('a missing Grant denies the real Pay request before routing or signing', async () => {
  const f = await productionPayFixture({ payMcp: true, grant: false });
  try {
    const routed = vi.spyOn(routing, 'routeApprovedPayment');
    expect((await f.callPay(await f.connectPay(), 'router-denied')).isError).toBe(true);
    expect(f.payRecord('router-denied')).toMatchObject({ status: 'DENIED' });
    expect(routed).not.toHaveBeenCalled();
    expect(f.signatureCalls).toBe(0); expect(f.paidRequests).toBe(0);
  } finally { await f.close(); }
}, 30_000);
