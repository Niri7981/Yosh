import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { type PaymentConfig } from '../../src/modules/payment/payment-config';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { requestMppResourcePurchase } from '../../src/modules/purchases/request-mpp-resource-purchase';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { type X402Resource } from '../../src/modules/resources/http-resource';
import { mppFixture } from '../helpers/mpp-fixture';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
const binary = process.env.YOSH_MPP_PROTOCOL_TEST_BINARY ?? resolve('build.noindex/mpp-protocol-engine/yosh-execution-protocol');
const ledgers: PurchaseLedger[] = [];
const directories: string[] = [];
afterEach(() => {
  ledgers.splice(0).forEach(ledger => ledger.close());
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
  vi.unstubAllGlobals(); vi.resetAllMocks();
});

async function fixture(options: {
  chainKnown?: boolean; merchantTimeout?: boolean; wrongReceipt?: boolean; invalidDelivery?: boolean;
  persistent?: boolean; recoveryLocation?: 'header' | 'query'; recoveryFailures?: number; concurrentQuotes?: number;
  omitExternalId?: boolean; distinctChallenges?: boolean; rejectRepeatedTransaction?: boolean;
  publicTransactionDelivery?: boolean;
} = {}) {
  const f = mppFixture(options.omitExternalId ? {} : { memo: 'sdk-purchase-fixture' });
  const resource: X402Resource = { paymentProtocol: 'mpp_solana_charge', resourceId: 'mpp-sdk-resource', providerId: 'fixture',
    request: { method: 'GET', url: 'http://127.0.0.1:19999/data', access: 'test_loopback', headers: { accept: 'application/json' } },
    network: f.config.network, mint: f.config.mint, decimals: 6, recipient: f.config.merchant, amount: f.quote.amount,
    deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 1024 },
    ...(options.recoveryLocation ? { deliveryRecovery: { kind: 'payment_identifier' as const,
      request: { method: 'GET' as const, url: 'http://127.0.0.1:19999/recover', access: 'test_loopback' as const, headers: { accept: 'application/json' } },
      identifier: 'transaction' as const, location: options.recoveryLocation, name: 'payment-id' } } : {}) };
  const config: PaymentConfig = { ...f.config, rpcUrl: 'https://rpc.fixture.invalid', registeredResources: [resource] };
  const directory = options.persistent ? mkdtempSync(join(tmpdir(), 'yosh-mpp-pipeline-')) : undefined;
  if (directory) directories.push(directory);
  const database = directory ? join(directory, 'ledger.sqlite') : ':memory:';
  let clockOffset = 0;
  const openLedger = () => new PurchaseLedger(database, { managed: true, requireSpendGrant: true, mode: 'live_devnet', now: () => Date.now() + clockOffset });
  let ledger = openLedger();
  ledgers.push(ledger);
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  ledger.setDailyLimit('1000000', 'live_devnet'); ledger.setPaused(false, 'live_devnet');
  ledger.createSpendGrant({ totalLimit: '1000000', singleLimit: '100000', expiresAt: Date.now() + 3_600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: config.network, assetId: config.mint, assetDecimals: 6, payTo: config.merchant,
      paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: '10001' }, Date.now(), 'live_devnet');
  const challenge = { ...f.quote.challenge, expires: new Date(Date.now() + 300_000).toISOString() };
  const issuedChallenges = new Map<string, typeof challenge>();
  const chainTransactions = new Map<string, string>();
  let wire: string | undefined; let signature: string | undefined;
  let chainKnown = options.chainKnown !== false;
  let afterSign: (() => void | Promise<void>) | undefined;
  let beforePaidResponse: (() => void | Promise<void>) | undefined;
  const signer = await createKeyPairSignerFromBytes(f.buyer.secretKey);
  const signTransactions = vi.fn<typeof signer.signTransactions>(async (...args) => {
    const signed = await signer.signTransactions(...args); await afterSign?.(); return signed;
  });
  vi.mocked(loadBuyerSigner).mockResolvedValue({ ...signer, signTransactions });
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
    owner, mint: config.mint, state: 'initialized', tokenAmount: { amount: '1000000', decimals: 6 },
  } } } });
  const rpcMethods: string[] = [];
  const rpc = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) !== config.rpcUrl) throw new Error('UNEXPECTED_NETWORK_TARGET');
    const request = z.object({ method: z.string(), id: z.union([z.string(), z.number()]), params: z.array(z.unknown()).optional() }).passthrough().parse(JSON.parse(String(init?.body)));
    rpcMethods.push(request.method);
    const confirmedWire = chainTransactions.get(String(request.params?.[0]));
    const results: Record<string, unknown> = {
      getGenesisHash: config.genesisHash,
      getLatestBlockhash: { value: { blockhash: f.lifetime.recentBlockhash, lastValidBlockHeight: Number(f.lifetime.lastValidBlockHeight) } },
      getMultipleAccounts: { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } }, token(config.buyer), token(config.merchant)] },
      isBlockhashValid: { value: true }, getFeeForMessage: { value: 5001 }, getBalance: { value: 100000 },
      simulateTransaction: { value: { err: null } }, getSignaturesForAddress: [],
      getTransaction: !chainKnown || !confirmedWire ? null : { transaction: [confirmedWire, 'base64'], meta: { err: null } },
    };
    if (!Object.hasOwn(results, request.method)) throw new Error('UNEXPECTED_RPC_METHOD');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
  });
  vi.stubGlobal('fetch', rpc);
  let quoteCalls = 0; let paidCalls = 0;
  const recoveryRequests: { url: string; identifier: string | null }[] = [];
  const quoteBarrier = Promise.withResolvers<void>();
  const merchant = vi.fn<typeof fetch>(async (url, init) => {
    const headers = new Headers(init?.headers);
    const target = new URL(String(url));
    if (options.recoveryLocation && target.origin + target.pathname === 'http://127.0.0.1:19999/recover') {
      expect(init?.method).toBe('GET');
      for (const forbidden of ['authorization', 'payment-authorization', 'payment-signature', 'cookie']) expect(headers.has(forbidden)).toBe(false);
      const identifier = options.recoveryLocation === 'query' ? target.searchParams.get('payment-id') : headers.get('payment-id');
      expect(identifier).toBe(signature);
      recoveryRequests.push({ url: target.href, identifier });
      if (recoveryRequests.length <= (options.recoveryFailures ?? 0)) return new Response(null, { status: 503 });
      const receipt = Buffer.from(JSON.stringify({ method: 'solana', status: 'success', timestamp: new Date().toISOString(), reference: signature })).toString('base64url');
      return Response.json({ result: 'offline identifier recovery fixture', ...(options.publicTransactionDelivery
        ? { transaction: signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` } : {}) }, { headers: { 'payment-receipt': receipt } });
    }
    if (target.href !== 'http://127.0.0.1:19999/data') throw new Error('UNEXPECTED_MERCHANT_TARGET');
    const authorization = headers.get('authorization');
    if (!authorization) {
      quoteCalls++;
      const offeredChallenge = { ...challenge, ...(options.distinctChallenges ? { id: `distinct-challenge-${quoteCalls}` } : {}) };
      issuedChallenges.set(offeredChallenge.id, offeredChallenge);
      const challengeHeader = 'Payment ' + Object.entries(offeredChallenge).map(([key, value]) => `${key}="${value}"`).join(', ');
      if (options.concurrentQuotes) {
        if (quoteCalls >= options.concurrentQuotes) quoteBarrier.resolve();
        await quoteBarrier.promise;
      }
      return new Response(null, { status: 402, headers: { 'www-authenticate': challengeHeader } });
    }
    paidCalls++;
    expect(authorization).toMatch(/^Payment /);
    const credential = z.object({ challenge: z.object({ id: z.string() }).passthrough(), payload: z.object({ type: z.literal('transaction'), transaction: z.string() }) })
      .parse(JSON.parse(Buffer.from(authorization.slice(8), 'base64url').toString()));
    expect(credential.challenge).toEqual(issuedChallenges.get(credential.challenge.id));
    wire = credential.payload.transaction;
    const transaction = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
    signature = getBase58Decoder().decode(transaction.signatures[0]);
    if (options.rejectRepeatedTransaction && chainTransactions.has(signature)) return Response.json({ error: 'payment_already_used' }, { status: 409 });
    chainTransactions.set(signature, wire);
    await beforePaidResponse?.();
    if (options.merchantTimeout) throw new Error('MOCK_SUBMISSION_TIMEOUT');
    const receipt = Buffer.from(JSON.stringify({ method: 'solana', status: 'success', timestamp: new Date().toISOString(),
      reference: options.wrongReceipt ? getBase58Decoder().decode(new Uint8Array(64).fill(7)) : signature })).toString('base64url');
    return options.invalidDelivery ? new Response('invalid delivery', { headers: { 'content-type': 'text/plain', 'payment-receipt': receipt } })
      : Response.json({ result: 'offline SDK purchase fixture', ...(options.publicTransactionDelivery
        ? { transaction: signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` } : {}) }, { headers: { 'payment-receipt': receipt } });
  });
  const input = { requestId: 'mpp-sdk-purchase', resourceId: resource.resourceId, reason: 'offline fixture' };
  const run = (override: Partial<typeof input> = {}) => requestMppResourcePurchase({ ...input, ...override }, {
    config, ledger, principal, dependencies: { binary, fetcher: merchant },
  });
  return { ...f, config, resource, get ledger() { return ledger; }, principal, signTransactions, rpcMethods, merchant, run, recoveryRequests, chainTransactions,
    onSigned(hook: () => void | Promise<void>) { afterSign = hook; },
    onPaidResponse(hook: () => void | Promise<void>) { beforePaidResponse = hook; },
    setChainKnown(value: boolean) { chainKnown = value; },
    advanceRecoveryClock() {
      clockOffset = Math.max(clockOffset, ledger.getOwned(input.requestId, principal.cardMemberId)!.deliveryRecovery.nextAttemptAt - Date.now() + 1);
    },
    reopen() {
      if (!directory) throw new Error('PERSISTENT_FIXTURE_REQUIRED');
      const index = ledgers.indexOf(ledger); ledger.close(); ledgers.splice(index, 1);
      ledger = openLedger(); ledgers.push(ledger);
      ledger.recoverUnsubmittedOnStartup(); ledger.recoverDeliveryClaimsOnStartup();
    },
    counts: () => ({ quoteCalls, paidCalls }), record: () => ledger.getOwned(input.requestId, principal.cardMemberId)!,
  };
}

it('runs 402 → official SDK transaction/credential → one verified payment and delivered resource', async () => {
  const f = await fixture();
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  const evidence = f.ledger.savedOriginalPayment(f.record().approvalId)!;
  expect(evidence.evidence.identity.protocol).toBe('mpp');
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  expect(f.rpcMethods).not.toContain('sendTransaction');
});

it('retains a sanitized pre-signing failure after service catch, retry and restart', async () => {
  const f = await fixture({ persistent: true });
  vi.mocked(loadBuyerSigner).mockRejectedValueOnce(new Error('private keychain error must never be returned'));
  const failed = await f.run();
  expect(failed).toMatchObject({ status: 'FAILED', paymentStatus: 'FAILED', transaction: null,
    failure: { failureStage: 'signer_load', failureCode: 'PAY_SIGNER_LOAD_FAILED', purchaseId: 'mpp-sdk-purchase' } });
  expect(JSON.stringify(failed)).not.toContain('private keychain');
  expect(f.signTransactions).not.toHaveBeenCalled(); expect(f.counts().paidCalls).toBe(0);
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)).toBeUndefined();
  f.reopen();
  expect(await f.run()).toEqual(failed);
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 0 });
});

it('retains UNKNOWN and its reservation after submission timeout, without another credential submission', async () => {
  const f = await fixture({ chainKnown: false, merchantTimeout: true });
  expect(await f.run()).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!;
  expect(await f.run()).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)?.evidence).toEqual(original.evidence);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: f.quote.amount, paid: '0' });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(f.counts().paidCalls).toBe(1);
});

it('recovers an original unknown payment after Grant revocation without another signature or payment', async () => {
  const f = await fixture({ chainKnown: false, merchantTimeout: true, recoveryLocation: 'query' });
  expect(await f.run()).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  f.ledger.revokeActiveSpendGrant(Date.now(), 'grant.REVOKED', f.principal.cardMemberId, f.resource.resourceId);
  f.setChainKnown(true);
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
});

it.each([false, true])('accepts the public confirmed transaction ID and explorer URL in valid delivery (identifier recovery: %s)', async recovery => {
  const f = await fixture({ publicTransactionDelivery: true,
    ...(recovery ? { recoveryLocation: 'header' as const, merchantTimeout: true } : {}) });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: recovery ? 'PENDING' : 'COMPLETE' });
  const transaction = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence.identity.buyerSignature;
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', transaction });
  expect(f.record().data).toMatchObject({ transaction, explorer: `https://explorer.solana.com/tx/${transaction}?cluster=devnet` });
  expect(f.recoveryRequests).toHaveLength(recovery ? 1 : 0);
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  await f.run();
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  expect(f.recoveryRequests).toHaveLength(recovery ? 1 : 0);
});

it.each([true, false])('rejects a distinct challenge that signs the same original transaction before credential egress (externalId absent: %s)', async omitExternalId => {
  const f = await fixture({ omitExternalId, distinctChallenges: true, rejectRepeatedTransaction: true });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  const secondInput = { requestId: 'distinct-request-same-transaction' };
  expect(await f.run(secondInput)).toMatchObject({ status: 'FAILED' });
  const second = f.ledger.getOwned(secondInput.requestId, f.principal.cardMemberId)!;
  expect(second.quote).toMatchObject({ challenge: { id: 'distinct-challenge-2' } });
  expect(f.record().quote).toMatchObject({ challenge: { id: 'distinct-challenge-1' } });
  expect(f.ledger.savedOriginalPayment(second.approvalId)).toBeUndefined();
  expect(f.ledger.savedMppPayment(second.approvalId)).toBeUndefined();
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence).toEqual(original);
  expect(f.signTransactions).toHaveBeenCalledTimes(2);
  expect(await f.signTransactions.mock.results[1].value).toEqual(await f.signTransactions.mock.results[0].value);
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 1 });
  expect(f.chainTransactions.size).toBe(1);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(f.ledger.listForAdministration().filter(item => item.status === 'PAID')).toHaveLength(1);
  // Even a now-different lifetime must not turn recovery of this failed purchase into a replacement.
  f.lifetime.recentBlockhash = Keypair.generate().publicKey.toBase58();
  expect(await f.run(secondInput)).toMatchObject({ status: 'FAILED' });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.signTransactions).toHaveBeenCalledTimes(2);
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 1 });
});

it.each([true, false])('keeps an UNKNOWN original reserved and denies another distinct challenge before signing (externalId absent: %s)', async omitExternalId => {
  const f = await fixture({ omitExternalId, chainKnown: false, merchantTimeout: true,
    distinctChallenges: true, rejectRepeatedTransaction: true });
  expect(await f.run()).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  expect(await f.run({ requestId: 'distinct-request-while-unknown' })).toMatchObject({ status: 'DENIED' });
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence).toEqual(original);
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 1 });
  expect(f.chainTransactions.size).toBe(1);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: f.quote.amount, paid: '0' });
});

it.each([true, false])('allows a distinct purchase with a new valid lifetime and different transaction (externalId absent: %s)', async omitExternalId => {
  const f = await fixture({ omitExternalId, distinctChallenges: true, rejectRepeatedTransaction: true });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  const first = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  f.lifetime.recentBlockhash = Keypair.generate().publicKey.toBase58();
  f.lifetime.lastValidBlockHeight = String(BigInt(f.lifetime.lastValidBlockHeight) + 1n);
  const secondInput = { requestId: 'distinct-request-new-transaction' };
  expect(await f.run(secondInput)).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  const second = f.ledger.getOwned(secondInput.requestId, f.principal.cardMemberId)!;
  const secondOriginal = f.ledger.savedOriginalPayment(second.approvalId)!.evidence;
  expect(secondOriginal.identity.buyerSignature).not.toBe(first.identity.buyerSignature);
  expect(f.chainTransactions.size).toBe(2);
  expect(f.signTransactions).toHaveBeenCalledTimes(2);
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 2 });
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: String(BigInt(f.quote.amount) * 2n) });
  await f.run(); await f.run(secondInput);
  expect(f.signTransactions).toHaveBeenCalledTimes(2);
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 2 });
});

it.each([true, false])('preserves the unresolved-payment authority gate for concurrent distinct challenges (externalId absent: %s)', async omitExternalId => {
  const f = await fixture({ omitExternalId, distinctChallenges: true, rejectRepeatedTransaction: true, concurrentQuotes: 2 });
  const results = await Promise.all([f.run(), f.run({ requestId: 'concurrent-distinct-request' })]);
  expect(results.map(result => result.status).sort()).toEqual(['DENIED', 'PAID']);
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 1 });
  expect(f.chainTransactions.size).toBe(1);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(f.ledger.listForAdministration().filter(item => item.status === 'PAID')).toHaveLength(1);
});

it.each([{ wrongReceipt: true }, { invalidDelivery: true }])('keeps paid delivery separate and never replaces payment for %j', async options => {
  const f = await fixture(options);
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'UNSUPPORTED' });
  await f.run();
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(f.counts().paidCalls).toBe(1);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
});

it('rejects Pause that wins during signing before any credential leaves the host', async () => {
  const f = await fixture(); f.onSigned(() => { f.ledger.setPaused(true, 'live_devnet'); });
  expect(await f.run()).toMatchObject({ status: 'FAILED' });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(f.counts().paidCalls).toBe(0);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet').reserved).toBe('0');
});

it('rejects immutable registration changes during signing and conflicting request replay', async () => {
  const f = await fixture(); f.onSigned(() => { f.resource.request.headers.accept = 'text/plain'; });
  expect(await f.run()).toMatchObject({ status: 'FAILED' });
  expect(f.counts().paidCalls).toBe(0);
  await expect(f.run({ reason: 'changed purpose' })).rejects.toThrow('REQUEST_ID_CONFLICT');
});

it.each([
  { recoveryLocation: 'header' as const, merchantTimeout: true },
  { recoveryLocation: 'query' as const, merchantTimeout: true },
  { recoveryLocation: 'header' as const, invalidDelivery: true },
  { recoveryLocation: 'query' as const, invalidDelivery: true },
])('recovers a paid order using only its declared identifier endpoint: %j', async options => {
  const f = await fixture(options);
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING' });
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  vi.mocked(loadBuyerSigner).mockRejectedValue(new Error('RECOVERY_MUST_NOT_OPEN_WALLET'));
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.record().deliveryRecovery.retryCount).toBe(1);
  expect(f.recoveryRequests).toHaveLength(1);
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence).toEqual(original);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  await f.run(); expect(f.recoveryRequests).toHaveLength(1);
});

it('reopens an UNKNOWN original payment, reconciles the saved signature, then recovers delivery without another signer', async () => {
  const f = await fixture({ persistent: true, recoveryLocation: 'header', merchantTimeout: true, chainKnown: false });
  expect(await f.run()).toMatchObject({ status: 'PAYMENT_UNKNOWN' });
  const payment = f.ledger.savedMppPayment(f.record().approvalId)!;
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  const walletIdentity = f.ledger.paymentScope(f.config, 'live_devnet');
  f.reopen();
  expect(f.ledger.paymentScope(f.config, 'live_devnet')).toEqual(walletIdentity);
  expect(f.record().status).toBe('PAYMENT_UNKNOWN');
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet').reserved).toBe(f.quote.amount);
  expect(f.ledger.savedMppPayment(f.record().approvalId)).toEqual(payment);
  expect(f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence).toEqual(original);
  vi.mocked(loadBuyerSigner).mockRejectedValue(new Error('RESTART_MUST_NOT_OPEN_WALLET'));
  f.setChainKnown(true);
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.recoveryRequests).toHaveLength(1);
  expect(f.record().transaction).toBe(original.identity.buyerSignature);
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.ledger.eventsForOwner(f.record().intent.idempotencyKey, f.principal.cardMemberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
});

it('persists retry count and backoff across restart, stops after four identifier requests, and never resends a credential', async () => {
  const f = await fixture({ persistent: true, recoveryLocation: 'query', invalidDelivery: true, recoveryFailures: 10 });
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING' });
  const original = f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence;
  vi.mocked(loadBuyerSigner).mockRejectedValue(new Error('RECOVERY_MUST_NOT_OPEN_WALLET'));
  for (let retry = 1; retry <= 4; retry++) {
    f.advanceRecoveryClock();
    expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: retry === 4 ? 'EXHAUSTED' : 'PENDING' });
    const persisted = f.record().deliveryRecovery;
    expect(persisted.retryCount).toBe(retry); expect(persisted.retryLimit).toBe(4);
    expect(f.recoveryRequests).toHaveLength(retry);
    f.reopen();
    expect(f.record().deliveryRecovery).toEqual(persisted);
    expect(f.ledger.savedOriginalPayment(f.record().approvalId)!.evidence).toEqual(original);
    // Neither reopening nor a client retry before the stored due time resets the backoff.
    await f.run(); expect(f.recoveryRequests).toHaveLength(retry);
  }
  f.advanceRecoveryClock(); await f.run();
  expect(f.record().deliveryStatus).toBe('EXHAUSTED'); expect(f.recoveryRequests).toHaveLength(4);
  expect(f.counts()).toEqual({ quoteCalls: 1, paidCalls: 1 });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
});

it('allows concurrent callers of the same request to produce only one signature, payment and ledger charge', async () => {
  const f = await fixture({ concurrentQuotes: 2 });
  const results = await Promise.all([f.run(), f.run()]);
  expect(results.some(result => result.status === 'PAID')).toBe(true);
  expect(await f.run()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ quoteCalls: 2, paidCalls: 1 });
  expect(f.ledger.listForAdministration()).toHaveLength(1);
  expect(f.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: f.quote.amount });
  expect(f.ledger.eventsForOwner(f.record().intent.idempotencyKey, f.principal.cardMemberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
});

it('does not let a concurrent retry discard the original in-flight paid response', async () => {
  const f = await fixture();
  const submitted = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  f.onPaidResponse(async () => { submitted.resolve(); await releaseResponse.promise; });
  const first = f.run();
  await submitted.promise;
  try {
    await f.run();
  } finally { releaseResponse.resolve(); }
  expect(await first).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
  expect(f.signTransactions).toHaveBeenCalledOnce(); expect(f.counts().paidCalls).toBe(1);
});
