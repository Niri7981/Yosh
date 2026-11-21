import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startRemoteReadRelay } from '../../src/modules/remote/forwarder';
import { readConnection } from '../../src/modules/mcp/connection';
import { signedManagementRequest } from '../helpers/management-request';
import { productionPayFixture, TEST_DELIVERY } from '../helpers/pay-production-fixture';
import { testingSshHost } from '../helpers/remote-read-ssh-fixture';

const paired = z.object({ id: z.uuid(), memberId: z.uuid(), token: z.string().regex(/^yrr1_[A-Za-z0-9_-]{43}$/) });
const statement = z.object({ entries: z.array(z.object({ purchaseId: z.uuid(), agentId: z.uuid() })),
  totals: z.object({ paidAtomic: z.string(), reservedAtomic: z.string() }) });
const textContent = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty() });
const readResult = async (client: Client, name: string, args: Record<string, unknown>) => {
  const reply = textContent.parse(await client.callTool({ name, arguments: args }));
  expect(reply.isError, reply.content[0].text.slice(0, 80)).not.toBe(true);
  return JSON.parse(reply.content[0].text) as unknown;
};
const sshAvailable = ['/usr/bin/ssh', '/usr/bin/ssh-keygen', '/usr/sbin/sshd'].every(p => existsSync(p));

it.skipIf(!sshAvailable)('pairs two distinct remote readers, carries SDK calls over a pinned OpenSSH reverse tunnel, and never spends on reuse', async () => {
  const nativeFetch = globalThis.fetch;
  const secret = randomBytes(32).toString('hex');
  const confirm = vi.fn(async () => false);
  const fixture = await productionPayFixture({ confirmRemoteReadPairing: confirm });
  let ssh: Awaited<ReturnType<typeof testingSshHost>> | undefined;
  let relay: Awaited<ReturnType<typeof startRemoteReadRelay>> | undefined;
  const clients: Client[] = [];
  try {
    vi.stubEnv('APP2049_MANAGEMENT_TOKEN', undefined); vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
    const buyer = await fixture.connect();
    expect(await fixture.purchase(buyer, 'private-remote-read-fixture')).toMatchObject({ status: 'PAID', resource: TEST_DELIVERY, amount: '200000' });
    const counts = () => ({ quoted: fixture.unpaidRequests, paid: fixture.paidRequests, signed: fixture.signatureCalls,
      rpc: fixture.rpcMethods.length, chain: fixture.transactions.size, spent: fixture.app.ledger.managedSummary(Date.now(), 'live_devnet').paid });
    const original = counts();
    expect(original).toMatchObject({ paid: 1, signed: 1, chain: 1, spent: '200000' });

    const management = fixture.origin + '/api/app/remote-read-pairings';
    const manage = (body?: unknown) => nativeFetch(signedManagementRequest(management, secret, body === undefined ? {} : {
      method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const requestPair = (label: string, scopes: string[]) => manage({ action: 'pair', label, scopes });
    expect((await requestPair('Not authorized', ['statement'])).status).toBe(403);
    expect(await (await manage()).json()).toEqual({ pairings: [] });
    confirm.mockResolvedValue(true);
    const directory = realpathSync(fixture.directory);
    writeFileSync(join(directory,'standalone-control.json'), JSON.stringify({ profile: 'com.yosh.local-authorization-dev',
      environment: 'devnet', managementSecret: secret }), { mode: 0o600 });
    const owner = async (action: string, ...args: string[]) => (await promisify(execFile)(process.execPath,
      ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/remote-read-owner.ts'), action, '--data-dir', directory,
        '--backend-port', new URL(fixture.origin).port, ...args], { cwd: directory, env: { HOME: directory, NODE_ENV: 'test', PATH: '/usr/bin:/bin' } })).stdout;
    const pair = async (label: string, scope: string) => {
      const file = join(directory, label + '.token');
      const stdout = await owner('pair', '--label', label, '--scope', scope, '--token-out', file);
      const token = readFileSync(file, 'utf8');
      expect(statSync(file).mode & 0o777).toBe(0o600); expect(stdout.includes(token)).toBe(false);
      return paired.parse({ ...z.object({ id: z.uuid(), memberId: z.uuid() }).parse(JSON.parse(stdout)), token });
    };
    const all = await pair('Remote researcher', 'statement,result'), bills = await pair('Remote auditor', 'statement');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ label: 'Remote researcher', scopes: ['statement','result'], account: expect.any(String), environment: 'live_devnet' }));
    expect(new Set([fixture.memberId, all.memberId, bills.memberId]).size).toBe(3);
    expect(all.token === bills.token).toBe(false);
    expect(fixture.app.spendGrantSummary(all.memberId)).toBeNull();
    const metadata = await owner('list');
    expect(metadata).toContain(bills.id); expect(metadata.includes(all.token) || metadata.includes(bills.token)).toBe(false);

    ssh = await testingSshHost();
    relay = await startRemoteReadRelay({ listenPort: 0, tunnelPort: ssh.tunnelPort });
    await ssh.connect(Number(new URL(fixture.origin).port));
    const endpoint = new URL('http://127.0.0.1:' + relay.port + '/mcp');
    const remote = async (token: string) => {
      const client = new Client({ name: 'generic-remote-reader', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: 'Bearer ' + token } },
        fetch: nativeFetch })); return client;
    };
    const rpc = (token: string, method: string, params: unknown = {}, url = endpoint.href) => nativeFetch(url, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const a = await remote(all.token), b = await remote(bills.token);
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(['list_account_purchases', 'read_account_result']);
    expect((await b.listTools()).tools.map(t => t.name)).toEqual(['list_account_purchases']);
    const page = statement.parse(await readResult(b, 'list_account_purchases', { agentId: fixture.memberId }));
    expect(page.totals).toEqual({ paidAtomic: '200000', reservedAtomic: '0' });
    expect(page.entries).toHaveLength(1); expect(page.entries[0].agentId).toBe(fixture.memberId);
    const args = { purchaseId: page.entries[0].purchaseId };
    const receipt = z.object({ purchaseId: z.uuid(), recordedAt: z.number(), chunk: z.string() }).parse(await readResult(a, 'read_account_result', args));
    expect(JSON.parse(Buffer.from(receipt.chunk,'base64').toString())).toEqual(TEST_DELIVERY);
    for (const [token, name] of [[bills.token, 'read_account_result'], [all.token, 'request_purchase'], [all.token, 'recover_payment']]) {
      const response = await rpc(token, 'tools/call', { name, arguments: args });
      const denied = z.union([z.object({ error: z.object({ code: z.number() }) }), z.object({ result: z.object({ isError: z.literal(true) }) })]);
      expect(denied.safeParse(await response.json()).success).toBe(true);
    }
    expect((await rpc(readConnection(fixture.directory).token, 'tools/list')).status).toBe(401);
    expect((await rpc(all.token, 'tools/list', {}, new URL('/api/app/remote-read-pairings', endpoint).href)).status).toBe(404);
    expect((await nativeFetch(management, { headers: { authorization: 'Bearer ' + all.token } })).status).toBe(401);
    expect((await fixture.post('no-spending-with-reader', all.token)).status).toBe(401);
    expect(counts()).toEqual(original);

    await ssh.stopLink();
    const offline = await rpc(all.token,'tools/list');
    expect(offline.status).toBe(503); expect(await offline.json()).toEqual({ code: 'MAC_OFFLINE' });
    await ssh.connect(Number(new URL(fixture.origin).port));
    expect(await readResult(a, 'read_account_result', args)).toMatchObject(receipt);
    // Drop SSH without stopping the Mac connector: the same CLI must reconnect on its own.
    ssh.dropTransport();
    await vi.waitFor(async () => { expect((await rpc(all.token, 'tools/list')).status).toBe(503); }, { timeout: 2000, interval: 25 });
    await vi.waitFor(async () => { expect((await rpc(all.token, 'tools/list')).status).toBe(200); }, { timeout: 8000, interval: 100 });
    expect(await readResult(a, 'read_account_result', args)).toMatchObject(receipt);
    fixture.app.setExecution('simulated');
    expect((await rpc(all.token, 'tools/list')).status).toBe(401);
    fixture.app.setExecution('live_devnet');
    expect(JSON.parse(await owner('revoke', '--id', all.id))).toEqual({ revoked: true });
    expect((await rpc(all.token, 'tools/call', { name: 'read_account_result', arguments: args })).status).toBe(401);
    await fixture.reopenWithoutPayExecutor();
    expect((await rpc(all.token, 'tools/list')).status).toBe(401);
    expect(await readResult(b, 'list_account_purchases', { agentId: fixture.memberId })).toMatchObject(page);
    expect(counts()).toEqual(original);
  } finally {
    for (const client of clients) await client.close();
    await relay?.close(); await ssh?.close(); await fixture.close();
  }
}, 60_000);
