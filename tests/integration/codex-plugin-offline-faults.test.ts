import { buildSync } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { startPayDevelopmentBackend } from '../../src/modules/pay-dev/runtime';
import { readConnection } from '../../src/modules/mcp/connection';

const requireDependency = createRequire(import.meta.url);
const runtimeDirectory = resolve(process.env.YOSH_PLUGIN_TEST_RUNTIME_DIR ?? 'build.noindex/codex-plugin-dev/Yosh Codex Plugin Dev.app/Contents/Resources/Runtime');
async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}

it.each(['lose-paid-response-and-rpc', 'delivery-unavailable'] as const)('real Offline runtime keeps original accounting through %s and restart without a second transfer', async mode => {
  const previous = { ...process.env };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-plugin-runtime-fault-')));
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const entry = join(parent, 'runtime.cjs');
  buildSync({ entryPoints: [resolve('src/modules/pay-dev/runtime.ts')], bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', define: { __YOSH_PLUGIN_DEV__: 'true', __YOSH_RC5__: 'false' }, outfile: entry });
  symlinkSync(resolve('node_modules'), join(parent, 'node_modules'));
  const exports: unknown = requireDependency(entry);
  const start = z.object({ startPayDevelopmentBackend: z.custom<typeof startPayDevelopmentBackend>(value => typeof value === 'function') })
    .parse(exports).startPayDevelopmentBackend;
  const port = await freePort();
  let backend: Awaited<ReturnType<typeof startPayDevelopmentBackend>> | undefined;
  const clients: Client[] = [];
  const operationId = `fault-${mode}`;
  const network = () => z.object({ transactions: z.array(z.object({ signature: z.string(), amount: z.string(), delivery: z.unknown() })) })
    .parse(JSON.parse(readFileSync(join(directory, 'simulator/offline-network.json'), 'utf8')));
  async function connect() {
    if (!backend) throw new Error('TEST_RUNTIME_REQUIRED');
    const memberId = backend.descriptor.memberId;
    const config = join(directory, `pay-host-${clients.length}.json`);
    writeFileSync(config, JSON.stringify({ origin: backend.origin, caller: memberId,
      token: readConnection(directory, memberId).token, timeout_ms: 5_000 }), { mode: 0o600 });
    const client = new Client({ name: 'plugin-offline-fault-regression', version: '1' });
    await client.connect(new StdioClientTransport({ command: join(runtimeDirectory, 'pay-mcp'), args: [config],
      cwd: directory, env: { NODE_ENV: 'test', HOME: directory, PATH: '/usr/bin:/bin' }, stderr: 'pipe' }));
    clients.push(client); return client;
  }
  try {
    process.env.YOSH_PAY_DEV = '1'; process.env.YOSH_PAY_DEV_ENV = 'offline';
    process.env.YOSH_MANAGEMENT_TOKEN = randomBytes(32).toString('hex');
    for (const key of Object.keys(process.env)) if (key.startsWith('APP2049_')) delete process.env[key];
    process.env.YOSH_DATA_DIR = directory;
    backend = await start({ directory, runtimeDirectory, port, merchantPort: 0, rpcPort: 0 });
    backend.app.setDailyLimit('400000'); backend.app.setPaused(false);
    await backend.app.setMemberConnection(true, backend.origin, backend.descriptor.memberId);
    backend.app.createSpendGrant({ totalLimit: '400000', singleLimit: '200000', expiresAt: Date.now() + 600_000 });
    const file = join(directory, 'simulator/offline-fault.json');
    writeFileSync(file, JSON.stringify({ version: 1, mode }), { mode: 0o600 });
    const failed = await (await connect()).callTool({ name: 'curl', arguments: { operation_id: operationId, url: backend.descriptor.merchantUrl } });
    expect(failed.isError).toBe(true);
    const memberId = backend.descriptor.memberId;
    const initial = backend.app.ledger.listForOwner(memberId, 50)[0];
    expect(initial).toBeDefined();
    const original = backend.app.ledger.getOwned(initial.purchaseId, memberId)!;
    expect(original.status).toBe(mode === 'lose-paid-response-and-rpc' ? 'PAYMENT_UNKNOWN' : 'PAID');
    expect(original.deliveryStatus).toBe(mode === 'lose-paid-response-and-rpc' ? 'NOT_PAID' : 'PENDING');
    expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject(mode === 'lose-paid-response-and-rpc'
      ? { paid: '0', reserved: '200000' } : { paid: '200000', reserved: '0' });
    const before = network(); expect(before.transactions).toHaveLength(1);
    if (mode === 'lose-paid-response-and-rpc') {
      const unresolved = await (await connect()).callTool({ name: 'curl', arguments: { operation_id: operationId, url: backend.descriptor.merchantUrl } });
      expect(unresolved.isError).toBe(true);
      expect(network().transactions).toEqual(before.transactions);
      expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '0', reserved: '200000' });
    }
    const saved = backend.app.ledger.savedOriginalPayment(original.approvalId)!;
    expect(saved).toBeDefined();
    const payload = backend.app.ledger.savedPayload(original.approvalId);
    expect(payload).toBeDefined();
    backend.app.setPaused(true);
    await backend.close(); backend = undefined;
    writeFileSync(file, JSON.stringify({ version: 1, mode: 'none' }));
    backend = await start({ directory, runtimeDirectory, port, merchantPort: 0, rpcPort: 0 });
    const replay = await (await connect()).callTool({ name: 'curl', arguments: { operation_id: operationId, url: backend.descriptor.merchantUrl } });
    expect(replay.isError).not.toBe(true);
    const recovered = backend.app.ledger.getOwned(initial.purchaseId, memberId)!;
    expect(recovered).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', transaction: before.transactions[0].signature });
    expect(backend.app.ledger.savedPayload(original.approvalId)).toEqual(payload);
    expect(recovered.data).toEqual(before.transactions[0].delivery);
    expect(network().transactions).toEqual(before.transactions);
    expect(backend.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '0' });
    expect(backend.app.ledger.listForOwner(memberId, 50)).toHaveLength(1);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await backend?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true });
  }
}, 30_000);
