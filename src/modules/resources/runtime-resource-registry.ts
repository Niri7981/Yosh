import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentResourceRegistrationInput, ResourceDocumentationSchema } from './agent-resource-registration';
import { ResourceRequestInputSchema, authorizedRequestInstance, MAX_RESOURCE_DELIVERY_BYTES } from './http-resource';
import { SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import type { discoverResource } from './mainnet-resource-discovery';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { X402ResourceSchema, DeclarativeResourceRequestInputsSchema, assertResourceInputDefinition, resourceInputNames, type X402Resource } from './http-resource';
import { assertSupportedMainnetResourceRequest } from './supported-resource-request';
import { validateDeliveryCapability } from './delivery-capability';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../payment/payment-environment';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { registeredResourceSummary } from './registered-resources';

/** Runtime approval stores policy only. Live transaction facts are never registration inputs. */
export const RuntimeResourceSchema = X402ResourceSchema.safeExtend({
  requestInputs: DeclarativeResourceRequestInputsSchema.optional(),
  resourceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
  displayName: z.string().trim().min(1).max(120), providerId: z.string().trim().min(1).max(200),
  recipientSource: z.literal('live_challenge'), recipient: z.never().optional(), amount: z.never().optional(),
  network: z.literal(MAINNET_NETWORK), mint: z.literal(MAINNET_USDC_MINT),
  maximumAmount: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => PositiveAtomicAmountSchema.safeParse(value).success), baseAmount: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => PositiveAtomicAmountSchema.safeParse(value).success).optional(),
}).superRefine((resource, ctx) => {
  if (resource.request.access !== 'https') ctx.addIssue({ code: 'custom', message: 'RESOURCE_PUBLIC_HTTPS_REQUIRED' });
  try { assertSupportedMainnetResourceRequest(resource.request, resourceInputNames(resource.requestInputs?.jsonBody).length > 0); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'RESOURCE_BODY_POLICY_INVALID' }); }
  try { assertResourceInputDefinition(resource); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'RESOURCE_INPUT_POLICY_INVALID' }); }
  try { validateDeliveryCapability(resource.deliveryRecovery ?? { kind: 'none' }, resource.request); }
  catch { ctx.addIssue({ code: 'custom', message: 'RESOURCE_RECOVERY_INVALID' }); }
});
const State = z.enum(['ACTIVE', 'DISABLED', 'REMOVED']);
const Submission = z.object({ cardMemberId: z.string().uuid(), discoveryId: z.string().uuid(),
  discoveredAt: z.number().int(), sample: ResourceRequestInputSchema, documentation: ResourceDocumentationSchema }).strict();
const Entry = z.object({ source: z.enum(['built_in', 'user', 'agent']), submission: Submission.optional(), state: State, createdAt: z.number().int(), updatedAt: z.number().int(), definition: X402ResourceSchema });
export type RegisteredResourceEntry = z.infer<typeof Entry>;
export class ResourceRegistryError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const builtInResources: readonly X402Resource[] = [{ resourceId: 'you-web-search', providerId: 'you.com', displayName: 'You.com Web Search',
  request: { url: 'https://api.you.com/v1/search', method: 'GET', access: 'https', headers: { accept: 'application/json' } },
  requestInputs: { query: ['query'] },
  network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT, decimals: 6, recipientSource: 'live_challenge',
  baseAmount: '5000', maximumAmount: '5000', deliveryRecovery: { kind: 'none' },
  deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: MAX_RESOURCE_DELIVERY_BYTES } }];

/** Shares the existing ledger connection; immutable definitions and tombstones preserve references. */
export class RuntimeResourceRegistry {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    this.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS resource_registry (
        resource_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('built_in','user')),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','DISABLED','REMOVED')),
        definition TEXT NOT NULL CHECK(json_valid(definition)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS resource_registry_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS resource_definition_immutable BEFORE UPDATE OF resource_id,source,definition,created_at ON resource_registry
          BEGIN SELECT RAISE(ABORT,'resource definition is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS resource_history_preserved BEFORE DELETE ON resource_registry
          BEGIN SELECT RAISE(ABORT,'resource identity must be retained'); END;`);
      // Additive metadata: existing immutable definitions, grants and payment evidence stay untouched.
      db.exec(`CREATE TABLE IF NOT EXISTS resource_discoveries (
        discovery_id TEXT PRIMARY KEY, principal TEXT NOT NULL CHECK(json_valid(principal)),
        snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), discovered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        registration TEXT CHECK(registration IS NULL OR json_valid(registration)));
        CREATE TRIGGER IF NOT EXISTS resource_discovery_immutable BEFORE UPDATE OF discovery_id,principal,snapshot,discovered_at,expires_at ON resource_discoveries
          BEGIN SELECT RAISE(ABORT,'validated discovery is immutable'); END;
        CREATE TABLE IF NOT EXISTS resource_agent_submissions (
          resource_id TEXT PRIMARY KEY REFERENCES resource_registry(resource_id),
          metadata TEXT NOT NULL CHECK(json_valid(metadata)));
        CREATE TRIGGER IF NOT EXISTS resource_submission_immutable BEFORE UPDATE ON resource_agent_submissions
          BEGIN SELECT RAISE(ABORT,'resource submission is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS resource_submission_preserved BEFORE DELETE ON resource_agent_submissions
          BEGIN SELECT RAISE(ABORT,'resource submission must be retained'); END;`);
      db.prepare("INSERT OR IGNORE INTO resource_registry_migrations VALUES ('015_agent_resource_registration',?)").run(now());
      db.prepare("INSERT OR IGNORE INTO resource_registry_migrations VALUES ('011_runtime_resources',?)").run(now());
    });
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  initialize(legacy: readonly X402Resource[]) {
    this.atomic(() => {
      if (!this.db.prepare("SELECT id FROM resource_registry_migrations WHERE id='legacy_import'").get()) {
        for (const resource of legacy) this.insert(X402ResourceSchema.parse(resource), 'built_in');
        this.db.prepare("INSERT INTO resource_registry_migrations VALUES ('legacy_import',?)").run(this.now());
      }
      // Upgrade only the original built-in route. Existing purchases retain
      // their saved exact request and quote; no grant or payment row is changed.
      if (!this.db.prepare("SELECT id FROM resource_registry_migrations WHERE id='012_builtin_request_policy'").get()) {
        const row = this.db.prepare("SELECT source,definition FROM resource_registry WHERE resource_id='you-web-search'").get();
        if (row?.source === 'built_in') {
          const prior = X402ResourceSchema.parse(JSON.parse(String(row.definition)));
          if (prior.providerId === 'you.com' && prior.request.url === 'https://api.you.com/v1/search'
            && prior.request.method === 'GET' && !prior.requestInputs) {
            this.db.exec('DROP TRIGGER resource_definition_immutable');
            this.db.prepare('UPDATE resource_registry SET definition=? WHERE resource_id=?').run(JSON.stringify({ ...prior,
              requestInputs: { query: ['query'] },
              deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: MAX_RESOURCE_DELIVERY_BYTES } }), 'you-web-search');
            this.db.exec(`CREATE TRIGGER resource_definition_immutable BEFORE UPDATE OF resource_id,source,definition,created_at ON resource_registry
              BEGIN SELECT RAISE(ABORT,'resource definition is immutable'); END;`);
          }
        }
        this.db.prepare("INSERT INTO resource_registry_migrations VALUES ('012_builtin_request_policy',?)").run(this.now());
      }
      // An existing curated ID keeps its original policy, including older grants.
      for (const resource of builtInResources) if (!this.db.prepare('SELECT resource_id FROM resource_registry WHERE resource_id=?').get(resource.resourceId)) this.insert(resource, 'built_in');
    });
  }
  private insert(definition: X402Resource, source: RegisteredResourceEntry['source']) {
    if (this.db.prepare('SELECT resource_id FROM resource_registry WHERE resource_id=?').get(definition.resourceId)) throw new ResourceRegistryError('RESOURCE_ID_EXISTS');
    if (Number(this.db.prepare("SELECT COUNT(*) AS count FROM resource_registry WHERE state='ACTIVE'").get()!.count) >= 256) throw new ResourceRegistryError('RESOURCE_REGISTRY_FULL');
    this.db.prepare("INSERT INTO resource_registry VALUES (?,?,'ACTIVE',?,?,?)").run(definition.resourceId, source, JSON.stringify(definition), this.now(), this.now());
  }
  private entry(row: Record<string, unknown>) {
    const submitted = this.db.prepare('SELECT metadata FROM resource_agent_submissions WHERE resource_id=?').get(String(row.resource_id));
    return Entry.parse({ source: submitted ? 'agent' : row.source, ...(submitted ? { submission: JSON.parse(String(submitted.metadata)) } : {}), state: row.state, createdAt: row.created_at, updatedAt: row.updated_at, definition: JSON.parse(String(row.definition)) });
  }
  list() { return this.db.prepare('SELECT * FROM resource_registry ORDER BY created_at,resource_id').all().map(row => this.entry(row)); }
  active() { return this.list().filter(entry => entry.state === 'ACTIVE').map(entry => entry.definition); }
  inspect(id: string) {
    const row = this.db.prepare('SELECT * FROM resource_registry WHERE resource_id=?').get(id);
    if (!row) throw new ResourceRegistryError('RESOURCE_NOT_FOUND');
    return this.entry(row);
  }
  add(raw: unknown) {
    const definition = RuntimeResourceSchema.parse(raw);
    this.atomic(() => this.insert({ ...definition, deliveryRecovery: definition.deliveryRecovery ?? { kind: 'none' } }, 'user'));
    return this.inspect(definition.resourceId);
  }
  recordDiscovery(result: Awaited<ReturnType<typeof discoverResource>>, principal: SpendPrincipal) {
    const actor = SpendPrincipalSchema.parse(principal);
    const discoveryId = randomUUID(); const discoveredAt = this.now(); const expiresAt = discoveredAt + 30 * 60_000;
    this.atomic(() => {
      this.db.prepare('DELETE FROM resource_discoveries WHERE expires_at<? AND registration IS NULL').run(discoveredAt);
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM resource_discoveries WHERE registration IS NULL').get()!.count) >= 256)
        throw new ResourceRegistryError('RESOURCE_DISCOVERY_LIMIT');
      this.db.prepare('INSERT INTO resource_discoveries VALUES (?,?,?,?,?,NULL)').run(discoveryId, JSON.stringify(actor), JSON.stringify(result), discoveredAt, expiresAt);
    });
    return { ...result, discoveryId, expiresAt, registrationStatus: 'DISCOVERED' as const };
  }
  /** No outbound requests or management delegation. The discovery and insertion are consumed atomically. */
  addDiscovered(raw: unknown, principal: SpendPrincipal) {
    const input = AgentResourceRegistrationInput.parse(raw); const actor = SpendPrincipalSchema.parse(principal);
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM resource_discoveries WHERE discovery_id=?').get(input.discoveryId);
      if (!row || !isDeepStrictEqual(JSON.parse(String(row.principal)), actor)) throw new ResourceRegistryError('RESOURCE_DISCOVERY_NOT_FOUND');
      if (row.registration !== null) {
        if (!isDeepStrictEqual(JSON.parse(String(row.registration)), input)) throw new ResourceRegistryError('RESOURCE_DISCOVERY_CONSUMED');
        const entry = this.inspect(input.resourceId);
        if (entry.state !== 'ACTIVE') throw new ResourceRegistryError('RESOURCE_DISCOVERY_CONSUMED');
        return entry;
      }
      if (Number(row.expires_at) < this.now()) throw new ResourceRegistryError('RESOURCE_DISCOVERY_EXPIRED');
      const snapshot = z.object({ proposal: z.unknown(), sample: ResourceRequestInputSchema, documentation: ResourceDocumentationSchema }).parse(JSON.parse(String(row.snapshot)));
      const definition = RuntimeResourceSchema.parse({ ...z.record(z.string(), z.unknown()).parse(snapshot.proposal),
        resourceId: input.resourceId, providerId: input.providerId, displayName: input.displayName });
      authorizedRequestInstance(definition, snapshot.sample);
      // A new ID cannot evade existing registrations, including disabled/tombstoned identities.
      const identity = (resource: X402Resource) => {
        const url = new URL(resource.request.url); url.searchParams.sort();
        return { ...resource.request, url: url.href };
      };
      if (this.list().some(entry => isDeepStrictEqual(identity(entry.definition), identity(definition))
        && isDeepStrictEqual(entry.definition.requestInputs ?? {}, definition.requestInputs ?? {})))
        throw new ResourceRegistryError('RESOURCE_REQUEST_EXISTS');
      this.insert(definition, 'user');
      const submission = Submission.parse({ cardMemberId: actor.cardMemberId, discoveryId: input.discoveryId,
        discoveredAt: row.discovered_at, sample: snapshot.sample, documentation: snapshot.documentation });
      this.db.prepare('INSERT INTO resource_agent_submissions VALUES (?,?)').run(input.resourceId, JSON.stringify(submission));
      this.db.prepare('UPDATE resource_discoveries SET registration=? WHERE discovery_id=?').run(JSON.stringify(input), input.discoveryId);
      return this.inspect(input.resourceId);
    });
  }
  setState(id: string, state: 'DISABLED' | 'REMOVED') {
    this.atomic(() => {
      const entry = this.inspect(id);
      if (entry.source === 'built_in') throw new ResourceRegistryError('RESOURCE_READ_ONLY');
      if (entry.state === 'REMOVED' && state !== 'REMOVED') throw new ResourceRegistryError('RESOURCE_REMOVED');
      this.db.prepare('UPDATE resource_registry SET state=?,updated_at=? WHERE resource_id=?').run(state, this.now(), id);
    });
    return this.inspect(id);
  }
}
export function resourceEntrySummary(entry: RegisteredResourceEntry) {
  return { ...registeredResourceSummary(entry.definition), ...entry };
}
