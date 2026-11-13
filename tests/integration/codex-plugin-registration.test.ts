import { buildSync } from 'esbuild';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { startPayDevelopmentBackend } from '../../src/modules/pay-dev/runtime';
import { readConnection } from '../../src/modules/mcp/connection';

const dependency = createRequire(import.meta.url);
const runtimeDirectory = resolve(process.env.YOSH_PLUGIN_TEST_RUNTIME_DIR ?? 'build.noindex/codex-plugin-dev/Yosh Codex Plugin Dev.app/Contents/Resources/Runtime');
async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  await new Promise<void>(done => server.close(() => done())); return address.port;
}

it('registers an owner-bound Offline resource without spending authority and purchases only under its own Grant across replay and restart', async () => {
  const previous = { ...process.env }, parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-plugin-register-')));
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const entry = join(parent, 'runtime.cjs');
  buildSync({ entryPoints: [resolve('src/modules/pay-dev/runtime.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    define: { __YOSH_PLUGIN_DEV__: 'true', __YOSH_RC5__: 'false' }, outfile: entry });
  symlinkSync(resolve('node_modules'), join(parent, 'node_modules'));
  const start = z.object({ startPayDevelopmentBackend: z.custom<typeof startPayDevelopmentBackend>() }).parse(dependency(entry)).startPayDevelopmentBackend;
  let backend: Awaited<ReturnType<typeof startPayDevelopmentBackend>> | undefined;
  const clients: Client[] = [], port = await freePort();
  const network = () => z.object({ transactions: z.array(z.object({ signature: z.string() })) })
    .parse(JSON.parse(readFileSync(join(directory, 'simulator/offline-network.json'), 'utf8')));
  async function connect(memberId: string) {
    if (!backend) throw new Error('TEST_RUNTIME_REQUIRED');
    const config = join(directory, `pay-host-${clients.length}.json`);
    writeFileSync(config, JSON.stringify({ origin: backend.origin, caller: memberId,
      token: readConnection(directory, memberId).token, timeout_ms: 5000 }), { mode: 0o600 });
    const client = new Client({ name: 'plugin-registration', version: '1' });
    await client.connect(new StdioClientTransport({ command: join(runtimeDirectory, 'pay-mcp'), args: [config], cwd: directory,
      env: { NODE_ENV: 'test', HOME: directory, PATH: '/usr/bin:/bin' }, stderr: 'pipe' })); clients.push(client); return client;
  }
  try {
    process.env.YOSH_PAY_DEV = '1'; process.env.YOSH_PAY_DEV_ENV = 'offline'; process.env.YOSH_MANAGEMENT_TOKEN = randomBytes(32).toString('hex');
    for (const key of Object.keys(process.env)) if (key.startsWith('APP2049_')) delete process.env[key];
    backend = await start({ directory, runtimeDirectory, port, merchantPort: 0, rpcPort: 0 });
    const app = backend.app, memberId = backend.descriptor.memberId;
    app.setDailyLimit('2000000'); app.setPaused(false); await app.setMemberConnection(true, backend.origin, memberId);
    app.createSpendGrant({ totalLimit: '1000000', singleLimit: '200000', expiresAt: Date.now() + 600_000 });
    const oldGrant = app.spendGrantSummary();
    const connection = readConnection(directory, memberId);
    const principal = app.authenticateAgent(new Request(`${backend.origin}/api/agent`, { headers: { authorization: `Bearer ${connection.token}` } }));
    const target = `${backend.origin}/api/paid/plugin-snapshot?asset=SOL`;
    for (const input of [{ url: 'https://public.example/data' }, { url: 'http://127.0.0.1:13449/private' },
      { url: backend.descriptor.merchantUrl }, { url: `${target}&extra=1` }, { url: target, method: 'POST', body: '{}' },
      { url: target, approved: true }, { url: target, headers: { accept: 'text/plain' } }, { url: target, sample: { query: { arbitrary: 'input' } } }])
      await expect(app.discoverAgentResource(input, principal)).rejects.toThrow();
    expect(app.ledger.resources.list()).toEqual([]); expect(app.spendGrantSummary()).toEqual(oldGrant);
    const discovery = await app.discoverAgentResource({ url: target }, principal);
    expect(discovery).toMatchObject({ registrationStatus: 'DISCOVERED', paymentSent: false });
    const resourceId = 'agent-offline-snapshot';
    const registration = { discoveryId: discovery.discoveryId, resourceId, providerId: 'offline-fixture', displayName: 'Offline registered snapshot' };
    const other = app.createCardMember('Another Agent').member.id;
    await app.setMemberConnection(true, backend.origin, other);
    const otherPrincipal = app.authenticateAgent(new Request(`${backend.origin}/api/agent`, {
      headers: { authorization: `Bearer ${readConnection(directory, other).token}` } }));
    expect(() => app.registerAgentResource(registration, otherPrincipal)).toThrow('RESOURCE_DISCOVERY_NOT_FOUND');
    expect(() => app.registerAgentResource({ ...registration, approved: true }, principal)).toThrow();
    const registered = app.registerAgentResource({ discoveryId: discovery.discoveryId, resourceId, providerId: 'offline-fixture', displayName: 'Offline registered snapshot' }, principal);
    expect(registered).toMatchObject({ registrationStatus: 'REGISTERED', spendingAuthorityCreated: false, paymentSent: false });
    expect(app.registerAgentResource(registration, principal)).toEqual(registered);
    expect(() => app.registerAgentResource({ ...registration, resourceId: 'changed-id' }, principal)).toThrow('RESOURCE_DISCOVERY_CONSUMED');
    expect(app.spendGrantSummary()).toEqual(oldGrant);
    expect(app.ledger.listForOwner(memberId)).toEqual([]);
    expect((await app.overview()).service).toMatchObject({ registeredResourceRequired: true,
      registeredResources: [expect.objectContaining({ resourceId, url: target })] });
    const quote = await app.quoteRegisteredResource(resourceId, {}, memberId);
    expect(quote).toMatchObject({ amount: '200000', paymentSent: false, preflight: { ready: false, code: 'SPEND_GRANT_REQUIRED' } });
    expect((await app.quotePaidResources(backend.origin, memberId)).resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: 'market-snapshot', amount: '200000' }), expect.objectContaining({ resourceId })]));
    const first = await connect(memberId);
    const buy = (client: Client, operation: string, url = target) => client.callTool({ name: 'curl', arguments: { operation_id: operation, url } });
    expect((await buy(await connect(other), 'other-agent-no-grant')).isError).toBe(true);
    expect((await buy(first, 'registered-no-grant')).isError).toBe(true);
    expect(app.ledger.listForOwner(memberId)[0]).toMatchObject({ resourceId, status: 'DENIED', decisionReason: 'SPEND_GRANT_REQUIRED' });
    expect(network().transactions).toHaveLength(0);
    await app.createSpendGrant({ resourceId, totalLimit: '600000', singleLimit: '200000', expiresAt: Date.now() + 600_000 });
    expect(app.ledger.spendGrantSummary(Date.now(), 'live_devnet', memberId, resourceId)).toMatchObject({ resourceId, totalLimit: '600000' });
    const challengeResponse = await fetch(target);
    const challenge = z.object({ resource: z.unknown(), accepts: z.array(z.object({ amount: z.string(), network: z.string(), asset: z.string(), payTo: z.string() }).passthrough()) }).passthrough()
      .parse(JSON.parse(Buffer.from(challengeResponse.headers.get('payment-required')!, 'base64').toString('utf8')));
    await challengeResponse.body?.cancel();
    const changed = { ...challenge.accepts[0], amount: '300000' };
    const changedFacts = { caller_id: memberId, operation_id: 'registered-quote-changed', attempt_id: randomUUID(),
      request: { method: 'GET', url: target, headers: [['accept', 'application/json']], body: null },
      execution_network: 'devnet', network: changed.network, asset: changed.asset, recipient: changed.payTo,
      amount_atomic: changed.amount, accepted: changed };
    const post = (stage: string, raw: unknown) => fetch(`${backend!.origin}/pay/${stage}`, { method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify(raw) });
    expect((await post('authorize', changedFacts)).ok).toBe(true);
    expect((await post('plan', { facts: { ...changedFacts, payment_required: { ...challenge, accepts: [changed] } } })).ok).toBe(false);
    expect(network().transactions).toHaveLength(0);
    expect((await buy(first, 'registered-success')).isError).not.toBe(true);
    const original = app.ledger.listForOwner(memberId).find(purchase => purchase.status === 'PAID')!;
    expect(original).toMatchObject({ resourceId, deliveryStatus: 'COMPLETE' }); expect(network().transactions).toHaveLength(1);
    expect((await buy(await connect(memberId), 'registered-success')).isError).not.toBe(true);
    expect(network().transactions).toHaveLength(1);
    const [concurrentA, concurrentB] = await Promise.all([connect(memberId), connect(memberId)]);
    const concurrent = await Promise.all([buy(concurrentA, 'registered-concurrent'), buy(concurrentB, 'registered-concurrent')]);
    expect(concurrent.some(result => result.isError !== true)).toBe(true);
    expect(network().transactions).toHaveLength(2);
    app.revokeSpendGrant(memberId, resourceId);
    expect((await buy(await connect(memberId), 'registered-revoked')).isError).toBe(true);
    expect(network().transactions).toHaveLength(2);
    // The old fixed path and its Grant keep their historical identity.
    expect((await buy(await connect(memberId), 'legacy-after-registration', backend.descriptor.merchantUrl)).isError).not.toBe(true);
    expect(app.ledger.spendGrantSummary(Date.now(), 'live_devnet', memberId, oldGrant!.resourceId)?.id).toBe(oldGrant!.id);
    app.setPaused(true); await backend.close(); backend = undefined;
    backend = await start({ directory, runtimeDirectory, port, merchantPort: 0, rpcPort: 0 });
    expect((await buy(await connect(memberId), 'registered-success')).isError).not.toBe(true);
    expect(backend.app.ledger.getOwned(original.purchaseId, memberId)?.transaction).toBe(original.transaction);
    expect(network().transactions).toHaveLength(3);
  } finally {
    for (const client of clients) await client.close().catch(() => {}); await backend?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    rmSync(parent, { recursive: true, force: true });
  }
}, 30_000);
