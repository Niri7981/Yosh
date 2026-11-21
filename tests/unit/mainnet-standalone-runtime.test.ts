import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { upgradeMainnetRuntime } from '../../src/modules/pay-dev/mainnet-runtime-upgrade';
import { acquireDataDirectoryOwnership } from '../../src/modules/app/data-directory-owner';
import { installMainnetRuntime, verifyMainnetRuntime } from '../../src/modules/pay-dev/mainnet-runtime-artifact';
import { claimMainnetProcessLock, drainMainnetBackend, ensureMainnetBackend, inspectMainnetBackend, requireRunningResourceOwner, stopMainnetBackend, readMainnetOwner, writeMainnetOwner } from '../../src/modules/pay-dev/mainnet-standalone-owner';

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

it('resource discovery only inspects the running standalone owner and leaves stopped or starting owners alone', async () => {
  const { configuration, digest } = fixture();
  const secret = configuration.environment.YOSH_MANAGEMENT_TOKEN;
  const fetcher = vi.fn(transport(secret, () => undefined));
  await expect(requireRunningResourceOwner({configuration, digest, fetcher})).rejects.toThrow('LOCAL_RESOURCE_OWNER_OFFLINE');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]).toMatchObject({0: configuration.origin + '/api/app/health', 1: {method: 'GET'}});
  expect(readMainnetOwner(configuration.directory)).toBeUndefined();
  const running = transport(secret, () => health(configuration.directory, digest));
  await expect(requireRunningResourceOwner({configuration, digest, fetcher: running})).rejects.toThrow('MAINNET_BACKEND_STARTING');
  writeMainnetOwner(configuration.directory, digest, true);
  await expect(requireRunningResourceOwner({configuration, digest, fetcher: running})).resolves.toBeUndefined();
  await expect(requireRunningResourceOwner({configuration, digest, fetcher: transport(secret, () => health(configuration.directory))}))
    .rejects.toThrow('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
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

function mppCandidate(runtime: string) {
  const path = join(runtime, 'mainnet-manifest.json');
  const old = JSON.parse(readFileSync(path, 'utf8'));
  const files = { ...old.files };
  for (const name of ['mpp-protocol-engine', 'mpp-provenance.json']) {
    writeFileSync(join(runtime, name), `fixture-${name}`); files[name] = hash(`fixture-${name}`);
  }
  writeFileSync(path, JSON.stringify({ ...old, mppProtocol: true, files }));
  return hash(readFileSync(path));
}
it('binds the Mainnet MPP capability to both verified executable and provenance bytes', () => {
  const f = fixture();
  const digest = mppCandidate(f.runtime);
  expect(verifyMainnetRuntime(f.runtime).manifest.mppProtocol).toBe(true);
  const installed = installMainnetRuntime(f.runtime, f.configuration.root);
  expect(verifyMainnetRuntime(installed).digest).toBe(digest);
  writeFileSync(join(f.runtime, 'mpp-protocol-engine'), 'tampered');
  expect(() => verifyMainnetRuntime(f.runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
});
it('cannot claim Mainnet MPP with the old file set', () => {
  const f = fixture(); const path = join(f.runtime, 'mainnet-manifest.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), mppProtocol: true }));
  expect(() => verifyMainnetRuntime(f.runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
});
it('requires a verified native consent helper for first-use purchases', () => {
  const { runtime } = fixture();
  const path = join(runtime, 'mainnet-manifest.json');
  const manifest = { ...JSON.parse(readFileSync(path, 'utf8')), firstUsePurchases: true };
  writeFileSync(path, JSON.stringify(manifest));
  expect(() => verifyMainnetRuntime(runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
  writeFileSync(join(runtime, 'yosh-confirm'), 'fixture-helper');
  manifest.files['yosh-confirm'] = hash('fixture-helper');
  writeFileSync(path, JSON.stringify(manifest));
  expect(verifyMainnetRuntime(runtime).manifest.firstUsePurchases).toBe(true);
  writeFileSync(path, JSON.stringify({ ...manifest, purchaseResourceLookup: true, firstUsePurchases: false }));
  expect(() => verifyMainnetRuntime(runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
  writeFileSync(path, JSON.stringify({ ...manifest, purchaseResourceLookup: true }));
  expect(verifyMainnetRuntime(runtime).manifest.purchaseResourceLookup).toBe(true);
  writeFileSync(join(runtime, 'yosh-confirm'), 'replaced helper');
  expect(() => verifyMainnetRuntime(runtime)).toThrow('MAINNET_RUNTIME_INTEGRITY_FAILED');
});
it('explicit stopped-owner upgrade changes only the version fence, retaining financial bytes and rejecting stale startup', async () => {
  const f = fixture(); installMainnetRuntime(f.runtime, f.configuration.root);
  writeMainnetOwner(f.configuration.directory, f.digest, false);
  const ledgerPath = join(f.configuration.directory, 'app-ledger.sqlite'); writeFileSync(ledgerPath, 'original-ledger');
  const next = mppCandidate(f.runtime);
  const fetcher = transport(f.configuration.environment.YOSH_MANAGEMENT_TOKEN, () => undefined);
  await upgradeMainnetRuntime(f.runtime, f.configuration, fetcher);
  expect(readMainnetOwner(f.configuration.directory)).toMatchObject({ runtimeDigest: next, ready: false });
  expect(readFileSync(ledgerPath, 'utf8')).toBe('original-ledger');
  const launch = vi.fn(() => ({ failed: () => false }));
  await expect(ensureMainnetBackend({ configuration: f.configuration, digest: f.digest, fetcher, launch }))
    .rejects.toThrow('MAINNET_RUNTIME_VERSION_MISMATCH');
  expect(launch).not.toHaveBeenCalled();
});
it('refuses a handoff while the App core owns the ledger, even when no listener or standalone service is present', async () => {
  const f = fixture(); installMainnetRuntime(f.runtime, f.configuration.root);
  writeMainnetOwner(f.configuration.directory, f.digest, false); mppCandidate(f.runtime);
  const core = acquireDataDirectoryOwnership(f.configuration.directory);
  try {
    await expect(upgradeMainnetRuntime(f.runtime, f.configuration,
      transport(f.configuration.environment.YOSH_MANAGEMENT_TOKEN, () => undefined))).rejects.toThrow('DATA_DIRECTORY_IN_USE');
    expect(readMainnetOwner(f.configuration.directory)?.runtimeDigest).toBe(f.digest);
  } finally { core.release(); }
});
it('refuses a handoff from an undrained owner with no listener', async () => {
  const f = fixture(); installMainnetRuntime(f.runtime, f.configuration.root);
  writeMainnetOwner(f.configuration.directory, f.digest, true); mppCandidate(f.runtime);
  await expect(upgradeMainnetRuntime(f.runtime, f.configuration,
    transport(f.configuration.environment.YOSH_MANAGEMENT_TOKEN, () => undefined))).rejects.toThrow('MAINNET_RUNTIME_HANDOFF_CHANGED');
  expect(readMainnetOwner(f.configuration.directory)?.runtimeDigest).toBe(f.digest);
});
