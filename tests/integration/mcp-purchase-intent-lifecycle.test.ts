import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FacilitatorClient } from '@x402/core/server';
import { Keypair } from '@solana/web3.js';
import { expect, it, vi } from 'vitest';
import { POST } from '../../src/app/api/agent/purchases/route';
import { GET } from '../../src/app/api/agent/route';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { readConnection } from '../../src/modules/mcp/connection';
import { createPaidMarketApi } from '../../src/modules/paid-market-api/paid-market-api';
import { SettlementStore } from '../../src/modules/paid-market-api/settlement-store';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { executeApprovedPayment, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import type { PaidResourceId } from '../../src/modules/resources/paid-resources';

vi.mock('@/modules/app/app-runtime', async original => ({
  ...await original<typeof import('../../src/modules/app/app-runtime')>(),
  appRuntime: () => (globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } }).__yosh?.runtime,
}));
vi.mock('@/modules/http/local-request', async () => await import('../../src/modules/http/local-request'));
vi.mock('@/modules/purchases/request-paid-resource-purchase', async () => await import('../../src/modules/purchases/request-paid-resource-purchase'));
vi.mock('../../src/modules/purchases/approved-payment', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/modules/purchases/approved-payment')>(),
  executeApprovedPayment: vi.fn(), recoverApprovedPayment: vi.fn(),
}));
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));

const buyer = Keypair.generate().publicKey.toBase58();
const merchant = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const fixedNow = Date.parse('2026-09-24T03:00:00Z');
const config: PaymentConfig = { ...resolvePaymentEnvironment({}, 'live_devnet'), cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', network: DEVNET_NETWORK,
  mint: DEVNET_USDC_MINT, buyer, merchant, facilitatorUrl: 'https://facilitator.invalid' };

function purchaseRequest(origin: string, token: string, requestId: string) {
  return fetch(`${origin}/api/agent/purchases`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, resourceId: 'market-snapshot', reason: 'Check policy without payment' }) });
}

it('separates authenticated MCP purchase intents from SpendGrant authority across creation, revoke and expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-intent-lifecycle-'));
  const store = new SettlementStore(':memory:');
  const facilitator = {
    getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2 as const, scheme: 'exact', network: config.network, extra: { feePayer } }], extensions: [], signers: {} })),
    verify: vi.fn(), settle: vi.fn(),
  } satisfies FacilitatorClient;
  const paidApi = createPaidMarketApi(config, facilitator, store);
  const quote = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    const resource = url.pathname.endsWith('/market-analysis') ? 'analysis'
      : url.pathname.endsWith('/token-risk-report') ? 'risk' : 'snapshot';
    return paidApi({ asset: url.searchParams.get('asset'), resource });
  });
  let now = fixedNow;
  const app = new AppRuntime(directory, { initializeWallet: async () => ({ address: buyer, reused: true }), now: () => now,
    timeZone: () => 'Asia/Shanghai', fetcher: quote });
  const claim = vi.spyOn(app.ledger, 'claim');
  const savePayload = vi.spyOn(app.ledger, 'savePayload');
  const state = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  const previous = state.__yosh;
  state.__yosh = { runtime: app };
  const http = createServer(async (incoming, outgoing) => {
    try {
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1:${address.port}${incoming.url ?? '/'}`, {
        method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = incoming.method === 'GET' ? await GET(request) : await POST(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '1');
  vi.stubEnv('APP2049_ENABLE_LEGACY_DEMO_TASKS', '');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', merchant);
  try {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const origin = `http://127.0.0.1:${address.port}`;
    await app.initializeWallet();
    app.setDailyLimit('5000000');
    app.setAgentConnection(true, origin);
    const first = readConnection(directory);
    expect(first.capabilities).toEqual(['read', 'request_purchase']);

    async function connect() {
      const client = new Client({ name: 'intent-lifecycle-test', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/mcp.ts')],
        cwd: tmpdir(), env: { APP2049_DATA_DIR: directory }, stderr: 'pipe' });
      await client.connect(transport);
      clients.push({ client, transport });
      return client;
    }
    async function call(client: Client, requestId: string, resourceId: PaidResourceId = 'market-snapshot') {
      const response = await client.callTool({ name: 'request_purchase', arguments: { requestId, resourceId, reason: 'Check policy without payment' } });
      expect(response.isError).not.toBe(true);
      if (!Array.isArray(response.content)) throw new Error('Missing MCP content');
      const content: unknown = response.content[0];
      if (!content || typeof content !== 'object' || !('type' in content) || content.type !== 'text'
        || !('text' in content) || typeof content.text !== 'string') throw new Error('Missing MCP text response');
      return JSON.parse(content.text) as unknown;
    }

    const initialClient = await connect();
    const quotesTool = await initialClient.callTool({ name: 'get_market_quote', arguments: {} });
    expect(quotesTool.isError).not.toBe(true);
    if (!Array.isArray(quotesTool.content)) throw new Error('Missing quote content');
    const quoteContent: unknown = quotesTool.content[0];
    if (!quoteContent || typeof quoteContent !== 'object' || !('type' in quoteContent) || quoteContent.type !== 'text' ||
      !('text' in quoteContent) || typeof quoteContent.text !== 'string') throw new Error('Missing quote text');
    const listed = JSON.parse(quoteContent.text);
    expect(listed.resources).toMatchObject([
      { resourceId: 'market-snapshot', resourceUrl: '/api/paid/sol-market-snapshot?asset=SOL', amount: '200000' },
      { resourceId: 'market-analysis', resourceUrl: '/api/paid/market-analysis?asset=SOL', amount: '20000000' },
      { resourceId: 'token-risk-report', resourceUrl: '/api/paid/token-risk-report?asset=SOL', amount: '50000' },
    ]);
    const withoutGrant = await call(initialClient, 'intent-no-grant');
    expect(withoutGrant).toMatchObject({ resourceId: listed.resources[0].resourceId, amount: listed.resources[0].amount });
    expect(withoutGrant).toMatchObject({
      status: 'DENIED', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_REQUIRED' },
      paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_DELIVERED', grant: null,
    });
    expect(withoutGrant).not.toHaveProperty('resource');
    expect(app.ledger.getOwned('intent-no-grant', first.cardMemberId)?.ownerCardMemberId).toBe(first.cardMemberId);
    expect(app.ledger.eventsForOwner('intent-no-grant', first.cardMemberId).map(event => event.type)).toEqual(['authority.DENIED']);
    expect(await call(initialClient, 'intent-risk-no-grant', 'token-risk-report')).toMatchObject({
      resourceId: 'token-risk-report', amount: '50000', status: 'DENIED',
      decision: { reason: 'SPEND_GRANT_REQUIRED' },
    });
    const quotesBeforeReplay = quote.mock.calls.length;
    expect(await call(initialClient, 'intent-no-grant')).toMatchObject({ reused: true,
      decision: { decision: 'DENIED', reason: 'SPEND_GRANT_REQUIRED' } });
    expect(quote).toHaveBeenCalledTimes(quotesBeforeReplay);

    app.createSpendGrant({ totalLimit: '5000000', singleLimit: '500000', expiresAt: now + 180_000 });
    const active = readConnection(directory);
    expect(active.capabilities).toEqual(['read', 'request_purchase']);
    expect(active.token).toBe(first.token);
    const afterGrant = await initialClient.callTool({ name: 'get_spending_status', arguments: {} });
    expect(afterGrant.isError).not.toBe(true);
    const activeClient = initialClient;
    const overLimit = await call(activeClient, 'intent-active-over-limit', 'market-analysis');
    expect(overLimit).toMatchObject({
      status: 'DENIED', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED' },
    });
    expect(overLimit).not.toHaveProperty('resource');
    expect(await call(activeClient, 'intent-active-approved')).toMatchObject({
      status: 'APPROVED', decision: { decision: 'APPROVED', reason: 'AUTHORITY_BUDGET_AND_GRANT_PASSED' },
    });
    expect(executeApprovedPayment).toHaveBeenCalledOnce();
    vi.mocked(executeApprovedPayment).mockClear();

    const beforeBudget = app.ledger.managedSummary(now, 'live_devnet');
    const beforeCommitted = app.spendGrantSummary()?.committed;
    app.revokeSpendGrant();
    const revoked = readConnection(directory);
    expect(revoked.capabilities).toEqual(['read', 'request_purchase']);
    expect(revoked.token).toBe(active.token);
    const afterRevoke = await initialClient.callTool({ name: 'get_spending_status', arguments: {} });
    expect(afterRevoke.isError).not.toBe(true);
    const revokedClient = initialClient;
    const revokedResult = await call(revokedClient, 'intent-revoked');
    expect(revokedResult).toMatchObject({
      status: 'DENIED', executionMode: 'live_devnet', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_REVOKED' },
      paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_DELIVERED', reused: false,
    });
    expect(revokedResult).not.toHaveProperty('resource');
    const denied = app.ledger.getOwned('intent-revoked', first.cardMemberId);
    expect(denied).toMatchObject({ status: 'DENIED', paymentPayloadPresent: false });
    expect(denied).not.toHaveProperty('transaction');
    expect(denied).not.toHaveProperty('data');
    expect(app.ledger.eventsForOwner('intent-revoked', first.cardMemberId).map(event => event.type)).toEqual(['authority.DENIED']);
    expect(app.ledger.managedSummary(now, 'live_devnet')).toEqual(beforeBudget);
    expect(app.spendGrantSummary()?.committed).toBe(beforeCommitted);
    expect(store.getByQuote(String(denied?.quote.extra?.memo))).toBeUndefined();

    app.createSpendGrant({ totalLimit: '5000000', singleLimit: '500000', expiresAt: now + 90_000 });
    now += 90_001;
    const expiredClient = initialClient;
    const expiredResult = await call(expiredClient, 'intent-expired');
    expect(expiredResult).toMatchObject({
      status: 'DENIED', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_EXPIRED' },
      paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_DELIVERED',
    });
    expect(expiredResult).not.toHaveProperty('resource');

    expect((await purchaseRequest(origin, 'invalid-token', 'intent-invalid-token')).status).toBe(401);
    expect(app.ledger.getOwned('intent-invalid-token', first.cardMemberId)).toBeUndefined();
    const crossOrigin = await fetch(`${origin}/api/agent/purchases`, { method: 'POST',
      headers: { authorization: `Bearer ${readConnection(directory).token}`, origin: 'https://untrusted.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'intent-cross-origin', resourceId: 'market-snapshot', reason: 'Check origin validation' }) });
    expect(crossOrigin.status).toBe(401);
    expect(app.ledger.getOwned('intent-cross-origin', first.cardMemberId)).toBeUndefined();
    const beforeDisable = readConnection(directory);
    app.setAgentConnection(false, origin);
    expect((await purchaseRequest(origin, beforeDisable.token, 'intent-disabled')).status).toBe(401);
    expect(app.ledger.getOwned('intent-disabled', first.cardMemberId)).toBeUndefined();
    app.setAgentConnection(true, origin);
    const memberToken = readConnection(directory).token;
    app.ledger.revokeCardMember(first.cardMemberId, now + 1);
    expect((await purchaseRequest(origin, memberToken, 'intent-revoked-member')).status).toBe(401);
    expect(app.ledger.getOwned('intent-revoked-member', first.cardMemberId)).toBeUndefined();

    expect(executeApprovedPayment).not.toHaveBeenCalled();
    expect(recoverApprovedPayment).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(savePayload).not.toHaveBeenCalled();
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  } finally {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    await new Promise<void>(done => http.close(() => done()));
    app.close(); store.close();
    if (previous === undefined) delete state.__yosh; else state.__yosh = previous;
    vi.unstubAllEnvs(); vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
