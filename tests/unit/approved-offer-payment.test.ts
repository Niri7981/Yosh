import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';
import { testModeGrants, testModeDailyLimit } from '../helpers/test-mode-authority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSigner } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { LEGACY_MARKET_SNAPSHOT_OPERATION as MARKET_SNAPSHOT_OPERATION } from '../../src/modules/authority/spend-grant';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { runPaymentPreflight } from '../../src/modules/payment/payment-preflight';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { executeApprovedPayment, paymentBinding, paymentEndpoint, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { marketOfferResource } from '../../src/modules/resources/market-offers';
import { DEMO_MARKET_DATA_PROVIDER_ID, SOL_MARKET_SNAPSHOT_RESOURCE_ID } from '../../src/modules/resources/static-resource-registry';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/payment-preflight', () => ({ runPaymentPreflight: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', () => ({
  MARKET_RESOURCE: '/api/paid/market-snapshot?asset=SOL',
  prepareSolanaPayment: vi.fn(),
  confirmSolanaTransaction: vi.fn(),
}));
vi.mock('../../src/modules/payment/reconcile-transaction', () => ({
  reconcileStoredOriginalPayment: vi.fn(),
  transactionMessageHash: () => 'b'.repeat(64),
}));

const cardMemberId = '11111111-1111-4111-8111-111111111111';
const principal = { cardMemberId, connectionId: '2c187121-f6f1-49a3-aea4-821c4bc0a662', connectionGeneration: 2 };
const snapshot = { asset: 'SOL' as const, as_of: '2026-09-05T08:00:00Z', spot_price_usd: 140, change_24h_pct: 2.4,
  volume_24h_usd: 3_000_000_000, market_cap_usd: 75_000_000_000, volatility_7d_pct: 5.8, rsi_14d: 57,
  support_levels_usd: [132, 136], resistance_levels_usd: [145, 151], source_label: 'Demo snapshot fixture', is_demo_snapshot: true as const };

async function fixture(path = ':memory:') {
  vi.clearAllMocks();
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  let now = Date.parse('2026-09-22T08:00:00Z');
  const signer = await generateKeyPairSigner();
  const merchant = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: signer.address, DEMO_MERCHANT_PUBLIC_KEY: merchant });
  const ledger = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai', defaultCardMemberId: cardMemberId });
  testModeDailyLimit(ledger, '5000000');
  testModeGrants(ledger, { totalLimit: '5000000', singleLimit: '500000', expiresAt: now + 60 * 60 * 1000 }, principal, {
    resourceId: SOL_MARKET_SNAPSHOT_RESOURCE_ID, providerId: DEMO_MARKET_DATA_PROVIDER_ID, operation: MARKET_SNAPSHOT_OPERATION,
    network: config.network, assetId: config.mint, assetDecimals: 6, payTo: config.merchant, paymentScheme: 'exact',
  }, now);
  const endpoint = paymentEndpoint('http://127.0.0.1:3049', 'basic');
  const quote = { scheme: 'exact' as const, network: config.network, asset: config.mint, amount: '200000', payTo: config.merchant,
    maxTimeoutSeconds: 300, extra: { feePayer, memo: 'day4:ABCDEFGHIJKLMNOPQRSTUV' } };
  const resource = marketOfferResource({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: config.mint,
    network: config.network, allowed_pay_to: config.merchant }, 'basic');
  const authority = ledger.spendAuthority(principal, MARKET_SNAPSHOT_OPERATION, now);
  const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'offer-basic', request: { asset: 'SOL' }, requestHash: hash('offer-basic'),
    resource, quote, executionBinding: paymentBinding(config, endpoint, quote), authority, offerId: 'basic', reason: 'Need data', now });
  const record = ledger.reserve(intent, quote, now, 'live_devnet');
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(runPaymentPreflight).mockResolvedValue({ cluster: config.cluster, network: config.network, mint: config.mint, paymentAmount: quote.amount,
    buyer: { publicKey: config.buyer, ata: config.buyer, balanceBaseUnits: quote.amount }, merchant: { publicKey: config.merchant, ata: config.merchant, balanceBaseUnits: '0' },
    facilitator: { feePayer, feePayerLamports: 100_000 }, readyForSettlement: true });
  vi.mocked(prepareSolanaPayment).mockImplementation(async (_config, _signer, requirement, beforeSign) => {
    beforeSign?.();
    return signedPaymentFixture(signer, config, requirement);
  });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  return { ledger, record, config, endpoint, quote, setNow: (value: number) => { now = value; }, initialNow: now };
}

function paidResponse(config: Awaited<ReturnType<typeof fixture>>['config']) {
  return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json',
    'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, network: config.network, payer: config.buyer,
      amount: '200000', transaction: FIXTURE_TRANSACTION_SIGNATURE })).toString('base64') } });
}

afterEach(() => vi.unstubAllGlobals());

it('executes the persisted basic offer through claim, 0.20 signing controls, payment, and delivery', async () => {
  const f = await fixture();
  vi.stubGlobal('fetch', vi.fn(async () => paidResponse(f.config)));
  try {
    await executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint);
    expect(runPaymentPreflight).toHaveBeenCalledWith(f.config, { amount: '200000' });
    expect(prepareSolanaPayment).toHaveBeenCalledWith(f.config, expect.anything(), f.quote, expect.any(Function),
      { amount: '200000', resource: '/api/paid/market-snapshot?asset=SOL&offer=basic' }, expect.any(Function));
    expect(f.ledger.getOwned('offer-basic', cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  } finally { f.ledger.close(); }
});

it('re-checks revocation after signer loading and inside the SDK signing callback', async () => {
  const first = await fixture();
  let release!: () => void;
  vi.mocked(loadBuyerSigner).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return generateKeyPairSigner();
  });
  try {
    const payment = executeApprovedPayment(first.ledger, first.record.approvalId, first.config, first.endpoint);
    await vi.waitFor(() => expect(loadBuyerSigner).toHaveBeenCalledOnce());
    first.ledger.revokeActiveSpendGrant(first.initialNow + 1);
    release();
    await expect(payment).rejects.toThrow();
    expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { first.ledger.close(); }

  const second = await fixture();
  vi.mocked(prepareSolanaPayment).mockImplementationOnce(async (_config, _signer, _quote, beforeSign) => {
    second.ledger.revokeActiveSpendGrant(second.initialNow + 1);
    beforeSign?.();
    throw new Error('authority guard did not reject');
  });
  try {
    await expect(executeApprovedPayment(second.ledger, second.record.approvalId, second.config, second.endpoint)).rejects.toThrow();
    expect(second.ledger.savedPayload(second.record.approvalId)).toBeUndefined();
  } finally { second.ledger.close(); }
});

it('does not submit when authority is revoked after payload persistence', async () => {
  const f = await fixture();
  const originalSave = f.ledger.savePayload.bind(f.ledger);
  vi.spyOn(f.ledger, 'savePayload').mockImplementation((approvalId, payload, validate, original) => {
    originalSave(approvalId, payload, validate, original);
    f.ledger.revokeActiveSpendGrant(f.initialNow + 1);
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.ledger.getOwned('offer-basic', cardMemberId)?.status).toBe('FAILED');
    expect(f.ledger.savedOriginalPayment(f.record.approvalId)?.state).toBe('NOT_SUBMITTED');
  } finally { f.ledger.close(); }
});

it.each([
  ['expired', (ledger: PurchaseLedger, f: Awaited<ReturnType<typeof fixture>>) => f.setNow(f.initialNow + 301_000)],
  ['paused', (ledger: PurchaseLedger) => ledger.setPaused(true)],
  ['lowered daily limit', (ledger: PurchaseLedger) => testModeDailyLimit(ledger, '199999')],
] as const)('stops after approval when authority becomes %s', async (_name, change) => {
  const f = await fixture();
  change(f.ledger, f);
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it('recovers a timed-out offer with the original payload and never signs again', async () => {
  const f = await fixture();
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockImplementation(async () => paidResponse(f.config));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValueOnce({ status: 'UNKNOWN' });
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    expect(f.ledger.getOwned('offer-basic', cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
    await recoverApprovedPayment(f.ledger, 'offer-basic', f.config, f.endpoint, undefined, cardMemberId);
    expect(f.ledger.getOwned('offer-basic', cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    expect(loadBuyerSigner).toHaveBeenCalledOnce();
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[1][1].headers['PAYMENT-SIGNATURE']).toBe(fetcher.mock.calls[0][1].headers['PAYMENT-SIGNATURE']);
  } finally { f.ledger.close(); }
});

it('reopens SQLite and recovers the original unknown offer payload without re-signing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-offer-restart-'));
  const path = join(directory, 'ledger.sqlite');
  const f = await fixture(path);
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockImplementation(async () => paidResponse(f.config));
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow();
    f.ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => f.initialNow, timeZone: () => 'Asia/Shanghai' });
    try {
      reopened.recoverUnsubmittedOnStartup();
      await recoverApprovedPayment(reopened, 'offer-basic', f.config, f.endpoint, undefined, cardMemberId);
      expect(reopened.getOwned('offer-basic', cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
      expect(loadBuyerSigner).toHaveBeenCalledOnce();
      expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    } finally { reopened.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['amount', 'payTo', 'asset', 'network', 'memo', 'feePayer', 'binding', 'resource'] as const)(
  'rejects persisted %s tampering before loading the signer', async field => {
    const directory = mkdtempSync(join(tmpdir(), 'yosh-offer-tamper-'));
    const path = join(directory, 'ledger.sqlite');
    const f = await fixture(path);
    f.ledger.close();
    const db = new DatabaseSync(path);
    if (field === 'binding') {
      const row = db.prepare('SELECT purchase FROM purchases WHERE task_id=?').get('offer-basic')!;
      const purchase = JSON.parse(String(row.purchase));
      purchase.executionBinding = 'changed';
      db.prepare('UPDATE purchases SET purchase=? WHERE task_id=?').run(JSON.stringify(purchase), 'offer-basic');
    } else if (field !== 'resource') {
      const row = db.prepare('SELECT quote FROM purchases WHERE task_id=?').get('offer-basic')!;
      const quote = JSON.parse(String(row.quote));
      if (field === 'memo' || field === 'feePayer') quote.extra[field] = 'changed';
      else quote[field] = field === 'amount' ? '200001' : 'changed';
      db.prepare('UPDATE purchases SET quote=? WHERE task_id=?').run(JSON.stringify(quote), 'offer-basic');
    }
    db.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => f.initialNow, timeZone: () => 'Asia/Shanghai' });
    try {
      const endpoint = field === 'resource' ? `${f.endpoint}&changed=true` : f.endpoint;
      await expect(executeApprovedPayment(reopened, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
      expect(loadBuyerSigner).not.toHaveBeenCalled();
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
