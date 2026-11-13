import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../payment/payment-environment';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalControlAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_wallet'), slot: z.literal('devnet'), network: z.literal(DEVNET_NETWORK), assetId: z.literal(DEVNET_USDC_MINT) }).strict(),
  z.object({ type: z.literal('connection'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('daily_limit'), amount: z.string().regex(/^(0|[1-9]\d{0,15})$/).nullable() }).strict(),
  z.object({ type: z.literal('revoke_grant'), grantId: z.uuid(), resourceId: z.string().min(1).max(200) }).strict(),
]);
export const LocalControlRequest = z.object({
  version: z.literal(1), kind: z.literal('control'), id: z.uuid(), challenge: hex, sessionHash: hex,
  createdAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
  environment: z.enum(['offline','devnet']), mode: z.literal('live_devnet'), memberId: z.uuid(),
  agentLabel: z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  basis: hex, action: LocalControlAction,
}).strict();
export type FrozenLocalControl = z.infer<typeof LocalControlRequest>;
export type LocalControlReceipt = { requestId: string; digest: string };
export const localControlBytes = (value: unknown) => JSON.stringify(LocalControlRequest.parse(value));
export const localControlDigest = (value: unknown) => createHash('sha256').update(localControlBytes(value)).digest('hex');

/** Opt-in journal on the existing ledger connection. The existing control
 * transaction consumes the receipt together with its financial policy change. */
export class LocalControlApprovals {
  constructor(private db: DatabaseSync) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS local_control_requests(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PENDING','CANCELLED','CLAIMED','CONSUMED')),consumed_at INTEGER);
      CREATE TRIGGER IF NOT EXISTS local_control_immutable BEFORE UPDATE OF id,body,digest ON local_control_requests
        BEGIN SELECT RAISE(ABORT,'frozen control is immutable'); END;
      INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES('019_local_control_confirmation',unixepoch('now')*1000);
      COMMIT;`);
  }
  freeze(input: Omit<FrozenLocalControl, 'version'|'kind'|'id'|'challenge'|'createdAt'|'expiresAt'>, now: number) {
    const request = LocalControlRequest.parse({ ...input, version: 1, kind: 'control', id: randomUUID(),
      challenge: randomBytes(32).toString('hex'), createdAt: now, expiresAt: now + 300_000 });
    const body = localControlBytes(request), digest = localControlDigest(request);
    this.db.prepare("INSERT INTO local_control_requests VALUES(?,?,?,'PENDING',NULL)").run(request.id, body, digest);
    return this.read(request.id);
  }
  read(id: string) {
    const row = this.db.prepare('SELECT * FROM local_control_requests WHERE id=?').get(z.uuid().parse(id));
    if (!row) throw new Error('LOCAL_AUTHORIZATION_NOT_FOUND');
    const request = LocalControlRequest.parse(JSON.parse(String(row.body)));
    if (request.id !== id || localControlDigest(request) !== row.digest) throw new Error('LOCAL_AUTHORIZATION_CORRUPT');
    return { request, digest: String(row.digest), state: z.enum(['PENDING','CANCELLED','CLAIMED','CONSUMED']).parse(row.state) };
  }
  cancel(id: string, sessionHash: string) {
    if (this.read(id).request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
    this.db.prepare("UPDATE local_control_requests SET state='CANCELLED' WHERE id=? AND state='PENDING'").run(id);
    return this.read(id);
  }
  assertPending(receipt: LocalControlReceipt, action: z.infer<typeof LocalControlAction>, now: number) {
    const frozen = this.read(receipt.requestId);
    if (receipt.digest !== frozen.digest || JSON.stringify(frozen.request.action) !== JSON.stringify(LocalControlAction.parse(action)))
      throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    if (frozen.state !== 'PENDING') throw new Error('LOCAL_AUTHORIZATION_ALREADY_USED');
    if (now < frozen.request.createdAt || now >= frozen.request.expiresAt) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
  }
  claimedRequests(memberId: string) {
    return this.db.prepare("SELECT id FROM local_control_requests WHERE state='CLAIMED'").all()
      .map(row => this.read(String(row.id))).filter(value => value.request.memberId === memberId);
  }
  claimExternal(receipt: LocalControlReceipt, now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const frozen = this.read(receipt.requestId);
      if (!['create_wallet','connection'].includes(frozen.request.action.type)) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
      this.assertPending(receipt, frozen.request.action, now);
      if (this.db.prepare("SELECT id FROM local_control_requests WHERE state='CLAIMED'").get()) throw new Error('LOCAL_WALLET_RECONCILIATION_REQUIRED');
      this.db.prepare("UPDATE local_control_requests SET state='CLAIMED' WHERE id=?").run(receipt.requestId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  consume(receipt: LocalControlReceipt, now: number) {
    if (this.db.prepare("UPDATE local_control_requests SET state='CONSUMED',consumed_at=? WHERE id=? AND digest=? AND state IN ('PENDING','CLAIMED')")
      .run(now, receipt.requestId, receipt.digest).changes !== 1) throw new Error('LOCAL_AUTHORIZATION_ALREADY_USED');
  }
}
