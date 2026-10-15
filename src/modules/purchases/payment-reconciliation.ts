import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TransactionSignatureSchema } from '../payment/original-payment-evidence';

export type ReconciliationCode = 'UNKNOWN' | 'CONFIRMED' | 'FAILED' | 'EVIDENCE_UNAVAILABLE' | 'BINDING_MISMATCH' | 'INTERRUPTED';
export type ReconciliationClaim = { purchaseId: string; token: string; before?: string };

/** Read-only chain work has its own durable schedule. A work claim never releases money. */
export class PaymentReconciliation {
  constructor(private db: DatabaseSync, private now: () => number) {
    this.atomic(() => {
      if (db.prepare("SELECT id FROM ledger_schema_migrations WHERE id='016_payment_reconciliation'").get()) return;
      db.exec(`CREATE TABLE payment_reconciliation (
        purchase_id TEXT PRIMARY KEY REFERENCES purchases(id), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at>=0), last_attempt_at INTEGER,
        last_code TEXT CHECK(last_code IN ('UNKNOWN','CONFIRMED','FAILED','EVIDENCE_UNAVAILABLE','BINDING_MISMATCH','INTERRUPTED')),
        history_before TEXT, claim_token TEXT);
        CREATE INDEX payment_reconciliation_due ON payment_reconciliation(next_attempt_at,purchase_id);
        CREATE TRIGGER payment_reconciliation_attempts_monotonic BEFORE UPDATE OF attempts ON payment_reconciliation
          WHEN NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
          BEGIN SELECT RAISE(ABORT,'reconciliation attempts cannot reset'); END;
        INSERT INTO payment_reconciliation(purchase_id)
          SELECT id FROM purchases WHERE status IN ('PAYING','PAYMENT_UNKNOWN') AND execution_mode IN ('live_devnet','live_mainnet');`);
      db.prepare('INSERT INTO ledger_schema_migrations VALUES (?,?)').run('016_payment_reconciliation', now());
    });
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  state(purchaseId: string) {
    const row = this.db.prepare('SELECT * FROM payment_reconciliation WHERE purchase_id=?').get(purchaseId);
    return row ? { attempts: Number(row.attempts), nextAttemptAt: Number(row.next_attempt_at),
      lastCode: row.last_code === null ? null : String(row.last_code), claimed: row.claim_token !== null,
      before: row.history_before === null ? undefined : TransactionSignatureSchema.parse(row.history_before) } : undefined;
  }
  claim(purchaseId: string, automatic = false): ReconciliationClaim | undefined {
    return this.atomic(() => {
      const purchase = this.db.prepare("SELECT id FROM purchases WHERE id=? AND status IN ('PAYING','PAYMENT_UNKNOWN') AND execution_mode IN ('live_devnet','live_mainnet')").get(purchaseId);
      if (!purchase) return;
      this.db.prepare('INSERT OR IGNORE INTO payment_reconciliation(purchase_id) VALUES (?)').run(purchaseId);
      const state = this.state(purchaseId)!; const now = this.now();
      if (state.claimed || (automatic && state.nextAttemptAt > now)) return;
      const token = randomUUID();
      // Persist backoff before network I/O, so restart cannot reset a hot retry loop.
      const next = now + Math.min(300_000, 1000 * 2 ** Math.min(state.attempts, 9));
      this.db.prepare(`UPDATE payment_reconciliation SET attempts=attempts+1,next_attempt_at=?,last_attempt_at=?,claim_token=?
        WHERE purchase_id=? AND claim_token IS NULL`).run(next, now, token, purchaseId);
      return { purchaseId, token, before: state.before };
    });
  }
  saveCursor(claim: ReconciliationClaim, before: string | undefined) {
    if (before !== undefined) TransactionSignatureSchema.parse(before);
    if (this.db.prepare('UPDATE payment_reconciliation SET history_before=? WHERE purchase_id=? AND claim_token=?')
      .run(before ?? null, claim.purchaseId, claim.token).changes !== 1) throw new Error('RECONCILIATION_CLAIM_MISMATCH');
  }
  finish(claim: ReconciliationClaim, code: ReconciliationCode) {
    this.db.prepare('UPDATE payment_reconciliation SET claim_token=NULL,last_code=? WHERE purchase_id=? AND claim_token=?')
      .run(code, claim.purchaseId, claim.token);
  }
  /** Only the exclusive service owner calls this before accepting requests. */
  recoverClaimsOnStartup() {
    this.db.prepare("UPDATE payment_reconciliation SET claim_token=NULL,last_code='INTERRUPTED' WHERE claim_token IS NOT NULL").run();
  }
  due(scopeId: string) {
    // Include rows created after migration. No original payment or financial row is rewritten.
    this.db.prepare(`INSERT OR IGNORE INTO payment_reconciliation(purchase_id)
      SELECT id FROM purchases WHERE status='PAYMENT_UNKNOWN' AND monetary_scope_id=? AND execution_mode IN ('live_devnet','live_mainnet')`).run(scopeId);
    return this.db.prepare(`SELECT p.id,p.task_id,p.owner_card_member_id FROM payment_reconciliation r JOIN purchases p ON p.id=r.purchase_id
      WHERE p.status='PAYMENT_UNKNOWN' AND p.monetary_scope_id=? AND r.claim_token IS NULL AND r.next_attempt_at<=?
      ORDER BY r.next_attempt_at,r.last_attempt_at,p.id LIMIT 4`).all(scopeId, this.now())
      .map(row => ({ purchaseId: String(row.id), requestId: String(row.task_id), ownerCardMemberId: row.owner_card_member_id ? String(row.owner_card_member_id) : undefined }));
  }
}
