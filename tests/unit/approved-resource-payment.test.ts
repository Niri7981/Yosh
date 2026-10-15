import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';
import { testModeGrants, testModeDailyLimit } from '../helpers/test-mode-authority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { runPaymentPreflight } from '../../src/modules/payment/payment-preflight';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { checkPaymentBinding, executeApprovedPayment, paymentBinding, paymentEndpointForIntent, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';
import { PAID_RESOURCE_SCOPE_ID, paidResource, type PaidResourceId } from '../../src/modules/resources/paid-resources';
import { DEMO_MARKET_DATA_PROVIDER_ID } from '../../src/modules/resources/static-resource-registry';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/payment-preflight', () => ({ runPaymentPreflight: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', () => ({ MARKET_RESOURCE: '/api/paid/market-snapshot?asset=SOL',
  prepareSolanaPayment: vi.fn(), confirmSolanaTransaction: vi.fn() }));
vi.mock('../../src/modules/payment/reconcile-transaction', () => ({ reconcileStoredOriginalPayment: vi.fn(), transactionMessageHash: () => 'b'.repeat(64) }));

const memberId = '11111111-1111-4111-8111-111111111111';
const principal = { cardMemberId: memberId, connectionId: '2c187121-f6f1-49a3-aea4-821c4bc0a662', connectionGeneration: 2 };
const now = Date.parse('2026-09-24T03:00:00Z');
const payloads = {
  'market-snapshot': { resource_id: 'sol-market-snapshot', asset: 'SOL', as_of: '2026-09-05T08:00:00Z',
    spot_price_usd: 140, source_label: 'Demo snapshot fixture', is_demo_snapshot: true },
  'market-analysis': { resource_id: 'sol-market-analysis', asset: 'SOL', as_of: '2026-09-05T08:00:00Z',
    assessment: 'Demo analysis', indicators: { change_24h_pct: 2.4, volatility_7d_pct: 5.8, rsi_14d: 57 },
    source_label: 'Demo analysis fixture', is_demo_analysis: true },
  'token-risk-report': { asset: 'SOL', riskLevel: 'medium', riskScore: 42,
    signals: [{ name: 'Liquidity concentration', status: 'watch', detail: 'Deterministic demo signal.' }],
    summary: 'Demo risk report.', generatedAt: '2026-09-24T03:00:00.000Z', is_demo_report: true },
};

async function fixture(id: PaidResourceId, path = ':memory:') {
  vi.clearAllMocks();
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  const signer = await generateKeyPairSigner();
  const merchant = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: signer.address, DEMO_MERCHANT_PUBLIC_KEY: merchant });
  const ledger = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now,
    timeZone: () => 'Asia/Shanghai', defaultCardMemberId: memberId });
  testModeDailyLimit(ledger, '50000000');
  testModeGrants(ledger, { totalLimit: '50000000', singleLimit: '20000000', expiresAt: now + 60 * 60 * 1000 }, principal, {
    resourceId: PAID_RESOURCE_SCOPE_ID, providerId: DEMO_MARKET_DATA_PROVIDER_ID, operation: PAID_RESOURCE_PURCHASE_OPERATION,
    network: config.network, assetId: config.mint, assetDecimals: 6, payTo: config.merchant, paymentScheme: 'exact',
  }, now);
  const descriptor = paidResource(id);
  const endpoint = `http://127.0.0.1:3049${descriptor.path}`;
  const amount = id === 'market-snapshot' ? '200000' : id === 'market-analysis' ? '20000000' : '50000';
  const quote = { scheme: 'exact' as const, network: config.network, asset: config.mint, amount, payTo: config.merchant,
    maxTimeoutSeconds: 300, extra: { feePayer, memo: 'day4:ABCDEFGHIJKLMNOPQRSTUV' } };
  const authority = ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now);
  const intent = SpendIntentSchema.parse({ id: crypto.randomUUID(), idempotencyKey: `new-${id}`, requestHash: hash(id),
    resourceId: id, resourceScopeId: PAID_RESOURCE_SCOPE_ID, resourcePath: descriptor.path,
    providerId: descriptor.providerId, amount: Number(amount), currency: 'USDC', assetDecimals: 6,
    assetId: config.mint, network: config.network, payTo: config.merchant, paymentScheme: 'exact',
    quoteFingerprint: hash(quote), createdAt: now, expiresAt: now + 300_000,
    executionBinding: paymentBinding(config, endpoint, quote), authority });
  const record = ledger.reserve(intent, quote, now, 'live_devnet');
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(runPaymentPreflight).mockResolvedValue({ cluster: config.cluster, network: config.network, mint: config.mint,
    paymentAmount: amount, buyer: { publicKey: config.buyer, ata: config.buyer, balanceBaseUnits: amount },
    merchant: { publicKey: config.merchant, ata: config.merchant, balanceBaseUnits: '0' },
    facilitator: { feePayer, feePayerLamports: 100_000 }, readyForSettlement: true });
  vi.mocked(prepareSolanaPayment).mockImplementation(async (_config, _signer, requirement, beforeSign) => {
    beforeSign?.(); return signedPaymentFixture(signer, config, requirement);
  });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  return { ledger, config, endpoint, quote, record, amount };
}

function paidResponse(id: PaidResourceId, config: Awaited<ReturnType<typeof fixture>>['config'], amount: string) {
  return new Response(JSON.stringify(payloads[id]), { status: 200, headers: { 'content-type': 'application/json',
    'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, network: config.network, payer: config.buyer,
      amount, transaction: FIXTURE_TRANSACTION_SIGNATURE })).toString('base64') } });
}

afterEach(() => vi.unstubAllGlobals());

it.each(['market-snapshot', 'market-analysis', 'token-risk-report'] as const)('pays for %s using its own requirements and stores its distinct delivery', async id => {
  const f = await fixture(id);
  vi.stubGlobal('fetch', vi.fn(async () => paidResponse(id, f.config, f.amount)));
  try {
    expect(paymentEndpointForIntent('http://127.0.0.1:3049', f.record.intent)).toBe(f.endpoint);
    await executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint);
    expect(runPaymentPreflight).toHaveBeenCalledWith(f.config, { amount: f.amount });
    expect(prepareSolanaPayment).toHaveBeenCalledWith(f.config, expect.anything(), f.quote, expect.any(Function),
      { amount: f.amount, resource: paidResource(id).path }, expect.any(Function));
    expect(f.ledger.getOwned(`new-${id}`, memberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: payloads[id] });
  } finally { f.ledger.close(); }
});

it.each(['market-snapshot', 'market-analysis', 'token-risk-report'] as const)('rejects %s requirements at the other resource URL', async id => {
  const f = await fixture(id);
  try {
    const other = id === 'market-snapshot' ? 'market-analysis' : 'market-snapshot';
    const wrong = `http://127.0.0.1:3049${paidResource(other).path}`;
    expect(() => checkPaymentBinding(f.record, f.config, wrong)).toThrow();
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, wrong)).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it('rejects malformed token risk delivery, then recovers with the original payment payload', async () => {
  const f = await fixture('token-risk-report');
  const valid = paidResponse('token-risk-report', f.config, f.amount);
  const malformed = new Response(JSON.stringify({ ...payloads['token-risk-report'], riskScore: 'unknown' }),
    { status: 200, headers: valid.headers });
  const fetcher = vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(valid);
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    expect(f.ledger.getOwned('new-token-risk-report', memberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING' });
    expect(f.ledger.getOwned('new-token-risk-report', memberId)?.data).toBeUndefined();
    await recoverApprovedPayment(f.ledger, 'new-token-risk-report', f.config, f.endpoint, undefined, memberId);
    expect(f.ledger.getOwned('new-token-risk-report', memberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE',
      data: payloads['token-risk-report'] });
    expect(loadBuyerSigner).toHaveBeenCalledOnce();
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[1][1].headers['PAYMENT-SIGNATURE']).toBe(fetcher.mock.calls[0][1].headers['PAYMENT-SIGNATURE']);
  } finally { f.ledger.close(); }
});

it('recovers a resource purchase after restart from the saved payload and resource identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-resource-payment-'));
  const path = join(directory, 'ledger.sqlite');
  const f = await fixture('market-analysis', path);
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockImplementation(async () => paidResponse('market-analysis', f.config, f.amount));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValueOnce({ status: 'UNKNOWN' });
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    expect(f.ledger.getOwned('new-market-analysis', memberId)?.status).toBe('PAYMENT_UNKNOWN');
    f.ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai' });
    try {
      reopened.recoverUnsubmittedOnStartup();
      const stored = reopened.getOwned('new-market-analysis', memberId)!;
      expect(stored.intent.offerId).toBeUndefined();
      await recoverApprovedPayment(reopened, 'new-market-analysis', f.config, paymentEndpointForIntent('http://127.0.0.1:3049', stored.intent), undefined, memberId);
      expect(reopened.getOwned('new-market-analysis', memberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: payloads['market-analysis'] });
      expect(loadBuyerSigner).toHaveBeenCalledOnce();
      expect(prepareSolanaPayment).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[1][1].headers['PAYMENT-SIGNATURE']).toBe(fetcher.mock.calls[0][1].headers['PAYMENT-SIGNATURE']);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
