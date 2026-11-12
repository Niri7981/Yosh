import { buildSync } from 'esbuild';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { startPayDevelopmentBackend } from '../../src/modules/pay-dev/runtime';
import { readConnection } from '../../src/modules/mcp/connection';
import { startLocalAuthorization } from '../../src/modules/authority/local-authorization-server';

const dependency = createRequire(import.meta.url);
async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
it('isolates browser sessions and commits exact frozen grants through a test confirmation dependency; no native acceptance claim', async () => {
  const previous = { ...process.env }, parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-local-web-')));
  const browserFetch = globalThis.fetch;
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const entry = join(parent, 'runtime.cjs');
  buildSync({ entryPoints: [resolve('src/modules/pay-dev/runtime.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    define: { __YOSH_PLUGIN_DEV__: 'true', __YOSH_RC5__: 'false' }, outfile: entry });
  symlinkSync(resolve('node_modules'), join(parent, 'node_modules'));
  const start = z.object({ startPayDevelopmentBackend: z.custom<typeof startPayDevelopmentBackend>() }).parse(dependency(entry)).startPayDevelopmentBackend;
  let backend: Awaited<ReturnType<typeof startPayDevelopmentBackend>> | undefined;
  let web: Awaited<ReturnType<typeof startLocalAuthorization>> | undefined;
  let controlConfirmations = 0;
  let confirmationCalls = 0, release: (() => void) | undefined;
  let refuse = true;
  try {
    process.env.YOSH_PAY_DEV = '1'; process.env.YOSH_PAY_DEV_ENV = 'offline';
    const secret = randomBytes(32).toString('hex'); process.env.YOSH_MANAGEMENT_TOKEN = secret;
    for (const key of Object.keys(process.env)) if (key.startsWith('APP2049_')) delete process.env[key];
    backend = await start({ directory, runtimeDirectory: resolve('build.noindex/standalone-dev-b6/runtime'), port: await freePort(),
      merchantPort: 0, rpcPort: 0, localAuthorizationOnly: true });
    const { app, descriptor, origin } = backend;
    app.setPaused(true); await app.setMemberConnection(true, origin, descriptor.memberId);
    const principal = app.authenticateAgent(new Request(origin + '/api/agent', {
      headers: { authorization: 'Bearer ' + readConnection(directory, descriptor.memberId).token } }));
    const found = await app.discoverAgentResource({ url: origin + '/api/paid/plugin-snapshot?asset=SOL' }, principal);
    app.registerAgentResource({ discoveryId: found.discoveryId, resourceId: 'c-local-api', providerId: 'offline-test', displayName: 'C test API' }, principal);
    web = await startLocalAuthorization({ app, memberId: descriptor.memberId, confirmControl: async () => { controlConfirmations++; }, confirm: async () => {
      confirmationCalls++;
      if (refuse) throw new Error('LOCAL_CONFIRMATION_DECLINED');
      await new Promise<void>(done => { release = done; });
    } });
    const local = web;
    const call = (path: string, body?: unknown, token?: string, customOrigin = local.origin) => browserFetch(local.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: customOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const credential = async () => {
      const token = new URL(local.createLink()).hash.slice(1);
      const response = await call('/session', { token }); expect(response.status).toBe(200);
      expect((await call('/session', { token })).status).toBe(400);
      return z.object({ token: z.string() }).parse(await response.json()).token;
    };
    expect((await call('/state')).status).toBe(400);
    const token = await credential(), other = await credential();
    for (const path of ['/state', '/requests', '/controls/requests']) {
      const response = await browserFetch(local.origin + path, {
        method: path === '/state' ? 'GET' : 'POST',
        headers: { origin: local.origin, authorization: 'Bearer ' + token,
          'x-yosh-environment': 'mainnet', 'content-type': 'application/json' },
        ...(path === '/state' ? {} : { body: JSON.stringify({}) }),
      });
      expect(await response.json()).toEqual({ code: 'LOCAL_WEB_ENVIRONMENT_UNAVAILABLE' });
      expect(response.status).toBe(400);
    }
    expect(confirmationCalls).toBe(0);
    expect(controlConfirmations).toBe(0);

    expect((await call('/state', undefined, token, 'https://attacker.invalid')).status).toBe(400);
    expect((await call('/requests', { approved: true }, token)).status).toBe(400);
    const draft = { resourceId: 'c-local-api', total: '1.00', single: '0.20', hours: 24 };
    expect((await call('/requests', { ...draft, total: '1e3' }, token)).status).toBe(400);
    const freezeResponse = await call('/requests', draft, token);
    const frozenBody: unknown = await freezeResponse.json();
    const diagnostic = z.object({ code: z.string() }).safeParse(frozenBody);
    expect(freezeResponse.status, diagnostic.success ? diagnostic.data.code : 'freeze').toBe(201);
    const request = z.object({ request: z.object({ id: z.uuid() }), digest: z.string() }).parse(frozenBody);
    const id = request.request.id;
    expect(app.spendGrantSummary()).toBeNull();
    expect((await call('/confirm', { id }, other)).status).toBe(400);
    expect(confirmationCalls).toBe(0);
    expect((await call('/confirm', { id, approved: true }, token)).status).toBe(400);
    expect((await call('/confirm', { id }, token)).status).toBe(400);
    expect(app.spendGrantSummary()).toBeNull();
    refuse = false;
    const pending = call('/confirm', { id }, token);
    await expect.poll(() => release !== undefined).toBe(true);
    expect((await call('/confirm', { id }, token)).status).toBe(400);
    release!();
    const result = await pending; expect(result.status).toBe(200);
    const saved = z.object({ state: z.literal('CONSUMED'), grantId: z.uuid(), digest: z.string() }).parse(await result.json());
    expect(saved.digest).toBe(request.digest);
    expect(app.ledger.spendGrantById(saved.grantId)).toMatchObject({ totalLimit: '1000000', singleLimit: '200000', resourceId: draft.resourceId });
    expect((await call('/confirm', { id }, token)).status).toBe(200);
    expect(confirmationCalls).toBe(2); // one refusal, one explicitly injected success
    expect(app.memberOverview(descriptor.memberId).budget.paused).toBe(true);
    expect(app.ledger.listForAdministration()).toHaveLength(0);
    const controls = async (action: unknown) => {
      const response = await call('/controls/requests', action, token);
      expect(response.status).toBe(201);
      return z.object({ request: z.object({ id: z.uuid() }) }).parse(await response.json()).request.id;
    };
    const daily = await controls({ type: 'daily_limit', amount: '1000000' });
    expect((await call('/controls/confirm', { id: daily }, other)).status).toBe(400);
    expect(controlConfirmations).toBe(0);
    expect((await call('/controls/confirm', { id: daily, approved: true }, token)).status).toBe(400);
    expect((await call('/controls/confirm', { id: daily }, token)).status).toBe(200);
    expect((await call('/controls/confirm', { id: daily }, token)).status).toBe(200);
    expect(controlConfirmations).toBe(1);
    expect(app.ledger.controls('live_devnet')).toMatchObject({ dailyBudget: '1000000', paused: true });
    const stale = await controls({ type: 'pause', paused: false });
    app.setDailyLimit('2000000');
    expect((await call('/controls/confirm', { id: stale }, token)).status).toBe(400);
    expect(app.ledger.controls('live_devnet').paused).toBe(true);
    const cancelled = await controls({ type: 'pause', paused: false });
    expect((await call('/controls/cancel', { id: cancelled }, token)).status).toBe(200);
    expect((await call('/controls/confirm', { id: cancelled }, token)).status).toBe(400);
    const revoke = await controls({ type: 'revoke_grant', grantId: saved.grantId, resourceId: draft.resourceId });
    expect((await call('/controls/confirm', { id: revoke }, token)).status).toBe(200);
    expect(app.ledger.spendGrantById(saved.grantId)?.status).toBe('REVOKED');
    const disconnect = await controls({ type: 'connection', enabled: false });
    expect((await call('/controls/confirm', { id: disconnect }, token)).status).toBe(200);
    expect(app.memberOverview(descriptor.memberId).connection.enabled).toBe(false);
    expect((await call('/controls/confirm', { id: disconnect }, token)).status).toBe(200);
    expect(app.ledger.localControlApprovals().claimedRequests(descriptor.memberId)).toHaveLength(0);
    expect((await call('/controls/requests', { type: 'create_wallet', slot: 'mainnet' }, token)).status).toBe(400);
    const snapshot = z.object({ environment: z.literal('offline'), walletSetup: z.object({ available: z.literal(false) }),
      connection: z.object({ enabled: z.literal(false) }), purchases: z.array(z.unknown()) }).parse(await (await call('/state', undefined, token)).json());
    expect(snapshot.purchases).toHaveLength(0);
    // Even the existing management HMAC cannot bypass the C confirmation path.
    const body = JSON.stringify({ paused: false }), timestamp = String(Date.now()), nonce = randomBytes(32).toString('hex');
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const proof = createHmac('sha256', secret).update(['2049-management-v1','PUT','/api/app/settings',timestamp,nonce,bodyHash].join('\n')).digest('hex');
    const bypass = await fetch(origin + '/api/app/settings', { method: 'PUT', body, headers: { origin,
      'content-type': 'application/json', 'x-2049-timestamp': timestamp, 'x-2049-nonce': nonce, 'x-2049-body-sha256': bodyHash, 'x-2049-proof': proof } });
    expect(bypass.status).toBe(403);
    expect(app.memberOverview(descriptor.memberId).budget.paused).toBe(true);
  } finally {
    release?.(); await web?.close(); await backend?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true });
  }
}, 45_000);
