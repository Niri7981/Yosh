import { combinedTools, routeTool, type EnvironmentTools } from '../src/modules/mcp/environment-routing';
/** Setup tools remain available before pairing. Once paired, forward to the
 * existing Pay wrapper; no wallet, approval or payment logic lives here. */
import { execFile } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IS_LOCAL_AUTH_DEVELOPMENT } from '../src/modules/pay-dev/profile';
const execute = promisify(execFile);
const root = dirname(resolve(process.argv[1]));
const directory = z.string().min(1).parse(process.argv[3]);
if (!IS_LOCAL_AUTH_DEVELOPMENT || process.argv.length !== 4 || process.argv[2] !== '--data-dir') throw new Error('LOCAL_PLUGIN_ARGUMENTS_INVALID');
async function command(action: 'settings' | 'connection') {
  const result = await execute(join(root, 'node'), [join(root, 'standalone.cjs'), action, '--data-dir', directory],
    { timeout: 15_000, maxBuffer: 16384, env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
  return JSON.parse(result.stdout) as unknown;
}
const Connection = z.object({ enabled: z.boolean(), connectionState: z.string(), paused: z.boolean() });
const setup = [
  { name: 'open_local_settings', description: 'Get a short-lived Yosh settings link. Pass environment: mainnet for direct Mainnet entry or devnet for Devnet. Without environment the page asks the user to choose before reading either network. Mainnet preserves the original wallet, Grant and ledger through the bundled backend. Does not approve, create a wallet, enable spending or pay. The user confirms changes in the native system window.', inputSchema: { type: 'object' as const, properties: { environment: { type: 'string', enum: ['mainnet', 'devnet'] } }, additionalProperties: false } },
  { name: 'local_setup_status', description: 'Read pairing and pause state; refresh Pay tool availability after the user completes local setup. Does not change authorization.', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } },
];
const server = new Server({ name: 'yosh-local-dev', version: '0.2.4' }, { capabilities: { tools: { listChanged: true } } });
let client: Client | undefined, connecting: Promise<Client> | undefined;
let mainnetClient: Client | undefined, mainnetConnecting: Promise<Client> | undefined;
let mainnetStarting: Promise<void> | undefined;
let inventory: EnvironmentTools = {};
async function ensureMainnet() {
  mainnetStarting ??= execute(join(root, 'node'), [join(root, 'mainnet.cjs'), 'start'],
    { cwd: root, timeout: 60_000, maxBuffer: 16384, env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'production' } })
    .then(() => undefined).finally(() => { mainnetStarting = undefined; });
  return mainnetStarting;
}
async function mainnet() {
  // A connected MCP child can outlive the previous backend. Recheck ownership
  // and authenticated readiness before every inventory read or tool dispatch.
  await ensureMainnet();
  if (mainnetClient) return mainnetClient;
  mainnetConnecting ??= (async () => {
    const next = new Client({ name: 'yosh-dev-mainnet-proxy', version: '0.2.4' });
    try {
      await next.connect(new StdioClientTransport({ command: join(root, 'node'),
        args: [join(root, 'mainnet.cjs'), 'install-mcp'], cwd: root, stderr: 'ignore',
        env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'production' } }));
      next.onclose = () => { if (mainnetClient === next) mainnetClient = undefined; };
      mainnetClient = next; return next;
    } catch (error) { await next.close(); throw error; }
  })().finally(() => { mainnetConnecting = undefined; });
  return mainnetConnecting;
}
async function refreshInventory() {
  const results = await Promise.allSettled([(async () => (await (await pay()).listTools()).tools)(), (async () => (await (await mainnet()).listTools()).tools)()]);
  inventory = {};
  if (results[0].status === 'fulfilled') inventory.devnet = results[0].value;
  if (results[1].status === 'fulfilled') inventory.mainnet = results[1].value;
  return combinedTools(inventory);
}
async function pay() {
  const state = Connection.parse(await command('connection'));
  if (!state.enabled) { await client?.close(); client = undefined; throw new Error('LOCAL_CONNECTION_DISABLED'); }
  if (client) return client;
  connecting ??= (async () => {
    const next = new Client({ name: 'yosh-local-proxy', version: '0.2.4' });
    try {
      await next.connect(new StdioClientTransport({ command: join(root, 'node'), args: [join(root, 'mcp.cjs'), '--data-dir', directory],
        cwd: directory, stderr: 'ignore', env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test', YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'devnet' } }));
      client = next; return next;
    } catch (error) { await next.close(); throw error; }
  })().finally(() => { connecting = undefined; });
  return connecting;
}
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...setup, ...await refreshInventory()] };
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (request.params.name === 'open_local_settings') {
      const { environment } = z.object({ environment: z.enum(['mainnet', 'devnet']).optional() }).strict().parse(request.params.arguments ?? {});
      const result = z.object({ url: z.url() }).strict().parse(await command('settings'));
      const url = new URL(result.url);
      if (environment) url.searchParams.set('environment', environment);
      return text({ url: url.toString() });
    }
    if (request.params.name === 'local_setup_status') {
      z.object({}).strict().parse(request.params.arguments ?? {});
      const state = Connection.parse(await command('connection'));
      await server.sendToolListChanged();
      await refreshInventory();
      return text({ devnet: { ...state, realFunds: false }, mainnet: { available: Boolean(inventory.mainnet), realFunds: true }, next: 'Use environment explicitly for wallet, API and purchase tools.' });
    }
    if (!Object.keys(inventory).length) await refreshInventory();
    const routed = routeTool(request.params.name, request.params.arguments ?? {}, inventory);
    const target = routed.environment === 'mainnet' ? await mainnet() : await pay();
    return await target.callTool({ name: request.params.name, arguments: routed.arguments });
  } catch (error) {
    const code = error instanceof Error && /^LOCAL_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_TOOL_UNAVAILABLE';
    return { ...text({ code, next: 'Open local settings to inspect the original state; do not replace an unknown purchase.' }), isError: true };
  }
});
void server.connect(new StdioServerTransport());
const close = async () => { await client?.close(); await mainnetClient?.close(); await server.close(); };
process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
