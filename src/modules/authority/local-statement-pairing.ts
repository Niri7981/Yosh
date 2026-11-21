import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const Label = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
export const StatementRegistration = z.object({ hostId: z.uuid().toLowerCase(), label: Label }).strict();
export const StatementPairingRequest = z.object({
  version: z.literal(1), kind: z.literal('statement_pairing'), environment: z.literal('mainnet'),
  scope: z.literal('read_statement'), registrationHash: z.string().regex(/^[0-9a-f]{64}$/),
  agentLabel: Label, createdAt: z.number().int().safe(), expiresAt: z.number().int().safe(),
  challenge: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type FrozenStatementPairing = z.infer<typeof StatementPairingRequest>;
export type ConfirmStatementPairing = (request: FrozenStatementPairing, signal?: AbortSignal) => Promise<void>;
type Registration = z.infer<typeof StatementRegistration>;
type ConnectionAccess = {
  enabled: (memberId: string) => boolean;
  install: (memberId: string) => void;
  canAddStatement?: (memberId: string) => boolean;
  accepting: () => boolean;
};

/** One writer already owns this database. The registration UUID is supplied by
 * the trusted launcher, never by the model. Store/display only its fingerprint. */
export class LocalStatementPairings {
  private pending?: { hash: string; label: string; result: Promise<{ memberId: string }> };
  constructor(private db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS local_statement_pairings(
        host_hash TEXT PRIMARY KEY, agent_label TEXT NOT NULL, member_id TEXT NOT NULL UNIQUE REFERENCES card_members(id));
        INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES('local_statement_pairings_v1',unixepoch('now')*1000);
        `);
      if (!db.prepare('PRAGMA table_info(local_statement_pairings)').all().some(row => row.name === 'statement_allowed'))
        db.exec('ALTER TABLE local_statement_pairings ADD COLUMN statement_allowed INTEGER NOT NULL DEFAULT 1');
      db.exec("INSERT OR IGNORE INTO app_schema_migrations(id,applied_at) VALUES('local_pairing_scopes_v2',unixepoch('now')*1000); COMMIT");
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  owns(memberId: string) {
    return !!this.db.prepare('SELECT 1 FROM local_statement_pairings WHERE member_id=?').get(memberId);
  }

  registration(input: Registration) {
    const {hostId, label} = StatementRegistration.parse(input);
    const hash = createHash('sha256').update(hostId).digest('hex');
    const row = this.db.prepare('SELECT member_id,agent_label FROM local_statement_pairings WHERE host_hash=?').get(hash);
    if (row && row.agent_label !== label) throw new Error('LOCAL_STATEMENT_IDENTITY_MISMATCH');
    return { hash, label, memberId: row ? z.uuid().parse(row.member_id) : undefined };
  }

  mayRead(memberId: string) {
    return this.db.prepare('SELECT statement_allowed FROM local_statement_pairings WHERE member_id=?').get(memberId)?.statement_allowed === 1;
  }

  publish(input: Registration, memberId: string, scope: 'read_statement' | 'request_purchase', install: (id: string) => void, withinGrant = false) {
    const registration = this.registration(input), now = Date.now();
    if (registration.memberId && registration.memberId !== memberId) throw new Error('LOCAL_STATEMENT_IDENTITY_MISMATCH');
    if (!withinGrant) this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!registration.memberId) {
        this.db.prepare("INSERT INTO card_members (id,label,status,is_default,created_at,updated_at) VALUES (?,?,'ACTIVE',0,?,?)")
          .run(memberId, registration.label, now, now);
        this.db.prepare('INSERT INTO local_statement_pairings(host_hash,agent_label,member_id,statement_allowed) VALUES(?,?,?,?)')
          .run(registration.hash, registration.label, memberId, scope === 'read_statement' ? 1 : 0);
      } else if (scope === 'read_statement') {
        this.db.prepare('UPDATE local_statement_pairings SET statement_allowed=1 WHERE member_id=?').run(memberId);
      }
      install(memberId);
      if (!withinGrant) this.db.exec('COMMIT');
    } catch (error) { if (!withinGrant) this.db.exec('ROLLBACK'); throw error; }
  }

  async pair(input: Registration, confirm: ConfirmStatementPairing, access: ConnectionAccess, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('LOCAL_STATEMENT_REQUEST_CANCELLED');
    const {label, hash, memberId} = this.registration(input);
    if (!access.accepting()) throw new Error('LOCAL_STATEMENT_SERVICE_STOPPING');
    if (memberId) {
      if (access.enabled(memberId)) return { memberId };
      if (!access.canAddStatement?.(memberId)) throw new Error('LOCAL_STATEMENT_CONNECTION_REVOKED');
    }
    if (this.pending) {
      if (this.pending.hash === hash && this.pending.label === label) return this.pending.result;
      throw new Error('LOCAL_CONFIRMATION_BUSY');
    }
    const create = async () => {
      const createdAt = Date.now(), expiresAt = createdAt + 120_000;
      await confirm(Object.freeze(StatementPairingRequest.parse({
        version: 1, kind: 'statement_pairing', environment: 'mainnet', scope: 'read_statement',
        registrationHash: hash, agentLabel: label, createdAt, expiresAt, challenge: randomBytes(32).toString('hex'),
      })), signal);
      if (signal?.aborted) throw new Error('LOCAL_STATEMENT_REQUEST_CANCELLED');
      if (Date.now() >= expiresAt || Date.now() < createdAt) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
      if (!access.accepting()) throw new Error('LOCAL_STATEMENT_SERVICE_STOPPING');
      if (memberId && !access.canAddStatement?.(memberId)) throw new Error('LOCAL_STATEMENT_CONNECTION_REVOKED');
      const id = memberId ?? randomUUID();
      this.publish(input, id, 'read_statement', access.install);
      return {memberId: id};
    };
    const result = create();
    this.pending = { hash, label, result };
    try { return await result; } finally { this.pending = undefined; }
  }
}
