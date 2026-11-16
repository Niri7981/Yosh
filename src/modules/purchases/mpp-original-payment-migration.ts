import type { DatabaseSync } from 'node:sqlite';

/** One on-chain MPP transaction belongs to one purchase, regardless of merchant,
 * challenge, Grant or wallet-record scope. The immutable original is the claim. */
export function ensureMppOriginalTransactionOwnership(db: DatabaseSync, now: number) {
  if (!db.isTransaction) throw new Error('MPP_ORIGINAL_TRANSACTION_ATOMIC_REQUIRED');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_mpp_original_transaction ON original_payments(
    json_extract(evidence,'$.identity.network'), json_extract(evidence,'$.identity.knownSignature'))
    WHERE json_extract(evidence,'$.identity.protocol')='mpp'`);
  db.prepare('INSERT OR IGNORE INTO ledger_schema_migrations(id,applied_at) VALUES (?,?)')
    .run('024_mpp_original_transaction_ownership', now);
}

/** Cover historical MPP originals before any recovery. Conflicting evidence is
 * retained for investigation, never deduplicated or attributed to a new owner.
 * x402-only databases do not acquire this migration during startup. */
export function migrateMppOriginalTransactionOwnership(db: DatabaseSync, now: number) {
  if (!db.prepare("SELECT 1 FROM original_payments WHERE json_extract(evidence,'$.identity.protocol')='mpp' LIMIT 1").get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureMppOriginalTransactionOwnership(db, now);
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    throw new Error('MPP_ORIGINAL_TRANSACTION_MIGRATION_FAILED: existing evidence retained');
  }
}
