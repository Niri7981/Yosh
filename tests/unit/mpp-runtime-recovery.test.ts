import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import * as fs from 'node:fs';
import type { RuntimeResourceSchema } from '../../src/modules/resources/runtime-resource-registry';
import type { z } from 'zod';

const state = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
vi.mock('../../src/modules/purchases/approved-payment', async original => ({
  ...await original<typeof import('../../src/modules/purchases/approved-payment')>(), recoverApprovedPayment: state.recover,
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('allows verified standalone MPP without consulting an installed App reader', () => {
  const stat = vi.mocked(fs.lstatSync).mockImplementation(() => { throw new Error('APP_ACCESS_FORBIDDEN'); });
  const runtime = { environment: { isProduction: true },
    hosting: { kind: 'mainnet-standalone', mppProtocolEnginePath: '/verified/mpp-protocol-engine' } };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  expect(Reflect.apply(Reflect.get(AppRuntime.prototype, 'mppDependencies'), runtime, []))
    .toEqual({ binary: '/verified/mpp-protocol-engine' });
  expect(stat).not.toHaveBeenCalled();
});

it.each(['recoverOnStartup', 'retryDueDeliveries'])('threads the trusted Mainnet adapter through %s without environment or prepare/fetch injection', async method => {
  vi.stubEnv('YOSH_MPP_PROTOCOL_ENGINE', undefined);
  const item = { requestId: 'original-001', ownerCardMemberId: 'member' };
  const record = { status: 'PAID', intent: { mpp: { protocol: 'mpp' }, httpRequest: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' } } };
  const ledger = { recoverUnclaimedExternalAuthorizationsOnStartup: vi.fn(), recoverUnsubmittedOnStartup: vi.fn(), recoverSubmittedOnStartup: vi.fn(),
    recoverDeliveryClaimsOnStartup: vi.fn(), reconciliation: { recoverClaimsOnStartup: vi.fn() },
    pendingRecovery: () => [item], dueDeliveryRecovery: () => [item], getOwned: () => record };
  const runtime = { ledger, accepting: true, environment: { isProduction: true },
    hosting: { kind: 'mainnet-standalone', mppProtocolEnginePath: '/verified/mpp-protocol-engine' },
    dependencies: { mpp: { binary: '/untrusted/engine', prepare: vi.fn() }, fetcher: vi.fn() },
    initializeWallet: async () => ({ address: 'payer' }), paymentConfiguration: () => ({ mode: 'live_mainnet', buyer: 'payer' }),
    purchaseExecutionMode: () => 'live_mainnet', reconciliationAbort: new AbortController(), scheduleDeliveryRecovery: vi.fn() };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  await Reflect.apply(Reflect.get(AppRuntime.prototype, method), runtime, ['http://127.0.0.1:13449']);
  expect(state.recover).toHaveBeenCalledOnce();
  const options: unknown = state.recover.mock.calls[0][6];
  expect(options).toMatchObject({ binary: '/verified/mpp-protocol-engine' });
  expect(options).not.toHaveProperty('prepare'); expect(options).not.toHaveProperty('fetcher', runtime.dependencies.fetcher);
});

const environment = { isProduction: true, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  asset: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } };
const hosting = { kind: 'mainnet-standalone', mppProtocolEnginePath: '/verified/mpp-protocol-engine' };
const resource = { resourceId: 'mpp-api', displayName: 'MPP', providerId: 'fixture', paymentProtocol: 'mpp_solana_charge',
  request: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' },
  network: environment.network, mint: environment.asset.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '1000' };

it('allows MPP registration with verified standalone capability and rejects it without capability before persistence', () => {
  const add = vi.fn((definition: z.infer<typeof RuntimeResourceSchema>) => ({ definition, source: 'user', state: 'ACTIVE', createdAt: 1, updatedAt: 1 }));
  const runtime: { accepting: boolean; environment: typeof environment; hosting?: typeof hosting; ledger: { resources: { add: typeof add } } } =
    { accepting: true, environment, hosting, ledger: { resources: { add } } };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  expect(Reflect.apply(AppRuntime.prototype.addRegisteredResource, runtime, [resource])).toMatchObject({ resourceId: resource.resourceId });
  expect(add).toHaveBeenCalledOnce(); add.mockClear();
  runtime.hosting = undefined;
  expect(() => Reflect.apply(AppRuntime.prototype.addRegisteredResource, runtime, [resource])).toThrow('MPP_MAINNET_ACCEPTANCE_REQUIRED');
  expect(add).not.toHaveBeenCalled();
});

it('requires verified standalone capability before first-start MPP resource import', () => {
  const initialize = vi.fn();
  const runtime: { environment: typeof environment; hosting?: typeof hosting; ledger: { resources: { list: () => never[]; initialize: typeof initialize } } } =
    { environment, ledger: { resources: { list: () => [], initialize } } };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const importResources = () => Reflect.apply(Reflect.get(AppRuntime.prototype, 'initializeRegisteredResources'), runtime, []);
  expect(importResources).toThrow('MPP_MAINNET_ACCEPTANCE_REQUIRED'); expect(initialize).not.toHaveBeenCalled();
  runtime.hosting = hosting;
  expect(importResources).not.toThrow();
  expect(initialize).toHaveBeenCalledWith([expect.objectContaining({ resourceId: resource.resourceId, paymentProtocol: 'mpp_solana_charge' })], environment.network);
});
