import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { resolvePaymentEnvironment, MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { GET, PUT } from '../../src/app/api/app/execution/route';
import { signedManagementRequest } from '../helpers/management-request';

const context = vi.hoisted(() => ({ app: undefined as AppRuntime | undefined }));
vi.mock('../../src/modules/app/app-runtime', async original => ({ ...await original<typeof import('../../src/modules/app/app-runtime')>(), appRuntime: () => context.app! }));
const dirs: string[] = [];
const address = 'BSEDrH4umjwCKUL5TqYm69ffsSjwWcV2BXQkczVp1F52';
const origin = 'http://127.0.0.1:3049';
const secret = 'execution-fixture-management-token';
afterEach(() => { context.app?.close(); context.app = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  for (const key of Object.keys(process.env)) if (key.startsWith('APP2049_') || key.startsWith('YOSH_') || key.startsWith('SOLANA_') || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated');
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs');
  const dir = mkdtempSync(join(tmpdir(), 'yosh-execution-')); dirs.push(dir);
  const initializeWallet = vi.fn(async () => ({ address, reused: true }));
  const readWallets = vi.fn(async () => [
    { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' as const },
    { id: 'devnet', label: 'Devnet · Test', address, status: 'available' as const },
  ]);
  const app = new AppRuntime(dir, { initializeWallet, readWallets }); context.app = app;
  return { app, dir, initializeWallet, readWallets };
}
function request(body: object) {
  return signedManagementRequest(`${origin}/api/app/execution`, secret, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
it('authenticated selection reaches backend truth, never provisions Mainnet or changes its authority', async () => {
  const { app, dir, initializeWallet } = fixture();
  app.setDailyLimit('100000'); app.setPaused(false);
  const response = await PUT(request({ mode: 'live_mainnet' })); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: 'live_mainnet', cluster: 'mainnet-beta', network: MAINNET_NETWORK,
    asset: { mint: MAINNET_USDC_MINT, decimals: 6 }, productionExecutionEnabled: false, spendingAuthorized: false, configurationReady: false });
  expect(app.ledger.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
  expect(app.spendGrantSummary()).toBeNull(); expect(app.ledger.listForAdministration()).toEqual([]);
  expect((await app.overview()).service).toMatchObject({ purchaseMode: 'live_mainnet', paymentEnabled: false });
  expect(initializeWallet).toHaveBeenCalledOnce(); expect(process.env.DEMO_MERCHANT_PUBLIC_KEY).toBeUndefined();
  expect(resolvePaymentEnvironment().productionExecutionEnabled).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'execution-selection.json'), 'utf8'))).toEqual({ version: 1, mode: 'live_mainnet' });
  expect(statSync(join(dir, 'execution-selection.json')).mode & 0o777).toBe(0o600);
  expect((await GET(signedManagementRequest(`${origin}/api/app/execution`, secret))).status).toBe(200);
  app.setExecution('simulated');
  expect(app.ledger.controls('simulated')).toMatchObject({ dailyBudget: '100000', paused: false });
  expect((await app.overview()).wallet.address).toBe(address);
});
it('selection survives restart without enabling execution or initializing a Mainnet wallet', async () => {
  const { app, dir, initializeWallet } = fixture(); app.setExecution('live_mainnet'); app.close(); context.app = undefined;
  const restored = new AppRuntime(dir, { initializeWallet }); context.app = restored;
  expect(restored.execution()).toMatchObject({ mode: 'live_mainnet', productionExecutionEnabled: false, spendingAuthorized: false });
  await restored.overview(); expect(initializeWallet).toHaveBeenCalledOnce();
});
it('loads the persisted profile before validating a product operator gate without an ambient execution mode', () => {
  const { app, dir } = fixture(); app.setExecution('live_mainnet'); app.close(); context.app = undefined;
  vi.stubEnv('YOSH_EXECUTION_MODE', undefined);
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1');
  context.app = new AppRuntime(dir);
  expect(context.app.execution()).toMatchObject({ mode: 'live_mainnet', productionExecutionEnabled: true, spendingAuthorized: false });
  context.app.setExecution('simulated'); context.app.close(); context.app = undefined;
  context.app = new AppRuntime(dir);
  expect(context.app.execution()).toMatchObject({ mode: 'simulated', productionExecutionEnabled: false });
});
it('Devnet selection keeps the existing test wallet and isolated controls', async () => {
  const { app, initializeWallet } = fixture();
  app.setDailyLimit('300000'); app.setPaused(false);
  app.setExecution('live_devnet'); expect(resolvePaymentEnvironment().mode).toBe('live_devnet');
  expect(app.ledger.controls('live_devnet')).toMatchObject({ dailyBudget: null, paused: false });
  await app.overview(); expect(initializeWallet).not.toHaveBeenCalled();
  app.setExecution('simulated'); expect(app.ledger.controls('simulated')).toMatchObject({ dailyBudget: '300000', paused: false });
});
it('rejects Agent/unsigned requests, extra authority fields and management replay', async () => {
  const { app } = fixture();
  expect((await PUT(new Request(`${origin}/api/app/execution`, { method: 'PUT', headers: { host: '127.0.0.1:3049', origin, authorization: 'Bearer agent-only' }, body: '{"mode":"live_mainnet"}' }))).status).toBe(403);
  expect((await PUT(request({ mode: 'live_mainnet', enabled: true, paused: false }))).status).toBe(400);
  const signed = request({ mode: 'live_mainnet' }); const copy = signed.clone();
  expect((await PUT(signed)).status).toBe(200); expect((await PUT(copy)).status).toBe(401);
  expect(app.execution().productionExecutionEnabled).toBe(false);
});
it('blocks switching while a wallet/overview read or original recovery is in flight', async () => {
  const { app, readWallets } = fixture();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  readWallets.mockImplementation(async () => { await pending; return [
    { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' as const },
    { id: 'devnet', label: 'Devnet · Test', address, status: 'available' as const },
  ]; });
  const read = app.overview();
  try { expect(() => app.setExecution('live_mainnet')).toThrow('EXECUTION_BUSY'); } finally { finish(); await read; }
  vi.spyOn(app.ledger, 'pendingRecovery').mockReturnValue([{ requestId: 'original-unknown', ownerCardMemberId: undefined }]);
  expect(() => app.setExecution('live_mainnet')).toThrow('EXECUTION_BUSY');
  expect(app.execution().mode).toBe('simulated');
});
it('corrupt persisted selection fails closed and releases the directory owner', () => {
  const { app, dir } = fixture(); app.close(); context.app = undefined;
  writeFileSync(join(dir, 'execution-selection.json'), '{"version":1,"mode":"anything"}');
  expect(() => new AppRuntime(dir)).toThrow('EXECUTION_SELECTION_INVALID');
  writeFileSync(join(dir, 'execution-selection.json'), '{"version":1,"mode":"simulated"}');
  context.app = new AppRuntime(dir); expect(context.app.execution().mode).toBe('simulated');
});

it('existing test SpendGrant and credentials cannot become Mainnet authority on selection', async () => {
  const { app } = fixture(); await app.overview();
  app.setDailyLimit('100000'); app.setPaused(false); app.setAgentConnection(true, origin);
  const grant = await app.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: Date.now() + 3600000 });
  app.setExecution('live_mainnet'); expect(app.spendGrantSummary()).toBeNull();
  expect(app.execution().spendingAuthorized).toBe(false);
  app.setExecution('simulated'); expect(app.spendGrantSummary()?.id).toBe(grant.id);
});
it('only an existing operator flag survives Mainnet selection, and no test profile inherits it', async () => {
  const { executionProfile } = await import('../../src/modules/app/execution-selection');
  const configured = { YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1' };
  expect(resolvePaymentEnvironment(executionProfile(configured, 'simulated')).productionExecutionEnabled).toBe(false);
  expect(resolvePaymentEnvironment(executionProfile(configured, 'live_mainnet')).productionExecutionEnabled).toBe(true);
  expect(resolvePaymentEnvironment(executionProfile({ YOSH_EXECUTION_MODE: 'simulated' }, 'live_mainnet')).productionExecutionEnabled).toBe(false);
});
