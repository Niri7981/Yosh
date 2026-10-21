import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { getStandardTokenAccount } from '../../src/modules/payment/payment-preflight';
import { readConnection } from '../../src/modules/mcp/connection';
import { GET } from '../../src/app/api/agent/route';
import { GET as memberGET } from '../../src/app/api/app/members/[memberId]/route';
import { GET as healthGET } from '../../src/app/api/app/health/route';
import { signedManagementRequest } from '../helpers/management-request';
const context = vi.hoisted(() => ({ app: undefined as AppRuntime | undefined }));
vi.mock('@/modules/app/app-runtime', async original => ({ ...await original<typeof import('../../src/modules/app/app-runtime')>(), appRuntime: () => context.app }));
const secrets = vi.hoisted(() => ({ test: undefined as string | undefined, mainnet: undefined as string | undefined, testReads: 0, mainnetReads: 0 }));
vi.mock('../../src/modules/payment/keychain', async original => ({
  ...await original<typeof import('../../src/modules/payment/keychain')>(),
  readAppWalletKeychain: async () => { secrets.testReads++; return secrets.test; },
  readMainnetWalletKeychain: async () => { secrets.mainnetReads++; return secrets.mainnet; },
  createAppWalletKeychain: () => { throw new Error('must not create'); }, createMainnetWalletKeychain: () => { throw new Error('must not create'); },
}));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); secrets.mainnet = undefined; secrets.test = undefined; secrets.testReads = 0; secrets.mainnetReads = 0; });
async function fixture(amount: string | null = '10000', assertion?: 'match' | 'mismatch', initializeWallet?: () => Promise<{ address: string; reused: boolean }>) {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
  secrets.mainnet = getBase58Decoder().decode(new Uint8Array([...new Uint8Array(32).fill(7), ...pub]));
  vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
  if (assertion) vi.stubEnv('YOSH_MAINNET_WALLET_PUBLIC_KEY', assertion === 'match' ? signer.address : '11111111111111111111111111111111');
  const environment = resolvePaymentEnvironment();
  const ata = await getStandardTokenAccount(signer.address, environment.asset.mint);
  const rpc = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(new URL(environment.rpcUrl).toString());
    const request = JSON.parse(String(init?.body));
    if (amount === null) throw new Error('fixture RPC failure');
    if (request.method === 'getGenesisHash') return Response.json({ result: environment.genesisHash });
    expect(request.method).toBe('getAccountInfo'); expect(request.params[0]).toBe(ata);
    return Response.json({ result: { value: { owner: environment.asset.tokenProgram, data: { parsed: { info: {
      owner: signer.address, mint: environment.asset.mint, tokenAmount: { amount, decimals: 6 },
    } } } } } });
  });
  vi.stubGlobal('fetch', rpc);
  const dir = mkdtempSync(join(tmpdir(), 'yosh-snapshot-')); dirs.push(dir);
  const app = new AppRuntime(dir, { initializeWallet }); context.app = app;
  return { app, signer, environment, rpc, dir };
}
it.each([undefined, 'match'] as const)('uses the saved identity without mandatory env configuration (%s)', async assertion => {
  const f = await fixture('10000', assertion);
  try {
    await f.app.refreshMainnetWallet();
    expect((await f.app.overview()).wallet).toMatchObject({ address: f.signer.address, available: true });
    expect(await f.app.existingWallets()).toContainEqual(expect.objectContaining({ id: 'mainnet', address: f.signer.address, status: 'available' }));
    f.app.setAgentConnection(true, 'http://127.0.0.1:3049');
    const response = await GET(new Request('http://127.0.0.1:3049/api/agent?operation=status', { headers: { authorization: `Bearer ${readConnection(f.dir).token}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ wallet: { address: f.signer.address, available: true, balance: { amount: '10000', available: true } }, authority: { wallet: { status: 'available' } } });
    expect(f.app.authority().wallet).toMatchObject({ address: f.signer.address, status: 'available' });
    expect(f.app.authority().blockers).not.toContain('USDC balance not verified');
    const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_mainnet',
      YOSH_MAINNET_RESOURCES: JSON.stringify([{ resourceId: 'fixture', providerId: 'fixture', network: f.environment.network,
        mint: f.environment.asset.mint, decimals: 6, recipient: f.environment.asset.tokenProgram,
        request: { url: 'https://fixture.example/data', method: 'GET', access: 'https', headers: {} } }]),
      X402_FACILITATOR_URL: 'https://fixture.example' }, 'live_devnet', f.app.authority().wallet.address);
    expect(config.buyer).toBe(f.signer.address);
    expect((await loadBuyerSigner(config.buyer)).address).toBe(f.app.authority().wallet.address);
  } finally { await f.app.prepareQuit(); f.app.close(); }
});

it('shares public inventory across status and Settings without rereading protected material', async () => {
  const f = await fixture();
  try {
    await f.app.refreshMainnetWallet();
    await Promise.all(Array.from({ length: 5 }, () => f.app.overview()));
    await f.app.existingWallets();
    await f.app.existingWallets();
    expect(secrets.mainnetReads).toBe(1);
    expect(secrets.testReads).toBe(1);
  } finally { await f.app.prepareQuit(); f.app.close(); }
});

it('returns authenticated core health and Connection state while a wallet lookup remains pending', async () => {
  let release!: (wallet: { address: string; reused: boolean }) => void;
  const pending = new Promise<{ address: string; reused: boolean }>(resolve => { release = resolve; });
  const f = await fixture('10000', undefined, () => pending);
  const token = 'slow-wallet-health-management-fixture';
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  try {
    const checking = f.app.initializeWallet();
    const response = await healthGET(signedManagementRequest('http://127.0.0.1:3049/api/app/health', token));
    expect(response.status).toBe(200);
    expect(response.headers.has('x-2049-response-proof')).toBe(true);
    expect(await response.json()).toMatchObject({ ready: true, coreReady: true, pid: process.pid, wallet: 'walletChecking' });
    expect((await f.app.overview()).wallet).toMatchObject({ available: false });
    release({ address: f.signer.address, reused: true });
    await checking;
    expect(f.app.healthStatus()).toMatchObject({ coreReady: true, wallet: 'walletAvailable' });
  } finally { release({ address: f.signer.address, reused: true }); await f.app.prepareQuit(); f.app.close(); }
});
it('fails closed on an optional assertion mismatch', async () => {
  const f = await fixture('10000', 'mismatch');
  try {
    await f.app.refreshMainnetWallet();
    expect((await f.app.overview()).wallet).toMatchObject({ available: false });
    expect(await f.app.readAuthorityBalance()).toMatchObject({ available: false });
    await expect(loadBuyerSigner(f.signer.address)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  } finally { await f.app.prepareQuit(); f.app.close(); }
});
it.each([null, '0'] as const)('keeps identity available with balance %s', async amount => {
  const f = await fixture(amount);
  try {
    expect(await f.app.readAuthorityBalance()).toMatchObject({ amount, available: amount !== null });
    expect((await f.app.overview()).wallet).toMatchObject({ address: f.signer.address, available: true });
    expect(f.app.authority().blockers).toContain(amount === null ? 'USDC balance not verified' : 'Insufficient USDC');
    expect(f.app.authority().blockers).not.toContain('Mainnet wallet unavailable');
  } finally { await f.app.prepareQuit(); f.app.close(); }
});

it.each(['missing', 'corrupt', 'copied-devnet'] as const)('rejects %s Keychain identity without fallback', async kind => {
  const f = await fixture();
  if (kind === 'missing') secrets.mainnet = undefined;
  if (kind === 'corrupt') secrets.mainnet = 'invalid-secret';
  if (kind === 'copied-devnet') secrets.test = secrets.mainnet;
  try {
    await f.app.refreshMainnetWallet();
    expect((await f.app.overview()).wallet).toMatchObject({ address: '', available: false });
    await expect(loadBuyerSigner(f.signer.address)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  } finally { await f.app.prepareQuit(); f.app.close(); }
});
it('caches public status but signing rechecks Keychain and rejects a replacement', async () => {
  const f = await fixture();
  try {
    await f.app.refreshMainnetWallet();
    expect((await f.app.overview()).wallet).toMatchObject({ available: true });
    secrets.mainnet = 'invalid-secret';
    expect((await f.app.overview()).wallet).toMatchObject({ available: true });
    await expect(loadBuyerSigner(f.signer.address)).rejects.toThrow();
    const other = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(8));
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', other.keyPair.publicKey));
    secrets.mainnet = getBase58Decoder().decode(new Uint8Array([...new Uint8Array(32).fill(8), ...pub]));
    expect((await f.app.overview()).wallet).toMatchObject({ address: f.signer.address, available: true });
    await expect(loadBuyerSigner(f.signer.address)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  } finally { await f.app.prepareQuit(); f.app.close(); }
});

it('resolves Mainnet identity on a member Authority read before any overview or Settings visit', async () => {
  const f = await fixture(); const token = 'mainnet-snapshot-management-fixture';
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  try {
    const id = f.app.ledger.defaultCardMember().id;
    const response = await memberGET(signedManagementRequest(`http://127.0.0.1:3049/api/app/members/${id}`, token), { params: Promise.resolve({ memberId: id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authority: { wallet: { status: 'unavailable' } } });
    await f.app.refreshMainnetWallet();
    expect(f.app.authority().wallet).toMatchObject({ address: f.signer.address, status: 'available' });
    expect(f.rpc).not.toHaveBeenCalled();
  } finally { await f.app.prepareQuit(); f.app.close(); }
});
