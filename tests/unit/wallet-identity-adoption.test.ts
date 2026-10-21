import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { monetaryScopeId, PRODUCT_MAINNET_WALLET_ID, PRODUCT_TEST_WALLET_ID } from '../../src/modules/purchases/monetary-scope';
import { storeMonetaryScope } from '../../src/modules/purchases/monetary-migration';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { hash } from '../../src/modules/purchases/spending-policy';
import { signedPaymentFixture } from '../helpers/signed-payment-fixture';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function path() { const directory = mkdtempSync(join(tmpdir(), 'yosh-wallet-adoption-')); directories.push(directory); return join(directory, 'ledger.sqlite'); }
function inventory(mainnet: string | null, devnet: string | null) {
  return [{ id: 'mainnet', label: 'Mainnet', address: mainnet, status: mainnet ? 'available' as const : 'missing' as const },
    { id: 'devnet', label: 'Devnet · Test', address: devnet, status: devnet ? 'available' as const : 'missing' as const }];
}
let fixtureSeed = 0;
function fixtureKeypair() { return Keypair.fromSeed(new Uint8Array(32).fill(++fixtureSeed)); }
function key() { return fixtureKeypair().publicKey.toBase58(); }

it('adopts both existing public identities once without changing their legacy monetary identities', () => {
  const file = path(); const mainnet = key(); const test = key();
  let ledger = new PurchaseLedger(file, { managed: true });
  const first = ledger.walletAccounts.observe(inventory(mainnet, test));
  expect(first.map(entry => entry.provisioningState)).toEqual(['existing', 'existing']);
  const pins = [ledger.walletAccounts.get('mainnet'), ledger.walletAccounts.get('devnet')];
  expect(pins[0]).toMatchObject({ publicKey: mainnet, legacyWalletIdentity: PRODUCT_MAINNET_WALLET_ID,
    credentialRef: { service: 'com.yosh.wallet.mainnet.v1', account: 'consumer-wallet-mainnet-v1', accessBackend: 'legacy-security' } });
  expect(pins[1]).toMatchObject({ publicKey: test, legacyWalletIdentity: PRODUCT_TEST_WALLET_ID,
    credentialRef: { service: 'com.2049.wallet.v1', account: 'consumer-wallet-v1', accessBackend: 'legacy-security' } });
  ledger.close();
  ledger = new PurchaseLedger(file, { managed: true });
  expect(ledger.walletAccounts.observe(inventory(mainnet, test))).toEqual(first);
  expect([ledger.walletAccounts.get('mainnet'), ledger.walletAccounts.get('devnet')]).toEqual(pins);
  expect(ledger.scope('live_mainnet').walletIdentity).toBe(PRODUCT_MAINNET_WALLET_ID);
  ledger.close();
});

it('rejects a changed key at the same slot across ledger connections and restarts', () => {
  const file = path(); const mainnet = key(); const test = key();
  const first = new PurchaseLedger(file, { managed: true });
  first.walletAccounts.observe(inventory(mainnet, test));
  const second = new PurchaseLedger(file, { managed: true });
  const different = key();
  expect(second.walletAccounts.observe(inventory(different, test))[0].provisioningState).toBe('identity_conflict');
  expect(second.walletAccounts.observe(inventory(different, test))[0]).toMatchObject({ status: 'unavailable', address: null });
  expect(() => second.walletAccounts.assertIdentity('mainnet', different)).toThrow('WALLET_IDENTITY_CONFLICT');
  first.close(); second.close();
  const restarted = new PurchaseLedger(file, { managed: true });
  expect(restarted.walletAccounts.get('mainnet')?.publicKey).toBe(mainnet);
  expect(restarted.walletAccounts.observe(inventory(null, test))[0].provisioningState).toBe('restore_required');
  restarted.close();
});

it('keeps truly fresh missing wallets unconfigured despite empty initialized scope/default controls', () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true });
  ledger.setPaused(true, 'live_mainnet');
  expect(ledger.walletAccounts.observe(inventory(null, null)).map(entry => entry.provisioningState)).toEqual(['absent_fresh', 'absent_fresh']);
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined();
  expect(ledger.walletAccounts.get('devnet')).toBeUndefined();
  const db = new DatabaseSync(file);
  expect(db.prepare('SELECT count(*) AS n FROM wallet_accounts').get()?.n).toBe(0);
  db.close(); ledger.close();
});

it('requires restoration when a missing wallet has an assertion or historical financial relationship', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true });
  expect(ledger.walletAccounts.observe(inventory(null, null), { mainnetAssertion: key() })[0].provisioningState).toBe('restore_required');
  ledger.setDailyLimit('1', 'live_mainnet');
  expect(ledger.walletAccounts.observe(inventory(null, null))[0].provisioningState).toBe('restore_required');
  ledger.close();
});

it('distinguishes missing, denied and corrupt items without adopting them or broadening isolation', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true });
  const [mainnet, devnet] = inventory(key(), null);
  for (const failure of ['corrupt', 'access_denied_or_locked'] as const) {
    const observed = ledger.walletAccounts.observe([mainnet, { ...devnet, status: 'unavailable', failure }]);
    expect(observed[0].provisioningState).toBe('isolation_unverified');
    expect(observed[0]).toMatchObject({ status: 'unavailable', address: null });
    expect(observed[1].provisioningState).toBe(failure);
    expect(ledger.walletAccounts.get('mainnet')).toBeUndefined();
  }
  const same = key();
  expect(ledger.walletAccounts.observe(inventory(same, same)).map(entry => entry.provisioningState)).toEqual(['identity_conflict', 'identity_conflict']);
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined();
  ledger.close();
});

it('rejects assertion mismatches while allowing unchanged legacy identities with budget-only history', () => {
  const file = path(); const mainnet = key(); const test = key(); const ledger = new PurchaseLedger(file, { managed: true });
  ledger.setDailyLimit('234', 'live_mainnet');
  const before = ledger.controls('live_mainnet');
  expect(ledger.walletAccounts.observe(inventory(mainnet, test), { mainnetAssertion: key() })[0].provisioningState).toBe('identity_conflict');
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined();
  expect(ledger.walletAccounts.observe(inventory(mainnet, test), { mainnetAssertion: mainnet })[0].provisioningState).toBe('existing');
  expect(ledger.controls('live_mainnet')).toEqual(before);
  const db = new DatabaseSync(file);
  expect(db.prepare('SELECT scope_id,daily_limit FROM monetary_controls WHERE scope_id=?').get(monetaryScopeId(ledger.scope('live_mainnet'))))
    .toMatchObject({ daily_limit: '234' });
  expect(() => db.prepare("UPDATE wallet_accounts SET public_key=? WHERE slot='mainnet'").run(key())).toThrow('immutable');
  expect(() => db.prepare("DELETE FROM wallet_accounts WHERE slot='mainnet'").run()).toThrow('immutable');
  db.close(); ledger.close();
});

it('counts historical purchases and grants as relationships even without an active daily limit', () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true }); const db = new DatabaseSync(file);
  const scope = storeMonetaryScope(db, ledger.scope('live_mainnet'));
  const member = ledger.defaultCardMember().id;
  db.prepare(`INSERT INTO spend_grants (id,version,connection_id,connection_generation,resource_id,provider_id,operation,network,asset_id,asset_decimals,
    pay_to,payment_scheme,total_limit,single_limit,status,created_at,expires_at,revoked_at,card_member_id,monetary_scope_id)
    VALUES ('fixture-grant',1,'fixture-connection',1,'fixture-resource','fixture-provider','paid.resource.purchase',?,?,6,?,'exact','10','10','REVOKED',1,2,2,?,?)`)
    .run(ledger.scope('live_mainnet').network, ledger.scope('live_mainnet').assetId, key(), member, scope);
  expect(ledger.walletAccounts.observe(inventory(null, null))[0].provisioningState).toBe('restore_required');
  db.close(); ledger.close();
});

async function originalPurchase(file: string, ledger: PurchaseLedger) {
  const signer = await createKeyPairSignerFromBytes(fixtureKeypair().secretKey); const recipient = key(); const sponsor = key();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const config = { ...environment, mint: environment.asset.mint, buyer: signer.address, merchant: recipient,
    facilitatorUrl: null, registeredResources: [] };
  const quote = { scheme: 'exact', network: environment.network, asset: config.mint, amount: '10', payTo: recipient,
    maxTimeoutSeconds: 300, extra: { feePayer: sponsor } };
  const payload = await signedPaymentFixture(signer, config, quote);
  const now = Date.now(); const id = crypto.randomUUID(); const approval = crypto.randomUUID();
  const intent = SpendIntentSchema.parse({ id, idempotencyKey: crypto.randomUUID(), requestHash: hash(id),
    resourceId: 'fixture-resource', providerId: 'fixture-provider', amount: '10', currency: 'USDC', assetDecimals: 6,
    assetId: config.mint, network: environment.network, payTo: recipient, paymentScheme: 'exact', quoteFingerprint: hash(quote),
    createdAt: now, expiresAt: now + 300_000, executionBinding: hash(['fixture-binding', signer.address]) });
  const scope = ledger.scope('live_mainnet');
  const original = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: id, requestId: intent.idempotencyKey,
    monetaryScope: scope, scopeId: monetaryScopeId(scope), executionBinding: intent.executionBinding,
    quoteFingerprint: intent.quoteFingerprint, payloadHash: hash(payload), recordedAt: now,
    identity: createSignedPaymentIdentity(payload, config) });
  const db = new DatabaseSync(file); storeMonetaryScope(db, scope);
  db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, intent.idempotencyKey, approval,
    JSON.stringify(intent), JSON.stringify(quote), JSON.stringify({ decision: 'APPROVED', reason: 'FIXTURE_ONLY', committedBefore: '0', remainingAfter: '0' }),
    'PAYMENT_UNKNOWN', '10', null, null, null, JSON.stringify(payload), null, 'live_mainnet', null, monetaryScopeId(scope));
  db.prepare('INSERT INTO original_payments VALUES (?,?,?,?,?)').run(id, JSON.stringify(original), 'OUTCOME_UNKNOWN', now, null);
  db.prepare("INSERT INTO purchase_delivery (purchase_id,capability,state,receipt_state,retry_count,next_attempt_at,last_error) VALUES (?,?,?, ?,?,?,?)")
    .run(id, '{"kind":"idempotent_replay"}', 'NOT_PAID', 'UNAVAILABLE', 2, now + 1000, 'FIXTURE_RETRY_STATE');
  db.close();
  return { payer: signer.address, approval, id };
}

it('pins only the payer proven by stored original signatures and retains every financial/recovery byte', async () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true });
  const original = await originalPurchase(file, ledger); const test = key();
  ledger.setDailyLimit('100', 'live_mainnet');
  const record = ledger.getForAdministration(ledger.savedOriginalPayment(original.approval)!.evidence.requestId)!;
  ledger.createSpendGrant({ totalLimit: '100', singleLimit: '10', expiresAt: Date.now() + 3600_000 },
    { cardMemberId: ledger.defaultCardMember().id, connectionId: crypto.randomUUID(), connectionGeneration: 1 },
    { resourceId: record.intent.resourceId, providerId: record.intent.providerId, operation: 'paid.resource.purchase',
      network: record.intent.network, assetId: record.intent.assetId, assetDecimals: 6, payTo: record.intent.payTo, paymentScheme: 'exact' },
    undefined, 'live_mainnet');
  const reconciliation = ledger.reconciliation.claim(original.id)!;
  ledger.reconciliation.finish(reconciliation, 'UNKNOWN');
  const db = new DatabaseSync(file);
  function financialSnapshot() {
    const tables = ['monetary_scopes', 'monetary_controls', 'monetary_budget_clock', 'spend_grants', 'spend_grant_events',
      'purchases', 'purchase_events', 'purchase_answers', 'purchase_delivery', 'original_payments', 'original_payment_signatures', 'payment_reconciliation'];
    return tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }
  const before = financialSnapshot();
  expect(ledger.walletAccounts.observe(inventory(key(), test))[0].provisioningState).toBe('identity_conflict');
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined();
  expect(ledger.walletAccounts.observe(inventory(original.payer, test))[0].provisioningState).toBe('existing');
  expect(financialSnapshot()).toEqual(before);
  expect(ledger.savedOriginalPayment(original.approval)?.state).toBe('OUTCOME_UNKNOWN');
  db.close(); ledger.close();
  const restarted = new PurchaseLedger(file, { managed: true });
  expect(restarted.walletAccounts.observe(inventory(null, test))[0].provisioningState).toBe('restore_required');
  expect(restarted.savedOriginalPayment(original.approval)?.evidence.identity.payer).toBe(original.payer);
  restarted.close();
});

it('converges repeated observations from independent ledger connections onto a single permanent mapping', async () => {
  const file = path(); const mainnet = key(); const test = key();
  const first = new PurchaseLedger(file, { managed: true }); const second = new PurchaseLedger(file, { managed: true });
  const observations = await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() =>
    (index % 2 ? first : second).walletAccounts.observe(inventory(mainnet, test)))));
  expect(observations.every(observed => JSON.stringify(observed) === JSON.stringify(observations[0]))).toBe(true);
  const db = new DatabaseSync(file);
  expect(db.prepare('SELECT count(*) AS n FROM wallet_accounts').get()?.n).toBe(2);
  expect(db.prepare("SELECT count(*) AS n FROM ledger_schema_migrations WHERE id='017_wallet_account_identity'").get()?.n).toBe(1);
  db.close(); first.close(); second.close();
});

it('refuses adoption when a legacy monetary scope contains two different verified payers', async () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true });
  const first = await originalPurchase(file, ledger); const second = await originalPurchase(file, ledger);
  for (const payer of [first.payer, second.payer]) {
    expect(ledger.walletAccounts.observe(inventory(payer, key()))[0].provisioningState).toBe('identity_conflict');
  }
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined(); ledger.close();
});

it('does not silently discard malformed historical payer evidence and adopt a new key', async () => {
  const file = path(); const ledger = new PurchaseLedger(file, { managed: true });
  const original = await originalPurchase(file, ledger); const db = new DatabaseSync(file);
  // A pre-evidence-migration row with malformed confirmation must fail closed.
  db.prepare('DELETE FROM original_payments WHERE purchase_id=?').run(original.id);
  db.prepare('UPDATE purchases SET payment_evidence=? WHERE id=?').run('{"version":2,"payer":"corrupt"}', original.id);
  db.close();
  expect(ledger.walletAccounts.observe(inventory(key(), key()))[0].provisioningState).toBe('identity_conflict');
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined(); ledger.close();
});

it('still adopts an independently readable Test wallet when Mainnet access is denied', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true }); const test = key();
  const observed = ledger.walletAccounts.observe([{ id: 'mainnet', label: 'Mainnet', address: null, status: 'unavailable', failure: 'access_denied_or_locked' },
    { id: 'devnet', label: 'Devnet · Test', address: test, status: 'available' }]);
  expect(observed.map(entry => entry.provisioningState)).toEqual(['access_denied_or_locked', 'existing']);
  expect(ledger.walletAccounts.get('devnet')?.publicKey).toBe(test);
  expect(ledger.walletAccounts.get('mainnet')).toBeUndefined(); ledger.close();
});
