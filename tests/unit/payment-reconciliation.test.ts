import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { PaymentReconciliation } from '../../src/modules/purchases/payment-reconciliation';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db); let now = 100_000;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE ledger_schema_migrations(id TEXT PRIMARY KEY,applied_at INTEGER);
    CREATE TABLE purchases(id TEXT PRIMARY KEY,task_id TEXT,owner_card_member_id TEXT,status TEXT,execution_mode TEXT,monetary_scope_id TEXT);`);
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO purchases VALUES (?,?,?,?,?,?)')
    .run(`purchase-${i}`, `request-${i}`, `owner-${i}`, 'PAYMENT_UNKNOWN', 'live_mainnet', i === 5 ? 'other-scope' : 'active-scope');
  const schedule = new PaymentReconciliation(db, () => now);
  return { db, schedule, advance: (ms: number) => { now += ms; }, now: () => now };
}

it('bounds each due batch, keeps owner/scope, and advances past unavailable orders after they back off', () => {
  const f = fixture(); const before = f.db.prepare('SELECT * FROM purchases').all();
  const first = f.schedule.due('active-scope');
  expect(first.map(item => item.purchaseId)).toEqual(['purchase-0', 'purchase-1', 'purchase-2', 'purchase-3']);
  for (const item of first) {
    expect(item.ownerCardMemberId).toBe(item.purchaseId.replace('purchase', 'owner'));
    const claim = f.schedule.claim(item.purchaseId, true)!; f.schedule.finish(claim, 'EVIDENCE_UNAVAILABLE');
  }
  expect(f.schedule.due('active-scope').map(item => item.purchaseId)).toEqual(['purchase-4']);
  expect(f.schedule.due('other-scope').map(item => item.purchaseId)).toEqual(['purchase-5']);
  expect(f.db.prepare('SELECT * FROM purchases').all()).toEqual(before);
});

it('persists exponential backoff capped at five minutes with no terminal attempt limit or reset', () => {
  const f = fixture(); const delays: number[] = [];
  for (let i = 0; i < 12; i++) {
    const claim = f.schedule.claim('purchase-0', true)!; expect(claim).toBeDefined();
    f.schedule.finish(claim, 'UNKNOWN');
    const state = f.schedule.state('purchase-0')!; const delay = state.nextAttemptAt - f.now(); delays.push(delay);
    expect(f.schedule.claim('purchase-0', true)).toBeUndefined();
    f.advance(delay);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
  expect(f.schedule.state('purchase-0')).toMatchObject({ attempts: 12, lastCode: 'UNKNOWN', claimed: false });
  expect(f.db.prepare('SELECT status FROM purchases WHERE id=?').get('purchase-0')).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  expect(() => f.db.prepare('UPDATE payment_reconciliation SET attempts=0 WHERE purchase_id=?').run('purchase-0')).toThrow('attempts cannot reset');
});

it('completed financial outcomes are never selected or claimed for another reconciliation', () => {
  const f = fixture(); f.db.prepare("UPDATE purchases SET status='PAID' WHERE id='purchase-0'").run();
  expect(f.schedule.claim('purchase-0')).toBeUndefined();
  expect(f.schedule.due('active-scope').some(item => item.purchaseId === 'purchase-0')).toBe(false);
});
