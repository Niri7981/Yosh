import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import type { PaymentRequirements } from '@x402/core/types';
import { afterEach, expect, it } from 'vitest';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';
import { monetaryScopeId } from '../../src/modules/purchases/monetary-scope';
import { hash } from '../../src/modules/purchases/spending-policy';
import { FIXTURE_TRANSACTION_SIGNATURE, signedPaymentFixture } from '../helpers/signed-payment-fixture';

const paths: string[] = [];
const ledgers = new Set<PurchaseLedger>();
afterEach(() => {
  for (const ledger of ledgers) ledger.close();
  ledgers.clear();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'purchase-state-transitions-')); paths.push(directory);
  const path = join(directory, 'ledger.sqlite');
  const buyer = Keypair.generate();
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: buyer.publicKey.toBase58(),
    DEMO_MERCHANT_PUBLIC_KEY: Keypair.generate().publicKey.toBase58() });
  const quote: PaymentRequirements = { scheme: 'exact', network: config.network, asset: config.mint,
    amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 300,
    extra: { feePayer: Keypair.generate().publicKey.toBase58() } };
  const now = Date.now();
  const open = () => {
    const ledger = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: config.buyer });
    ledgers.add(ledger); return ledger;
  };
  let ledger = open();
  const resource = createStaticResourceRegistry({ endpoint: 'https://state.fixture.invalid/api',
    asset_id: config.mint, network: config.network, allowed_pay_to: config.merchant })[0];
  const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'state-fixture', request: { asset: 'SOL' },
    requestHash: hash('state-fixture'), resource, quote, executionBinding: hash('immutable fixture request'), now });
  const reserved = ledger.reserve(intent, quote, now, 'live_devnet');
  const database = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path);
    try { return run(db); } finally { db.close(); }
  };
  const snapshot = () => database(db => ({
    purchase: db.prepare('SELECT * FROM purchases').all(), original: db.prepare('SELECT * FROM original_payments').all(),
    delivery: db.prepare('SELECT * FROM purchase_delivery').all(), events: db.prepare('SELECT * FROM purchase_events').all(),
  }));
  return { get ledger() { return ledger; }, reserved, config, now, database, snapshot,
    restart() { ledger.close(); ledgers.delete(ledger); ledger = open(); },
    async sign() {
      ledger.claim(reserved.approvalId, now);
      const payload = await signedPaymentFixture(await createKeyPairSignerFromBytes(buyer.secretKey), config, quote);
      const original = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: intent.id,
        requestId: intent.idempotencyKey, monetaryScope: reserved.monetaryScope,
        scopeId: monetaryScopeId(reserved.monetaryScope), executionBinding: intent.executionBinding,
        quoteFingerprint: intent.quoteFingerprint, payloadHash: hash(payload), recordedAt: now,
        identity: createSignedPaymentIdentity(payload, config) });
      ledger.savePayload(reserved.approvalId, payload, undefined, original);
      return original;
    },
  };
}

it('cannot regress a paid original transaction, release it as failed, or claim another execution', async () => {
  const f = fixture(); await f.sign();
  f.ledger.markSubmissionAttempt(f.reserved.approvalId);
  f.ledger.confirmOriginalPayment(f.reserved.approvalId, FIXTURE_TRANSACTION_SIGNATURE, 'confirmed', f.now);
  const before = f.snapshot();

  f.ledger.unknown(f.reserved.approvalId);
  f.ledger.failUnsubmitted(f.reserved.approvalId);
  expect(() => f.ledger.failConfirmed(f.reserved.approvalId, FIXTURE_TRANSACTION_SIGNATURE)).toThrow('ORIGINAL_PAYMENT_PROOF_REQUIRED');
  expect(() => f.ledger.failOriginalPayment(f.reserved.approvalId, FIXTURE_TRANSACTION_SIGNATURE)).toThrow();
  expect(() => f.ledger.claim(f.reserved.approvalId, f.now)).toThrow();

  expect(f.snapshot()).toEqual(before);
  expect(f.ledger.get('state-fixture')).toMatchObject({ status: 'PAID', transaction: FIXTURE_TRANSACTION_SIGNATURE,
    deliveryStatus: 'PENDING' });
  expect(f.ledger.managedSummary(f.now, 'live_devnet')).toMatchObject({ paid: '10000', reserved: '0', unresolved: 0 });
});

it('retains UNKNOWN authority and immutable evidence after a submitted attempt, including restart', async () => {
  const f = fixture(); const original = await f.sign();
  f.ledger.markSubmissionAttempt(f.reserved.approvalId);
  f.ledger.unknown(f.reserved.approvalId);
  const before = f.snapshot();
  f.restart();
  f.ledger.recoverUnsubmittedOnStartup();
  f.ledger.failUnsubmitted(f.reserved.approvalId);
  expect(() => f.ledger.failConfirmed(f.reserved.approvalId, FIXTURE_TRANSACTION_SIGNATURE)).toThrow('ORIGINAL_PAYMENT_PROOF_REQUIRED');
  expect(() => f.ledger.claim(f.reserved.approvalId, f.now)).toThrow();

  expect(f.snapshot()).toEqual(before);
  expect(f.ledger.savedOriginalPayment(f.reserved.approvalId)).toMatchObject({ evidence: original, state: 'OUTCOME_UNKNOWN' });
  expect(f.ledger.get('state-fixture')).toMatchObject({ status: 'PAYMENT_UNKNOWN', paymentPayloadPresent: true });
  expect(f.ledger.managedSummary(f.now + 600_000, 'live_devnet')).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
});

it.each([false, true])('releases only demonstrably unsubmitted startup work (signed=%s)', async signed => {
  const f = fixture();
  if (signed) await f.sign(); else f.ledger.claim(f.reserved.approvalId, f.now);
  const originalBefore = f.ledger.savedOriginalPayment(f.reserved.approvalId)?.evidence;
  f.restart();
  f.ledger.recoverUnsubmittedOnStartup();

  expect(f.ledger.get('state-fixture')).toMatchObject({ status: 'FAILED', deliveryStatus: 'NOT_PAID' });
  expect(f.ledger.managedSummary(f.now, 'live_devnet')).toMatchObject({ paid: '0', reserved: '0', unresolved: 0 });
  if (signed) expect(f.ledger.savedOriginalPayment(f.reserved.approvalId)).toMatchObject({ state: 'NOT_SUBMITTED', evidence: originalBefore });
  const after = f.snapshot();
  f.ledger.recoverUnsubmittedOnStartup();
  expect(f.snapshot()).toEqual(after);
});

it.each([
  ['REJECTED', 'DENIED'], ['NEEDS_CONFIRMATION', 'REQUIRES_APPROVAL'],
])('reads historical %s as %s without rewriting its persisted history', (legacy, canonical) => {
  const f = fixture();
  f.database(db => db.prepare('UPDATE purchases SET status=?').run(legacy));
  const before = f.snapshot();
  f.restart();

  expect(f.ledger.get('state-fixture')).toMatchObject({ status: canonical });
  expect(f.ledger.list()[0]).toMatchObject({ status: canonical });
  expect(f.snapshot()).toEqual(before);
});

it('rejects a foreign persisted status at record and list boundaries while preserving the corrupt row for review', () => {
  const f = fixture();
  f.database(db => db.prepare("UPDATE purchases SET status='COMPLETE'").run());
  const before = f.snapshot();
  expect(() => f.ledger.get('state-fixture')).toThrow();
  expect(() => f.ledger.list()).toThrow();
  expect(f.snapshot()).toEqual(before);
});
