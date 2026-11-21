import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { monetaryScopeId, type MonetaryScope } from '../purchases/monetary-scope';

export const readScope = z.enum(['statement', 'result']);
export type ReadScope = z.infer<typeof readScope>;
export const pairingRequest = z.object({
  label: z.string().min(1).max(80).regex(/^[\p{L}\p{N}\p{M} ._()-]+$/u).refine(label => label.trim() === label),
  scopes: z.array(readScope).min(1).max(2).refine(scopes => scopes.length === new Set(scopes).size),
}).strict();
export type ReadConsent = { label: string; scopes: readonly ReadScope[]; account: string; environment: string };
export const purchasePairingRequest = pairingRequest.extend({ scopes: z.tuple([z.literal('purchase')]) });
export type PurchaseConsent = Omit<ReadConsent, 'scopes'> & { scopes: readonly ['purchase'] };
const metaFields = { id: z.uuid(), memberId: z.uuid(), environment: z.string(), createdAt: z.number().int(),
  revokedAt: z.number().int().nullable() };
const readMetadata = pairingRequest.extend(metaFields), purchaseMetadata = purchasePairingRequest.extend(metaFields);
const anyRequest = z.union([pairingRequest, purchasePairingRequest]);
const anyMetadata = z.union([readMetadata, purchaseMetadata]);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const remoteReadToken = /^yrr1_[A-Za-z0-9_-]{43}$/;
export const remotePurchaseToken = /^yrp1_[A-Za-z0-9_-]{43}$/;
const selectMetadata = `SELECT p.id,p.member_id AS memberId,p.label,p.scopes,p.environment,p.created_at AS createdAt,
  CASE WHEN m.status='REVOKED' THEN m.updated_at END AS revokedAt FROM remote_read_pairings p JOIN card_members m ON m.id=p.member_id`;
function parseMetadata(row: Record<string, unknown>) {
  return { ...row, scopes: JSON.parse(String(row.scopes)) as unknown };
}

/** Uses the owning ledger transaction; a pairing and its dedicated member either both exist or neither exists. */
export class RemoteReadPairings {
  constructor(private db: DatabaseSync) {}
  private exists() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_read_pairings'").get());
  }
  issue(memberId: string, raw: z.infer<typeof anyRequest>, scope: MonetaryScope, now: number) {
    const request = anyRequest.parse(raw), purchase = request.scopes[0] === 'purchase';
    if (purchase && scope.environment !== 'simulated') throw new Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    // Opt-in additive migration: reading older ledgers does not change or backfill them.
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_read_pairings(
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE REFERENCES card_members(id), token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL, scopes TEXT NOT NULL, monetary_scope_id TEXT NOT NULL, environment TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.prepare("INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES('p1_remote_read_pairings',?)").run(now);
    const id = randomUUID(), token = (purchase ? 'yrp1_' : 'yrr1_') + randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO remote_read_pairings(id,member_id,token_hash,label,scopes,monetary_scope_id,environment,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, memberId, digest(token), request.label, JSON.stringify(request.scopes), monetaryScopeId(scope), scope.environment, now);
    return { ...request, id, memberId, environment: scope.environment, createdAt: now, revokedAt: null, token };
  }
  list() {
    return this.exists() ? this.db.prepare(selectMetadata + ' ORDER BY p.created_at DESC,p.id').all().map(row => anyMetadata.parse(parseMetadata(row))) : [];
  }
  memberForId(id: string) {
    return this.exists() ? this.db.prepare('SELECT member_id FROM remote_read_pairings WHERE id=?').get(id)?.member_id : undefined;
  }
  belongsToMember(id: string) {
    return this.exists() && Boolean(this.db.prepare('SELECT 1 FROM remote_read_pairings WHERE member_id=?').get(id));
  }
  authenticate(token: string, scope: MonetaryScope) {
    if (remoteReadToken.test(token) && this.exists()) {
      const row = this.db.prepare(selectMetadata + " WHERE p.token_hash=? AND p.monetary_scope_id=? AND m.status='ACTIVE'")
        .get(digest(token), monetaryScopeId(scope));
      if (row) return readMetadata.parse(parseMetadata(row));
    }
    throw new Error('REMOTE_READ_UNAUTHORIZED');
  }
  authenticatePurchase(token: string, scope: MonetaryScope) {
    if (scope.environment === 'simulated' && remotePurchaseToken.test(token) && this.exists()) {
      const row = this.db.prepare(selectMetadata + " WHERE p.token_hash=? AND p.monetary_scope_id=? AND m.status='ACTIVE'")
        .get(digest(token), monetaryScopeId(scope));
      if (row) return purchaseMetadata.parse(parseMetadata(row));
    }
    throw new Error('REMOTE_PURCHASE_UNAUTHORIZED');
  }
  purchaseForId(id: string, scope: MonetaryScope) {
    if (scope.environment === 'simulated' && this.exists()) {
      const row = this.db.prepare(selectMetadata + " WHERE p.id=? AND p.monetary_scope_id=? AND m.status='ACTIVE'").get(id, monetaryScopeId(scope));
      if (row) {
        const result = purchaseMetadata.safeParse(parseMetadata(row));
        if (result.success) return result.data;
      }
    }
    throw new Error('REMOTE_PURCHASE_UNAUTHORIZED');
  }
  /** Each purchase pairing is single-generation: rotation creates a fresh pairing
   * and member. Reusing a read pairing or a revoked member cannot recreate authority. */
  purchasePrincipal(id: string, scope: MonetaryScope) {
    const pairing = this.purchaseForId(id, scope);
    return { cardMemberId: pairing.memberId, connectionId: pairing.id, connectionGeneration: 1 };
  }
}
