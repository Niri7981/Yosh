import { postRequestPolicyHash } from '../../src/modules/resources/post-request-authorization';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, expect, it, vi } from 'vitest';
import { assertPaymentExecutionEnabled, resolvePaymentEnvironment, DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { loadPaymentConfig, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { checkPaymentBinding, executeApprovedPayment, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { requestRegisteredResourcePurchase } from '../../src/modules/purchases/request-registered-resource-purchase';
import { requestForPurchase } from '../../src/modules/purchases/request-registered-resource-purchase';
import { assertProductionPaymentGate } from '../../src/modules/purchases/production-execution-gate';
import { resourcePaymentBinding } from '../../src/modules/payment/resource-challenge';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import type { X402Resource } from '../../src/modules/resources/http-resource';
import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async original => ({
  ...await original<typeof import('../../src/modules/payment/solana-payment')>(), prepareSolanaPayment: vi.fn(),
}));
vi.mock('../../src/modules/payment/reconcile-transaction', async original => ({
  ...await original<typeof import('../../src/modules/payment/reconcile-transaction')>(), reconcileStoredOriginalPayment: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture(path = ':memory:') {
  const signer = await generateKeyPairSigner(); const recipient = await generateKeyPairSigner(); const sponsor = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1' });
  const resource: X402Resource & { recipient: string } = { resourceId: 'registered-data', providerId: 'provider', network: environment.network,
    mint: environment.asset.mint, decimals: 6, recipient: recipient.address, amount: '10000', deliveryRecovery: { kind: 'idempotent_replay' },
    request: { url: 'https://api.provider.example/v1/data', method: 'POST', access: 'https', headers: { 'content-type': 'application/json' }, body: '{"asset":"SOL"}' } };
  const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer: signer.address, merchant: recipient.address,
    facilitatorUrl: 'https://facilitator.example', registeredResources: [resource] };
  const ledger = new PurchaseLedger(path, { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  const scope = { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
    network: config.network, assetId: config.mint, assetDecimals: 6, payTo: resource.recipient, paymentScheme: 'exact', postPolicyHash: postRequestPolicyHash(resource) };
  const now = Date.now();
  const grantInput = { totalLimit: '100000', singleLimit: '10000', expiresAt: now + 3600_000 };
  const challenge = { x402Version: 2 as const, resource: { url: resource.request.url }, accepts: [{ scheme: 'exact', network: config.network,
    asset: config.mint, payTo: resource.recipient, amount: '10000', maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address } }] };
  const enableAuthority = () => {
    ledger.setDailyLimit('100000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
    ledger.createSpendGrant(grantInput, principal, scope, now, 'live_mainnet');
  };
  const request = (id: string, authority = ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet')) => {
    const intent = createX402SpendIntent({ idempotencyKey: id, resource, challenge, environment, buyer: config.buyer, authority, reason: 'fixture', now });
    return ledger.reserve(intent, challenge.accepts[0], now, 'live_mainnet', principal.cardMemberId, ledger.paymentScope(config, 'live_mainnet'));
  };
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(prepareSolanaPayment).mockImplementation(async (selected, _signer, quote, guard, authorized) => {
    guard?.();
    expect(selected.mode).toBe('live_mainnet'); expect(selected.merchant).toBe(recipient.address);
    return { ...await signedPaymentFixture(signer, selected, quote), resource: authorized?.challenge?.resource };
  });
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture response lost'));
  vi.stubGlobal('fetch', fetcher);
  return { signer, resource, config, ledger, principal, scope, grantInput, challenge, now, enableAuthority, request, fetcher };
}

it('requires an explicit unambiguous production enablement, with no cluster/wallet/resource inference', () => {
  for (const flag of [undefined, '', '0']) {
    const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: flag });
    expect(() => assertPaymentExecutionEnabled(environment)).toThrow('MAINNET_EXECUTION_DISABLED');
  }
  for (const flag of ['true', 'yes', ' 1', '01']) {
    expect(() => resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: flag })).toThrow('Invalid Yosh configuration');
  }
  expect(() => resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1', APP2049_ENABLE_MAINNET_EXECUTION: '0' })).toThrow('Conflicting');
  expect(() => resolvePaymentEnvironment({ YOSH_ENABLE_MAINNET_EXECUTION: '1' })).toThrow('production execution mode');
});

it('loads production wallet/resource facts with an optional validated facilitator override and no Demo fallback', async () => {
  const f = await fixture();
  try {
    const env = { YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1', YOSH_MAINNET_WALLET_PUBLIC_KEY: f.config.buyer,
      YOSH_MAINNET_RESOURCES: JSON.stringify([f.resource]), X402_FACILITATOR_URL: f.config.facilitatorUrl ?? undefined };
    expect(loadPaymentConfig(env, 'live_devnet', f.config.buyer)).toMatchObject(f.config);
    expect(() => loadPaymentConfig({ ...env, YOSH_MAINNET_WALLET_PUBLIC_KEY: undefined })).toThrow('Mainnet wallet identity');
    expect(() => loadPaymentConfig({ ...env, YOSH_MAINNET_RESOURCES: undefined }, 'live_devnet', f.config.buyer)).toThrow('MAINNET_RESOURCE_REGISTRATION_REQUIRED');
    expect(loadPaymentConfig({ ...env, X402_FACILITATOR_URL: undefined }, 'live_devnet', f.config.buyer).facilitatorUrl).toBeNull();
    expect(() => loadPaymentConfig({ ...env, X402_FACILITATOR_URL: 'http://facilitator.example' }, 'live_devnet', f.config.buyer)).toThrow('must use HTTPS');
    expect(() => loadPaymentConfig({ ...env, DEMO_MERCHANT_PUBLIC_KEY: f.resource.recipient })).toThrow('Demo configuration is forbidden');
    expect(() => loadPaymentConfig({ ...env, YOSH_MAINNET_RESOURCES: JSON.stringify([{ ...f.resource, mint: DEVNET_USDC_MINT }]) }, 'live_devnet', f.config.buyer)).toThrow('REGISTRATION_INVALID');
  } finally { f.ledger.close(); }
});

it('fresh Mainnet stays paused and unauthorized; explicit grant/limit creation does not inherit test controls or resume payments', async () => {
  const f = await fixture();
  try {
    f.ledger.setDailyLimit('999999', 'live_devnet'); f.ledger.setPaused(false, 'live_devnet');
    expect(f.ledger.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
    expect(f.request('missing-grant').decision.reason).toBe('SPEND_GRANT_REQUIRED');
    f.ledger.createSpendGrant(f.grantInput, f.principal, f.scope, f.now, 'live_mainnet');
    expect(f.request('missing-limit').decision.reason).toBe('PAYMENTS_PAUSED');
    f.ledger.setPaused(false, 'live_mainnet');
    expect(f.request('missing-daily').decision.reason).toBe('DAILY_LIMIT_NOT_SET');
    f.ledger.setPaused(true, 'live_mainnet');
    f.ledger.setDailyLimit('100000', 'live_mainnet');
    expect(f.ledger.controls('live_mainnet').paused).toBe(true);
    expect(f.ledger.controls('live_devnet').dailyBudget).toBe('999999');
    expect(() => f.ledger.createSpendGrant(f.grantInput, f.principal, f.scope, f.now)).toThrow('MAINNET_AUTHORITY_SCOPE_REQUIRED');
    expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['live_devnet', 'simulated'] as const)('%s grant cannot authorize Mainnet, even with explicit production enablement and daily authority', async mode => {
  const f = await fixture();
  try {
    f.ledger.setDailyLimit('100000', 'live_mainnet'); f.ledger.setPaused(false, 'live_mainnet');
    f.ledger.createSpendGrant(f.grantInput, f.principal, { ...f.scope, network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT }, f.now, mode);
    const binding = f.ledger.spendAuthority(f.principal, PAID_RESOURCE_PURCHASE_OPERATION, f.now, mode);
    const record = f.request('test-grant', binding);
    expect(record.decision.reason).toBe('SPEND_GRANT_MONETARY_SCOPE_MISMATCH');
    await expect(executeApprovedPayment(f.ledger, record.approvalId, f.config, f.resource.request.url)).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['provider', 'recipient', 'resource', 'daily', 'grant-total', 'single', 'paused'])( 'rejects wrong or insufficient Mainnet authority: %s', async condition => {
  const f = await fixture();
  try {
    f.enableAuthority();
    if (condition === 'daily') f.ledger.setDailyLimit('9999', 'live_mainnet');
    else if (condition === 'paused') f.ledger.setPaused(true, 'live_mainnet');
    else f.ledger.createSpendGrant({ ...f.grantInput, ...(condition === 'grant-total' ? { totalLimit: '9999', singleLimit: '9999' }
      : condition === 'single' ? { singleLimit: '9999' } : {}) }, f.principal,
      { ...f.scope, ...(condition === 'provider' ? { providerId: 'wrong' } : condition === 'resource' ? { resourceId: 'wrong' }
        : condition === 'recipient' ? { payTo: f.config.buyer } : {}) }, f.now, 'live_mainnet');
    const record = f.request(condition);
    expect(record.status).toBe('DENIED');
    await expect(executeApprovedPayment(f.ledger, record.approvalId, f.config, f.resource.request.url)).rejects.toThrow();
    expect(prepareSolanaPayment).not.toHaveBeenCalled(); expect(loadBuyerSigner).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['disabled', 'wallet', 'genesis', 'mint', 'recipient', 'unregistered', 'request'])( 'rejects altered production configuration before the signer: %s', async condition => {
  const f = await fixture();
  try {
    f.enableAuthority(); const record = f.request(condition);
    const changed: PaymentConfig = { ...f.config,
      ...(condition === 'disabled' ? { productionExecutionEnabled: false } : condition === 'wallet' ? { buyer: f.resource.recipient }
        : condition === 'genesis' ? { genesisHash: resolvePaymentEnvironment({}, 'live_devnet').genesisHash }
          : condition === 'mint' ? { mint: DEVNET_USDC_MINT } : {}),
      ...(condition === 'unregistered' ? { registeredResources: [] } : condition === 'recipient' ? { registeredResources: [{ ...f.resource, recipient: f.config.buyer }] }
        : condition === 'request' ? { registeredResources: [{ ...f.resource, request: { ...f.resource.request, body: 'changed' } }] } : {}) };
    await expect(executeApprovedPayment(f.ledger, record.approvalId, changed, f.resource.request.url)).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.ledger.get(condition, f.principal.cardMemberId)?.status).toBe('APPROVED');
  } finally { f.ledger.close(); }
});

it('fully valid registered Mainnet request reaches the shared execution boundary only once; unknown submission blocks other purchases and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mainnet-gate-')); const path = join(directory, 'ledger.sqlite');
  const f = await fixture(path); let closed = false;
  try {
    f.enableAuthority();
    const quoteFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(f.challenge) } }));
    expect(await requestRegisteredResourcePurchase({ requestId: 'original', resourceId: f.resource.resourceId, reason: 'fixture' },
      { config: f.config, ledger: f.ledger, principal: f.principal, fetcher: quoteFetch })).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
    const original = f.ledger.get('original', f.principal.cardMemberId)!;
    expect(original.status).toBe('PAYMENT_UNKNOWN');
    const evidence = f.ledger.savedOriginalPayment(original.approvalId)!;
    expect(evidence).toMatchObject({ state: 'OUTCOME_UNKNOWN', evidence: { monetaryScope: { environment: 'live_mainnet' }, identity: { payer: f.config.buyer, recipient: f.resource.recipient } } });
    expect(evidence.evidence.identity.buyerSignature).toBeTruthy();
    expect(f.ledger.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({ reserved: '10000', unresolved: 1 });
    expect(f.request('conflicting').decision.reason).toBe('LEDGER_UNRESOLVED');
    await expect(executeApprovedPayment(f.ledger, original.approvalId, f.config, f.resource.request.url)).rejects.toThrow();
    f.ledger.close(); closed = true;
    const reopened = new PurchaseLedger(path, { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
    try {
      reopened.recoverUnsubmittedOnStartup();
      expect(reopened.get('original', f.principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
      reopened.setPaused(true, 'live_mainnet');
      vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE, confirmationStatus: 'confirmed' });
      f.fetcher.mockClear();
      f.fetcher.mockResolvedValue(Response.json({ data: 'recovered using original credential' }));
      await recoverApprovedPayment(reopened, 'original', { ...f.config, productionExecutionEnabled: false }, f.resource.request.url, undefined, f.principal.cardMemberId);
      expect(reopened.get('original', f.principal.cardMemberId)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
      expect(reopened.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({ reserved: '0', paid: '10000', paused: true });
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.fetcher.mock.calls[0][1]?.headers).toHaveProperty('PAYMENT-SIGNATURE');
      expect(prepareSolanaPayment).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce(); expect(quoteFetch).toHaveBeenCalledOnce();
    } finally { reopened.close(); }
  } finally { if (!closed) f.ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('claim serializes independently approved Mainnet purchases before any signing', async () => {
  const f = await fixture();
  try {
    f.enableAuthority(); const first = f.request('first'); const second = f.request('second');
    f.ledger.claim(first.approvalId, undefined, undefined, 'live_mainnet');
    expect(() => f.ledger.claim(second.approvalId, undefined, undefined, 'live_mainnet')).toThrow('requires reconciliation');
    f.ledger.setDailyLimit('9999', 'live_mainnet');
    expect(() => f.ledger.assertCanSign(first.approvalId)).toThrow('no longer covers');
    expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it('activation migration quarantines pre-enablement Mainnet authority without moving test authority or changing payment records; fresh explicit authority survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mainnet-activation-')); const path = join(directory, 'ledger.sqlite');
  const f = await fixture(path); let closed = false;
  try {
    f.enableAuthority(); const record = f.request('pre-enablement');
    f.ledger.claim(record.approvalId); f.ledger.unknown(record.approvalId);
    f.ledger.setDailyLimit('456789', 'live_devnet');
    f.ledger.createSpendGrant(f.grantInput, f.principal, { ...f.scope, network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT }, f.now, 'live_devnet');
    const testGrant = f.ledger.spendGrantSummary(f.now, 'live_devnet', f.principal.cardMemberId);
    f.ledger.close(); closed = true;
    const db = new DatabaseSync(path);
    const rows = db.prepare('SELECT * FROM purchases').all();
    db.prepare("DELETE FROM ledger_schema_migrations WHERE id='010_mainnet_authority_activation'").run(); db.close();
    const migrated = new PurchaseLedger(path, { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
    try {
      expect(migrated.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
      expect(migrated.spendGrantSummary(f.now, 'live_mainnet', f.principal.cardMemberId)?.status).toBe('REVOKED');
      expect(migrated.controls('live_devnet').dailyBudget).toBe('456789');
      expect(migrated.spendGrantSummary(f.now, 'live_devnet', f.principal.cardMemberId)).toEqual(testGrant);
      const check = new DatabaseSync(path);
      expect(check.prepare('SELECT * FROM purchases').all()).toEqual(rows); check.close();
      expect(migrated.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({ reserved: '10000', unresolved: 1 });
      migrated.setDailyLimit('234567', 'live_mainnet'); migrated.setPaused(false, 'live_mainnet');
      migrated.createSpendGrant(f.grantInput, f.principal, f.scope, f.now, 'live_mainnet');
    } finally { migrated.close(); }
    const reopened = new PurchaseLedger(path, { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
    try {
      expect(reopened.controls('live_mainnet')).toMatchObject({ dailyBudget: '234567', paused: false });
      expect(reopened.spendGrantSummary(f.now, 'live_mainnet', f.principal.cardMemberId)?.status).toBe('ACTIVE');
      expect(reopened.get('pre-enablement', f.principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
    } finally { reopened.close(); }
  } finally { if (!closed) f.ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('challenge-derived recipients still enforce the Grant payee and immutable production payment gate', async () => {
  const f = await fixture(); f.enableAuthority();
  const { recipient, amount, ...base } = f.resource;
  expect(recipient).toBe(f.scope.payTo); expect(amount).toBe('10000');
  const resource: X402Resource = { ...base, recipientSource: 'live_challenge', maximumAmount: '10000' };
  const config: PaymentConfig = { ...f.config, merchant: '', registeredResources: [resource] };
  try {
    const { assertProductionPaymentGate } = await import('../../src/modules/purchases/production-execution-gate');
    const record = f.request('challenge-bound-approved');
    expect(() => assertProductionPaymentGate(f.ledger, record, config, resource.request.url)).not.toThrow();
    expect(() => assertProductionPaymentGate(f.ledger, record, { ...config, registeredResources: [{ ...resource, maximumAmount: '9999' }] }, resource.request.url)).toThrow();
    const changed = { ...f.challenge, accepts: [{ ...f.challenge.accepts[0], payTo: f.signer.address }] };
    const intent = createX402SpendIntent({ idempotencyKey: 'changed-live-recipient', resource, challenge: changed, environment: config,
      buyer: config.buyer, authority: f.ledger.spendAuthorityForDecision(f.principal, PAID_RESOURCE_PURCHASE_OPERATION, f.now, 'live_mainnet'), now: f.now });
    expect(f.ledger.reserve(intent, changed.accepts[0], f.now, 'live_mainnet', f.principal.cardMemberId,
      f.ledger.paymentScope(config, 'live_mainnet')).decision.reason).toBe('SPEND_GRANT_SCOPE_MISMATCH');
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['GET', 'POST'] as const)('production gate accepts only the registered dynamic %s request instance', async method => {
  const f = await fixture(); f.enableAuthority();
  try {
    const registered: X402Resource = { ...f.resource, request: { url: 'https://api.provider.example/v1/data', method,
      access: 'https', headers: method === 'POST' ? { 'content-type': 'application/json' } : {} },
      requestInputs: method === 'GET' ? { query: ['query'] } : { jsonBody: ['query'] } };
    if (method === 'POST') f.ledger.createSpendGrant(f.grantInput, f.principal, { ...f.scope, postPolicyHash: postRequestPolicyHash(registered) }, f.now, 'live_mainnet');
    const instance = requestForPurchase(registered, { requestId: 'dynamic', resourceId: registered.resourceId, reason: 'fixture',
      request: method === 'GET' ? { query: { query: 'SOL' } } : { jsonBody: { query: 'SOL' } } });
    const challenge = { ...f.challenge, resource: { url: registered.request.url } };
    const intent = createX402SpendIntent({ idempotencyKey: `dynamic-${method}`, resource: instance, challenge,
      environment: f.config, buyer: f.config.buyer, authority: f.ledger.spendAuthorityForDecision(f.principal,
        PAID_RESOURCE_PURCHASE_OPERATION, f.now, 'live_mainnet'), now: f.now });
    const record = f.ledger.reserve(intent, challenge.accepts[0], f.now, 'live_mainnet', f.principal.cardMemberId,
      f.ledger.paymentScope(f.config, 'live_mainnet'));
    const config = { ...f.config, registeredResources: [registered] };
    expect(() => assertProductionPaymentGate(f.ledger, record, config, instance.request.url)).not.toThrow();
    if (method === 'GET') expect(() => assertProductionPaymentGate(f.ledger, record, config, registered.request.url)).toThrow('MAINNET_RESOURCE_BINDING_MISMATCH');
    expect(() => assertProductionPaymentGate(f.ledger, record, { ...config, registeredResources: [{ ...registered,
      requestInputs: undefined }] }, instance.request.url)).toThrow();
  } finally { f.ledger.close(); }
});
it.each(['HEAD', 'PUT', 'PATCH', 'DELETE'] as const)('historical %s resource cannot reach the Mainnet execution boundary', async method => {
  const f = await fixture(); f.enableAuthority();
  try {
    const original = f.request(`historical-${method}`);
    const request = { ...f.resource.request, method, ...(method === 'HEAD' ? { body: undefined } : {}) };
    const historical = { ...f.resource, request };
    const record = { ...original, intent: { ...original.intent, httpRequest: request,
      executionBinding: resourcePaymentBinding(f.config, f.config.buyer, request, f.challenge, historical.deliveryRecovery) } };
    expect(() => assertProductionPaymentGate(f.ledger, record, { ...f.config, registeredResources: [historical] }, request.url))
      .toThrow('MAINNET_RESOURCE_METHOD_UNSUPPORTED');
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
    expect(f.ledger.get(original.intent.idempotencyKey, f.principal.cardMemberId)).toEqual(original);
  } finally { f.ledger.close(); }
});
it('accepts a 600-second route quote through the approval gate and expires it before signing', async () => {
  const f = await fixture(); f.enableAuthority();
  try {
    const registered: X402Resource = { ...f.resource, request: { url: 'https://api.you.com/v1/search',
      method: 'GET', access: 'https', headers: {} }, requestInputs: { query: ['query'] } };
    const instance = requestForPurchase(registered, { requestId: 'you-600', resourceId: registered.resourceId,
      reason: 'fixture', query: 'solana' });
    const challenge = { ...f.challenge, resource: { url: registered.request.url },
      accepts: [{ ...f.challenge.accepts[0], maxTimeoutSeconds: 600 }] };
    const intent = createX402SpendIntent({ idempotencyKey: 'you-600', resource: instance, challenge,
      environment: f.config, buyer: f.config.buyer, authority: f.ledger.spendAuthorityForDecision(f.principal,
        PAID_RESOURCE_PURCHASE_OPERATION, f.now, 'live_mainnet'), now: f.now });
    const record = f.ledger.reserve(intent, challenge.accepts[0], f.now, 'live_mainnet', f.principal.cardMemberId,
      f.ledger.paymentScope(f.config, 'live_mainnet'));
    const config = { ...f.config, registeredResources: [registered] };
    expect(() => checkPaymentBinding(record, config, instance.request.url)).not.toThrow();
    expect(() => assertProductionPaymentGate(f.ledger, record, config, instance.request.url)).not.toThrow();
    expect(() => f.ledger.claim(record.approvalId, f.now + 600_001, undefined, 'live_mainnet')).toThrow('Approval inactive or expired');
    expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['HEAD', 'PUT', 'PATCH', 'DELETE'] as const)('rejects historical %s definitions at Mainnet execution before signer access', async method => {
  const f = await fixture(); f.enableAuthority();
  try {
    const record = f.request(`unsupported-${method}`);
    const historical = { ...f.resource, request: { ...f.resource.request, method, ...(method === 'HEAD' ? { body: undefined } : {}) } };
    expect(() => assertProductionPaymentGate(f.ledger, record, { ...f.config, registeredResources: [historical] }, f.resource.request.url))
      .toThrow('MAINNET_RESOURCE_METHOD_UNSUPPORTED');
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});
