import type { PaymentRequirements } from '@x402/core/types';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AtomicAmountSchema, MAX_ATOMIC_AMOUNT, atomicAmount, addAtomic } from '../../src/modules/authority/atomic-money';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { monetaryScopeId, PRODUCT_TEST_WALLET_ID } from '../../src/modules/purchases/monetary-scope';
import { storeMonetaryScope } from '../../src/modules/purchases/monetary-migration';

const now = Date.parse('2026-10-05T12:00:00Z');
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function path() { const directory = mkdtempSync(join(tmpdir(), 'yosh-money-')); directories.push(directory); return join(directory, 'ledger.sqlite'); }
function request(amount = '10000', network: PaymentRequirements['network'] = DEVNET_NETWORK, asset = DEVNET_USDC_MINT) {
  const quote = { scheme: 'exact' as const, network, asset, amount, payTo: 'fixture-payee', maxTimeoutSeconds: 300, extra: {} };
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: randomUUID(), requestHash: 'request-hash',
    resourceId: 'fixture-resource', providerId: 'fixture-provider', amount, currency: 'USDC', assetDecimals: 6,
    assetId: asset, network, payTo: quote.payTo, paymentScheme: quote.scheme, quoteFingerprint: 'quote-hash',
    createdAt: now, expiresAt: now + 300_000, executionBinding: 'immutable-binding' });
  return { intent, quote };
}

it('keeps each environment, wallet and asset budget separate while sharing a scope across clients', () => {
  const file = path();
  const a = new PurchaseLedger(file, { managed: true, walletIdentity: 'fixture-wallet-a', mode: 'simulated', now: () => now });
  const same = new PurchaseLedger(file, { managed: true, walletIdentity: 'fixture-wallet-a', mode: 'simulated', now: () => now });
  const b = new PurchaseLedger(file, { managed: true, walletIdentity: 'fixture-wallet-b', mode: 'simulated', now: () => now });
  try {
    a.setDailyLimit('10000', 'simulated'); a.setDailyLimit('50000', 'live_devnet'); b.setDailyLimit('20000');
    const first = request(); a.reserve(first.intent, first.quote, now, 'simulated');
    const second = request(); expect(same.reserve(second.intent, second.quote, now, 'simulated').decision.reason).toBe('DAILY_BUDGET_EXCEEDED');
    const third = request(); expect(b.reserve(third.intent, third.quote, now, 'simulated').status).toBe('APPROVED');
    expect(a.managedSummary(now, 'simulated')).toMatchObject({ reserved: '10000', remaining: '0' });
    expect(a.managedSummary(now, 'live_devnet')).toMatchObject({ reserved: '0', remaining: '50000' });
    expect(a.managedSummary(now, 'live_mainnet')).toMatchObject({ reserved: '0', paid: '0', dailyLimit: null, paused: true });
    const otherAsset = a.scope('simulated', DEVNET_NETWORK, 'fixture-other-mint');
    expect(a.managedSummary(now, 'simulated', otherAsset)).toMatchObject({ reserved: '0', dailyLimit: null });
    expect(() => a.reserve(first.intent, first.quote, now, 'live_mainnet')).toThrow('MAINNET_AUTHORITY_REQUIRED');
    expect(() => same.reserve(first.intent, first.quote, now, 'simulated', undefined, b.scope('simulated'))).toThrow('MONETARY_SCOPE_MISMATCH');
  } finally { a.close(); same.close(); b.close(); }
});

it('stores amounts above JS safe integer exactly and serializes JSON as decimal strings', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'simulated', now: () => now });
  try {
    ledger.setDailyLimit(MAX_ATOMIC_AMOUNT.toString());
    const value = request('9007199254740993');
    const reserved = ledger.reserve(value.intent, value.quote, now);
    expect(reserved.status).toBe('REQUIRES_APPROVAL');
    expect(reserved.intent.amount).toBe('9007199254740993');
    expect(reserved.decision.remainingAfter).toBe('9214364837600034814');
    expect(JSON.parse(JSON.stringify(reserved)).intent.amount).toBe('9007199254740993');
    expect(JSON.parse(JSON.stringify(ledger.controls())).dailyBudget).toBe(MAX_ATOMIC_AMOUNT.toString());
    expect(atomicAmount(AtomicAmountSchema.parse(9007199254740991))).toBe(9007199254740991n);
    expect(AtomicAmountSchema.parse(100n)).toBe('100');
  } finally { ledger.close(); }
});

it('reads Mainnet fixture accounting independently while refusing Mainnet reservations without enforced authority', () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true, mode: 'simulated', now: () => now });
  try {
    ledger.setDailyLimit('100000');
    const production = request('20000', MAINNET_NETWORK, MAINNET_USDC_MINT);
    const db = new DatabaseSync(file);
    const scopeId = storeMonetaryScope(db, ledger.scope('live_mainnet'));
    db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(production.intent.id, production.intent.idempotencyKey, 'fixture-approval',
      JSON.stringify(production.intent), JSON.stringify(production.quote), JSON.stringify({ decision: 'APPROVED', reason: 'FIXTURE_ONLY', committedBefore: '0', remainingAfter: '0' }),
      'PAYMENT_UNKNOWN', '20000', null, 'fixture-mainnet-transaction', null, 'fixture-payload', null, 'live_mainnet', null, scopeId);
    db.prepare("INSERT INTO purchase_delivery (purchase_id,capability,state,receipt_state) VALUES (?,?,?,?)")
      .run(production.intent.id, '{"kind":"none"}', 'NOT_PAID', 'UNAVAILABLE');
    db.close();
    expect(ledger.listForAdministration()[0]).toMatchObject({ monetaryEnvironment: 'live_mainnet', network: MAINNET_NETWORK,
      assetId: MAINNET_USDC_MINT, assetDecimals: 6, currency: 'USDC', providerId: 'fixture-provider' });
    expect(ledger.managedSummary(now, 'live_mainnet')).toMatchObject({ paid: '0', reserved: '20000', unresolved: 1, remaining: null, paused: true });
    expect(ledger.managedSummary(now, 'simulated')).toMatchObject({ reserved: '0', unresolved: 0, remaining: '100000' });
    const test = request(); expect(ledger.reserve(test.intent, test.quote, now).status).toBe('APPROVED');
    expect(ledger.listForAdministration().find(row => row.purchaseId === test.intent.idempotencyKey)).toMatchObject({
      monetaryEnvironment: 'simulated', network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT,
      currency: 'USDC', providerId: 'fixture-provider',
    });
    expect(() => ledger.reserve(production.intent, production.quote, now, 'live_mainnet')).toThrow('MAINNET_AUTHORITY_REQUIRED');
  } finally { ledger.close(); }
});

it('keeps grant commitments and remaining authority separate per environment', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true, requireSpendGrant: true, mode: 'simulated', now: () => now });
  try {
    const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
    const scope = { resourceId: 'fixture-resource', providerId: 'fixture-provider', operation: 'paid.resource.purchase', network: DEVNET_NETWORK,
      assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo: 'fixture-payee', paymentScheme: 'exact' };
    for (const mode of ['simulated', 'live_devnet'] as const) {
      ledger.setDailyLimit('100000', mode);
      ledger.createSpendGrant({ totalLimit: '30000', singleLimit: '20000', expiresAt: now + 3600_000 }, principal, scope, now, mode);
    }
    const simulated = request(); simulated.intent.authority = ledger.spendAuthority(principal, 'paid.resource.purchase', now, 'simulated');
    const stored = ledger.reserve(simulated.intent, simulated.quote, now, 'simulated');
    ledger.claim(stored.approvalId, now); ledger.finish(stored.approvalId, { transaction: 'simulated-fixture', data: {} }, now);
    expect(ledger.spendGrantSummary(now, 'simulated')).toMatchObject({ committed: '10000', remaining: '20000' });
    expect(ledger.spendGrantSummary(now, 'live_devnet')).toMatchObject({ committed: '0', remaining: '30000' });
    const replay = request(); replay.intent.authority = simulated.intent.authority;
    expect(ledger.reserve(replay.intent, replay.quote, now, 'live_devnet').decision.reason).toBe('SPEND_GRANT_MONETARY_SCOPE_MISMATCH');
    expect(ledger.spendGrantSummary(now, 'live_mainnet')).toBeNull();
  } finally { ledger.close(); }
});

it.each(['01', '1.5', '-1', '1e6', '', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid or out-of-range atomic money (%s)', input => {
  expect(() => atomicAmount(input)).toThrow('INVALID_ATOMIC_AMOUNT');
});

it('rejects aggregate overflow before authorization or insertion', () => {
  expect(() => addAtomic(MAX_ATOMIC_AMOUNT, 1n)).toThrow('MONETARY_AGGREGATE_OVERFLOW');
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true, mode: 'simulated', now: () => now });
  try {
    ledger.setDailyLimit(MAX_ATOMIC_AMOUNT.toString());
    const value = request(MAX_ATOMIC_AMOUNT.toString()); ledger.reserve(value.intent, value.quote, now);
    const db = new DatabaseSync(file);
    // Model a pre-existing reservation at the storage bound without granting a payment.
    db.prepare("UPDATE purchases SET status='APPROVED' WHERE id=?").run(value.intent.id); db.close();
    const next = request('1'); expect(() => ledger.reserve(next.intent, next.quote, now)).toThrow('MONETARY_AGGREGATE_OVERFLOW');
    expect(ledger.getForAdministration(next.intent.idempotencyKey)).toBeUndefined();
    expect(ledger.managedSummary(now)).toMatchObject({ reserved: MAX_ATOMIC_AMOUNT.toString(), remaining: '0' });
  } finally { ledger.close(); }
});

it('makes monetary scope and atomic amount immutable in SQLite', () => {
  const file = path(); const ledger = new PurchaseLedger(file, { mode: 'simulated' });
  const value = request(); ledger.reserve(value.intent, value.quote, now); ledger.close();
  const db = new DatabaseSync(file);
  try {
    expect(() => db.prepare('UPDATE purchases SET amount=? WHERE id=?').run('1', value.intent.id)).toThrow('immutable');
    expect(() => db.prepare('UPDATE purchases SET monetary_scope_id=? WHERE id=?').run('other', value.intent.id)).toThrow('immutable');
    expect(() => db.prepare('UPDATE monetary_scopes SET wallet_identity=?').run('another-wallet')).toThrow('immutable');
  } finally { db.close(); }
});

function legacyDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE purchases (id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,approval_id TEXT NOT NULL UNIQUE,
    purchase TEXT NOT NULL,quote TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,amount INTEGER NOT NULL,
    confirmed_day TEXT,transaction_id TEXT,data TEXT,payload TEXT,owner_card_member_id TEXT,execution_mode TEXT,payment_evidence TEXT);`);
  return db;
}
it('migrates PAID, reservation, in-flight and unknown rows without rewriting evidence, IDs or bindings', () => {
  const file = path(); const db = legacyDatabase(file); const values = [request(), request(), request(), request()];
  const originals = values.map(value => JSON.stringify({ ...value.intent, amount: Number(value.intent.amount) }));
  const states = ['PAID', 'APPROVED', 'PAYING', 'PAYMENT_UNKNOWN'];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, `approval-${i}`,
      originals[i], JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: 0, remainingAfter: 100000 }),
      states[i], 10000, i === 0 ? '2026-10-05' : null, `transaction-${i}`, null, i >= 2 ? 'original-payload' : null, null, 'live_devnet', 'original-evidence');
  }
  db.close();
  const first = new PurchaseLedger(file, { mode: 'live_devnet', now: () => now });
  try {
    expect(first.managedSummary(now)).toMatchObject({ paid: '10000', reserved: '30000', unresolved: 2 });
    for (let i = 0; i < values.length; i++) expect(first.getForAdministration(values[i].intent.idempotencyKey)).toMatchObject({ approvalId: `approval-${i}`, status: states[i],
      intent: { amount: '10000', executionBinding: 'immutable-binding' }, monetaryScope: { environment: 'live_devnet' } });
  } finally { first.close(); }
  const check = new DatabaseSync(file);
  expect(check.prepare('SELECT purchase,payload,payment_evidence FROM purchases ORDER BY rowid').all()).toEqual(originals.map((purchase, i) => ({ purchase, payload: i >= 2 ? 'original-payload' : null, payment_evidence: 'original-evidence' })));
  check.close();
  const restarted = new PurchaseLedger(file, { mode: 'live_devnet', now: () => now });
  try { expect(restarted.managedSummary(now)).toMatchObject({ paid: '10000', reserved: '30000', unresolved: 2 }); }
  finally { restarted.close(); }
});

it('rolls back unsafe/unclassifiable legacy data instead of converting it into Mainnet evidence', () => {
  const file = path(); const db = legacyDatabase(file); const value = request('10000', MAINNET_NETWORK, MAINNET_USDC_MINT);
  const raw = JSON.stringify(value.intent);
  db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, 'approval', raw,
    JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: 0, remainingAfter: 0 }), 'PAYMENT_UNKNOWN', 10000, null, 'transaction', null, 'signed-payload', null, 'live_devnet', 'evidence');
  db.close();
  expect(() => new PurchaseLedger(file)).toThrow('MONETARY_MIGRATION_FAILED');
  const check = new DatabaseSync(file);
  expect(check.prepare('SELECT purchase,payload,amount FROM purchases').get()).toEqual({ purchase: raw, payload: 'signed-payload', amount: 10000 });
  expect(check.prepare("SELECT name FROM sqlite_master WHERE name='monetary_scopes'").get()).toBeUndefined(); check.close();
});

it('quarantines legacy unknown-mode reservations and never assigns them Mainnet authority', () => {
  const file = path(); const db = legacyDatabase(file); const value = request();
  db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, 'approval', JSON.stringify(value.intent),
    JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: 0, remainingAfter: 0 }), 'PAYMENT_UNKNOWN', 10000, null, null, null, 'payload', null, null, null);
  db.close(); const ledger = new PurchaseLedger(file, { walletIdentity: PRODUCT_TEST_WALLET_ID });
  try {
    const saved = ledger.getForAdministration(value.intent.idempotencyKey)!;
    expect(saved.executionMode).toBe('UNKNOWN'); expect(saved.monetaryScope.environment).toBe('legacy_test');
    expect(ledger.managedSummary(now, 'UNKNOWN')).toMatchObject({ reserved: '10000', unresolved: 1 });
    expect(ledger.managedSummary(now, 'live_mainnet')).toMatchObject({ reserved: '0', dailyLimit: null });
    const next = request(); expect(() => ledger.reserve(next.intent, next.quote, now, 'live_devnet')).toThrow('LEGACY_MONETARY_SCOPE_UNRESOLVED');
    expect(monetaryScopeId(saved.monetaryScope)).not.toBe(monetaryScopeId(ledger.scope('live_mainnet')));
  } finally { ledger.close(); }
});

it.each([false, true])('preserves historical grant consumption through migration/restart, including mixed test environments (%s)', mixed => {
  const file = path(); const db = legacyDatabase(file);
  const member = randomUUID(); const connection = randomUUID(); const grantId = randomUUID();
  db.exec(`CREATE TABLE spend_grants (id TEXT PRIMARY KEY,version INTEGER NOT NULL UNIQUE,connection_id TEXT NOT NULL,connection_generation INTEGER NOT NULL,
    resource_id TEXT NOT NULL,provider_id TEXT NOT NULL,operation TEXT NOT NULL,network TEXT NOT NULL,asset_id TEXT NOT NULL,asset_decimals INTEGER NOT NULL,
    pay_to TEXT NOT NULL,payment_scheme TEXT NOT NULL,total_limit INTEGER NOT NULL,single_limit INTEGER NOT NULL,status TEXT NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,card_member_id TEXT);`);
  db.prepare('INSERT INTO spend_grants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(grantId, 1, connection, 1, 'fixture-resource', 'fixture-provider',
    'paid.resource.purchase', DEVNET_NETWORK, DEVNET_USDC_MINT, 6, 'fixture-payee', 'exact', 30000, 20000, 'ACTIVE', now, now + 3600_000, null, member);
  const binding = { cardMemberId: member, connectionId: connection, connectionGeneration: 1, grantId, grantVersion: 1, operation: 'paid.resource.purchase' };
  for (const status of ['PAID', 'PAYMENT_UNKNOWN']) {
    const value = request(); value.intent.authority = binding;
    db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, randomUUID(), JSON.stringify(value.intent),
      JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: 0, remainingAfter: 0 }), status, 10000,
      status === 'PAID' ? '2026-10-05' : null, 'transaction', null, 'payload', member, mixed && status === 'PAID' ? 'simulated' : 'live_devnet', null);
  }
  db.close();
  for (let restart = 0; restart < 2; restart++) {
    const ledger = new PurchaseLedger(file, { managed: true, requireSpendGrant: true, defaultCardMemberId: member, mode: mixed ? 'UNKNOWN' : 'live_devnet', now: () => now });
    try {
      expect(ledger.spendGrantSummary(now, mixed ? undefined : 'live_devnet', member)).toMatchObject({ id: grantId, status: 'ACTIVE', committed: '20000', remaining: '10000', totalLimit: '30000' });
      expect(ledger.spendGrantSummary(now, 'simulated', member)).toBeNull();
      if (mixed) expect(ledger.spendGrantSummary(now, 'live_devnet', member)).toBeNull();
      expect(ledger.managedSummary(now, 'live_devnet')).toMatchObject({ paid: mixed ? '0' : '10000', reserved: '10000', unresolved: 1 });
    } finally { ledger.close(); }
  }
});

it('accounts for grant commitments above the JS safe integer without rounding', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true, requireSpendGrant: true, mode: 'simulated', now: () => now });
  try {
    ledger.setDailyLimit(MAX_ATOMIC_AMOUNT.toString());
    const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
    ledger.createSpendGrant({ totalLimit: '9007199254740994', singleLimit: '9007199254740993', expiresAt: now + 3600_000 }, principal,
      { resourceId: 'fixture-resource', providerId: 'fixture-provider', operation: 'paid.resource.purchase', network: DEVNET_NETWORK,
        assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo: 'fixture-payee', paymentScheme: 'exact' }, now);
    const value = request('9007199254740993'); value.intent.authority = ledger.spendAuthority(principal, 'paid.resource.purchase', now);
    const reserved = ledger.reserve(value.intent, value.quote, now);
    expect(reserved.status).toBe('APPROVED');
    ledger.claim(reserved.approvalId, now); ledger.finish(reserved.approvalId, { transaction: 'simulated-fixture', data: {} }, now);
    expect(ledger.spendGrantSummary(now)).toMatchObject({ committed: '9007199254740993', remaining: '1' });
    expect(ledger.managedSummary(now)).toMatchObject({ paid: '9007199254740993', reserved: '0' });
  } finally { ledger.close(); }
});

it.each([1.5, 9007199254740992])('refuses unsafe legacy JSON amounts without losing the unresolved row (%s)', amount => {
  const file = path(); const db = legacyDatabase(file); const value = request();
  const raw = JSON.stringify({ ...value.intent, amount });
  db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, 'approval', raw,
    JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: 0, remainingAfter: 0 }),
    'PAYMENT_UNKNOWN', amount, null, 'transaction', null, 'original-payload', null, 'live_devnet', null);
  db.close();
  expect(() => new PurchaseLedger(file)).toThrow('MONETARY_MIGRATION_FAILED');
  const check = new DatabaseSync(file);
  expect(check.prepare('SELECT purchase,payload,status FROM purchases').get()).toEqual({ purchase: raw, payload: 'original-payload', status: 'PAYMENT_UNKNOWN' });
  check.close();
});

it('migrates exact SQLite integer values above JS safe integer via TEXT reads', () => {
  const file = path(); const db = legacyDatabase(file); const value = request('9007199254740993');
  db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.intent.id, value.intent.idempotencyKey, 'approval', JSON.stringify(value.intent),
    JSON.stringify(value.quote), JSON.stringify({ decision: 'APPROVED', reason: 'OLD', committedBefore: '0', remainingAfter: '0' }),
    'PAYMENT_UNKNOWN', 9007199254740993n, null, 'transaction', null, 'original-payload', null, 'live_devnet', null);
  db.close(); const ledger = new PurchaseLedger(file, { mode: 'live_devnet' });
  try { expect(ledger.managedSummary(now)).toMatchObject({ reserved: '9007199254740993' }); }
  finally { ledger.close(); }
});
