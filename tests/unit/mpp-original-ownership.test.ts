import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { MppChargeQuoteSchema, MppStoredPaymentSchema } from '../../src/modules/payment/mpp-contract';
import { createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { monetaryScopeId } from '../../src/modules/purchases/monetary-scope';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';
import { hash } from '../../src/modules/purchases/spending-policy';
import { mppCredential, mppFixture } from '../helpers/mpp-fixture';

const now = Date.parse('2026-11-15T12:00:00Z');
const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
const indexName = 'one_mpp_original_transaction';
const paths: string[] = [], ledgers: PurchaseLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(value => value.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function open(path: string, walletIdentity?: string) {
  const value = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true,
    now: () => now, defaultCardMemberId: principal.cardMemberId, walletIdentity });
  ledgers.push(value); return value;
}
function close(value: PurchaseLedger) { value.close(); ledgers.splice(ledgers.indexOf(value), 1); }
function setup(memo?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-mpp-original-')); paths.push(directory);
  const path = join(directory, 'ledger.sqlite'), value = open(path), f = mppFixture({ memo });
  authorize(value, f);
  return { path, value, f };
}
function authorize(value: PurchaseLedger, f: ReturnType<typeof mppFixture>) {
  value.setDailyLimit('1000000');
  value.createSpendGrant({ totalLimit: '1000000', singleLimit: '500000', expiresAt: now + 3_600_000 }, principal,
    { resourceId: 'mpp-resource', providerId: 'fixture', operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: f.config.network, assetId: f.config.mint, assetDecimals: 6, payTo: f.config.merchant,
      paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: '10001' }, now, 'live_devnet');
}
function prepared(value: PurchaseLedger, f: ReturnType<typeof mppFixture>, id: string) {
  const challenge = { ...f.quote.challenge, id };
  const quote = MppChargeQuoteSchema.parse({ ...f.quote, challenge,
    challengeHeader: 'Payment ' + Object.entries(challenge).map(([key, field]) => `${key}="${field}"`).join(', ') });
  const payment = MppStoredPaymentSchema.parse({ ...f.payment, quote, credential: mppCredential(quote, f.payment.transaction) });
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: id, requestHash: hash(id), resourceId: 'mpp-resource',
    providerId: 'fixture', network: quote.network, assetId: quote.asset, assetDecimals: 6, amount: quote.amount, currency: 'USDC',
    payTo: quote.payTo, paymentScheme: 'mpp_charge', quoteFingerprint: hash(quote), createdAt: now, expiresAt: quote.expiresAt,
    executionBinding: hash([id, quote]), authority: value.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_devnet'),
    mpp: quote, httpRequest: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' } });
  const record = value.reserve(intent, quote, now);
  expect(record.status).toBe('APPROVED');
  const original = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: record.intent.id, requestId: id,
    monetaryScope: record.monetaryScope, scopeId: monetaryScopeId(record.monetaryScope), executionBinding: intent.executionBinding,
    quoteFingerprint: hash(quote), payloadHash: hash(payment), recordedAt: now, identity: f.identity });
  return { record, payment, original };
}
function save(value: PurchaseLedger, item: ReturnType<typeof prepared>) {
  value.claim(item.record.approvalId, now);
  value.savePayload(item.record.approvalId, item.payment, undefined, item.original);
}

it.each([undefined, 'reused-external-id'])('owns one signed transaction across distinct challenges with externalId=%s', memo => {
  const { path, value, f } = setup(memo), first = prepared(value, f, 'first'), second = prepared(value, f, 'second');
  expect(first.payment.quote.challenge.id).not.toBe(second.payment.quote.challenge.id);
  expect(first.payment.transaction).toBe(second.payment.transaction);
  save(value, first); value.markSubmissionAttempt(first.record.approvalId, undefined, now);
  value.confirmOriginalPayment(first.record.approvalId, f.signature, 'confirmed', now);
  const stale = new DatabaseSync(path);
  try {
    expect(() => stale.prepare('INSERT INTO original_payments VALUES (?,?,?,NULL,?)')
      .run(second.record.intent.id, JSON.stringify(second.original), 'SIGNED_NOT_SUBMITTED', f.signature)).toThrow('UNIQUE');
  } finally { stale.close(); }
  expect(() => save(value, second)).toThrow('MPP_ORIGINAL_TRANSACTION_ALREADY_USED');
  expect(value.savedMppPayment(second.record.approvalId)).toBeUndefined();
  expect(value.savedOriginalPayment(second.record.approvalId)).toBeUndefined();
  expect(() => value.markSubmissionAttempt(second.record.approvalId, undefined, now)).toThrow();
  value.failUnsubmitted(second.record.approvalId);
  expect(value.savedOriginalPayment(first.record.approvalId)?.state).toBe('CONFIRMED');
  value.confirmOriginalPayment(first.record.approvalId, f.signature, 'confirmed', now);
  expect(value.managedSummary(now)).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(() => value.confirmOriginalPayment(second.record.approvalId, f.signature, 'confirmed', now)).toThrow();
});

it('retains transaction ownership after terminal failure and restart while a different lifetime remains valid', () => {
  const { path, value, f } = setup(), first = prepared(value, f, 'failed-first');
  save(value, first); value.failUnsubmitted(first.record.approvalId); close(value);
  const reopened = open(path), second = prepared(reopened, f, 'after-restart');
  expect(() => save(reopened, second)).toThrow('MPP_ORIGINAL_TRANSACTION_ALREADY_USED');
  reopened.failUnsubmitted(second.record.approvalId);
  const fresh = mppFixture({ buyer: f.buyer, merchant: f.merchant });
  expect(fresh.identity.recentBlockhash).not.toBe(f.identity.recentBlockhash);
  const third = prepared(reopened, fresh, 'different-original'); save(reopened, third);
  expect(reopened.savedOriginalPayment(first.record.approvalId)?.state).toBe('NOT_SUBMITTED');
  expect(reopened.savedOriginalPayment(third.record.approvalId)?.evidence.identity.knownSignature).toBe(fresh.signature);
});

it('claims a duplicate signed transaction only once across separate concurrent processes', async () => {
  const { path, value, f } = setup(), otherScope = open(path, 'alternate-wallet-record'); authorize(otherScope, f);
  const items = [prepared(value, f, 'race-a'), prepared(otherScope, f, 'race-b')]; close(value); close(otherScope);
  expect(items[0].original.scopeId).not.toBe(items[1].original.scopeId);
  const workers = items.map(item => ({ item, child: fork(resolve('tests/helpers/mpp-original-worker.ts'), [], {
    execArgv: ['--import', 'tsx'], silent: true, env: { PATH: process.env.PATH, NODE_ENV: 'test' } }) }));
  const exits = workers.map(({ child }) => once(child, 'exit'));
  try {
    // Constructors are sequential; only the actual ownership writes race.
    for (const { child, item } of workers) {
      const ready = once(child, 'message'); child.send({ path, now, walletIdentity: item.record.monetaryScope.walletIdentity,
        approvalId: item.record.approvalId, payment: item.payment, original: item.original });
      expect((await ready)[0]).toEqual({ ready: true });
    }
    const results = await Promise.all(workers.map(async ({ child }) => {
      const done = once(child, 'message'); child.send('save');
      return z.object({ status: z.enum(['saved', 'MPP_ORIGINAL_TRANSACTION_ALREADY_USED']) }).parse((await done)[0]);
    }));
    expect(results.filter(result => result.status === 'saved')).toHaveLength(1);
    expect(results.filter(result => result.status === 'MPP_ORIGINAL_TRANSACTION_ALREADY_USED')).toHaveLength(1);
    await Promise.all(exits);
    const reopened = open(path);
    const originals = items.map(item => reopened.savedOriginalPayment(item.record.approvalId));
    expect(originals.filter(Boolean)).toHaveLength(1);
    const reserved = items.reduce((sum, item) => sum + BigInt(reopened.managedSummary(now, 'live_devnet', item.record.monetaryScope).reserved), 0n);
    expect(reserved.toString()).toBe(f.quote.amount);
    expect(items.filter(item => reopened.getOwned(item.record.intent.idempotencyKey, principal.cardMemberId)?.status === 'FAILED')).toHaveLength(1);
  } finally { workers.forEach(({ child }) => child.kill()); }
}, 15_000);

it('adds ownership for a historical pending MPP original without changing its bytes or held budget', () => {
  const { path, value, f } = setup(), first = prepared(value, f, 'historical-unique'); save(value, first);
  value.markSubmissionAttempt(first.record.approvalId, undefined, now); value.unknown(first.record.approvalId); close(value);
  const old = new DatabaseSync(path);
  old.exec(`DROP INDEX IF EXISTS ${indexName}`);
  old.prepare("DELETE FROM ledger_schema_migrations WHERE id='024_mpp_original_transaction_ownership'").run();
  const before = old.prepare('SELECT * FROM original_payments').all(); old.close();
  const reopened = open(path), read = new DatabaseSync(path);
  try {
    expect(read.prepare('SELECT * FROM original_payments').all()).toEqual(before);
    expect(read.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(indexName)).toBeDefined();
    expect(reopened.managedSummary(now).reserved).toBe(f.quote.amount);
    reopened.confirmOriginalPayment(first.record.approvalId, f.signature, 'confirmed', now);
    const second = prepared(reopened, f, 'historical-collision');
    expect(() => save(reopened, second)).toThrow('MPP_ORIGINAL_TRANSACTION_ALREADY_USED');
  } finally { read.close(); }
});

it('fails closed on historical duplicate ownership and retains both originals and reservations verbatim', () => {
  const { path, value, f } = setup(), first = prepared(value, f, 'historical-a'), second = prepared(value, f, 'historical-b');
  save(value, first); value.markSubmissionAttempt(first.record.approvalId, undefined, now); value.unknown(first.record.approvalId); close(value);
  const old = new DatabaseSync(path);
  old.exec(`DROP INDEX IF EXISTS ${indexName}`);
  old.prepare("DELETE FROM ledger_schema_migrations WHERE id='024_mpp_original_transaction_ownership'").run();
  // Reproduce the prior schema, which had no cross-purchase ownership constraint.
  old.prepare("UPDATE purchases SET payload=?,status='PAYMENT_UNKNOWN' WHERE id=?").run(JSON.stringify(second.payment), second.record.intent.id);
  old.prepare('INSERT INTO original_payments VALUES (?,?,?,?,?)').run(second.record.intent.id, JSON.stringify(second.original), 'OUTCOME_UNKNOWN', now, f.signature);
  const before = { purchases: old.prepare('SELECT * FROM purchases ORDER BY id').all(), originals: old.prepare('SELECT * FROM original_payments ORDER BY purchase_id').all() };
  old.close();
  expect(() => open(path)).toThrow('MPP_ORIGINAL_TRANSACTION_MIGRATION_FAILED');
  const after = new DatabaseSync(path);
  try {
    expect(after.prepare('SELECT * FROM purchases ORDER BY id').all()).toEqual(before.purchases);
    expect(after.prepare('SELECT * FROM original_payments ORDER BY purchase_id').all()).toEqual(before.originals);
    expect(after.prepare("SELECT 1 FROM ledger_schema_migrations WHERE id='024_mpp_original_transaction_ownership'").get()).toBeUndefined();
  } finally { after.close(); }
});

it('leaves an x402-only pending original and its stored bytes unchanged across startup', () => {
  const { path, value, f } = setup('x402-original-memo');
  const quote = { scheme: 'exact', network: f.config.network, asset: f.config.mint, amount: f.quote.amount,
    payTo: f.config.merchant, maxTimeoutSeconds: 300, extra: { feePayer: f.config.buyer } };
  value.createSpendGrant({ totalLimit: '1000000', singleLimit: '500000', expiresAt: now + 3_600_000 }, principal,
    { resourceId: 'exact-resource', providerId: 'fixture', operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: quote.network, assetId: quote.asset, assetDecimals: 6, payTo: quote.payTo, paymentScheme: 'exact' }, now, 'live_devnet');
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: 'exact-original', requestHash: hash('exact'), resourceId: 'exact-resource',
    providerId: 'fixture', network: quote.network, assetId: quote.asset, assetDecimals: 6, amount: quote.amount, currency: 'USDC',
    payTo: quote.payTo, paymentScheme: 'exact', quoteFingerprint: hash(quote), createdAt: now, expiresAt: now + 300_000,
    executionBinding: hash(['exact', quote]), authority: value.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_devnet') });
  const record = value.reserve(intent, quote, now); value.claim(record.approvalId, now);
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: f.buyer.publicKey,
    recentBlockhash: f.lifetime.recentBlockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ...f.instructions.slice(1)] }).compileToV0Message());
  transaction.sign([f.buyer]);
  const payload = { x402Version: 2, accepted: quote, payload: { transaction: Buffer.from(transaction.serialize()).toString('base64') } };
  const original = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: record.intent.id, requestId: intent.idempotencyKey,
    monetaryScope: record.monetaryScope, scopeId: monetaryScopeId(record.monetaryScope), executionBinding: intent.executionBinding,
    quoteFingerprint: hash(quote), payloadHash: hash(payload), recordedAt: now, identity: createSignedPaymentIdentity(payload, f.config, undefined, f.lifetime) });
  value.savePayload(record.approvalId, payload, undefined, original); value.markSubmissionAttempt(record.approvalId, undefined, now); value.unknown(record.approvalId); close(value);
  const beforeDb = new DatabaseSync(path), before = beforeDb.prepare('SELECT * FROM original_payments').all(); beforeDb.close();
  const reopened = open(path), after = new DatabaseSync(path);
  try {
    expect(after.prepare('SELECT * FROM original_payments').all()).toEqual(before);
    expect(after.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(indexName)).toBeUndefined();
    expect(reopened.savedPayload(record.approvalId)).toEqual(payload);
    expect(reopened.savedOriginalPayment(record.approvalId)?.state).toBe('OUTCOME_UNKNOWN');
    expect(reopened.managedSummary(now).reserved).toBe(quote.amount);
    reopened.confirmOriginalPayment(record.approvalId, original.identity.knownSignature!, 'confirmed', now);
    expect(reopened.managedSummary(now).paid).toBe(quote.amount);
  } finally { after.close(); }
});
