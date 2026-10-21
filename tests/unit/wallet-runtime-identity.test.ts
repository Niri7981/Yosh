import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { GET as agentGET } from '../../src/app/api/agent/route';
import { readConnection } from '../../src/modules/mcp/connection';

const secrets = vi.hoisted(() => ({
  test: undefined as string | undefined, mainnet: undefined as string | undefined,
  create: vi.fn(async () => { throw new Error('implicit creation is forbidden'); }),
}));
vi.mock('../../src/modules/payment/keychain', async original => ({
  ...await original<typeof import('../../src/modules/payment/keychain')>(),
  readAppWalletKeychain: async () => secrets.test,
  readMainnetWalletKeychain: async () => secrets.mainnet,
  createAppWalletKeychain: secrets.create, createMainnetWalletKeychain: secrets.create,
}));
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks();
  secrets.test = undefined; secrets.mainnet = undefined;
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
function fixture(mode = 'simulated') {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  vi.stubEnv('YOSH_EXECUTION_MODE', mode);
  const directory = mkdtempSync(join(tmpdir(), 'yosh-wallet-identity-')); directories.push(directory);
  return { directory, app: new AppRuntime(directory) };
}

it('keeps balance and explicit wallet readiness reads empty without generating a test wallet', async () => {
  const { app } = fixture();
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  try {
    expect(await app.readAuthorityBalance()).toMatchObject({ available: false, amount: null });
    await expect(app.initializeWallet()).rejects.toThrow('WALLET_');
    expect(secrets.create).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally { await app.prepareQuit(); app.close(); }
});

async function keypair(value: number) {
  const seed = new Uint8Array(32).fill(value);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
  return { address: signer.address, secret: getBase58Decoder().decode(new Uint8Array([...seed, ...publicBytes])) };
}

it('retains the first Mainnet identity across a backend restart and rejects a different key in the same slot', async () => {
  const original = await keypair(11); const replacement = await keypair(22);
  const { app, directory } = fixture('live_mainnet');
  secrets.mainnet = original.secret;
  try {
    await app.refreshMainnetWallet();
    expect(app.authority().wallet).toMatchObject({ address: original.address, status: 'available' });
  } finally { await app.prepareQuit(); app.close(); }
  secrets.mainnet = replacement.secret;
  const restarted = new AppRuntime(directory);
  try {
    const wallets = await restarted.existingWallets();
    expect(wallets).toContainEqual(expect.objectContaining({ id: 'mainnet', status: 'unavailable',
      address: null, provisioningState: 'identity_conflict' }));
    expect(restarted.authority().wallet.status).toBe('unavailable');
    expect(secrets.create).not.toHaveBeenCalled();
  } finally { await restarted.prepareQuit(); restarted.close(); }
});

it('distinguishes a genuinely absent Mainnet wallet from a corrupt protected item', async () => {
  const { app } = fixture('live_mainnet');
  try {
    expect(await app.existingWallets()).toContainEqual(expect.objectContaining({ id: 'mainnet', status: 'missing',
      provisioningState: 'absent_fresh' }));
  } finally { await app.prepareQuit(); app.close(); }
  const corrupt = fixture('live_mainnet').app;
  secrets.mainnet = 'not-a-valid-secret';
  try {
    expect(await corrupt.existingWallets()).toContainEqual(expect.objectContaining({ id: 'mainnet', status: 'unavailable',
      provisioningState: 'corrupt' }));
    expect(secrets.create).not.toHaveBeenCalled();
  } finally { await corrupt.prepareQuit(); corrupt.close(); }
});

it('keeps startup, pages, balance, quote, Agent status/connect and environment changes at zero wallets', async () => {
  const { app, directory } = fixture();
  const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  const previous = globals.__yosh; globals.__yosh = { runtime: app };
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  const origin = 'http://127.0.0.1:3049';
  try {
    await app.start(origin);
    app.setAgentConnection(true, origin);
    for (const mode of ['simulated', 'live_devnet', 'live_mainnet', 'simulated'] as const) {
      app.setExecution(mode);
      await app.overview(); app.authority();
      expect((await app.existingWallets()).every(entry => entry.provisioningState === 'absent_fresh')).toBe(true);
      expect(await app.readAuthorityBalance()).toMatchObject({ available: false });
      await app.quotePaidResources(origin).catch(() => undefined);
      const status = await agentGET(new Request(`${origin}/api/agent?operation=status`, {
        headers: { authorization: `Bearer ${readConnection(directory).token}` },
      }));
      expect(status.status).toBe(200);
      expect(app.ledger.walletAccounts.get('mainnet')).toBeUndefined();
      expect(app.ledger.walletAccounts.get('devnet')).toBeUndefined();
    }
    expect(secrets.create).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  } finally { globals.__yosh = previous; await app.prepareQuit(); app.close(); }
});

it('adopts both original fixture identities under concurrent reads without touching either secret', async () => {
  const test = await keypair(31); const mainnet = await keypair(32);
  const { app, directory } = fixture();
  secrets.test = test.secret; secrets.mainnet = mainnet.secret;
  try {
    await Promise.all(Array.from({ length: 6 }, () => app.existingWallets()));
    expect((await app.overview()).wallet.address).toBe(test.address);
    expect(app.ledger.walletAccounts.get('mainnet')?.publicKey).toBe(mainnet.address);
    expect(app.ledger.walletAccounts.get('devnet')?.publicKey).toBe(test.address);
    expect([secrets.test, secrets.mainnet]).toEqual([test.secret, mainnet.secret]);
    expect(secrets.create).not.toHaveBeenCalled();
  } finally { await app.prepareQuit(); app.close(); }
  secrets.test = (await keypair(33)).secret;
  const restarted = new AppRuntime(directory);
  try {
    expect((await restarted.overview()).wallet.address).toBe('');
    await expect(restarted.initializeWallet()).rejects.toThrow('WALLET_');
    expect(restarted.ledger.walletAccounts.get('devnet')?.publicKey).toBe(test.address);
    expect(secrets.mainnet).toBe(mainnet.secret); expect(secrets.create).not.toHaveBeenCalled();
  } finally { await restarted.prepareQuit(); restarted.close(); }
});
