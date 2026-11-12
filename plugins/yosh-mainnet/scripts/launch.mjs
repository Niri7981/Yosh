/** Attach only: the installed App owns the wallet, ledger and backend lifecycle. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export const ALLOWED_TOOLS = new Set(['get_spending_status', 'get_balance', 'list_catalog', 'search_catalog',
  'get_catalog_entry', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource', 'curl', 'recover_payment']);
export function permittedCall(message) {
  return message?.method !== 'tools/call' || ALLOWED_TOOLS.has(message.params?.name);
}
export function filterTools(tools) { return tools.filter(tool => ALLOWED_TOOLS.has(tool.name)); }
export function assertMainnetStatus(status) {
  const scope = status?.budget?.monetaryScope;
  if (scope?.environment !== 'live_mainnet' || scope.network !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      || scope.assetId !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || scope.assetDecimals !== 6)
    fail('YOSH_MAINNET_BACKEND_SCOPE_INVALID');
}

const ORIGIN = 'http://127.0.0.1:13449';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code) { throw new Error(code); }
function privateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 16384)
      fail('YOSH_MAINNET_PRIVATE_CONFIG_INVALID');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function readScope(home) {
  const root = path.join(home, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5');
  const directory = path.join(root, 'Mainnet');
  for (const dir of [root, directory]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || fs.realpathSync(dir) !== dir || stat.uid !== process.getuid() || (stat.mode & 0o077))
      fail('YOSH_MAINNET_DIRECTORY_INVALID');
  }
  const selection = privateJson(path.join(root, 'development-environment.json'));
  if (selection.version !== 1 || selection.environment !== 'mainnet') fail('YOSH_MAINNET_NOT_SELECTED');
  const manifest = privateJson(path.join(directory, 'pay-mainnet-runtime.json'));
  if (manifest.version !== 1 || manifest.profile !== 'pay-mcp-mainnet' || manifest.origin !== ORIGIN || !UUID.test(manifest.memberId))
    fail('YOSH_MAINNET_SCOPE_INVALID');
  // Deliberately reuse the original Codex principal, not a second Agent with copied Grants.
  const memberPath = path.join(directory, 'members', manifest.memberId);
  let connection;
  try {
    if (fs.realpathSync(memberPath) !== memberPath) fail('YOSH_MAINNET_CONNECTION_INVALID');
    connection = privateJson(path.join(memberPath, 'mcp-connection.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    connection = privateJson(path.join(directory, 'mcp-connection.json'));
  }
  if (connection.origin !== ORIGIN || connection.cardMemberId !== manifest.memberId
      || !UUID.test(connection.connectionId) || !Number.isSafeInteger(connection.generation) || connection.generation < 1
      || typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(connection.token)
      || !Array.isArray(connection.capabilities) || !['read', 'request_purchase'].every(c => connection.capabilities.includes(c)))
    fail('YOSH_MAINNET_CONNECTION_INVALID');
  return { root, connection };
}

async function main() {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--check')) fail('YOSH_MAINNET_ARGUMENTS_INVALID');
  const home = os.userInfo().homedir;
  const app = process.env.YOSH_MAINNET_APP;
  if (!app || !path.isAbsolute(app) || fs.realpathSync(app) !== app
      || fs.realpathSync(process.execPath) !== fs.realpathSync(path.join(app, 'Contents/MacOS/YoshBackendNode')))
    fail('YOSH_MAINNET_RUNTIME_INVALID');
  const { root, connection } = readScope(home);
  // No auto-start or shutdown: closing this MCP must not stop the App's backend.
  const response = await fetch(ORIGIN + '/api/agent?operation=status', {
    headers: { authorization: `Bearer ${connection.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(response.status === 401 ? 'YOSH_MAINNET_CONNECTION_REVOKED' : 'YOSH_MAINNET_BACKEND_NOT_READY');
  }
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 262144) fail('YOSH_MAINNET_STATUS_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  assertMainnetStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (process.argv[2] === '--check') {
    process.stdout.write(JSON.stringify({ environment: 'mainnet', realFunds: true, connection: 'ready', authority: 'existing-app' }) + '\n');
    return;
  }
  const runtime = path.join(app, 'Contents/Resources/Runtime');
  const child = spawn(process.execPath, [path.join(runtime, 'mcp.cjs'), '--data-dir', root], {
    cwd: runtime, stdio: ['pipe', 'pipe', 'ignore'], env: { HOME: home, PATH: '/usr/bin:/bin', NODE_ENV: 'production' },
  });
  // Inventory and dispatch share the same allowlist. No topup, inference sale or skill creation.
  const lists = new Set();
  const input = createInterface({ input: process.stdin });
  const output = createInterface({ input: child.stdout });
  input.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!permittedCall(message)) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'YOSH_MAINNET_TOOL_NOT_ALLOWED' } }) + '\n');
        return;
      }
      if (message.method === 'tools/list') lists.add(message.id);
      child.stdin.write(line + '\n');
    } catch { process.stderr.write('YOSH_MAINNET_MESSAGE_INVALID\n'); }
  });
  output.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (lists.delete(message.id) && Array.isArray(message.result?.tools)) message.result.tools = filterTools(message.result.tools);
      process.stdout.write(JSON.stringify(message) + '\n');
    } catch { process.stderr.write('YOSH_MAINNET_MESSAGE_INVALID\n'); }
  });
  input.once('close', () => child.stdin.end());
  child.stdin.on('error', () => { input.close(); });
  child.once('exit', () => { input.close(); output.close(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
  child.once('error', () => { process.stderr.write('YOSH_MAINNET_BRIDGE_UNAVAILABLE\n'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write((/^YOSH_MAINNET_[A-Z_]+$/.test(error.message) ? error.message : 'YOSH_MAINNET_UNAVAILABLE_OPEN_ORIGINAL_APP') + '\n');
  process.exitCode = 1;
});
