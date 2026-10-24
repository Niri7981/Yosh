import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { startPayDevelopmentBackend } from '../../src/modules/pay-dev/runtime';
import { codexHost } from '../helpers/codex-app-server';
import { z } from 'zod';

it('standalone real development AppRuntime serves authenticated UI controls and real Pay MCP purchases across restart', async () => {
  const previous = { ...process.env };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-development-test-')));
  const directory = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName); mkdirSync(directory, { mode: 0o700 });
  const wrapper = join(parent, 'mcp.cjs');
  execFileSync(resolve('node_modules/.bin/esbuild'), [resolve('scripts/pay-dev-mcp.ts'), '--bundle', '--platform=node',
    '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', `--outfile=${wrapper}`], { stdio: 'ignore' });
  copyFileSync(resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'), join(parent, 'pay-mcp'));
  const token = randomBytes(32).toString('hex');
  process.env.YOSH_PAY_DEV = '1'; process.env.YOSH_MANAGEMENT_TOKEN = token;
  delete process.env.APP2049_MANAGEMENT_TOKEN;
  let backend: Awaited<ReturnType<typeof startPayDevelopmentBackend>> | undefined;
  const clients: Client[] = [];
  const chosenPort = PAY_DEVELOPMENT_PROFILE.backendPort;
  async function control(method: string, path: string, input?: unknown) {
    const body = input === undefined ? '' : JSON.stringify(input);
    const timestamp = String(Date.now()), nonce = randomBytes(32).toString('hex');
    const digest = createHash('sha256').update(body).digest('hex');
    const proof = createHmac('sha256', token).update(['2049-management-v1', method, path, timestamp, nonce, digest].join('\n')).digest('hex');
    return fetch(`${backend!.origin}${path}`, { method, ...(input === undefined ? {} : { body }),
      headers: { origin: backend!.origin, 'content-type': 'application/json', 'x-2049-timestamp': timestamp,
        'x-2049-nonce': nonce, 'x-2049-body-sha256': digest, 'x-2049-proof': proof } });
  }
  async function connect() {
    const connection = backend!.app.agentConnection;
    expect(connection.status().enabled).toBe(true);
    const client = new Client({ name: 'actual-development-runtime', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [wrapper, '--data-dir', directory],
      env: { NODE_ENV: 'production', YOSH_PAY_DEV: '1', HOME: directory, PATH: '/usr/bin:/bin' } }));
    clients.push(client); return client;
  }
  try {
    backend = await startPayDevelopmentBackend({ directory, runtimeDirectory: resolve('build.noindex/pay-dev-delivery/Yosh Pay Dev.app/Contents/Resources/Runtime'),
      port: chosenPort, merchantPort: 0, rpcPort: 0 });
    expect((await fetch(`${backend.origin}/api/app/overview`)).status).toBe(401);
    expect((await control('PUT', '/api/app/execution', { mode: 'live_mainnet' })).status).toBe(409);
    expect((await control('POST', '/api/app/wallets', { requestId: '00000000-0000-4000-8000-000000000002', label: 'Blocked offline wallet', kind: 'create' })).status).toBe(409);
    expect((await control('PUT', '/api/app/connection', { enabled: true })).ok).toBe(true);
    expect((await control('PUT', '/api/app/settings', { dailyLimit: '400000' })).ok).toBe(true);
    expect((await control('PUT', '/api/app/settings', { paused: false })).ok).toBe(true);
    expect((await control('PUT', '/api/app/grant', { action: 'create', totalLimit: '600000', singleLimit: '200000', expiresAt: Date.now() + 3600000 })).ok).toBe(true);
    const grantBeforeReconnect = backend.app.spendGrantSummary();
    expect((await control('PUT', '/api/app/connection', { enabled: true })).ok).toBe(true);
    expect(backend.app.spendGrantSummary()).toEqual(grantBeforeReconnect);
    const client = await connect();
    const statusTool = (await client.listTools()).tools.find(tool => tool.name === 'get_spending_status');
    expect(statusTool?.annotations?.readOnlyHint).toBe(true);
    const status = () => client.callTool({ name: 'get_spending_status', arguments: {} });
    const beforeRead = backend.app.ledger.listForOwner(backend.descriptor.memberId, 50);
    const current = await status();
    expect(current.isError).not.toBe(true);
    expect(JSON.stringify(current.content)).toContain('isolated-pay-dev');
    expect(JSON.stringify(current.content)).toContain('400000');
    expect(backend.app.ledger.listForOwner(backend.descriptor.memberId, 50)).toEqual(beforeRead);
    expect((await client.callTool({ name: 'get_spending_status', arguments: { origin: 'http://127.0.0.1:3049' } })).isError).toBe(true);
    expect((await fetch(`${backend.origin}/api/agent?operation=status`)).status).toBe(401);
    const buy = (id: string, active = client) => active.callTool({ name: 'curl', arguments: { operation_id: id, url: backend!.descriptor.merchantUrl } });
    const codexHome = join(parent, 'codex-home'); mkdirSync(codexHome, { mode: 0o700 });
    writeFileSync(join(codexHome, 'config.toml'), [
      'cli_auth_credentials_store="file"', 'mcp_oauth_credentials_store="file"',
      `[projects.${JSON.stringify(directory)}]`, 'trust_level="trusted"',
      '[mcp_servers.yosh_pay_dev]', `command=${JSON.stringify(process.execPath)}`,
      `args=${JSON.stringify([wrapper, '--data-dir', directory])}`, 'enabled_tools=["curl","get_spending_status"]',
    ].join('\n'), { mode: 0o600 });
    const host = codexHost('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', codexHome, directory);
    let first;
    try {
      await host.request('initialize', { clientInfo: { name: 'pay_trace_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
      host.notify('initialized');
      const thread = z.object({ thread: z.object({ id: z.string() }) }).parse(await host.request('thread/start', {
        cwd: directory, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: true }));
      const tools = await host.request('mcpServerStatus/list', { threadId: thread.thread.id, serverName: 'yosh_pay_dev', detail: 'toolsAndAuthOnly' });
      expect(JSON.stringify(tools)).toContain('get_spending_status');
      first = z.object({ isError: z.boolean().optional(), content: z.array(z.unknown()) }).parse(await host.request('mcpServer/tool/call', {
        threadId: thread.thread.id, server: 'yosh_pay_dev', tool: 'curl',
        arguments: { url: backend.descriptor.merchantUrl, operation_id: 'dev-product-original' } }));
    } finally { await host.close(); }
    expect(first.isError).not.toBe(true); expect(JSON.stringify(first.content)).toContain('Offline');
    expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '0' });
    // Final upstream has no Yosh-private eight-stage instrumentation. Absence
    // remains explicit; persisted custody evidence still proves original execution.
    const traced = backend.app.memberOverview(backend.descriptor.memberId).purchases.find(p => p.status === 'PAID');
    expect(traced?.offline).toBe(true);
    expect(traced?.executionTrace).toMatchObject({ source: 'pay_mcp', originalPaymentState: 'CONFIRMED',
      yoshExecutionPhase: 'SUBMISSION_ATTEMPTED', complete: false, events: [] });
    const originalSummary = backend.app.ledger.listForOwner(backend.descriptor.memberId, 50).find(p => p.status === 'PAID')!;
    const original = backend.app.ledger.getOwned(originalSummary.purchaseId, backend.descriptor.memberId)!;
    expect(backend.app.ledger.executionSafety.provenance(original.intent.id)).toMatchObject({ origin: 'external_pay', phase: 'SUBMISSION_ATTEMPTED' });
    expect(backend.app.ledger.savedOriginalPayment(original.approvalId)?.state).toBe('CONFIRMED');
    expect(JSON.stringify((await status()).content)).toContain('pay_mcp');
    const replay = await buy('dev-product-original');
    // Pay's existing connection-local guard refuses repeated operations in
    // one process. A fresh host below can recover the same durable purchase.
    // This SDK connection has not sent the operation before; its replay reads
    // the original result. The second call hits Pay's connection-local guard.
    expect(replay.isError).not.toBe(true);
    const sameHostReplay = await buy('dev-product-original');
    expect(sameHostReplay.isError).toBe(true);
    expect(JSON.stringify(sameHostReplay)).toContain('OPERATION_ALREADY_STARTED');
    expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet').paid).toBe('200000');
    expect((await control('PUT', '/api/app/settings', { paused: true })).ok).toBe(true);
    expect(JSON.stringify((await status()).content)).toContain('PAYMENTS_PAUSED');
    expect((await buy('dev-product-paused')).isError).toBe(true);
    expect((await control('PUT', '/api/app/settings', { paused: false })).ok).toBe(true);
    // Unavailable diagnostic storage must neither roll back a confirmed
    // purchase nor discard delivery. Missing trace stays explicitly incomplete.
    mkdirSync(join(directory, 'pay-execution-traces'), { recursive: true, mode: 0o700 });
    chmodSync(join(directory, 'pay-execution-traces'), 0o755);
    try { expect((await buy('dev-product-second')).isError).not.toBe(true); }
    finally { chmodSync(join(directory, 'pay-execution-traces'), 0o700); }
    const untraced = backend.app.memberOverview(backend.descriptor.memberId).purchases
      .find(p => p.executionTrace?.operationId === 'dev-product-second');
    expect(untraced).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', executionTrace: { complete: false, events: [] } });
    expect((await buy('dev-product-over-budget')).isError).toBe(true);
    const memberId = backend.descriptor.memberId;
    const before = backend.app.ledger.listForOwner(memberId, 50);
    expect(before.filter(record => record.status === 'PAID')).toHaveLength(2);
    expect(before.filter(record => record.status === 'DENIED')).toHaveLength(2);
    await backend.close(); backend = undefined;
    const unavailable = await status();
    expect(unavailable.isError).toBe(true);
    expect(JSON.stringify(unavailable.content)).toContain('PAY_DEV_STATUS_UNAVAILABLE');
    backend = await startPayDevelopmentBackend({ directory, runtimeDirectory: resolve('build.noindex/pay-dev-delivery/Yosh Pay Dev.app/Contents/Resources/Runtime'),
      port: chosenPort, merchantPort: 0, rpcPort: 0 });
    expect(backend.descriptor.memberId).toBe(memberId);
    expect(backend.app.memberOverview(memberId).purchases.filter(p => p.status === 'PAID').every(p => p.executionTrace?.complete === false)).toBe(true);
    expect((await status()).isError).not.toBe(true);
    expect((await buy('dev-product-original', await connect())).isError).not.toBe(true);
    expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '400000', reserved: '0' });
    const after = backend.app.ledger.listForOwner(memberId, 50);
    expect(after.filter(record => record.status === 'PAID').map(record => record.transaction).sort())
      .toEqual(before.filter(record => record.status === 'PAID').map(record => record.transaction).sort());
    expect((await control('PUT', '/api/app/connection', { enabled: false })).ok).toBe(true);
    const revoked = await status();
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked.content)).toContain('PAY_DEV_REVOKED');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await backend?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(parent, { recursive: true, force: true });
  }
}, 30_000);
