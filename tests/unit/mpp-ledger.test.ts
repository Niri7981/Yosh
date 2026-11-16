import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendGrantScopeSchema, type SpendAuthorityBinding } from '../../src/modules/authority/spend-grant';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { MppChargeQuoteSchema } from '../../src/modules/payment/mpp-contract';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { monetaryScopeId } from '../../src/modules/purchases/monetary-scope';
import { hash } from '../../src/modules/purchases/spending-policy';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';
import { mppFixture } from '../helpers/mpp-fixture';

// Isolated ledger fixtures only: no SDK process, wallet, RPC or merchant calls.
const now = Date.parse('2026-11-15T12:00:00Z');
const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111', connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
const payTo = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
const paths: string[] = [];
afterEach(() => paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function temporaryLedger() { const path = mkdtempSync(join(tmpdir(), 'yosh-mpp-ledger-')); paths.push(path); return join(path, 'ledger.sqlite'); }
function ledger(path = ':memory:') {
  return new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true,
    now: () => now, defaultCardMemberId: principal.cardMemberId });
}
function quote(amount = '200000') {
  const expiresAt = now + 300_000;
  const request = Buffer.from(JSON.stringify({ amount, currency: DEVNET_USDC_MINT, recipient: payTo,
    methodDetails: { network: 'devnet', decimals: 6, tokenProgram: TOKEN_PROGRAM } })).toString('base64url');
  return MppChargeQuoteSchema.parse({ protocol: 'mpp', method: 'solana', intent: 'charge', scheme: 'mpp_charge',
    network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, payTo, amount, expiresAt,
    challenge: { id: 'offline-ledger-fixture', realm: 'merchant.example', method: 'solana', intent: 'charge', request,
      expires: new Date(expiresAt).toISOString() }, challengeHeader: 'Payment fixture=offline-ledger' });
}
function x402Quote(): PaymentRequirements { return { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT,
  payTo, amount: '200000', maxTimeoutSeconds: 300, extra: {} }; }
function grant(value: PurchaseLedger, resourceId: string, paymentScheme: string): SpendAuthorityBinding {
  value.createSpendGrant({ totalLimit: '1000000', singleLimit: '500000', expiresAt: now + 3_600_000 }, principal,
    { resourceId, providerId: 'fixture-provider', operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo, paymentScheme,
      ...(paymentScheme === 'mpp_charge' ? { maximumNetworkFeeLamports: '10001' } : {}) }, now, 'live_devnet');
  return value.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_devnet');
}
function intent(id: string, resourceId: string, authority: SpendAuthorityBinding, mpp = true, amount = '200000') {
  const offered = mpp ? quote(amount) : x402Quote();
  return SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: id, requestHash: hash(id), resourceId,
    providerId: 'fixture-provider', network: offered.network, assetId: offered.asset, assetDecimals: 6, amount,
    currency: 'USDC', payTo, paymentScheme: offered.scheme, quoteFingerprint: hash(offered), createdAt: now,
    expiresAt: now + 300_000, executionBinding: hash([id, offered]), authority,
    ...(mpp ? { mpp: offered, httpRequest: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' } } : {}) });
}

it('requires explicit mpp_charge consent and never widens an existing exact Grant', () => {
  const value = ledger();
  try {
    value.setDailyLimit('1000000');
    const exact = grant(value, 'same-resource', 'exact');
    const denied = value.reserve(intent('mpp-with-exact', 'same-resource', exact), quote(), now);
    expect(denied.decision.reason).toBe('SPEND_GRANT_SCOPE_MISMATCH');
    const allowed = grant(value, 'same-resource', 'mpp_charge');
    expect(value.reserve(intent('mpp-with-mpp', 'same-resource', allowed), quote(), now).status).toBe('APPROVED');
    expect(value.reserve(intent('x402-with-mpp', 'same-resource', allowed, false), x402Quote(), now).decision.reason).toBe('SPEND_GRANT_SCOPE_MISMATCH');
    expect(value.spendGrantById(exact.grantId)?.paymentScheme).toBe('exact');
  } finally { value.close(); }
});

it.each([true, false])('shares one atomic monetary budget across protocols, MPP first: %s', mppFirst => {
  const path = temporaryLedger(), first = ledger(path), second = ledger(path);
  try {
    first.setDailyLimit('300000');
    const mpp = grant(first, 'mpp-resource', 'mpp_charge'), x402 = grant(first, 'x402-resource', 'exact');
    const a = first.reserve(intent('first', mppFirst ? 'mpp-resource' : 'x402-resource', mppFirst ? mpp : x402, mppFirst), mppFirst ? quote() : x402Quote(), now);
    const b = second.reserve(intent('second', mppFirst ? 'x402-resource' : 'mpp-resource', mppFirst ? x402 : mpp, !mppFirst), mppFirst ? x402Quote() : quote(), now);
    expect(a.status).toBe('APPROVED'); expect(b.decision.reason).toBe('DAILY_BUDGET_EXCEEDED');
    expect(monetaryScopeId(a.monetaryScope)).toBe(monetaryScopeId(b.monetaryScope));
    expect(second.managedSummary(now, 'live_devnet')).toMatchObject({ reserved: '200000', remaining: '100000' });
  } finally { first.close(); second.close(); }
});

it('preserves immutable MPP and legacy x402 bytes across restart and idempotent replay', () => {
  const path = temporaryLedger(); let value = ledger(path);
  try {
    value.setDailyLimit('1000000');
    const mpp = grant(value, 'mpp-resource', 'mpp_charge'), x402 = grant(value, 'x402-resource', 'exact');
    const original = intent('durable-mpp', 'mpp-resource', mpp), legacy = intent('durable-x402', 'x402-resource', x402, false);
    const saved = value.reserve(original, quote(), now);
    value.reserve(legacy, x402Quote(), now);
    const db = new DatabaseSync(path); const before = db.prepare('SELECT purchase,quote FROM purchases ORDER BY task_id').all(); db.close();
    value.close(); value = ledger(path);
    expect(value.reserve({ ...original, id: randomUUID() }, quote(), now).approvalId).toBe(saved.approvalId);
    expect(value.getOwned('durable-x402', principal.cardMemberId)?.intent.mpp).toBeUndefined();
    const read = new DatabaseSync(path); expect(read.prepare('SELECT purchase,quote FROM purchases ORDER BY task_id').all()).toEqual(before); read.close();
    expect(value.managedSummary(now, 'live_devnet').reserved).toBe('400000');
    expect(() => value.savedPayload(saved.approvalId)).toThrow('MPP_PAYMENT_REQUIRES_PROTOCOL_API');
    expect(value.savedMppPayment(saved.approvalId)).toBeUndefined();
    expect(() => value.reserve({ ...legacy, idempotencyKey: original.idempotencyKey,
      requestHash: original.requestHash, executionBinding: original.executionBinding }, x402Quote(), now)).toThrow('PURCHASE_PROTOCOL_MISMATCH');
  } finally { value.close(); }
});

it('rejects mutated quote terms and mixed protocol bindings before reservation', () => {
  const value = ledger();
  try {
    value.setDailyLimit('1000000'); const binding = grant(value, 'mpp-resource', 'mpp_charge');
    const original = intent('bad-binding', 'mpp-resource', binding);
    expect(() => value.reserve(original, quote('100000'), now)).toThrow('MPP_QUOTE_BINDING_MISMATCH');
    expect(() => SpendIntentSchema.parse({ ...original, paymentRequiredHeader: 'x402-header' })).toThrow('INVALID_MPP_BINDING');
    expect(() => SpendIntentSchema.parse({ ...original, mpp: undefined })).toThrow();
    expect(() => SpendIntentSchema.parse({ ...original, httpRequest: undefined })).toThrow('INVALID_MPP_BINDING');
    expect(value.listForAdministration()).toHaveLength(0);
  } finally { value.close(); }
});

it('rechecks Pause and the original Grant before MPP claim and signing', () => {
  const value = ledger();
  try {
    value.setDailyLimit('1000000'); const binding = grant(value, 'mpp-resource', 'mpp_charge');
    const reserved = value.reserve(intent('mpp-pause', 'mpp-resource', binding), quote(), now);
    value.setPaused(true); expect(() => value.claim(reserved.approvalId, now)).toThrow('paused');
    value.setPaused(false); value.claim(reserved.approvalId, now);
    value.revokeActiveSpendGrant(now + 1, 'grant.REVOKED', principal.cardMemberId, 'mpp-resource');
    expect(() => value.assertCanSign(reserved.approvalId, now + 1)).toThrow('inactive or expired');
    expect(() => value.claim(reserved.approvalId, now + 1)).toThrow();
  } finally { value.close(); }
});

it('adds immutable fee consent without changing legacy grant/scope rows or creating it on x402-only startup', () => {
  const path = temporaryLedger(); let value = ledger(path);
  try {
    const exact = grant(value, 'x402-resource', 'exact');
    const before = new DatabaseSync(path);
    expect(before.prepare("SELECT 1 FROM sqlite_schema WHERE name='mpp_grant_terms'").get()).toBeUndefined();
    const originalGrant = before.prepare('SELECT * FROM spend_grants WHERE id=?').get(exact.grantId);
    const originalScopes = before.prepare('SELECT * FROM monetary_scopes ORDER BY id').all();
    before.close();
    const mpp = grant(value, 'mpp-resource', 'mpp_charge');
    expect(value.spendGrantById(mpp.grantId)?.maximumNetworkFeeLamports).toBe('10001');
    value.close(); value = ledger(path);
    expect(value.spendGrantById(mpp.grantId)?.maximumNetworkFeeLamports).toBe('10001');
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare('SELECT * FROM spend_grants WHERE id=?').get(exact.grantId)).toEqual(originalGrant);
      expect(after.prepare('SELECT * FROM monetary_scopes ORDER BY id').all()).toEqual(originalScopes);
      expect(() => after.prepare('UPDATE mpp_grant_terms SET maximum_network_fee_lamports=? WHERE grant_id=?').run('20000', mpp.grantId)).toThrow('immutable');
      expect(() => after.prepare('DELETE FROM mpp_grant_terms WHERE grant_id=?').run(mpp.grantId)).toThrow('history');
    } finally { after.close(); }
    const scope = { resourceId: 'mpp', providerId: 'fixture', operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo, paymentScheme: 'mpp_charge' };
    expect(() => SpendGrantScopeSchema.parse(scope)).toThrow('MPP_NETWORK_FEE_CONSENT_REQUIRED');
    expect(() => SpendGrantScopeSchema.parse({ ...scope, maximumNetworkFeeLamports: '0' })).toThrow();
    expect(() => SpendGrantScopeSchema.parse({ ...scope, paymentScheme: 'exact', maximumNetworkFeeLamports: '10001' })).toThrow('MPP_NETWORK_FEE_CONSENT_REQUIRED');
  } finally { value.close(); }
});

it('keeps newly added fee consent inside the active writer fence and MPP claims inside external execution authority', () => {
  const path = temporaryLedger(), value = ledger(path);
  try {
    value.executionSafety.enable(now);
    value.setDailyLimit('1000000'); const binding = grant(value, 'mpp-resource', 'mpp_charge');
    const request = intent('external-mpp', 'mpp-resource', binding);
    expect(() => value.reserve(request, quote(), now)).toThrow('MPP_EXTERNAL_PROVENANCE_REQUIRED');
    const external = { callerId: principal.cardMemberId, operationId: 'external-mpp', attemptId: randomUUID(),
      factsHash: hash(['mpp', request]), quoteHash: hash(quote()), requestHash: hash({ method: 'GET',
        url: 'https://merchant.example/data', headers: [], body: null }) };
    const record = value.reserve(request, quote(), now, 'live_devnet', principal.cardMemberId, undefined, external);
    expect(value.executionSafety.provenance(record.intent.id)?.origin).toBe('external_pay');
    expect(() => value.claim(record.approvalId, now)).toThrow('EXTERNAL_EXECUTION_FENCED');
    const permit = value.executionSafety.permit(record);
    expect(value.claim(record.approvalId, now, undefined, 'live_devnet', permit).status).toBe('PAYING');
    const stale = new DatabaseSync(path);
    try {
      expect(() => stale.prepare('INSERT INTO mpp_grant_terms VALUES (?,?)').run(randomUUID(), '10001')).toThrow();
    } finally { stale.close(); }
    expect(value.spendGrantById(binding.grantId)?.maximumNetworkFeeLamports).toBe('10001');
  } finally { value.close(); }
});

it.each(['transaction ID', 'explorer URL'])('retains submitted MPP evidence across restart, rejects credentials and delivers a public %s', publicReference => {
  const f = mppFixture(), path = temporaryLedger(); let value = ledger(path);
  try {
    value.setDailyLimit('1000000');
    value.createSpendGrant({ totalLimit: '1000000', singleLimit: '500000', expiresAt: now + 3_600_000 }, principal,
      { resourceId: 'mpp-resource', providerId: 'fixture-provider', operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: f.config.network, assetId: f.config.mint, assetDecimals: 6, payTo: f.config.merchant,
        paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: '10001' }, now, 'live_devnet');
    const binding = value.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_devnet');
    const request = SpendIntentSchema.parse({ ...intent('original-mpp', 'mpp-resource', binding), amount: f.quote.amount,
      payTo: f.quote.payTo, mpp: f.quote, quoteFingerprint: hash(f.quote), expiresAt: f.quote.expiresAt });
    const record = value.reserve(request, f.quote, now);
    value.claim(record.approvalId, now);
    const original = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: record.intent.id,
      requestId: record.intent.idempotencyKey, monetaryScope: record.monetaryScope, scopeId: monetaryScopeId(record.monetaryScope),
      executionBinding: request.executionBinding, quoteFingerprint: request.quoteFingerprint, payloadHash: hash(f.payment),
      recordedAt: now, identity: f.identity });
    expect(() => value.savePayload(record.approvalId, f.payment)).toThrow('MPP_ORIGINAL_PAYMENT_REQUIRED');
    expect(value.savedMppPayment(record.approvalId)).toBeUndefined();
    value.savePayload(record.approvalId, f.payment, undefined, original);
    value.markSubmissionAttempt(record.approvalId, undefined, now);
    value.unknown(record.approvalId);
    value.close(); value = ledger(path); value.recoverUnsubmittedOnStartup();
    expect(value.savedMppPayment(record.approvalId)).toEqual(f.payment);
    expect(value.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original);
    expect(value.getOwned('original-mpp', principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
    expect(value.managedSummary(now).reserved).toBe(f.quote.amount);
    expect(() => value.claim(record.approvalId, now)).toThrow();
    expect(() => value.markSubmissionAttempt(record.approvalId, undefined, now)).toThrow();
    value.confirmOriginalPayment(record.approvalId, f.signature, 'confirmed', now);
    value.confirmOriginalPayment(record.approvalId, f.signature, 'confirmed', now);
    expect(value.eventsForOwner('original-mpp', principal.cardMemberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
    const delivery = value.claimDelivery(record.approvalId, 'initial', undefined, now)!;
    for (const data of [{ credential: f.payment.credential }, { headers: { Authorization: f.payment.credential } },
      { encoded: f.payment.credential.slice(8) }, { wire: f.payment.transaction },
      { payment: JSON.stringify(f.payment) }, { encodedPayment: Buffer.from(JSON.stringify(f.payment)).toString('base64') }]) {
      expect(() => value.finish(record.approvalId, { transaction: f.signature, data }, now, delivery))
        .toThrow('PAY_CREDENTIAL_REFLECTION_REJECTED');
      expect(value.getOwned('original-mpp', principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'DELIVERING' });
    }
    const data = { result: 'offline fixture delivered', reference: publicReference === 'transaction ID' ? f.signature
      : `https://explorer.solana.com/tx/${f.signature}?cluster=devnet` };
    expect(f.identity.buyerSignature).toBe(f.signature); // MPP's sole signer signature is the public transaction ID.
    value.finish(record.approvalId, { transaction: f.signature, data }, now, delivery);
    expect(value.getOwned('original-mpp', principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data });
    value.close(); value = ledger(path);
    expect(value.getOwned('original-mpp', principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data });
    expect(value.managedSummary(now)).toMatchObject({ reserved: '0', paid: f.quote.amount });
  } finally { value.close(); }
});

it('never reuses one merchant challenge for a different request ID, including after terminal failure and restart', () => {
  const path = temporaryLedger(); let value = ledger(path);
  try {
    value.setDailyLimit('1000000'); const binding = grant(value, 'mpp-resource', 'mpp_charge');
    const original = intent('single-use-first', 'mpp-resource', binding);
    const record = value.reserve(original, quote(), now);
    expect(() => value.reserve(intent('single-use-second', 'mpp-resource', binding), quote(), now)).toThrow('MPP_CHALLENGE_ALREADY_USED');
    expect(value.getOwned('single-use-second', principal.cardMemberId)).toBeUndefined();
    value.claim(record.approvalId, now); value.failUnsubmitted(record.approvalId);
    value.close(); value = ledger(path);
    expect(value.getOwned('single-use-first', principal.cardMemberId)?.status).toBe('FAILED');
    expect(() => value.reserve(intent('single-use-after-restart', 'mpp-resource', binding), quote(), now)).toThrow('MPP_CHALLENGE_ALREADY_USED');
    const freshQuote = MppChargeQuoteSchema.parse({ ...quote(), challenge: { ...quote().challenge, id: 'fresh-challenge' },
      challengeHeader: 'Payment fixture=fresh-challenge' });
    const fresh = SpendIntentSchema.parse({ ...intent('fresh-request', 'mpp-resource', binding), mpp: freshQuote,
      quoteFingerprint: hash(freshQuote), executionBinding: hash(['fresh-request', freshQuote]) });
    expect(value.reserve(fresh, freshQuote, now).status).toBe('APPROVED');
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('SELECT challenge_hash,purchase_id FROM mpp_challenge_claims WHERE challenge_id=?').get(quote().challenge.id))
        .toEqual({ challenge_hash: hash(quote().challengeHeader), purchase_id: record.intent.id });
      expect(() => db.prepare('DELETE FROM mpp_challenge_claims WHERE purchase_id=?').run(record.intent.id)).toThrow('history');
      expect(() => db.prepare('UPDATE mpp_challenge_claims SET challenge_hash=? WHERE purchase_id=?').run('a'.repeat(64), record.intent.id)).toThrow('immutable');
    } finally { db.close(); }
  } finally { value.close(); }
});

it('atomically claims one merchant challenge across concurrent processes using different request IDs', async () => {
  const path = temporaryLedger(), value = ledger(path);
  value.setDailyLimit('1000000'); const binding = grant(value, 'mpp-resource', 'mpp_charge'); value.close();
  const workers = ['race-a', 'race-b'].map(id => ({
    child: fork(resolve('tests/helpers/mpp-challenge-worker.ts'), [], { execArgv: ['--import', 'tsx'], silent: true,
      env: { PATH: process.env.PATH, NODE_ENV: 'test' } }), input: intent(id, 'mpp-resource', binding),
  }));
  const exits = workers.map(({ child }) => once(child, 'exit'));
  try {
    // Open connections sequentially, then race only the atomic reservations.
    for (const { child, input } of workers) {
      const ready = once(child, 'message'); child.send({ path, now, intent: input, quote: quote() });
      expect((await ready)[0]).toEqual({ ready: true });
    }
    const results = await Promise.all(workers.map(async ({ child }) => {
      const finished = once(child, 'message'); child.send('reserve');
      return z.union([z.object({ status: z.literal('APPROVED') }), z.object({ code: z.literal('MPP_CHALLENGE_ALREADY_USED') })]).parse((await finished)[0]);
    }));
    expect(results.filter(result => 'status' in result)).toHaveLength(1);
    expect(results.filter(result => 'code' in result)).toHaveLength(1);
    await Promise.all(exits);
    const reopened = ledger(path);
    try {
      expect(reopened.managedSummary(now).reserved).toBe('200000');
      expect(reopened.listForAdministration()).toHaveLength(1);
    } finally { reopened.close(); }
  } finally { workers.forEach(({ child }) => child.kill()); }
}, 15_000);
