import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { executeApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { routeApprovedPayment } from '../../src/modules/payment/payment-router';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';

vi.mock('../../src/modules/purchases/approved-payment', () => ({ executeApprovedPayment: vi.fn() }));
const ledger = new PurchaseLedger(':memory:');
const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
const args: Parameters<typeof executeApprovedPayment> = [ledger, 'original-approval', {
  ...environment, mint: environment.asset.mint, buyer: '11111111111111111111111111111111',
  merchant: '11111111111111111111111111111111', facilitatorUrl: null,
}, 'https://merchant.example/resource', vi.fn()];
afterEach(() => vi.resetAllMocks());
afterAll(() => ledger.close());

it('preserves original x402 arguments and promise without a second execution layer', () => {
  const pending = Promise.resolve(undefined); vi.mocked(executeApprovedPayment).mockReturnValue(pending);
  expect(routeApprovedPayment(args)).toBe(pending);
  expect(executeApprovedPayment).toHaveBeenCalledExactlyOnceWith(...args);
  vi.mocked(executeApprovedPayment).mock.calls[0].forEach((value, index) => expect(value).toBe(args[index]));
});
it('propagates the original x402 failure without retry', async () => {
  const error = new Error('ORIGINAL_PAYMENT_UNKNOWN'); vi.mocked(executeApprovedPayment).mockRejectedValue(error);
  await expect(routeApprovedPayment(args)).rejects.toBe(error);
  expect(executeApprovedPayment).toHaveBeenCalledOnce();
});
