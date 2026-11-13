import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { callMainnetAuthorization } from '../src/modules/authority/mainnet-authorization-client';
import { startLocalAuthorization } from '../src/modules/authority/local-authorization-server';
import { nativeGrantConfirmation, nativeControlConfirmation } from '../src/modules/authority/native-grant-confirmation';
import { startLiveDevnetDevelopmentBackend } from '../src/modules/pay-dev/live-devnet-runtime';
import { IS_LOCAL_AUTH_DEVELOPMENT as local } from '../src/modules/pay-dev/profile';
/** Development-only process owner; no real wallet, web authority or auto-update. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { acquireDataDirectoryOwnership, DataDirectoryInUseError } from '../src/modules/app/data-directory-owner';
import { startPayDevelopmentBackend } from '../src/modules/pay-dev/runtime';
import { PAY_DEVELOPMENT_PROFILE as profile } from '../src/modules/pay-dev/profile';

const API_VERSION = local ? 2 : 1;
const SCHEMA_CONTRACT = local ? 'local-devnet-v1' : 'standalone-offline-v1';
const runtimeKind = local ? 'yosh-local-devnet' : 'yosh-standalone-offline-dev';
const environment = local ? 'devnet' : 'offline';
const backendDirectory = (directory: string) => local ? join(directory, 'Devnet') : directory;
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const origin = `http://127.0.0.1:${profile.backendPort}`;
const runtime = dirname(resolve(process.argv[1]));
const executable = join(runtime, 'node');
const Control = z.object({ apiVersion: z.literal(API_VERSION), dataContract: z.literal(SCHEMA_CONTRACT),
  profile: z.literal(profile.bundleIdentifier), environment: z.literal(environment),
  managementSecret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Owner = z.object({ apiVersion: z.literal(API_VERSION), dataContract: z.literal(SCHEMA_CONTRACT),
  runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive(), ready: z.boolean() }).strict();
const Manifest = z.object({ kind: z.literal(runtimeKind), apiVersion: z.literal(API_VERSION),
  dataContract: z.literal(SCHEMA_CONTRACT), productionEnabled: z.literal(false),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).passthrough();
const runtimeFiles = ['node', 'standalone.cjs', 'mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'offline.sb',
  ...(local ? ['local-mcp.cjs', 'mainnet-launch.mjs', 'mainnet-launch.sh', 'yosh-confirm', 'spirit-design-sheet.png', 'instrument-serif.woff2', 'Instrument-Serif-OFL.txt'] : [])];

function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o700) throw new Error('STANDALONE_PRIVATE_DIRECTORY_REQUIRED');
}
function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384)
    throw new Error('STANDALONE_PRIVATE_FILE_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function checkLockFiles(directory: string, name: string) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(join(directory, name + suffix));
      if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('STANDALONE_STORAGE_REJECTED');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
function verifyRuntime() {
  const manifestBytes = readFileSync(join(runtime, 'manifest.json'));
  const manifest = Manifest.parse(JSON.parse(manifestBytes.toString('utf8')));
  if (Object.keys(manifest.files).length !== runtimeFiles.length) throw new Error('STANDALONE_RUNTIME_INCOMPLETE');
  for (const required of runtimeFiles)
    if (!manifest.files[required]) throw new Error('STANDALONE_RUNTIME_INCOMPLETE');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('STANDALONE_RUNTIME_PATH_INVALID');
    const path = join(runtime, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(path)) !== expected)
      throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
  }
  if (realpathSync(process.execPath) !== realpathSync(executable)) throw new Error('STANDALONE_PACKAGED_NODE_REQUIRED');
  return hash(manifestBytes);
}

/** Plugin caches are disposable. Copy verified program bytes atomically into
 * a content-addressed version directory separate from both cache and ledger. */
function installRuntime(directory: string, digest: string) {
  const root = join(dirname(directory), local ? 'Yosh Local Authorization Runtime Dev' : 'Yosh Standalone Runtime Dev');
  mkdirSync(root, { mode: 0o700, recursive: true });
  privateDirectory(root);
  const installed = join(root, digest);
  const bytes = readFileSync(join(runtime, 'manifest.json'));
  if (hash(bytes) !== digest) throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
  const manifest = Manifest.parse(JSON.parse(bytes.toString('utf8')));
  const verify = (target: string) => {
    privateDirectory(target);
    if (hash(readFileSync(join(target, 'manifest.json'))) !== digest) throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
    for (const [name, expected] of Object.entries(manifest.files)) {
      const file = join(target, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(file)) !== expected) throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
    }
  };
  if (existsSync(installed)) { verify(installed); return installed; }
  const staged = join(root, '.install-' + randomBytes(16).toString('hex'));
  mkdirSync(staged, { mode: 0o700 });
  try {
    for (const name of [...runtimeFiles, 'manifest.json']) copyFileSync(join(runtime, name), join(staged, name), constants.COPYFILE_EXCL);
    mkdirSync(join(staged, 'licenses'), { mode: 0o700 });
    for (const name of ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']) {
      const file = join(runtime, 'licenses', name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('STANDALONE_LICENSE_INVALID');
      copyFileSync(file, join(staged, 'licenses', name), constants.COPYFILE_EXCL);
    }
    verify(staged);
    try { renameSync(staged, installed); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code)))) throw error;
      verify(installed); // A concurrent installer can publish only identical bytes.
    }
    return installed;
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true }); }
}

async function management(directory: string, method: 'GET' | 'POST', path: string, body = '') {
  const { managementSecret: secret } = Control.parse(privateJson(join(directory, 'standalone-control.json')));
  const nonce = randomBytes(32).toString('hex'), timestamp = String(Date.now()), bodyHash = hash(body);
  const message = ['2049-management-v1', method, path, timestamp, nonce, bodyHash].join('\n');
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(2000),
    headers: { 'content-type': 'application/json', origin,
      'x-2049-nonce': nonce, 'x-2049-timestamp': timestamp, 'x-2049-body-sha256': bodyHash,
      'x-2049-proof': createHmac('sha256', secret).update(message).digest('hex') }, ...(body ? { body } : {}) });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 16384) throw new Error('STANDALONE_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally { await reader?.cancel(); reader?.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const proof = response.headers.get('x-2049-response-proof') ?? '';
  const expected = createHmac('sha256', secret).update(['2049-management-response-v1', nonce, String(response.status), hash(bytes)].join('\n')).digest();
  if (!/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), expected)) throw new Error('STANDALONE_BACKEND_AUTH_FAILED');
  if (!response.ok) throw new Error('STANDALONE_BACKEND_NOT_READY');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function readOwner(directory: string, digest: string) {
  const owner = Owner.parse(privateJson(join(directory, 'standalone-owner.json')));
  if (owner.runtimeDigest !== digest) throw new Error('STANDALONE_VERSION_INCOMPATIBLE');
  return owner;
}
async function ready(directory: string, digest: string) {
  let health: unknown;
  try { health = await management(directory, 'GET', '/api/app/health'); }
  catch (error) {
    // Only an actual connection refusal means no listener; auth failures or
    // slow/unknown listeners must not trigger a second backend or takeover.
    if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ECONNREFUSED') return false;
    throw error;
  }
  const owner = readOwner(directory, digest);
  const actual = z.object({ ready: z.literal(true), pid: z.number().int().positive(), dataDirectory: z.string(), service: z.literal('Yosh') }).parse(health);
  if (actual.pid !== owner.pid || actual.dataDirectory !== backendDirectory(directory)) throw new Error('STANDALONE_BACKEND_IDENTITY_MISMATCH');
  if (!owner.ready) throw new Error('STANDALONE_BACKEND_STARTING');
  return true;
}

async function serve(directory: string, digest: string) {
  const control = Control.parse(privateJson(join(directory, 'standalone-control.json')));
  checkLockFiles(directory, 'standalone-service.sqlite');
  const serviceLock = acquireDataDirectoryOwnership(directory, 'standalone-service.sqlite');
  Object.assign(process.env, { YOSH_MANAGEMENT_TOKEN: control.managementSecret,
    YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: environment, YOSH_DATA_DIR: backendDirectory(directory) });
  const first = !existsSync(join(backendDirectory(directory), 'app-ledger.sqlite'));
  let web: Awaited<ReturnType<typeof startLocalAuthorization>> | undefined;
  const record = join(directory, 'standalone-owner.json');
  const recordReady = (ready: boolean) => {
    const temporary = record + '.' + randomBytes(16).toString('hex');
    writeFileSync(temporary, JSON.stringify({ apiVersion: API_VERSION, dataContract: SCHEMA_CONTRACT, runtimeDigest: digest, pid: process.pid, ready }), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, record);
  };
  let backend: Awaited<ReturnType<typeof startPayDevelopmentBackend>> | Awaited<ReturnType<typeof startLiveDevnetDevelopmentBackend>> | undefined;
  try {
  recordReady(false);
  if (local) {
    mkdirSync(backendDirectory(directory), { mode: 0o700, recursive: true });
    const selection = join(directory, 'development-environment.json');
    if (!existsSync(selection)) writeFileSync(selection, JSON.stringify({ version: 1, environment: 'devnet', mainnetRiskAccepted: false,
      rpcUrl: 'https://solana-rpc.publicnode.com', devnetRpcUrl: 'https://api.devnet.solana.com' }), { mode: 0o600, flag: 'wx', flush: true });
    Object.assign(process.env, { YOSH_PORT: String(profile.backendPort), YOSH_PACKAGED_RUNTIME_DIR: runtime, YOSH_PAY_MCP_DEVNET: '1',
      YOSH_PAY_MCP_MAINNET: '0', YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_DEVNET_PURCHASES: '1', YOSH_ENABLE_MAINNET_EXECUTION: '0',
      SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://api.devnet.solana.com' });
    backend = await startLiveDevnetDevelopmentBackend({ directory: backendDirectory(directory), port: profile.backendPort, localAuthorizationOnly: true,
      afterClose: async () => { await web?.close(); },
      localAuthorizationLink: () => { if (!web) throw new Error('LOCAL_WEB_NOT_READY'); return web.createLink(); } });
    const manifest = Manifest.parse(JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8')));
    const assets = new Map<string, { bytes: Buffer; contentType: string }>([
      ['/spirit-design-sheet.png', { bytes: readFileSync(join(runtime, 'spirit-design-sheet.png')), contentType: 'image/png' }],
      ['/instrument-serif.woff2', { bytes: readFileSync(join(runtime, 'instrument-serif.woff2')), contentType: 'font/woff2' }],
    ]);
    web = await startLocalAuthorization({ mainnet: callMainnetAuthorization, app: backend.app, memberId: backend.descriptor.memberId, port: profile.backendPort + 3, assets,
      confirm: nativeGrantConfirmation(join(runtime, 'yosh-confirm'), manifest.files['yosh-confirm']),
      confirmControl: nativeControlConfirmation(join(runtime, 'yosh-confirm'), manifest.files['yosh-confirm']) });
  } else backend = await startPayDevelopmentBackend({ directory, runtimeDirectory: runtime });
  if (first) {
    backend.app.setPaused(true);
    // Offline fixture pairing, no Grant and no unpause. Product pairing belongs
    // to C's trusted confirmation and is intentionally not enabled here.
    if (!local) await backend.app.setMemberConnection(true, origin, backend.descriptor.memberId);
  }
  recordReady(true);
  const running = backend;
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await web?.close();
    await running.close();
    serviceLock.release();
  };
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  } catch (error) {
    await web?.close(); await backend?.close(); serviceLock.release(); throw error;
  }
}

/** Explicit same-contract upgrade. The old verified owner drains before any
 * version metadata changes; both ownership locks protect the handoff. */
async function upgradeRuntime(directory: string, digest: string) {
  if (!local) throw new Error('STANDALONE_UPGRADE_LOCAL_ONLY');
  const controlPath = join(directory, 'standalone-control.json');
  Control.parse(privateJson(controlPath));
  const record = join(directory, 'standalone-owner.json');
  const owner = Owner.parse(privateJson(record));
  if (owner.runtimeDigest === digest) return;
  const previous = join(dirname(directory), 'Yosh Local Authorization Runtime Dev', owner.runtimeDigest);
  privateDirectory(previous);
  const manifestBytes = readFileSync(join(previous, 'manifest.json'));
  if (hash(manifestBytes) !== owner.runtimeDigest) throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
  const manifest = Manifest.parse(JSON.parse(manifestBytes.toString('utf8')));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (basename(name) !== name) throw new Error('STANDALONE_RUNTIME_PATH_INVALID');
    const file = join(previous, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(file)) !== expected)
      throw new Error('STANDALONE_RUNTIME_INTEGRITY_FAILED');
  }
  await promisify(execFile)(join(previous, 'node'), [join(previous, 'standalone.cjs'), 'stop', '--data-dir', directory],
    { timeout: 45000, maxBuffer: 16384, env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
  const startup = acquireDataDirectoryOwnership(directory, 'standalone-startup.sqlite');
  try {
    const service = acquireDataDirectoryOwnership(directory, 'standalone-service.sqlite');
    try {
      const stopped = Owner.parse(privateJson(record));
      if (stopped.runtimeDigest !== owner.runtimeDigest) throw new Error('STANDALONE_RUNTIME_CHANGED');
      try { process.kill(stopped.pid, 0); throw new Error('STANDALONE_STOP_INCOMPLETE'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      // Authenticate absence at the original listener, not just a stale PID.
      if (await ready(directory, owner.runtimeDigest)) throw new Error('STANDALONE_STOP_INCOMPLETE');
      const installed = installRuntime(directory, digest);
      const receipt = join(directory, 'runtime-upgrade-' + randomBytes(16).toString('hex') + '.json');
      writeFileSync(receipt, JSON.stringify({ version: 1, previous: stopped, nextDigest: digest, installed }), { mode: 0o600, flag: 'wx', flush: true });
      const temporary = record + '.' + randomBytes(16).toString('hex');
      writeFileSync(temporary, JSON.stringify({ ...stopped, runtimeDigest: digest, ready: false }), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, record);
    } finally { service.release(); }
  } finally { startup.release(); }
}

async function main() {
  const action = z.enum(['start', 'status', 'stop', 'mcp', 'serve', 'install-mcp', 'settings', 'connection', 'upgrade']).parse(process.argv[2]);
  if (process.argv.length !== 3 && (process.argv.length !== 5 || process.argv[3] !== '--data-dir')) throw new Error('STANDALONE_ARGUMENTS_INVALID');
  const digest = verifyRuntime(); // Validate program bytes before touching data.
  const directory = process.argv[4] ?? join(userInfo().homedir, 'Library/Application Support', profile.directoryName);
  if (!isAbsolute(directory) || resolve(directory) !== directory || basename(directory) !== profile.directoryName
    || directory === runtime || directory.startsWith(runtime + '/')) throw new Error('STANDALONE_DATA_DIRECTORY_INVALID');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); privateDirectory(directory);
  if (action === 'install-mcp') {
    const installed = installRuntime(directory, digest);
    const child = spawn(join(installed, 'node'), [join(installed, 'standalone.cjs'), 'mcp', '--data-dir', directory],
      { cwd: directory, stdio: 'inherit', env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
    child.once('error', () => { process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    process.once('SIGINT', () => child.kill('SIGINT'));
    return;
  }
  if (action === 'upgrade') { await upgradeRuntime(directory, digest); console.log(JSON.stringify({ upgraded: true, runtimeDigest: digest, dataPreserved: true })); return; }
  const controlPath = join(directory, 'standalone-control.json');
  // The internal service entry is still callable by local programs. It must
  // enforce the same compatibility fence as the launcher before opening data.
  if (existsSync(join(directory, 'standalone-owner.json'))) readOwner(directory, digest);
  if (action === 'serve') { await serve(directory, digest); return; }
  let lock: ReturnType<typeof acquireDataDirectoryOwnership> | undefined;
  checkLockFiles(directory, 'standalone-startup.sqlite');
  for (let attempt = 0; attempt < 100 && !lock; attempt++) {
    try { lock = acquireDataDirectoryOwnership(directory, 'standalone-startup.sqlite'); }
    catch (error) { if (!(error instanceof DataDirectoryInUseError)) throw error; await delay(100); }
  }
  if (!lock) throw new Error('STANDALONE_START_BUSY');
  try {
    if (!existsSync(controlPath)) {
      if (!['start', 'mcp', 'settings', 'connection'].includes(action) || existsSync(join(directory, 'app-ledger.sqlite'))) throw new Error('STANDALONE_CONTROL_MISSING');
      writeFileSync(controlPath, JSON.stringify({ apiVersion: API_VERSION, dataContract: SCHEMA_CONTRACT,
        profile: profile.bundleIdentifier, environment, managementSecret: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx', flush: true });
    }
    Control.parse(privateJson(controlPath));
    // Even stopped data cannot silently move to a different runtime. Upgrades
    // need an explicit migration procedure, which this first Dev build lacks.
    if (existsSync(join(directory, 'standalone-owner.json'))) readOwner(directory, digest);
    let running = await ready(directory, digest);
    if (action === 'stop') {
      if (running) {
        await management(directory, 'POST', '/api/app/lifecycle', JSON.stringify({ action: 'shutdown' }));
        for (let attempt = 0; attempt < 100 && running; attempt++) { await delay(100); running = await ready(directory, digest); }
        if (running) throw new Error('STANDALONE_STOP_INCOMPLETE');
      }
    } else if (!running && ['start', 'mcp', 'settings', 'connection'].includes(action)) {
      const child = spawn(local ? executable : '/usr/bin/sandbox-exec', [...(local ? [] : ['-D', `DATA=${directory}`, '-D', `RUNTIME=${runtime}`,
        '-D', `USERHOME=${userInfo().homedir}`, '-f', join(runtime, 'offline.sb'), executable]), process.argv[1], 'serve', '--data-dir', directory], {
        detached: true, cwd: directory, stdio: 'ignore', env: { HOME: directory, PATH: '/usr/bin:/bin',
          NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1' },
      });
      let failed = false;
      child.on('error', () => { failed = true; }); child.on('exit', () => { failed = true; }); child.unref();
      for (let attempt = 0; attempt < 100 && !running && !failed; attempt++) {
        await delay(100);
        try { running = await ready(directory, digest); }
        catch (error) { if (!(error instanceof Error && error.message === 'STANDALONE_BACKEND_STARTING')) throw error; }
      }
      if (!running) throw new Error('STANDALONE_START_FAILED');
    }
    if (local && ['settings', 'connection'].includes(action)) {
      console.log(JSON.stringify(await management(directory, action === 'settings' ? 'POST' : 'GET',
        action === 'settings' ? '/api/app/local-authorization-link' : '/api/app/local-authorization-state', action === 'settings' ? '{}' : '')));
      return;
    }
    if (action !== 'mcp') console.log(JSON.stringify({ profile: profile.bundleIdentifier, environment,
      apiVersion: API_VERSION, running, origin, dataDirectory: directory, realFunds: false }));
  } finally { lock.release(); }
  if (action === 'mcp') {
    const child = spawn(local ? executable : '/usr/bin/sandbox-exec', local
      ? [join(runtime, 'local-mcp.cjs'), '--data-dir', directory]
      : ['-D', `DATA=${directory}`, '-D', `RUNTIME=${runtime}`, '-D', `USERHOME=${userInfo().homedir}`, '-f', join(runtime, 'offline.sb'), executable,
      join(runtime, 'mcp.cjs'), '--data-dir', directory], { cwd: directory, stdio: 'inherit',
      env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test', YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: environment } });
    child.once('error', () => { process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    process.once('SIGINT', () => child.kill('SIGINT'));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
    ? error.message : 'STANDALONE_DEV_FAILED'); process.exitCode = 1;
});
