import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLiveDevnetDevelopmentBackend } from '../../src/modules/pay-dev/live-devnet-runtime';
import { DEFAULT_DEVNET_RPC, DEFAULT_DEV_RPC } from '../../src/modules/pay-dev/environment';
import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { signedManagementRequest } from '../helpers/management-request';

const wallet = vi.hoisted(() => ({ address: undefined as string | undefined, reads: 0, provisions: 0 }));
const buyer = 'BSEDrH4umjwCKUL5TqYm69ffsSjwWcV2BXQkczVp1F52';
const recipient = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
vi.mock('../../src/modules/app-wallet/product-wallet', async original => ({
  ...await original<typeof import('../../src/modules/app-wallet/product-wallet')>(),
  readExistingProductWallets: vi.fn(async () => {
    wallet.reads++;
    // Namespace/OS-command isolation is independently covered by the VM test.
    if (process.env.YOSH_PAY_DEV_ENV === 'simulated') return [];
    return [{ id: 'devnet', label: 'Devnet · Test', address: wallet.address ?? null,
      status: wallet.address ? 'available' : 'missing' }];
  }),
  initializeEnvironmentWallet: vi.fn(async (environment: { mode: string }) => {
    if (environment.mode !== 'live_devnet') throw new Error('FIXTURE_DEVNET_ONLY');
    const reused = wallet.address !== undefined;
    if (!reused) { wallet.provisions++; wallet.address = buyer; }
    return { address: buyer, reused };
  }),
}));

const directories: string[] = [];
let backend: Awaited<ReturnType<typeof startLiveDevnetDevelopmentBackend>> | undefined;
afterEach(async () => {
  await backend?.close(); backend = undefined;
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks();
  wallet.address = undefined; wallet.reads = 0; wallet.provisions = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_PORT_UNAVAILABLE');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}

function fixture(profile: 'devnet' | 'simulated') {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-live-backend-'))); directories.push(parent);
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, profile === 'devnet' ? 'Devnet' : 'Simulated'); mkdirSync(directory, { mode: 0o700 });
  const home = join(directory, 'home'); mkdirSync(home, { mode: 0o700 }); vi.stubEnv('HOME', home);
  const mainnet = join(root, 'Mainnet'); mkdirSync(mainnet, { mode: 0o700 });
  writeFileSync(join(mainnet, 'app-ledger.sqlite'), 'mainnet-unchanged');
  writeFileSync(join(root, 'app-ledger.sqlite'), 'offline-unchanged');
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: profile,
    mainnetRiskAccepted: false, rpcUrl: DEFAULT_DEV_RPC }), { mode: 0o600 });
  const token = 'fixture-live-profile-management-token-32';
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token); vi.stubEnv('YOSH_PAY_DEV', '1'); vi.stubEnv('YOSH_PAY_DEV_ENV', profile);
  vi.stubEnv('YOSH_DATA_DIR', directory); vi.stubEnv('YOSH_EXECUTION_MODE', profile === 'devnet' ? 'live_devnet' : 'simulated');
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '0'); vi.stubEnv('SOLANA_RPC_URL', DEFAULT_DEVNET_RPC);
  if (profile === 'devnet') vi.stubEnv('YOSH_PAY_MCP_DEVNET', '1');
  const resource = { resourceId: 'devnet-data', displayName: 'Devnet data', providerId: 'fixture.example',
    request: { url: 'https://fixture.example/data', method: 'GET', access: 'https', headers: {} },
    network: DEVNET_NETWORK, mint: DEVNET_USDC_MINT, decimals: 6, recipient, amount: '1000' };
  if (profile === 'devnet') vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const nativeFetch = globalThis.fetch;
  const external = vi.fn();
  const guardedFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
    external(url.origin); throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');
  };
  vi.stubGlobal('fetch', guardedFetch);
  return { root, directory, mainnet, token, external, guardedFetch };
}

async function control(token: string, path: string, body?: object) {
  if (!backend) throw new Error('FIXTURE_BACKEND_REQUIRED');
  const request = signedManagementRequest(`${backend.origin}${path}`, token,
    body === undefined ? {} : { method: 'PUT', headers: { origin: backend.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return fetch(request);
}

it('starts genuine Devnet on the common backend, keeps stores separate, and preserves scoped grant/budget through restart', async () => {
  const f = fixture('devnet'); const port = await freePort();
  backend = await startLiveDevnetDevelopmentBackend({ directory: f.directory, port });
  expect(globalThis.fetch).toBe(f.guardedFetch);
  expect(backend.descriptor.profile).toBe('pay-mcp-devnet');
  expect(JSON.parse(readFileSync(join(f.directory, 'pay-devnet-runtime.json'), 'utf8'))).toMatchObject({ profile: 'pay-mcp-devnet' });
  expect(backend.app.execution()).toMatchObject({ mode: 'live_devnet', network: DEVNET_NETWORK,
    asset: { mint: DEVNET_USDC_MINT }, productionExecutionEnabled: false, spendingAuthorized: false });
  expect((await fetch(`${backend.origin}/api/app/overview`)).status).toBe(401);
  const overview = await (await control(f.token, '/api/app/overview')).json();
  expect(overview.service.purchaseMode).toBe('live_devnet');
  expect(overview.service.registeredResources).toEqual([expect.objectContaining({ resourceId: 'devnet-data', network: DEVNET_NETWORK })]);
  expect(wallet.provisions).toBe(0); expect(backend.app.spendGrantSummary()).toBeNull();
  expect(backend.app.ledger.controls('live_devnet').dailyBudget).toBeNull();
  // Explicit provisioning remains the existing backend operation, never startup.
  expect(await backend.app.createDevelopmentPaymentWallet()).toMatchObject({ address: buyer, reused: false });
  expect(wallet.provisions).toBe(1);
  expect(backend.app.ledger.walletAccounts.get('devnet')?.credentialRef.service)
    .toBe(`${PAY_DEVELOPMENT_PROFILE.keychainNamespace}.wallet.devnet.v1`);
  const member = backend.descriptor.memberId;
  await backend.app.setMemberConnection(true, backend.origin, member);
  backend.app.setDailyLimit('100000'); backend.app.setPaused(false);
  const grant = await backend.app.createSpendGrant({ totalLimit: '50000', singleLimit: '10000',
    expiresAt: Date.now() + 3_600_000, resourceId: 'devnet-data' }, member);
  expect(grant.resourceId).toBe('devnet-data');
  expect(backend.app.memberOverview(member).authority).toMatchObject({ network: DEVNET_NETWORK,
    assetId: DEVNET_USDC_MINT, dailyLimit: '100000', available: '100000', reserved: '0', paid: '0' });
  expect(process.env.DEMO_BUYER_PUBLIC_KEY).toBeUndefined();
  await backend.close(); backend = undefined;
  backend = await startLiveDevnetDevelopmentBackend({ directory: f.directory, port });
  expect(backend.app.spendGrantSummary()?.id).toBe(grant.id);
  expect(backend.app.ledger.controls('live_devnet').dailyBudget).toBe('100000');
  expect(backend.app.ledger.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
  expect(wallet.provisions).toBe(1); expect(f.external).not.toHaveBeenCalled();
  expect(readFileSync(join(f.mainnet, 'app-ledger.sqlite'), 'utf8')).toBe('mainnet-unchanged');
  expect(readFileSync(join(f.root, 'app-ledger.sqlite'), 'utf8')).toBe('offline-unchanged');
});

it('Simulation starts without a wallet or executor and cannot provision or claim a payment permission', async () => {
  const f = fixture('simulated');
  backend = await startLiveDevnetDevelopmentBackend({ directory: f.directory, port: await freePort() });
  expect(backend.descriptor.profile).toBe('pay-mcp-simulated');
  expect(backend.app.execution()).toMatchObject({ mode: 'simulated', productionExecutionEnabled: false, spendingAuthorized: false });
  expect((await control(f.token, '/api/app/overview')).status).toBe(200);
  expect(() => backend!.app.createDevelopmentPaymentWallet()).toThrow('PAY_DEVELOPMENT_ONLY');
  expect(wallet.provisions).toBe(0); expect(backend.app.ledger.listForAdministration()).toEqual([]);
  expect(f.external).not.toHaveBeenCalled(); expect(globalThis.fetch).toBe(f.guardedFetch);
});
