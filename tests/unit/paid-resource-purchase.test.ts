import { testModeGrants, testModeDailyLimit } from '../helpers/test-mode-authority';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FacilitatorClient } from '@x402/core/server';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { Keypair } from '@solana/web3.js';
import { expect, it, vi } from 'vitest';
import { LEGACY_MARKET_SNAPSHOT_OPERATION, PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { createPaidMarketApi } from '../../src/modules/paid-market-api/paid-market-api';
import { SettlementStore } from '../../src/modules/paid-market-api/settlement-store';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { paymentEndpointForIntent } from '../../src/modules/purchases/approved-payment';
import { readPaidResourceQuotes } from '../../src/modules/purchases/paid-resource-quote';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { PurchaseRequestInputSchema, requestPaidResourcePurchase } from '../../src/modules/purchases/request-paid-resource-purchase';
import { PAID_RESOURCE_SCOPE_ID, PaidResourceIdSchema, paidResource, type PaidResourceId } from '../../src/modules/resources/paid-resources';
import { DEMO_MARKET_DATA_PROVIDER_ID } from '../../src/modules/resources/static-resource-registry';

const buyer = Keypair.generate().publicKey.toBase58();
const merchant = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const config: PaymentConfig = { ...resolvePaymentEnvironment({}, 'live_devnet'), cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', network: DEVNET_NETWORK,
  mint: DEVNET_USDC_MINT, buyer, merchant, facilitatorUrl: 'https://facilitator.invalid' };
const memberId = '11111111-1111-4111-8111-111111111111';
const principal = { cardMemberId: memberId, connectionId: '2c187121-f6f1-49a3-aea4-821c4bc0a662', connectionGeneration: 2 };
const now = Date.parse('2026-09-24T03:00:00Z');
const origin = 'http://127.0.0.1:3049';

function setup(path = ':memory:', operation: string = PAID_RESOURCE_PURCHASE_OPERATION, singleLimit = '200000') {
  const ledger = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now,
    timeZone: () => 'Asia/Shanghai', defaultCardMemberId: memberId });
  testModeDailyLimit(ledger, '1000000');
  testModeGrants(ledger, { totalLimit: '400000', singleLimit, expiresAt: now + 60 * 60 * 1000 }, principal, {
    resourceId: PAID_RESOURCE_SCOPE_ID, providerId: DEMO_MARKET_DATA_PROVIDER_ID, operation,
    network: config.network, assetId: config.mint, assetDecimals: 6, payTo: config.merchant, paymentScheme: 'exact',
  }, now);
  const facilitator = { getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2 as const, scheme: 'exact', network: config.network,
    extra: { feePayer } }], extensions: [], signers: {} })), verify: vi.fn(), settle: vi.fn() } satisfies FacilitatorClient;
  const store = new SettlementStore(':memory:');
  const paidApi = createPaidMarketApi(config, facilitator, store);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    const resource = url.pathname.endsWith('/market-analysis') ? 'analysis'
      : url.pathname.endsWith('/token-risk-report') ? 'risk' : 'snapshot';
    return paidApi({ asset: url.searchParams.get('asset'), resource });
  });
  return { ledger, store, facilitator, fetcher };
}
const request = (requestId: string, resourceId: PaidResourceId) => ({ requestId, resourceId, reason: 'Need SOL data' });

it('quotes both real 402 resources, then evaluates the same resource and amount under one Grant', async () => {
  const f = setup();
  try {
    const listed = await readPaidResourceQuotes(origin, config, f.fetcher);
    expect(listed.resources).toMatchObject([
      { resourceId: 'market-snapshot', resourceUrl: '/api/paid/sol-market-snapshot?asset=SOL', amount: '200000', display: '0.20 test USDC' },
      { resourceId: 'market-analysis', resourceUrl: '/api/paid/market-analysis?asset=SOL', amount: '20000000', display: '20.00 test USDC' },
      { resourceId: 'token-risk-report', resourceUrl: '/api/paid/token-risk-report?asset=SOL', amount: '50000', display: '0.05 test USDC' },
    ]);
    const pay = vi.fn();
    const snapshot = await requestPaidResourcePurchase(request('snapshot-policy', 'market-snapshot'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false, pay });
    const analysis = await requestPaidResourcePurchase(request('analysis-policy', 'market-analysis'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false, pay });
    expect(snapshot).toMatchObject({ amount: '200000', status: 'APPROVED', executionMode: 'simulated',
      quote: { resourceId: 'market-snapshot', resourceUrl: listed.resources[0].resourceUrl, amount: listed.resources[0].amount } });
    expect(analysis).toMatchObject({ amount: '20000000', status: 'DENIED',
      decision: { reason: 'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED' }, quote: { resourceId: 'market-analysis', resourceUrl: listed.resources[1].resourceUrl } });
    expect(f.ledger.getOwned('snapshot-policy', memberId)?.intent).toMatchObject({ resourceScopeId: PAID_RESOURCE_SCOPE_ID,
      resourcePath: '/api/paid/sol-market-snapshot?asset=SOL' });
    expect(f.ledger.getOwned('analysis-policy', memberId)?.intent).toMatchObject({ resourceScopeId: PAID_RESOURCE_SCOPE_ID,
      resourcePath: '/api/paid/market-analysis?asset=SOL' });
    expect(f.ledger.listForAdministration().map(item => ({ resourceId: item.resourceId, status: item.status }))).toEqual(expect.arrayContaining([
      { resourceId: 'market-analysis', status: 'DENIED' },
      { resourceId: 'market-snapshot', status: 'APPROVED' },
    ]));
    expect(pay).not.toHaveBeenCalled();
    expect(f.facilitator.verify).not.toHaveBeenCalled();
    expect(f.facilitator.settle).not.toHaveBeenCalled();
  } finally { f.ledger.close(); f.store.close(); }
});

it('registers token risk, approves its fresh 0.05 quote, and replays the persisted resource path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-token-risk-purchase-'));
  const path = join(directory, 'ledger.sqlite');
  const f = setup(path);
  try {
    expect(PaidResourceIdSchema.parse('token-risk-report')).toBe('token-risk-report');
    expect(paidResource('token-risk-report').path).toBe('/api/paid/token-risk-report?asset=SOL');
    const first = await requestPaidResourcePurchase(request('risk-report-approved', 'token-risk-report'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
    expect(first).toMatchObject({ resourceId: 'token-risk-report', amount: '50000', display: '0.05 test USDC',
      status: 'APPROVED', decision: { reason: 'AUTHORITY_BUDGET_AND_GRANT_PASSED' },
      quote: { resourceUrl: '/api/paid/token-risk-report?asset=SOL', network: config.network,
        assetId: config.mint, payTo: config.merchant, amount: '50000' } });
    expect(f.ledger.getOwned('risk-report-approved', memberId)?.intent).toMatchObject({ resourceId: 'token-risk-report',
      resourcePath: '/api/paid/token-risk-report?asset=SOL',
      authority: { operation: PAID_RESOURCE_PURCHASE_OPERATION } });
    f.ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai' });
    try {
      const saved = reopened.getOwned('risk-report-approved', memberId)!;
      expect(paymentEndpointForIntent(origin, saved.intent)).toBe(`${origin}/api/paid/token-risk-report?asset=SOL`);
      const replay = await requestPaidResourcePurchase(request('risk-report-approved', 'token-risk-report'),
        { config, ledger: reopened, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
      expect(replay).toMatchObject({ reused: true, status: 'APPROVED', amount: '50000' });
      expect(f.fetcher).toHaveBeenCalledOnce();
      await expect(requestPaidResourcePurchase(request('risk-report-approved', 'market-snapshot'),
        { config, ledger: reopened, origin, principal, fetcher: f.fetcher, now: () => now, execute: false })).rejects.toThrow('REQUEST_ID_CONFLICT');
    } finally { reopened.close(); }
    expect(f.facilitator.verify).not.toHaveBeenCalled();
    expect(f.facilitator.settle).not.toHaveBeenCalled();
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('denies token risk under the existing per-transaction Grant limit below 0.05', async () => {
  const f = setup(':memory:', PAID_RESOURCE_PURCHASE_OPERATION, '49999');
  try {
    const result = await requestPaidResourcePurchase(request('risk-report-denied', 'token-risk-report'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
    expect(result).toMatchObject({ amount: '50000', status: 'DENIED',
      decision: { reason: 'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED' } });
    expect(f.facilitator.verify).not.toHaveBeenCalled();
    expect(f.facilitator.settle).not.toHaveBeenCalled();
  } finally { f.ledger.close(); f.store.close(); }
});

it('evaluates a changed fresh 402 amount rather than a token-risk price in purchase policy', async () => {
  const f = setup(':memory:', PAID_RESOURCE_PURCHASE_OPERATION, '55000');
  const repriced = vi.fn<typeof fetch>(async input => {
    const response = await f.fetcher(input);
    const required = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'));
    required.accepts[0].amount = '60000';
    return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } });
  });
  try {
    const result = await requestPaidResourcePurchase(request('risk-report-repriced', 'token-risk-report'),
      { config, ledger: f.ledger, origin, principal, fetcher: repriced, now: () => now, execute: false });
    expect(result).toMatchObject({ amount: '60000', status: 'DENIED',
      decision: { reason: 'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED' } });
    expect(f.ledger.getOwned('risk-report-repriced', memberId)?.quote.amount).toBe('60000');
    expect(f.facilitator.verify).not.toHaveBeenCalled();
    expect(f.facilitator.settle).not.toHaveBeenCalled();
  } finally { f.ledger.close(); f.store.close(); }
});

it('takes no Agent amount, price, offerId, payTo, or arbitrary requirements', () => {
  for (const extra of [{ amount: '1' }, { price: '1' }, { offerId: 'basic' }, { payTo: buyer }, { requirements: {} }]) {
    expect(PurchaseRequestInputSchema.safeParse({ ...request('strict-schema', 'market-snapshot'), ...extra }).success).toBe(false);
  }
});

it('rejects an unknown resource through the registry before quoting or reserving', async () => {
  const f = setup();
  try {
    expect(PurchaseRequestInputSchema.safeParse({ requestId: 'unknown-resource', resourceId: 'unknown-resource', reason: 'Need data' }).success).toBe(true);
    await expect(requestPaidResourcePurchase({ requestId: 'unknown-resource', resourceId: 'unknown-resource', reason: 'Need data' },
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false })).rejects.toThrow('UNKNOWN_PAID_RESOURCE');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.ledger.getOwned('unknown-resource', memberId)).toBeUndefined();
  } finally { f.ledger.close(); f.store.close(); }
});

it('uses a stored legacy grant for registered resources without rewriting its operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-legacy-resource-grant-'));
  const path = join(directory, 'ledger.sqlite');
  const f = setup(path, LEGACY_MARKET_SNAPSHOT_OPERATION);
  try {
    f.ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai' });
    try {
      const purchase = await requestPaidResourcePurchase(request('legacy-resource-grant', 'market-snapshot'),
        { config, ledger: reopened, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
      expect(purchase.decision.decision).toBe('APPROVED');
      const record = reopened.getOwned('legacy-resource-grant', memberId)!;
      expect(record.intent.authority?.operation).toBe(LEGACY_MARKET_SNAPSHOT_OPERATION);
      expect(reopened.spendGrantSummary(now)?.operation).toBe(LEGACY_MARKET_SNAPSHOT_OPERATION);
    } finally { reopened.close(); }
    const recovering = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai' });
    try {
      const record = recovering.getOwned('legacy-resource-grant', memberId)!;
      expect(record.intent.authority?.operation).toBe(LEGACY_MARKET_SNAPSHOT_OPERATION);
      const replay = await requestPaidResourcePurchase(request('legacy-resource-grant', 'market-snapshot'),
        { config, ledger: recovering, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
      expect(replay).toMatchObject({ reused: true, status: 'APPROVED' });
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(recovering.claim(record.approvalId, now).status).toBe('PAYING');
    } finally { recovering.close(); }
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('rejects a 402 for the wrong registered resource before any reservation', async () => {
  const f = setup();
  try {
    const wrong = vi.fn<typeof fetch>(async input => {
      const response = await f.fetcher(input);
      const required = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'));
      required.resource.url = '/api/paid/market-analysis?asset=SOL';
      return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } });
    });
    await expect(requestPaidResourcePurchase(request('wrong-quote', 'market-snapshot'),
      { config, ledger: f.ledger, origin, principal, fetcher: wrong, now: () => now, execute: false })).rejects.toThrow('INVALID_X402_QUOTE');
    expect(f.ledger.getOwned('wrong-quote', memberId)).toBeUndefined();
  } finally { f.ledger.close(); f.store.close(); }
});

it('routes a live approval to the existing executor with persisted 402 terms and no offerId', async () => {
  const f = setup();
  const pay = vi.fn(async (ledger: PurchaseLedger, approvalId: string, _config: PaymentConfig, endpoint: string) => {
    const record = ledger.getOwned('live-snapshot', memberId)!;
    expect(record.intent.offerId).toBeUndefined();
    expect(record.quote.amount).toBe('200000');
    expect(endpoint).toBe(`${origin}/api/paid/sol-market-snapshot?asset=SOL`);
    expect(paymentEndpointForIntent(origin, record.intent)).toBe(endpoint);
    expect(record.intent.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(approvalId).toBe(record.approvalId);
    return { transaction: '1'.repeat(88), data: {} };
  });
  try {
    const first = await requestPaidResourcePurchase(request('live-snapshot', 'market-snapshot'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, pay });
    expect(first).toMatchObject({ status: 'APPROVED', amount: '200000', reused: false });
    expect(pay).toHaveBeenCalledOnce();
    await requestPaidResourcePurchase(request('live-snapshot', 'market-snapshot'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, pay });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(pay).toHaveBeenCalledTimes(2);
    await expect(requestPaidResourcePurchase(request('live-snapshot', 'market-analysis'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, pay })).rejects.toThrow('REQUEST_ID_CONFLICT');
  } finally { f.ledger.close(); f.store.close(); }
});

it('reopens new purchases without offerId and reconstructs the exact selected endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-resource-recovery-'));
  const path = join(directory, 'ledger.sqlite');
  const f = setup(path);
  try {
    await requestPaidResourcePurchase(request('restart-resource', 'market-snapshot'),
      { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
    f.ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai' });
    try {
      const record = reopened.getOwned('restart-resource', memberId)!;
      expect(record.intent.offerId).toBeUndefined();
      expect(record.intent.resourcePath).toBe('/api/paid/sol-market-snapshot?asset=SOL');
      expect(paymentEndpointForIntent(origin, record.intent)).toBe(`${origin}${record.intent.resourcePath}`);
      expect(record.quote.amount).toBe('200000');
    } finally { reopened.close(); }
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('refuses a stored request replay after changing wallet scope before quote, payment or recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-wallet-scope-replay-'));
  const file = join(directory, 'ledger.sqlite'); const f = setup(file);
  let other: PurchaseLedger | undefined;
  try {
    const input = request('wallet-bound-risk', 'token-risk-report');
    await requestPaidResourcePurchase(input, { config, ledger: f.ledger, origin, principal, fetcher: f.fetcher, now: () => now, execute: false });
    other = new PurchaseLedger(file, { managed: true, requireSpendGrant: true, walletIdentity: 'fixture-other-wallet', mode: 'simulated', now: () => now });
    const fetcher = vi.fn(); const pay = vi.fn(); const recover = vi.fn();
    await expect(requestPaidResourcePurchase(input, { config, ledger: other, origin, principal, fetcher, pay, recover, now: () => now, execute: false }))
      .rejects.toThrow('MONETARY_SCOPE_MISMATCH');
    expect(fetcher).not.toHaveBeenCalled(); expect(pay).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    expect(other.managedSummary(now)).toMatchObject({ paid: '0', reserved: '0', dailyLimit: null });
    expect(f.ledger.managedSummary(now, 'simulated')).toMatchObject({ reserved: '50000' });
  } finally { other?.close(); f.ledger.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
