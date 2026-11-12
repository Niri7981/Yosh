import { buildSync } from 'esbuild';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { createOfflineResourcePolicy } from '../../src/modules/pay-dev/offline-resource-policy';
import type { discoverResource } from '../../src/modules/resources/mainnet-resource-discovery';
import type { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import type { RuntimeResourceSchema } from '../../src/modules/resources/runtime-resource-registry';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { X402ResourceSchema } from '../../src/modules/resources/http-resource';

const dependency = createRequire(import.meta.url), directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-resource-admission-'))); directories.push(parent);
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const entry = join(parent, 'admission.cjs');
  buildSync({ stdin: { contents: "export {createOfflineResourcePolicy} from './src/modules/pay-dev/offline-resource-policy'; export {discoverResource} from './src/modules/resources/mainnet-resource-discovery'; export {PurchaseLedger} from './src/modules/purchases/purchase-ledger'; export {RuntimeResourceSchema} from './src/modules/resources/runtime-resource-registry';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_PLUGIN_DEV__: 'true', __YOSH_RC5__: 'false' }, outfile: entry });
  symlinkSync(resolve('node_modules'), join(parent, 'node_modules'));
  const api = z.object({ createOfflineResourcePolicy: z.custom<typeof createOfflineResourcePolicy>(), discoverResource: z.custom<typeof discoverResource>(),
    PurchaseLedger: z.custom<typeof PurchaseLedger>(), RuntimeResourceSchema: z.custom<typeof RuntimeResourceSchema>() }).parse(dependency(entry));
  vi.stubEnv('YOSH_PAY_DEV', '1'); vi.stubEnv('YOSH_PAY_DEV_ENV', 'offline'); vi.stubEnv('YOSH_DATA_DIR', directory);
  writeFileSync(join(directory, 'pay-development.json'), JSON.stringify({ version: 1, kind: 'yosh-pay-offline-development',
    buyer: '11111111111111111111111111111111', network: DEVNET_NETWORK }), { mode: 0o600 });
  const origin = 'http://127.0.0.1:14449', policy = api.createOfflineResourcePolicy(directory, origin);
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
  const target = origin + '/api/paid/plugin-snapshot?asset=SOL';
  const headers = (url: string, patch: Record<string, unknown> = {}) => new Headers({ 'payment-required': encodePaymentRequiredHeader({
    x402Version: 2, resource: { url }, accepts: [{ scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT,
      amount: '200000', payTo: '11111111111111111111111111111111', maxTimeoutSeconds: 300,
      extra: { decimals: 6, feePayer: 'ComputeBudget111111111111111111111111111111' }, ...patch }] }) });
  const discover = (patch: Record<string, unknown> = {}) => api.discoverResource(policy.discoveryInput({ url: target }),
    async url => headers(url, patch), undefined, environment, policy);
  return { ...api, directory, origin, policy, environment, target, discover };
}

it('uses the same Agent-bound expiry and one-time registration transaction while the production schema stays strict', async () => {
  const f = fixture(); let now = Date.now();
  const ledger = new f.PurchaseLedger(':memory:', { managed: true, now: () => now });
  try {
    const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
    const found = ledger.resources.recordDiscovery(await f.discover(), principal);
    const input = { discoveryId: found.discoveryId, resourceId: 'registered-fixture', providerId: 'offline', displayName: 'Offline' };
    expect(() => ledger.resources.addDiscovered(input, principal)).toThrow();
    expect(() => ledger.resources.addDiscovered(input, { ...principal, connectionGeneration: 2 }, f.policy.assertResource)).toThrow('RESOURCE_DISCOVERY_NOT_FOUND');
    const registered = ledger.resources.addDiscovered(input, principal, f.policy.assertResource);
    expect(registered.definition.request).toMatchObject({ url: f.target, access: 'test_loopback' });
    expect(f.RuntimeResourceSchema.safeParse(registered.definition).success).toBe(false);
    expect(ledger.resources.addDiscovered(input, principal, f.policy.assertResource)).toEqual(registered);
    expect(() => ledger.resources.addDiscovered({ ...input, resourceId: 'second' }, principal, f.policy.assertResource)).toThrow('RESOURCE_DISCOVERY_CONSUMED');
    const second = ledger.resources.recordDiscovery(await f.discover(), principal);
    expect(() => ledger.resources.addDiscovered({ ...input, discoveryId: second.discoveryId, resourceId: 'duplicate' }, principal, f.policy.assertResource)).toThrow('RESOURCE_REQUEST_EXISTS');
    const expired = ledger.resources.recordDiscovery(await f.discover(), principal); now += 30 * 60_000 + 1;
    expect(() => ledger.resources.addDiscovered({ ...input, discoveryId: expired.discoveryId, resourceId: 'expired' }, principal, f.policy.assertResource)).toThrow('RESOURCE_DISCOVERY_EXPIRED');
    expect(ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toEqual([]);
    expect(ledger.listForOwner(principal.cardMemberId)).toEqual([]);
  } finally { ledger.close(); }
});

it('rejects wrong mint/network, unsafe targets, extra inputs and legacy aliases without recording a proposal or authority', async () => {
  const f = fixture();
  for (const patch of [{ asset: '11111111111111111111111111111111' }, { network: 'solana:wrong-network' }, { amount: '0' }])
    await expect(f.discover(patch)).rejects.toThrow('RESOURCE_DISCOVERY_UNAVAILABLE');
  for (const url of ['https://public.example/data', 'http://127.0.0.1:13449/api/paid/plugin-snapshot?asset=SOL',
    f.target + '&extra=1', f.origin + '/api/paid/sol-market-snapshot?asset=SOL'])
    await expect(f.discoverResource(f.policy.discoveryInput({ url }), async () => { throw new Error('NETWORK_MUST_NOT_RUN'); },
      undefined, f.environment, f.policy)).rejects.toThrow();
  const definition = (await f.discover()).proposal;
  for (const resourceId of ['market-snapshot', 'token-risk-report', 'demo-sol-market-resources'])
    expect(() => f.policy.assertResource(X402ResourceSchema.parse({ ...definition, resourceId, providerId: 'offline', displayName: 'Offline' }))).toThrow('OFFLINE_RESOURCE_SCOPE_REJECTED');
  vi.stubEnv('YOSH_PAY_DEV_ENV', 'mainnet');
  expect(() => f.policy.includesUrl(f.target)).toThrow();
});
