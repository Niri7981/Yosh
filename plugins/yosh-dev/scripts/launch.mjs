import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NAME = 'Yosh Codex Plugin Dev';
const IDENTITY = 'com.yosh.codex-plugin-dev';
const ORIGIN = 'http://127.0.0.1:14449';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class LauncherError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new LauncherError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function realDirectory(directory, privateDirectory = false) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(directory) !== directory
      || (privateDirectory && (metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700))) {
    fail('YOSH_PLUGIN_DATA_DIRECTORY_INVALID');
  }
}

function privateJson(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 16384) {
      fail('YOSH_PLUGIN_CONNECTION_INVALID');
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!object(value)) fail('YOSH_PLUGIN_CONNECTION_INVALID');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof LauncherError) throw error;
    fail('YOSH_PLUGIN_CONNECTION_INVALID');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function validateApp(app, readPlist = file => {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
  return JSON.parse(result.stdout);
}) {
  if (!path.isAbsolute(app) || path.basename(app) !== NAME + '.app') fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
  if (!fs.existsSync(app)) fail('YOSH_PLUGIN_APP_NOT_INSTALLED');
  try { realDirectory(app); } catch { fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH'); }
  const info = readPlist(path.join(app, 'Contents/Info.plist'));
  if (info.CFBundleIdentifier !== IDENTITY || info.YoshCodexPluginDevelopment !== true
      || info.YoshPayDevelopment !== true || info.YoshStableRelease === true) fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
  const runtime = path.join(app, 'Contents/Resources/Runtime');
  try { realDirectory(runtime); realDirectory(path.join(runtime, 'backend')); }
  catch { fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH'); }
  for (const file of [path.join(app, 'Contents/MacOS/YoshBackendNode'), path.join(runtime, 'mcp.cjs'),
    path.join(runtime, 'pay-mcp'), path.join(runtime, 'backend/server.js')]) {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('YOSH_PLUGIN_RUNTIME_UNAVAILABLE');
  }
  const manifestPath = path.join(runtime, 'codex-plugin-dev-source-manifest.json');
  const metadata = fs.lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'codex-plugin-dev' || manifest.productionEnabled !== false || !object(manifest.identity)
      || manifest.identity.bundleIdentifier !== IDENTITY || manifest.identity.directoryName !== NAME
      || manifest.identity.keychainNamespace !== IDENTITY
      || JSON.stringify(manifest.identity.ports) !== '[14449,14450,14451]') fail('YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
  return { app, runtime, node: path.join(app, 'Contents/MacOS/YoshBackendNode'), bridge: path.join(runtime, 'mcp.cjs') };
}

function readScope(home) {
  const root = path.join(home, 'Library/Application Support', NAME);
  realDirectory(root, true);
  let environment = 'offline';
  try {
    const selection = privateJson(path.join(root, 'development-environment.json'));
    if (selection.version !== 1 || !['offline', 'simulated'].includes(selection.environment)) fail('YOSH_PLUGIN_ENVIRONMENT_DISABLED');
    environment = selection.environment;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = environment === 'simulated' ? path.join(root, 'Simulated') : root;
  realDirectory(directory, true);
  const manifest = privateJson(path.join(directory, environment === 'simulated' ? 'pay-simulated-runtime.json' : 'pay-dev-runtime.json'));
  if (manifest.version !== 1 || manifest.profile !== (environment === 'simulated' ? 'pay-mcp-simulated' : 'isolated-pay-dev')
      || manifest.origin !== ORIGIN || !UUID.test(manifest.memberId)) fail('YOSH_PLUGIN_RUNTIME_SCOPE_MISMATCH');
  return { root, directory, environment, manifest };
}

function readConnection(scope) {
  const memberDirectory = path.join(scope.directory, 'members', scope.manifest.memberId);
  let connection;
  try {
    realDirectory(memberDirectory, true);
    connection = privateJson(path.join(memberDirectory, 'mcp-connection.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    connection = privateJson(path.join(scope.directory, 'mcp-connection.json'));
  }
  if (connection.origin !== ORIGIN || connection.cardMemberId !== scope.manifest.memberId
      || !UUID.test(connection.connectionId) || !Number.isSafeInteger(connection.generation) || connection.generation <= 0
      || typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(connection.token)
      || !Array.isArray(connection.capabilities) || !connection.capabilities.includes('read')
      || !connection.capabilities.includes('request_purchase')) fail('YOSH_PLUGIN_CONNECTION_INVALID');
  return connection;
}

function portReady() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 14449 });
    let ended = false;
    const finish = ready => { if (!ended) { ended = true; socket.destroy(); resolve(ready); } };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function authenticate(connection) {
  return new Promise((resolve, reject) => {
    const request = http.get(ORIGIN + '/api/agent?operation=status', { headers: { authorization: 'Bearer ' + connection.token }, timeout: 1500 }, response => {
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65536) request.destroy(new Error('response limit')); });
      response.on('end', () => {
        if (response.statusCode === 401) reject(new LauncherError('YOSH_PLUGIN_CONNECTION_REVOKED'));
        else if (response.statusCode !== 200) reject(new LauncherError('YOSH_PLUGIN_BACKEND_NOT_READY'));
        else resolve();
      });
      response.on('error', () => reject(new LauncherError('YOSH_PLUGIN_BACKEND_NOT_READY')));
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', () => reject(new LauncherError('YOSH_PLUGIN_BACKEND_NOT_READY')));
  });
}

async function ready(app, home, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 7000);
  const probe = options.portReady ?? portReady;
  const pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 250)));
  let opened = false;
  for (;;) {
    let scope;
    try { scope = readScope(home); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (scope && await probe()) {
      let connection;
      try { connection = readConnection(scope); }
      catch (error) { if (error.code === 'ENOENT') fail('YOSH_PLUGIN_CONNECTION_REQUIRED'); throw error; }
      await (options.authenticate ?? authenticate)(connection);
      return scope;
    }
    if (!opened) {
      opened = true;
      const result = (options.openApp ?? (target => spawnSync('/usr/bin/open', ['-a', target], { stdio: 'ignore', timeout: 5000 })))(app);
      if (result.status !== 0) fail('YOSH_PLUGIN_APP_OPEN_FAILED');
    }
    if (Date.now() >= deadline) fail('YOSH_PLUGIN_BACKEND_NOT_READY');
    await pause();
  }
}

async function main() {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--check')) fail('YOSH_PLUGIN_ARGUMENTS_INVALID');
  const home = os.userInfo().homedir;
  const target = validateApp(process.env.YOSH_CODEX_PLUGIN_APP || path.join(home, 'Applications', NAME + '.app'));
  if (fs.realpathSync(process.execPath) !== fs.realpathSync(target.node)) fail('YOSH_PLUGIN_RUNTIME_UNAVAILABLE');
  const scope = await ready(target.app, home);
  if (process.argv[2] === '--check') {
    process.stdout.write(JSON.stringify({ profile: 'codex-plugin-dev', environment: scope.environment, connection: 'ready', realFunds: false }) + '\n');
    return;
  }
  const child = spawn(target.node, [target.bridge, '--data-dir', scope.root], { cwd: target.runtime, stdio: 'inherit',
    env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_ENV: 'production' } });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
  child.once('error', () => { process.stderr.write('YOSH_PLUGIN_BRIDGE_UNAVAILABLE\n'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

export { NAME, IDENTITY, ORIGIN, LauncherError, privateJson, validateApp, readScope, readConnection, authenticate, ready };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write((error instanceof LauncherError ? error.code : 'YOSH_PLUGIN_RUNTIME_UNAVAILABLE') + '\n');
  process.exitCode = 1;
});
