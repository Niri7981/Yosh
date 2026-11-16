import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { LocalGrantRequest, type LocalGrantConfirmation } from '../../src/modules/authority/local-grant-approval';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { X402ResourceSchema } from '../../src/modules/resources/http-resource';
import { mppFixture } from '../helpers/mpp-fixture';

const now = 1_794_326_400_000;
const sessionHash = 'a'.repeat(64);
const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
const input = { resourceId: 'registered-api', totalLimit: '1000000', singleLimit: '200000', expiresAt: now + 86_400_000 };
const pending = z.object({ request: LocalGrantRequest, digest: z.string(), state: z.literal('PENDING'), grantId: z.null() });
const createdGrant = z.object({ id: z.uuid(), paymentScheme: z.string(), maximumNetworkFeeLamports: z.string().optional() });
const ledgers: PurchaseLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });

/** Real runtime methods and durable approval/Grant code, without starting a
 * product runtime, opening a wallet or making any RPC/merchant request. */
function fixture(mpp: boolean) {
  const f = mppFixture();
  const resource = X402ResourceSchema.parse({ resourceId: input.resourceId, providerId: 'fixture',
    ...(mpp ? { paymentProtocol: 'mpp_solana_charge' } : {}),
    request: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' },
    network: f.config.network, mint: f.config.mint, decimals: 6, recipient: f.config.merchant, amount: f.quote.amount });
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet', requireSpendGrant: true,
    defaultCardMemberId: principal.cardMemberId, now: () => now });
  ledgers.push(ledger);
  const runtime = { ledger, accepting: true, environment: f.config, walletAddress: f.config.buyer,
    registeredLive: true, offlineResources: undefined, authorityWalletStatus: 'available', dependencies: { now: () => now },
    localGrantEnvironment: () => 'devnet', purchaseExecutionMode: () => 'live_devnet',
    registeredResource: (id: string) => id === resource.resourceId ? resource : undefined,
    activeResourceDefinitions: () => [resource], connectionFor: () => ({ principal: () => principal }),
    mppDependencies: vi.fn(() => ({ binary: '/fixture/protocol' })),
    quoteMppResource: vi.fn(async () => f.quote),
    quoteRegisteredResource: vi.fn(async () => ({ amount: f.quote.amount, payTo: f.quote.payTo })) };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  const freeze = async (raw: unknown) => pending.parse(await Reflect.apply(AppRuntime.prototype.freezeLocalGrant,
    runtime, [raw, principal.cardMemberId, sessionHash]));
  const create = (raw: unknown, confirmation?: LocalGrantConfirmation): unknown => Reflect.apply(AppRuntime.prototype.createSpendGrant,
    runtime, [raw, principal.cardMemberId, confirmation]);
  const commit = (confirmation: LocalGrantConfirmation): unknown => Reflect.apply(AppRuntime.prototype.commitLocalGrant,
    runtime, [confirmation, sessionHash]);
  return { ledger, runtime, freeze, create, commit };
}

it.each([true, false])('rejects %s protocol fee-consent mismatch at both runtime Grant entry points before quoting', async mpp => {
  const f = fixture(mpp);
  const mismatched = { ...input, ...(mpp ? {} : { maximumNetworkFeeLamports: '10001' }) };
  await expect(f.freeze(mismatched)).rejects.toThrow('MPP_NETWORK_FEE_CONSENT_REQUIRED');
  expect(() => f.create(mismatched)).toThrow('MPP_NETWORK_FEE_CONSENT_REQUIRED');
  expect(f.runtime.quoteMppResource).not.toHaveBeenCalled();
  expect(f.runtime.quoteRegisteredResource).not.toHaveBeenCalled();
  expect(f.runtime.mppDependencies).not.toHaveBeenCalled();
  expect(f.ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toEqual([]);
});

it('freezes MPP fee scope and forwards that frozen consent through actual runtime commit exactly once', async () => {
  const f = fixture(true);
  const frozen = await f.freeze({ ...input, maximumNetworkFeeLamports: '10001' });
  expect(frozen.request.binding.scope).toMatchObject({ paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: '10001' });
  expect(frozen.request.binding.input).not.toHaveProperty('maximumNetworkFeeLamports');
  expect(f.runtime.quoteMppResource).toHaveBeenCalledExactlyOnceWith(input.resourceId, {}, principal.cardMemberId);
  expect(f.runtime.quoteRegisteredResource).not.toHaveBeenCalled();
  const confirmation = { requestId: frozen.request.id, digest: frozen.digest };
  const grant = createdGrant.parse(await f.commit(confirmation));
  expect(grant).toMatchObject({ paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: '10001' });
  expect(f.ledger.localGrantApprovals().read(frozen.request.id)).toMatchObject({ state: 'CONSUMED', grantId: grant.id });
  expect(() => f.commit(confirmation)).toThrow('LOCAL_AUTHORIZATION_ALREADY_USED');
  expect(f.ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toHaveLength(1);
  expect(f.ledger.listForAdministration()).toEqual([]);
});

it('rejects fee changes between frozen review and runtime creation without consuming the request', async () => {
  const f = fixture(true);
  const frozen = await f.freeze({ ...input, maximumNetworkFeeLamports: '10001' });
  const confirmation = { requestId: frozen.request.id, digest: frozen.digest };
  expect(() => f.create({ ...input, maximumNetworkFeeLamports: '10002' }, confirmation))
    .toThrow('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
  expect(f.ledger.localGrantApprovals().read(frozen.request.id).state).toBe('PENDING');
  expect(f.ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toEqual([]);
  expect(createdGrant.parse(await f.commit(confirmation)).maximumNetworkFeeLamports).toBe('10001');
});

it('preserves exact Grant freeze/commit with no SOL fee or MPP dependency', async () => {
  const f = fixture(false);
  const frozen = await f.freeze(input);
  expect(frozen.request.binding.scope.paymentScheme).toBe('exact');
  expect(frozen.request.binding.scope).not.toHaveProperty('maximumNetworkFeeLamports');
  const grant = createdGrant.parse(await f.commit({ requestId: frozen.request.id, digest: frozen.digest }));
  expect(grant.paymentScheme).toBe('exact'); expect(grant).not.toHaveProperty('maximumNetworkFeeLamports');
  expect(f.runtime.quoteRegisteredResource).toHaveBeenCalledExactlyOnceWith(input.resourceId, {}, principal.cardMemberId);
  expect(f.runtime.quoteMppResource).not.toHaveBeenCalled(); expect(f.runtime.mppDependencies).not.toHaveBeenCalled();
  expect(f.ledger.listForAdministration()).toEqual([]);
});
