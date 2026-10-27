import { buildSync } from 'esbuild';
import { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const requireDependency = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const WalletItem = z.object({ service: z.string(), account: z.string() });
const Exports = z.object({
  DEV_MAINNET_WALLET_KEYCHAIN: WalletItem,
  DEV_DEVNET_WALLET_KEYCHAIN: WalletItem,
  readMainnetWalletKeychain: z.custom<() => Promise<string | undefined>>(value => typeof value === 'function'),
  readAppWalletKeychain: z.custom<() => Promise<string | undefined>>(value => typeof value === 'function'),
  readLibraryWalletKeychain: z.custom<(id: string) => Promise<string | undefined>>(value => typeof value === 'function'),
});

function fixture(rc3: boolean, profile: 'mainnet' | 'devnet' | 'simulated' = 'mainnet') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-keychain-namespace-'))); directories.push(parent);
  const root = join(parent, rc3 ? 'Yosh Pay Dev v0.1.1-rc.5' : 'Yosh Pay Dev'); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, profile === 'mainnet' ? 'Mainnet' : profile === 'devnet' ? 'Devnet' : 'Simulated'); mkdirSync(directory, { mode: 0o700 });
  const rpc = 'https://rpc.namespace-test.invalid';
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: profile,
    mainnetRiskAccepted: true, rpcUrl: rpc }), { mode: 0o600 });
  const securitySpawn = vi.fn((command: string, args: string[]) => {
    if (command !== '/usr/bin/security' || args[0] !== 'find-generic-password') throw new Error('TEST_READ_ONLY_MOCK_REQUIRED');
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    queueMicrotask(() => child.emit('close', 44));
    return child;
  });
  const source = buildSync({ entryPoints: [resolve('src/modules/payment/keychain.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', minifySyntax: true,
    define: { __YOSH_RC5__: String(rc3) } }).outputFiles[0].text;
  const environment: Record<string, string> = { YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: profile, YOSH_DATA_DIR: directory,
    YOSH_EXECUTION_MODE: profile === 'devnet' ? 'live_devnet' : profile === 'simulated' ? 'simulated' : 'live_mainnet',
    YOSH_ENABLE_MAINNET_EXECUTION: '0', SOLANA_RPC_URL: profile === 'mainnet' ? rpc : 'https://api.devnet.solana.com',
    SOLANA_MAINNET_RPC_URL: rpc, YOSH_KEYCHAIN_NAMESPACE: 'untrusted.namespace', NODE_ENV: 'test' };
  const exported: unknown = runInNewContext(`${source}\nmodule.exports`, { module: { exports: {} },
    require: (name: string): unknown => name === 'node:child_process' ? { spawn: securitySpawn } : requireDependency(name),
    process: { env: environment, platform: 'darwin', getuid: process.getuid }, URL, Error, setTimeout, clearTimeout });
  return { keychain: Exports.parse(exported), securitySpawn, environment };
}

it.each([false, true])('compiled rc.4 selection %s only queries its fixed namespace, regardless of runtime namespace input', async rc3 => {
  const { keychain, securitySpawn } = fixture(rc3);
  const namespace = rc3 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development';
  expect(keychain.DEV_MAINNET_WALLET_KEYCHAIN.service).toBe(`${namespace}.wallet.mainnet.v1`);
  await expect(keychain.readMainnetWalletKeychain()).resolves.toBeUndefined();
  await expect(keychain.readAppWalletKeychain()).resolves.toBeUndefined();
  await expect(keychain.readLibraryWalletKeychain('00000000-0000-4000-8000-000000000001')).resolves.toBeUndefined();
  const queried = securitySpawn.mock.calls.map(([, args]) => args[args.indexOf('-s') + 1]);
  expect(queried).toEqual([`${namespace}.wallet.mainnet.v1`, `${namespace}.wallet.offline.v1`, `${namespace}.wallet.library.v1`]);
  expect(queried).not.toContain('com.yosh.wallet.mainnet.v1');
  expect(queried).not.toContain('untrusted.namespace');
});

it('candidate Offline still rejects Keychain access before any OS command', async () => {
  const { keychain, securitySpawn, environment } = fixture(true);
  environment.YOSH_PAY_DEV_ENV = 'offline';
  await expect(keychain.readMainnetWalletKeychain()).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  expect(securitySpawn).not.toHaveBeenCalled();
});

it.each([false, true])('Devnet profile %s reads only its fixed Devnet key, never Mainnet, Offline or library credentials', async rc3 => {
  const { keychain, securitySpawn } = fixture(rc3, 'devnet');
  const namespace = rc3 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development';
  expect(keychain.DEV_DEVNET_WALLET_KEYCHAIN.service).toBe(`${namespace}.wallet.devnet.v1`);
  await expect(keychain.readAppWalletKeychain()).resolves.toBeUndefined();
  await expect(keychain.readMainnetWalletKeychain()).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  await expect(keychain.readLibraryWalletKeychain('00000000-0000-4000-8000-000000000001')).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  const queried = securitySpawn.mock.calls.map(([, args]) => args[args.indexOf('-s') + 1]);
  expect(queried).toEqual([`${namespace}.wallet.devnet.v1`]);
});

it('Simulation profile cannot read any product signing credential', async () => {
  const { keychain, securitySpawn } = fixture(true, 'simulated');
  await expect(keychain.readAppWalletKeychain()).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  await expect(keychain.readMainnetWalletKeychain()).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  expect(securitySpawn).not.toHaveBeenCalled();
});
