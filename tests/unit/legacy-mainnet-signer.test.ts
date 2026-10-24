import { resolvePaymentEnvironment, type PaymentEnvironment } from '../../src/modules/payment/payment-environment';
import type { ProductWalletStores } from '../../src/modules/app-wallet/product-wallet';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const requireDependency = createRequire(import.meta.url);
const dirs: string[] = [];
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture(candidate = true) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-legacy-signer-'))); dirs.push(parent);
  const root = join(parent, candidate ? 'Yosh Pay Dev v0.1.1-rc.5' : 'Yosh Pay Dev'); mkdirSync(root, { mode: 0o700 });
  const dir = join(root, 'Mainnet'); mkdirSync(dir, { mode: 0o700 });
  const rpc = 'https://rpc.fixture.invalid';
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'mainnet', mainnetRiskAccepted: true, rpcUrl: rpc }), { mode: 0o600 });
  const env: Record<string, string> = { YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'mainnet', YOSH_DATA_DIR: dir, SOLANA_MAINNET_RPC_URL: rpc };
  let exitCode = 44;
  const os = vi.fn((_command: string, _args: string[]) => {
    if (_command !== '/usr/bin/security' || _args[0] !== 'find-generic-password') throw new Error('MOCK_READ_ONLY_REQUIRED');
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    queueMicrotask(() => child.emit('close', exitCode));
    return child;
  });
  const source = buildSync({ stdin: { contents: "export * from './src/modules/payment/keychain'; export * from './src/modules/pay-dev/mainnet-signer-selection'; export * from './src/modules/app-wallet/product-wallet';", resolveDir: resolve('.') }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_RC5__: String(candidate) } }).outputFiles[0].text;
  const api = z.object({
    initializeEnvironmentWallet: z.custom<(environment: PaymentEnvironment, stores: ProductWalletStores) => Promise<unknown>>(v => typeof v === 'function'),
    assertLegacyMainnetSignerAddress: z.custom<(address: string) => void>(v => typeof v === 'function'),
    productWalletSlotKeychain: z.custom<(slot: 'mainnet' | 'devnet') => {service: string; account: string}>(v => typeof v === 'function'),
    readMainnetWalletKeychain: z.custom<() => Promise<string | undefined>>(v => typeof v === 'function'),
    createMainnetWalletKeychain: z.custom<(secret: string) => Promise<void>>(v => typeof v === 'function'),
  }).parse(runInNewContext(`${source}\nmodule.exports`, {module: {exports: {}}, require: (n: string): unknown => n === 'node:child_process' ? { spawn: os } : requireDependency(n), process: {env, platform:'darwin', getuid: process.getuid}, URL, Error, setTimeout, clearTimeout}));
  const file = join(root, 'mainnet-signer-acceptance.json');
  const select = (identity = 'legacy-pay-dev-mainnet') => writeFileSync(file, JSON.stringify({ version:1, identity }), {mode:0o600});
  return {api, env, os, file, select, root, locked: () => { exitCode = 36; }};
}
it('default and explicit isolated lookup remain candidate-local; other slots never change', () => {
  const f = fixture();
  expect(f.api.productWalletSlotKeychain('mainnet').service).toBe('com.yosh.pay-development.v011rc5.wallet.mainnet.v1');
  f.select();
  expect(f.api.productWalletSlotKeychain('mainnet')).toEqual({service:'com.yosh.pay-development.wallet.mainnet.v1', account:'consumer-wallet-mainnet-v1'});
  expect(f.api.productWalletSlotKeychain('devnet').service).toBe('com.yosh.pay-development.v011rc5.wallet.offline.v1');
  expect(f.os).not.toHaveBeenCalled();
});
it('legacy selection cannot create or rewrite a wallet, including missing-item recovery', async () => {
  const f=fixture(); f.select();
  await expect(f.api.createMainnetWalletKeychain('not-a-secret')).rejects.toThrow('LEGACY_MAINNET_SIGNER_READ_ONLY');
  expect(f.os).not.toHaveBeenCalled();
});
it.each(['com.yosh.wallet.mainnet.v1','arbitrary.service','', 'legacy-pay-dev-mainnet-typo'])('rejects unrecognized identity %s', identity => {
  const f=fixture();f.select(identity);
  expect(() => f.api.productWalletSlotKeychain('mainnet')).toThrow('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  expect(f.os).not.toHaveBeenCalled();
});
it('rejects unsafe permissions and symlinks instead of silently choosing another signer', () => {
  const f=fixture();f.select();chmodSync(f.file,0o644);
  expect(() => f.api.productWalletSlotKeychain('mainnet')).toThrow('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  chmodSync(f.file,0o600);const target=join(f.root,'target');writeFileSync(target,'{}');rmSync(f.file);symlinkSync(target,f.file);
  expect(() => f.api.productWalletSlotKeychain('mainnet')).toThrow('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
});
it('production and old Dev do not gain a legacy override; Offline rejects before OS access', () => {
  const f=fixture(false);f.select();
  expect(() => f.api.productWalletSlotKeychain('mainnet')).toThrow('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  const g=fixture();g.select();g.env.YOSH_PAY_DEV_ENV='offline';
  expect(() => g.api.productWalletSlotKeychain('mainnet')).toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  g.env.YOSH_PAY_DEV='0';
  expect(g.api.productWalletSlotKeychain('mainnet').service).toBe('com.yosh.wallet.mainnet.v1');
  expect(g.os).not.toHaveBeenCalled();
});

it('pins the historical public identity; malformed config and mismatched identities fail closed', () => {
  const f=fixture();f.select();
  expect(() => f.api.assertLegacyMainnetSignerAddress('5jgN7QN4uYdYLHrEcUvZczciV144TRxz2Xjr1MYPJYHj')).not.toThrow();
  expect(() => f.api.assertLegacyMainnetSignerAddress('D8F9JNGbXirgU5FYCijw3SJMLy9ZcxnMpNsxvajTRXRC')).toThrow('LEGACY_MAINNET_SIGNER_IDENTITY_MISMATCH');
  writeFileSync(f.file,'{');
  expect(() => f.api.productWalletSlotKeychain('mainnet')).toThrow('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
});

it('missing and locked legacy items never fall back or provision across reloads', async () => {
  for (const locked of [false,true]) {
    const f=fixture();f.select();if (locked) f.locked();
    if (locked) await expect(f.api.readMainnetWalletKeychain()).rejects.toThrow();
    else await expect(f.api.readMainnetWalletKeychain()).resolves.toBeUndefined();
    expect(f.os.mock.calls.map(([,args]) => args)).toEqual([['find-generic-password','-s','com.yosh.pay-development.wallet.mainnet.v1','-a','consumer-wallet-mainnet-v1','-w']]);
  }
});

it('rejects wallet initialization before reading stores or generating a seed', async () => {
  const f=fixture();f.select();
  const read=vi.fn(async () => undefined), create=vi.fn(async (_secret: string) => { throw new Error('WRITE_FORBIDDEN:' + _secret.length); });
  const store={read,create};
  await expect(f.api.initializeEnvironmentWallet(resolvePaymentEnvironment({},'live_mainnet'),{test:store,mainnet:store})).rejects.toThrow('LEGACY_MAINNET_SIGNER_READ_ONLY');
  expect(read).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(f.os).not.toHaveBeenCalled();
});
