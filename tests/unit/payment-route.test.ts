import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { resolvePaymentRoute, storedPaymentRoute } from '../../src/modules/payment/payment-route';
import { routeStoredApprovedPayment } from '../../src/modules/payment/payment-router';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { hash } from '../../src/modules/authority/authority-policy';
import { mppFixture } from '../helpers/mpp-fixture';

// Adapted from the preserved payment-router donor tests; Alipay is not imported.
it('preserves default x402 descriptors and explicitly represents Solana Charge', () => {
  expect(resolvePaymentRoute()).toEqual({ domain: 'onchain', network: 'solana', protocol: 'x402_exact', executor: 'pay_x402_solana', asset: 'USDC' });
  expect(resolvePaymentRoute('pay_mpp_solana_charge')).toEqual({ domain: 'onchain', network: 'solana', protocol: 'mpp_charge', executor: 'pay_mpp_solana_charge', asset: 'USDC' });
  expect(Object.isFrozen(resolvePaymentRoute())).toBe(true);
});
it.each([null, '', 'alipay', {}, { ...resolvePaymentRoute(), executor: 'pay_mpp_solana_charge' },
  { ...resolvePaymentRoute(), approved: true }, { ...resolvePaymentRoute(), network: 'ethereum' }])('rejects unsupported routes %s', raw => {
  expect(() => resolvePaymentRoute(raw)).toThrow('PAYMENT_ROUTE_UNSUPPORTED');
});
it('dispatches only the stored protocol and preserves its promise and errors without fallback', async () => {
  const { quote } = mppFixture();
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: 'mpp-route', requestHash: hash('request'),
    resourceId: 'mpp-resource', providerId: 'fixture', amount: quote.amount, currency: 'USDC', assetDecimals: 6,
    assetId: quote.asset, network: quote.network, payTo: quote.payTo, paymentScheme: 'mpp_charge', quoteFingerprint: hash(quote),
    createdAt: Date.now(), expiresAt: quote.expiresAt, executionBinding: hash('binding'), mpp: quote,
    httpRequest: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' } });
  const record = { intent, quote };
  expect(storedPaymentRoute(record).executor).toBe('pay_mpp_solana_charge');
  const failure = new Error('ORIGINAL_MPP_PAYMENT_UNKNOWN');
  const original = Promise.reject(failure), mpp = vi.fn(() => original), x402 = vi.fn(() => Promise.resolve());
  expect(routeStoredApprovedPayment(record, { pay_x402_solana: x402, pay_mpp_solana_charge: mpp })).toBe(original);
  await expect(original).rejects.toBe(failure);
  expect(mpp).toHaveBeenCalledOnce(); expect(x402).not.toHaveBeenCalled();
  expect(() => storedPaymentRoute({ ...record, quote: { ...quote, amount: '999' } })).toThrow('PAYMENT_ROUTE_BINDING_MISMATCH');
});
