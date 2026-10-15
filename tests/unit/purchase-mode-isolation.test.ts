import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { purchaseMarketSnapshot } from '../../src/modules/purchases/purchase-market-snapshot';
import { paymentBinding, paymentEndpoint } from '../../src/modules/purchases/approved-payment';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { hash } from '../../src/modules/purchases/spending-policy';
import { demoSnapshot } from '../../src/modules/paid-market-api/paid-market-api';

const config: PaymentConfig = { ...resolvePaymentEnvironment({}, 'live_devnet'),
  cluster: 'devnet', rpcUrl: 'https://rpc.invalid', network: DEVNET_NETWORK, mint: DEVNET_USDC_MINT,
  buyer: 'BSEDrH4umjwCKUL5TqYm69ffsSjwWcV2BXQkczVp1F52',
  merchant: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', facilitatorUrl: 'https://facilitator.invalid',
};
const origin = 'http://127.0.0.1:3049';
const transaction = '1'.repeat(88);
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

function liveQuote(id: string): PaymentRequirements {
  return { scheme: 'exact', network: config.network, asset: config.mint, amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 300,
    extra: { feePayer: config.buyer, memo: `app-test:${id}` } };
}

function reserveIntent(id: string, quote: PaymentRequirements, now = Date.now()) {
  const resource = createStaticResourceRegistry({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: config.mint,
    network: config.network, allowed_pay_to: config.merchant })[0];
  return createMarketSnapshotSpendIntent({ idempotencyKey: id, request: { asset: 'SOL' }, requestHash: hash('same task'), resource, quote,
    executionBinding: paymentBinding(config, paymentEndpoint(origin)), now });
}

function seedVerifiedLivePurchase(ledger: PurchaseLedger, id: string) {
  const now = Date.now();
  const quote = liveQuote(id);
  const intent = reserveIntent(id, quote, now);
  const reserved = ledger.reserve(intent, quote, now, 'live_devnet', undefined, ledger.paymentScope(config, 'live_devnet'));
  ledger.claim(reserved.approvalId, now);
  ledger.savePayload(reserved.approvalId, { x402Version: 2, accepted: quote, payload: { transaction: 'signed-fixture-wire' } });
  ledger.confirmPayment(reserved.approvalId, transaction, {
    payer: config.buyer, messageHash: 'a'.repeat(64), confirmationStatus: 'confirmed', settlementConfirmed: true,
  }, now);
  ledger.finish(reserved.approvalId, { transaction, data: demoSnapshot }, now);
  return reserved;
}

it('rejects Mainnet reservation before any write without changing the ledger schema or existing rows', () => {
  const ledger = new PurchaseLedger(':memory:');
  seedVerifiedLivePurchase(ledger, 'original-devnet');
  const before = ledger.listForAdministration();
  const quote = liveQuote('mainnet-disabled');
  try {
    expect(() => ledger.reserve(reserveIntent('mainnet-disabled', quote), quote, Date.now(), 'live_mainnet'))
      .toThrow('MAINNET_AUTHORITY_REQUIRED');
    expect(ledger.listForAdministration()).toEqual(before);
    expect(ledger.getForAdministration('mainnet-disabled')).toBeUndefined();
  } finally { ledger.close(); }
});

it('replays simulated PAID in simulated mode and rejects it in live mode before side effects', async () => {
  const ledger = new PurchaseLedger(':memory:');
  const id = 'simulated-purchase';
  const input = { purchaseId: id, intent: 'same task' };
  const simulated = await purchaseMarketSnapshot(input, { config, ledger, origin, mode: 'simulated' });
  const sameModeReplay = await purchaseMarketSnapshot(input, { config, ledger, origin, mode: 'simulated' });
  const fetcher = vi.fn<typeof fetch>();
  const preflight = vi.fn();
  const pay = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    expect(simulated).toMatchObject({ reused: false, simulated: true, record: { status: 'PAID', executionMode: 'simulated', paymentPayloadPresent: false } });
    expect(sameModeReplay).toMatchObject({ reused: true, simulated: true, record: { status: 'PAID', executionMode: 'simulated' } });
    await expect(purchaseMarketSnapshot(input, { config, ledger, origin, mode: 'live_devnet', preflight, pay }))
      .rejects.toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');
    expect(preflight).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { ledger.close(); }
});

it('keeps a persisted execution mode immutable in the ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-mode-immutable-')); directories.push(directory);
  const path = join(directory, 'ledger.sqlite');
  const ledger = new PurchaseLedger(path);
  const id = 'immutable-simulation';
  try {
    await purchaseMarketSnapshot({ purchaseId: id, intent: 'same task' }, { config, ledger, origin, mode: 'simulated' });
    const database = new DatabaseSync(path);
    try {
      expect(() => database.prepare("UPDATE purchases SET execution_mode='live_devnet' WHERE task_id=?").run(id))
        .toThrow('purchase execution mode is immutable');
    } finally { database.close(); }
    expect(ledger.getForAdministration(id)?.executionMode).toBe('simulated');
  } finally { ledger.close(); }
});

it('replays verified live PAID in live mode and rejects simulated reuse', async () => {
  const ledger = new PurchaseLedger(':memory:');
  const id = 'live-purchase';
  seedVerifiedLivePurchase(ledger, id);
  const input = { purchaseId: id, intent: 'same task' };
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  try {
    const replay = await purchaseMarketSnapshot(input, { config, ledger, origin, mode: 'live_devnet' });
    expect(replay).toMatchObject({ reused: true, simulated: false, record: { status: 'PAID', executionMode: 'live_devnet', paymentPayloadPresent: true } });
    await expect(purchaseMarketSnapshot(input, { config, ledger, origin, mode: 'simulated' }))
      .rejects.toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { ledger.close(); }
});

it('refuses to reuse a live PAID row after its durable payment proof is missing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-proof-')); directories.push(directory);
  const path = join(directory, 'ledger.sqlite');
  const ledger = new PurchaseLedger(path);
  const id = 'live-proof-required';
  seedVerifiedLivePurchase(ledger, id);
  const database = new DatabaseSync(path);
  expect(() => database.prepare('UPDATE purchases SET payload=NULL WHERE task_id=?').run(id)).toThrow('signed payment payload is immutable');
  database.prepare('UPDATE purchases SET payment_evidence=NULL WHERE task_id=?').run(id);
  database.close();
  try {
    await expect(purchaseMarketSnapshot({ purchaseId: id, intent: 'same task' }, { config, ledger, origin, mode: 'live_devnet' }))
      .rejects.toThrow('LIVE_PAYMENT_EVIDENCE_INVALID');
  } finally { ledger.close(); }
});

it('keeps a migrated legacy purchase UNKNOWN and preserves its saved resource', () => {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-legacy-')); directories.push(directory);
  const path = join(directory, 'legacy.sqlite');
  const id = 'legacy-simulation';
  const quote = liveQuote(id);
  const intent = reserveIntent(id, quote);
  const decision = { decision: 'APPROVED', reason: 'LEGACY', committedBefore: 0, remainingAfter: 10000 };
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE purchases (id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,approval_id TEXT NOT NULL UNIQUE,
    purchase TEXT NOT NULL,quote TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,amount INTEGER NOT NULL,
    confirmed_day TEXT,transaction_id TEXT,data TEXT,payload TEXT,owner_card_member_id TEXT);
    CREATE TABLE purchase_answers (purchase_id TEXT PRIMARY KEY,answer TEXT NOT NULL);
    CREATE TABLE purchase_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,purchase_id TEXT NOT NULL,type TEXT NOT NULL,at INTEGER NOT NULL);`);
  database.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    intent.id, id, 'legacy-approval', JSON.stringify(intent), JSON.stringify(quote), JSON.stringify(decision), 'PAID', 10000,
    '2026-09-23', `simulated-${id}`, JSON.stringify(demoSnapshot), null, null,
  );
  database.close();

  const ledger = new PurchaseLedger(path, { managed: true });
  try {
    const record = ledger.getForAdministration(id);
    expect(record).toMatchObject({ status: 'PAID', executionMode: 'UNKNOWN', data: demoSnapshot, paymentPayloadPresent: false });
    expect(() => ledger.assertReplayAllowed(record!, 'live_devnet')).toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');
    expect(() => ledger.assertReplayAllowed(record!, 'simulated')).toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');
  } finally { ledger.close(); }
});
