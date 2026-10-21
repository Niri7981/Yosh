import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { basename, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { acquireDataDirectoryOwnership } from '../app/data-directory-owner';
import type { PurchaseRecord } from './purchase-contract';
import { hash } from './spending-policy';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExternalExecutionFactsSchema = z.object({ callerId: z.string().uuid(), operationId: z.string().min(1).max(128),
    attemptId: z.string().uuid(), factsHash: digest, requestHash: digest, quoteHash: digest }).strict();
// Match Pay's canonical wire request, not the purchase-use-case requestHash.
// The current external profile is GET only; no absent body becomes a new body.
function externalRequestHash(record: PurchaseRecord) {
    const request = record.intent.httpRequest;
    return hash(request ? { method: request.method, url: request.url,
        headers: Object.entries(request.headers).sort(([a], [b]) => a.localeCompare(b)), body: request.body ?? null } : null);
}
export type ExternalExecutionFacts = z.infer<typeof ExternalExecutionFactsSchema>;
export type ExternalExecutionPermit = ExternalExecutionFacts & {
    purchaseId: string;
    ownerId: string;
    epoch: number;
};
/** Execution metadata only; all monetary state remains in purchases/original_payments.
 * Missing rows mean historical/unattributed, never an inferred JS or Pay origin.
 * SQL triggers require connection-local functions absent from actual old writers.
 * This fences ordinary old DML, not arbitrary same-user DDL or file replacement. */
export class ExecutionSafety {
    private lease?: ReturnType<typeof acquireDataDirectoryOwnership>;
    private ownerId = randomUUID();
    private live = true;
    private enabled = false;
    constructor(private db: DatabaseSync, private path: string) {
        db.function('yosh_execution_writer', () => this.enabled && this.live ? this.ownerId : '');
        db.function('yosh_execution_lease', () => this.live && (this.lease || this.path === ':memory:') ? 1 : 0);
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='execution_owner'").get())
            this.open(false);
    }
    get active() { return this.enabled; }
    private lock() {
        if (this.path !== ':memory:' && !this.lease) {
            const canonical = realpathSync(this.path);
            this.lease = acquireDataDirectoryOwnership(dirname(canonical), `${basename(canonical)}.writer-lock`);
        }
    }
    enable(now: number) {
        if (this.enabled)
            return;
        this.open(true, now);
    }
    private open(migrate: boolean, now = Date.now()) {
        this.lock();
        try {
            this.db.exec('BEGIN IMMEDIATE');
            if (migrate)
                this.db.exec(`CREATE TABLE IF NOT EXISTS execution_owner (
        id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL CHECK(format=1), owner_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991));
        CREATE TABLE IF NOT EXISTS purchase_execution_provenance (
          purchase_id TEXT PRIMARY KEY REFERENCES purchases(id), origin TEXT NOT NULL CHECK(origin IN ('external_pay','js_x402')),
          caller_id TEXT,operation_id TEXT,attempt_id TEXT UNIQUE,facts_hash TEXT,request_hash TEXT NOT NULL,quote_hash TEXT NOT NULL,
          record_binding TEXT NOT NULL,owner_id TEXT NOT NULL,epoch INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('AUTHORIZED','CLAIMED','SIGNED','SUBMISSION_ATTEMPTED')),
          UNIQUE(caller_id,operation_id),
          CHECK(origin='js_x402' OR (caller_id IS NOT NULL AND operation_id IS NOT NULL AND attempt_id IS NOT NULL AND facts_hash IS NOT NULL)));
        CREATE TRIGGER IF NOT EXISTS execution_provenance_immutable BEFORE UPDATE OF purchase_id,origin,caller_id,operation_id,attempt_id,
          facts_hash,request_hash,quote_hash,record_binding,owner_id,epoch ON purchase_execution_provenance
          BEGIN SELECT RAISE(ABORT,'execution provenance is immutable'); END;`);
            const prior = this.db.prepare('SELECT format,epoch FROM execution_owner WHERE id=1').get();
            if (!migrate && !prior)
                throw new Error('EXECUTION_OWNER_MISSING');
            if (prior && prior.format !== 1)
                throw new Error('EXECUTION_FORMAT_UNSUPPORTED');
            const epoch = prior ? Number(prior.epoch) + 1 : 1;
            if (!Number.isSafeInteger(epoch))
                throw new Error('EXECUTION_EPOCH_EXHAUSTED');
            this.enabled = true;
            this.db.prepare('INSERT INTO execution_owner VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,epoch=excluded.epoch')
                .run(this.ownerId, epoch);
            // Guard every current durable table, including controls, grant, recovery,
            // migration and provenance writes. BEFORE INSERT also covers INSERT OR IGNORE.
            for (const row of this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
                const table = String(row.name);
                if (!/^[a-z_][a-z0-9_]*$/.test(table))
                    throw new Error('EXECUTION_SCHEMA_UNSUPPORTED');
                for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
                    const predicate = table === 'execution_owner' ? 'yosh_execution_lease()!=1'
                        : "yosh_execution_writer() IS NOT (SELECT owner_id FROM execution_owner WHERE id=1)";
                    this.db.exec(`CREATE TRIGGER IF NOT EXISTS writer_guard_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
            BEGIN SELECT CASE WHEN ${predicate} THEN RAISE(ABORT,'EXECUTION_WRITER_FENCED') END; END;`);
                }
            }
            if (migrate)
                this.db.prepare("INSERT OR IGNORE INTO ledger_schema_migrations VALUES ('018_execution_safety',?)").run(now);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            this.enabled = false;
            this.lease?.release();
            this.lease = undefined;
            throw error;
        }
    }
    invalidate() {
        if (!this.enabled)
            return;
        const { epoch } = this.snapshot();
        if (!Number.isSafeInteger(epoch + 1))
            throw new Error('EXECUTION_EPOCH_EXHAUSTED');
        // The caller's transaction owns this change. A later SQL/COMMIT failure
        // must roll back the epoch too; never mirror uncommitted state in memory.
        if (this.db.prepare('UPDATE execution_owner SET epoch=epoch+1 WHERE id=1 AND owner_id=? AND epoch=?').run(this.ownerId, epoch).changes !== 1)
            throw new Error('EXECUTION_OWNER_FENCED');
    }
    snapshot() {
        if (!this.enabled)
            throw new Error('EXECUTION_SAFETY_REQUIRED');
        const row = this.db.prepare('SELECT owner_id,epoch FROM execution_owner WHERE id=1').get();
        const epoch = Number(row?.epoch);
        if (!this.live || row?.owner_id !== this.ownerId || !Number.isSafeInteger(epoch) || epoch < 1)
            throw new Error('EXECUTION_OWNER_FENCED');
        return { ownerId: this.ownerId, epoch };
    }
    reserve(record: PurchaseRecord, external?: ExternalExecutionFacts) {
        if (!this.enabled) {
            if (external)
                throw new Error('EXECUTION_SAFETY_REQUIRED');
            return;
        }
        const current = this.snapshot();
        if (external) {
            external = ExternalExecutionFactsSchema.parse(external);
            if (external.callerId !== record.ownerCardMemberId || external.quoteHash !== hash(record.quote)
                || external.requestHash !== externalRequestHash(record))
                throw new Error('EXTERNAL_PROVENANCE_MISMATCH');
        }
        this.db.prepare('INSERT INTO purchase_execution_provenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(record.intent.id, external ? 'external_pay' : 'js_x402', external?.callerId ?? null, external?.operationId ?? null, external?.attemptId ?? null, external?.factsHash ?? null, external?.requestHash ?? hash(record.intent.httpRequest ?? null), hash(record.quote), record.intent.executionBinding, current.ownerId, current.epoch, 'AUTHORIZED');
    }
    provenance(purchaseId: string) {
        if (!this.enabled)
            return undefined;
        return this.db.prepare('SELECT * FROM purchase_execution_provenance WHERE purchase_id=?').get(purchaseId);
    }
    permit(record: PurchaseRecord): ExternalExecutionPermit {
        const row = this.provenance(record.intent.id);
        if (row?.origin !== 'external_pay')
            throw new Error('EXTERNAL_PROVENANCE_REQUIRED');
        const facts = ExternalExecutionFactsSchema.parse({ callerId: row.caller_id, operationId: row.operation_id, attemptId: row.attempt_id,
            factsHash: row.facts_hash, requestHash: row.request_hash, quoteHash: row.quote_hash });
        return { ...facts, purchaseId: record.intent.id, ownerId: String(row.owner_id), epoch: Number(row.epoch) };
    }
    assert(record: PurchaseRecord, permit?: ExternalExecutionPermit) {
        if (this.enabled)
            this.snapshot();
        const row = this.provenance(record.intent.id);
        if (row?.origin === 'js_x402') {
            const current = this.snapshot();
            if (row.owner_id !== current.ownerId || row.epoch !== current.epoch)
                throw new Error('JS_EXECUTION_FENCED');
        }
        if (row?.origin !== 'external_pay') {
            if (permit)
                throw new Error('EXTERNAL_PROVENANCE_REQUIRED');
            return;
        }
        const current = this.snapshot();
        if (!permit || hash(this.permit(record)) !== hash(permit) || permit.ownerId !== current.ownerId || permit.epoch !== current.epoch
            || row.record_binding !== record.intent.executionBinding || row.quote_hash !== hash(record.quote)
            || row.request_hash !== externalRequestHash(record))
            throw new Error('EXTERNAL_EXECUTION_FENCED');
    }
    phase(record: PurchaseRecord, phase: 'CLAIMED' | 'SIGNED' | 'SUBMISSION_ATTEMPTED') {
        if (!this.enabled)
            return;
        if (!this.provenance(record.intent.id))
            return;
        const previous = { CLAIMED: 'AUTHORIZED', SIGNED: 'CLAIMED', SUBMISSION_ATTEMPTED: 'SIGNED' }[phase];
        if (this.db.prepare('UPDATE purchase_execution_provenance SET phase=? WHERE purchase_id=? AND phase=?').run(phase, record.intent.id, previous).changes !== 1)
            throw new Error('EXECUTION_PHASE_CONFLICT');
    }
    close() { this.live = false; this.lease?.release(); this.lease = undefined; }
}
