import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { CodexIntegration } from '../../src/modules/mcp/codex-integration';
import { POST as session } from '../../src/app/api/agent/session/route';
import { PUT as connect } from '../../src/app/api/app/members/[memberId]/connection/route';
import { readConnection } from '../../src/modules/mcp/connection';
import { signedManagementRequest } from '../helpers/management-request';
import { codexHost } from '../helpers/codex-app-server';

const directories: string[] = [];
const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
afterEach(() => { globals.__yosh = undefined; vi.unstubAllEnvs(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
let executable: string | undefined;
try { executable = execFileSync('which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* CI without Codex runs SDK and unit coverage. */ }

it.skipIf(!executable)('allows slow Codex CLI startup while keeping the complete configuration operation bounded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-codex-slow-')); directories.push(directory);
  const home = join(directory, 'codex-home'); mkdirSync(home);
  const wrapper = join(directory, 'slow-codex');
  writeFileSync(wrapper, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nsetTimeout(() => { const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: 'inherit' }); child.on('exit', code => process.exit(code ?? 1)); }, 3100);\n`, { mode: 0o700 });
  vi.stubEnv('CODEX_HOME', home); vi.stubEnv('APP2049_CODEX_PATH', wrapper);
  const adapter = new CodexIntegration(directory, '11111111-1111-4111-8111-111111111111');
  await adapter.connect();
  expect(adapter.configured).toBe(true);
}, 20_000);

it.skipIf(!executable)('finishes an owned rename with slow real Codex CLI startup and preserves other entries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-codex-rename-slow-')); directories.push(directory);
  const home = join(directory, 'codex-home'); mkdirSync(home);
  const wrapper = join(directory, 'slow-codex');
  writeFileSync(wrapper, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nsetTimeout(() => { const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: 'inherit' }); child.on('exit', code => process.exit(code ?? 1)); }, 3100);\n`, { mode: 0o700 });
  vi.stubEnv('CODEX_HOME', home); vi.stubEnv('YOSH_CODEX_PATH', wrapper);
  const memberId = '11111111-1111-4111-8111-111111111111';
  const adapter = new CodexIntegration(directory, memberId);
  execFileSync(executable!, ['mcp', 'add', adapter.legacyServerName,
    '--env', `APP2049_DATA_DIR=${directory}`, '--env', `APP2049_CARD_MEMBER_ID=${memberId}`,
    '--env', 'APP2049_MCP_PROVIDER=codex', '--', process.execPath, '--import',
    resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/mcp.ts')], { stdio: 'ignore' });
  const entries = JSON.parse(execFileSync(executable!, ['mcp', 'list', '--json'], { encoding: 'utf8' }));
  const config = z.array(z.object({ name: z.string() }).passthrough()).parse(entries)
    .find(entry => entry.name === adapter.legacyServerName);
  mkdirSync(dirname(adapter.recordPath), { recursive: true });
  writeFileSync(adapter.recordPath, JSON.stringify({ provider: 'codex', memberId, config }), { mode: 0o600 });
  const restarted = new CodexIntegration(directory, memberId);
  await restarted.migrateLegacy();
  const after = execFileSync(executable!, ['mcp', 'list', '--json'], { encoding: 'utf8' });
  expect(after).toContain(adapter.serverName);
  expect(after).not.toContain(adapter.legacyServerName);
  expect(after).toContain(memberId);
  expect(existsSync(adapter.migrationPath)).toBe(false);
}, 30_000);

it.skipIf(!executable)('uses the saved provider config in the real Codex host, observes handshake/ping, and keeps member and grant isolation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-codex-host-')); directories.push(directory);
  const home = join(directory, 'codex-home'); mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), '# unrelated configuration must survive\nmodel_reasoning_effort = "low"\n');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('APP2049_CODEX_PATH', executable!);
  vi.stubEnv('APP2049_MANAGEMENT_TOKEN', 'm'.repeat(48));
  let app = new AppRuntime(directory);
  globals.__yosh = { runtime: app };
  const memberId = app.ledger.defaultCardMember().id;
  const other = app.createCardMember('Fixture Research').member.id;
  const context = { params: Promise.resolve({ memberId }) };
  let origin = '';
  const seen: string[] = [];
  const http = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`${origin}${incoming.url}`, { method: incoming.method,
      headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    let response: Response;
    if (incoming.url === '/api/agent/session') response = await session(request);
    else {
      try {
        const principal = app.authenticateAgent(request);
        seen.push(principal.cardMemberId);
        response = Response.json({ cardMemberId: principal.cardMemberId, budget: app.ledger.managedSummary(Date.now(), 'simulated'), paymentEnabled: false });
      } catch { response = Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
    }
    outgoing.writeHead(response.status, { 'content-type': 'application/json' });
    outgoing.end(await response.text());
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('MISSING_FIXTURE_PORT');
  origin = `http://127.0.0.1:${address.port}`;
  const write = (enabled: boolean) => connect(signedManagementRequest(`${origin}/api/app/members/${memberId}/connection`, 'm'.repeat(48), {
    method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  }), context);
  let host: ReturnType<typeof codexHost> | undefined;
  try {
    expect((await write(true)).status).toBe(200);
    const first = readConnection(directory, memberId);
    const serverName = app.memberOverview(memberId).connection.integration!.serverName;
    expect(app.memberOverview(memberId).connection.integration).toMatchObject({ configured: true, connected: false });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('model_reasoning_effort = "low"');
    host = codexHost(executable!, home, tmpdir());
    await host.request('initialize', { clientInfo: { name: 'yosh_provider_test', version: '1' }, capabilities: { experimentalApi: true } });
    host.notify('initialized');
    const started = z.object({ thread: z.object({ id: z.string() }) }).passthrough().parse(await host.request('thread/start', {
      cwd: tmpdir(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    }));
    const status = await host.request('mcpServerStatus/list', { threadId: started.thread.id });
    expect(JSON.stringify(status)).toContain(serverName);
    await vi.waitFor(() => expect(app.memberOverview(memberId).connection.integration?.connected).toBe(true), { timeout: 15_000 });
    const handshake = app.agentConnection.status().integration!.lastHandshake!;
    await vi.waitFor(() => expect(app.agentConnection.status().integration!.lastHeartbeat!).toBeGreaterThan(handshake), { timeout: 15_000, interval: 100 });
    const result = await host.request('mcpServer/tool/call', { threadId: started.thread.id, server: serverName,
      tool: 'get_spending_status', arguments: {} });
    expect(JSON.stringify(result)).toContain(memberId);
    expect(seen).toEqual([memberId]);
    expect(app.memberOverview(other).connection.enabled).toBe(false);
    expect(app.spendGrantSummary(memberId)).toBeNull();
    expect(app.ledger.listForAdministration()).toHaveLength(0);

    // Grant creation changes ledger authority without rotating the live host credential.
    app.createSpendGrant({ totalLimit: '500000', singleLimit: '200000', expiresAt: Date.now() + 3_600_000 });
    const authorized = readConnection(directory, memberId);
    expect(authorized.token).toBe(first.token);
    expect(authorized.generation).toBe(first.generation);
    expect(app.agentConnection.status().integration?.connected).toBe(true);
    const continued = await host.request('mcpServer/tool/call', { threadId: started.thread.id, server: serverName,
      tool: 'get_spending_status', arguments: {} });
    expect(JSON.stringify(continued)).toContain(memberId);
    expect((await write(true)).status).toBe(200);
    expect(readConnection(directory, memberId).token).toBe(first.token);
    expect(app.spendGrantSummary(memberId)?.status).toBe('ACTIVE');
    await host.request('config/mcpServer/reload', {});
    const renewed = z.object({ thread: z.object({ id: z.string() }) }).passthrough().parse(await host.request('thread/start', {
      cwd: tmpdir(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    }));
    await host.request('mcpServerStatus/list', { threadId: renewed.thread.id });
    await vi.waitFor(() => expect(app.agentConnection.status().integration?.connected).toBe(true), { timeout: 15_000 });
    const fresh = await host.request('mcpServer/tool/call', { threadId: renewed.thread.id, server: serverName,
      tool: 'get_spending_status', arguments: {} });
    expect(JSON.stringify(fresh)).toContain(memberId);
    expect(app.spendGrantSummary(memberId)?.status).toBe('ACTIVE');

    // Preserve the real host and stdio child while replacing the backend core.
    // Its volatile lease must recover without config reload or credential rotation.
    await app.prepareQuit(); app.close();
    app = new AppRuntime(directory); globals.__yosh = { runtime: app };
    expect(app.agentConnection.status().integration?.connected).toBe(false);
    expect(readConnection(directory, memberId).token).toBe(authorized.token);
    await vi.waitFor(() => expect(app.agentConnection.status().integration?.connected).toBe(true), { timeout: 20_000 });
    const resumed = await host.request('mcpServer/tool/call', { threadId: renewed.thread.id, server: serverName,
      tool: 'get_spending_status', arguments: {} });
    expect(JSON.stringify(resumed)).toContain(memberId);
    expect(app.spendGrantSummary(memberId)?.status).toBe('ACTIVE');

    await host.close(); host = undefined;
    // Codex can kill stdio children without a close report. Their lease must still expire.
    await vi.waitFor(() => expect(app.agentConnection.status().integration?.connected).toBe(false), { timeout: 35_000, interval: 100 });
    await app.prepareQuit(); app.close();
    app = new AppRuntime(directory); globals.__yosh = { runtime: app };
    expect(app.ledger.defaultCardMember().id).toBe(memberId);
    expect(app.memberOverview(other).member.label).toBe('Fixture Research');
    expect(app.agentConnection.status()).toMatchObject({ enabled: true, integration: { configured: true, connected: false } });
    expect(app.spendGrantSummary(memberId)?.status).toBe('ACTIVE');
    expect(() => app.authenticateAgent(new Request(`${origin}/api/agent`, {
      headers: { authorization: `Bearer ${authorized.token}` },
    }))).not.toThrow();
    expect((await write(true)).status).toBe(200);
    expect(readConnection(directory, memberId).token).toBe(authorized.token);
    expect((await write(false)).status).toBe(200);
    expect(app.spendGrantSummary(memberId)?.status).toBe('REVOKED');
    expect(app.agentConnection.status().integration).toMatchObject({ configured: false, connected: false, state: 'disconnected' });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain(serverName);
    expect(existsSync(join(directory, 'mcp-connection.json'))).toBe(false);
  } finally {
    await host?.close();
    await app.prepareQuit(); app.close();
    http.closeAllConnections(); await new Promise<void>(done => http.close(() => done()));
  }
}, 90_000);
