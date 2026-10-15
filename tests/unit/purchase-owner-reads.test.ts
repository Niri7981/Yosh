import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentRequirements } from '@x402/core/types';
import { expect, it } from 'vitest';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';

const now = Date.parse('2026-10-16T08:00:00Z');
const requestId = 'same-request-id';
const options = { managed: true, mode: 'simulated' as const, now: () => now, timeZone: () => 'UTC' };
const quote: PaymentRequirements = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT,
  amount: '10000', payTo: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', maxTimeoutSeconds: 300, extra: {} };

function purchase(ledger: PurchaseLedger, owner: string | undefined, result: string) {
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: requestId, requestHash: hash(result),
    resourceId: 'fixture-resource', providerId: 'fixture-provider', amount: quote.amount, currency: 'USDC',
    assetDecimals: 6, assetId: quote.asset, network: quote.network, payTo: quote.payTo, paymentScheme: quote.scheme,
    quoteFingerprint: hash(quote), createdAt: now, expiresAt: now + 300_000, executionBinding: 'fixture-configuration' });
  const reserved = ledger.reserve(intent, quote, now, 'simulated', owner);
  ledger.claim(reserved.approvalId, now);
  ledger.finish(reserved.approvalId, { transaction: `simulated-${result}`, data: { result } }, now);
  return reserved;
}

it('requires exact owners for duplicate request IDs and makes management aggregation explicit across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-owner-reads-'));
  const path = join(directory, 'ledger.sqlite');
  let ledger = new PurchaseLedger(path, options);
  try {
    ledger.setDailyLimit('100000', 'simulated');
    const firstOwner = ledger.defaultCardMember().id;
    const secondOwner = ledger.createCardMember('Second fixture Agent', now).id;
    const first = purchase(ledger, firstOwner, 'first-owner-data');
    const second = purchase(ledger, secondOwner, 'second-owner-data');
    expect(ledger.getLegacy(requestId)).toBeUndefined();
    const legacy = purchase(ledger, undefined, 'ownerless-history');
    ledger.close();
    ledger = new PurchaseLedger(path, options);

    expect(ledger.getOwned(requestId, firstOwner)).toMatchObject({ ownerCardMemberId: firstOwner,
      approvalId: first.approvalId, data: { result: 'first-owner-data' } });
    expect(ledger.getOwned(requestId, secondOwner)).toMatchObject({ ownerCardMemberId: secondOwner,
      approvalId: second.approvalId, data: { result: 'second-owner-data' } });
    expect(ledger.getOwned(requestId, randomUUID())).toBeUndefined();
    expect(ledger.getLegacy(requestId)).toMatchObject({ approvalId: legacy.approvalId, data: { result: 'ownerless-history' } });
    expect(ledger.getLegacy(requestId)).not.toHaveProperty('ownerCardMemberId');
    expect(() => ledger.getForAdministration(requestId)).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');

    expect(ledger.listForOwner(firstOwner)).toMatchObject([{ ownerCardMemberId: firstOwner, transaction: 'simulated-first-owner-data' }]);
    expect(ledger.listForOwner(secondOwner)).toMatchObject([{ ownerCardMemberId: secondOwner, transaction: 'simulated-second-owner-data' }]);
    expect(ledger.listForAdministration().map(row => row.ownerCardMemberId).sort()).toEqual([null, firstOwner, secondOwner].sort());
    const firstEvents = ledger.eventsForOwner(requestId, firstOwner);
    const secondEvents = ledger.eventsForOwner(requestId, secondOwner);
    const legacyEvents = ledger.eventsForLegacy(requestId);
    const allEvents = ledger.eventsForAdministration(requestId);
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(legacyEvents.length).toBeGreaterThan(0);
    expect(allEvents).toHaveLength(firstEvents.length + secondEvents.length + legacyEvents.length);
    for (const [owner, record, events] of [[firstOwner, first, firstEvents], [secondOwner, second, secondEvents], [null, legacy, legacyEvents]] as const) {
      expect(allEvents.filter(event => event.ownerCardMemberId === owner)).toEqual(events.map(event => ({ ...event,
        purchaseId: record.intent.id, requestId, ownerCardMemberId: owner })));
    }
    for (const summary of ledger.listForAdministration()) {
      expect(summary).not.toHaveProperty('data');
      expect(summary).not.toHaveProperty('paymentEvidence');
      expect(summary).not.toHaveProperty('payload');
    }
    for (const event of allEvents) expect(Object.keys(event).sort()).toEqual(
      ['at', 'ownerCardMemberId', 'purchaseId', 'requestId', 'sequence', 'type']);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects absent owner values at runtime instead of choosing the default member', () => {
  const ledger = new PurchaseLedger(':memory:', options);
  try {
    for (const owner of ['', '   ']) {
      expect(() => ledger.getOwned(requestId, owner)).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
      expect(() => ledger.listForOwner(owner)).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
      expect(() => ledger.eventsForOwner(requestId, owner)).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
    }
    expect(() => Reflect.apply(ledger.getOwned, ledger, [requestId])).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
    expect(() => Reflect.apply(ledger.listForOwner, ledger, [])).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
    expect(() => Reflect.apply(ledger.eventsForOwner, ledger, [requestId])).toThrow('PURCHASE_REQUEST_OWNER_REQUIRED');
  } finally { ledger.close(); }
});
