import { afterEach, expect, it, vi } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { hash } from '../../src/modules/purchases/spending-policy';
import { signedManagementRequest } from '../helpers/management-request';
import { GET } from '../../src/app/api/app/notifications/route';

let ledger: PurchaseLedger;
let directory: string;
vi.mock('../../src/modules/app/app-runtime', () => ({ appRuntime: () => ({ ledger, directory }) }));
const secret = 'fixture-notifications-management-secret';
afterEach(() => { ledger?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function setup(mode: 'live_devnet' | 'simulated' = 'live_devnet') {
  directory = mkdtempSync(join(tmpdir(), 'yosh-notifications-'));
  ledger = new PurchaseLedger(join(directory, 'ledger.sqlite'), { mode, managed: true });
}
function purchase(status: string, type: string, amount = '10000') {
  const id = randomUUID(), now = Date.now();
  const quote: PaymentRequirements = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount,
    payTo: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', maxTimeoutSeconds: 300, extra: {} };
  const intent = SpendIntentSchema.parse({ id, idempotencyKey: id, requestHash: hash(id), resourceId: 'fixture-api',
    providerId: 'fixture', amount, currency: 'USDC', assetDecimals: 6, assetId: DEVNET_USDC_MINT,
    network: DEVNET_NETWORK, payTo: quote.payTo, paymentScheme: 'exact', quoteFingerprint: hash(quote),
    createdAt: now, expiresAt: now + 300000, executionBinding: 'fixture' });
  ledger.reserve(intent, quote, now);
  // Fixture only: seed authoritative outcomes without keys, network, signatures or payment execution.
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  db.prepare('UPDATE purchases SET status=?,payload=? WHERE id=?').run(status, 'fixture-sensitive-payload', id);
  db.prepare('INSERT INTO purchase_events(purchase_id,type,at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM purchase_events WHERE purchase_id=? AND type=?)').run(id, type, now, id, type);
  db.close();
  return id;
}
it('baselines history, returns explicit outcomes only, and never exposes payment payloads', () => {
  setup();
  purchase('PAID', 'payment.PAID');
  const baseline = ledger.notificationEvents();
  expect(baseline.events).toEqual([]);
  purchase('PAYMENT_UNKNOWN', 'payment.PAYMENT_UNKNOWN');
  purchase('APPROVED', 'authority.APPROVED');
  purchase('PAID', 'payment.PAID');
  purchase('DENIED', 'authority.DENIED');
  purchase('FAILED', 'payment.FAILED_BEFORE_SUBMISSION');
  const result = ledger.notificationEvents(baseline.cursor);
  expect(result.events.map(e => e.outcome)).toEqual(['Paid', 'Unpaid', 'Unpaid']);
  expect(result.events[0]).toMatchObject({ quantity: '1', priceDisplay: '0.01 Test USDC', apiName: 'fixture-api', amount: '10000' });
  expect(JSON.stringify(result)).not.toContain('fixture-sensitive-payload');
  expect(ledger.notificationEvents(result.cursor).events).toEqual([]);
  expect(() => ledger.notificationEvents(-1)).toThrow();
});
it('pages more than fifty transitions without losing outcomes and resumes after reopening the database', () => {
  setup();
  const ids = Array.from({ length: 65 }, () => purchase('PAID', 'payment.PAID'));
  let cursor = 0;
  const received: string[] = [];
  for (;;) {
    const feed = ledger.notificationEvents(cursor);
    received.push(...feed.events.map(e => e.purchaseId));
    if (feed.cursor === cursor) break;
    cursor = feed.cursor;
  }
  expect(received).toEqual(ids);
  ledger.close();
  ledger = new PurchaseLedger(join(directory, 'ledger.sqlite'), { mode: 'live_devnet', managed: true });
  expect(ledger.notificationEvents(cursor).events).toEqual([]);
});
it('requires management authentication, validates cursors and returns a stable opaque store identity', async () => {
  setup(); vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  const url = 'http://127.0.0.1:3049/api/app/notifications';
  expect((await GET(new Request(url))).status).toBe(401);
  const read = (suffix: string) => GET(signedManagementRequest(url + suffix, secret));
  expect((await read('?after=-1')).status).toBe(400);
  expect((await read('?unexpected=1')).status).toBe(400);
  const first = await (await read('')).json();
  const next = await (await read('?after=0')).json();
  expect(next.storeId).toBe(first.storeId);
  expect(next.storeId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain(directory);
});

it('formats amounts above Number precision without rounding and never labels a simulation Paid', () => {
  setup();
  purchase('PAID', 'payment.PAID', '9007199254740993');
  expect(ledger.notificationEvents(0).events[0].priceDisplay).toBe('9007199254.740993 Test USDC');
  ledger.close(); rmSync(directory, { recursive: true, force: true });
  setup('simulated');
  purchase('PAID', 'payment.PAID');
  expect(ledger.notificationEvents(0).events).toEqual([]);
});
