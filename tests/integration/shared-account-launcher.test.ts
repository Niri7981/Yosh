import { build } from 'esbuild';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { AgentConnection } from '../../src/modules/mcp/connection';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
const directoryName = 'Yosh Local Authorization Dev';
const stagedNode = resolve('build.noindex/node-runtime/node-v24.21.0-darwin-arm64/bin/node');
const packagedNode = process.env.YOSH_TEST_PACKAGED_NODE ?? (existsSync(stagedNode) ? stagedNode
  : 'node_shared' in process.config.variables && process.config.variables.node_shared ? undefined : process.execPath);
async function temporaryPackage(directory: string, port: number) {
  mkdirSync(directory, { mode: 0o700 });
  if (!packagedNode) throw new Error('TEST_RELOCATABLE_NODE_REQUIRED');
  copyFileSync(packagedNode, join(directory, 'node'));
  writeFileSync(join(directory, 'pay-mcp'), `#!/bin/sh
exec "$(dirname "$0")/node" -e '
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:"read-only-fixture",version:"1"} }
    : message.method === "tools/list" ? {tools:[]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result}) + "\\n");
});'
`, { mode: 0o700 });
  const define = { __YOSH_LOCAL_AUTH_DEV__: 'true', __YOSH_PLUGIN_DEV__: 'true', __YOSH_STANDALONE_DEV__: 'true', __YOSH_RC5__: 'false' };
  await build({ entryPoints: { standalone: 'scripts/standalone-dev.ts', 'local-mcp': 'scripts/local-plugin-mcp.ts', mcp: 'scripts/pay-dev-mcp.ts' },
    outdir: directory, outExtension: { '.js': '.cjs' }, platform: 'node', bundle: true, format: 'cjs', define,
    plugins: [{ name: 'ephemeral-test-port', setup(build) {
      build.onLoad({ filter: /[/\\]pay-dev[/\\]profile\.ts$/ }, input => {
        const source = readFileSync(input.path, 'utf8'), fixture = source.replace('backendPort: IS_LOCAL_AUTH_DEVELOPMENT ? 17449', 'backendPort: IS_LOCAL_AUTH_DEVELOPMENT ? ' + port);
        if (fixture === source) throw new Error('TEST_BACKEND_PORT_NOT_ISOLATED');
        return { contents: fixture, loader: 'ts' };
      });
    } }] });
  writeFileSync(join(directory, 'mainnet.cjs'), 'process.exit(2);');
  for (const name of ['pay-protocol-engine', 'offline.sb', 'mainnet-mcp.cjs', 'mainnet-manifest.json', 'mainnet.sb',
    'yosh-confirm', 'spirit-design-sheet.png', 'instrument-serif.woff2', 'Instrument-Serif-OFL.txt']) writeFileSync(join(directory, name), 'unused test resource');
  const files = Object.fromEntries(readdirSync(directory).map(name => [name, hash(readFileSync(join(directory, name)))]));
  mkdirSync(join(directory, 'licenses'));
  for (const name of ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']) writeFileSync(join(directory, 'licenses', name), 'fixture');
  const manifest = join(directory, 'manifest.json');
  json(manifest, { kind: 'yosh-local-devnet', apiVersion: 2, dataContract: 'local-devnet-v1', productionEnabled: false, files });
  return hash(readFileSync(manifest));
}

it.skipIf(!packagedNode)('preserves the chosen member across real standalone install-mcp, installed mcp, local proxy and Pay wrapper while the default member is disabled', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-launcher-members-'))), data = join(root, directoryName);
  const runtime = join(root, 'cache'), devnet = join(data, 'Devnet');
  const owner = randomUUID(), reader = randomUUID(), missing = randomUUID(), purchase = randomUUID();
  const secret = randomBytes(32).toString('hex'), statusReads: string[] = [], agentReads: string[] = [], unexpected: string[] = [];
  let origin = '';
  const buyer = new AgentConnection(devnet, owner, () => true);
  const member = new AgentConnection(devnet, reader, () => true, true);
  const clients: Client[] = [];
  const server = createServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? '/', origin);
    if (path.pathname.startsWith('/api/app/')) {
      const nonce = String(incoming.headers['x-2049-nonce']), timestamp = String(incoming.headers['x-2049-timestamp']);
      const proof = (fields: string[]) => createHmac('sha256', secret).update(fields.join('\n')).digest('hex');
      const message = ['2049-management-v1', 'GET', path.pathname + path.search, timestamp, nonce, hash('')];
      if (incoming.method !== 'GET' || incoming.headers['x-2049-proof'] !== proof(message)) { outgoing.writeHead(401).end(); return; }
      const memberId = path.searchParams.get('memberId') ?? owner;
      const state = memberId === reader ? member.status() : buyer.status();
      const body = path.pathname === '/api/app/health' ? { ready: true, pid: process.pid, dataDirectory: devnet, service: 'Yosh' }
        : { enabled: state.enabled, connectionState: state.enabled ? 'connected' : 'disconnected', paused: true };
      if (path.pathname === '/api/app/local-authorization-state') statusReads.push(memberId);
      else if (path.pathname !== '/api/app/health') unexpected.push(path.pathname);
      const status = memberId === reader || memberId === owner ? 200 : 404; const encoded = JSON.stringify(body);
      outgoing.writeHead(status, { 'content-type': 'application/json',
        'x-2049-response-proof': proof(['2049-management-response-v1', nonce, String(status), hash(encoded)]) }).end(encoded);
      return;
    }
    try {
      const principal = member.authenticate(new Request(path, { headers: { authorization: incoming.headers.authorization ?? '' } }));
      const marker = { purchaseId: purchase, readBy: principal.cardMemberId, result: 'public test fixture' };
      if (path.pathname === '/api/agent/account/result' && incoming.method === 'GET' && path.searchParams.get('purchaseId') === purchase) {
        agentReads.push(principal.cardMemberId); outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(marker));
      } else if (path.pathname === '/api/agent/session' && incoming.method === 'POST') outgoing.writeHead(200).end('{}');
      else if (path.pathname === '/api/agent/purchases/private-buyer-order/delivery') outgoing.writeHead(404).end('{"code":"DELIVERY_NOT_AVAILABLE"}');
      else { unexpected.push(path.pathname); outgoing.writeHead(404).end(); }
    } catch { outgoing.writeHead(401).end('{"code":"AGENT_UNAUTHORIZED"}'); }
  });
  const connect = async (selection: Record<string, string>) => {
    const client = new Client({ name: 'standalone-member-acceptance', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: join(runtime, 'node'), args: [join(runtime, 'standalone.cjs'), 'install-mcp', '--data-dir', data],
      env: { HOME: root, PATH: '/usr/bin:/bin', NODE_ENV: 'test', ...selection }, cwd: root, stderr: 'pipe' }));
    return client;
  };
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_TCP_PORT_REQUIRED');
    origin = 'http://127.0.0.1:' + address.port;
    mkdirSync(devnet, { recursive: true, mode: 0o700 });
    const digest = await temporaryPackage(runtime, address.port);
    json(join(data, 'standalone-control.json'), { apiVersion: 2, dataContract: 'local-devnet-v1', profile: 'com.yosh.local-authorization-dev',
      environment: 'devnet', managementSecret: secret });
    json(join(data, 'standalone-owner.json'), { apiVersion: 2, dataContract: 'local-devnet-v1', runtimeDigest: digest, pid: process.pid, ready: true });
    json(join(data, 'development-environment.json'), { version: 1, environment: 'devnet', mainnetRiskAccepted: false, rpcUrl: 'https://fixture.invalid' });
    json(join(devnet, 'pay-devnet-runtime.json'), { version: 1, profile: 'pay-mcp-devnet', origin, memberId: owner });
    member.setEnabled(true, origin);
    const agent = await connect({ APP2049_CARD_MEMBER_ID: reader });
    const inventory = (await agent.listTools()).tools;
    expect(inventory.find(tool => tool.name === 'read_account_result')?.inputSchema.properties?.environment,
      'signed member readiness reads: ' + statusReads.length).toMatchObject({ enum: ['devnet'] });
    const argumentsForRead = { purchaseId: purchase, environment: 'devnet' };
    const read = await agent.callTool({ name: 'read_account_result', arguments: argumentsForRead });
    expect(read).toMatchObject({ content: [{ text: JSON.stringify({ purchaseId: purchase, readBy: reader, result: 'public test fixture' }) }] });
    expect((await agent.callTool({ name: 'get_purchase_delivery', arguments: { purchaseId: 'private-buyer-order', environment: 'devnet' } })).isError).toBe(true);
    expect(statusReads.length).toBeGreaterThan(0); expect(new Set(statusReads)).toEqual(new Set([reader]));
    expect(existsSync(join(root, 'Yosh Local Authorization Runtime Dev', digest, 'standalone.cjs'))).toBe(true);
    member.setEnabled(false, origin);
    expect((await agent.callTool({ name: 'read_account_result', arguments: argumentsForRead })).isError).toBe(true);
    buyer.setEnabled(true, origin);
    const unknown = await connect({ YOSH_CARD_MEMBER_ID: missing });
    expect((await unknown.listTools()).tools.map(tool => tool.name)).not.toContain('read_account_result');
    expect(statusReads).toContain(missing);
    const invalidSelections: Record<string, string>[] = [{ YOSH_CARD_MEMBER_ID: 'bad' }, { YOSH_CARD_MEMBER_ID: reader, APP2049_CARD_MEMBER_ID: owner }];
    for (const invalid of invalidSelections)
      await expect(connect(invalid)).rejects.toThrow();
    expect(statusReads).not.toContain(owner); expect(agentReads).toEqual([reader]); expect(unexpected).toEqual([]);
  } finally {
    for (const client of clients) await client.close();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
