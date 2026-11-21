import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { canShareSavedResult } from '../../src/modules/purchases/account-result-policy';
import type { SpendIntent } from '../../src/modules/authority/spend-intent';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { PAID_RESOURCE_SCOPE_ID, paidResource } from '../../src/modules/resources/paid-resources';

const now = Date.now();
function intent(resultAudience?: 'owner' | 'account'): SpendIntent {
  return { id: randomUUID(), idempotencyKey: randomUUID(), resourceId: 'report', providerId: 'fixture', requestHash: 'request-hash',
    createdAt: now, expiresAt: now + 60_000, amount: '1000', assetId: DEVNET_USDC_MINT, assetDecimals: 6, currency: 'TEST',
    network: DEVNET_NETWORK, payTo: 'fixture', executionBinding: 'test-only', paymentScheme: 'exact', quoteFingerprint: 'quote', resultAudience };
}
it('recognizes only the original built-in test delivery contract in unclassified historical orders', () => {
  const d = paidResource('market-snapshot');
  const old: SpendIntent = { ...intent(), resourceId: d.id, resourceScopeId: PAID_RESOURCE_SCOPE_ID, resourcePath: d.path,
    providerId: d.providerId, httpRequest: { url: `http://127.0.0.1:8080${d.path}`, access: 'test_loopback', method: 'GET', headers: {} } };
  const data = { resource_id: 'sol-market-snapshot', asset: 'SOL', as_of: '2026-01-01T00:00:00Z', source_label: 'fixture', spot_price_usd: 100, is_demo_snapshot: true };
  expect(canShareSavedResult(old, data)).toBe(true);
  expect(canShareSavedResult(intent('account'), { nested: [{ api_key: 'fixture' }] })).toBe(false);
  expect(canShareSavedResult(intent('account'), 'Bearer fixture')).toBe(false);
  expect(canShareSavedResult({ ...old, resultAudience: 'owner' }, data)).toBe(false);
  expect(canShareSavedResult({ ...old, resourceScopeId: undefined }, data)).toBe(false);
  expect(canShareSavedResult({ ...old, providerId: 'another' }, data)).toBe(false);
  expect(canShareSavedResult(old, { ...data, extra: 'unclassified' })).toBe(false);
});

it('keeps private results private across restart and reassembles permitted UTF-8 chunks without spending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-test-statement-'));
  const open = () => new PurchaseLedger(join(dir, 'ledger.sqlite'), { managed: true, mode: 'simulated', now: () => now });
  let ledger = open();
  try {
    const a = ledger.defaultCardMember().id, b = ledger.createCardMember('Reader').id;
    ledger.setDailyLimit('100000', 'simulated');
    const orders = [intent('owner'), intent(), intent('account'), intent('account')];
    const data = { report: '示例'.repeat(5000) };
    for (const [i, order] of orders.entries()) {
      const row = ledger.reserve(order, { scheme: 'exact', amount: order.amount, network: DEVNET_NETWORK, asset: order.assetId, payTo: order.payTo,
        maxTimeoutSeconds: 60, extra: {} }, now, 'simulated', a);
      if (i === 3) continue;
      ledger.claim(row.approvalId, now, undefined, 'simulated'); ledger.finish(row.approvalId, { transaction: `simulated-${i}`, data }, now);
    }
    ledger.close(); ledger = open();
    for (const i of [0,1,3]) expect(ledger.readAccountResult(b, 'simulated', { purchaseId: orders[i].id })).toBeNull();
    const read = (offset?: number) => ledger.readAccountResult(b, 'simulated', { purchaseId: orders[2].id, offset });
    const first = read()!; expect(first.nextOffset).toBe(16_384);
    const second = read(first.nextOffset!)!; expect(second.nextOffset).toBeNull();
    expect(Buffer.concat([first, second].map(r => Buffer.from(r.chunk, 'base64'))).toString()).toBe(JSON.stringify(data));
    expect(read(first.totalBytes + 1)).toBeNull();
    const statement = ledger.readAccountStatement(b, 'simulated', {});
    expect(statement.totals).toEqual({ paidAtomic: '3000', reservedAtomic: '1000' });
    expect(statement.entries[0]).toMatchObject({ status: 'APPROVED', paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_PAID', fee: null });
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
