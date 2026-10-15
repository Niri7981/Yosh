import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
vi.mock('../../src/modules/payment/reconcile-transaction', () => ({ reconcileStoredOriginalPayment: vi.fn(), transactionMessageHash: () => 'a'.repeat(64) }));
import { generateKeyPairSigner } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment, confirmSolanaTransaction } from '../../src/modules/payment/solana-payment';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { executeApprovedPayment, recoverApprovedPayment, paymentBinding } from '../../src/modules/purchases/approved-payment';
import { hash } from '../../src/modules/purchases/spending-policy';
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', () => ({ MARKET_RESOURCE: '/api/paid/market-snapshot?asset=SOL', prepareSolanaPayment: vi.fn(), confirmSolanaTransaction: vi.fn() }));
const endpoint = 'http://127.0.0.1:3000/api/paid/market-snapshot?asset=SOL';
async function fixture(path = ':memory:', managed = false) {
  vi.clearAllMocks();
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  const signer = await generateKeyPairSigner();
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: signer.address, DEMO_MERCHANT_PUBLIC_KEY: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs' });
  const resource = createStaticResourceRegistry({ endpoint: 'https://example.com', asset_id: config.mint, network: config.network, allowed_pay_to: config.merchant })[0];
  const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 300, extra: { feePayer: (await generateKeyPairSigner()).address } };
  vi.mocked(prepareSolanaPayment).mockResolvedValue(await signedPaymentFixture(signer, config, quote));
  const ledger = new PurchaseLedger(path, { managed, mode: 'live_devnet' }); const now = Date.now();
  if (managed) ledger.setDailyLimit('100000');
  const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'task', request: { asset: 'SOL' }, requestHash: hash('task'), resource, quote,
    executionBinding: paymentBinding(config, endpoint), now });
  const record = ledger.reserve(intent, quote, now, 'live_devnet');
  return { ledger, record, config, payload: await signedPaymentFixture(signer, config, quote) };
}
afterEach(() => vi.unstubAllGlobals());
it('unknown approval never accesses the wallet', async () => {
  const f = await fixture();
  try { await expect(executeApprovedPayment(f.ledger, 'untrusted-id', f.config, endpoint)).rejects.toThrow('Unknown approval'); expect(loadBuyerSigner).not.toHaveBeenCalled(); }
  finally { f.ledger.close(); }
});
it('binding mismatch stops before key access', async () => {
  const f = await fixture();
  try { await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint + '&changed=true')).rejects.toThrow('Approval binding changed'); expect(loadBuyerSigner).not.toHaveBeenCalled(); }
  finally { f.ledger.close(); }
});
it('network timeout retains UNKNOWN and prevents a second signature', async () => {
  const f = await fixture(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow('reconciliation');
    expect(f.ledger.getLegacy('task')?.status).toBe('PAYMENT_UNKNOWN');
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow('inactive');
    expect(prepareSolanaPayment).toHaveBeenCalledTimes(1);
  } finally { f.ledger.close(); }
});
it('a receipt for another payer cannot mark the purchase paid', async () => {
  const f = await fixture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, network: f.config.network, payer: f.config.merchant, transaction: FIXTURE_TRANSACTION_SIGNATURE })).toString('base64') } })));
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow('reconciliation');
    expect(f.ledger.getLegacy('task')?.status).toBe('PAYMENT_UNKNOWN'); expect(confirmSolanaTransaction).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

const snapshot = { asset: 'SOL', as_of: '2026-09-05T08:00:00Z', spot_price_usd: 140, change_24h_pct: 2.4, volume_24h_usd: 3000000000, market_cap_usd: 75000000000, volatility_7d_pct: 5.8, rsi_14d: 57, support_levels_usd: [132,136], resistance_levels_usd: [145,151], source_label: 'Demo snapshot fixture', is_demo_snapshot: true };
function paidResponse(config: Awaited<ReturnType<typeof fixture>>['config'], body = JSON.stringify(snapshot), success = true) {
  return new Response(body, { status: success ? 200 : 402, headers: { 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success, network: config.network, payer: config.buyer, amount: '10000', transaction: FIXTURE_TRANSACTION_SIGNATURE })).toString('base64') } });
}
it('lost response recovers using identical saved payload without wallet access or resubmission', async () => {
  const f = await fixture(); const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockImplementation(() => Promise.resolve(paidResponse(f.config))); vi.stubGlobal('fetch', fetcher);
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
    await Promise.all([1,2].map(() => recoverApprovedPayment(f.ledger, 'task', f.config, endpoint)));
    expect(f.ledger.getLegacy('task')?.status).toBe('PAID');
    expect(f.ledger.getLegacy('task')?.paymentEvidence).toMatchObject({ version: 3, payer: f.config.buyer });
    expect(fetcher.mock.calls[1][1].headers['PAYMENT-RECOVERY']).toBe('1');
    expect(fetcher.mock.calls[0][1].headers['PAYMENT-SIGNATURE']).toBe(fetcher.mock.calls[1][1].headers['PAYMENT-SIGNATURE']);
    expect(loadBuyerSigner).toHaveBeenCalledTimes(1); expect(prepareSolanaPayment).toHaveBeenCalledTimes(1);
    expect(f.ledger.eventsForLegacy('task').filter(e => e.type === 'payment.PAID')).toHaveLength(1);
  } finally { f.ledger.close(); }
});
it.each([JSON.stringify({ ...snapshot, rsi_14d: 999 }), JSON.stringify(snapshot) + ' '.repeat(17000)])('invalid or oversized paid data remains unavailable to the agent', async body => {
  const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config, body)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
    await recoverApprovedPayment(f.ledger, 'task', f.config, endpoint);
    expect(f.ledger.getLegacy('task')?.status).toBe('PAID'); expect(f.ledger.getLegacy('task')?.deliveryStatus).toBe('PENDING');
    expect(f.ledger.getLegacy('task')?.data).toBeUndefined();
    expect(f.ledger.summary()).toMatchObject({ paidUSDC: 0.01, reservedUSDC: 0, unresolved: 0 });
  } finally { f.ledger.close(); }
});

it('pause while loading the wallet prevents preparation and submission', async () => {
  const f = await fixture(':memory:', true);
  const signer = await generateKeyPairSigner();
  let release!: () => void;
  vi.mocked(loadBuyerSigner).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return signer;
  });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  try {
    const payment = executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint);
    f.ledger.setPaused(true); release();
    await expect(payment).rejects.toThrow();
    expect(prepareSolanaPayment).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(f.ledger.getLegacy('task')?.status).toBe('FAILED');
  } finally { f.ledger.close(); }
});

it('pause during preparation is checked at the actual signing boundary', async () => {
  const f = await fixture(':memory:', true);
  vi.mocked(prepareSolanaPayment).mockImplementationOnce(async (_config, _signer, _quote, beforeSign) => {
    f.ledger.setPaused(true);
    beforeSign?.();
    throw new Error('signing guard did not reject');
  });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
    expect(vi.mocked(prepareSolanaPayment).mock.calls[0]?.[3]).toBeTypeOf('function');
    expect(fetcher).not.toHaveBeenCalled(); expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  } finally { f.ledger.close(); }
});

it('startup releases a crashed claim without a persisted payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-crash-')); const path = join(dir, 'ledger.sqlite');
  const f = await fixture(path); f.ledger.claim(f.record.approvalId); f.ledger.close();
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet' });
  try {
    reopened.recoverUnsubmittedOnStartup();
    expect(reopened.getLegacy('task')?.status).toBe('FAILED');
    expect(reopened.summary().unresolved).toBe(0);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('startup preserves a signed unknown payment and its reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-unknown-')); const path = join(dir, 'ledger.sqlite');
  const f = await fixture(path);
  f.ledger.claim(f.record.approvalId);
  f.ledger.savePayload(f.record.approvalId, f.payload);
  f.ledger.unknown(f.record.approvalId); f.ledger.close();
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet' });
  try {
    reopened.recoverUnsubmittedOnStartup();
    expect(reopened.getLegacy('task')?.status).toBe('PAYMENT_UNKNOWN');
    expect(reopened.summary()).toMatchObject({ reservedUSDC: 0.01, unresolved: 1 });
    expect(reopened.savedPayload(f.record.approvalId)).toBeDefined();
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('delivery recovery after restart preserves the payment day and uses no new signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-delivery-')); const path = join(dir, 'ledger.sqlite');
  const f = await fixture(path);
  f.ledger.claim(f.record.approvalId);
  f.ledger.savePayload(f.record.approvalId, f.payload);
  const yesterday = Date.now() - 86400000;
  f.ledger.confirmPayment(f.record.approvalId, FIXTURE_TRANSACTION_SIGNATURE, { payer: f.config.buyer, messageHash: 'a'.repeat(64), confirmationStatus: 'confirmed', settlementConfirmed: true }, yesterday); f.ledger.close();
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet' });
  vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try {
    expect(reopened.getLegacy('task')?.deliveryStatus).toBe('PENDING');
    await recoverApprovedPayment(reopened, 'task', f.config, endpoint);
    expect(reopened.getLegacy('task')?.deliveryStatus).toBe('COMPLETE');
    expect(reopened.summary(yesterday).paidUSDC).toBe(0.01);
    expect(reopened.summary().paidUSDC).toBe(0);
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('a receipt for an unrelated confirmed transaction never completes a purchase', async () => {
  const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  try { await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow(); expect(f.ledger.getLegacy('task')?.status).toBe('PAYMENT_UNKNOWN'); }
  finally { f.ledger.close(); }
});

it('marks the original transfer paid from chain proof even without facilitator settlement success', async () => {
  const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config, '{}', false)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
    expect(f.ledger.getLegacy('task')).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING', transaction: FIXTURE_TRANSACTION_SIGNATURE });
    expect(f.ledger.getLegacy('task')?.paymentEvidence).toMatchObject({ version: 3, source: 'buyer_rpc', settlementConfirmed: false });
    expect(f.ledger.summary()).toMatchObject({ paidUSDC: 0.01, reservedUSDC: 0, unresolved: 0 });
  } finally { f.ledger.close(); }
});
it('only proven chain failure releases the payment reservation', async () => {
  const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config, '{}', false)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'FAILED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try { await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow(); expect(f.ledger.getLegacy('task')?.status).toBe('FAILED'); expect(f.ledger.getLegacy('task')?.data).toBeUndefined(); }
  finally { f.ledger.close(); }
});
it('a simulation failure releases the unsubmitted approval without any network submission', async () => {
  const f = await fixture(); vi.mocked(prepareSolanaPayment).mockRejectedValueOnce(new Error('simulation failed')); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  try { await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow(); expect(f.ledger.getLegacy('task')?.status).toBe('FAILED'); expect(fetcher).not.toHaveBeenCalled(); }
  finally { f.ledger.close(); }
});

it('recovers a client crash using the persisted original payload after reopening SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'day6-client-')); const path = join(dir, 'ledger.sqlite');
  const f = await fixture(path);
  f.ledger.claim(f.record.approvalId);
  const payload = f.payload;
  f.ledger.savePayload(f.record.approvalId, payload);
  f.ledger.close();
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet' });
  vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config)));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  try {
    await recoverApprovedPayment(reopened, 'task', f.config, endpoint);
    expect(reopened.getLegacy('task')?.status).toBe('PAID');
    expect(reopened.getLegacy('task')?.paymentEvidence).toMatchObject({ version: 3, payer: f.config.buyer });
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});
