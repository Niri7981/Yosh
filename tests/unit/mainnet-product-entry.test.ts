import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverResource } from '../../src/modules/resources/mainnet-resource-discovery';
import { POST as registerAgentResourcePOST } from '../../src/app/api/agent/resources/route';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { createAgentServer } from '../../src/modules/mcp/server';
import { readConnection } from '../../src/modules/mcp/connection';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { FIXTURE_TRANSACTION_SIGNATURE, signedPaymentFixture } from '../helpers/signed-payment-fixture';
import { signedManagementRequest } from '../helpers/management-request';
import { POST } from '../../src/app/api/agent/purchases/route';
import { POST as sessionPOST } from '../../src/app/api/agent/session/route';
import { GET as agentGET } from '../../src/app/api/agent/route';
import { PUT as grantPUT } from '../../src/app/api/app/grant/route';
import { POST as prepareResourcePOST } from '../../src/app/api/app/resources/prepare/route';
import { POST as registerResourcePOST } from '../../src/app/api/app/resources/route';
import { PUT as settingsPUT } from '../../src/app/api/app/settings/route';
import { PUT as executionPUT } from '../../src/app/api/app/execution/route';
import type { X402Resource } from '../../src/modules/resources/http-resource';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async original => ({ ...await original<typeof import('../../src/modules/payment/solana-payment')>(), prepareSolanaPayment: vi.fn() }));
vi.mock('../../src/modules/payment/reconcile-transaction', () => ({ reconcileStoredOriginalPayment: vi.fn().mockResolvedValue({ status: 'UNKNOWN' }) }));
const context = vi.hoisted(() => ({ app: undefined as AppRuntime | undefined }));
vi.mock('../../src/modules/app/app-runtime', async original => ({ ...await original<typeof import('../../src/modules/app/app-runtime')>(), appRuntime: () => context.app! }));
const origin = 'http://127.0.0.1:3049';
const secret = 'fixture-management-secret-32-bytes';
const dirs: string[] = [];
afterEach(async () => { await context.app?.prepareQuit(); context.app?.close(); context.app = undefined; vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
async function fixture(enabled = true) {
  const signer = await generateKeyPairSigner(); const recipient = await generateKeyPairSigner(); const sponsor = await generateKeyPairSigner();
  const env = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const resource: X402Resource & { recipient: string } = { resourceId: 'production-data', providerId: 'registered-provider', network: env.network, mint: env.asset.mint,
    decimals: 6, recipient: recipient.address, amount: '10000', request: { url: 'https://provider.example/data', method: 'GET', access: 'https', headers: {} }, deliveryRecovery: { kind: 'idempotent_replay' } };
  vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet'); vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', enabled ? '1' : '');
  vi.stubEnv('YOSH_MAINNET_WALLET_PUBLIC_KEY', signer.address); vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  vi.stubEnv('X402_FACILITATOR_URL', 'https://facilitator.example'); vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  const challenge = { x402Version: 2 as const, resource: { url: resource.request.url }, accepts: [{ scheme: 'exact', network: env.network, asset: env.asset.mint,
    amount: '10000', payTo: recipient.address, maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address } }] };
  const quoteFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } }));
  const dir = mkdtempSync(join(tmpdir(), 'yosh-mainnet-entry-')); dirs.push(dir);
  const app = new AppRuntime(dir, { initializeWallet: async () => ({ address: signer.address, reused: true }), fetcher: quoteFetch }); context.app = app;
  await app.initializeWallet(); app.setAgentConnection(true, origin);
  const manage = async (path: string, body: object) => (path === 'grant' ? grantPUT : settingsPUT)(signedManagementRequest(`${origin}/api/app/${path}`, secret, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }));
  const grant = async () => expect((await manage('grant', { action: 'create', resourceId: resource.resourceId, totalLimit: '100000', singleLimit: '10000', expiresAt: Date.now() + 3600000 })).status).toBe(200);
  const daily = async () => { expect((await manage('settings', { dailyLimit: '100000' })).status).toBe(200); expect((await manage('settings', { paused: false })).status).toBe(200); };
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(prepareSolanaPayment).mockImplementation(async (config, _signer, quote, guard, authorized) => { guard?.(); return { ...await signedPaymentFixture(signer, config, quote), resource: authorized?.challenge?.resource }; });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fixture submission unknown')));
  const call = async (id = 'purchase', token = readConnection(dir).token, extra = {}) => POST(new Request(`${origin}/api/agent/purchases`, { method: 'POST', headers: { host: '127.0.0.1:3049', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, resourceId: resource.resourceId, reason: 'fixture', ...extra }) }));
  return { app, dir, grant, daily, call, quoteFetch, resource, signer };
}
it('Agent-created resources appear in both read models but cannot spend without a resource Grant', async () => {
  const f = await fixture(); await f.daily();
  const descriptor = readConnection(f.dir);
  const principal = f.app.authenticateAgent(new Request(`${origin}/api/agent`, { headers: { authorization: `Bearer ${descriptor.token}` } }));
  const input = { url: 'https://generic.example/price', requestInputs: { query: { coins: { type: 'string', required: true } } }, sample: { query: { coins: 'SOL' } } };
  const read = vi.fn(async (url: string) => new Headers({ 'payment-required': encodePaymentRequiredHeader({ x402Version: 2,
    resource: { url }, accepts: [{ scheme: 'exact', network: f.resource.network, asset: f.resource.mint,
      amount: '10000', payTo: f.resource.recipient, maxTimeoutSeconds: 300, extra: { feePayer: f.signer.address } }] }) }));
  const discovered = f.app.ledger.resources.recordDiscovery(await discoverResource(input, read), principal);
  const response = await registerAgentResourcePOST(new Request(`${origin}/api/agent/resources`, { method: 'POST',
    headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discoveryId: discovered.discoveryId, resourceId: 'agent-generic-price', providerId: 'generic.example', displayName: 'Generic price' }) }));
  expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ registrationStatus: 'REGISTERED', spendingAuthorityCreated: false });
  expect(f.app.listRegisteredResources().find(item => item.resourceId === 'agent-generic-price')).toMatchObject({ source: 'agent', submission: { sample: input.sample } });
  expect(f.app.registeredResources().find(item => item.resourceId === 'agent-generic-price')).toMatchObject({ source: 'agent', submission: { sample: input.sample } });
  expect(f.app.ledger.spendGrantSummary(Date.now(), 'live_mainnet', principal.cardMemberId, 'agent-generic-price')).toBeNull();
  expect(f.app.ledger.listForAdministration()).toHaveLength(0);
  f.quoteFetch.mockImplementation(async (url) => new Response(null, { status: 402, headers: await read(String(url)) }));
  const denied = await f.call('agent-without-grant', descriptor.token, { resourceId: 'agent-generic-price', request: input.sample });
  expect(denied.status).toBe(200);
  expect(await denied.json()).toMatchObject({ status: 'DENIED', grant: null, decision: { reason: 'SPEND_GRANT_REQUIRED' }, paymentStatus: 'NOT_STARTED' });
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it('real App management and MCP tool reach the shared Mainnet signing boundary; replay preserves original payment', async () => {
  const f = await fixture(); await f.daily(); await f.grant();
  const server = createAgentServer(async () => f.app.overview(), async input => { const response = await f.call(input.requestId); if (!response.ok) throw new Error(); return response.json(); });
  const client = new Client({ name: 'fixture-host', version: '1' }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport);
    const input = { requestId: 'mcp-mainnet', resourceId: f.resource.resourceId, reason: 'fixture' };
    const first = await client.callTool({ name: 'request_purchase', arguments: input }); expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first)).toContain('PAYMENT_UNKNOWN'); expect(JSON.stringify(first)).not.toMatch(/buyerSignature|PAYMENT-SIGNATURE|transactionBase64/);
    await client.callTool({ name: 'request_purchase', arguments: input });
    expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(f.quoteFetch).toHaveBeenCalledOnce(); expect(f.app.ledger.listForAdministration()).toHaveLength(1);
    expect((await f.app.overview()).service).toMatchObject({ network: 'Solana Mainnet', testEnvironment: false });
  } finally { await client.close(); await server.close(); }
});
it('authenticated product control enables Mainnet persistently without creating authority or entering payment', async () => {
  const f = await fixture(false);
  expect(f.app.execution()).toMatchObject({ productionExecutionEnabled: false, spendingAuthorized: false });
  const request = signedManagementRequest(`${origin}/api/app/execution`, secret, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ productionExecutionEnabled: true }) });
  const response = await executionPUT(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ productionExecutionEnabled: true, spendingAuthorized: false });
  expect(JSON.parse(readFileSync(join(f.dir, 'product-configuration.json'), 'utf8'))).toEqual({ YOSH_ENABLE_MAINNET_EXECUTION: '1' });
  expect(f.app.ledger.spendGrantSummary(Date.now(), 'live_mainnet', f.app.ledger.defaultCardMember().id)).toBeNull();
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it('quote readiness reports a balance blocker independently of active resource and grant', async () => {
  const f = await fixture(); await f.daily(); await f.grant();
  const preview = await f.app.quotePaidResources(origin);
  expect(preview.resources[0]).toMatchObject({ resourceId: f.resource.resourceId,
    quoteStatus: 'available', preflight: { ready: false, code: 'USDC_BALANCE_UNVERIFIED' } });
  expect(f.app.authority().readiness).toMatchObject({ resourceRegistration: { ready: true },
    spendGrantAuthorization: { ready: true } });
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it('You.com search requires a bounded query and binds it to the exact paid request', async () => {
  const f = await fixture();
  const missing = await f.call('you-missing', undefined, { resourceId: 'you-web-search' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: 'RESOURCE_REQUEST_INPUT_REQUIRED' });
  expect(f.quoteFetch).not.toHaveBeenCalled();
  const queryURL = 'https://api.you.com/v1/search?query=Solana+payments';
  const env = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  f.quoteFetch.mockResolvedValueOnce(new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
    x402Version: 2, resource: { url: queryURL }, accepts: [{ scheme: 'exact', network: env.network,
      asset: env.asset.mint, amount: '5000', payTo: f.resource.recipient,
      maxTimeoutSeconds: 300, extra: { feePayer: f.signer.address } }],
  }) } }));
  const quoted = await f.call('you-query', undefined, { resourceId: 'you-web-search', query: 'Solana payments' });
  expect(quoted.status).toBe(200);
  expect(await quoted.json()).toMatchObject({ status: 'DENIED', quote: { resourceUrl: queryURL } });
  expect(f.quoteFetch.mock.calls[0][0]).toBe(queryURL);
  const changed = await f.call('you-query', undefined, { resourceId: 'you-web-search', query: 'different search' });
  expect(changed.status).toBe(409);
  expect(f.quoteFetch).toHaveBeenCalledOnce();
  expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it('registers an unknown JSON POST through management and creates a sample-bound Grant without a rebuild or payment', async () => {
  const f = await fixture(); await f.daily();
  const env = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const endpoint = 'https://new-synthetic-merchant.example/v1/analyze';
  const definition = { resourceId: 'new-json-merchant', providerId: 'synthetic.example', displayName: 'New JSON Merchant',
    request: { url: endpoint, method: 'POST', access: 'https', headers: { 'content-type': 'application/json' } },
    requestInputs: { jsonBody: { prompt: { type: 'string', required: true, maxLength: 300 } } }, network: env.network, mint: env.asset.mint, decimals: 6,
    recipientSource: 'live_challenge', maximumAmount: '10000', deliveryRecovery: { kind: 'none' },
    deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 32768 } };
  const registration = await registerResourcePOST(signedManagementRequest(`${origin}/api/app/resources`, secret, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(definition) }));
  expect(registration.status).toBe(201);
  f.quoteFetch.mockImplementation(async () => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
    x402Version: 2, resource: { url: endpoint }, accepts: [{ scheme: 'exact', network: env.network,
      asset: env.asset.mint, amount: '5000', payTo: f.resource.recipient, maxTimeoutSeconds: 300,
      extra: { feePayer: f.signer.address } }] }) } }));
  const grantInput = { action: 'create', resourceId: definition.resourceId, sample: { jsonBody: { prompt: 'sample' } },
    totalLimit: '20000', singleLimit: '10000', expiresAt: Date.now() + 3600000 };
  const rejected = await grantPUT(signedManagementRequest(`${origin}/api/app/grant`, secret, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(grantInput) }));
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ code: 'RESOURCE_POST_APPROVAL_REQUIRED' });
  await expect(f.app.quoteRegisteredResource(definition.resourceId, { jsonBody: { prompt: 'sample' } }, f.app.ledger.defaultCardMember().id))
    .rejects.toThrow('RESOURCE_POST_APPROVAL_REQUIRED');
  expect(f.quoteFetch).not.toHaveBeenCalled();
  const reviewResponse = await prepareResourcePOST(signedManagementRequest(`${origin}/api/app/resources/prepare`, secret, { method: 'POST',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ kind: 'grant', resourceId: definition.resourceId, sample: grantInput.sample }) }));
  expect(reviewResponse.status).toBe(200);
  const review = await reviewResponse.json();
  const changed = await grantPUT(signedManagementRequest(`${origin}/api/app/grant`, secret, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ ...grantInput,
      sample: { jsonBody: { prompt: 'changed' } }, postApprovalHash: review.requestHash }) }));
  expect(changed.status).toBe(409); expect(f.quoteFetch).not.toHaveBeenCalled();
  const grant = await grantPUT(signedManagementRequest(`${origin}/api/app/grant`, secret, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ action: 'create', resourceId: definition.resourceId, postApprovalHash: review.requestHash,
      sample: { jsonBody: { prompt: 'sample' } }, totalLimit: '20000', singleLimit: '10000', expiresAt: Date.now() + 3600000 }) }));
  expect(grant.status).toBe(200);
  expect(f.app.ledger.spendGrantSummary(Date.now(), 'live_mainnet', f.app.ledger.defaultCardMember().id, definition.resourceId)?.status).toBe('ACTIVE');
  const quote = await f.app.quoteRegisteredResource(definition.resourceId, { jsonBody: { prompt: 'actual request' } }, f.app.ledger.defaultCardMember().id);
  expect(quote).toMatchObject({ resourceId: definition.resourceId, amount: '5000', paymentSent: false });
  expect(f.quoteFetch.mock.calls.map(call => (call[1] as RequestInit).body)).toEqual(['{"prompt":"sample"}', '{"prompt":"actual request"}']);
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it.each(['unauthorized', 'daily', 'grant', 'paused', 'disabled', 'extra', 'debug'] as const)('product Mainnet gate rejects %s without signing', async condition => {
  const f = await fixture(condition !== 'disabled');
  if (condition !== 'daily') await f.daily(); else f.app.setPaused(false);
  if (condition !== 'grant') await f.grant();
  if (condition === 'paused') f.app.setPaused(true);
  if (condition === 'debug') {
    const start = vi.spyOn(f.app, 'start'); const wallet = vi.spyOn(f.app, 'initializeWallet');
    await expect(f.app.createTestPurchase('debug', origin)).rejects.toThrow('TEST_PURCHASE_UNAVAILABLE');
    expect(start).not.toHaveBeenCalled(); expect(wallet).not.toHaveBeenCalled();
  }
  else {
    const response = await f.call('denied', condition === 'unauthorized' ? 'invalid-token' : undefined, condition === 'extra' ? { amount: '1', network: 'solana:devnet', approved: true } : {});
    if (condition === 'unauthorized') expect(response.status).toBe(401);
    else if (condition === 'disabled' || condition === 'extra') expect(response.status).toBe(400);
    else expect(await response.json()).toMatchObject({ status: 'DENIED', decision: { reason: condition === 'daily' ? 'DAILY_LIMIT_NOT_SET' : condition === 'grant' ? 'SPEND_GRANT_REQUIRED' : 'PAYMENTS_PAUSED' } });
  }
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('the shipped stdio MCP bridge uses a registered member capability and the production HTTP handler for Mainnet', async () => {
  const f = await fixture(); await f.daily();
  const http = createServer(async (incoming, outgoing) => {
    try {
      const address = http.address(); if (!address || typeof address === 'string') throw new Error();
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1:${address.port}${incoming.url}`, { method: incoming.method, headers, ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks) }) });
      const response = incoming.method === 'GET' ? await agentGET(request) : incoming.url === '/api/agent/session' ? await sessionPOST(request) : await POST(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  const client = new Client({ name: 'stdio-fixture-host', version: '1' });
  try {
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); if (!address || typeof address === 'string') throw new Error();
    f.app.setAgentConnection(true, `http://127.0.0.1:${address.port}`); await f.grant();
    f.app.agentConnection.setIntegration(true, 'codex-fixture');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/mcp.ts')],
      cwd: tmpdir(), env: { YOSH_DATA_DIR: f.dir, YOSH_CARD_MEMBER_ID: f.app.ledger.defaultCardMember().id, YOSH_MCP_PROVIDER: 'codex' }, stderr: 'pipe' });
    await client.connect(transport);
    await vi.waitFor(() => expect(f.app.agentConnection.status().integration?.connected).toBe(true));
    const quotes = await client.callTool({ name: 'get_market_quote', arguments: {} });
    expect(quotes.isError).not.toBe(true); expect(JSON.stringify(quotes)).toContain(f.resource.resourceId);
    f.quoteFetch.mockClear();
    const args = { requestId: 'stdio-mainnet', resourceId: f.resource.resourceId, reason: 'fixture' };
    const injected = await client.callTool({ name: 'request_purchase', arguments: { ...args, amount: '1', network: 'solana:devnet' } });
    expect(injected.isError).toBe(true); expect(prepareSolanaPayment).not.toHaveBeenCalled();
    const first = await client.callTool({ name: 'request_purchase', arguments: args });
    expect(first.isError).not.toBe(true); expect(JSON.stringify(first)).toContain('PAYMENT_UNKNOWN');
    await client.callTool({ name: 'request_purchase', arguments: args });
    expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(f.app.ledger.listForAdministration()).toHaveLength(1);
    f.app.revokeSpendGrant();
    const stale = await client.callTool({ name: 'request_purchase', arguments: { ...args, requestId: 'stale' } });
    expect(stale.isError).not.toBe(true);
    expect(JSON.stringify(stale)).toContain('SPEND_GRANT_REVOKED');
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    expect(f.app.agentConnection.status().integration).toMatchObject({ connected: true, state: 'connected' });
  } finally { await client.close(); http.closeAllConnections(); await new Promise<void>(resolveClose => http.close(() => resolveClose())); }
});

it('Mainnet original-payment recovery survives backend restart with production disabled and authority revoked', async () => {
  const f = await fixture(); await f.daily(); await f.grant();
  expect(await (await f.call('restart-original')).json()).toMatchObject({ paymentStatus: 'PAYMENT_UNKNOWN' });
  const before = f.app.ledger.getOwned('restart-original', f.app.ledger.defaultCardMember().id)!;
  const evidence = f.app.ledger.savedOriginalPayment(before.approvalId)!;
  f.app.setPaused(true); await f.app.prepareQuit(); f.app.close(); context.app = undefined;
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '');
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([{ ...f.resource, resourceId: 'replacement-resource', request: { ...f.resource.request, url: 'https://provider.example/replacement' } }]));
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE, confirmationStatus: 'confirmed' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: 'original delivery' })));
  const restarted = new AppRuntime(f.dir, { initializeWallet: async () => ({ address: evidence.evidence.identity.payer, reused: true }), fetcher: f.quoteFetch }); context.app = restarted;
  await restarted.start(origin); await restarted.initializeWallet(); restarted.setAgentConnection(true, origin);
  const response = await f.call('restart-original'); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ paymentStatus: 'PAID', resource: { data: 'original delivery' }, reused: true });
  expect(restarted.ledger.controls('live_mainnet').paused).toBe(true);
  expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce(); expect(f.quoteFetch).toHaveBeenCalledOnce();
});
it('test authority and unregistered resources cannot enter the product Mainnet signer', async () => {
  const f = await fixture(); await f.daily();
  const principal = f.app.agentConnection.principal('request_purchase')!;
  const testEnv = resolvePaymentEnvironment({}, 'live_devnet');
  f.app.ledger.setDailyLimit('100000', 'live_devnet'); f.app.ledger.setPaused(false, 'live_devnet');
  f.app.ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: Date.now() + 3600000 }, principal,
    { resourceId: f.resource.resourceId, providerId: f.resource.providerId, operation: 'paid.resource.purchase', network: testEnv.network,
      assetId: testEnv.asset.mint, assetDecimals: 6, payTo: f.resource.recipient, paymentScheme: 'exact' }, Date.now(), 'live_devnet');
  expect(await (await f.call('test-authority')).json()).toMatchObject({ status: 'DENIED', decision: { reason: 'SPEND_GRANT_REQUIRED' } });
  expect((await f.call('unregistered', undefined, { resourceId: 'unregistered' })).status).toBe(400);
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('concurrent product requests share one original payment and reject changed intent under the same ID', async () => {
  const f = await fixture(); await f.daily(); await f.grant();
  const responses = await Promise.all([f.call('concurrent'), f.call('concurrent')]);
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(f.app.ledger.listForAdministration()).toHaveLength(1); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  expect(f.app.ledger.managedSummary(Date.now(), 'live_mainnet').reserved).toBe('10000');
  expect((await f.call('concurrent', undefined, { reason: 'changed purpose' })).status).toBe(409);
  expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('a revoked registered member capability rejects before quoting or signing', async () => {
  const f = await fixture(); await f.daily();
  const member = f.app.createCardMember('Fixture research member');
  f.app.setAgentConnection(true, origin, member.member.id);
  f.app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '100000', singleLimit: '10000', expiresAt: Date.now() + 3600000 }, member.member.id);
  const token = readConnection(f.dir, member.member.id).token;
  f.app.revokeCardMember(member.member.id);
  expect((await f.call('revoked-member', token)).status).toBe(401);
  expect(f.quoteFetch).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('Mainnet balance reads verify network identity and never supply spending authority', async () => {
  const f = await fixture(false); const overview = await f.app.overview(); const env = resolvePaymentEnvironment();
  const rpc = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: env.genesisHash })).mockResolvedValueOnce(Response.json({ result: { value: {
    owner: env.asset.tokenProgram, data: { parsed: { info: { owner: overview.wallet.address, mint: env.asset.mint, tokenAmount: { amount: '1999999', decimals: 6 } } } }
  } } }));
  expect(await f.app.balance(overview.wallet.address, rpc)).toMatchObject({ display: '2.00 USDC', available: true });
  rpc.mockResolvedValueOnce(Response.json({ result: 'wrong-network' }));
  expect(await f.app.balance(overview.wallet.address, rpc)).toMatchObject({ available: false });
  expect(f.app.ledger.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
  expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('lists production registration while paused and disabled, even when live quote discovery fails', async () => {
  const f = await fixture(false);
  f.app.setPaused(true);
  f.quoteFetch.mockRejectedValue(new Error('fixture upstream unavailable'));
  const before = await f.app.overview();
  const response = await agentGET(new Request(`${origin}/api/agent?operation=quote`, { headers: { authorization: `Bearer ${readConnection(f.dir).token}` } }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.registeredResources).toEqual(before.service.registeredResources);
  expect(result.resources[0]).toMatchObject({ resourceId: f.resource.resourceId, quoteStatus: 'unavailable', code: 'RESOURCE_QUOTE_UNAVAILABLE' });
  expect(f.app.spendGrantSummary()).toBeNull();
  expect(f.app.ledger.listForAdministration()).toHaveLength(0);
  expect((await f.app.overview()).budget.paused).toBe(true);
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

function challengeBoundRegistration(f: Awaited<ReturnType<typeof fixture>>) {
  const { recipient, amount, ...resource } = f.resource;
  expect(recipient).toBeDefined(); expect(amount).toBe('10000');
  const declared = { ...resource, displayName: 'You.com Web Search', recipientSource: 'live_challenge', baseAmount: '5000', maximumAmount: '5000' };
  declared.resourceId = 'runtime-data';
  f.resource.resourceId = declared.resourceId;
  f.app.addRegisteredResource(declared);
  return declared;
}
function readOnlyChallenge(f: Awaited<ReturnType<typeof fixture>>, payTo = f.resource.recipient, timeout = 600) {
  return new Response(null, { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({
    x402Version: 2, resource: { url: f.resource.request.url }, accepts: [
      { scheme: 'exact', network: 'eip155:8453', asset: 'other-asset', amount: '5000', payTo: 'other-payee', maxTimeoutSeconds: 600, extra: {} },
      { scheme: 'exact', network: f.resource.network, asset: f.resource.mint, amount: '5000', payTo, maxTimeoutSeconds: timeout,
        extra: { feePayer: 'ComputeBudget111111111111111111111111111111' } },
    ],
  }) } });
}
it('only an explicit management request creates a challenge-bound Mainnet grant, without enabling payments', async () => {
  const f = await fixture(false); challengeBoundRegistration(f); vi.stubEnv('X402_FACILITATOR_URL', undefined);
  f.quoteFetch.mockImplementation(async () => readOnlyChallenge(f));
  const overview = await f.app.overview();
  expect(overview.service.registeredResources.find(r => r.resourceId === 'runtime-data')).toMatchObject({ name: 'You.com Web Search', recipient: null, method: 'GET', maximumAmount: '5000' });
  expect(f.app.spendGrantSummary()).toBeNull(); expect(f.quoteFetch).not.toHaveBeenCalled();
  const create = () => f.app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '10000', singleLimit: '5000', expiresAt: Date.now() + 3600000 });
  await create();
  expect(f.app.spendGrantSummary()).toMatchObject({ totalLimit: '10000', singleLimit: '5000', payTo: f.resource.recipient, status: 'ACTIVE' });
  expect(f.app.execution().productionExecutionEnabled).toBe(false); expect((await f.app.overview()).budget.paused).toBe(true);
  expect(f.app.ledger.listForAdministration()).toHaveLength(0); expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});
it('a failed challenge cannot create a grant or rotate the member credential', async () => {
  const f = await fixture(false); challengeBoundRegistration(f);
  const connection = readConnection(f.dir); f.quoteFetch.mockRejectedValue(new Error('upstream details must not be returned'));
  const response = await grantPUT(signedManagementRequest(`${origin}/api/app/grant`, secret, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ action: 'create', resourceId: f.resource.resourceId,
      totalLimit: '10000', singleLimit: '5000', expiresAt: Date.now() + 3600000 }) }));
  expect(response.status).toBe(500); expect(await response.text()).not.toContain('upstream details');
  expect(readConnection(f.dir)).toEqual(connection); expect(f.app.spendGrantSummary()).toBeNull();
  expect(f.app.ledger.listForAdministration()).toHaveLength(0); expect(loadBuyerSigner).not.toHaveBeenCalled();
});
it('revoking the connection during challenge discovery prevents the pending Grant from being created', async () => {
  const f = await fixture(false); challengeBoundRegistration(f);
  let resolve!: (response: Response) => void;
  f.quoteFetch.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  const creating = f.app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '10000', singleLimit: '5000', expiresAt: Date.now() + 3600000 });
  await vi.waitFor(() => expect(f.quoteFetch).toHaveBeenCalledOnce());
  f.app.setAgentConnection(false, origin); resolve(readOnlyChallenge(f));
  await expect(creating).rejects.toThrow('GRANT_CONNECTION_CHANGED');
  expect(f.app.spendGrantSummary()).toBeNull(); expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('runtime registration immediately enters the App selector and cannot be performed by an Agent', async () => {
  const f = await fixture(false); const before = f.app.registeredResources().length;
  const { POST: add, GET: list } = await import('../../src/app/api/app/resources/route');
  const definition = { ...f.resource, resourceId: 'managed-runtime', recipient: undefined, amount: undefined, displayName: 'User runtime API',
    recipientSource: 'live_challenge', maximumAmount: '10000' };
  const bearer = new Request(`${origin}/api/app/resources`, { method: 'POST', headers: { host: '127.0.0.1:3049', origin, authorization: `Bearer ${readConnection(f.dir).token}`, 'content-type': 'application/json' }, body: JSON.stringify(definition) });
  expect((await add(bearer)).status).toBe(401); expect(f.app.registeredResources()).toHaveLength(before);
  const response = await add(signedManagementRequest(`${origin}/api/app/resources`, secret, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(definition) }));
  expect(response.status).toBe(201);
  expect((await f.app.overview()).service.registeredResources.some(r => r.resourceId === 'managed-runtime')).toBe(true);
  expect((await list(signedManagementRequest(`${origin}/api/app/resources`, secret))).status).toBe(200);
  expect(f.app.spendGrantSummary()).toBeNull(); expect(f.app.execution().productionExecutionEnabled).toBe(false);
  expect((await f.app.overview()).budget.paused).toBe(true); expect(loadBuyerSigner).not.toHaveBeenCalled();
  f.app.disableRegisteredResource('managed-runtime', 'DISABLED');
  expect(() => f.app.createSpendGrant({ resourceId: 'managed-runtime', totalLimit: '10000', singleLimit: '5000', expiresAt: Date.now() + 3600000 })).toThrow('MAINNET_REGISTERED_RESOURCE_REQUIRED');
});
it('disabling a resource while its Grant challenge is in flight fails closed', async () => {
  const f = await fixture(false); challengeBoundRegistration(f);
  let resolve!: (response: Response) => void;
  f.quoteFetch.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  const creating = f.app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '10000', singleLimit: '5000', expiresAt: Date.now() + 3600000 });
  await vi.waitFor(() => expect(f.quoteFetch).toHaveBeenCalledOnce()); f.app.disableRegisteredResource(f.resource.resourceId, 'REMOVED');
  resolve(readOnlyChallenge(f)); await expect(creating).rejects.toThrow('RESOURCE_REGISTRATION_CHANGED');
  expect(f.app.spendGrantSummary()).toBeNull(); expect(loadBuyerSigner).not.toHaveBeenCalled();
});
it('removing a user resource keeps real ledger records and Grants intact and blocks later signing', async () => {
  const f = await fixture(); challengeBoundRegistration(f); f.quoteFetch.mockImplementation(async () => readOnlyChallenge(f, f.resource.recipient, 300));
  await f.daily(); await f.grant(); expect(await (await f.call('historical-runtime')).json()).toMatchObject({ paymentStatus: 'PAYMENT_UNKNOWN' });
  const member = f.app.ledger.defaultCardMember().id;
  const purchase = f.app.ledger.getOwned('historical-runtime', member); const grant = f.app.spendGrantSummary();
  f.app.disableRegisteredResource(f.resource.resourceId, 'REMOVED');
  expect(f.app.ledger.getOwned('historical-runtime', member)).toEqual(purchase); expect(f.app.spendGrantSummary()).toEqual(grant);
  expect((await f.call('after-removal')).status).toBe(400); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('resource disable between quote and signing aborts before producing a payment', async () => {
  const f = await fixture(); challengeBoundRegistration(f); f.quoteFetch.mockImplementation(async () => readOnlyChallenge(f, f.resource.recipient, 300));
  await f.daily(); await f.grant();
  let resume!: () => void; const signed = vi.fn();
  vi.mocked(prepareSolanaPayment).mockImplementation(async (config, _signer, quote, guard, approved) => {
    await new Promise<void>(done => { resume = done; }); guard?.(); signed();
    return { ...await signedPaymentFixture(f.signer, config, quote), resource: approved?.challenge?.resource };
  });
  const requesting = f.call('disable-before-sign');
  await vi.waitFor(() => expect(prepareSolanaPayment).toHaveBeenCalledOnce());
  f.app.disableRegisteredResource(f.resource.resourceId, 'DISABLED'); resume(); await requesting;
  expect(signed).not.toHaveBeenCalled();
  const record = f.app.ledger.getOwned('disable-before-sign', f.app.ledger.defaultCardMember().id)!;
  expect(record.status).toBe('FAILED'); expect(record.transaction).toBeUndefined(); expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toBeUndefined();
});
it('runtime resource selection survives an App backend restart and ignores later installation configuration', async () => {
  const f = await fixture(false); challengeBoundRegistration(f);
  const id = f.resource.resourceId; const before = f.app.inspectRegisteredResource(id);
  await f.app.prepareQuit(); f.app.close(); context.app = undefined;
  vi.stubEnv('YOSH_MAINNET_RESOURCES', undefined);
  const restarted = new AppRuntime(f.dir, { initializeWallet: async () => ({ address: '11111111111111111111111111111111', reused: true }) }); context.app = restarted;
  expect(restarted.inspectRegisteredResource(id)).toEqual(before);
  expect((await restarted.overview()).service.registeredResources.some(resource => resource.resourceId === id)).toBe(true);
  expect(restarted.spendGrantSummary()).toBeNull(); expect(restarted.ledger.listForAdministration()).toHaveLength(0);
});
