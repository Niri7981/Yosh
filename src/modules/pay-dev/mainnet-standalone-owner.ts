import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { acquireDataDirectoryOwnership, DataDirectoryInUseError } from '../app/data-directory-owner';

export type MainnetOwnerConfiguration = { directory: string; origin: string; environment: Record<string, string> };
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Hosting = z.object({ kind: z.literal('mainnet-standalone'), apiVersion: z.literal(1),
  dataContract: z.literal('existing-mainnet-v1'), runtimeDigest: Digest }).strict();
const Owner = Hosting.extend({ pid: z.number().int().positive(), ready: z.boolean() }).strict();
const Health = z.object({ ready: z.literal(true), coreReady: z.literal(true), service: z.literal('Yosh'),
  pid: z.number().int().positive(), dataDirectory: z.string(), hosting: Hosting.optional() });
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const ownerPath = (directory: string) => join(directory, 'mainnet-standalone-owner.json');

export function readMainnetOwner(directory: string) {
  let fd: number;
  try { fd = openSync(ownerPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('MAINNET_OWNER_INVALID');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) throw new Error();
    return Owner.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } catch { throw new Error('MAINNET_OWNER_INVALID'); }
  finally { closeSync(fd); }
}

export function writeMainnetOwner(directory: string, digest: string, ready: boolean) {
  const value = Owner.parse({ kind: 'mainnet-standalone', apiVersion: 1, dataContract: 'existing-mainnet-v1',
    runtimeDigest: digest, pid: process.pid, ready });
  const temporary = ownerPath(directory) + '.' + randomBytes(16).toString('hex');
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
  renameSync(temporary, ownerPath(directory));
}

export async function drainMainnetBackend(options: { markStopping: () => void; close: () => Promise<void>; release: () => void }) {
  let metadataFailure: unknown;
  try { options.markStopping(); } catch (error) { metadataFailure = error; }
  // The sidecar is advisory. A full disk must never bypass the payment barrier
  // or prevent draining; exclusive ownership lasts until the core has closed.
  await options.close();
  options.release();
  if (metadataFailure !== undefined) throw metadataFailure;
}

export function claimMainnetProcessLock(directory: string, name: 'mainnet-standalone-start.sqlite' | 'mainnet-standalone-service.sqlite') {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = lstatSync(join(directory, name + suffix));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw new Error('MAINNET_OWNER_STORAGE_INVALID');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return acquireDataDirectoryOwnership(directory, name);
}

async function management(configuration: MainnetOwnerConfiguration, path: string, body: string | undefined, fetcher: typeof fetch) {
  const secret = configuration.environment.YOSH_MANAGEMENT_TOKEN;
  if (!secret) throw new Error('MAINNET_MANAGEMENT_IDENTITY_MISSING');
  const nonce = randomBytes(32).toString('hex'), timestamp = String(Date.now()), method = body === undefined ? 'GET' : 'POST';
  const proof = createHmac('sha256', secret).update(['2049-management-v1', method, path, timestamp, nonce, hash(body ?? '')].join('\n')).digest('hex');
  let response: Response;
  try {
    response = await fetcher(configuration.origin + path, { method, body, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { origin: configuration.origin, 'content-type': 'application/json', 'x-2049-nonce': nonce,
        'x-2049-timestamp': timestamp, 'x-2049-body-sha256': hash(body ?? ''), 'x-2049-proof': proof } });
  } catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ECONNREFUSED') return undefined;
    throw new Error('MAINNET_BACKEND_UNAVAILABLE');
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 65536) throw new Error('MAINNET_BACKEND_RESPONSE_INVALID');
      chunks.push(part.value);
    }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  const bytes = Buffer.concat(chunks), actual = response.headers.get('x-2049-response-proof') ?? '';
  const expected = createHmac('sha256', secret).update(['2049-management-response-v1', nonce, String(response.status), hash(bytes)].join('\n')).digest();
  if (!/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), expected)) throw new Error('MAINNET_BACKEND_AUTH_FAILED');
  if (!response.ok) throw new Error('MAINNET_BACKEND_NOT_READY');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error('MAINNET_BACKEND_RESPONSE_INVALID'); }
}

type Options = { configuration: MainnetOwnerConfiguration; digest: string; fetcher?: typeof fetch };
async function startupLock(directory: string, deadline: number, pollMs: number) {
  while (Date.now() < deadline) {
    try { return claimMainnetProcessLock(directory, 'mainnet-standalone-start.sqlite'); }
    catch (error) { if (!(error instanceof DataDirectoryInUseError)) throw error; await delay(pollMs); }
  }
  throw new Error('MAINNET_START_BUSY');
}
export async function inspectMainnetBackend({ configuration, digest, fetcher = fetch }: Options) {
  const raw = await management(configuration, '/api/app/health', undefined, fetcher);
  if (raw === undefined) return undefined;
  const health = Health.safeParse(raw);
  if (!health.success || health.data.dataDirectory !== configuration.directory) throw new Error('MAINNET_BACKEND_IDENTITY_MISMATCH');
  if (!health.data.hosting) return { owner: 'existing-backend' as const, pid: health.data.pid };
  if (health.data.hosting.runtimeDigest !== digest) throw new Error('MAINNET_RUNTIME_VERSION_MISMATCH');
  const owner = readMainnetOwner(configuration.directory);
  if (!owner || !owner.ready) throw new Error('MAINNET_BACKEND_STARTING');
  if (owner.pid !== health.data.pid || owner.runtimeDigest !== digest) throw new Error('MAINNET_BACKEND_IDENTITY_MISMATCH');
  return { owner: 'standalone' as const, pid: owner.pid };
}

export async function ensureMainnetBackend(options: Options & { launch: () => { failed: () => boolean }; timeoutMs?: number; pollMs?: number }) {
  const { configuration, digest, timeoutMs = 60_000, pollMs = 100 } = options;
  const deadline = Date.now() + timeoutMs;
  const lock = await startupLock(configuration.directory, deadline, pollMs);
  try {
    let starting = false;
    try {
      const existing = await inspectMainnetBackend(options);
      if (existing) return existing;
    } catch (error) {
      if (!(error instanceof Error && error.message === 'MAINNET_BACKEND_STARTING')) throw error;
      starting = true;
    }
    const previous = readMainnetOwner(configuration.directory);
    if (previous && previous.runtimeDigest !== digest) throw new Error('MAINNET_RUNTIME_VERSION_MISMATCH');
    // No listener is insufficient proof of absence: an owner may still be
    // draining a signer. The shared AppRuntime lock remains the final arbiter.
    const child = starting ? { failed: () => false } : options.launch();
    while (Date.now() < deadline && !child.failed()) {
      await delay(pollMs);
      try {
        const result = await inspectMainnetBackend(options);
        if (result) return result;
      } catch (error) {
        if (!(error instanceof Error && error.message === 'MAINNET_BACKEND_STARTING')) throw error;
      }
    }
    // Do not kill a slow owner: Keychain or original-payment recovery can outlive this observation.
    throw new Error(child.failed() ? 'MAINNET_START_FAILED' : 'MAINNET_START_TIMEOUT');
  } finally { lock.release(); }
}

export async function stopMainnetBackend(options: Options) {
  const lock = await startupLock(options.configuration.directory, Date.now() + 60_000, 100);
  try {
    const owner = await inspectMainnetBackend(options);
    if (!owner) {
      // Closing the listener precedes draining signers and releasing ownership.
      // Refused TCP alone must not be reported as a completed shutdown.
      try {
        const service = claimMainnetProcessLock(options.configuration.directory, 'mainnet-standalone-service.sqlite');
        service.release(); return;
      } catch (error) {
        if (error instanceof DataDirectoryInUseError) throw new Error('MAINNET_STOP_INCOMPLETE');
        throw error;
      }
    }
    if (owner.owner !== 'standalone') throw new Error('MAINNET_BACKEND_NOT_OWNED');
    // Bind shutdown in the receiving process. Shared credentials alone cannot
    // prevent an old App from taking the port between a health read and POST.
    await management(options.configuration, '/api/app/mainnet-standalone-lifecycle',
      JSON.stringify({ action: 'shutdown', pid: owner.pid, runtimeDigest: options.digest }), options.fetcher ?? fetch);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await delay(100);
      try {
        const current = await inspectMainnetBackend(options);
        if (current && (current.pid !== owner.pid || current.owner !== 'standalone')) throw new Error('MAINNET_BACKEND_NOT_OWNED');
        if (!current) {
          const service = claimMainnetProcessLock(options.configuration.directory, 'mainnet-standalone-service.sqlite');
          service.release(); return;
        }
      } catch (error) {
        if (!(error instanceof DataDirectoryInUseError) && !(error instanceof Error && error.message === 'MAINNET_BACKEND_STARTING')) throw error;
      }
    }
    throw new Error('MAINNET_STOP_INCOMPLETE');
  } finally { lock.release(); }
}
