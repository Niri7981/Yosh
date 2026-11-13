import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installMainnetRuntime, verifyMainnetRuntime } from '../../src/modules/pay-dev/mainnet-runtime-artifact';
import { claimMainnetProcessLock, drainMainnetBackend, ensureMainnetBackend, inspectMainnetBackend, stopMainnetBackend, writeMainnetOwner } from '../../src/modules/pay-dev/mainnet-standalone-owner';

const cleanups: string[] = [];
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-owner-'))); cleanups.push(home);
  const root = join(home, 'Yosh Pay Dev v0.1.1-rc.5'), directory = join(root, 'Mainnet'), runtime = join(home, 'package');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); mkdirSync(runtime, { mode: 0o700 });
  const files = Object.fromEntries(['node', 'mainnet.cjs', 'mainnet-mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'mainnet.sb'].map(name => {
    writeFileSync(join(runtime, name), `fixture-${name}`); return [name, hash(`fixture-${name}`)];
  }));
  mkdirSync(join(runtime, 'licenses'));
  const licenses = Object.fromEntries(['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE'].map(name => {
    writeFileSync(join(runtime, 'licenses', name), name); return [name, hash(name)];
  }));
  writeFileSync(join(runtime, 'mainnet-manifest.json'), JSON.stringify({ kind: 'yosh-mainnet-standalone', apiVersion: 1,
    dataContract: 'existing-mainnet-v1', profile: 'com.yosh.pay-development.v011rc5', productionEnabled: false, files, licenses }));
  const configuration = { root, directory, origin: 'http://127.0.0.1:13449' as const, port: 13449 as const,
    memberId: '11111111-1111-4111-8111-111111111111', environment: { YOSH_MANAGEMENT_TOKEN: 't'.repeat(43) } };
  return { runtime, configuration, digest: hash(readFileSync(join(runtime, 'mainnet-manifest.json'))) };
}
function health(directory: string, digest?: string) {
  return { ready: true, coreReady: true, service: 'Yosh', pid: process.pid, dataDirectory: directory,
    ...(digest ? { hosting: { kind: 'mainnet-standalone', apiVersion: 1, dataContract: 'existing-mainnet-v1', runtimeDigest: digest } } : {}) };
}
function transport(secret: string, state: () => unknown): typeof fetch {
  return async (_input, init) => {
    const value = state();
    if (!value) throw new TypeError('unavailable', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const bytes = JSON.stringify(value), nonce = new Headers(init?.headers).get('x-2049-nonce');
    const proof = createHmac('sha256', secret).update(['2049-management-response-v1', nonce, '200', hash(bytes)].join('\n')).digest('hex');
    return new Response(bytes, { headers: { 'x-2049-response-proof': proof } });
  };
}

it('installs only verified program files independently of cache and preserves financial data', () => {
  const { runtime, configuration, digest } = fixture();
  writeFileSync(join(configuration.directory, 'app-ledger.sqlite'), 'existing-ledger');
  const before = readFileSync(join(configuration.directory, 'app-ledger.sqlite'));
  expect(verifyMainnetRuntime(runtime).digest).toBe(digest);
  const installed = installMainnetRuntime(runtime, configuration.root);
  expect(installed).not.toBe(runtime);
  expect(installMainnetRuntime(runtime, configuration.root)).toBe(installed);
  rmSync(runtime, { recursive: true });
  expect(verifyMainnetRuntime(installed).digest).toBe(digest);
  expect(readFileSync(join(configuration.directory, 'app-ledger.sqlite'))).toEqual(before);
});

it('rejects tampering and symbolic program paths before installation', () => {
  const { runtime, configuration } = fixture();
  writeFileSync(join(runtime, 'pay-mcp'), 'changed');
  expect(() => installMainnetRuntime(runtime, configuration.root)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
  writeFileSync(join(runtime, 'pay-mcp'), 'fixture-pay-mcp');
  rmSync(join(runtime, 'node')); symlinkSync(join(runtime, 'pay-mcp'), join(runtime, 'node'));
  expect(() => verifyMainnetRuntime(runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
});

it('concurrent cold starts elect one owner and reuse the same original data', async () => {
  const { configuration, digest } = fixture(); let current: unknown;
  const fetcher = transport(configuration.environment.YOSH_MANAGEMENT_TOKEN, () => current);
  const launch = vi.fn(() => {
    writeMainnetOwner(configuration.directory, digest, true);
    current = health(configuration.directory, digest);
    return { failed: () => false };
  });
  const options = { configuration, digest, fetcher, launch, timeoutMs: 500, pollMs: 5 };
  const results = await Promise.all([ensureMainnetBackend(options), ensureMainnetBackend(options)]);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(results.every(result => result?.owner === 'standalone' && result.pid === process.pid)).toBe(true);
});

it('attaches to the authenticated original backend without starting or stopping it', async () => {
  const { configuration, digest } = fixture();
  const fetcher = transport(configuration.environment.YOSH_MANAGEMENT_TOKEN, () => health(configuration.directory));
  const launch = vi.fn(() => ({ failed: () => false }));
  expect(await ensureMainnetBackend({ configuration, digest, fetcher, launch })).toMatchObject({ owner: 'existing-backend' });
  expect(launch).not.toHaveBeenCalled();
  await expect(stopMainnetBackend({ configuration, digest, fetcher })).rejects.toThrow('MAINNET_BACKEND_NOT_OWNED');
});

it('does not treat a timeout or an unauthenticated listener as permission to spawn', async () => {
  const { configuration, digest } = fixture(); const launch = vi.fn(() => ({ failed: () => false }));
  const timeout: typeof fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  await expect(ensureMainnetBackend({ configuration, digest, launch, fetcher: timeout })).rejects.toThrow('MAINNET_BACKEND_UNAVAILABLE');
  const wrongProof = transport('wrong', () => health(configuration.directory));
  await expect(ensureMainnetBackend({ configuration, digest, launch, fetcher: wrongProof })).rejects.toThrow('MAINNET_BACKEND_AUTH_FAILED');
  expect(launch).not.toHaveBeenCalled();
});

it('does not report shutdown complete while a listener-free service is still draining', async () => {
  const { configuration, digest } = fixture();
  const service = claimMainnetProcessLock(configuration.directory, 'mainnet-standalone-service.sqlite');
  const fetcher = transport(configuration.environment.YOSH_MANAGEMENT_TOKEN, () => undefined);
  try {
    await expect(stopMainnetBackend({ configuration, digest, fetcher })).rejects.toThrow('MAINNET_STOP_INCOMPLETE');
  } finally { service.release(); }
  await expect(stopMainnetBackend({ configuration, digest, fetcher })).resolves.toBeUndefined();
});

it('drains the payment runtime even when advisory owner metadata cannot be written', async () => {
  const events: string[] = [];
  await expect(drainMainnetBackend({
    markStopping: () => { events.push('metadata'); throw new Error('WRITE_FAILED'); },
    close: async () => { events.push('drained'); },
    release: () => { events.push('released'); },
  })).rejects.toThrow('WRITE_FAILED');
  expect(events).toEqual(['metadata', 'drained', 'released']);
  const release = vi.fn();
  await expect(drainMainnetBackend({ markStopping: () => {}, close: async () => { throw new Error('DRAIN_FAILED'); }, release }))
    .rejects.toThrow('DRAIN_FAILED');
  expect(release).not.toHaveBeenCalled();
});

it('rejects incompatible or mismatched running owners and preserves stopped version metadata', async () => {
  const { configuration, digest } = fixture();
  writeMainnetOwner(configuration.directory, 'a'.repeat(64), true);
  const fetcher = transport(configuration.environment.YOSH_MANAGEMENT_TOKEN, () => health(configuration.directory, 'a'.repeat(64)));
  await expect(inspectMainnetBackend({ configuration, digest, fetcher })).rejects.toThrow('MAINNET_RUNTIME_VERSION_MISMATCH');
  const launch = vi.fn(() => ({ failed: () => false }));
  await expect(ensureMainnetBackend({ configuration, digest, launch,
    fetcher: transport(configuration.environment.YOSH_MANAGEMENT_TOKEN, () => undefined) })).rejects.toThrow('MAINNET_RUNTIME_VERSION_MISMATCH');
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(configuration.directory, 'mainnet-standalone-owner.json'), 'utf8')).runtimeDigest).toBe('a'.repeat(64));
});

it('never stops the original App if it replaces the inspected standalone listener before shutdown', async () => {
  const { configuration, digest } = fixture();
  writeMainnetOwner(configuration.directory, digest, true);
  let oldAppStopped = false;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; requests.push(`${init?.method} ${path}`);
    if (oldAppStopped) throw new TypeError('unavailable', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    // The same installation token authenticates both hosts. The old App takes
    // the listener after the health observation but before receiving the POST.
    const post = init?.method === 'POST';
    const genericShutdown = post && path === '/api/app/lifecycle';
    if (genericShutdown) oldAppStopped = true;
    const status = post && !genericShutdown ? 404 : 200;
    const bytes = JSON.stringify(post ? status === 404 ? { code: 'NOT_FOUND' } : { ready: true }
      : health(configuration.directory, digest));
    const nonce = new Headers(init?.headers).get('x-2049-nonce');
    const proof = createHmac('sha256', configuration.environment.YOSH_MANAGEMENT_TOKEN)
      .update(['2049-management-response-v1', nonce, String(status), hash(bytes)].join('\n')).digest('hex');
    return new Response(bytes, { status, headers: { 'x-2049-response-proof': proof } });
  };
  const failure: unknown = await stopMainnetBackend({ configuration, digest, fetcher }).then(() => undefined, error => error);
  expect(oldAppStopped).toBe(false);
  expect(requests).not.toContain('POST /api/app/lifecycle');
  expect(failure).toBeInstanceOf(Error);
});
