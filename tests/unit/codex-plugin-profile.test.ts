import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

const dependency = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const Profile = z.object({ bundleIdentifier: z.string(), directoryName: z.string(), backendPort: z.number(),
  merchantPort: z.number(), rpcPort: z.number(), keychainNamespace: z.string() });

function load(entry: string, env: Record<string, string> = {}, define: Record<string, string> = { __YOSH_PLUGIN_DEV__: 'true' }): unknown {
  const source = buildSync({ entryPoints: [resolve(entry)], bundle: true, write: false, platform: 'node', format: 'cjs',
    packages: 'external', minifySyntax: true, define }).outputFiles[0].text;
  return runInNewContext(`${source}\nmodule.exports`, { module: { exports: {} }, require: dependency, URL, Error,
    process: { getuid: process.getuid, env } });
}
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-plugin-profile-'))); directories.push(parent);
  const root = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(root, { mode: 0o700 });
  return { parent, root };
}

it('selects a fixed plugin identity at compile time and rejects conflicting build identities', () => {
  expect(z.object({ PAY_DEVELOPMENT_PROFILE: Profile, IS_CODEX_PLUGIN_DEVELOPMENT: z.boolean() })
    .parse(load('src/modules/pay-dev/profile.ts', { YOSH_KEYCHAIN_NAMESPACE: 'com.yosh.wallet', YOSH_RC5: '1' })))
    .toEqual({ IS_CODEX_PLUGIN_DEVELOPMENT: true, PAY_DEVELOPMENT_PROFILE: {
      bundleIdentifier: 'com.yosh.codex-plugin-dev', directoryName: 'Yosh Codex Plugin Dev', backendPort: 14449,
      merchantPort: 14450, rpcPort: 14451, keychainNamespace: 'com.yosh.codex-plugin-dev' } });
  expect(() => load('src/modules/pay-dev/profile.ts', {}, { __YOSH_PLUGIN_DEV__: 'true', __YOSH_RC5__: 'true' }))
    .toThrow('PAY_DEVELOPMENT_PROFILE_CONFLICT');
  const legacy = z.object({ PAY_DEVELOPMENT_PROFILE: Profile }).parse(load('src/modules/pay-dev/profile.ts', { YOSH_PLUGIN_DEV: '1' }, {}));
  expect(legacy.PAY_DEVELOPMENT_PROFILE.bundleIdentifier).toBe('com.yosh.pay-development');
});

it('gives the standalone Offline build its own fixed identity without changing App profiles', () => {
  const define = { __YOSH_PLUGIN_DEV__: 'true', __YOSH_STANDALONE_DEV__: 'true', __YOSH_RC5__: 'false' };
  const profile = z.object({ PAY_DEVELOPMENT_PROFILE: Profile }).parse(load('src/modules/pay-dev/profile.ts', {}, define)).PAY_DEVELOPMENT_PROFILE;
  expect(profile).toEqual({ bundleIdentifier: 'com.yosh.standalone-plugin-dev', directoryName: 'Yosh Standalone Plugin Dev',
    backendPort: 15449, merchantPort: 15450, rpcPort: 15451, keychainNamespace: 'com.yosh.standalone-plugin-dev' });
  const environment = z.object({ assertDevelopmentOrigin: z.custom<(origin: string) => void>() })
    .parse(load('src/modules/pay-dev/environment.ts', {}, define));
  expect(() => environment.assertDevelopmentOrigin('http://127.0.0.1:15449')).not.toThrow();
  for (const port of [13449, 14449]) expect(() => environment.assertDevelopmentOrigin(`http://127.0.0.1:${port}`)).toThrow();
  expect(() => load('src/modules/pay-dev/profile.ts', {}, { ...define, __YOSH_PLUGIN_DEV__: 'false' })).toThrow('PAY_DEVELOPMENT_PROFILE_CONFLICT');
});

it('accepts only the isolated plugin directory and origin, with Offline as its empty-store default', () => {
  const { parent, root } = fixture();
  const environment = z.object({ readDevelopmentEnvironment: z.custom<(root: string) => unknown>(),
    assertDevelopmentOrigin: z.custom<(origin: string) => void>() }).parse(load('src/modules/pay-dev/environment.ts'));
  expect(environment.readDevelopmentEnvironment(root)).toMatchObject({ environment: 'offline', mainnetRiskAccepted: false });
  expect(() => environment.assertDevelopmentOrigin('http://127.0.0.1:14449')).not.toThrow();
  for (const origin of ['http://127.0.0.1:13449', 'http://127.0.0.1:13049', 'http://localhost:14449'])
    expect(() => environment.assertDevelopmentOrigin(origin)).toThrow('PAY_PROFILE_MISMATCH');
  for (const name of ['Yosh Pay Dev', 'Yosh Pay Dev v0.1.1-rc.5', 'Yosh', '2049']) {
    const old = join(parent, name); mkdirSync(old, { mode: 0o700 });
    expect(() => environment.readDevelopmentEnvironment(old)).toThrow('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  }
});

it('rejects Mainnet before reading its directory or any signing configuration', () => {
  const { root } = fixture();
  const environment = z.object({ readDevelopmentEnvironment: z.custom<(root: string) => unknown>(),
    isMainnetDevelopment: z.custom<(directory: string) => boolean>() }).parse(load('src/modules/pay-dev/environment.ts', {
    YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'mainnet', YOSH_DATA_DIR: '/must-not-access-production/Mainnet',
  }));
  expect(() => environment.isMainnetDevelopment('/must-not-access-production/Mainnet')).toThrow('YOSH_PLUGIN_MAINNET_DISABLED');
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'mainnet',
    mainnetRiskAccepted: true, rpcUrl: 'https://rpc.example' }), { mode: 0o600 });
  expect(() => environment.readDevelopmentEnvironment(root)).toThrow('YOSH_PLUGIN_MAINNET_DISABLED');
});

it('does not admit live Devnet in the plugin development build', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet',
    mainnetRiskAccepted: false, rpcUrl: 'https://rpc.example' }), { mode: 0o600 });
  const environment = z.object({ readDevelopmentEnvironment: z.custom<(root: string) => unknown>(),
    isDevnetDevelopment: z.custom<(directory: string) => boolean>() }).parse(load('src/modules/pay-dev/environment.ts', {
    YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'devnet', YOSH_DATA_DIR: '/must-not-access-wallet/Devnet',
  }));
  expect(() => environment.readDevelopmentEnvironment(root)).toThrow('YOSH_PLUGIN_ENVIRONMENT_DISABLED');
  expect(() => environment.isDevnetDevelopment('/must-not-access-wallet/Devnet')).toThrow('YOSH_PLUGIN_ENVIRONMENT_DISABLED');
});

it.each(['mainnet', 'devnet'])('the packaged backend rejects %s before requiring paths or starting services', mode => {
  const { parent } = fixture();
  const entry = join(parent, 'backend.cjs');
  buildSync({ entryPoints: [resolve('scripts/pay-dev-backend.ts')], bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', define: { __YOSH_PLUGIN_DEV__: 'true' }, outfile: entry });
  const child = spawnSync(process.execPath, [entry], { env: { NODE_ENV: 'test', NODE_PATH: resolve('node_modules'),
    YOSH_PAY_DEV_ENV: mode }, encoding: 'utf8', timeout: 10_000 });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain(mode === 'mainnet' ? 'YOSH_PLUGIN_MAINNET_DISABLED' : 'YOSH_PLUGIN_ENVIRONMENT_DISABLED');
});

it('the packaged backend rejects fixture port overrides before accessing runtime state', () => {
  const { parent } = fixture();
  const entry = join(parent, 'backend.cjs');
  buildSync({ entryPoints: [resolve('scripts/pay-dev-backend.ts')], bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', define: { __YOSH_PLUGIN_DEV__: 'true' }, outfile: entry });
  const child = spawnSync(process.execPath, [entry], { env: { NODE_ENV: 'test', NODE_PATH: resolve('node_modules'), YOSH_PAY_DEV_ENV: 'offline',
    YOSH_DATA_DIR: '/must-not-read-state', YOSH_PACKAGED_RUNTIME_DIR: '/must-not-read-runtime', YOSH_PAY_NATIVE_FIXTURE_PORT: '13449' },
    encoding: 'utf8', timeout: 10_000 });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('PAY_NATIVE_FIXTURE_REJECTED');
});

it('keeps C wallet setup identity separate and does not permit plugin Mainnet', () => {
  const define = { __YOSH_PLUGIN_DEV__: 'true', __YOSH_STANDALONE_DEV__: 'true', __YOSH_LOCAL_AUTH_DEV__: 'true', __YOSH_RC5__: 'false' };
  const profile = z.object({ PAY_DEVELOPMENT_PROFILE: Profile }).parse(load('src/modules/pay-dev/profile.ts', {}, define)).PAY_DEVELOPMENT_PROFILE;
  expect(profile.keychainNamespace).toBe('com.yosh.local-authorization-dev');
  expect(profile.backendPort).toBe(17449);
  expect(() => load('src/modules/pay-dev/profile.ts', {}, { ...define, __YOSH_STANDALONE_DEV__: 'false' })).toThrow('PROFILE_CONFLICT');
  const { parent } = fixture();
  const root = join(parent, profile.directoryName); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'mainnet', mainnetRiskAccepted: true, rpcUrl: 'https://api.mainnet-beta.solana.com' }), { mode: 0o600 });
  const environment = z.object({ readDevelopmentEnvironment: z.custom<(path: string) => unknown>() }).parse(load('src/modules/pay-dev/environment.ts', {}, define));
  expect(() => environment.readDevelopmentEnvironment(root)).toThrow('YOSH_PLUGIN_MAINNET_DISABLED');
});
