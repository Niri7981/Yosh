import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { acquireDataDirectoryOwnership } from '../../src/modules/app/data-directory-owner';
import { assertIsolatedPaymentDirectory, createIsolatedPayExecution } from '../../src/modules/payment/isolated-pay-execution';
import { createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import type { PaymentExecutionContext, PaymentExecutor } from '../../src/modules/payment/payment-execution-contract';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { executeApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import type { X402Resource } from '../../src/modules/resources/http-resource';
import { signedPaymentFixture } from '../helpers/signed-payment-fixture';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async original => ({
  ...await original<typeof import('../../src/modules/payment/solana-payment')>(), prepareSolanaPayment: vi.fn(),
}));
vi.mock('../../src/modules/payment/reconcile-transaction', () => ({ reconcileStoredOriginalPayment: vi.fn() }));

const ledgers = new Set<PurchaseLedger>();
const directories: string[] = [];
const executions = new Set<ReturnType<typeof createIsolatedPayExecution>>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
});
afterEach(() => {
  for (const execution of executions) execution.close();
  executions.clear();
  for (const ledger of ledgers) ledger.close();
  ledgers.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function barrier() {
  let release: () => void = () => { throw new Error('BARRIER_NOT_INITIALIZED'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** These tests keep real production Grant/reserve/claim/state transitions. The
 * wallet loader, JS builder and chain result are isolated boundary substitutes. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-pay-boundary-'));
  directories.push(directory); chmodSync(directory, 0o700);
  const signer = await generateKeyPairSigner();
  const merchant = (await generateKeyPairSigner()).address;
  const sponsor = (await generateKeyPairSigner()).address;
  const now = Date.now();
  const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_DEVNET_PURCHASES: '1',
    SOLANA_RPC_URL: 'https://rpc.pay-boundary.invalid', DEMO_BUYER_PUBLIC_KEY: signer.address,
    DEMO_MERCHANT_PUBLIC_KEY: merchant });
  const endpoint = 'http://127.0.0.1:19492/boundary';
  const ledger = new PurchaseLedger(join(directory, 'ledger.sqlite'), { managed: true, requireSpendGrant: true,
    mode: 'live_devnet', now: () => now, timeZone: () => 'UTC' });
  ledgers.add(ledger);
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  const resource: X402Resource = { resourceId: 'pay-boundary', providerId: 'pay-boundary-provider',
    network: config.network, mint: config.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '10000',
    deliveryRecovery: { kind: 'none' }, request: { url: endpoint, method: 'GET', access: 'test_loopback', headers: {} } };
  ledger.setDailyLimit('100000', config.mode);
  ledger.setPaused(false, config.mode);
  ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: now + 600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: config.network, assetId: config.mint, assetDecimals: 6, payTo: merchant, paymentScheme: 'exact' }, now, config.mode);
  const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '10000', payTo: merchant,
    maxTimeoutSeconds: 300, extra: { feePayer: sponsor, memo: 'pay-boundary-offline-fixture' } };
  const challenge = { x402Version: 2 as const, resource: { url: endpoint }, accepts: [quote] };
  const authority = ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, config.mode);
  const intent = createX402SpendIntent({ idempotencyKey: 'pay-boundary-original', resource, challenge,
    environment: config, buyer: signer.address, authority, now });
  const record = ledger.reserve(intent, quote, now, config.mode, principal.cardMemberId, ledger.paymentScope(config, config.mode));
  expect(record.status).toBe('APPROVED');
  function execution(hooks?: Parameters<typeof createIsolatedPayExecution>[0]['hooks']) {
    const result = createIsolatedPayExecution({ directory, enginePath: '/nonexistent/never-invoked-pay-engine',
      merchantOrigin: endpoint, rpcUrl: 'http://127.0.0.1:19493', signer, ...(hooks ? { hooks } : {}) });
    executions.add(result);
    return result;
  }
  function context(): PaymentExecutionContext {
    return { config, record: ledger.claim(record.approvalId, now, undefined, config.mode), endpoint,
      beforeSign: () => ledger.assertCanSign(record.approvalId) };
  }
  return { directory, ledger, signer, config, endpoint, record, principal, quote, challenge, execution, context };
}

it('a custom preparation failure cannot fall back to the JS builder or wallet', async () => {
  const f = await fixture();
  const executor = { assertEligibility: vi.fn(), prepare: vi.fn(async () => { throw new Error('CONTROLLED_PREPARE_REJECTED'); }),
    assertBeforeSubmission: vi.fn() } satisfies PaymentExecutor;
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint, undefined, executor)).rejects.toThrow('Payment stopped');
  expect(executor.assertEligibility).toHaveBeenCalledExactlyOnceWith(f.config, f.ledger);
  expect(executor.prepare).toHaveBeenCalledOnce();
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  expect(executor.assertBeforeSubmission).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(f.ledger.getOwned(f.record.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('FAILED');
  expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  expect(f.ledger.eventsForOwner(f.record.intent.idempotencyKey, f.principal.cardMemberId).map(event => event.type)).not.toContain('payment.SUBMISSION_ATTEMPTED');
});

it('custom admission failure leaves the real reservation unclaimed', async () => {
  const f = await fixture(); const claim = vi.spyOn(f.ledger, 'claim');
  const executor = { assertEligibility() { throw new Error('ISOLATED_ONLY'); }, prepare: vi.fn(),
    assertBeforeSubmission: vi.fn() } satisfies PaymentExecutor;
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint, undefined, executor)).rejects.toThrow('ISOLATED_ONLY');
  expect(claim).not.toHaveBeenCalled(); expect(executor.prepare).not.toHaveBeenCalled();
  expect(f.ledger.getOwned(f.record.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('APPROVED');
  expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('omitting the executor still invokes the original JS wallet and builder', async () => {
  const f = await fixture(); vi.mocked(loadBuyerSigner).mockResolvedValue(f.signer);
  vi.mocked(prepareSolanaPayment).mockRejectedValue(new Error('OFFLINE_JS_BUILDER_STOP'));
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint)).rejects.toThrow('Payment stopped');
  expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(prepareSolanaPayment).toHaveBeenCalledWith(f.config, f.signer, f.quote, expect.any(Function),
    { amount: f.quote.amount, resource: f.endpoint, challenge: f.challenge }, expect.any(Function));
  expect(fetcher).not.toHaveBeenCalled();
});

it('unsafe permissions, symlinks and non-test execution cannot admit the isolated factory', async () => {
  const f = await fixture();
  chmodSync(f.directory, 0o755);
  expect(f.execution).toThrow('PAY_EXECUTOR_PRIVATE_TEMP_DIRECTORY_REQUIRED');
  chmodSync(f.directory, 0o700);
  const link = join(f.directory, 'linked-directory'); symlinkSync(f.directory, link);
  expect(() => assertIsolatedPaymentDirectory(link)).toThrow('PAY_EXECUTOR_PRIVATE_TEMP_DIRECTORY_REQUIRED');
  expect(() => assertIsolatedPaymentDirectory(process.cwd())).toThrow('PAY_EXECUTOR_PRIVATE_TEMP_DIRECTORY_REQUIRED');
  vi.stubEnv('NODE_ENV', 'production');
  expect(f.execution).toThrow('PAY_EXECUTOR_PRODUCTION_BLOCKED');
});

it('runtime binding, Mainnet and public RPC configurations fail before claim or signing', async () => {
  const f = await fixture(); const execution = f.execution();
  expect(() => execution.executor.assertEligibility(f.config, f.ledger)).toThrow('PAY_EXECUTOR_RUNTIME_BINDING_REQUIRED');
  execution.executor.bindRuntime?.(f.directory, f.ledger);
  expect(() => execution.executor.assertEligibility(f.config, f.ledger)).not.toThrow();
  expect(() => execution.executor.bindRuntime?.(f.directory, f.ledger)).toThrow('PAY_EXECUTOR_RUNTIME_BINDING_REQUIRED');
  const mainnet = resolvePaymentEnvironment({ YOSH_ENABLE_MAINNET_EXECUTION: '1' }, 'live_mainnet');
  expect(() => execution.executor.assertEligibility({ ...f.config, ...mainnet, mint: mainnet.asset.mint }, f.ledger)).toThrow('PAY_EXECUTOR_ISOLATED_CONFIGURATION_REQUIRED');
  expect(() => execution.executor.assertEligibility({ ...f.config, rpcUrl: 'https://api.devnet.solana.com' }, f.ledger)).toThrow('PAY_EXECUTOR_ISOLATED_CONFIGURATION_REQUIRED');
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(f.ledger.getOwned(f.record.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('APPROVED');
});

it('one owner controls a directory and retired instances cannot act after replacement', async () => {
  const f = await fixture(); const first = f.execution();
  first.executor.bindRuntime?.(f.directory, f.ledger);
  expect(f.execution).toThrow('PAY_EXECUTOR_OWNER_EXISTS');
  const owner = acquireDataDirectoryOwnership(f.directory);
  try { expect(() => acquireDataDirectoryOwnership(f.directory)).toThrow('DATA_DIRECTORY_IN_USE'); }
  finally { owner.release(); }
  first.close();
  const replacement = f.execution(); replacement.executor.bindRuntime?.(f.directory, f.ledger);
  expect(() => first.executor.assertEligibility(f.config, f.ledger)).toThrow('PAY_EXECUTOR_STALE_OWNER');
  await expect(first.quoteFetcher(f.endpoint)).rejects.toThrow('PAY_EXECUTOR_STALE_OWNER');
  expect(() => replacement.executor.assertEligibility(f.config, f.ledger)).not.toThrow();
  expect(first.calls).toEqual({ quote: 0, prepare: 0, interpret: 0 });
});

it('Pause then Resume permanently fences an unfinished preparation and duplicate operation', async () => {
  const f = await fixture(); const waiting = barrier();
  const execution = f.execution({ beforePrepare: () => waiting.promise });
  execution.executor.bindRuntime?.(f.directory, f.ledger);
  const context = f.context();
  execution.executor.beginPreparation?.(context);
  const pending = execution.executor.prepare(context);
  await expect(execution.executor.prepare(context)).rejects.toThrow('PAY_EXECUTOR_OPERATION_ALREADY_PREPARED');
  f.ledger.setPaused(true, f.config.mode); execution.invalidate(); f.ledger.setPaused(false, f.config.mode);
  const stopped = expect(pending).rejects.toThrow('PAY_EXECUTOR_STALE_GENERATION');
  waiting.release(); await stopped;
  expect(execution.calls).toEqual({ quote: 0, prepare: 0, interpret: 0 });
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(() => execution.executor.assertBeforeSubmission(context)).toThrow('PAY_EXECUTOR_STALE_GENERATION');
});

it('merchant signature echoes stay inside Yosh and interpreter failure still reconciles the original', async () => {
  const f = await fixture();
  const payload = { ...await signedPaymentFixture(f.signer, f.config, f.quote), resource: f.challenge.resource };
  const identity = createSignedPaymentIdentity(payload, f.config);
  const executor = { assertEligibility: vi.fn(), prepare: vi.fn(async () => ({ payload })), assertBeforeSubmission: vi.fn(),
    interpretResponse: vi.fn<NonNullable<PaymentExecutor['interpretResponse']>>(async () => { throw new Error('PROTOCOL_OBSERVATION_FAILURE'); }) } satisfies PaymentExecutor;
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200, headers: { 'payment-response':
    Buffer.from(JSON.stringify({ success: true, network: f.config.network, payer: f.config.buyer,
      amount: f.quote.amount, transaction: identity.buyerSignature, extra: { signedWire: payload.payload.transaction } })).toString('base64') } }));
  vi.stubGlobal('fetch', fetcher);
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, f.endpoint, undefined, executor)).rejects.toThrow('Payment stopped');
  expect(executor.interpretResponse).toHaveBeenCalledOnce();
  const observation = executor.interpretResponse.mock.calls[0]?.[0];
  expect(observation).toBeDefined();
  const encoded = observation?.paymentResponse;
  if (!encoded) throw new Error('SAFE_OBSERVATION_REQUIRED');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  expect(decoded).toEqual({ success: true, network: f.config.network, payer: f.config.buyer, amount: f.quote.amount });
  expect(JSON.stringify(observation)).not.toContain(identity.buyerSignature);
  expect(JSON.stringify(observation)).not.toContain(payload.payload.transaction);
  expect(reconcileStoredOriginalPayment).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce(); expect(executor.prepare).toHaveBeenCalledOnce();
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)?.state).toBe('OUTCOME_UNKNOWN');
  expect(f.ledger.getOwned(f.record.intent.idempotencyKey, f.principal.cardMemberId)?.status).toBe('PAYMENT_UNKNOWN');
  expect(f.ledger.getOwned(f.record.intent.idempotencyKey, f.principal.cardMemberId)?.data).toBeUndefined();
});
