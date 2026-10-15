import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { TEST_CACHED_DELIVERY, validateDeliveryCapability, type DeliveryRecoveryCapability } from '../../src/modules/resources/delivery-capability';
import type { X402Resource } from '../../src/modules/resources/http-resource';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { executeApprovedPayment, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { DELIVERY_RETRY_LIMIT } from '../../src/modules/purchases/delivery-state';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { postRequestPolicyHash } from '../../src/modules/resources/post-request-authorization';
import { requestRegisteredResourcePurchase } from '../../src/modules/purchases/request-registered-resource-purchase';
import { randomUUID } from 'node:crypto';
import type { SpendPrincipal } from '../../src/modules/authority/spend-grant';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async original => ({ ...await original<typeof import('../../src/modules/payment/solana-payment')>(), prepareSolanaPayment: vi.fn() }));
vi.mock('../../src/modules/payment/reconcile-transaction', async original => ({ ...await original<typeof import('../../src/modules/payment/reconcile-transaction')>(), reconcileStoredOriginalPayment: vi.fn() }));
const handles = new Set<PurchaseLedger>(); const directories: string[] = [];
afterEach(() => {
  for (const ledger of handles) { try { ledger.close(); } catch { /* Already closed by restart fixture. */ } }
  handles.clear(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks();
});
async function fixture(capability: DeliveryRecoveryCapability | null = TEST_CACHED_DELIVERY, mode: 'live_devnet' | 'live_mainnet' = 'live_devnet') {
  let clock = Date.now();
  const signer = await generateKeyPairSigner(); const fee = await generateKeyPairSigner(); const recipient = (await generateKeyPairSigner()).address;
  const environment = resolvePaymentEnvironment(mode === 'live_mainnet' ? { YOSH_ENABLE_MAINNET_EXECUTION: '1' } : {}, mode);
  let config: PaymentConfig = { ...environment, buyer: signer.address, mint: environment.asset.mint,
    merchant: (await generateKeyPairSigner()).address, facilitatorUrl: 'https://facilitator.example' };
  const resource: X402Resource = { resourceId: 'approved-result', providerId: 'approved-provider', network: config.network,
    mint: config.mint, decimals: 6, ...(mode === 'live_mainnet' ? { recipientSource: 'live_challenge' as const, maximumAmount: '10000' } : { recipient }), request: { url: 'https://api.provider.example/v1/result', method: 'POST',
      access: 'https', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"query":"approved"}' },
    ...(capability ? { deliveryRecovery: capability } : {}) };
  const challenge = { x402Version: 2 as const, resource: { url: resource.request.url }, accepts: [{ scheme: 'exact',
    network: config.network, asset: config.mint, payTo: recipient, amount: '10000', maxTimeoutSeconds: 300, extra: { feePayer: fee.address } }] };
  const dir = mkdtempSync(join(tmpdir(), 'yosh-delivery-')); directories.push(dir); const path = join(dir, 'app-ledger.sqlite');
  const options = { managed: true, requireSpendGrant: true, requireRegisteredResource: mode === 'live_mainnet', mode, now: () => clock };
  const ledger = new PurchaseLedger(path, options); handles.add(ledger);
  if (mode === 'live_mainnet') {
    ledger.resources.add({ ...resource, displayName: 'Synthetic delivery fixture' });
    config = { ...config, registeredResources: ledger.resources.active() };
  }
  ledger.setDailyLimit('100000', mode); ledger.setPaused(false, mode);
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: crypto.randomUUID(), connectionGeneration: 1 };
  ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: clock + 600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: config.network, assetId: config.mint, assetDecimals: 6, payTo: recipient, paymentScheme: 'exact',
      ...(mode === 'live_mainnet' ? { postPolicyHash: postRequestPolicyHash(resource) } : {}) }, clock, mode);
  const authority = ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, clock, mode);
  const intent = createX402SpendIntent({ idempotencyKey: 'original-purchase', resource, challenge, environment, buyer: signer.address, authority, now: clock,
    ...(mode === 'live_mainnet' ? { reason: 'fixture recovery' } : {}) });
  const record = ledger.reserve(intent, challenge.accepts[0], clock, mode, principal.cardMemberId, ledger.paymentScope(config, mode));
  expect(record.status).toBe('APPROVED');
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(prepareSolanaPayment).mockImplementation(async (signedConfig, _signer, quote, beforeSign) => {
    beforeSign?.(); return { ...await signedPaymentFixture(signer, signedConfig, quote), resource: challenge.resource };
  });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE, confirmationStatus: 'finalized' });
  const initial = vi.fn<typeof fetch>().mockRejectedValue(new Error('Response lost')); vi.stubGlobal('fetch', initial);
  const paid = () => executeApprovedPayment(ledger, record.approvalId, config, resource.request.url);
  const retry = (fetcher: typeof fetch, activeLedger = ledger) => recoverApprovedPayment(activeLedger, intent.idempotencyKey, config,
    resource.request.url, undefined, principal.cardMemberId, { fetcher });
  const response = (receipt = true, body = '{"result":"original-data"}') => new Response(body, { headers: {
    'content-type': 'application/json', ...(receipt ? { 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true,
      network: config.network, payer: config.buyer, transaction: FIXTURE_TRANSACTION_SIGNATURE, amount: '10000' }) } : {}) } });
  return { ledger, record, get config() { return config; }, resource, intent, path, options, principal, paid, retry, initial, response,
    deactivate: (state: 'DISABLED' | 'REMOVED' = 'DISABLED') => {
      ledger.resources.setState(resource.resourceId, state);
      config = { ...config, registeredResources: ledger.resources.active() };
    },
    advance: (ms = 60_000) => { clock += ms; }, now: () => clock,
    reopen: () => { const reopened = new PurchaseLedger(path, options); handles.add(reopened); return reopened; } };
}

function reserveIndependentPurchase(f: Awaited<ReturnType<typeof fixture>>, requestId: string, principal: SpendPrincipal = f.principal,
  resource: X402Resource = { ...f.resource, resourceId: 'independent-result', request: { ...f.resource.request, url: 'https://independent.example/v1/result' } }) {
  if (!f.ledger.resources.list().some(entry => entry.definition.resourceId === resource.resourceId))
    f.ledger.resources.add({ ...resource, displayName: 'Independent fixture' });
  if (!f.ledger.activeSpendGrant(f.now(), principal.cardMemberId, 'live_mainnet', resource.resourceId))
    f.ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: f.now() + 600_000 }, principal,
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: f.config.network, assetId: f.config.mint, assetDecimals: 6, payTo: f.intent.payTo, paymentScheme: 'exact',
        postPolicyHash: postRequestPolicyHash(resource) }, f.now(), 'live_mainnet');
  const challenge = { ...f.intent.x402Challenge!, resource: { url: resource.request.url } };
  const intent = createX402SpendIntent({ idempotencyKey: requestId, resource, challenge, environment: f.config, buyer: f.config.buyer,
    authority: f.ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, f.now(), 'live_mainnet', resource.resourceId), now: f.now() });
  return f.ledger.reserve(intent, challenge.accepts[0], f.now(), 'live_mainnet', principal.cardMemberId, f.ledger.paymentScope(f.config, 'live_mainnet'));
}

it('keeps evidenced UNKNOWN money reserved while another member buys an independent resource', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  await expect(f.paid()).rejects.toThrow();
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  const other = { ...f.principal, cardMemberId: f.ledger.createCardMember('Independent member').id, connectionId: randomUUID() };
  const independent = reserveIndependentPurchase(f, 'independent', other);
  expect(independent.status).toBe('APPROVED');
  f.ledger.close(); const reopened = f.reopen();
  expect(reopened.claim(independent.approvalId, f.now(), undefined, 'live_mainnet').status).toBe('PAYING');
  expect(reopened.managedSummary(f.now(), 'live_mainnet')).toMatchObject({ reserved: '20000', paid: '0', remaining: '80000' });
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
  expect(reopened.savedOriginalPayment(f.record.approvalId)).toEqual(original);
  expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});

it('rechecks independent approvals against the retained UNKNOWN reservation and still serializes PAYING', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  const independent = reserveIndependentPurchase(f, 'preapproved');
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' }); await expect(f.paid()).rejects.toThrow();
  f.ledger.setDailyLimit('19999', 'live_mainnet');
  expect(() => f.ledger.claim(independent.approvalId, f.now(), undefined, 'live_mainnet')).toThrow('Daily limit');
  f.ledger.setDailyLimit('100000', 'live_mainnet');
  expect(f.ledger.claim(independent.approvalId, f.now(), undefined, 'live_mainnet').status).toBe('PAYING');
  const third = reserveIndependentPurchase(f, 'while-paying', f.principal,
    { ...f.resource, resourceId: 'third-result', request: { ...f.resource.request, url: 'https://third.example/result' } });
  expect(third.decision.reason).toBe('LEDGER_UNRESOLVED');
});

it('blocks replacement attempts for the same resource or an alias of the original HTTP request', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' }); await expect(f.paid()).rejects.toThrow();
  expect(reserveIndependentPurchase(f, 'replacement', f.principal, f.resource).decision.reason).toBe('LEDGER_UNRESOLVED');
  expect(reserveIndependentPurchase(f, 'alias', f.principal, { ...f.resource, resourceId: 'alias-result' }).decision.reason).toBe('LEDGER_UNRESOLVED');
  expect(reserveIndependentPurchase(f, 'changed-alias', f.principal, { ...f.resource, resourceId: 'changed-alias-result',
    request: { ...f.resource.request, url: f.resource.request.url + '?retry=1', body: '{"query":"replacement"}' } }).decision.reason).toBe('LEDGER_UNRESOLVED');
});

it('keeps legacy or invalid-evidence UNKNOWN payments blocking the scope rather than assuming a bounded transfer', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  f.ledger.claim(f.record.approvalId, f.now(), undefined, 'live_mainnet'); f.ledger.unknown(f.record.approvalId);
  expect(reserveIndependentPurchase(f, 'no-evidence').decision.reason).toBe('LEDGER_UNRESOLVED');
  expect(f.ledger.managedSummary(f.now(), 'live_mainnet')).toMatchObject({ reserved: '10000', unresolved: 1 });
});

it.each(['DISABLED', 'REMOVED'] as const)('recovers the same paid Mainnet order after resource %s and restart without new spending', async state => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet'); await expect(f.paid()).rejects.toThrow();
  const before = f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)!;
  expect(before).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING' });
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  const payload = f.ledger.savedPayload(f.record.approvalId);
  const summary = f.ledger.managedSummary(f.now(), 'live_mainnet');
  const grant = f.ledger.spendGrantSummary(f.now(), 'live_mainnet', f.principal.cardMemberId, f.resource.resourceId);
  f.deactivate(state);
  expect(f.config.registeredResources?.some(resource => resource.resourceId === f.resource.resourceId)).toBe(false);
  f.ledger.close(); const reopened = f.reopen(); reopened.recoverDeliveryClaimsOnStartup();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(f.response());
  await Promise.all([f.retry(fetcher, reopened), f.retry(fetcher, reopened)]);
  await f.retry(fetcher, reopened);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(f.intent.httpRequest!.url, expect.objectContaining({
    method: f.intent.httpRequest!.method, body: f.intent.httpRequest!.body, redirect: 'error',
  }));
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('PAYMENT-SIGNATURE'))
    .toBe(new Headers(f.initial.mock.calls[0][1]?.headers).get('PAYMENT-SIGNATURE'));
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({
    status: 'PAID', deliveryStatus: 'COMPLETE', transaction: before.transaction, paymentEvidence: before.paymentEvidence,
    intent: before.intent, data: { result: 'original-data' }, deliveryRecovery: { retryCount: 1 },
  });
  expect(reopened.savedOriginalPayment(f.record.approvalId)).toEqual(original);
  expect(reopened.savedPayload(f.record.approvalId)).toEqual(payload);
  expect(reopened.managedSummary(f.now(), 'live_mainnet')).toEqual(summary);
  expect(reopened.spendGrantSummary(f.now(), 'live_mainnet', f.principal.cardMemberId, f.resource.resourceId)).toEqual(grant);
  expect(reopened.events(f.intent.idempotencyKey, f.principal.cardMemberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
  expect(loadBuyerSigner).toHaveBeenCalledOnce(); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  expect(reconcileStoredOriginalPayment).toHaveBeenCalledOnce(); expect(f.initial).toHaveBeenCalledOnce();
});

it('rejects fresh purchases and unclaimed Mainnet approvals after disabling the resource, before any network or signer call', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  f.deactivate();
  const fetcher = vi.fn<typeof fetch>();
  await expect(requestRegisteredResourcePurchase({ requestId: 'new-after-disable', resourceId: f.resource.resourceId, reason: 'fixture' },
    { ledger: f.ledger, config: f.config, principal: f.principal, fetcher })).rejects.toThrow('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  await expect(f.paid()).rejects.toThrow('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  expect(f.ledger.get('new-after-disable', f.principal.cardMemberId)).toBeUndefined();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('APPROVED');
  expect(fetcher).not.toHaveBeenCalled(); expect(f.initial).not.toHaveBeenCalled();
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('replays an owned paid request through the purchase service after disablement and rejects changed resource identity', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet'); await expect(f.paid()).rejects.toThrow();
  f.deactivate();
  const input = { requestId: f.intent.idempotencyKey, resourceId: f.resource.resourceId, reason: 'fixture recovery' };
  const options = { ledger: f.ledger, config: f.config, principal: f.principal };
  await expect(requestRegisteredResourcePurchase({ ...input, resourceId: 'another-resource' }, options)).rejects.toThrow('REQUEST_ID_CONFLICT');
  expect(f.initial).toHaveBeenCalledOnce();
  f.initial.mockResolvedValue(f.response());
  expect(await requestRegisteredResourcePurchase(input, options)).toMatchObject({
    approvalId: f.record.approvalId, ownerCardMemberId: f.principal.cardMemberId,
    status: 'PAID', deliveryStatus: 'COMPLETE', transaction: FIXTURE_TRANSACTION_SIGNATURE,
  });
  await requestRegisteredResourcePurchase(input, options);
  expect(f.initial).toHaveBeenCalledTimes(2); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});

it('still refuses signing and submission for a claimed Mainnet approval after disabling the resource', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet');
  f.ledger.claim(f.record.approvalId, f.now(), undefined, 'live_mainnet');
  f.deactivate();
  expect(() => f.ledger.assertCanSign(f.record.approvalId)).toThrow('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  expect(() => f.ledger.markSubmissionAttempt(f.record.approvalId)).toThrow('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  expect(f.initial).not.toHaveBeenCalled(); expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('accepts the initial delivery if the resource is disabled after submission and before chain confirmation', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet'); f.initial.mockResolvedValue(f.response());
  vi.mocked(reconcileStoredOriginalPayment).mockImplementation(async () => {
    f.deactivate();
    return { status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE, confirmationStatus: 'finalized' };
  });
  await f.paid();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({
    status: 'PAID', deliveryStatus: 'COMPLETE', deliveryRecovery: { retryCount: 0 },
  });
  expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(f.initial).toHaveBeenCalledOnce();
});

it('inactive resource recovery cannot read another owner or send the original credential to another endpoint', async () => {
  const f = await fixture(TEST_CACHED_DELIVERY, 'live_mainnet'); await expect(f.paid()).rejects.toThrow();
  f.deactivate();
  const fetcher = vi.fn<typeof fetch>();
  const other = f.ledger.createCardMember('Other fixture member');
  await recoverApprovedPayment(f.ledger, f.intent.idempotencyKey, f.config, f.resource.request.url, undefined, other.id, { fetcher });
  expect(f.ledger.get(f.intent.idempotencyKey, other.id)).toBeUndefined();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({
    status: 'PAID', deliveryStatus: 'PENDING', deliveryRecovery: { retryCount: 0 },
  });
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  await recoverApprovedPayment(f.ledger, f.intent.idempotencyKey, f.config, 'https://unapproved.example/steal', undefined,
    f.principal.cardMemberId, { fetcher });
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({
    status: 'PAID', deliveryStatus: 'UNSUPPORTED', deliveryRecovery: { retryCount: 0, lastError: 'DELIVERY_RECOVERY_BINDING_INVALID' },
  });
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toEqual(original);
  expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce();
});

it('persists independent PAID, receipt CONFIRMED and delivered success without a delivery retry', async () => {
  const f = await fixture(); f.initial.mockResolvedValue(f.response());
  await f.paid();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'CONFIRMED', deliveryStatus: 'COMPLETE', deliveryRecovery: { retryCount: 0 } });
});
it('lost response remains paid and receipt unavailable until a later delivery-only retry succeeds', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'UNAVAILABLE', deliveryStatus: 'PENDING' });
  const retry = vi.fn<typeof fetch>().mockResolvedValue(f.response()); await f.retry(retry);
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'CONFIRMED', deliveryStatus: 'COMPLETE', deliveryRecovery: { retryCount: 1 } });
  const request = retry.mock.calls[0][1]; expect(request).toMatchObject({ method: 'POST', body: f.resource.request.body, redirect: 'error' });
  expect(request?.headers).toMatchObject({ 'PAYMENT-RECOVERY': '1', 'PAYMENT-SIGNATURE': f.initial.mock.calls[0][1]?.headers && new Headers(f.initial.mock.calls[0][1]?.headers).get('PAYMENT-SIGNATURE') });
  expect(loadBuyerSigner).toHaveBeenCalledOnce(); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  expect(reconcileStoredOriginalPayment).toHaveBeenCalledOnce();
});
it('valid delivery can be complete while the independent receipt remains unavailable', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  await f.retry(vi.fn<typeof fetch>().mockResolvedValue(f.response(false)));
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'UNAVAILABLE', deliveryStatus: 'COMPLETE' });
});
it('accepts a bounded JSON POST creation response with HTTP 201 as delivered data', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  await f.retry(vi.fn<typeof fetch>().mockResolvedValue(new Response('{"created":true}', {
    status: 201, headers: { 'content-type': 'application/json' },
  })));
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: { created: true } });
});
it('claims only one concurrent retry and repeated completed calls send no request', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  let release!: (response: Response) => void;
  const retry = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const first = f.retry(retry); await f.retry(retry);
  expect(retry).toHaveBeenCalledOnce(); expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryRecovery.retryCount).toBe(1);
  release(f.response()); await first; await f.retry(retry);
  expect(retry).toHaveBeenCalledOnce();
});
it('another SQLite handle cannot steal an active delivery claim', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const token = f.ledger.claimDelivery(f.record.approvalId, 'retry'); expect(token).toBeTypeOf('string');
  const other = f.reopen();
  expect(other.claimDelivery(f.record.approvalId, 'retry')).toBeUndefined();
  expect(other.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryRecovery.retryCount).toBe(1);
});
it('restart preserves consumed attempts, recovers an interrupted claim and rejects the stale owner', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const token = f.ledger.claimDelivery(f.record.approvalId, 'retry')!; f.ledger.close();
  const reopened = f.reopen(); reopened.recoverDeliveryClaimsOnStartup();
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING', deliveryRecovery: { retryCount: 1, lastError: 'DELIVERY_ATTEMPT_INTERRUPTED' } });
  expect(() => reopened.finish(f.record.approvalId, { transaction: FIXTURE_TRANSACTION_SIGNATURE, data: { stale: true } }, undefined, token)).toThrow('DELIVERY_CLAIM_MISMATCH');
  f.advance(); await f.retry(vi.fn<typeof fetch>().mockResolvedValue(f.response()), reopened);
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ deliveryStatus: 'COMPLETE', deliveryRecovery: { retryCount: 2 } });
});
it('four failed retries exhaust durably; requests and restart cannot reset the budget', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const retry = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable'));
  for (let i = 0; i < DELIVERY_RETRY_LIMIT; i++) { await f.retry(retry); f.advance(); }
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'EXHAUSTED', deliveryRecovery: { retryCount: 4 } });
  expect(f.ledger.pendingRecovery()).toEqual([]); await f.retry(retry);
  f.ledger.close(); const reopened = f.reopen(); reopened.recoverDeliveryClaimsOnStartup(); await f.retry(retry, reopened);
  expect(retry).toHaveBeenCalledTimes(4); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('a crash during the last attempt becomes exhausted without granting a fifth attempt', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  for (let i = 0; i < 3; i++) { await f.retry(vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable'))); f.advance(); }
  expect(f.ledger.claimDelivery(f.record.approvalId, 'retry')).toBeTypeOf('string'); f.ledger.close();
  const reopened = f.reopen(); reopened.recoverDeliveryClaimsOnStartup();
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ deliveryStatus: 'EXHAUSTED', deliveryRecovery: { retryCount: 4 } });
  expect(reopened.claimDelivery(f.record.approvalId, 'retry')).toBeUndefined();
});
it('backoff survives restart and repeated early calls do not consume another attempt', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow(); const retry = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable'));
  await f.retry(retry); const state = f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)!.deliveryRecovery;
  expect(state.nextAttemptAt).toBe(f.now() + 1000); f.ledger.close(); const reopened = f.reopen();
  await f.retry(retry, reopened); expect(retry).toHaveBeenCalledOnce();
  f.advance(1000); await f.retry(retry, reopened); expect(retry).toHaveBeenCalledTimes(2);
});
it.each([{ kind: 'none' } as const, null])('unsupported or absent capability never sends a delivery request', async capability => {
  const f = await fixture(capability); await expect(f.paid()).rejects.toThrow();
  const retry = vi.fn<typeof fetch>(); await f.retry(retry); await f.retry(retry);
  expect(retry).not.toHaveBeenCalled(); expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'UNSUPPORTED', deliveryRecovery: { retryCount: 0 } });
});
it('unknown payment never enters paid-delivery recovery or consumes an attempt', async () => {
  const f = await fixture(); vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  await expect(f.paid()).rejects.toThrow(); const retry = vi.fn<typeof fetch>(); await f.retry(retry);
  expect(retry).not.toHaveBeenCalled(); expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAYMENT_UNKNOWN', deliveryStatus: 'NOT_PAID', deliveryRecovery: { retryCount: 0 } });
  expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('delivery retry changes no daily paid/reserved/remaining amounts or grant commitment, even after pause/revocation', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const before = f.ledger.managedSummary(f.now(), 'live_devnet'); const grant = f.ledger.spendGrantSummary(f.now(), 'live_devnet', f.principal.cardMemberId);
  f.ledger.setPaused(true); f.ledger.revokeActiveSpendGrant(f.now());
  await f.retry(vi.fn<typeof fetch>().mockResolvedValue(f.response()));
  const after = f.ledger.managedSummary(f.now(), 'live_devnet'); const nextGrant = f.ledger.spendGrantSummary(f.now(), 'live_devnet', f.principal.cardMemberId);
  expect([after.paid, after.reserved, after.remaining]).toEqual([before.paid, before.reserved, before.remaining]);
  expect(nextGrant).toMatchObject({ committed: grant!.committed, remaining: grant!.remaining });
  expect(f.ledger.events(f.intent.idempotencyKey, f.principal.cardMemberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
});
it.each(['not json', ' '.repeat(16_385)])('malformed recovered delivery remains paid and consumes a bounded retry', async body => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow(); await f.retry(vi.fn<typeof fetch>().mockResolvedValue(f.response(true, body)));
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'CONFIRMED', deliveryStatus: 'PENDING', deliveryRecovery: { retryCount: 1 } });
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.data).toBeUndefined();
});
it.each(['[]', '1', '"text"'])('protocol-valid non-object JSON delivery survives recovery', async body => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  await f.retry(vi.fn<typeof fetch>().mockResolvedValue(f.response(true, body)));
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.data).toEqual(JSON.parse(body));
  expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('malformed/wrong transaction receipt cannot satisfy delivery and cannot erase confirmed payment', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const response = f.response(); response.headers.set('PAYMENT-RESPONSE', 'malformed'); await f.retry(vi.fn<typeof fetch>().mockResolvedValue(response));
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', receiptStatus: 'INVALID', deliveryStatus: 'PENDING' });
});
it('idempotent replay reuses the original signature without injecting a Demo recovery header', async () => {
  const f = await fixture({ kind: 'idempotent_replay' }); await expect(f.paid()).rejects.toThrow();
  const retry = vi.fn<typeof fetch>().mockResolvedValue(f.response()); await f.retry(retry);
  const headers = new Headers(retry.mock.calls[0][1]?.headers);
  expect(headers.has('PAYMENT-SIGNATURE')).toBe(true); expect(headers.has('PAYMENT-RECOVERY')).toBe(false);
  expect(headers.get('PAYMENT-SIGNATURE')).toBe(new Headers(f.initial.mock.calls[0][1]?.headers).get('PAYMENT-SIGNATURE'));
});
it.each(['query', 'header'] as const)('declared payment identifier lookup uses %s and sends no payment credential', async location => {
  const capability: DeliveryRecoveryCapability = { kind: 'payment_identifier', request: { url: 'https://api.provider.example/v1/cache',
    method: 'GET', access: 'https', headers: { accept: 'application/json' } }, identifier: 'transaction', location, name: 'payment-id' };
  const f = await fixture(capability); await expect(f.paid()).rejects.toThrow();
  const retry = vi.fn<typeof fetch>().mockResolvedValue(f.response(false)); await f.retry(retry);
  const [url, request] = retry.mock.calls[0]; expect(request?.method).toBe('GET'); const headers = new Headers(request?.headers);
  expect(headers.has('PAYMENT-SIGNATURE')).toBe(false); expect(headers.has('PAYMENT-RECOVERY')).toBe(false);
  expect(location === 'query' ? new URL(String(url)).searchParams.get('payment-id') : headers.get('payment-id')).toBe(FIXTURE_TRANSACTION_SIGNATURE);
  expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryStatus).toBe('COMPLETE'); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
});
it('capability request cannot change origin or weaken access', () => {
  expect(() => validateDeliveryCapability({ kind: 'payment_identifier', request: { url: 'https://other.provider.example/cache', method: 'GET', access: 'https', headers: {} },
    identifier: 'transaction', location: 'query', name: 'payment-id' }, { url: 'https://api.provider.example/data', access: 'https' })).toThrow('DELIVERY_RECOVERY_RESOURCE_MISMATCH');
});
it('SQL rejects retry reset and changing the persisted recovery capability', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow(); await f.retry(vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable')));
  const db = new DatabaseSync(f.path);
  try {
    expect(() => db.prepare('UPDATE purchase_delivery SET retry_count=0 WHERE purchase_id=?').run(f.intent.id)).toThrow('delivery retry count cannot reset');
    expect(() => db.prepare('UPDATE purchase_delivery SET capability=? WHERE purchase_id=?').run('{"kind":"idempotent_replay"}', f.intent.id)).toThrow('delivery capability is immutable');
  } finally { db.close(); }
});

it.each(['data', 'delivery', 'audit'] as const)('rolls back result, delivery claim and audit together when %s persistence fails', async failedWrite => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow();
  const token = f.ledger.claimDelivery(f.record.approvalId, 'retry')!;
  expect(token).toBeTruthy();
  const before = f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)!;
  const events = f.ledger.events(f.intent.idempotencyKey, f.principal.cardMemberId);
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  const db = new DatabaseSync(f.path);
  try {
    const statement = failedWrite === 'data' ? 'BEFORE UPDATE OF data ON purchases'
      : failedWrite === 'delivery' ? "BEFORE UPDATE OF state ON purchase_delivery WHEN NEW.state='COMPLETE'"
        : "BEFORE INSERT ON purchase_events WHEN NEW.type='delivery.COMPLETE'";
    db.exec(`CREATE TRIGGER fail_delivery_write ${statement} BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END`);
    expect(() => f.ledger.finish(f.record.approvalId, { transaction: FIXTURE_TRANSACTION_SIGNATURE, data: { original: true } }, undefined, token))
      .toThrow('fixture persistence failure');
    expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toEqual(before);
    expect(f.ledger.events(f.intent.idempotencyKey, f.principal.cardMemberId)).toEqual(events);
    expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toEqual(original);
    db.exec('DROP TRIGGER fail_delivery_write');
    // The same consumed claim can complete after the local write failure, without another HTTP/payment attempt.
    f.ledger.finish(f.record.approvalId, { transaction: FIXTURE_TRANSACTION_SIGNATURE, data: { original: true } }, undefined, token);
    expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE',
      data: { original: true }, deliveryRecovery: { retryCount: 1 } });
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  } finally { db.close(); }
});

it.each(['PAID', 'PAYMENT_UNKNOWN'] as const)('009 migration preserves the original %s row and financial/evidence bindings', async status => {
  const f = await fixture();
  if (status === 'PAYMENT_UNKNOWN') vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  await expect(f.paid()).rejects.toThrow(); f.ledger.close();
  const db = new DatabaseSync(f.path);
  const before = db.prepare('SELECT * FROM purchases').all();
  const grants = db.prepare('SELECT * FROM spend_grants').all();
  const original = db.prepare('SELECT * FROM original_payments').all();
  db.exec("DROP TRIGGER purchase_delivery_payment_state; DROP TABLE purchase_delivery; DELETE FROM ledger_schema_migrations WHERE id='009_durable_delivery_recovery'");
  db.close(); const reopened = f.reopen();
  expect(reopened.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status, deliveryStatus: status === 'PAID' ? 'PENDING' : 'NOT_PAID', deliveryRecovery: { retryCount: 0 } });
  const after = new DatabaseSync(f.path);
  try {
    expect(after.prepare('SELECT * FROM purchases').all()).toEqual(before);
    expect(after.prepare('SELECT * FROM spend_grants').all()).toEqual(grants);
    expect(after.prepare('SELECT * FROM original_payments').all()).toEqual(original);
    expect(after.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
  } finally { after.close(); }
});
it('backend automatically retries due paid deliveries after restart, even while payments are disabled', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow(); f.ledger.close();
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated'); vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '0');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', f.config.merchant);
  vi.stubEnv('DEMO_BUYER_PUBLIC_KEY', f.config.buyer); vi.stubEnv('YOSH_USE_PRODUCT_WALLET', '1');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(f.response());
  const app = new AppRuntime(join(f.path, '..'), { initializeWallet: async () => ({ address: f.config.buyer, reused: true }), now: f.now, fetcher });
  try {
    app.ledger.setPaused(true);
    await app.start('http://127.0.0.1:3049');
    expect(app.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryRecovery.retryCount).toBe(1);
    f.advance(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(app.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', deliveryRecovery: { retryCount: 2 } });
    expect(loadBuyerSigner).toHaveBeenCalledOnce(); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    await app.prepareQuit(); await vi.advanceTimersByTimeAsync(10_000); expect(fetcher).toHaveBeenCalledOnce();
  } finally { await app.prepareQuit(); app.close(); }
});
it('backend continuously reconciles UNKNOWN after RPC recovery without another purchase request or restart', async () => {
  const f = await fixture({ kind: 'none' });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' }); await expect(f.paid()).rejects.toThrow(); f.ledger.close();
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated'); vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '0');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', f.config.merchant);
  vi.stubEnv('DEMO_BUYER_PUBLIC_KEY', f.config.buyer); vi.stubEnv('YOSH_USE_PRODUCT_WALLET', '1');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn<typeof fetch>();
  const app = new AppRuntime(join(f.path, '..'), { initializeWallet: async () => ({ address: f.config.buyer, reused: true }), now: f.now, fetcher });
  try {
    app.ledger.setPaused(true);
    await app.start('http://127.0.0.1:3049');
    expect(app.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
    expect(reconcileStoredOriginalPayment).toHaveBeenCalledOnce(); // Startup must respect the persisted first backoff.
    vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
    f.advance(999); await vi.advanceTimersByTimeAsync(999); expect(reconcileStoredOriginalPayment).toHaveBeenCalledOnce();
    f.advance(1); await vi.advanceTimersByTimeAsync(1);
    expect(app.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('PAID');
    expect(app.ledger.managedSummary(f.now(), 'live_devnet')).toMatchObject({ paid: '10000', reserved: '0' });
    expect(fetcher).not.toHaveBeenCalled(); expect(prepareSolanaPayment).toHaveBeenCalledOnce();
    const count = vi.mocked(reconcileStoredOriginalPayment).mock.calls.length;
    await app.prepareQuit(); await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileStoredOriginalPayment).toHaveBeenCalledTimes(count);
  } finally { await app.prepareQuit(); app.close(); }
});
it('quit cancels an in-flight automatic chain read, retains the reservation, and schedules no more work', async () => {
  const f = await fixture({ kind: 'none' });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' }); await expect(f.paid()).rejects.toThrow(); f.ledger.close();
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated'); vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', '0'); vi.stubEnv('DEMO_MERCHANT_PUBLIC_KEY', f.config.merchant);
  vi.stubEnv('DEMO_BUYER_PUBLIC_KEY', f.config.buyer); vi.stubEnv('YOSH_USE_PRODUCT_WALLET', '1');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const app = new AppRuntime(join(f.path, '..'), { initializeWallet: async () => ({ address: f.config.buyer, reused: true }), now: f.now });
  let cancelled = false;
  try {
    await app.start('http://127.0.0.1:3049');
    vi.mocked(reconcileStoredOriginalPayment).mockImplementation((_config, _identity, _known, _observe, options) => new Promise(resolve => {
      options?.signal?.addEventListener('abort', () => { cancelled = true; resolve({ status: 'UNKNOWN' }); }, { once: true });
    }));
    f.advance(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(app.ledger.reconciliation.state(f.intent.id)?.claimed).toBe(true);
    await app.prepareQuit(); expect(cancelled).toBe(true);
    expect(app.ledger.reconciliation.state(f.intent.id)?.claimed).toBe(false);
    expect(app.ledger.managedSummary(f.now(), 'live_devnet')).toMatchObject({ reserved: '10000', paid: '0', unresolved: 1 });
    const count = vi.mocked(reconcileStoredOriginalPayment).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(reconcileStoredOriginalPayment).toHaveBeenCalledTimes(count);
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  } finally { await app.prepareQuit(); app.close(); }
});
it('cached-result retries never invoke the fixture token-transfer dispatcher a second time', async () => {
  const f = await fixture(); const transfer = vi.fn();
  f.initial.mockImplementation(async () => { transfer(); throw new Error('Transfer succeeded, response lost'); });
  await expect(f.paid()).rejects.toThrow();
  const originalHeader = new Headers(f.initial.mock.calls[0][1]?.headers).get('PAYMENT-SIGNATURE');
  const cache = vi.fn<typeof fetch>().mockImplementation(async (_url, request) => {
    const headers = new Headers(request?.headers);
    expect(headers.get('PAYMENT-RECOVERY')).toBe('1');
    expect(headers.get('PAYMENT-SIGNATURE')).toBe(originalHeader);
    // The declared fixture cache serves/reads this already paid result, never settles.
    throw new Error('Cache not available yet');
  });
  for (let i = 0; i < DELIVERY_RETRY_LIMIT; i++) { await f.retry(cache); f.advance(); }
  expect(transfer).toHaveBeenCalledOnce(); expect(cache).toHaveBeenCalledTimes(4);
  expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  expect(f.ledger.list()).toHaveLength(1); expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryStatus).toBe('EXHAUSTED');
});
it('rejects a test purchase with a Mainnet recovery environment before a delivery request or claim', async () => {
  const f = await fixture(); await expect(f.paid()).rejects.toThrow(); const fetcher = vi.fn<typeof fetch>();
  const mainnet = { ...f.config, ...resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' }) };
  await expect(recoverApprovedPayment(f.ledger, f.intent.idempotencyKey, mainnet, f.resource.request.url, undefined, f.principal.cardMemberId, { fetcher })).rejects.toThrow('PURCHASE_EXECUTION_MODE_MISMATCH');
  expect(fetcher).not.toHaveBeenCalled(); expect(f.ledger.get(f.intent.idempotencyKey, f.principal.cardMemberId)?.deliveryRecovery.retryCount).toBe(0);
});
