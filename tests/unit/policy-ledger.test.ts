import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { hash, spendingDay } from '../../src/modules/purchases/spending-policy';
import { evaluateSpendAuthority, parseStoredAuthorityDecision } from '../../src/modules/authority/authority-policy';
import { parseStoredSpendIntent, SpendIntentSchema, type SpendIntent } from '../../src/modules/authority/spend-intent';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import type { PaymentRequirements } from '@x402/core/types';
const now = Date.parse('2026-09-09T12:00:00Z');
const resource = createStaticResourceRegistry({ endpoint: 'https://example.com', asset_id: DEVNET_USDC_MINT, network: DEVNET_NETWORK, allowed_pay_to: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs' })[0];
function fixture(amount = 10000) {
  const quote: PaymentRequirements = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount: String(amount), payTo: resource.allowed_pay_to, maxTimeoutSeconds: 300, extra: {} };
  const intent: SpendIntent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: randomUUID(), requestHash: hash('task'), resourceId: resource.resource_id,
    providerId: resource.provider_id, amount, currency: 'USDC', assetDecimals: 6, assetId: DEVNET_USDC_MINT, network: DEVNET_NETWORK,
    payTo: resource.allowed_pay_to, paymentScheme: 'exact', quoteFingerprint: hash(quote), createdAt: now, expiresAt: now + 300000, executionBinding: 'fixed-config' });
  return { quote, intent, resource: { ...resource, expected_price_minor: String(amount) } };
}
describe('generic authority policy', () => {
  it('decides economic limits without requiring an HTTP or payment-protocol envelope', () => {
    const f = fixture();
    const facts = { amount: f.intent.amount, createdAt: f.intent.createdAt, expiresAt: f.intent.expiresAt };
    expect(evaluateSpendAuthority(facts, { committed: 0, hasUnknownPayment: false }, now))
      .toEqual(evaluateSpendAuthority(f.intent, { committed: 0, hasUnknownPayment: false }, now));
    expect(evaluateSpendAuthority(facts, { committed: 0, hasUnknownPayment: false }, now).decision).toBe('APPROVED');
  });
  it('defines a strict SpendIntent and upgrades legacy purchase records without changing their execution binding', () => {
    const f = fixture();
    expect(SpendIntentSchema.safeParse({ ...f.intent, input: { asset: 'SOL' } }).success).toBe(false);
    const legacy = { id: f.intent.id, taskId: f.intent.idempotencyKey, taskHash: f.intent.requestHash, resourceId: f.intent.resourceId,
      providerId: f.intent.providerId, input: { asset: 'SOL' }, amount: f.intent.amount, currency: f.intent.currency, decimals: f.intent.assetDecimals,
      mint: f.intent.assetId, network: f.intent.network, payTo: f.intent.payTo, scheme: f.intent.paymentScheme,
      quoteFingerprint: f.intent.quoteFingerprint, createdAt: f.intent.createdAt, expiresAt: f.intent.expiresAt, binding: f.intent.executionBinding };
    expect(parseStoredSpendIntent(legacy)).toEqual(f.intent);
    expect(parseStoredAuthorityDecision({ decision: 'REJECTED', reason: 'OLD', committedBefore: 0, remainingAfter: 1 }).decision).toBe('DENIED');
  });
  it.each([[10000, 0, 'APPROVED'], [100000, 900000, 'APPROVED'], [110000, 0, 'REQUIRES_APPROVAL'], [100000, 910000, 'DENIED']])('amount %s with committed %s gives %s', (amount, committed, expected) => {
    const f = fixture(Number(amount));
    expect(evaluateSpendAuthority(f.intent, { committed: Number(committed), hasUnknownPayment: false }, now).decision).toBe(expected);
  });
  it('denies malformed and expired intents, unresolved payments, pause, and budget overflow', () => {
    const f = fixture();
    for (const amount of [0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(evaluateSpendAuthority({ ...f.intent, amount }, { committed: 0, hasUnknownPayment: false }, now).decision).toBe('DENIED');
    expect(evaluateSpendAuthority(f.intent, { committed: 0, hasUnknownPayment: false }, now + 300000).decision).toBe('DENIED');
    expect(evaluateSpendAuthority(f.intent, { committed: 0, hasUnknownPayment: true }, now).reason).toBe('LEDGER_UNRESOLVED');
    expect(evaluateSpendAuthority(f.intent, { committed: 0, hasUnknownPayment: false }, now, { dailyBudget: '1000000', singleLimit: '100000', paused: true }).reason).toBe('PAYMENTS_PAUSED');
    expect(evaluateSpendAuthority(f.intent, { committed: 995000, hasUnknownPayment: false }, now).reason).toBe('DAILY_BUDGET_EXCEEDED');
  });
  it('uses Shanghai midnight and canonical quote fingerprints', () => {
    expect(spendingDay(Date.parse('2026-09-09T15:59:59Z'))).toBe('2026-09-09');
    expect(spendingDay(Date.parse('2026-09-09T16:00:00Z'))).toBe('2026-09-10');
    expect(hash({ b: 2, a: { d: 4, c: 3 } })).toBe(hash({ a: { c: 3, d: 4 }, b: 2 }));
  });
});

describe('market resource adapter', () => {
  it('validates market-specific input and quote before creating a generic SpendIntent', () => {
    const f = fixture();
    const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'market-1', request: { asset: 'SOL' }, requestHash: hash('task'), resource: f.resource,
      quote: f.quote, executionBinding: 'fixed-config', now });
    expect(intent).toMatchObject({ idempotencyKey: 'market-1', resourceId: 'premium-sol-market-snapshot', amount: '10000', assetId: DEVNET_USDC_MINT });
    expect(intent).not.toHaveProperty('input');
  });
  it.each([
    ['input', { asset: 'BTC' }, resource, fixture().quote],
    ['provider', { asset: 'SOL' }, { ...resource, provider_id: 'other' }, fixture().quote],
    ['network', { asset: 'SOL' }, resource, { ...fixture().quote, network: 'wrong' }],
    ['price', { asset: 'SOL' }, resource, { ...fixture().quote, amount: '20000' }],
  ])('rejects market-specific %s mismatches outside the authority policy', (_case, request, candidateResource, quote) => {
    expect(() => createMarketSnapshotSpendIntent({ idempotencyKey: 'market-1', request, requestHash: hash('task'), resource: candidateResource,
      quote: quote as PaymentRequirements, executionBinding: 'fixed-config', now })).toThrow();
  });
});
describe('durable approval and budget ledger', () => {
  it('rejects an incomplete protocol binding before reserving even when its economic facts pass', () => {
    const ledger = new PurchaseLedger(':memory:');
    try {
      const f = fixture();
      expect(evaluateSpendAuthority(f.intent, { committed: 0, hasUnknownPayment: false }, now).decision).toBe('APPROVED');
      expect(() => ledger.reserve({ ...f.intent,
        httpRequest: { url: 'https://provider.fixture.example/data', method: 'GET', access: 'https', headers: {} },
      }, f.quote, now)).toThrow();
      expect(ledger.list()).toHaveLength(0);
      expect(ledger.summary(now).reservedUSDC).toBe(0);
    } finally { ledger.close(); }
  });
  it('reuses a task purchase, rejects changed input and permits only one claim', () => {
    const ledger = new PurchaseLedger(':memory:');
    try {
      const f = fixture();
      const first = ledger.reserve(f.intent, f.quote, now);
      expect(ledger.summary(now)).toEqual({ paidUSDC: 0, reservedUSDC: 0.01, remainingUSDC: 0.99, unresolved: 0 });
      expect(ledger.reserve({ ...f.intent, id: randomUUID() }, f.quote, now).approvalId).toBe(first.approvalId);
      expect(() => ledger.reserve({ ...f.intent, requestHash: 'changed' }, f.quote, now)).toThrow();
      ledger.claim(first.approvalId, now);
      expect(() => ledger.claim(first.approvalId, now)).toThrow();
      ledger.unknown(first.approvalId);
      expect(ledger.summary(now).unresolved).toBe(1);
      const next = fixture();
      expect(ledger.reserve(next.intent, next.quote, now).decision.reason).toBe('LEDGER_UNRESOLVED');
    } finally { ledger.close(); }
  });
  it('reserves pending budgets across two connections and survives restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'day5-ledger-'));
    const path = join(dir, 'ledger.sqlite');
    const a = new PurchaseLedger(path), b = new PurchaseLedger(path);
    try {
      for (let i = 0; i < 10; i++) {
        const f = fixture(100000);
        expect((i % 2 ? a : b).reserve(f.intent, f.quote, now).status).toBe('APPROVED');
      }
      const f = fixture();
      expect(b.reserve(f.intent, f.quote, now).decision.reason).toBe('DAILY_BUDGET_EXCEEDED');
      const c = new PurchaseLedger(path);
      try { expect(c.get(f.intent.idempotencyKey)?.status).toBe('DENIED'); } finally { c.close(); }
    } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('a crash after claim remains locked after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'day5-crash-')); const path = join(dir, 'ledger.sqlite');
    const a = new PurchaseLedger(path); const f = fixture();
    const r = a.reserve(f.intent, f.quote, now); a.claim(r.approvalId, now); a.close();
    const b = new PurchaseLedger(path);
    try { expect(() => b.claim(r.approvalId, now)).toThrow(); expect(b.get(f.intent.idempotencyKey)?.status).toBe('PAYING'); }
    finally { b.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

it('expired unclaimed approvals release budget but claimed payments stay frozen', () => {
  const ledger = new PurchaseLedger(':memory:');
  try {
    const first = fixture(100000); const claimed = fixture(100000);
    ledger.reserve(first.intent, first.quote, now);
    const record = ledger.reserve(claimed.intent, claimed.quote, now);
    ledger.claim(record.approvalId, now);
    ledger.releaseExpired(now + 300001);
    expect(ledger.get(first.intent.idempotencyKey)?.status).toBe('EXPIRED');
    expect(ledger.get(claimed.intent.idempotencyKey)?.status).toBe('PAYING');
    expect(ledger.summary(now + 300001)).toEqual({ paidUSDC: 0, reservedUSDC: 0.1, remainingUSDC: 0.9, unresolved: 1 });
    expect(() => ledger.claim(record.approvalId, now + 300001)).toThrow();
    const next = fixture(); next.intent.createdAt += 300001; next.intent.expiresAt += 300001;
    expect(ledger.reserve(next.intent, next.quote, now + 300001).decision.reason).toBe('LEDGER_UNRESOLVED');
  } finally { ledger.close(); }
});
it('a new purchase can use released expired budget', () => {
  const ledger = new PurchaseLedger(':memory:');
  try {
    for (let i = 0; i < 10; i++) { const f = fixture(100000); ledger.reserve(f.intent, f.quote, now); }
    const next = fixture(100000); next.intent.createdAt += 300001; next.intent.expiresAt += 300001;
    expect(ledger.reserve(next.intent, next.quote, now + 300001).status).toBe('APPROVED');
  } finally { ledger.close(); }
});
