import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertMainnetProxyStartupEnvironment, loadMainnetStandaloneConfiguration, parseMainnetStandaloneSystemProxy, readMainnetStandaloneConfiguration } from '../../src/modules/pay-dev/mainnet-standalone-configuration';
import { LEGACY_PAY_DEV_MAINNET } from '../../src/modules/pay-dev/mainnet-signer-selection';

const system = vi.hoisted(() => ({ home: '', proxy: '<dictionary> {\n  HTTPSEnable : 0\n}\n', failed: false,
  execute: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), userInfo: () => ({ homedir: system.home }) }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  system.execute(...args.slice(0, 3));
  const callback = args[3];
  if (typeof callback !== 'function') throw new Error('FIXTURE_CALLBACK_REQUIRED');
  callback(system.failed ? new Error('SECRET_PROXY_ERROR') : null, system.proxy, '');
} }));
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); system.execute.mockClear(); system.failed = false;
  system.proxy = '<dictionary> {\n  HTTPSEnable : 0\n}\n';
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mainnet-existing-configuration-'))); directories.push(home); system.home = home;
  const root = join(home, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5'), directory = join(root, 'Mainnet');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'home'), { mode: 0o700 });
  const runtimeDirectory = join(home, 'runtime'); mkdirSync(runtimeDirectory, { mode: 0o700 });
  const memberId = randomUUID(), token = 'T'.repeat(43), connection = { origin: 'http://127.0.0.1:13449', token: 'A'.repeat(43),
    cardMemberId: memberId, connectionId: randomUUID(), generation: 7, capabilities: ['read', 'request_purchase'] };
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(join(root, 'development-environment.json'), { version: 1, environment: 'mainnet', mainnetRiskAccepted: true, rpcUrl: 'https://rpc.example/v1' });
  write(join(root, 'mainnet-signer-acceptance.json'), { version: 1, identity: 'legacy-pay-dev-mainnet' });
  write(join(directory, 'pay-development-mainnet.json'), { version: 1, kind: 'yosh-pay-mainnet-development', directory });
  write(join(directory, 'pay-mainnet-runtime.json'), { version: 1, profile: 'pay-mcp-mainnet', origin: connection.origin, memberId });
  write(join(directory, 'product-configuration.json'), { YOSH_ENABLE_MAINNET_EXECUTION: '1',
    YOSH_MAINNET_WALLET_PUBLIC_KEY: LEGACY_PAY_DEV_MAINNET.publicAddress, YOSH_MAINNET_RESOURCES: '[]' });
  write(join(directory, 'execution-selection.json'), { version: 1, mode: 'live_mainnet' });
  write(join(directory, 'mcp-connection.json'), connection);
  writeFileSync(join(directory, 'management-token'), token, { mode: 0o600 });
  // Metadata-only fixture: the loader must never open or query a Ledger.
  writeFileSync(join(directory, 'app-ledger.sqlite'), 'NOT_A_DATABASE', { mode: 0o600 });
  return { home, root, directory, runtimeDirectory, memberId, token, connection, write,
    read: () => readMainnetStandaloneConfiguration({ home, runtimeDirectory }) };
}
function fingerprint(directory: string): string {
  const entries: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path); entries.push(`${path}:${stat.mode}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else entries.push(createHash('sha256').update(readFileSync(path)).digest('hex'));
  };
  visit(directory); return createHash('sha256').update(entries.join('\n')).digest('hex');
}

it('uses the original Mainnet identity and settings without writing any existing state or inheriting process overrides', () => {
  const f = fixture(), before = fingerprint(f.home);
  for (const key of ['HOME', 'YOSH_DATA_DIR', 'YOSH_MANAGEMENT_TOKEN', 'SOLANA_MAINNET_RPC_URL', 'HTTPS_PROXY', 'YOSH_KEYCHAIN_NAMESPACE'])
    vi.stubEnv(key, 'SECRET_UNTRUSTED_OVERRIDE');
  const result = readMainnetStandaloneConfiguration({ home: f.home, runtimeDirectory: f.runtimeDirectory, httpsProxy: { host: '127.0.0.1', port: 6074 } });
  expect(result).toMatchObject({ root: f.root, directory: f.directory, origin: 'http://127.0.0.1:13449', port: 13449, memberId: f.memberId });
  expect(result.environment).toMatchObject({ HOME: join(f.directory, 'home'), NODE_ENV: 'production', PORT: '13449',
    YOSH_PORT: '13449', YOSH_DATA_DIR: f.directory, APP2049_DATA_DIR: f.directory,
    YOSH_MANAGEMENT_TOKEN: f.token, APP2049_MANAGEMENT_TOKEN: f.token, YOSH_PACKAGED_RUNTIME_DIR: f.runtimeDirectory,
    YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'mainnet', YOSH_PAY_MCP_MAINNET: '1', YOSH_EXECUTION_MODE: 'live_mainnet',
    YOSH_ENABLE_MAINNET_EXECUTION: '1', APP2049_ENABLE_MAINNET_EXECUTION: '1', SOLANA_MAINNET_RPC_URL: 'https://rpc.example/v1',
    YOSH_MAINNET_WALLET_PUBLIC_KEY: LEGACY_PAY_DEV_MAINNET.publicAddress,
    HTTPS_PROXY: 'http://127.0.0.1:6074', HTTP_PROXY: 'http://127.0.0.1:6074', NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1' });
  expect(JSON.stringify(result)).not.toContain('SECRET_UNTRUSTED_OVERRIDE');
  expect(fingerprint(f.home)).toBe(before);
});

it('preserves disabled execution and a disconnected Agent without creating credentials or requiring a new public assertion', () => {
  const f = fixture();
  f.write(join(f.directory, 'product-configuration.json'), { YOSH_ENABLE_MAINNET_EXECUTION: '0' });
  rmSync(join(f.directory, 'mcp-connection.json'));
  const before = fingerprint(f.home), result = f.read();
  expect(result.environment.YOSH_ENABLE_MAINNET_EXECUTION).toBe('0');
  expect(result.environment.YOSH_MAINNET_WALLET_PUBLIC_KEY).toBeUndefined();
  expect(existsSync(join(f.directory, 'mcp-connection.json'))).toBe(false);
  expect(fingerprint(f.home)).toBe(before);
});

it('retains the existing RC5 signer slot when no legacy signer selection exists', () => {
  const f = fixture(); rmSync(join(f.root, 'mainnet-signer-acceptance.json'));
  f.write(join(f.directory, 'product-configuration.json'), { YOSH_MAINNET_WALLET_PUBLIC_KEY: '11111111111111111111111111111111' });
  expect(f.read().environment.YOSH_MAINNET_WALLET_PUBLIC_KEY).toBe('11111111111111111111111111111111');
  expect(existsSync(join(f.root, 'mainnet-signer-acceptance.json'))).toBe(false);
});

it('leaves absent product policy absent and defaults execution to disabled', () => {
  const f = fixture(); rmSync(join(f.directory, 'product-configuration.json'));
  const before = fingerprint(f.home), result = f.read();
  expect(result.environment.YOSH_ENABLE_MAINNET_EXECUTION).toBe('0');
  expect(result.environment.APP2049_ENABLE_MAINNET_EXECUTION).toBe('0');
  expect(fingerprint(f.home)).toBe(before);
});

it('refuses a non-RC5 compiled profile before accessing any fixture or production path', () => {
  const code = buildSync({ entryPoints: [resolve('src/modules/pay-dev/mainnet-standalone-configuration.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_RC5__: 'false' } }).outputFiles[0].text;
  const result: unknown = runInNewContext(`${code}\nmodule.exports`, { module: { exports: {} }, require: createRequire(import.meta.url),
    process: { env: { YOSH_RC5: '1' }, getuid: process.getuid }, URL, Buffer });
  const loaded = z.object({ readMainnetStandaloneConfiguration: z.custom<typeof readMainnetStandaloneConfiguration>() }).parse(result);
  expect(() => loaded.readMainnetStandaloneConfiguration({ home: '/must-not-access', runtimeDirectory: '/unused' }))
    .toThrow('MAINNET_STANDALONE_PROFILE_REQUIRED');
});

it.each(['development-environment.json', 'Mainnet/pay-development-mainnet.json', 'Mainnet/pay-mainnet-runtime.json',
  'Mainnet/app-ledger.sqlite', 'Mainnet/management-token', 'Mainnet/home'])('refuses missing existing state %s without provisioning replacements', missing => {
  const f = fixture(), path = join(f.root, missing); rmSync(path, { recursive: true });
  const before = fingerprint(f.home);
  expect(() => f.read()).toThrow(/MAINNET_STANDALONE_/);
  expect(existsSync(path)).toBe(false); expect(fingerprint(f.home)).toBe(before);
});

it.each([
  ['development-environment.json', { version: 1, environment: 'devnet', mainnetRiskAccepted: false, rpcUrl: 'https://rpc.example' }],
  ['development-environment.json', { version: 1, environment: 'mainnet', mainnetRiskAccepted: false, rpcUrl: 'https://rpc.example' }],
  ['development-environment.json', { version: 1, environment: 'mainnet', mainnetRiskAccepted: true, rpcUrl: 'https://rpc.example/?secret=TOKEN' }],
  ['mainnet-signer-acceptance.json', { version: 1, identity: 'other-wallet' }],
  ['Mainnet/product-configuration.json', { YOSH_ENABLE_MAINNET_EXECUTION: 'true' }],
  ['Mainnet/product-configuration.json', { YOSH_MAINNET_WALLET_PUBLIC_KEY: '11111111111111111111111111111111' }],
  ['Mainnet/product-configuration.json', { SOLANA_MAINNET_RPC_URL: 'https://other-rpc.example' }],
  ['Mainnet/product-configuration.json', { YOSH_MANAGEMENT_TOKEN: 'SECRET_REPLACEMENT' }],
  ['Mainnet/execution-selection.json', { version: 1, mode: 'live_devnet' }],
  ['Mainnet/pay-development-mainnet.json', { version: 1, kind: 'yosh-pay-mainnet-development', directory: '/different/Mainnet' }],
] as const)('rejects changed or invalid immutable launch facts in %s', (path, value) => {
  const f = fixture(); f.write(join(f.root, path), value);
  const before = fingerprint(f.home);
  expect(() => f.read()).toThrow(/MAINNET_STANDALONE_/); expect(fingerprint(f.home)).toBe(before);
});

it.each(['origin', 'cardMemberId'] as const)('rejects a persisted connection with a different %s', field => {
  const f = fixture(); f.write(join(f.directory, 'mcp-connection.json'), { ...f.connection,
    [field]: field === 'origin' ? 'http://127.0.0.1:17449' : randomUUID() });
  expect(() => f.read()).toThrow('MAINNET_STANDALONE_IDENTITY_MISMATCH');
});

it.each(['management-token', 'product-configuration.json', 'app-ledger.sqlite'])('rejects unsafe permissions and symlinks for %s', name => {
  const f = fixture(), path = join(f.directory, name);
  chmodSync(path, 0o644); expect(() => f.read()).toThrow('MAINNET_STANDALONE_STORAGE_REJECTED');
  chmodSync(path, 0o600); const target = join(f.home, 'target'); writeFileSync(target, readFileSync(path), { mode: 0o600 });
  rmSync(path); symlinkSync(target, path); expect(() => f.read()).toThrow('MAINNET_STANDALONE_STORAGE_REJECTED');
});

it('validates the fixed existing directory and private HOME without creating or following an alias', () => {
  const f = fixture(); chmodSync(f.root, 0o755);
  expect(() => f.read()).toThrow('MAINNET_STANDALONE_STORAGE_REJECTED'); chmodSync(f.root, 0o700);
  const original = join(f.directory, 'home'); rmSync(original, { recursive: true }); symlinkSync(f.home, original);
  expect(() => f.read()).toThrow('MAINNET_STANDALONE_STORAGE_REJECTED');
});

it('reads only the top-level enabled HTTPS system proxy and rejects malformed enabled settings', () => {
  expect(parseMainnetStandaloneSystemProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 6074\n  __SCOPED__ : <dictionary> {\n    en0 : <dictionary> {\n      HTTPSProxy : wrong.example\n    }\n  }\n}'))
    .toEqual({ host: '127.0.0.1', port: 6074 });
  expect(parseMainnetStandaloneSystemProxy('<dictionary> {\n  HTTPSEnable : 0\n}')).toBeUndefined();
  for (const value of [
    '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : user:SECRET@proxy\n  HTTPSPort : 6074\n}',
    '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : proxy.example\n  HTTPSPort : 65536\n}',
    '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSEnable : 0\n}',
    'SECRET_INVALID_RESPONSE',
  ]) expect(() => parseMainnetStandaloneSystemProxy(value)).toThrow('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
});

it('the production loader uses the OS account home and a bounded system proxy query', async () => {
  const f = fixture(); vi.stubEnv('HOME', '/must-not-use-ambient-home'); vi.stubEnv('YOSH_DATA_DIR', '/must-not-use-ambient-data');
  system.proxy = '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : proxy.example\n  HTTPSPort : 8080\n}';
  const result = await loadMainnetStandaloneConfiguration(f.runtimeDirectory);
  expect(result.directory).toBe(f.directory); expect(result.environment.HTTPS_PROXY).toBe('http://proxy.example:8080');
  expect(system.execute).toHaveBeenCalledWith('/usr/sbin/scutil', ['--proxy'], expect.objectContaining({ timeout: 2000, maxBuffer: 16384,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_ENV: 'production' } }));
  system.failed = true;
  await expect(loadMainnetStandaloneConfiguration(f.runtimeDirectory)).rejects.toThrow('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
});

it.each(['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])('rejects changed or missing Node startup proxy fact %s before starting the backend', key => {
  const f = fixture();
  const expected = readMainnetStandaloneConfiguration({ home: f.home, runtimeDirectory: f.runtimeDirectory,
    httpsProxy: { host: '127.0.0.1', port: 6074 } }).environment;
  expect(() => assertMainnetProxyStartupEnvironment(expected, { ...expected, [key]: 'CHANGED_PROXY_FACT' }))
    .toThrow('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
  expect(() => assertMainnetProxyStartupEnvironment(expected, { ...expected, [key]: undefined }))
    .toThrow('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
});

it('accepts matching startup proxy facts and rejects late configuration or a proxy removed since launch', () => {
  const f = fixture(), withoutProxy = f.read().environment;
  const withProxy = readMainnetStandaloneConfiguration({ home: f.home, runtimeDirectory: f.runtimeDirectory,
    httpsProxy: { host: '127.0.0.1', port: 6074 } }).environment;
  expect(() => assertMainnetProxyStartupEnvironment(withProxy, { ...withProxy, UNRELATED: 'IGNORED' })).not.toThrow();
  expect(() => assertMainnetProxyStartupEnvironment(withoutProxy, withoutProxy)).not.toThrow();
  expect(() => assertMainnetProxyStartupEnvironment(withProxy, {})).toThrow('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
  expect(() => assertMainnetProxyStartupEnvironment(withProxy, withoutProxy)).toThrow('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
  expect(() => assertMainnetProxyStartupEnvironment(withoutProxy, withProxy)).toThrow('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
});

it('activates the configured HTTPS proxy at Node startup without any direct external connection', async () => {
  const f = fixture(), targets: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    targets.push(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const location = proxy.address();
  if (!location || typeof location === 'string') throw new Error('FIXTURE_PROXY_REQUIRED');
  const configuration = readMainnetStandaloneConfiguration({ home: f.home, runtimeDirectory: f.runtimeDirectory,
    httpsProxy: { host: '127.0.0.1', port: location.port } });
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execute = async (late: boolean) => {
    const script = `const https = require('node:https');
      ${late ? `process.env.NODE_USE_ENV_PROXY='1'; process.env.HTTPS_PROXY=${JSON.stringify(configuration.environment.HTTPS_PROXY)};` : ''}
      const request = https.request('https://merchant.example.invalid/fixture', { lookup(_host, _options, callback) {
        callback(Object.assign(new Error('DIRECT_NETWORK_BLOCKED'), {code:'DIRECT_NETWORK_BLOCKED'}));
      }});
      const timer=setTimeout(()=>request.destroy(new Error('FIXTURE_TIMEOUT')),1500);
      request.once('error',error=>{clearTimeout(timer);process.stdout.write(error.code || error.message);});
      request.once('response',response=>{clearTimeout(timer);response.resume();});request.end();`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'],
      env: late ? { HOME: configuration.environment.HOME, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }
        : { ...configuration.environment, NODE_ENV: 'production' } });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FIXTURE_CHILD_TIMEOUT')); }, 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('FIXTURE_CHILD_FAILED')); });
    });
    return output;
  };
  try {
    expect(await execute(false)).not.toContain('DIRECT_NETWORK_BLOCKED');
    expect(targets).toEqual(['merchant.example.invalid:443']);
    targets.length = 0;
    expect(await execute(true)).toContain('DIRECT_NETWORK_BLOCKED');
    expect(targets).toEqual([]);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
