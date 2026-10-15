import { testModeGrants, testModeDailyLimit } from '../helpers/test-mode-authority';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FacilitatorClient } from '@x402/core/server';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { Keypair } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { LEGACY_MARKET_SNAPSHOT_OPERATION as MARKET_SNAPSHOT_OPERATION } from '../../src/modules/authority/spend-grant';
import { createPaidMarketApi } from '../../src/modules/paid-market-api/paid-market-api';
import { SettlementStore } from '../../src/modules/paid-market-api/settlement-store';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { readPaymentRequiredHeader } from '../../src/modules/payment/x402-client';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { requestMarketPurchase } from '../../src/modules/purchases/request-market-purchase';
import { DEMO_MARKET_DATA_PROVIDER_ID, SOL_MARKET_SNAPSHOT_RESOURCE_ID } from '../../src/modules/resources/static-resource-registry';

const buyer = Keypair.generate().publicKey.toBase58();
const merchant = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();
const config: PaymentConfig = { ...resolvePaymentEnvironment({}, 'live_devnet'), cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', network: DEVNET_NETWORK,
  mint: DEVNET_USDC_MINT, buyer, merchant, facilitatorUrl: 'https://facilitator.invalid' };
const cardMemberId = '11111111-1111-4111-8111-111111111111';
const principal = { cardMemberId, connectionId: '2c187121-f6f1-49a3-aea4-821c4bc0a662', connectionGeneration: 2 };
const now = Date.parse('2026-09-22T08:00:00Z');
const snapshot = { asset: 'SOL' as const, as_of: '2026-09-05T08:00:00Z', spot_price_usd: 140, change_24h_pct: 2.4,
  volume_24h_usd: 3_000_000_000, market_cap_usd: 75_000_000_000, volatility_7d_pct: 5.8, rsi_14d: 57,
  support_levels_usd: [132, 136], resistance_levels_usd: [145, 151], source_label: 'Demo snapshot fixture', is_demo_snapshot: true as const };

function facilitator() {
  return {
    getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2 as const, scheme: 'exact', network: config.network, extra: { feePayer } }], extensions: [], signers: {} })),
    verify: vi.fn(async () => ({ isValid: true, payer: buyer })),
    settle: vi.fn(async () => ({ success: true, transaction: 'not-used', payer: buyer, network: config.network })),
  } satisfies FacilitatorClient;
}

function setup(totalLimit = '5000000', ledgerPath = ':memory:') {
  const ledger = new PurchaseLedger(ledgerPath, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now, timeZone: () => 'Asia/Shanghai', defaultCardMemberId: cardMemberId });
  testModeDailyLimit(ledger, '50000000');
  testModeGrants(ledger, { totalLimit, singleLimit: String(Math.min(Number(totalLimit), 500_000)), expiresAt: now + 60 * 60 * 1000 }, principal, {
    resourceId: SOL_MARKET_SNAPSHOT_RESOURCE_ID, providerId: DEMO_MARKET_DATA_PROVIDER_ID, operation: MARKET_SNAPSHOT_OPERATION,
    network: config.network, assetId: config.mint, assetDecimals: 6, payTo: config.merchant, paymentScheme: 'exact',
  }, now);
  const remote = facilitator();
  const store = new SettlementStore(':memory:');
  const paidApi = createPaidMarketApi(config, remote, store);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    return paidApi({ asset: url.searchParams.get('asset'), offer: url.searchParams.get('offer') });
  });
  return { ledger, remote, fetcher, store };
}

function finishLivePurchase(ledger: PurchaseLedger, approvalId: string, transaction: string, now: number) {
  const record = ledger.claim(approvalId);
  const payload = { x402Version: 2, accepted: record.quote, payload: { transaction: 'signed-fixture-wire' } };
  ledger.savePayload(approvalId, payload);
  ledger.confirmPayment(approvalId, transaction, { payer: config.buyer, messageHash: 'a'.repeat(64), confirmationStatus: 'confirmed', settlementConfirmed: true }, now);
  ledger.finish(approvalId, { transaction, data: snapshot }, now);
}

afterEach(() => vi.restoreAllMocks());

it('runs real quote → SpendGrant → policy for APPROVED and DENIED without payment', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const claim = vi.spyOn(ledger, 'claim');
  try {
    const basic = await requestMarketPurchase({ requestId: 'request-basic', offerId: 'basic', reason: 'Need the SOL snapshot' },
      { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now });
    const premium = await requestMarketPurchase({ requestId: 'request-premium', offerId: 'premium', reason: 'Compare the premium offer' },
      { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now });
    expect(basic).toMatchObject({ amount: '200000', status: 'APPROVED', paymentStatus: 'NOT_STARTED', decision: { decision: 'APPROVED', reason: 'AUTHORITY_BUDGET_AND_GRANT_PASSED' } });
    expect(premium).toMatchObject({ amount: '20000000', status: 'DENIED', paymentStatus: 'NOT_STARTED', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED' } });
    expect(basic.quote).toMatchObject({ resourceId: SOL_MARKET_SNAPSHOT_RESOURCE_ID, network: config.network, assetId: config.mint, payTo: config.merchant, amount: '200000' });
    expect(basic.grant).toMatchObject({ id: expect.any(String), version: 1 });
    expect(premium.grant?.id).toBe(basic.grant?.id);
    expect(ledger.listForAdministration()).toHaveLength(2);
    expect(ledger.spendGrantSummary(now, 'simulated')).toMatchObject({ committed: '200000', remaining: '4800000' });
    expect(remote.verify).not.toHaveBeenCalled();
    expect(remote.settle).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('bridges basic APPROVED through the existing claim path using the one persisted 0.20 quote', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const signer = vi.fn();
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string, _config: PaymentConfig, endpoint: string) => {
    signer();
    const claimed = paymentLedger.getOwned('executed-basic', cardMemberId);
    if (!claimed) throw new Error('purchase reservation missing');
    expect(claimed.quote.amount).toBe('200000');
    expect(endpoint).toBe('http://127.0.0.1:3049/api/paid/market-snapshot?asset=SOL&offer=basic');
    finishLivePurchase(paymentLedger, approvalId, '1'.repeat(88), now);
    return { transaction: '1'.repeat(88), data: snapshot };
  });
  const input = { requestId: 'executed-basic', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  try {
    const first = await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay });
    const replayPrincipal = { ...principal, connectionId: randomUUID(), connectionGeneration: 1 };
    const replay = await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal: replayPrincipal, fetcher, now: () => now, pay });
    const rotatedReplay = await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049',
      principal: { ...replayPrincipal, connectionGeneration: 2 }, fetcher, now: () => now, pay });
    expect(first).toMatchObject({ amount: '200000', status: 'PAID', paymentStatus: 'PAID', deliveryStatus: 'COMPLETE', reused: false, resource: snapshot });
    expect(replay).toMatchObject({ purchaseId: first.purchaseId, paymentStatus: 'PAID', deliveryStatus: 'COMPLETE', reused: true, resource: snapshot });
    expect(replay.resource).toEqual(first.resource);
    expect(rotatedReplay).toMatchObject({ reused: true, resource: snapshot });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pay).toHaveBeenCalledOnce();
    expect(signer).toHaveBeenCalledOnce();
    expect(remote.verify).not.toHaveBeenCalled();
    expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('does not replay another CardMember purchase with the same requestId', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-purchase-owner-'));
  const ledgerPath = join(directory, 'ledger.sqlite');
  const { ledger, fetcher, store } = setup('5000000', ledgerPath);
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string) => {
    finishLivePurchase(paymentLedger, approvalId, '4'.repeat(88), now);
    return { transaction: '4'.repeat(88), data: snapshot };
  });
  const input = { requestId: 'member-owned-resource', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  try {
    await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay });
    const otherCardMemberId = ledger.createCardMember('Other Agent', now).id;
    const other = await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049',
      principal: { cardMemberId: otherCardMemberId, connectionId: randomUUID(), connectionGeneration: 1 }, fetcher, now: () => now, pay });
    expect(other).toMatchObject({ reused: false, status: 'DENIED', paymentStatus: 'NOT_STARTED' });
    expect(other).not.toHaveProperty('resource');
    expect(ledger.getOwned(input.requestId, cardMemberId)).toMatchObject({ ownerCardMemberId: cardMemberId, status: 'PAID' });
    expect(ledger.getOwned(input.requestId, otherCardMemberId)).toMatchObject({ ownerCardMemberId: otherCardMemberId, status: 'DENIED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(pay).toHaveBeenCalledOnce();
  } finally {
    ledger.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it('CardMember revoke blocks new spending and completed resource access without erasing ownership', async () => {
  const { ledger, fetcher, store } = setup();
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string) => {
    finishLivePurchase(paymentLedger, approvalId, '5'.repeat(88), now);
    return { transaction: '5'.repeat(88), data: snapshot };
  });
  const input = { requestId: 'revoked-member-resource', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  try {
    await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay });
    expect(ledger.revokeCardMember(cardMemberId, now + 1)).toBe(true);
    expect(ledger.getOwned(input.requestId, cardMemberId)?.ownerCardMemberId).toBe(cardMemberId);
    await expect(requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now + 2, pay }))
      .rejects.toThrow('CARD_MEMBER_REVOKED');
    await expect(requestMarketPurchase({ requestId: 'revoked-member-new', offerId: 'basic', reason: 'Need new data' },
      { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now + 2, pay }))
      .rejects.toThrow('CARD_MEMBER_REVOKED');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pay).toHaveBeenCalledOnce();
  } finally { ledger.close(); store.close(); }
});

it('returns premium DENIED from durable policy facts without invoking payment or recovery', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const pay = vi.fn();
  const recover = vi.fn();
  try {
    const denied = await requestMarketPurchase({ requestId: 'denied-premium', offerId: 'premium', reason: 'Need premium data' },
      { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay, recover });
    expect(denied).toMatchObject({ amount: '20000000', status: 'DENIED', paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_DELIVERED' });
    expect(denied).not.toHaveProperty('resource');
    expect(pay).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(remote.verify).not.toHaveBeenCalled();
    expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('does not return a resource while payment is unknown', async () => {
  const { ledger, fetcher, store } = setup();
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string) => {
    paymentLedger.claim(approvalId);
    paymentLedger.unknown(approvalId);
    throw new Error('Submission outcome unknown');
  });
  try {
    const result = await requestMarketPurchase({ requestId: 'unknown-basic', offerId: 'basic', reason: 'Need the SOL snapshot' },
      { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay });
    expect(result).toMatchObject({ paymentStatus: 'PAYMENT_UNKNOWN', deliveryStatus: 'NOT_DELIVERED', reused: false });
    expect(result).not.toHaveProperty('resource');
  } finally { ledger.close(); store.close(); }
});

it('rejects malformed persisted resources instead of returning unvalidated database JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-purchase-resource-'));
  const ledgerPath = join(directory, 'ledger.sqlite');
  const { ledger, fetcher, store } = setup('5000000', ledgerPath);
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string) => {
    finishLivePurchase(paymentLedger, approvalId, '3'.repeat(88), now);
    return { transaction: '3'.repeat(88), data: snapshot };
  });
  const input = { requestId: 'malformed-resource', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  try {
    await requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay });
    const database = new DatabaseSync(ledgerPath);
    try { database.prepare('UPDATE purchases SET data=? WHERE task_id=?').run('{"asset":"BTC"}', input.requestId); }
    finally { database.close(); }

    await expect(requestMarketPurchase(input,
      { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pay).toHaveBeenCalledOnce();
  } finally {
    ledger.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('replays the same request without another quote and rejects changed input', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const input = { requestId: 'stable-request', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  try {
    const first = await requestMarketPurchase(input, { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now });
    const replay = await requestMarketPurchase(input, { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now });
    expect(replay).toMatchObject({ purchaseId: first.purchaseId, status: 'APPROVED', reused: true });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(requestMarketPurchase({ ...input, offerId: 'premium' }, { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now })).rejects.toThrow('REQUEST_ID_CONFLICT');
    const rotated = await requestMarketPurchase(input, { config, ledger, execute: false, origin: 'http://127.0.0.1:3049',
      principal: { ...principal, connectionGeneration: 99 }, fetcher, now: () => now });
    expect(rotated).toMatchObject({ purchaseId: first.purchaseId, reused: true });
    expect(ledger.listForAdministration()).toHaveLength(1);
    expect(remote.verify).not.toHaveBeenCalled(); expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('rejects simulated APPROVED replay in live mode before payment, recovery, or another quote', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const input = { requestId: 'simulated-approved-replay', offerId: 'basic' as const, reason: 'Need the SOL snapshot' };
  const pay = vi.fn();
  const recover = vi.fn();
  try {
    const simulated = await requestMarketPurchase(input, {
      config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now,
    });
    await expect(requestMarketPurchase(input, {
      config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay, recover,
    })).rejects.toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');

    expect(simulated).toMatchObject({ status: 'APPROVED', executionMode: 'simulated', reused: false });
    expect(ledger.getOwned(input.requestId, cardMemberId)).toMatchObject({ status: 'APPROVED', executionMode: 'simulated', paymentPayloadPresent: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pay).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(remote.verify).not.toHaveBeenCalled();
    expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('concurrent identical request IDs persist one quote and claim payment once', async () => {
  const { ledger, fetcher, store } = setup();
  const pay = vi.fn(async (paymentLedger: PurchaseLedger, approvalId: string) => {
    const transaction = '2'.repeat(88);
    finishLivePurchase(paymentLedger, approvalId, transaction, now);
    return { transaction, data: snapshot };
  });
  const input = { requestId: 'concurrent-stable-id', offerId: 'basic' as const, reason: 'Need data' };
  try {
    const [first, second] = await Promise.all([
      requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay }),
      requestMarketPurchase(input, { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now, pay }),
    ]);
    expect(first.purchaseId).toBe(second.purchaseId);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(ledger.listForAdministration()).toHaveLength(1);
    expect(pay).toHaveBeenCalledOnce();
  } finally { ledger.close(); store.close(); }
});

it('rejects Agent-supplied payment terms before fetching a quote', async () => {
  const { ledger, remote, fetcher, store } = setup();
  try {
    await expect(requestMarketPurchase({ requestId: 'forged-terms', offerId: 'basic', reason: 'Need data',
      amount: '1', payTo: buyer, approved: true, transaction: 'forged' },
    { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(ledger.listForAdministration()).toHaveLength(0);
    expect(remote.verify).not.toHaveBeenCalled(); expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('rejects a changed server quote before reserving any budget', async () => {
  const { ledger, remote, fetcher, store } = setup();
  const changed = vi.fn<typeof fetch>(async input => {
    const response = await fetcher(input);
    const required = readPaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED')!);
    required.accepts[0].amount = '1';
    return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } });
  });
  try {
    await expect(requestMarketPurchase({ requestId: 'changed-quote', offerId: 'basic', reason: 'Need data' },
      { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher: changed, now: () => now })).rejects.toThrow('INVALID_X402_QUOTE');
    expect(ledger.listForAdministration()).toHaveLength(0);
    expect(ledger.spendGrantSummary(now)?.committed).toBe('0');
    expect(remote.verify).not.toHaveBeenCalled(); expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('atomically applies the grant total to concurrent quoted requests', async () => {
  const { ledger, remote, fetcher, store } = setup('300000');
  try {
    const results = await Promise.all(['one', 'two'].map(id => requestMarketPurchase({ requestId: `request-${id}-${randomUUID()}`, offerId: 'basic', reason: 'Need data' },
      { config, ledger, execute: false, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now })));
    expect(results.map(value => value.decision.reason).sort()).toEqual(['AUTHORITY_BUDGET_AND_GRANT_PASSED', 'SPEND_GRANT_TOTAL_LIMIT_EXCEEDED']);
    expect(remote.verify).not.toHaveBeenCalled(); expect(remote.settle).not.toHaveBeenCalled();
  } finally { ledger.close(); store.close(); }
});

it('persists a structured DENIED request when the grant is already revoked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-revoked-denial-'));
  const ledgerPath = join(directory, 'ledger.sqlite');
  const { ledger, remote, store } = setup('5000000', ledgerPath);
  const pay = vi.fn();
  const recover = vi.fn();
  const paidApi = createPaidMarketApi(config, remote, store);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    return paidApi({ asset: 'SOL', offer: url.searchParams.get('offer') });
  });
  let reopened: PurchaseLedger | undefined;
  try {
    ledger.revokeActiveSpendGrant(now + 1);
    const beforeBudget = ledger.managedSummary(now + 2, 'live_devnet');
    const beforeGrant = ledger.spendGrantSummary(now + 2, 'live_devnet');
    const denied = await requestMarketPurchase({ requestId: 'revoked-during-quote', offerId: 'basic', reason: 'Need data' },
      { config, ledger, origin: 'http://127.0.0.1:3049', principal, fetcher, now: () => now + 2, pay, recover });
    expect(denied).toMatchObject({
      purchaseId: 'revoked-during-quote', offerId: 'basic', amount: '200000', executionMode: 'live_devnet',
      decision: { decision: 'DENIED', reason: 'SPEND_GRANT_REVOKED' }, paymentStatus: 'NOT_STARTED',
      deliveryStatus: 'NOT_DELIVERED', reused: false,
    });
    expect(denied).not.toHaveProperty('resource');
    const record = ledger.getOwned('revoked-during-quote', cardMemberId);
    expect(record).toMatchObject({ status: 'DENIED', executionMode: 'live_devnet', paymentPayloadPresent: false });
    expect(record).not.toHaveProperty('transaction');
    expect(record).not.toHaveProperty('data');
    expect(ledger.eventsForOwner('revoked-during-quote', cardMemberId).map(event => event.type)).toEqual(['authority.DENIED']);
    expect(ledger.managedSummary(now + 2, 'live_devnet')).toEqual(beforeBudget);
    expect(ledger.spendGrantSummary(now + 2, 'live_devnet')).toEqual(beforeGrant);
    expect(beforeGrant).toMatchObject({ status: 'REVOKED', committed: '0' });
    expect(store.getQuote(String(record?.quote.extra?.memo))).toBeDefined();
    expect(store.getByQuote(String(record?.quote.extra?.memo))).toBeUndefined();
    expect(pay).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(remote.verify).not.toHaveBeenCalled(); expect(remote.settle).not.toHaveBeenCalled();
    ledger.close();
    reopened = new PurchaseLedger(ledgerPath, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => now + 2,
      timeZone: () => 'Asia/Shanghai', defaultCardMemberId: cardMemberId });
    expect(reopened.getOwned('revoked-during-quote', cardMemberId)).toMatchObject({
      status: 'DENIED', executionMode: 'live_devnet', decision: { decision: 'DENIED', reason: 'SPEND_GRANT_REVOKED' },
      paymentPayloadPresent: false,
    });
  } finally {
    reopened?.close();
    if (!reopened) ledger.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
