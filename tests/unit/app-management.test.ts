import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { requireManagementRequest } from '../../src/modules/app/management-auth';
import { signedManagementRequest } from '../helpers/management-request';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { hash } from '../../src/modules/purchases/spending-policy';
import { paymentBinding, paymentEndpoint, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { demoSnapshot } from '../../src/modules/paid-market-api/paid-market-api';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { legacyDemoTasksAllowed } from '../../src/modules/app/product-mode';
import { readConnection } from '../../src/modules/mcp/connection';

vi.mock('../../src/modules/purchases/approved-payment', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/modules/purchases/approved-payment')>();
  return { ...original, recoverApprovedPayment: vi.fn() };
});

const address = 'BSEDrH4umjwCKUL5TqYm69ffsSjwWcV2BXQkczVp1F52';
const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); delete process.env.APP2049_MANAGEMENT_TOKEN; delete process.env.APP2049_ENABLE_DEVNET_PURCHASES; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function runtime(timeZone = 'America/Los_Angeles', now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-')); dirs.push(dir);
  return new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }),
    readWallets: async () => [{ id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' },
      { id: 'devnet', label: 'Devnet · Test', address, status: 'available' }], timeZone: () => timeZone, now });
}
const origin = 'http://127.0.0.1:3049';
async function authorize(app: AppRuntime, now = Date.now(), totalLimit = '1000000') {
  app.setAgentConnection(true, origin);
  const grant = await app.createSpendGrant({ totalLimit, singleLimit: totalLimit, expiresAt: now + 24 * 60 * 60 * 1000 });
  const principal = app.agentConnection.principal('request_purchase');
  if (!principal) throw new Error('test connection was not authorized');
  return { grant, principal, authority: app.ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now) };
}

describe('authenticated local management boundary', () => {
  it('rejects missing, wrong, and cross-site credentials', () => {
    process.env.APP2049_MANAGEMENT_TOKEN = 'a'.repeat(32);
    const request = (authorization?: string, site?: string) => new Request('http://127.0.0.1:3049/api/app/overview', { headers: { host: '127.0.0.1:3049', ...(authorization ? { authorization } : {}), ...(site ? { 'sec-fetch-site': site } : {}) } });
    expect(() => requireManagementRequest(request())).toThrow('UNAUTHORIZED');
    expect(() => requireManagementRequest(request(`Bearer ${'b'.repeat(32)}`))).toThrow('UNAUTHORIZED');
    expect(() => requireManagementRequest(request(`Bearer ${'a'.repeat(32)}`, 'cross-site'))).toThrow('跨站');
    expect(() => requireManagementRequest(request(`Bearer ${'a'.repeat(32)}`))).toThrow('UNAUTHORIZED');
    expect(() => requireManagementRequest(signedManagementRequest(`${origin}/api/app/overview`, 'a'.repeat(32)))).not.toThrow();
  });
  it('keeps legacy demo tasks closed unless explicitly enabled in development or tests', () => {
    expect(legacyDemoTasksAllowed({})).toBe(false);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'test', APP2049_MANAGEMENT_TOKEN: 'product-token' })).toBe(false);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'development', APP2049_ENABLE_LEGACY_DEMO_TASKS: '1' })).toBe(true);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'test', APP2049_ENABLE_LEGACY_DEMO_TASKS: '1' })).toBe(true);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'production', APP2049_ENABLE_LEGACY_DEMO_TASKS: '1' })).toBe(false);
  });
});

describe('fresh product startup', () => {
  it('does not create a wallet as a side effect of reading the initial overview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-fresh-overview-')); dirs.push(dir);
    const initializeWallet = vi.fn(async () => ({ address, reused: false }));
    const app = new AppRuntime(dir, { initializeWallet, readWallets: async () => [
      { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' },
      { id: 'devnet', label: 'Devnet · Test', address: null, status: 'missing' },
    ] });
    try {
      const overview = await app.overview();
      expect(overview.service.purchaseMode).toBe('simulated');
      expect(overview.wallet).toEqual({ address: '', reused: false });
      expect(initializeWallet).not.toHaveBeenCalled();
    } finally { app.close(); }
  });
});

describe('managed budget and Devnet test records', () => {
  it('rejects Mainnet authority changes before rotating a connection or using the test recipient default', async () => {
    const now = Date.now();
    const app = runtime('Asia/Shanghai', () => now);
    try {
      app.setDailyLimit('1000000');
      const { grant, principal } = await authorize(app, now);
      vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
      expect(() => app.createSpendGrant({ totalLimit: '1000000', singleLimit: '100000', expiresAt: now + 3600_000 })).toThrow('Restart Yosh');
      expect(() => app.setDailyLimit('2000000')).toThrow('Restart Yosh');
      expect(() => app.setPaused(false)).toThrow('Restart Yosh');
      expect(app.ledger.spendGrantSummary(now, 'live_mainnet')).toBeNull();
      vi.unstubAllEnvs();
      expect(app.agentConnection.principal('request_purchase')).toEqual(principal);
      expect(app.ledger.spendGrantSummary(now)?.id).toBe(grant.id);
      expect(app.ledger.controls()).toMatchObject({ dailyBudget: '1000000' });
    } finally { app.close(); }
  });

  it('rejects a pending test wallet result when the environment switches before it resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-wallet-switch-')); dirs.push(dir);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const app = new AppRuntime(dir, { initializeWallet: async () => { await pending; return { address, reused: true }; } });
    try {
      const initializing = app.initializeWallet();
      vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
      release();
      await expect(initializing).rejects.toThrow('Restart Yosh');
      vi.unstubAllEnvs();
      expect(await app.initializeWallet()).toEqual({ address, reused: true });
    } finally { release(); app.close(); }
  });

  it('keeps overview read-only while explicit wallet initialization is shared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-wallet-cache-')); dirs.push(dir);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const initializeWallet = vi.fn(async () => { await pending; return { address, reused: true }; });
    const app = new AppRuntime(dir, { initializeWallet, readWallets: async () => [
      { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' },
      { id: 'devnet', label: 'Devnet · Test', address, status: 'available' },
    ] });
    try {
      await Promise.all([app.start(origin), app.start(origin)]);
      expect(initializeWallet).not.toHaveBeenCalled(); // Health with no recovery has no Keychain work.
      const first = app.overview(); const second = app.overview();
      expect((await first).wallet).toEqual({ address, reused: true });
      expect((await second).wallet).toEqual({ address, reused: true });
      const wallet = app.initializeWallet();
      expect(initializeWallet).toHaveBeenCalledTimes(1);
      release();
      expect(await wallet).toEqual({ address, reused: true });
      await app.overview(); await app.initializeWallet(); await app.start(origin);
      expect(initializeWallet).toHaveBeenCalledTimes(1);
    } finally { release(); app.close(); }
  });

  it('retries a denied wallet read without creating a replacement wallet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-wallet-denied-')); dirs.push(dir);
    const initializeWallet = vi.fn<() => Promise<{ address: string; reused: boolean }>>()
      .mockRejectedValueOnce(new Error('Keychain access denied')).mockResolvedValue({ address, reused: true });
    const app = new AppRuntime(dir, { initializeWallet, readWallets: async () => [
      { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' },
      { id: 'devnet', label: 'Devnet · Test', address: null, status: 'missing' },
    ] });
    try {
      await expect(app.initializeWallet()).rejects.toThrow('Keychain access denied');
      expect(await app.initializeWallet()).toEqual({ address, reused: true });
      await app.overview();
      expect(initializeWallet).toHaveBeenCalledTimes(2);
    } finally { app.close(); }
  });

  it('returns local Authority data while balance RPC stalls or fails', async () => {
    const app = runtime();
    let release!: () => void;
    const pending = new Promise<Response>(resolve => { release = () => resolve(Response.error()); });
    const fetcher = vi.fn(() => pending);
    try {
      const balance = app.balance(address, fetcher);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const overview = await app.overview();
      expect(overview.wallet).toEqual({ address, reused: true });
      expect(overview.budget.dailyLimit).toBeNull();
      release();
      expect((await balance).available).toBe(false);
      expect((await app.overview()).budget.dailyLimit).toBeNull();
    } finally { app.close(); }
  });
  it('keeps canonical App test purchases behind SpendGrant when legacy tasks are disabled', async () => {
    vi.stubEnv('APP2049_ENABLE_LEGACY_DEMO_TASKS', '');
    vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '');
    const app = runtime();
    app.setDailyLimit('1000000');
    app.setAgentConnection(true, origin);
    try {
      await expect(app.createTestPurchase('app-canonical-without-grant', origin)).rejects.toThrow('消费授权');
      expect(app.ledger.getForAdministration('app-canonical-without-grant')).toBeUndefined();
      const { grant } = await authorize(app, Date.now(), '1000000');
      const purchase = await app.createTestPurchase('app-canonical-with-grant', origin);
      expect(purchase).toMatchObject({ status: 'PAID', simulated: true });
      expect(app.ledger.getForAdministration('app-canonical-with-grant')?.intent.authority?.grantId).toBe(grant.id);
    } finally { app.close(); }
  });

  it('keeps a policy-only purchase request away from wallet initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-request-wallet-')); dirs.push(dir);
    const initializeWallet = vi.fn(async () => ({ address, reused: true }));
    const app = new AppRuntime(dir, { initializeWallet });
    try {
      await expect(app.requestPurchase({ requestId: 'no-wallet', offerId: 'basic', reason: 'Need data' }, origin,
        { cardMemberId: app.ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 })).rejects.toThrow('尚未初始化');
      expect(initializeWallet).not.toHaveBeenCalled();
      expect(app.ledger.listForAdministration()).toHaveLength(0);
    } finally { app.close(); }
  });

  it('binds a finite grant to the current Agent and reports successful authorization', async () => {
    const app = runtime(); const now = Date.now();
    try {
      app.setAgentConnection(true, origin);
      const intentCredential = readConnection(app.directory);
      expect(intentCredential.capabilities).toEqual(['read', 'request_purchase']);
      const grant = await app.createSpendGrant({ totalLimit: '5000000', singleLimit: '500000', expiresAt: now + 8 * 60 * 60 * 1000 });
      expect(grant.operation).toBe(PAID_RESOURCE_PURCHASE_OPERATION);
      const authorized = readConnection(app.directory);
      expect(authorized).toMatchObject({ connectionId: intentCredential.connectionId, generation: intentCredential.generation, capabilities: ['read', 'request_purchase'] });
      expect(authorized.token).toBe(intentCredential.token);
      expect(app.agentConnection.status()).toMatchObject({ enabled: true, access: 'purchase_intent' });
      expect(grant).toMatchObject({ status: 'ACTIVE', totalLimit: '5000000', singleLimit: '500000' });
      expect(app.ledger.spendGrantSummary()).toMatchObject({ id: grant.id, status: 'ACTIVE', remaining: '5000000' });
      app.setAgentConnection(false, origin);
      expect(app.ledger.spendGrantSummary()?.status).toBe('REVOKED');
    } finally { app.close(); }
  });

  it('persists the default CardMember across successive MCP connections and App restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-card-member-')); dirs.push(dir);
    const first = new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }) });
    let firstMember: string;
    let firstConnection: string;
    try {
      first.setAgentConnection(true, origin);
      const descriptor = readConnection(dir);
      firstMember = descriptor.cardMemberId;
      firstConnection = descriptor.connectionId;
      first.setAgentConnection(false, origin);
      first.setAgentConnection(true, origin);
      const reconnected = readConnection(dir);
      expect(reconnected.cardMemberId).toBe(firstMember);
      expect(reconnected.connectionId).not.toBe(firstConnection);
    } finally { first.close(); }

    const restarted = new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }) });
    try {
      restarted.setAgentConnection(true, origin);
      const descriptor = readConnection(dir);
      expect(descriptor.cardMemberId).toBe(firstMember!);
      expect(descriptor.connectionId).not.toBe(firstConnection!);
    } finally { restarted.close(); }
  });

  it('quit waits for a request loading its wallet and prevents it from making a purchase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-drain-')); dirs.push(dir);
    let release!: () => void;
    let entered!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    const app = new AppRuntime(dir, { initializeWallet: async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return { address, reused: true };
    } });
    try {
      app.setDailyLimit('100000');
      await authorize(app);
      const payment = app.createTestPurchase('quit-race', 'http://127.0.0.1:3049');
      const rejected = expect(payment).rejects.toThrow('正在退出');
      await loading;
      let ready = false;
      const quit = app.prepareQuit().then(() => { ready = true; });
      await Promise.resolve(); expect(ready).toBe(false);
      await expect(app.createTestPurchase('after-quit', 'http://127.0.0.1:3049')).rejects.toThrow('正在退出');
      release(); await rejected; await quit;
      expect(ready).toBe(true); expect(app.ledger.listForAdministration()).toHaveLength(0);
    } finally { app.close(); }
  });

  it('startup recovers original pending purchases once even when paused and live purchases are disabled', async () => {
    vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '1');
    vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs');
    vi.stubEnv('SOLANA_CLUSTER', 'devnet');
    const app = runtime();
    const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: address, DEMO_MERCHANT_PUBLIC_KEY: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs' });
    const resource = createStaticResourceRegistry({ endpoint: 'https://example.com', asset_id: config.mint, network: config.network, allowed_pay_to: config.merchant })[0];
    const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 300, extra: {} };
    const now = Date.now();
    app.setDailyLimit('100000');
    const { authority } = await authorize(app, now);
    const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'startup-original', request: { asset: 'SOL' }, requestHash: hash('task'), resource, quote,
      executionBinding: paymentBinding(config, paymentEndpoint(origin)), authority, now });
    const record = app.ledger.reserve(intent, quote, now, 'live_devnet');
    app.ledger.claim(record.approvalId);
    app.ledger.savePayload(record.approvalId, { x402Version: 2, accepted: quote, payload: { transaction: 'test-wire' } });
    app.setPaused(true);
    vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '0');
    let release!: () => void;
    let entered!: () => void;
    const recovering = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(recoverApprovedPayment).mockImplementationOnce(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return undefined;
    });
    try {
      const startup = app.start(origin); const repeated = app.start(origin);
      await recovering;
      let ready = false; const quit = app.prepareQuit().then(() => { ready = true; });
      await Promise.resolve(); expect(ready).toBe(false);
      release(); await Promise.all([startup, repeated, quit]);
      expect(recoverApprovedPayment).toHaveBeenCalledTimes(1);
      expect(vi.mocked(recoverApprovedPayment).mock.calls[0]?.[1]).toBe('startup-original');
      expect(app.ledger.getForAdministration('startup-original')?.status).toBe('PAYMENT_UNKNOWN');
      expect(app.ledger.savedPayload(record.approvalId)).toEqual({ x402Version: 2, accepted: quote, payload: { transaction: 'test-wire' } });
      expect(app.ledger.managedSummary(now, 'live_devnet')).toMatchObject({ reserved: '10000', paid: '0', unresolved: 1 });
      expect(app.ledger.controls().paused).toBe(true);
    } finally { app.close(); }
  });
  it('reports zero for an unfunded wallet and fails closed on malformed RPC data', async () => {
    const app = runtime();
    try {
      const empty = await app.balance(address, async () => Response.json({ jsonrpc: '2.0', id: 1, result: { value: null } }));
      const malformed = await app.balance(address, async () => Response.json({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'wrong' } } }));
      expect(empty).toEqual({ amount: '0', display: '0.00 Test USDC', available: true });
      expect(malformed.available).toBe(false);
    } finally { app.close(); }
  });

  it('starts without an implicit limit and blocks zero-limit and paused purchases', async () => {
    const app = runtime();
    try {
      await authorize(app);
      expect(app.ledger.managedSummary().dailyLimit).toBeNull();
      let result = await app.createTestPurchase(`app-${randomUUID()}`, 'http://127.0.0.1:3049');
      expect(result.policy.reason).toBe('DAILY_LIMIT_NOT_SET');
      app.setDailyLimit('0');
      result = await app.createTestPurchase(`app-${randomUUID()}`, 'http://127.0.0.1:3049');
      expect(result.policy.reason).toBe('DAILY_LIMIT_ZERO');
      app.setDailyLimit('100000'); app.setPaused(true);
      result = await app.createTestPurchase(`app-${randomUUID()}`, 'http://127.0.0.1:3049');
      expect(result.policy.reason).toBe('PAYMENTS_PAUSED');
    } finally { app.close(); }
  });

  it('records a simulated purchase once and persists settings and history after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-restart-')); dirs.push(dir);
    const create = () => new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }), timeZone: () => 'America/Los_Angeles' });
    const app = create(); const id = `app-${randomUUID()}`;
    try {
      app.setDailyLimit('20000');
      await authorize(app);
      const first = await app.createTestPurchase(id, 'http://127.0.0.1:3049');
      const replay = await app.createTestPurchase(id, 'http://127.0.0.1:3049');
      expect(first.status).toBe('PAID'); expect(replay.status).toBe('PAID');
      expect(app.ledger.listForAdministration()).toHaveLength(1);
      expect(app.ledger.listForAdministration()[0]).toMatchObject({ executionMode: 'simulated', network: DEVNET_NETWORK,
        assetId: DEVNET_USDC_MINT, assetDecimals: 6, currency: 'USDC', deliveryStatus: 'COMPLETE' });
      expect(app.ledger.listForAdministration()[0]).not.toHaveProperty('paymentEvidence');
      app.setDailyLimit('5000');
      const blocked = await app.createTestPurchase(`app-${randomUUID()}`, 'http://127.0.0.1:3049');
      expect(blocked.policy.reason).toBe('DAILY_BUDGET_EXCEEDED');
      app.setPaused(true);
    } finally { app.close(); }
    const restarted = create();
    try { expect(restarted.ledger.managedSummary()).toMatchObject({ dailyLimit: '5000', paid: '10000', remaining: '0', paused: true }); expect(restarted.ledger.listForAdministration()).toHaveLength(2); }
    finally { restarted.close(); }
  });

  it('reuses same-mode simulated App purchases and scopes displayed grant accounting by mode', async () => {
    const app = runtime();
    const id = `app-${randomUUID()}`;
    const merchant = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
    const resource = createStaticResourceRegistry({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: DEVNET_USDC_MINT, network: DEVNET_NETWORK, allowed_pay_to: merchant })[0];
    const quote: PaymentRequirements = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount: '10000', payTo: merchant, maxTimeoutSeconds: 300, extra: { feePayer: address, memo: `app-test:${id}` } };
    const now = Date.now();
    try {
      app.setDailyLimit('20000');
      const { authority } = await authorize(app, now);
      const intent = createMarketSnapshotSpendIntent({ idempotencyKey: id, request: { asset: 'SOL' }, requestHash: hash('2049 App test purchase'), resource, quote,
        executionBinding: hash(['simulated-devnet', address, merchant]), authority, now });
      const reserved = app.ledger.reserve(intent, quote, now, 'simulated');
      app.ledger.claim(reserved.approvalId, now);
      app.ledger.finish(reserved.approvalId, { transaction: `simulated-${id}`, data: demoSnapshot }, now);
      const replay = await app.createTestPurchase(id, 'http://127.0.0.1:3049');
      expect(replay.status).toBe('PAID');
      expect(app.spendGrantSummary()).toMatchObject({ committed: '10000', remaining: '990000' });
      vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '1');
      expect(app.spendGrantSummary()).toBeNull();
      expect(app.ledger.listForAdministration()).toHaveLength(1);
    } finally { app.close(); }
  });

  it('advances at local midnight without allowing a time-zone change or clock rollback to open another window', () => {
    let zone = 'America/Los_Angeles';
    const start = Date.parse('2026-09-14T06:00:00Z');
    const dir = mkdtempSync(join(tmpdir(), 'yosh-clock-')); dirs.push(dir);
    const app = new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }), timeZone: () => zone, now: () => start });
    try {
      expect(app.ledger.managedSummary(start).day).toBe('2026-09-13');
      zone = 'Asia/Shanghai';
      expect(app.ledger.managedSummary(Date.parse('2026-09-14T06:30:00Z')).day).toBe('2026-09-13');
      expect(app.ledger.managedSummary(Date.parse('2026-09-14T07:00:00Z')).day).toBe('2026-09-14');
      expect(app.ledger.managedSummary(Date.parse('2026-09-14T06:45:00Z')).day).toBe('2026-09-14');
    }
    finally { app.close(); }
  });

  it('serializes concurrent App requests against one shared managed limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yosh-concurrent-')); dirs.push(dir);
    const make = () => new AppRuntime(dir, { initializeWallet: async () => ({ address, reused: true }), timeZone: () => 'Asia/Shanghai' });
    const first = make();
    try {
      first.setDailyLimit('10000');
      await authorize(first, Date.now(), '20000');
      const results = await Promise.all([first.createTestPurchase(`app-${randomUUID()}`, origin), first.createTestPurchase(`app-${randomUUID()}`, origin)]);
      expect(results.map(result => result.status).sort()).toEqual(['DENIED', 'PAID']);
      expect(first.ledger.managedSummary()).toMatchObject({ paid: '10000', remaining: '0' });
    } finally { first.close(); }
  });

  it('rechecks pause and a lowered limit before signing and before submission', () => {
    const now = Date.parse('2026-09-14T08:00:00Z');
    const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet', timeZone: () => 'Asia/Shanghai', now: () => now });
    const merchant = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
    const resource = createStaticResourceRegistry({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: DEVNET_USDC_MINT, network: DEVNET_NETWORK, allowed_pay_to: merchant })[0];
    const quote: PaymentRequirements = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount: '10000', payTo: merchant, maxTimeoutSeconds: 300, extra: {} };
    const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'pause-race', request: { asset: 'SOL' }, requestHash: hash('task'), resource, quote,
      executionBinding: 'test', now });
    try {
      ledger.setDailyLimit('20000'); const reserved = ledger.reserve(intent, quote, now, 'live_devnet');
      ledger.setPaused(true); expect(() => ledger.claim(reserved.approvalId, now)).toThrow('paused');
      ledger.setPaused(false); ledger.setDailyLimit('5000'); expect(() => ledger.claim(reserved.approvalId, now)).toThrow('no longer covers');
      ledger.setDailyLimit('20000'); ledger.claim(reserved.approvalId, now); ledger.setPaused(true);
      expect(() => ledger.savePayload(reserved.approvalId, { signed: 'fixture' })).toThrow('paused before submission');
      expect(ledger.savedPayload(reserved.approvalId)).toBeUndefined();
    } finally { ledger.close(); }
  });
});
