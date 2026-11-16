import type { DatabaseSync } from 'node:sqlite';

/** Add consent only when creating the first MPP Grant, in that Grant's existing
 * transaction. Existing scopes, grants, purchases and authorization hashes stay
 * byte-for-byte unchanged; this table is not a separate budget ledger. */
export function migrateMppGrantConsent(db: DatabaseSync, now: number) {
  if (!db.isTransaction) throw new Error('MPP_GRANT_TRANSACTION_REQUIRED');
  db.exec(`CREATE TABLE IF NOT EXISTS mpp_grant_terms (
    grant_id TEXT PRIMARY KEY REFERENCES spend_grants(id),
    maximum_network_fee_lamports TEXT NOT NULL CHECK(length(maximum_network_fee_lamports)>0
      AND maximum_network_fee_lamports NOT GLOB '*[^0-9]*' AND substr(maximum_network_fee_lamports,1,1) BETWEEN '1' AND '9'));
    CREATE TRIGGER IF NOT EXISTS mpp_grant_terms_immutable BEFORE UPDATE ON mpp_grant_terms
      BEGIN SELECT RAISE(ABORT,'MPP grant fee consent is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mpp_grant_terms_no_delete BEFORE DELETE ON mpp_grant_terms
      BEGIN SELECT RAISE(ABORT,'MPP grant fee consent history is required'); END;
    CREATE TRIGGER IF NOT EXISTS mpp_grant_terms_scheme BEFORE INSERT ON mpp_grant_terms
      WHEN NOT EXISTS(SELECT 1 FROM spend_grants WHERE id=NEW.grant_id AND payment_scheme='mpp_charge')
      BEGIN SELECT RAISE(ABORT,'MPP grant protocol mismatch'); END;
    CREATE TABLE IF NOT EXISTS mpp_challenge_claims (
      scope_id TEXT NOT NULL REFERENCES monetary_scopes(id), merchant_origin TEXT NOT NULL,
      realm TEXT NOT NULL, challenge_id TEXT NOT NULL,
      challenge_hash TEXT NOT NULL CHECK(length(challenge_hash)=64 AND challenge_hash NOT GLOB '*[^a-f0-9]*'),
      purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
      PRIMARY KEY(scope_id,merchant_origin,realm,challenge_id));
    CREATE TRIGGER IF NOT EXISTS mpp_challenge_claims_immutable BEFORE UPDATE ON mpp_challenge_claims
      BEGIN SELECT RAISE(ABORT,'MPP challenge claim is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mpp_challenge_claims_no_delete BEFORE DELETE ON mpp_challenge_claims
      BEGIN SELECT RAISE(ABORT,'MPP challenge claim history is required'); END;`);
  // ExecutionSafety may already own this connection. Guard the newly introduced
  // table just like every table that existed when it acquired the writer lease.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='execution_owner'").get()) {
    for (const table of ['mpp_grant_terms', 'mpp_challenge_claims']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
      CREATE TRIGGER IF NOT EXISTS writer_guard_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      BEGIN SELECT CASE WHEN yosh_execution_writer() IS NOT (SELECT owner_id FROM execution_owner WHERE id=1)
        THEN RAISE(ABORT,'EXECUTION_WRITER_FENCED') END; END;`);
  }
  db.prepare('INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES (?,?)').run('022_mpp_grant_fee_consent', now);
  db.prepare('INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES (?,?)').run('023_mpp_single_use_challenge', now);
}
