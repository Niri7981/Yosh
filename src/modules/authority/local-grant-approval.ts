import { SolanaPublicKeySchema } from '../resources/http-resource';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../payment/payment-environment';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SpendGrantInputSchema, SpendGrantScopeSchema, SpendPrincipalSchema } from './spend-grant';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
// Untrusted Agent/API labels must not inject lines or reverse the trusted
// confirmation's text direction to disguise recipients or amounts.
const label = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const LocalGrantBinding = z.object({
  input: SpendGrantInputSchema,
  principal: SpendPrincipalSchema,
  scope: SpendGrantScopeSchema.extend({ resourceId: label, providerId: label, operation: label,
    network: label, assetId: label, payTo: label, paymentScheme: label }),
  mode: z.enum(['live_devnet', 'live_mainnet']),
}).strict();
export const LocalGrantRequest = z.object({
  version: z.literal(1), id: z.uuid(), challenge: hex,
  sessionHash: hex, createdAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
  environment: z.enum(['offline', 'devnet', 'mainnet']),
  agentLabel: label.max(120), apiLabel: label,
  // Optional for old persisted requests; new Mainnet confirmations require it.
  payerWallet: SolanaPublicKeySchema.optional(),
  resourceHash: hex, binding: LocalGrantBinding,
}).strict().refine(value => value.environment === 'mainnet'
  ? value.binding.mode === 'live_mainnet' && value.binding.scope.network === MAINNET_NETWORK
    && value.binding.scope.assetId === MAINNET_USDC_MINT
  : value.binding.mode === 'live_devnet', 'Authorization environment mismatch');
export type FrozenLocalGrant = z.infer<typeof LocalGrantRequest>;
export type LocalGrantConfirmation = { requestId: string; digest: string };

/** Zod parsing fixes field order. These UTF-8 bytes are displayed and hashed by
 * the native helper; do not re-serialize a browser-supplied object for signing. */
export function localGrantBytes(raw: unknown) { return JSON.stringify(LocalGrantRequest.parse(raw)); }
export function localGrantDigest(raw: unknown) { return digest(localGrantBytes(raw)); }
export function localGrantBindingBytes(raw: unknown) { return JSON.stringify(LocalGrantBinding.parse(raw)); }

/** Shares the purchase connection so consuming a request and inserting its
 * Grant commit in ONE existing ledger transaction. No external receipt DB. */
export class LocalGrantApprovals {
  constructor(private db: DatabaseSync) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS local_grant_requests (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PENDING','CANCELLED','CONSUMED')),
        grant_id TEXT UNIQUE, consumed_at INTEGER);
      CREATE TRIGGER IF NOT EXISTS local_grant_request_content_immutable
        BEFORE UPDATE OF id,body,digest ON local_grant_requests
        BEGIN SELECT RAISE(ABORT,'frozen authorization is immutable'); END;
      INSERT OR IGNORE INTO app_schema_migrations(id,applied_at)
        VALUES ('018_local_grant_confirmation',unixepoch('now') * 1000);
      COMMIT;`);
  }

  freeze(input: Omit<FrozenLocalGrant, 'version' | 'id' | 'challenge' | 'createdAt' | 'expiresAt'>, now: number) {
    const request = LocalGrantRequest.parse({ ...input, version: 1, id: randomUUID(),
      challenge: randomBytes(32).toString('hex'), createdAt: now, expiresAt: now + 5 * 60_000 });
    const body = localGrantBytes(request), fingerprint = digest(body);
    this.db.prepare("INSERT INTO local_grant_requests(id,body,digest,state) VALUES(?,?,?,'PENDING')")
      .run(request.id, body, fingerprint);
    return { request, digest: fingerprint, state: 'PENDING' as const, grantId: null };
  }

  read(id: string) {
    z.uuid().parse(id);
    const row = this.db.prepare('SELECT * FROM local_grant_requests WHERE id=?').get(id);
    if (!row) throw new Error('LOCAL_AUTHORIZATION_NOT_FOUND');
    const request = LocalGrantRequest.parse(JSON.parse(String(row.body)));
    if (localGrantDigest(request) !== row.digest || request.id !== id) throw new Error('LOCAL_AUTHORIZATION_CORRUPT');
    return { request, digest: String(row.digest),
      state: z.enum(['PENDING', 'CANCELLED', 'CONSUMED']).parse(row.state),
      grantId: row.grant_id === null ? null : z.uuid().parse(row.grant_id) };
  }

  cancel(id: string, sessionHash: string) {
    const value = this.read(id);
    if (value.request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
    this.db.prepare("UPDATE local_grant_requests SET state='CANCELLED' WHERE id=? AND state='PENDING'").run(id);
    return this.read(id);
  }

  assertPending(confirmation: LocalGrantConfirmation, binding: unknown, now: number) {
    const value = this.read(confirmation.requestId);
    if (value.digest !== confirmation.digest || localGrantBindingBytes(value.request.binding) !== localGrantBindingBytes(binding))
      throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    if (value.state !== 'PENDING') throw new Error('LOCAL_AUTHORIZATION_ALREADY_USED');
    if (now >= value.request.expiresAt || now < value.request.createdAt) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
    return value;
  }

  consume(confirmation: LocalGrantConfirmation, grantId: string, now: number) {
    // Caller must already hold the grant transaction and have checked binding.
    const changed = this.db.prepare("UPDATE local_grant_requests SET state='CONSUMED',grant_id=?,consumed_at=? WHERE id=? AND digest=? AND state='PENDING'")
      .run(grantId, now, confirmation.requestId, confirmation.digest).changes;
    if (changed !== 1) throw new Error('LOCAL_AUTHORIZATION_ALREADY_USED');
  }
}
