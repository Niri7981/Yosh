import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { assertMainnetProxyStartupEnvironment, loadMainnetStandaloneConfiguration } from '../src/modules/pay-dev/mainnet-standalone-configuration';
import { installMainnetRuntime, verifyMainnetRuntime } from '../src/modules/pay-dev/mainnet-runtime-artifact';
import { claimMainnetProcessLock, drainMainnetBackend, ensureMainnetBackend, inspectMainnetBackend, readMainnetOwner,
  stopMainnetBackend, writeMainnetOwner } from '../src/modules/pay-dev/mainnet-standalone-owner';
import { startMainnetDevelopmentBackend } from '../src/modules/pay-dev/mainnet-runtime';
import { filterMainnetTools, permittedMainnetCall } from '../src/modules/mcp/mainnet-plugin-scope';

const runtime = dirname(resolve(process.argv[1]));
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
  ? error.message : 'MAINNET_STANDALONE_FAILED';
type Configuration = Awaited<ReturnType<typeof loadMainnetStandaloneConfiguration>>;

function backendLog(directory: string) {
  const fd = openSync(join(directory, 'mainnet-standalone.log'), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) { closeSync(fd); throw new Error('MAINNET_LOG_INVALID'); }
  return fd;
}
function launch(installed: string, configuration: Configuration) {
  const log = backendLog(configuration.directory);
  try {
    // The child inherits neither the App process nor its bundle. It reloads
    // original persisted configuration after acquiring its own service lock.
    const child = spawn('/usr/bin/sandbox-exec', ['-f', join(installed, 'mainnet.sb'),
      join(installed, 'node'), join(installed, 'mainnet.cjs'), 'serve'], { detached: true,
      cwd: installed, stdio: ['ignore', 'ignore', log],
      env: { ...configuration.environment, NODE_ENV: 'production' } });
    let failed = false;
    child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; }); child.unref();
    return { failed: () => failed };
  } finally { closeSync(log); }
}

async function serve(digest: string, initial: Configuration) {
  if (runtime !== join(dirname(initial.root), 'Yosh Mainnet Runtime', digest)) throw new Error('MAINNET_INSTALLED_RUNTIME_REQUIRED');
  const lock = claimMainnetProcessLock(initial.directory, 'mainnet-standalone-service.sqlite');
  let backend: Awaited<ReturnType<typeof startMainnetDevelopmentBackend>> | undefined;
  let stopRequested = false;
  let closeReady: (() => Promise<void>) | undefined;
  const stop = () => {
    stopRequested = true;
    if (closeReady) void closeReady().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
  };
  // A signal during Keychain/startup recovery requests a drain, not the default
  // abrupt process termination before a backend handle has become available.
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    const configuration = await loadMainnetStandaloneConfiguration(runtime);
    assertMainnetProxyStartupEnvironment(configuration.environment, process.env);
    if (configuration.directory !== initial.directory) throw new Error('MAINNET_BACKEND_IDENTITY_MISMATCH');
    const previous = readMainnetOwner(configuration.directory);
    if (previous && previous.runtimeDigest !== digest) throw new Error('MAINNET_RUNTIME_VERSION_MISMATCH');
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, configuration.environment);
    // AppRuntime obtains the original backend-owner and ledger writer locks
    // before opening or recovering the existing ledger. Never clear those locks.
    backend = await startMainnetDevelopmentBackend({ directory: configuration.directory, port: configuration.port,
      hosting: { kind: 'mainnet-standalone', runtimeDigest: digest, payMcpPath: join(runtime, 'pay-mcp') } });
    writeMainnetOwner(configuration.directory, digest, !stopRequested);
    const running = backend;
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      // Retain the version fence even while stopped; future upgrades need an
      // explicit compatible handoff instead of silently changing runtime bytes.
      await drainMainnetBackend({ markStopping: () => writeMainnetOwner(configuration.directory, digest, false),
        close: () => running.close(), release: () => lock.release() });
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
    };
    closeReady = close;
    if (stopRequested) await close();
  } catch (error) {
    await backend?.close(); lock.release();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    throw error;
  }
}

function mcp(installed: string, configuration: Configuration) {
  const child = spawn('/usr/bin/sandbox-exec', ['-f', join(installed, 'mainnet.sb'), join(installed, 'node'),
    join(installed, 'mainnet-mcp.cjs'), '--data-dir', configuration.root], {
    cwd: installed, stdio: ['pipe', 'pipe', 'ignore'],
    env: { HOME: configuration.environment.HOME, PATH: '/usr/bin:/bin', NODE_ENV: 'production' } });
  const input = createInterface({ input: process.stdin }), output = createInterface({ input: child.stdout });
  const lists = new Set<string | number>();
  const Envelope = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
    result: z.object({ tools: z.array(z.unknown()).optional() }).passthrough().optional() }).passthrough();
  input.on('line', line => {
    try {
      if (line.length > 1_048_576) throw new Error();
      const message: unknown = JSON.parse(line), envelope = Envelope.parse(message);
      if (!permittedMainnetCall(message)) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: envelope.id,
          error: { code: -32601, message: 'YOSH_MAINNET_TOOL_NOT_ALLOWED' } }) + '\n'); return;
      }
      if (envelope.method === 'tools/list' && envelope.id !== undefined) lists.add(envelope.id);
      child.stdin.write(line + '\n');
    } catch { process.stderr.write('YOSH_MAINNET_MESSAGE_INVALID\n'); }
  });
  output.on('line', line => {
    try {
      if (line.length > 1_048_576) throw new Error();
      const message = Envelope.parse(JSON.parse(line));
      if (message.id !== undefined && lists.delete(message.id) && message.result?.tools)
        message.result.tools = filterMainnetTools(message.result.tools);
      process.stdout.write(JSON.stringify(message) + '\n');
    } catch { process.stderr.write('YOSH_MAINNET_MESSAGE_INVALID\n'); }
  });
  input.once('close', () => { child.stdin.end(); });
  child.stdin.on('error', () => { input.close(); });
  child.once('error', () => { input.close(); output.close(); process.exitCode = 1; });
  child.once('exit', code => { input.close(); output.close(); process.exitCode = code ?? 1; });
  process.once('SIGTERM', () => { child.kill('SIGTERM'); });
  process.once('SIGINT', () => { child.kill('SIGINT'); });
}

async function main() {
  if (process.argv.length !== 3) throw new Error('MAINNET_ARGUMENTS_INVALID');
  const action = z.enum(['start', 'status', 'stop', 'serve', 'install-mcp']).parse(process.argv[2]);
  const { digest } = verifyMainnetRuntime(runtime);
  if (realpathSync(process.execPath) !== realpathSync(join(runtime, 'node'))) throw new Error('MAINNET_PACKAGED_NODE_REQUIRED');
  const configuration = await loadMainnetStandaloneConfiguration(runtime);
  if (action === 'serve') { await serve(digest, configuration); return; }
  if (action === 'stop') {
    await stopMainnetBackend({ configuration, digest });
    console.log(JSON.stringify({ stopped: true, environment: 'mainnet', dataPreserved: true })); return;
  }
  if (action === 'status') {
    const status = await inspectMainnetBackend({ configuration, digest });
    console.log(JSON.stringify({ environment: 'mainnet', running: Boolean(status), ...status,
      candidateRuntimeDigest: digest, ...(status?.owner === 'standalone' ? { runtimeDigest: digest } : {}) })); return;
  }
  const installed = installMainnetRuntime(runtime, configuration.root);
  const installedConfiguration = await loadMainnetStandaloneConfiguration(installed);
  const status = await ensureMainnetBackend({ configuration: installedConfiguration, digest, launch: () => launch(installed, installedConfiguration) });
  if (action === 'install-mcp') { mcp(installed, installedConfiguration); return; }
  console.log(JSON.stringify({ environment: 'mainnet', running: true, ...status, candidateRuntimeDigest: digest,
    ...(status.owner === 'standalone' ? { runtimeDigest: digest, runtimeDirectory: installed } : {}) }));
}
void main().catch((error: unknown) => { console.error(safeCode(error)); process.exitCode = 1; });
