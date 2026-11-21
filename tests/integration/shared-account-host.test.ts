import { buildSync } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { handleAccountRead } from '../../src/modules/mcp/account-read-route';
import { readConnection } from '../../src/modules/mcp/connection';
import { codexHost } from '../helpers/codex-app-server';
import { PAY_MCP_PATH, productionPayFixture, TEST_DELIVERY } from '../helpers/pay-production-fixture';

const bundle = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const executable = process.env.YOSH_TEST_CODEX_EXECUTABLE ?? bundle;
const toolReply = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) });
const page = z.object({ entries: z.array(z.object({ purchaseId: z.uuid(), agentId: z.uuid(), createdAt: z.number(),
  paidAtomic: z.string(), reservedAtomic: z.string() })), nextBefore: z.uuid().nullable(),
  totals: z.object({ paidAtomic: z.string(), reservedAtomic: z.string() }) });

async function memberSession(directory: string, memberId: string, name: string, payWrapper?: string) {
  const home = join(directory, name);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'config.toml'), [
    'cli_auth_credentials_store="file"', 'mcp_oauth_credentials_store="file"', '[analytics]', 'enabled=false',
    '[feedback]', 'enabled=false', '[projects.' + JSON.stringify(home) + ']', 'trust_level="trusted"',
    '[mcp_servers.yosh]', 'command=' + JSON.stringify(process.execPath),
    'args=' + JSON.stringify(payWrapper ? [payWrapper, '--data-dir', directory]
      : ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/mcp.ts')]),
    '[mcp_servers.yosh.env]', 'YOSH_DATA_DIR=' + JSON.stringify(directory), 'YOSH_CARD_MEMBER_ID=' + JSON.stringify(memberId),
  ].join('\n'), { mode: 0o600 });
  const host = codexHost(executable, home, home, [], { PATH: '/usr/bin:/bin', HOME: home, NODE_ENV: 'test' });
  try {
    await host.request('initialize', { clientInfo: { name: 'yosh_shared_account_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
    host.notify('initialized');
    const { thread } = z.object({ thread: z.object({ id: z.string() }) }).parse(await host.request('thread/start',
      { cwd: home, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true }));
    const status = z.object({ data: z.array(z.object({ name: z.string(), tools: z.record(z.string(), z.unknown()) })) })
      .parse(await host.request('mcpServerStatus/list', { threadId: thread.id, detail: 'toolsAndAuthOnly' }));
    const inventory = status.data.find(server => server.name === 'yosh')?.tools;
    expect(inventory).toHaveProperty(payWrapper ? 'curl' : 'request_purchase');
    const call = async (tool: string, args: Record<string, unknown>) => toolReply.parse(await host.request('mcpServer/tool/call',
      { threadId: thread.id, server: 'yosh', tool, arguments: args }));
    const read = async (tool: string, args: Record<string, unknown>) => {
      const response = await call(tool, args);
      expect(response.isError, response.content[0]?.text.slice(0, 120)).not.toBe(true);
      return JSON.parse(response.content[0].text) as unknown;
    };
    return { inventory, read, call, close: host.close };
  } catch (error) { await host.close(); throw error; }
}

it.skipIf(!existsSync(executable))('reuses one paid result across independent Codex sessions without granting new spending authority', async () => {
  const fixture = await productionPayFixture();
  const sessions: Awaited<ReturnType<typeof memberSession>>[] = [];
  let foreignAccount: AppRuntime | undefined;
  const operation = 'private-request-key-a';
  const purchase = (requestId: string) => ({ requestId, resourceId: 'market-snapshot', reason: 'private-fixture-request-purpose' });
  try {
    const member = fixture.app.createCardMember('Second fixture Agent').member;
    await fixture.app.setMemberConnection(true, fixture.origin, member.id);
    expect(fixture.app.spendGrantSummary(member.id)).toBeNull();
    const buyer = await memberSession(fixture.directory, fixture.memberId, 'buyer-host'); sessions.push(buyer);
    const delivery = await buyer.read('request_purchase', purchase(operation));
    expect(delivery).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', amount: '200000', resource: TEST_DELIVERY });
    const reader = await memberSession(fixture.directory, member.id, 'reader-host'); sessions.push(reader);
    expect(reader.inventory).toHaveProperty('list_account_purchases');
    expect(reader.inventory).toHaveProperty('read_account_result');
    expect(await reader.read('request_purchase', purchase('second-member-without-grant'))).toMatchObject({
      status: 'DENIED', decision: { reason: 'SPEND_GRANT_REQUIRED' }, paymentStatus: 'NOT_STARTED' });
    const counters = () => ({ quoted: fixture.unpaidRequests, paid: fixture.paidRequests,
      signed: fixture.signatureCalls, transactions: fixture.transactions.size, rpc: fixture.rpcMethods.length,
      spent: fixture.app.ledger.managedSummary(Date.now(), 'live_devnet').paid });
    const originalCounts = counters();
    expect(originalCounts).toMatchObject({ paid: 1, signed: 1, transactions: 1, spent: '200000' });
    const first = page.parse(await reader.read('list_account_purchases', { limit: 1 }));
    expect(first.entries).toMatchObject([{ agentId: member.id, paidAtomic: '0', reservedAtomic: '0' }]);
    expect(first.nextBefore).toBe(first.entries[0].purchaseId);
    const second = page.parse(await reader.read('list_account_purchases', { limit: 1, before: first.nextBefore }));
    expect(second.entries).toMatchObject([{ agentId: fixture.memberId, paidAtomic: '200000', reservedAtomic: '0' }]);
    expect(second.nextBefore).toBeNull(); expect(second.totals).toEqual(first.totals);
    expect(second.totals).toEqual({ paidAtomic: '200000', reservedAtomic: '0' });
    const { purchaseId, createdAt } = second.entries[0];
    const filtered = await reader.read('list_account_purchases', { agentId: fixture.memberId, from: createdAt, until: createdAt + 1 });
    expect(page.parse(filtered).entries).toEqual(second.entries);
    expect(JSON.stringify(filtered)).not.toMatch(/private-fixture-request-purpose|private-request-key-a|paymentPayload|connectionId/);
    expect(page.parse(await reader.read('list_account_purchases', { until: createdAt })).entries).toEqual([]);
    const result = z.object({ purchaseId: z.uuid(), recordedAt: z.number(), encoding: z.literal('base64'),
      chunk: z.string(), nextOffset: z.null(), totalBytes: z.number() }).parse(await reader.read('read_account_result', { purchaseId }));
    expect(result.purchaseId).toBe(purchaseId);
    const data = Buffer.from(result.chunk, 'base64');
    expect(data.byteLength).toBe(result.totalBytes); expect(JSON.parse(data.toString())).toEqual(TEST_DELIVERY);
    expect(await buyer.read('read_account_result', { purchaseId })).toMatchObject(result);
    expect((await reader.call('get_purchase_delivery', { purchaseId: operation })).isError).toBe(true);
    const wrapper = join(fixture.directory, 'mcp.cjs');
    buildSync({ entryPoints: [resolve('scripts/pay-dev-mcp.ts')], platform: 'node', bundle: true, format: 'cjs', outfile: wrapper,
      define: { __YOSH_RC5__: 'false' } });
    copyFileSync(PAY_MCP_PATH, join(fixture.directory, 'pay-mcp'));
    writeFileSync(join(fixture.directory, 'pay-dev-runtime.json'), JSON.stringify({
      version: 1, profile: 'isolated-pay-dev', origin: fixture.origin, memberId: fixture.memberId,
    }), { mode: 0o600 });
    const payReader = await memberSession(fixture.directory, member.id, 'pay-reader-host', wrapper); sessions.push(payReader);
    expect((await payReader.call('get_purchase_delivery', { purchaseId: operation })).isError).toBe(true);
    expect(await payReader.read('read_account_result', { purchaseId })).toMatchObject(result);
    expect(page.parse(await payReader.read('list_account_purchases', { agentId: fixture.memberId })).entries).toEqual(second.entries);
    expect((await reader.call('read_account_result', { purchaseId: first.entries[0].purchaseId })).isError).toBe(true);
    const token = readConnection(fixture.directory, member.id).token;
    const readHttp = (path: string, credential: string) => fetch(fixture.origin + path,
      { headers: { authorization: 'Bearer ' + credential } });
    expect((await readHttp('/api/agent/purchase?purchaseId=' + operation, token)).status).toBe(404);
    const foreignDir = join(fixture.directory, 'other-account');
    mkdirSync(foreignDir, { mode: 0o700 });
    foreignAccount = new AppRuntime(foreignDir, { ...fixture.dependencies, paymentExecutor: undefined });
    foreignAccount.setAgentConnection(true, fixture.origin);
    const foreignToken = readConnection(foreignDir).token;
    const path = '/api/agent/account/result?purchaseId=' + purchaseId;
    expect((await readHttp(path, foreignToken)).status).toBe(401);
    expect((await readHttp('/api/agent/account/statement', foreignToken)).status).toBe(401);
    const foreignRequest = (resource: string) => new Request(fixture.origin + resource, { headers: { authorization: 'Bearer ' + foreignToken } });
    expect((await handleAccountRead(foreignAccount, 'result', foreignRequest(path))).status).toBe(404);
    expect(page.parse(await handleAccountRead(foreignAccount, 'statement', foreignRequest('/api/agent/account/statement')).json()).entries).toEqual([]);
    fixture.app.setExecution('simulated');
    expect(page.parse(await reader.read('list_account_purchases', {})).entries).toEqual([]);
    expect((await readHttp(path, token)).status).toBe(404);
    fixture.app.setExecution('live_devnet');
    fixture.app.revokeCardMember(member.id);
    expect((await readHttp(path, token)).status).toBe(401);
    expect((await reader.call('list_account_purchases', {})).isError).toBe(true);
    expect((await reader.call('read_account_result', { purchaseId })).isError).toBe(true);
    expect((await payReader.call('read_account_result', { purchaseId })).isError).toBe(true);
    expect(await buyer.read('read_account_result', { purchaseId })).toMatchObject(result);
    expect(counters()).toEqual(originalCounts);
  } finally {
    for (const session of sessions) await session.close();
    if (foreignAccount) { await foreignAccount.prepareQuit(); foreignAccount.close(); }
    await fixture.close();
  }
}, 90_000);
