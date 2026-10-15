import { TransactionSignatureSchema, validateSignedPaymentIdentity } from '../payment/original-payment-evidence';
import { OriginalPaymentRecordSchema, OriginalPaymentStateSchema, type OriginalPaymentRecord, type StoredOriginalPayment } from './original-payment-record';
import { migrateOriginalPaymentEvidence } from './original-payment-migration';
import { migrateHttpPurchaseBindings } from './http-binding-migration';
import { initializeDeliveryState, migrateDeliveryRecovery } from './delivery-migration';
import { migrateMainnetAuthority } from './mainnet-authority-migration';
import { DeliveryRecoveryStateSchema, DELIVERY_RETRY_LIMIT, ReceiptStatusSchema, type DeliveryStatus, type DeliveryRecoveryState, type ReceiptStatus } from './delivery-state';
import { DeliveryRecoveryCapabilitySchema, type DeliveryRecoveryCapability } from '../resources/delivery-capability';
import { atomicAmount, addAtomic, remainingAtomic } from '../authority/atomic-money';
import { MonetaryScopeSchema, monetaryScope, monetaryScopeId, PRODUCT_MAINNET_WALLET_ID, PRODUCT_TEST_WALLET_ID, LEGACY_TEST_WALLET_ID, type MonetaryScope } from './monetary-scope';
import { migrateMonetaryLedger, storeMonetaryScope } from './monetary-migration';
import { RuntimeResourceRegistry } from '../resources/runtime-resource-registry';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { address } from '@solana/kit';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { CardMemberSchema, type CardMember } from '../authority/card-member';
import { DEFAULT_SPENDING_POLICY, evaluateSpendAuthority, parseStoredAuthorityDecision, type AuthorityDecision, type SpendingControls } from '../authority/authority-policy';
import { parseStoredSpendIntent, type SpendIntent } from '../authority/spend-intent';
import { LEGACY_MARKET_SNAPSHOT_OPERATION, PAID_RESOURCE_PURCHASE_OPERATION, SpendGrantInputSchema, SpendGrantSchema, SpendGrantScopeSchema, SpendPrincipalSchema, parseGrantAmount, type SpendAuthorityBinding, type SpendGrant, type SpendGrantInput, type SpendGrantScope, type SpendPrincipal } from '../authority/spend-grant';
import { PAID_RESOURCE_SCOPE_ID, PaidResourceIdSchema, paidResource } from '../resources/paid-resources';
import { PREMIUM_SOL_MARKET_SNAPSHOT_ID } from '../resources/static-resource-registry';
import { hash, nextSpendingDayBoundary, spendingDay } from './spending-policy';
import { MAINNET_NETWORK, MAINNET_USDC_MINT, PurchaseExecutionModeSchema, type PurchaseExecutionMode } from '../payment/payment-environment';

export type { DeliveryStatus } from './delivery-state';
export { PurchaseExecutionModeSchema, type PurchaseExecutionMode } from '../payment/payment-environment';
export type StoredPurchaseExecutionMode = PurchaseExecutionMode | 'UNKNOWN';
const PaymentEvidenceFields = {
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), messageHash: z.string().regex(/^[a-f0-9]{64}$/),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/), transaction: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/),
  confirmationStatus: z.enum(['confirmed', 'finalized']), verifiedAt: z.number().int().nonnegative(),
};
const PaymentEvidencePayerSchema = z.string().refine(value => {
  try { address(value); return true; } catch { return false; }
});
export const PaymentEvidenceSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...PaymentEvidenceFields, settlementConfirmed: z.literal(true) }).strict(),
  z.object({ version: z.literal(2), ...PaymentEvidenceFields, settlementConfirmed: z.literal(true), payer: PaymentEvidencePayerSchema }).strict(),
  z.object({ version: z.literal(3), ...PaymentEvidenceFields, payer: PaymentEvidencePayerSchema,
    source: z.literal('buyer_rpc'), transaction: TransactionSignatureSchema, settlementConfirmed: z.boolean(), originalEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    scopeId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type PaymentEvidence = z.infer<typeof PaymentEvidenceSchema>;
export type PaymentVerification = { payer: string; messageHash: string; confirmationStatus: 'confirmed' | 'finalized'; settlementConfirmed: true };
export type SpendReservation = {
  monetaryScope: MonetaryScope; intent: SpendIntent; quote: PaymentRequirements; approvalId: string; decision: AuthorityDecision; status: string; deliveryStatus: DeliveryStatus;
  executionMode: StoredPurchaseExecutionMode; paymentPayloadPresent: boolean; paymentPayloadHash?: string; paymentEvidence?: PaymentEvidence;
  receiptStatus: ReceiptStatus; deliveryRecovery: DeliveryRecoveryState;
  ownerCardMemberId?: string; transaction?: string; data?: unknown; answer?: string;
};
/** Compatibility name for callers that still expose the market purchase use case. */
export type PurchaseRecord = SpendReservation;
export type PurchaseLedgerOptions = { mode?: StoredPurchaseExecutionMode; walletIdentity?: string; managed?: boolean; requireRegisteredResource?: boolean; requireSpendGrant?: boolean; timeZone?: () => string; now?: () => number; defaultCardMemberId?: string };
export type SpendGrantSummary = {
  id: string; version: number; status: SpendGrant['status']; resourceId: string; providerId: string; operation: string;
  network: string; assetId: string; assetDecimals: number; payTo: string; paymentScheme: string; totalLimit: string; singleLimit: string;
  committed: string; remaining: string; createdAt: number; expiresAt: number; revokedAt: number | null;
};
function currentAuthorityStatus(status: string) {
  if (status === 'REJECTED') return 'DENIED';
  if (status === 'NEEDS_CONFIRMATION') return 'REQUIRES_APPROVAL';
  return status;
}
function storedExecutionMode(value: unknown): StoredPurchaseExecutionMode {
  const parsed = PurchaseExecutionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'UNKNOWN';
}
function storedPaymentEvidence(value: unknown): PaymentEvidence | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = PaymentEvidenceSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
/** Production authority always names its scope explicitly; ambient mode is never consent. */
function assertExplicitAuthority(mode?: StoredPurchaseExecutionMode, network?: string, asset?: string) {
  if ((network === MAINNET_NETWORK || asset === MAINNET_USDC_MINT) && mode !== 'live_mainnet') {
    throw new Error('MAINNET_AUTHORITY_SCOPE_REQUIRED');
  }
}
function isLiveMode(mode: StoredPurchaseExecutionMode | undefined) {
  return mode === 'live_devnet' || mode === 'live_mainnet';
}
/** SQLite owns approval, budget reservation and the unique task purchase. No model writes. */
export class PurchaseLedger {
  private db: DatabaseSync;
  readonly resources: RuntimeResourceRegistry;
  private managed: boolean;
  private requireSpendGrant: boolean;
  private requireRegisteredResource: boolean;
  private timeZone: () => string;
  private now: () => number;
  private defaultCardMemberId?: string;
  private stopping = false;
  private walletIdentity: string;
  private defaultMode: StoredPurchaseExecutionMode;
  constructor(path = '.data/day5-ledger.sqlite', options: PurchaseLedgerOptions = {}) {
    this.managed = options.managed ?? false;
    this.defaultMode = options.mode ?? 'UNKNOWN';
    this.walletIdentity = options.walletIdentity ?? (this.managed ? PRODUCT_TEST_WALLET_ID : LEGACY_TEST_WALLET_ID);
    this.requireRegisteredResource = options.requireRegisteredResource ?? false;
    this.requireSpendGrant = options.requireSpendGrant ?? false;
    if (this.requireSpendGrant && !this.managed) throw new Error('Spend grant enforcement requires a managed ledger');
    this.timeZone = options.timeZone ?? (() => 'Asia/Shanghai');
    this.now = options.now ?? Date.now;
    this.defaultCardMemberId = options.defaultCardMemberId;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE,
        purchase TEXT NOT NULL, quote TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL,
        amount INTEGER NOT NULL, confirmed_day TEXT, transaction_id TEXT, data TEXT, payload TEXT, owner_card_member_id TEXT,
        execution_mode TEXT CHECK(execution_mode IN ('simulated','live_devnet')), payment_evidence TEXT);
      CREATE TABLE IF NOT EXISTS purchase_answers (purchase_id TEXT PRIMARY KEY, answer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS purchase_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL);`);
    if (!this.columns('purchases').has('owner_card_member_id')) this.db.exec('ALTER TABLE purchases ADD COLUMN owner_card_member_id TEXT');
    if (!this.columns('purchases').has('execution_mode')) this.db.exec('ALTER TABLE purchases ADD COLUMN execution_mode TEXT');
    if (!this.columns('purchases').has('payment_evidence')) this.db.exec('ALTER TABLE purchases ADD COLUMN payment_evidence TEXT');
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS purchases_execution_mode_immutable
      BEFORE UPDATE OF execution_mode ON purchases
      WHEN NEW.execution_mode IS NOT OLD.execution_mode
      BEGIN SELECT RAISE(ABORT, 'purchase execution mode is immutable'); END;`);
    if (this.managed) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS app_schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK(id=1), daily_limit INTEGER, paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)));
        INSERT OR IGNORE INTO app_settings (id,daily_limit,paused) VALUES (1,NULL,0);
        CREATE TABLE IF NOT EXISTS app_budget_clock (id INTEGER PRIMARY KEY CHECK(id=1), spending_day TEXT NOT NULL, time_zone TEXT NOT NULL, next_boundary INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS spend_grants (id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, connection_id TEXT NOT NULL, connection_generation INTEGER NOT NULL,
          resource_id TEXT NOT NULL, provider_id TEXT NOT NULL, operation TEXT NOT NULL, network TEXT NOT NULL, asset_id TEXT NOT NULL, asset_decimals INTEGER NOT NULL,
          pay_to TEXT NOT NULL, payment_scheme TEXT NOT NULL,
          total_limit INTEGER NOT NULL, single_limit INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS spend_grant_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL);
        INSERT OR IGNORE INTO app_schema_migrations (id,applied_at) VALUES ('001_app_controls',unixepoch('now') * 1000);
        INSERT OR IGNORE INTO app_schema_migrations (id,applied_at) VALUES ('002_spend_grants',unixepoch('now') * 1000);
        INSERT OR IGNORE INTO app_schema_migrations (id,applied_at) VALUES ('004_purchase_execution_isolation',unixepoch('now') * 1000);
        COMMIT;`);
      this.migrateCardMemberIdentity();
      this.migrateMemberScopedPurchasesAndGrants();
      const now = this.now(); const zone = this.timeZone();
      this.db.prepare('INSERT OR IGNORE INTO app_budget_clock (id,spending_day,time_zone,next_boundary,last_seen) VALUES (1,?,?,?,?)')
        .run(spendingDay(now, zone), zone, nextSpendingDayBoundary(now, zone), now);
    }
    try { migrateMonetaryLedger(this.db, this.managed, this.walletIdentity, this.now()); migrateOriginalPaymentEvidence(this.db, this.now()); migrateHttpPurchaseBindings(this.db, this.now()); migrateDeliveryRecovery(this.db, this.now()); migrateMainnetAuthority(this.db, this.managed, this.now()); this.migrateResourceScopedGrants(); this.migratePostGrantConsent(); this.resources = new RuntimeResourceRegistry(this.db, this.now); }
    catch (error) { this.db.close(); throw error; }
  }
  scope(mode: StoredPurchaseExecutionMode = this.defaultMode, network?: string, asset?: string, decimals = 6,
    walletIdentity = mode === 'live_mainnet' ? PRODUCT_MAINNET_WALLET_ID : this.walletIdentity) {
    return monetaryScope(mode === 'UNKNOWN' ? 'legacy_test' : mode, walletIdentity, network, asset, decimals);
  }
  paymentScope(config: { network: string; mint: string; buyer: string }, mode: StoredPurchaseExecutionMode) {
    return this.scope(mode, config.network, config.mint, 6, mode === 'live_mainnet' ? PRODUCT_MAINNET_WALLET_ID : this.managed ? this.walletIdentity : config.buyer);
  }
  private scopeFilter(scope: MonetaryScope) { return ` AND monetary_scope_id='${monetaryScopeId(scope)}'`; }
  private recordScope(scopeId: string): MonetaryScope {
    const row = this.db.prepare('SELECT * FROM monetary_scopes WHERE id=?').get(scopeId);
    if (!row) throw new Error('MONETARY_SCOPE_MISSING');
    const scope = MonetaryScopeSchema.parse({ environment: row.environment, walletIdentity: row.wallet_identity,
      network: row.network, assetId: row.asset_id, assetDecimals: Number(row.asset_decimals) });
    if (monetaryScopeId(scope) !== scopeId) throw new Error('MONETARY_SCOPE_MISMATCH');
    return scope;
  }
  private sumMoney(where: string, ...params: (string | number)[]) {
    let total = 0n;
    for (const row of this.db.prepare(`SELECT amount FROM purchases WHERE ${where}`).all(...params)) total = addAtomic(total, atomicAmount(row.amount));
    return total;
  }
  private columns(table: string) {
    return new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
  }
  private migrateCardMemberIdentity() {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS card_members (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_default_card_member ON card_members(is_default) WHERE is_default=1;
        CREATE TABLE IF NOT EXISTS legacy_connection_card_members (
          connection_id TEXT PRIMARY KEY, card_member_id TEXT NOT NULL REFERENCES card_members(id));`);
      if (!this.columns('spend_grants').has('card_member_id')) this.db.exec('ALTER TABLE spend_grants ADD COLUMN card_member_id TEXT');
      if (!this.columns('purchases').has('owner_card_member_id')) this.db.exec('ALTER TABLE purchases ADD COLUMN owner_card_member_id TEXT');

      if (!this.db.prepare('SELECT id FROM card_members WHERE is_default=1').get()) {
        this.db.prepare("INSERT INTO card_members (id,label,status,is_default,created_at,updated_at) VALUES (?,?,'ACTIVE',1,?,?)")
          .run(this.defaultCardMemberId ?? randomUUID(), 'Codex', now, now);
      }

      const historical = new Set<string>();
      for (const row of this.db.prepare('SELECT DISTINCT connection_id FROM spend_grants WHERE card_member_id IS NULL').all()) historical.add(String(row.connection_id));
      for (const row of this.db.prepare(`SELECT DISTINCT json_extract(purchase,'$.authority.connectionId') AS connection_id FROM purchases
        WHERE owner_card_member_id IS NULL AND json_valid(purchase) AND json_extract(purchase,'$.authority.connectionId') IS NOT NULL`).all()) {
        historical.add(String(row.connection_id));
      }
      for (const connectionId of historical) {
        let mapping = this.db.prepare('SELECT card_member_id FROM legacy_connection_card_members WHERE connection_id=?').get(connectionId);
        if (!mapping) {
          const cardMemberId = randomUUID();
          this.db.prepare("INSERT INTO card_members (id,label,status,is_default,created_at,updated_at) VALUES (?,?,'ACTIVE',0,?,?)")
            .run(cardMemberId, `Imported Codex connection ${connectionId.slice(0, 8)}`, now, now);
          this.db.prepare('INSERT INTO legacy_connection_card_members (connection_id,card_member_id) VALUES (?,?)').run(connectionId, cardMemberId);
          mapping = { card_member_id: cardMemberId };
        }
        const cardMemberId = String(mapping.card_member_id);
        this.db.prepare('UPDATE spend_grants SET card_member_id=? WHERE connection_id=? AND card_member_id IS NULL').run(cardMemberId, connectionId);
        this.db.prepare(`UPDATE purchases SET owner_card_member_id=? WHERE owner_card_member_id IS NULL AND json_valid(purchase)
          AND json_extract(purchase,'$.authority.connectionId')=?`).run(cardMemberId, connectionId);
      }
      this.db.prepare("INSERT OR IGNORE INTO app_schema_migrations (id,applied_at) VALUES ('003_stable_card_member',?)").run(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private migrateMemberScopedPurchasesAndGrants() {
    if (this.db.prepare("SELECT id FROM app_schema_migrations WHERE id='005_member_scope'").get()) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // SQLite cannot remove the old inline UNIQUE(task_id) constraint. Copy every
      // row, including unknown payments and signed payloads, before replacing it.
      this.db.exec(`CREATE TABLE purchases_member_scope (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE,
        purchase TEXT NOT NULL, quote TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL,
        amount INTEGER NOT NULL, confirmed_day TEXT, transaction_id TEXT, data TEXT, payload TEXT, owner_card_member_id TEXT,
        execution_mode TEXT CHECK(execution_mode IN ('simulated','live_devnet')), payment_evidence TEXT);
        INSERT INTO purchases_member_scope SELECT id,task_id,approval_id,purchase,quote,decision,status,amount,confirmed_day,
          transaction_id,data,payload,owner_card_member_id,execution_mode,payment_evidence FROM purchases;
        DROP TABLE purchases;
        ALTER TABLE purchases_member_scope RENAME TO purchases;
        CREATE UNIQUE INDEX purchase_request_per_member ON purchases(owner_card_member_id,task_id) WHERE owner_card_member_id IS NOT NULL;
        CREATE UNIQUE INDEX legacy_purchase_request_unique ON purchases(task_id) WHERE owner_card_member_id IS NULL;
        CREATE TRIGGER purchases_execution_mode_immutable BEFORE UPDATE OF execution_mode ON purchases
          WHEN NEW.execution_mode IS NOT OLD.execution_mode
          BEGIN SELECT RAISE(ABORT, 'purchase execution mode is immutable'); END;
        DROP INDEX IF EXISTS one_active_spend_grant;
        CREATE UNIQUE INDEX one_active_spend_grant_per_member ON spend_grants(card_member_id) WHERE status='ACTIVE';`);
      this.db.prepare("INSERT INTO app_schema_migrations (id,applied_at) VALUES ('005_member_scope',?)").run(this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private migrateResourceScopedGrants() {
    if (!this.managed || this.db.prepare("SELECT id FROM app_schema_migrations WHERE id='013_resource_scoped_grants'").get()) return;
    this.atomic(() => {
      this.db.exec(`DROP INDEX IF EXISTS one_active_spend_grant_per_member;
        CREATE UNIQUE INDEX one_active_spend_grant_per_member_resource ON spend_grants(card_member_id,monetary_scope_id,resource_id) WHERE status='ACTIVE';`);
      this.db.prepare("INSERT INTO app_schema_migrations (id,applied_at) VALUES ('013_resource_scoped_grants',?)").run(this.now());
    });
  }
  private migratePostGrantConsent() {
    if (!this.managed || this.db.prepare("SELECT id FROM app_schema_migrations WHERE id='014_post_grant_consent'").get()) return;
    this.atomic(() => {
      // Add evidence only; historical grants remain unchanged and have no inferred POST consent.
      this.db.exec('ALTER TABLE spend_grants ADD COLUMN post_policy_hash TEXT');
      this.db.prepare("INSERT INTO app_schema_migrations (id,applied_at) VALUES ('014_post_grant_consent',?)").run(this.now());
    });
  }
  private event(id: string, type: string) { this.db.prepare('INSERT INTO purchase_events (purchase_id,type,at) VALUES (?,?,?)').run(id, type, Date.now()); }
  private grantEvent(id: string, type: string, at = this.now()) { this.db.prepare('INSERT INTO spend_grant_events (grant_id,type,at) VALUES (?,?,?)').run(id, type, at); }
  private expireGrants(now: number) {
    if (!this.managed) return;
    const rows = this.db.prepare("UPDATE spend_grants SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at<=? RETURNING id").all(now);
    for (const row of rows) this.grantEvent(String(row.id), 'grant.EXPIRED', now);
  }
  private parseGrantRow(row: Record<string, unknown>): SpendGrant {
    return SpendGrantSchema.parse({
      id: String(row.id), version: Number(row.version), cardMemberId: String(row.card_member_id), connectionId: String(row.connection_id), connectionGeneration: Number(row.connection_generation),
      resourceId: String(row.resource_id), providerId: String(row.provider_id), operation: String(row.operation), network: String(row.network), assetId: String(row.asset_id),
      assetDecimals: Number(row.asset_decimals), payTo: String(row.pay_to), paymentScheme: String(row.payment_scheme), totalLimit: String(row.total_limit), singleLimit: String(row.single_limit), status: String(row.status),
      ...(typeof row.post_policy_hash === 'string' ? { postPolicyHash: row.post_policy_hash } : {}),
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    });
  }
  private parseCardMemberRow(row: Record<string, unknown>): CardMember {
    return CardMemberSchema.parse({ id: String(row.id), label: String(row.label), status: String(row.status),
      isDefault: Boolean(row.is_default), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
  }
  defaultCardMember() {
    if (!this.managed) throw new Error('CardMember identity requires a managed ledger');
    const row = this.db.prepare('SELECT * FROM card_members WHERE is_default=1').get();
    if (!row) throw new Error('Default CardMember is missing');
    return this.parseCardMemberRow(row);
  }
  cardMember(id: string) {
    if (!this.managed) return undefined;
    const row = this.db.prepare('SELECT * FROM card_members WHERE id=?').get(id);
    return row ? this.parseCardMemberRow(row) : undefined;
  }
  cardMembers() {
    if (!this.managed) return [];
    return this.db.prepare('SELECT * FROM card_members ORDER BY is_default DESC, created_at, id').all().map(row => this.parseCardMemberRow(row));
  }
  createCardMember(label: string, now = this.now()) {
    if (!this.managed) throw new Error('CardMember identity requires a managed ledger');
    const cleanLabel = CardMemberSchema.shape.label.parse(label);
    const id = randomUUID();
    this.atomic(() => this.db.prepare("INSERT INTO card_members (id,label,status,is_default,created_at,updated_at) VALUES (?,?,'ACTIVE',0,?,?)")
      .run(id, cleanLabel, now, now));
    return this.cardMember(id)!;
  }
  renameCardMember(id: string, label: string, now = this.now()) {
    const cleanLabel = CardMemberSchema.shape.label.parse(label);
    const changed = this.atomic(() => this.db.prepare("UPDATE card_members SET label=?,updated_at=? WHERE id=? AND status='ACTIVE'").run(cleanLabel, now, id).changes);
    if (!changed) throw new Error('CARD_MEMBER_NOT_ACTIVE');
    return this.cardMember(id)!;
  }
  isCardMemberActive(id: string) { return this.cardMember(id)?.status === 'ACTIVE'; }
  assertCardMemberActive(id: string) {
    if (!this.isCardMemberActive(id)) throw new Error('CARD_MEMBER_REVOKED');
  }
  revokeCardMember(id: string, now = this.now()) {
    if (!this.managed) return false;
    return this.atomic(() => {
      const changed = this.db.prepare("UPDATE card_members SET status='REVOKED',updated_at=? WHERE id=? AND status='ACTIVE'").run(now, id).changes;
      const grants = this.db.prepare("UPDATE spend_grants SET status='REVOKED',revoked_at=? WHERE card_member_id=? AND status='ACTIVE' RETURNING id").all(now, id);
      for (const row of grants) this.grantEvent(String(row.id), 'grant.REVOKED_CARD_MEMBER', now);
      return changed > 0;
    });
  }
  spendGrantById(id: string) { return this.grantById(id); }
  private grantById(id: string) {
    const row = this.db.prepare('SELECT * FROM spend_grants WHERE id=?').get(id);
    return row ? this.parseGrantRow(row) : undefined;
  }
  private grantCommitted(id: string, scope: MonetaryScope) {
    // A mixed legacy grant remains quarantined, but its historical consumption
    // must not disappear when its linked test purchases have different modes.
    const filter = scope.environment === 'legacy_test'
      ? ` AND monetary_scope_id IN (SELECT id FROM monetary_scopes WHERE environment<>'live_mainnet' AND wallet_identity=? AND network=? AND asset_id=? AND asset_decimals=?)`
      : this.scopeFilter(scope);
    return this.sumMoney(`json_extract(purchase,'$.authority.grantId')=? AND status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN','PAID')${filter}`,
      id, ...(scope.environment === 'legacy_test' ? [scope.walletIdentity, scope.network, scope.assetId, scope.assetDecimals] : []));
  }
  createSpendGrant(raw: SpendGrantInput, rawPrincipal: SpendPrincipal, rawScope: SpendGrantScope, now = this.now(), mode?: PurchaseExecutionMode) {
    assertExplicitAuthority(mode, rawScope.network, rawScope.assetId);
    if (!this.managed) throw new Error('Spend grants require a managed ledger');
    const monetary = this.scope(mode, rawScope.network, rawScope.assetId, rawScope.assetDecimals);
    const input = SpendGrantInputSchema.parse(raw); const principal = SpendPrincipalSchema.parse(rawPrincipal); const scope = SpendGrantScopeSchema.parse(rawScope);
    this.assertCardMemberActive(principal.cardMemberId);
    const totalLimit = parseGrantAmount(input.totalLimit, 'totalLimit'); const singleLimit = parseGrantAmount(input.singleLimit, 'singleLimit');
    if (singleLimit > totalLimit) throw new Error('单笔上限不能大于授权总额。');
    if (input.expiresAt <= now + 60_000 || input.expiresAt > now + 7 * 24 * 60 * 60 * 1000) throw new Error('授权有效期必须在 1 分钟到 7 天之间。');
    return this.atomic(() => {
      const scopeId = storeMonetaryScope(this.db, monetary);
      this.expireGrants(now);
      const previous = this.db.prepare("UPDATE spend_grants SET status='REVOKED',revoked_at=? WHERE status='ACTIVE' AND card_member_id=? AND monetary_scope_id=? AND resource_id=? RETURNING id").all(now, principal.cardMemberId, scopeId, scope.resourceId);
      for (const row of previous) this.grantEvent(String(row.id), 'grant.REVOKED_REPLACED', now);
      const version = Number(this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM spend_grants').get()!.version);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO spend_grants (id,version,card_member_id,connection_id,connection_generation,resource_id,provider_id,operation,network,asset_id,asset_decimals,pay_to,payment_scheme,total_limit,single_limit,status,created_at,expires_at,revoked_at,monetary_scope_id,post_policy_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE',?,?,NULL,?,?)`).run(id, version, principal.cardMemberId, principal.connectionId, principal.connectionGeneration, scope.resourceId, scope.providerId,
        scope.operation, scope.network, scope.assetId, scope.assetDecimals, scope.payTo, scope.paymentScheme, totalLimit, singleLimit, now, input.expiresAt, scopeId, scope.postPolicyHash ?? null);
      this.grantEvent(id, 'grant.CREATED', now);
      return this.latestGrantSummary(now, mode, principal.cardMemberId, monetary, scope.resourceId)!;
    });
  }
  revokeActiveSpendGrant(now = this.now(), event = 'grant.REVOKED', memberId?: string, resourceId?: string) {
    if (!this.managed) return false;
    return this.atomic(() => {
      const rows = memberId
        ? this.db.prepare(`UPDATE spend_grants SET status='REVOKED',revoked_at=? WHERE status='ACTIVE' AND card_member_id=? ${resourceId ? 'AND resource_id=?' : ''} RETURNING id`).all(now, memberId, ...(resourceId ? [resourceId] : []))
        : this.db.prepare("UPDATE spend_grants SET status='REVOKED',revoked_at=? WHERE status='ACTIVE' RETURNING id").all(now);
      for (const row of rows) this.grantEvent(String(row.id), event, now);
      return rows.length > 0;
    });
  }
  activeSpendGrant(now = this.now(), memberId?: string, mode?: PurchaseExecutionMode, resourceId?: string) {
    if (!this.managed) return undefined;
    return this.atomic(() => {
      this.expireGrants(now);
      const row = memberId
        ? this.db.prepare(`SELECT * FROM spend_grants WHERE status='ACTIVE' AND card_member_id=? AND monetary_scope_id=? ${resourceId ? 'AND resource_id=?' : ''} ORDER BY version DESC LIMIT 1`).get(memberId, monetaryScopeId(this.scope(mode)), ...(resourceId ? [resourceId] : []))
        : this.db.prepare("SELECT * FROM spend_grants WHERE status='ACTIVE' AND monetary_scope_id=? ORDER BY version DESC LIMIT 1").get(monetaryScopeId(this.scope(mode)));
      return row ? this.parseGrantRow(row) : undefined;
    });
  }
  spendAuthority(principal: SpendPrincipal, operation: string, now = this.now(), mode?: PurchaseExecutionMode): SpendAuthorityBinding {
    const parsed = SpendPrincipalSchema.parse(principal); const grant = this.activeSpendGrant(now, parsed.cardMemberId, mode);
    this.assertCardMemberActive(parsed.cardMemberId);
    if (!grant || grant.cardMemberId !== parsed.cardMemberId ||
      (grant.operation !== operation && !(operation === PAID_RESOURCE_PURCHASE_OPERATION &&
        grant.operation === LEGACY_MARKET_SNAPSHOT_OPERATION && grant.resourceId === PAID_RESOURCE_SCOPE_ID))) {
      throw new Error('当前 Agent 连接没有可用的消费授权。');
    }
    return { grantId: grant.id, grantVersion: grant.version, cardMemberId: parsed.cardMemberId,
      connectionId: parsed.connectionId, connectionGeneration: parsed.connectionGeneration, operation: grant.operation };
  }
  /** Identifies the latest matching grant so policy can persist an inactive-grant denial.
   * This binding is only an input to reserve(); claim/sign still require an ACTIVE grant. */
  spendAuthorityForDecision(principal: SpendPrincipal, operation: string, now = this.now(), mode?: PurchaseExecutionMode, resourceId?: string): SpendAuthorityBinding | undefined {
    if (!this.managed) throw new Error('Spend grants require a managed ledger');
    const parsed = SpendPrincipalSchema.parse(principal);
    this.assertCardMemberActive(parsed.cardMemberId);
    return this.atomic(() => {
      this.expireGrants(now);
      // Historical grants for the registered resource scope retain their stored operation.
      const row = operation === PAID_RESOURCE_PURCHASE_OPERATION
        ? this.db.prepare(`SELECT * FROM spend_grants WHERE card_member_id=? AND monetary_scope_id=? AND (operation=? OR (operation=? AND resource_id=?)) ${resourceId ? 'AND resource_id=?' : ''} ORDER BY version DESC LIMIT 1`)
          .get(parsed.cardMemberId, monetaryScopeId(this.scope(mode)), operation, LEGACY_MARKET_SNAPSHOT_OPERATION, PAID_RESOURCE_SCOPE_ID, ...(resourceId ? [resourceId] : []))
        : this.db.prepare('SELECT * FROM spend_grants WHERE card_member_id=? AND monetary_scope_id=? AND operation=? ORDER BY version DESC LIMIT 1').get(parsed.cardMemberId, monetaryScopeId(this.scope(mode)), operation);
      if (!row) return undefined;
      const grant = this.parseGrantRow(row);
      return { grantId: grant.id, grantVersion: grant.version, cardMemberId: parsed.cardMemberId,
        connectionId: parsed.connectionId, connectionGeneration: parsed.connectionGeneration, operation: grant.operation };
    });
  }
  spendGrantSummary(now = this.now(), mode?: PurchaseExecutionMode, memberId?: string, resourceId?: string): SpendGrantSummary | null {
    if (!this.managed) return null;
    return this.atomic(() => this.latestGrantSummary(now, mode, memberId, this.scope(mode), resourceId));
  }
  spendGrantSummaries(now = this.now(), mode?: PurchaseExecutionMode, memberId?: string): SpendGrantSummary[] {
    if (!this.managed) return [];
    return this.atomic(() => {
      this.expireGrants(now);
      const scope = this.scope(mode);
      const rows = this.db.prepare(`SELECT DISTINCT resource_id FROM spend_grants WHERE monetary_scope_id=? ${memberId ? 'AND card_member_id=?' : ''}`)
        .all(monetaryScopeId(scope), ...(memberId ? [memberId] : []));
      return rows.flatMap(row => {
        const summary = this.latestGrantSummary(now, mode, memberId, scope, String(row.resource_id));
        return summary ? [summary] : [];
      });
    });
  }
  private latestGrantSummary(now: number, mode?: StoredPurchaseExecutionMode, memberId?: string, scope = this.scope(mode), resourceId?: string): SpendGrantSummary | null {
    this.expireGrants(now);
    const row = memberId
      ? this.db.prepare(`SELECT * FROM spend_grants WHERE card_member_id=? AND monetary_scope_id=? ${resourceId ? 'AND resource_id=?' : ''} ORDER BY version DESC LIMIT 1`).get(memberId, monetaryScopeId(scope), ...(resourceId ? [resourceId] : []))
      : this.db.prepare('SELECT * FROM spend_grants WHERE monetary_scope_id=? ORDER BY version DESC LIMIT 1').get(monetaryScopeId(scope));
    if (!row) return null;
    const grant = this.parseGrantRow(row); const committed = this.grantCommitted(grant.id, scope);
    return { id: grant.id, version: grant.version, status: grant.status, resourceId: grant.resourceId, providerId: grant.providerId, operation: grant.operation,
      network: grant.network, assetId: grant.assetId, assetDecimals: grant.assetDecimals, payTo: grant.payTo, paymentScheme: grant.paymentScheme,
      totalLimit: String(grant.totalLimit), singleLimit: String(grant.singleLimit),
      committed: String(committed), remaining: remainingAtomic(grant.totalLimit, committed).toString(), createdAt: grant.createdAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt };
  }
  private activeDay(now: number, scope: MonetaryScope = this.scope()) {
    if (!this.managed) return spendingDay(now, this.timeZone());
    const id = storeMonetaryScope(this.db, scope);
    const zone = this.timeZone();
    this.db.prepare('INSERT OR IGNORE INTO monetary_budget_clock VALUES (?,?,?,?,?)').run(id, spendingDay(now, zone), zone, nextSpendingDayBoundary(now, zone), now);
    const row = this.db.prepare('SELECT spending_day,time_zone,next_boundary,last_seen FROM monetary_budget_clock WHERE scope_id=?').get(id)!;
    // A time-zone change does not immediately open a fresh budget. The current
    // window keeps its existing real-time midnight boundary; after that boundary
    // the new zone becomes authoritative. A wall-clock rollback never advances it.
    if (now < Number(row.last_seen)) return String(row.spending_day);
    if (now >= Number(row.next_boundary)) {
      const zone = this.timeZone(); const day = spendingDay(now, zone);
      this.db.prepare('UPDATE monetary_budget_clock SET spending_day=?,time_zone=?,next_boundary=?,last_seen=? WHERE scope_id=?')
        .run(day, zone, nextSpendingDayBoundary(now, zone), now, id);
      return day;
    }
    this.db.prepare('UPDATE monetary_budget_clock SET last_seen=? WHERE scope_id=?').run(now, id);
    return String(row.spending_day);
  }
  controls(mode?: PurchaseExecutionMode, scope: MonetaryScope = this.scope(mode)): SpendingControls {
    if (scope.environment === 'live_mainnet' && !this.managed) return { dailyBudget: null, paused: true, singleLimit: '0' };
    if (!this.managed) return { dailyBudget: DEFAULT_SPENDING_POLICY.dailyBudget, paused: false, singleLimit: DEFAULT_SPENDING_POLICY.singleLimit };
    const row = this.db.prepare('SELECT daily_limit,paused FROM monetary_controls WHERE scope_id=?').get(monetaryScopeId(scope));
    return { dailyBudget: !row || row.daily_limit === null ? null : atomicAmount(row.daily_limit).toString(), paused: row ? Boolean(row.paused) : true,
      singleLimit: scope.environment === 'live_mainnet' ? '0' : DEFAULT_SPENDING_POLICY.singleLimit };
  }
  setDailyLimit(value: string | null, mode?: PurchaseExecutionMode, scope: MonetaryScope = this.scope(mode)) {
    assertExplicitAuthority(mode, scope.network, scope.assetId);
    const parsed = value === null ? null : atomicAmount(value).toString();
    this.atomic(() => {
      const id = storeMonetaryScope(this.db, scope);
      this.db.prepare('INSERT INTO monetary_controls VALUES (?,?,?) ON CONFLICT(scope_id) DO UPDATE SET daily_limit=excluded.daily_limit').run(id, parsed, scope.environment === 'live_mainnet' ? 1 : 0);
    });
    return this.controls(mode, scope);
  }
  setPaused(paused: boolean, mode?: PurchaseExecutionMode, scope: MonetaryScope = this.scope(mode)) {
    assertExplicitAuthority(mode, scope.network, scope.assetId);
    if (typeof paused !== 'boolean') throw new Error('Paused must be a boolean');
    this.atomic(() => {
      const id = storeMonetaryScope(this.db, scope);
      this.db.prepare('INSERT INTO monetary_controls VALUES (?,NULL,?) ON CONFLICT(scope_id) DO UPDATE SET paused=excluded.paused').run(id, paused ? 1 : 0);
    });
    return this.controls(mode, scope);
  }
  stopPayments() { this.stopping = true; }
  /** Called synchronously immediately before the signer and before submission. */
  assertCanSign(approvalId: string, now = this.now(), validate?: (record: PurchaseRecord) => void) {
    if (this.stopping) throw new Error('Service is stopping');
    const row = this.db.prepare('SELECT task_id,owner_card_member_id FROM purchases WHERE approval_id=?').get(approvalId);
    const record = row ? this.get(String(row.task_id), row.owner_card_member_id ? String(row.owner_card_member_id) : undefined) : undefined;
    if (!isLiveMode(record?.executionMode)) throw new Error('PURCHASE_EXECUTION_MODE_MISMATCH');
    if (record?.status !== 'PAYING' || record.intent.expiresAt <= now) throw new Error('Approval inactive or expired');
    if (record.executionMode === 'live_mainnet' && (!this.managed || !this.requireSpendGrant)) throw new Error('MAINNET_AUTHORITY_REQUIRED');
    if (record.executionMode === 'live_mainnet' && this.requireRegisteredResource && !this.resources.active().some(resource => resource.resourceId === record.intent.resourceId)) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    validate?.(record);
    if (this.managed) {
      const controls = this.controls(undefined, record.monetaryScope);
      if (controls.paused) throw new Error('Payments were paused before submission');
      const modeFilter = this.scopeFilter(record.monetaryScope);
      const committed = this.sumMoney(`(status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN') OR (status='PAID' AND confirmed_day=?))${modeFilter}`, this.activeDay(now, record.monetaryScope));
      if (controls.dailyBudget === null || committed > atomicAmount(controls.dailyBudget)) throw new Error('Daily limit no longer covers reserved payments');
      if (this.requireSpendGrant) this.assertGrantCovers(record, now);
    }
  }
  /** Only the sole service owner calls this before accepting any requests.
   * A payload is durably saved before submission; its absence proves no submission.
   * Never run this while another process or signer can still own these claims. */
  recoverUnsubmittedOnStartup() {
    this.atomic(() => {
      const rows = this.db.prepare("UPDATE purchases SET status='FAILED' WHERE status IN ('PAYING','PAYMENT_UNKNOWN') AND ((status='PAYING' AND payload IS NULL) OR id IN (SELECT purchase_id FROM original_payments WHERE state='SIGNED_NOT_SUBMITTED' AND submission_attempted_at IS NULL)) RETURNING id").all();
      for (const row of rows) this.db.prepare("UPDATE original_payments SET state='NOT_SUBMITTED' WHERE purchase_id=? AND state='SIGNED_NOT_SUBMITTED'").run(String(row.id));
      for (const row of rows) this.event(String(row.id), 'payment.FAILED_BEFORE_SUBMISSION');
    });
  }
  pendingRecovery() {
    return this.db.prepare("SELECT task_id,owner_card_member_id FROM purchases p JOIN purchase_delivery d ON d.purchase_id=p.id WHERE p.status IN ('PAYING','PAYMENT_UNKNOWN') OR (p.status='PAID' AND d.state IN ('PENDING','DELIVERING'))").all()
      .map(row => ({ requestId: String(row.task_id), ownerCardMemberId: row.owner_card_member_id ? String(row.owner_card_member_id) : undefined }));
  }
  dueDeliveryRecovery(now = this.now()) {
    return this.db.prepare(`SELECT task_id,owner_card_member_id FROM purchases p JOIN purchase_delivery d ON d.purchase_id=p.id
      WHERE p.status='PAID' AND p.execution_mode IN ('live_devnet','live_mainnet') AND d.state='PENDING' AND d.next_attempt_at<=?`).all(now)
      .map(row => ({ requestId: String(row.task_id), ownerCardMemberId: row.owner_card_member_id ? String(row.owner_card_member_id) : undefined }));
  }
  private deliveryState(purchaseId: string): DeliveryRecoveryState {
    const row = this.db.prepare('SELECT * FROM purchase_delivery WHERE purchase_id=?').get(purchaseId);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    return DeliveryRecoveryStateSchema.parse({ status: row.state, receiptStatus: row.receipt_state,
      retryCount: Number(row.retry_count), retryLimit: DELIVERY_RETRY_LIMIT, nextAttemptAt: Number(row.next_attempt_at), lastError: row.last_error });
  }
  deliveryCapability(approvalId: string): DeliveryRecoveryCapability {
    const record = this.recordForApproval(approvalId);
    const row = this.db.prepare('SELECT capability FROM purchase_delivery WHERE purchase_id=?').get(record.intent.id);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    return DeliveryRecoveryCapabilitySchema.parse(JSON.parse(String(row.capability)));
  }
  recordReceipt(approvalId: string, outcome: ReceiptStatus, receipt?: { transaction: string; network: string; payer?: string; amount?: string }) {
    this.atomic(() => {
      const record = this.recordForApproval(approvalId);
      outcome = ReceiptStatusSchema.parse(outcome);
      if (outcome === 'CONFIRMED' && (!this.hasVerifiedLivePayment(record) || !receipt || receipt.transaction !== record.transaction
        || receipt.network !== record.intent.network || (record.paymentEvidence?.version !== 1 && receipt.payer !== record.paymentEvidence?.payer)
        || (receipt.amount !== undefined && receipt.amount !== record.intent.amount))) throw new Error('SETTLEMENT_RECEIPT_BINDING_MISMATCH');
      // Once verified, a later missing/invalid response does not erase that receipt fact.
      this.db.prepare(`UPDATE purchase_delivery SET receipt_state=?,receipt=COALESCE(?,receipt)
        WHERE purchase_id=? AND receipt_state<>'CONFIRMED'`).run(outcome, receipt ? JSON.stringify(receipt) : null, record.intent.id);
    });
  }
  /** No money/authority writes. The durable claim is consumed before any recovery HTTP request. */
  claimDelivery(approvalId: string, kind: 'initial' | 'retry', validate?: (record: PurchaseRecord) => void, now = this.now()): string | undefined {
    return this.atomic(() => {
      if (this.stopping) return;
      const record = this.recordForApproval(approvalId);
      if (record.status !== 'PAID' || record.deliveryStatus !== 'PENDING') return;
      if (!this.hasVerifiedLivePayment(record)) { this.deliveryTerminal(record, 'DELIVERY_PAYMENT_EVIDENCE_INVALID', 'UNSUPPORTED'); return; }
      // Resource disablement stops new spending, not fulfillment of a paid order.
      // Delivery remains bound to the saved request, capability and payment evidence.
      validate?.(record);
      const row = this.db.prepare('SELECT * FROM purchase_delivery WHERE purchase_id=?').get(record.intent.id)!;
      if (kind === 'retry') {
        const capability = DeliveryRecoveryCapabilitySchema.parse(JSON.parse(String(row.capability)));
        if (capability.kind === 'none') { this.deliveryTerminal(record, 'DELIVERY_RECOVERY_UNSUPPORTED', 'UNSUPPORTED'); return; }
        if (Number(row.retry_count) >= DELIVERY_RETRY_LIMIT) { this.deliveryTerminal(record, 'DELIVERY_RETRY_EXHAUSTED', 'EXHAUSTED'); return; }
        if (Number(row.next_attempt_at) > now) return;
      } else if (row.initial_attempted === 1) return;
      const token = randomUUID();
      const update = this.db.prepare(`UPDATE purchase_delivery SET state='DELIVERING',claim_token=?,claim_kind=?,claim_at=?,
        retry_count=retry_count+?,initial_attempted=CASE WHEN ?='initial' THEN 1 ELSE initial_attempted END
        WHERE purchase_id=? AND state='PENDING'`).run(token, kind, now, kind === 'retry' ? 1 : 0, kind, record.intent.id);
      if (update.changes !== 1) return;
      this.event(record.intent.id, kind === 'retry' ? 'delivery.RETRY_CLAIMED' : 'delivery.INITIAL_CLAIMED');
      return token;
    });
  }
  blockDeliveryRecovery(approvalId: string, code: string, state: 'UNSUPPORTED' | 'EXHAUSTED' = 'UNSUPPORTED') {
    this.atomic(() => {
      const record = this.recordForApproval(approvalId);
      if (record.status !== 'PAID') return;
      this.deliveryTerminal(record, code, state);
    });
  }
  private deliveryTerminal(record: PurchaseRecord, code: string, state: 'UNSUPPORTED' | 'EXHAUSTED') {
    const changed = this.db.prepare("UPDATE purchase_delivery SET state=?,last_error=? WHERE purchase_id=? AND state='PENDING'").run(state, code, record.intent.id);
    if (changed.changes) this.event(record.intent.id, `delivery.${state}`);
  }
  failDeliveryAttempt(approvalId: string, token: string, code = 'DELIVERY_RESPONSE_UNAVAILABLE', now = this.now()) {
    this.atomic(() => {
      const record = this.recordForApproval(approvalId);
      const row = this.db.prepare("SELECT * FROM purchase_delivery WHERE purchase_id=? AND state='DELIVERING' AND claim_token=?").get(record.intent.id, token);
      if (!row) return; // A stale response cannot finish or release another owner's claim.
      const capability = DeliveryRecoveryCapabilitySchema.parse(JSON.parse(String(row.capability)));
      const state = capability.kind === 'none' ? 'UNSUPPORTED' : Number(row.retry_count) >= DELIVERY_RETRY_LIMIT ? 'EXHAUSTED' : 'PENDING';
      const next = row.claim_kind === 'retry' ? now + 1000 * 2 ** Math.max(0, Number(row.retry_count) - 1) : now;
      this.db.prepare(`UPDATE purchase_delivery SET state=?,claim_token=NULL,claim_kind=NULL,claim_at=NULL,next_attempt_at=?,last_error=?
        WHERE purchase_id=? AND claim_token=?`).run(state, next, state === 'UNSUPPORTED' ? 'DELIVERY_RECOVERY_UNSUPPORTED' : code, record.intent.id, token);
      this.event(record.intent.id, state === 'PENDING' ? 'delivery.RETRY_PENDING' : `delivery.${state}`);
    });
  }
  /** Sole data-directory owner only, before accepting requests. Interrupted claims
   * retain their consumed retry count; opening another SQLite handle never resets them. */
  recoverDeliveryClaimsOnStartup() {
    for (const row of this.db.prepare("SELECT p.approval_id,d.claim_token FROM purchase_delivery d JOIN purchases p ON p.id=d.purchase_id WHERE d.state='DELIVERING'").all()) {
      this.failDeliveryAttempt(String(row.approval_id), String(row.claim_token), 'DELIVERY_ATTEMPT_INTERRUPTED');
    }
  }
  get(idempotencyKey: string, memberId?: string): SpendReservation | undefined {
    const row = memberId
      ? this.db.prepare('SELECT * FROM purchases WHERE task_id=? AND owner_card_member_id=?').get(idempotencyKey, memberId)
      : this.managed
        ? this.db.prepare(`SELECT * FROM purchases WHERE task_id=? ORDER BY
          CASE WHEN owner_card_member_id=(SELECT id FROM card_members WHERE is_default=1) THEN 0 ELSE 1 END, rowid LIMIT 1`).get(idempotencyKey)
        : this.db.prepare('SELECT * FROM purchases WHERE task_id=?').get(idempotencyKey);
    if (!row) return undefined;
    const ownerCardMemberId = row.owner_card_member_id ? String(row.owner_card_member_id) : undefined;
    const intent = parseStoredSpendIntent(JSON.parse(String(row.purchase)), ownerCardMemberId);
    const monetary = this.recordScope(String(row.monetary_scope_id));
    if (atomicAmount(row.amount).toString() !== intent.amount || monetary.network !== intent.network || monetary.assetId !== intent.assetId || monetary.assetDecimals !== intent.assetDecimals) throw new Error('MONETARY_SCOPE_MISMATCH');
    const paymentPayloadPresent = typeof row.payload === 'string' && row.payload.length > 0;
    let paymentPayloadHash: string | undefined;
    if (paymentPayloadPresent) {
      try { paymentPayloadHash = hash(JSON.parse(String(row.payload))); } catch { /* Malformed legacy payloads cannot prove a live payment. */ }
    }
    const delivery = this.deliveryState(String(row.id));
    return { monetaryScope: monetary, intent, quote: JSON.parse(String(row.quote)), approvalId: String(row.approval_id), decision: parseStoredAuthorityDecision(JSON.parse(String(row.decision))), status: currentAuthorityStatus(String(row.status)),
      deliveryStatus: delivery.status, receiptStatus: delivery.receiptStatus, deliveryRecovery: delivery,
      executionMode: storedExecutionMode(row.execution_mode), paymentPayloadPresent,
      ...(paymentPayloadHash ? { paymentPayloadHash } : {}), ...(storedPaymentEvidence(row.payment_evidence) ? { paymentEvidence: storedPaymentEvidence(row.payment_evidence) } : {}),
      ...(ownerCardMemberId ? { ownerCardMemberId } : {}),
      ...(this.db.prepare("SELECT answer FROM purchase_answers WHERE purchase_id=?").get(String(row.id)) as { answer: string } | undefined),
      ...(row.transaction_id ? { transaction: String(row.transaction_id) } : {}),
      ...(row.data ? { data: z.json().parse(JSON.parse(String(row.data))) } : {}) };
  }
  private hasVerifiedPaymentProof(record: SpendReservation) {
    const evidence = record.paymentEvidence;
    return Boolean(record.status === 'PAID' && record.executionMode !== 'simulated' && record.paymentPayloadPresent && evidence
      && record.paymentPayloadHash === evidence.payloadHash && record.transaction === evidence.transaction
      && record.intent.quoteFingerprint === evidence.quoteFingerprint && (evidence.version === 3 ? this.matchesOriginalProof(record, evidence) : evidence.settlementConfirmed === true)
      && ['confirmed', 'finalized'].includes(evidence.confirmationStatus));
  }
  private hasVerifiedLivePayment(record: SpendReservation) {
    return isLiveMode(record.executionMode) && this.hasVerifiedPaymentProof(record);
  }
  assertReplayAllowed(record: SpendReservation, requestedMode: PurchaseExecutionMode, scope?: MonetaryScope) {
    if (record.executionMode !== requestedMode) throw new Error('PURCHASE_EXECUTION_MODE_MISMATCH');
    if (scope && monetaryScopeId(record.monetaryScope) !== monetaryScopeId(scope)) throw new Error('MONETARY_SCOPE_MISMATCH');
    if (isLiveMode(requestedMode) && record.status === 'PAID' && !this.hasVerifiedLivePayment(record)) {
      throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID');
    }
  }
  private hasBlockingPayment(intent: SpendIntent, scope: MonetaryScope) {
    const rows = this.db.prepare(`SELECT approval_id,status FROM purchases WHERE status IN ('PAYING','PAYMENT_UNKNOWN')${this.scopeFilter(scope)}`).all();
    for (const row of rows) {
      // Signing/submission stays serialized. An unproven legacy payment is not bounded evidence.
      if (row.status === 'PAYING') return true;
      try {
        const record = this.recordForApproval(String(row.approval_id));
        const original = this.savedOriginalPayment(record.approvalId);
        const request = record.intent.httpRequest;
        if (!isLiveMode(record.executionMode) || !original || !original.evidence.identity.genesisHash
          || original.evidence.identity.feePayer === original.evidence.identity.payer
          || !['SUBMISSION_ATTEMPTED', 'OUTCOME_UNKNOWN'].includes(original.state)
          || !request || !record.intent.x402Challenge || !intent.httpRequest
          || record.intent.resourceId === intent.resourceId
          || (new URL(request.url).origin === new URL(intent.httpRequest.url).origin
            && new URL(request.url).pathname === new URL(intent.httpRequest.url).pathname)) return true;
        // The entire immutable transfer remains reserved by the same scope/Grant queries.
        // Endpoint aliases (even different query/body/headers) cannot replace this order.
      } catch { return true; }
    }
    return false;
  }
  reserve(intent: SpendIntent, quote: PaymentRequirements, now = Date.now(), mode: StoredPurchaseExecutionMode = this.defaultMode, ownerCardMemberId?: string, monetary?: MonetaryScope): SpendReservation {
    if (mode === 'live_mainnet' && (!this.managed || !this.requireSpendGrant)) throw new Error('MAINNET_AUTHORITY_REQUIRED');
    assertExplicitAuthority(mode, intent.network, intent.assetId);
    assertExplicitAuthority(mode, quote.network, quote.asset);
    if (mode !== 'UNKNOWN') PurchaseExecutionModeSchema.parse(mode);
    intent = parseStoredSpendIntent(intent, ownerCardMemberId);
    monetary = MonetaryScopeSchema.parse(monetary ?? this.scope(mode, intent.network, intent.assetId, intent.assetDecimals));
    if (monetary.environment !== (mode === 'UNKNOWN' ? 'legacy_test' : mode) || monetary.network !== intent.network || monetary.assetId !== intent.assetId || monetary.assetDecimals !== intent.assetDecimals) throw new Error('MONETARY_SCOPE_MISMATCH');
    if (mode === 'live_mainnet' && monetaryScopeId(monetary) !== monetaryScopeId(this.scope('live_mainnet'))) throw new Error('MONETARY_SCOPE_MISMATCH');
    if (ownerCardMemberId && intent.authority && ownerCardMemberId !== intent.authority.cardMemberId) throw new Error('PURCHASE_REQUEST_OWNER_MISMATCH');
    return this.atomic(() => {
      const memberId = ownerCardMemberId ?? intent.authority?.cardMemberId;
      const existing = this.get(intent.idempotencyKey, memberId);
      if (existing) {
        if (monetaryScopeId(existing.monetaryScope) !== monetaryScopeId(monetary)) throw new Error('MONETARY_SCOPE_MISMATCH');
        if (this.requireSpendGrant && existing.ownerCardMemberId !== (ownerCardMemberId ?? intent.authority?.cardMemberId)) {
          throw new Error('PURCHASE_REQUEST_OWNER_MISMATCH');
        }
        if (mode === 'UNKNOWN') {
          if (existing.executionMode !== 'UNKNOWN') throw new Error('PURCHASE_EXECUTION_MODE_MISMATCH');
        } else this.assertReplayAllowed(existing, mode);
        if (existing.intent.requestHash !== intent.requestHash || existing.intent.executionBinding !== intent.executionBinding) throw new Error('Idempotency key belongs to another request or execution configuration');
        return existing;
      }
      const ambiguous = this.db.prepare(`SELECT id FROM purchases WHERE (execution_mode IS NULL OR monetary_scope_id IN (SELECT id FROM monetary_scopes WHERE wallet_identity=?)) AND (status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN') OR (status='PAID' AND confirmed_day=?)) AND monetary_scope_id<>? LIMIT 1`).get(LEGACY_TEST_WALLET_ID, this.activeDay(now, monetary), monetaryScopeId(monetary));
      if (ambiguous && monetary.environment !== 'legacy_test') throw new Error('LEGACY_MONETARY_SCOPE_UNRESOLVED');
      this.expireUnclaimed(now, monetary);
      const modeFilter = this.scopeFilter(monetary);
      const committed = this.sumMoney(`(status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN') OR (status='PAID' AND confirmed_day=?))${modeFilter}`, this.activeDay(now, monetary));
      const unresolved = this.hasBlockingPayment(intent, monetary);
      const controls = this.controls(undefined, monetary);
      let decision = evaluateSpendAuthority(intent, { committed, hasUnknownPayment: Boolean(unresolved) }, now, controls);
      if (this.requireSpendGrant) decision = this.evaluateGrant(intent, decision, committed, controls, now, monetary);
      this.db.prepare('INSERT INTO purchases (id,task_id,approval_id,purchase,quote,decision,status,amount,owner_card_member_id,execution_mode,monetary_scope_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(intent.id, intent.idempotencyKey, randomUUID(), JSON.stringify(intent), JSON.stringify(quote), JSON.stringify(decision), decision.decision, intent.amount,
          ownerCardMemberId ?? intent.authority?.cardMemberId ?? null, mode === 'UNKNOWN' ? null : mode, storeMonetaryScope(this.db, monetary));
      initializeDeliveryState(this.db, { id: intent.id, purchase: JSON.stringify(intent), owner: ownerCardMemberId ?? intent.authority?.cardMemberId,
        status: decision.decision, delivered: false, receiptConfirmed: false });
      this.event(intent.id, `authority.${decision.decision}`);
      return this.get(intent.idempotencyKey, memberId)!;
    });
  }
  /** Release only approvals that never reached the signer. Caller holds the write lock. */
  private expireUnclaimed(now: number, scope: MonetaryScope = this.scope()) {
    const rows = this.db.prepare(`UPDATE purchases SET status='EXPIRED' WHERE status='APPROVED' AND payload IS NULL AND json_extract(purchase,'$.expiresAt')<=?${this.scopeFilter(scope)} RETURNING id`).all(now);
    for (const row of rows) this.event(String(row.id), 'purchase.EXPIRED');
  }
  releaseExpired(now = Date.now()) { this.atomic(() => this.expireUnclaimed(now)); }
  saveAnswer(taskId: string, answer: string, memberId?: string) {
    if (!answer.trim() || answer.length > 12000) throw new Error('Invalid final answer');
    this.atomic(() => {
      const record = this.get(taskId, memberId);
      if (record?.status !== 'PAID' || !record.data) throw new Error('Answer requires paid data');
      const result = this.db.prepare('INSERT OR IGNORE INTO purchase_answers (purchase_id,answer) VALUES (?,?)').run(record.intent.id, answer);
      if (result.changes) this.event(record.intent.id, 'task.ANSWERED');
    });
  }
  claim(approvalId: string, now = this.now(), validate?: (record: PurchaseRecord) => void, expectedMode?: PurchaseExecutionMode): SpendReservation {
    return this.atomic(() => {
      if (this.stopping) throw new Error('Service is stopping');
      const row = this.db.prepare('SELECT task_id,owner_card_member_id FROM purchases WHERE approval_id=?').get(approvalId);
      if (!row) throw new Error('Unknown approval');
      const record = this.get(String(row.task_id), row.owner_card_member_id ? String(row.owner_card_member_id) : undefined)!;
      if (expectedMode && record.executionMode !== expectedMode) throw new Error('PURCHASE_EXECUTION_MODE_MISMATCH');
      if (record.status !== 'APPROVED' || record.decision.decision !== 'APPROVED' || record.intent.expiresAt <= now) throw new Error('Approval inactive or expired');
      if (record.executionMode === 'live_mainnet' && (!this.managed || !this.requireSpendGrant)) throw new Error('MAINNET_AUTHORITY_REQUIRED');
      if (record.executionMode === 'live_mainnet' && this.requireRegisteredResource && !this.resources.active().some(resource => resource.resourceId === record.intent.resourceId)) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    validate?.(record);
      if (this.managed) {
        const controls = this.controls(undefined, record.monetaryScope);
        if (controls.paused) throw new Error('Payments are paused');
        if (controls.dailyBudget === null) throw new Error('Daily limit is not set');
        const modeFilter = this.scopeFilter(record.monetaryScope);
        const committed = this.sumMoney(`(status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN') OR (status='PAID' AND confirmed_day=?))${modeFilter}`, this.activeDay(now, record.monetaryScope));
        if (committed > atomicAmount(controls.dailyBudget)) throw new Error('Daily limit no longer covers reserved payments');
        if (this.requireSpendGrant) this.assertGrantCovers(record, now);
      }
      if (this.hasBlockingPayment(record.intent, record.monetaryScope)) throw new Error('Another payment requires reconciliation');
      this.db.prepare("UPDATE purchases SET status='PAYING' WHERE approval_id=? AND status='APPROVED'").run(approvalId);
      this.event(record.intent.id, 'payment.PAYING');
      return this.get(record.intent.idempotencyKey, record.ownerCardMemberId)!;
    });
  }
  savePayload(approvalId: string, payload: unknown, validate?: (record: PurchaseRecord) => void, original?: OriginalPaymentRecord) {
    this.atomic(() => {
      this.assertCanSign(approvalId, undefined, validate);
      if (this.db.prepare("UPDATE purchases SET payload=? WHERE approval_id=? AND status='PAYING' AND payload IS NULL").run(JSON.stringify(payload), approvalId).changes !== 1) throw new Error('Payment already signed or inactive');
      if (original) this.storeOriginalPayment(approvalId, original, false);
    });
  }
  private recordForApproval(approvalId: string) {
    const row = this.db.prepare('SELECT task_id,owner_card_member_id FROM purchases WHERE approval_id=?').get(approvalId);
    if (!row) throw new Error('Unknown approval');
    return this.get(String(row.task_id), row.owner_card_member_id ? String(row.owner_card_member_id) : undefined)!;
  }
  private assertOriginalBindings(record: PurchaseRecord, original: OriginalPaymentRecord) {
    const payload = this.savedPayload(record.approvalId);
    if (!payload || original.purchaseId !== record.intent.id || original.requestId !== record.intent.idempotencyKey
      || original.scopeId !== monetaryScopeId(record.monetaryScope) || original.executionBinding !== record.intent.executionBinding
      || original.quoteFingerprint !== record.intent.quoteFingerprint || hash(payload.accepted) !== original.quoteFingerprint
      || original.payloadHash !== hash(payload) || original.identity.amount !== record.intent.amount
      || original.identity.recipient !== record.intent.payTo || original.identity.mint !== record.intent.assetId
      || original.identity.network !== record.intent.network || original.identity.decimals !== record.intent.assetDecimals
      || (record.intent.x402Challenge && (hash(payload.resource) !== hash(record.intent.x402Challenge.resource)
        || hash(payload.extensions ?? {}) !== hash(record.intent.x402Challenge.extensions ?? {})))
      || !validateSignedPaymentIdentity(payload, original.identity)) {
      throw new Error('ORIGINAL_PAYMENT_BINDING_MISMATCH');
    }
  }
  private storeOriginalPayment(approvalId: string, raw: OriginalPaymentRecord, legacy: boolean) {
    const original = OriginalPaymentRecordSchema.parse(raw); const record = this.recordForApproval(approvalId);
    if (!isLiveMode(record.executionMode)) throw new Error('PURCHASE_EXECUTION_MODE_MISMATCH');
    this.assertOriginalBindings(record, original);
    const state = legacy ? (record.status === 'PAID' ? 'CONFIRMED' : 'OUTCOME_UNKNOWN') : 'SIGNED_NOT_SUBMITTED';
    this.db.prepare('INSERT INTO original_payments VALUES (?,?,?,NULL,?)').run(record.intent.id, JSON.stringify(original), state, original.identity.knownSignature ?? null);
  }
  /** Legacy payloads have no send marker: their prior submission remains possible. */
  attachLegacyOriginalPayment(approvalId: string, original: OriginalPaymentRecord) {
    this.atomic(() => {
      const existing = this.savedOriginalPayment(approvalId);
      if (existing) { if (hash(existing.evidence) !== hash(original)) throw new Error('Original evidence already exists'); return; }
      this.storeOriginalPayment(approvalId, original, true);
    });
  }
  savedOriginalPayment(approvalId: string): StoredOriginalPayment | undefined {
    const row = this.db.prepare('SELECT o.* FROM original_payments o JOIN purchases p ON p.id=o.purchase_id WHERE p.approval_id=?').get(approvalId);
    if (!row) return undefined;
    const evidence = OriginalPaymentRecordSchema.parse(JSON.parse(String(row.evidence)));
    this.assertOriginalBindings(this.recordForApproval(approvalId), evidence);
    return { evidence, state: OriginalPaymentStateSchema.parse(row.state), submissionAttemptedAt: row.submission_attempted_at === null ? null : Number(row.submission_attempted_at),
      ...(row.transaction_id ? { transaction: String(row.transaction_id) } : {}) };
  }
  /** Only the initial owner can commit this once, immediately before its first HTTP send. */
  markSubmissionAttempt(approvalId: string, validate?: (record: PurchaseRecord) => void, now = this.now()) {
    this.atomic(() => {
      this.assertCanSign(approvalId, undefined, validate);
      const record = this.recordForApproval(approvalId);
      const original = this.savedOriginalPayment(approvalId);
      if (!original || original.state !== 'SIGNED_NOT_SUBMITTED') throw new Error('Original payment submission already started');
      if (this.db.prepare("UPDATE original_payments SET state='SUBMISSION_ATTEMPTED',submission_attempted_at=? WHERE purchase_id=? AND state='SIGNED_NOT_SUBMITTED' AND submission_attempted_at IS NULL").run(now, record.intent.id).changes !== 1) throw new Error('Original payment submission already started');
      this.event(record.intent.id, 'payment.SUBMISSION_ATTEMPTED');
    });
  }
  /** A merchant/history signature is only a search hint until its exact message is proved. */
  observeTransactionSignature(approvalId: string, signature: string, now = this.now()) {
    if (!TransactionSignatureSchema.safeParse(signature).success) throw new Error('Invalid transaction signature');
    this.atomic(() => {
      const record = this.recordForApproval(approvalId); const original = this.savedOriginalPayment(approvalId);
      if (!original) throw new Error('Original payment evidence is unavailable');
      if (this.db.prepare('INSERT OR IGNORE INTO original_payment_signatures VALUES (?,?,?)').run(record.intent.id, signature, now).changes) this.event(record.intent.id, 'payment.SIGNATURE_OBSERVED');
    });
  }
  observedTransactionSignature(approvalId: string) {
    const row = this.db.prepare('SELECT s.signature FROM original_payment_signatures s JOIN purchases p ON p.id=s.purchase_id WHERE p.approval_id=? ORDER BY s.observed_at DESC,s.rowid DESC LIMIT 1').get(approvalId);
    return row ? String(row.signature) : undefined;
  }
  private matchesOriginalProof(record: PurchaseRecord, proof: Extract<PaymentEvidence, { version: 3 }>) {
    const original = this.savedOriginalPayment(record.approvalId);
    return Boolean(original && original.state === 'CONFIRMED' && original.transaction === proof.transaction
      && proof.originalEvidenceHash === hash(original.evidence) && proof.scopeId === original.evidence.scopeId
      && proof.messageHash === original.evidence.identity.messageHash && proof.payer === original.evidence.identity.payer);
  }
  confirmOriginalPayment(approvalId: string, transaction: string, confirmationStatus: 'confirmed' | 'finalized', now = this.now()) {
    this.atomic(() => {
      const record = this.recordForApproval(approvalId); const original = this.savedOriginalPayment(approvalId);
      if (!original || !isLiveMode(record.executionMode) || (original.transaction && original.transaction !== transaction)) throw new Error('ORIGINAL_PAYMENT_BINDING_MISMATCH');
      if (record.status === 'PAID') { if (record.transaction !== transaction || !this.hasVerifiedPaymentProof(record)) throw new Error('Original transaction changed'); return; }
      if (!['PAYING','PAYMENT_UNKNOWN'].includes(record.status) || !['SUBMISSION_ATTEMPTED','OUTCOME_UNKNOWN'].includes(original.state)) throw new Error('Original payment is not recoverable');
      const proof = PaymentEvidenceSchema.parse({ version: 3, payloadHash: original.evidence.payloadHash, messageHash: original.evidence.identity.messageHash,
        quoteFingerprint: original.evidence.quoteFingerprint, transaction, payer: original.evidence.identity.payer, confirmationStatus,
        settlementConfirmed: false, source: 'buyer_rpc', originalEvidenceHash: hash(original.evidence), scopeId: original.evidence.scopeId, verifiedAt: now });
      this.db.prepare("UPDATE original_payments SET state='CONFIRMED',transaction_id=? WHERE purchase_id=?").run(transaction, record.intent.id);
      this.db.prepare("UPDATE purchases SET status='PAID',transaction_id=?,confirmed_day=?,payment_evidence=? WHERE approval_id=? AND status IN ('PAYING','PAYMENT_UNKNOWN')")
        .run(transaction, this.activeDay(now, record.monetaryScope), JSON.stringify(proof), approvalId);
      this.event(record.intent.id, 'payment.PAID');
    });
  }
  failOriginalPayment(approvalId: string, transaction: string) {
    this.atomic(() => {
      const record = this.recordForApproval(approvalId); const original = this.savedOriginalPayment(approvalId);
      if (!original || !isLiveMode(record.executionMode) || (original.transaction && original.transaction !== transaction)
        || !TransactionSignatureSchema.safeParse(transaction).success) throw new Error('ORIGINAL_PAYMENT_BINDING_MISMATCH');
      if (record.status === 'FAILED' && original.state === 'FINALIZED_FAILED') return;
      if (!['PAYING','PAYMENT_UNKNOWN'].includes(record.status) || !['SUBMISSION_ATTEMPTED','OUTCOME_UNKNOWN'].includes(original.state)) throw new Error('Original payment is not recoverable');
      this.db.prepare("UPDATE original_payments SET state='FINALIZED_FAILED',transaction_id=? WHERE purchase_id=?").run(transaction, record.intent.id);
      this.db.prepare("UPDATE purchases SET status='FAILED',transaction_id=? WHERE approval_id=?").run(transaction, approvalId);
      this.event(record.intent.id, 'payment.FAILED_ON_CHAIN');
    });
  }
  savedPayload(approvalId: string): PaymentPayload | undefined {
    const row = this.db.prepare('SELECT payload FROM purchases WHERE approval_id=?').get(approvalId);
    return row?.payload ? JSON.parse(String(row.payload)) : undefined;
  }
  failUnsubmitted(approvalId: string) {
    this.atomic(() => {
      const row = this.db.prepare("UPDATE purchases SET status='FAILED' WHERE approval_id=? AND status IN ('PAYING','PAYMENT_UNKNOWN') AND ((status='PAYING' AND payload IS NULL) OR id IN (SELECT purchase_id FROM original_payments WHERE state='SIGNED_NOT_SUBMITTED' AND submission_attempted_at IS NULL)) RETURNING id").get(approvalId);
      if (row) {
        this.db.prepare("UPDATE original_payments SET state='NOT_SUBMITTED' WHERE purchase_id=? AND state='SIGNED_NOT_SUBMITTED'").run(String(row.id));
        this.event(String(row.id), 'payment.FAILED_BEFORE_SUBMISSION');
      }
    });
  }
  failConfirmed(approvalId: string, transaction: string) {
    this.atomic(() => {
      // New evidence rows may only release authority through exact finalized proof.
      if (this.savedOriginalPayment(approvalId)) throw new Error('ORIGINAL_PAYMENT_PROOF_REQUIRED');
      const row = this.db.prepare("UPDATE purchases SET status='FAILED',transaction_id=? WHERE approval_id=? AND status IN ('PAYING','PAYMENT_UNKNOWN') RETURNING id").get(transaction, approvalId);
      if (row) this.event(String(row.id), 'payment.FAILED_ON_CHAIN');
    });
  }
  private recordConfirmation(approvalId: string, transaction: string, verification: PaymentVerification, now: number) {
    if (this.savedOriginalPayment(approvalId)) throw new Error('ORIGINAL_PAYMENT_PROOF_REQUIRED');
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(transaction) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(verification.payer)
      || !/^[a-f0-9]{64}$/.test(verification.messageHash)
      || verification.settlementConfirmed !== true || !['confirmed', 'finalized'].includes(verification.confirmationStatus)) {
      throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID');
    }
    const row = this.db.prepare('SELECT task_id,owner_card_member_id,payload,payment_evidence,status,execution_mode FROM purchases WHERE approval_id=?').get(approvalId);
    if (!row) throw new Error('Unknown approval');
    const record = this.get(String(row.task_id), row.owner_card_member_id ? String(row.owner_card_member_id) : undefined);
    if (!record || record.executionMode === 'simulated' || !row.payload) throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID');
    let payload: unknown;
    try { payload = JSON.parse(String(row.payload)); } catch { throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID'); }
    if (!payload || typeof payload !== 'object' || !('accepted' in payload)
      || hash(payload.accepted) !== record.intent.quoteFingerprint) throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID');
    if (row.status === 'PAID') {
      if (record.transaction === transaction && this.hasVerifiedPaymentProof(record)) return;
      throw new Error('Payment cannot be confirmed from this state');
    }
    const evidence = PaymentEvidenceSchema.parse({ version: 2, payloadHash: hash(payload), messageHash: verification.messageHash,
      quoteFingerprint: record.intent.quoteFingerprint, transaction, payer: verification.payer, confirmationStatus: verification.confirmationStatus,
      settlementConfirmed: true, verifiedAt: now });
    const updated = this.db.prepare("UPDATE purchases SET status='PAID',transaction_id=?,confirmed_day=?,payment_evidence=? WHERE approval_id=? AND status IN ('PAYING','PAYMENT_UNKNOWN') RETURNING id")
      .get(transaction, this.activeDay(now, record.monetaryScope), JSON.stringify(evidence), approvalId);
    if (!updated) throw new Error('Payment cannot be confirmed from this state');
    this.event(String(updated.id), 'payment.PAID');
  }
  confirmPayment(approvalId: string, transaction: string, verification: PaymentVerification, now = Date.now()) {
    this.atomic(() => this.recordConfirmation(approvalId, transaction, verification, now));
  }
  finish(approvalId: string, result: { transaction: string; data: unknown }, now = Date.now(), deliveryClaim?: string) {
    this.atomic(() => {
      const data = z.json().parse(result.data);
      const row = this.db.prepare('SELECT task_id,owner_card_member_id,status,execution_mode FROM purchases WHERE approval_id=?').get(approvalId);
      if (!row) throw new Error('Unknown approval');
      const record = this.get(String(row.task_id), row.owner_card_member_id ? String(row.owner_card_member_id) : undefined);
      if (record?.executionMode === 'simulated') {
        if (!result.transaction.startsWith('simulated-') || !['PAYING', 'PAID'].includes(record.status)) throw new Error('Simulated purchase cannot be completed from this state');
        if (record.status !== 'PAID') {
          const paid = this.db.prepare("UPDATE purchases SET status='PAID',transaction_id=?,confirmed_day=? WHERE approval_id=? AND status='PAYING' RETURNING id")
            .get(result.transaction, this.activeDay(now, record.monetaryScope), approvalId);
          if (!paid) throw new Error('Simulated purchase cannot be completed from this state');
          this.event(String(paid.id), 'payment.PAID');
        } else if (record.transaction !== result.transaction) throw new Error('Simulated transaction changed');
      } else if (!record || record.status !== 'PAID' || !this.hasVerifiedPaymentProof(record)) {
        throw new Error('LIVE_PAYMENT_EVIDENCE_INVALID');
      }
      const delivery = this.db.prepare('SELECT state,claim_token FROM purchase_delivery WHERE purchase_id=?').get(record!.intent.id)!;
      if (result.transaction !== record!.transaction && record!.executionMode !== 'simulated') throw new Error('DELIVERY_TRANSACTION_MISMATCH');
      if ((deliveryClaim && (delivery.state !== 'DELIVERING' || delivery.claim_token !== deliveryClaim))
        || (!deliveryClaim && delivery.state === 'DELIVERING')) throw new Error('DELIVERY_CLAIM_MISMATCH');
      if (delivery.state === 'COMPLETE') return;
      if (!['PENDING','NOT_PAID','DELIVERING'].includes(String(delivery.state))) throw new Error('DELIVERY_TERMINAL');
      const saved = this.db.prepare('UPDATE purchases SET data=? WHERE approval_id=? AND data IS NULL RETURNING id').get(JSON.stringify(data), approvalId);
      this.db.prepare("UPDATE purchase_delivery SET state='COMPLETE',claim_token=NULL,claim_kind=NULL,claim_at=NULL,last_error=NULL WHERE purchase_id=?").run(record!.intent.id);
      if (saved) this.event(String(saved.id), 'delivery.COMPLETE');
    });
  }
  unknown(approvalId: string, transaction?: string) {
    this.atomic(() => {
      const previous = this.db.prepare('SELECT status FROM purchases WHERE approval_id=?').get(approvalId);
      const row = this.db.prepare("UPDATE purchases SET status='PAYMENT_UNKNOWN',transaction_id=COALESCE(transaction_id,?) WHERE approval_id=? AND status IN ('PAYING','PAYMENT_UNKNOWN') RETURNING id").get(transaction ?? null, approvalId);
      if (row) this.db.prepare("UPDATE original_payments SET state='OUTCOME_UNKNOWN' WHERE purchase_id=? AND state IN ('SUBMISSION_ATTEMPTED','OUTCOME_UNKNOWN')").run(String(row.id));
      if (row && previous?.status !== 'PAYMENT_UNKNOWN') this.event(String(row.id), 'payment.PAYMENT_UNKNOWN');
    });
  }
  summary(now = Date.now(), mode?: StoredPurchaseExecutionMode) {
    const value = this.managedSummary(now, mode);
    // Compatibility presentation only; authority uses integer strings/bigint.
    return { paidUSDC: Number(value.paid) / 1_000_000, reservedUSDC: Number(value.reserved) / 1_000_000,
      remainingUSDC: value.remaining === null ? 0 : Number(value.remaining) / 1_000_000, unresolved: value.unresolved };
  }
  managedSummary(now = Date.now(), mode?: StoredPurchaseExecutionMode, scope: MonetaryScope = this.scope(mode)) {
    return this.atomic(() => {
      this.expireUnclaimed(now, scope);
      const day = this.activeDay(now, scope);
      const filter = this.scopeFilter(scope);
      const paid = this.sumMoney(`status='PAID' AND confirmed_day=?${filter}`, day);
      const reserved = this.sumMoney(`status IN ('APPROVED','PAYING','PAYMENT_UNKNOWN')${filter}`);
      const committed = addAtomic(paid, reserved);
      const controls = this.controls(undefined, scope);
      return { monetaryScope: scope, day, timeZone: this.timeZone(), dailyLimit: controls.dailyBudget,
        paid: paid.toString(), reserved: reserved.toString(), remaining: controls.dailyBudget === null ? null : remainingAtomic(controls.dailyBudget, committed).toString(), paused: controls.paused,
        unresolved: Number(this.db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE status IN ('PAYING','PAYMENT_UNKNOWN')${filter}`).get()!.n) };
    });
  }
  list(limit = 50, memberId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid record limit');
    return this.db.prepare(`SELECT p.id,p.task_id,p.status,p.amount,p.transaction_id,p.data IS NOT NULL AS delivered,p.execution_mode,
      json_extract(p.purchase,'$.createdAt') AS created_at,json_extract(p.purchase,'$.offerId') AS offer_id,
      json_extract(p.purchase,'$.resourceId') AS resource_id,json_extract(p.purchase,'$.providerId') AS provider_id,
      json_extract(p.purchase,'$.reason') AS reason,json_extract(p.decision,'$.reason') AS decision_reason,
      ms.environment AS monetary_environment,ms.network,ms.asset_id,ms.asset_decimals,
      json_extract(p.purchase,'$.currency') AS currency,
      json_extract(p.purchase,'$.authority.grantId') AS grant_id,p.owner_card_member_id
      FROM purchases p JOIN monetary_scopes ms ON ms.id=p.monetary_scope_id
      ${memberId ? 'WHERE p.owner_card_member_id=?' : ''} ORDER BY created_at DESC,p.id DESC LIMIT ?`)
      .all(...(memberId ? [memberId, limit] : [limit]))
      .map(row => { const delivery = this.deliveryState(String(row.id)); return ({ purchaseId: String(row.task_id), ownerCardMemberId: row.owner_card_member_id ? String(row.owner_card_member_id) : null,
        status: currentAuthorityStatus(String(row.status)), deliveryStatus: delivery.status, receiptStatus: delivery.receiptStatus, deliveryRecovery: delivery,
        amount: String(row.amount), createdAt: Number(row.created_at), transaction: row.transaction_id ? String(row.transaction_id) : null,
        executionMode: storedExecutionMode(row.execution_mode), monetaryEnvironment: String(row.monetary_environment),
        network: String(row.network), providerId: row.provider_id ? String(row.provider_id) : null,
        currency: row.currency ? String(row.currency) : null, assetId: row.asset_id ? String(row.asset_id) : null,
        assetDecimals: row.asset_decimals === null ? null : Number(row.asset_decimals),
        ...(row.offer_id ? { offerId: String(row.offer_id) } : {}), ...(row.resource_id ? { resourceId: String(row.resource_id) } : {}),
        ...(row.reason ? { reason: String(row.reason) } : {}),
        ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {}), ...(row.grant_id ? { grantId: String(row.grant_id) } : {}) }); });
  }
  events(taskId: string, memberId?: string) {
    return this.db.prepare(`SELECT e.sequence,e.type,e.at FROM purchase_events e JOIN purchases p ON p.id=e.purchase_id
      WHERE p.task_id=? ${memberId ? 'AND p.owner_card_member_id=?' : ''} ORDER BY e.sequence`).all(...(memberId ? [taskId, memberId] : [taskId]));
  }
  private denied(reason: string, committed: bigint, controls: SpendingControls): AuthorityDecision {
    return { decision: 'DENIED', reason, committedBefore: committed.toString(), remainingAfter: controls.dailyBudget === null ? '0' : remainingAtomic(controls.dailyBudget, committed).toString() };
  }
  private evaluateGrant(intent: SpendIntent, base: AuthorityDecision, committed: bigint, controls: SpendingControls, now: number, scope: MonetaryScope): AuthorityDecision {
    const binding = intent.authority;
    if (!binding) return this.denied('SPEND_GRANT_REQUIRED', committed, controls);
    if (!this.isCardMemberActive(binding.cardMemberId)) return this.denied('CARD_MEMBER_REVOKED', committed, controls);
    this.expireGrants(now);
    const grant = this.grantById(binding.grantId);
    if (!grant) return this.denied('SPEND_GRANT_INACTIVE', committed, controls);
    if (this.db.prepare('SELECT monetary_scope_id FROM spend_grants WHERE id=?').get(grant.id)?.monetary_scope_id !== monetaryScopeId(scope)) {
      return this.denied('SPEND_GRANT_MONETARY_SCOPE_MISMATCH', committed, controls);
    }
    if (grant.status === 'REVOKED') return this.denied('SPEND_GRANT_REVOKED', committed, controls);
    if (grant.status === 'EXPIRED' || grant.expiresAt <= now) return this.denied('SPEND_GRANT_EXPIRED', committed, controls);
    if (grant.status !== 'ACTIVE') return this.denied('SPEND_GRANT_INACTIVE', committed, controls);
    if (grant.version !== binding.grantVersion || grant.cardMemberId !== binding.cardMemberId) return this.denied('SPEND_GRANT_PRINCIPAL_MISMATCH', committed, controls);
    if (grant.operation !== binding.operation || !this.grantOperationCoversIntent(grant, intent) || !this.grantCoversResource(grant, intent) || grant.providerId !== intent.providerId || grant.network !== intent.network || grant.assetId !== intent.assetId || grant.assetDecimals !== intent.assetDecimals || grant.payTo !== intent.payTo || grant.paymentScheme !== intent.paymentScheme) {
      return this.denied('SPEND_GRANT_SCOPE_MISMATCH', committed, controls);
    }
    if (atomicAmount(intent.amount) > atomicAmount(grant.singleLimit)) return this.denied('SPEND_GRANT_SINGLE_LIMIT_EXCEEDED', committed, controls);
    const grantCommitted = this.grantCommitted(grant.id, scope);
    const grantTotal = addAtomic(grantCommitted, atomicAmount(intent.amount));
    if (grantTotal > atomicAmount(grant.totalLimit)) return this.denied('SPEND_GRANT_TOTAL_LIMIT_EXCEEDED', committed, controls);
    if (base.decision === 'REQUIRES_APPROVAL' && base.reason === 'SINGLE_LIMIT_EXCEEDED') {
      return { decision: 'APPROVED', reason: 'AUTHORITY_BUDGET_AND_GRANT_PASSED', committedBefore: base.committedBefore, remainingAfter: base.remainingAfter };
    }
    return base.decision === 'APPROVED' ? { ...base, reason: 'AUTHORITY_BUDGET_AND_GRANT_PASSED' } : base;
  }
  private assertGrantCovers(record: SpendReservation, now: number) {
    const binding = record.intent.authority;
    if (!binding) throw new Error('Spend grant is missing');
    this.assertCardMemberActive(binding.cardMemberId);
    const grant = this.grantById(binding.grantId);
    if (!grant || grant.status !== 'ACTIVE' || grant.expiresAt <= now) throw new Error('Spend grant is inactive or expired');
    if (this.db.prepare('SELECT monetary_scope_id FROM spend_grants WHERE id=?').get(grant.id)?.monetary_scope_id !== monetaryScopeId(record.monetaryScope)) throw new Error('SPEND_GRANT_MONETARY_SCOPE_MISMATCH');
    if (grant.version !== binding.grantVersion || grant.cardMemberId !== binding.cardMemberId || grant.operation !== binding.operation) {
      throw new Error('Spend grant principal changed');
    }
    const intent = record.intent;
    if (!this.grantOperationCoversIntent(grant, intent) || !this.grantCoversResource(grant, intent) || grant.providerId !== intent.providerId ||
      grant.network !== intent.network || grant.assetId !== intent.assetId || grant.assetDecimals !== intent.assetDecimals ||
      grant.payTo !== intent.payTo || grant.paymentScheme !== intent.paymentScheme || atomicAmount(intent.amount) > atomicAmount(grant.singleLimit)) {
      throw new Error('Spend grant scope or single limit changed');
    }
    const committed = this.grantCommitted(grant.id, record.monetaryScope);
    if (committed > atomicAmount(grant.totalLimit)) throw new Error('Spend grant no longer covers reserved payments');
  }
  private grantOperationCoversIntent(grant: SpendGrant, intent: SpendIntent) {
    if (grant.operation === PAID_RESOURCE_PURCHASE_OPERATION) return true;
    // Existing grants and in-flight purchases keep their original stored binding.
    return grant.operation === LEGACY_MARKET_SNAPSHOT_OPERATION &&
      (!intent.resourceScopeId || (grant.resourceId === PAID_RESOURCE_SCOPE_ID && intent.resourceScopeId === PAID_RESOURCE_SCOPE_ID));
  }
  private grantCoversResource(grant: SpendGrant, intent: SpendIntent) {
    // The App's historical 0.01 test purchase retains its former grant access;
    // it is not exposed through the current Agent purchase contract.
    if (intent.network === MAINNET_NETWORK) return !intent.resourceScopeId && grant.resourceId === intent.resourceId;
    if (!intent.resourceScopeId) return grant.resourceId === intent.resourceId ||
      (grant.resourceId === PAID_RESOURCE_SCOPE_ID && intent.resourceId === PREMIUM_SOL_MARKET_SNAPSHOT_ID);
    const id = PaidResourceIdSchema.safeParse(intent.resourceId);
    return intent.resourceScopeId === PAID_RESOURCE_SCOPE_ID && grant.resourceId === PAID_RESOURCE_SCOPE_ID &&
      id.success && intent.resourcePath === paidResource(id.data).path;
  }
  close() { this.db.close(); }
}
