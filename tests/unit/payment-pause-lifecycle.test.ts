import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage, type RequestOptions } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createKeyPairSignerFromBytes, getBase58Decoder, getBase64EncodedWireTransaction } from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { PaymentPayload } from '@x402/core/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Keep the same fake RPC fetch identity at module initialization and execution.
// Otherwise safe-resource-fetch's test-only injected-fetch shortcut skips DNS.
const transport = vi.hoisted(() => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, lookup: vi.fn(), request: vi.fn() };
});
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ request: transport.request }));
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));

import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { createSignedPaymentIdentity, transactionMessageHash } from '../../src/modules/payment/original-payment-evidence';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { resolvePaymentEnvironment, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { paymentSignatureHeaders } from '../../src/modules/payment/x402-client';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { executeApprovedPayment, reconcileApprovedPayment, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';
import type { X402Resource } from '../../src/modules/resources/http-resource';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const handles = new Set<PurchaseLedger>();
const directories: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', transport.fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const ledger of handles) ledger.close();
  handles.clear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function fixture(options: { holdWallet?: boolean; holdSigner?: boolean; holdDns?: boolean; holdHttp?: boolean } = {}) {
  const now = Date.now();
  const buyer = Keypair.generate();
  const feePayer = Keypair.generate();
  const recipient = Keypair.generate().publicKey.toBase58();
  const ephemeral = await createKeyPairSignerFromBytes(buyer.secretKey);
  // Mainnet is only a metadata/policy fixture: every network boundary is fake.
  const environment = resolvePaymentEnvironment({ YOSH_ENABLE_MAINNET_EXECUTION: '1', YOSH_MAINNET_RPC_URL: 'https://rpc.pause.invalid' }, 'live_mainnet');
  const resource: X402Resource = { resourceId: 'pause-lifecycle-fixture', providerId: 'pause-fixture-provider', network: environment.network,
    mint: environment.asset.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '10000', deliveryRecovery: { kind: 'none' },
    request: { url: 'https://merchant.pause.invalid/result', method: 'GET', access: 'https', headers: { accept: 'application/json' } } };
  const dir = mkdtempSync(join(tmpdir(), 'yosh-pause-lifecycle-'));
  directories.push(dir);
  const path = join(dir, 'ledger.sqlite');
  const ledgerOptions = { managed: true, requireSpendGrant: true, requireRegisteredResource: true, mode: 'live_mainnet' as const,
    walletIdentity: ephemeral.address, now: () => now, timeZone: () => 'UTC' };
  const open = () => { const ledger = new PurchaseLedger(path, ledgerOptions); handles.add(ledger); return ledger; };
  const ledger = open();
  ledger.resources.add({ ...resource, displayName: 'Offline Pause regression fixture' });
  const config: PaymentConfig = { ...environment, buyer: ephemeral.address, mint: environment.asset.mint, merchant: recipient,
    facilitatorUrl: null, registeredResources: ledger.resources.active() };
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  ledger.setDailyLimit('100000', config.mode);
  ledger.setPaused(false, config.mode);
  ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: now + 600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: config.network, assetId: config.mint, assetDecimals: 6, payTo: recipient, paymentScheme: 'exact' }, now, config.mode);
  const authority = ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, config.mode);
  const quote = { scheme: 'exact', network: config.network, asset: config.mint, payTo: recipient, amount: '10000', maxTimeoutSeconds: 300,
    extra: { feePayer: feePayer.publicKey.toBase58(), memo: 'pause:ABCDEFGHIJKLMNOPQRSTUV' } };
  const challenge = { x402Version: 2 as const, resource: { url: resource.request.url }, accepts: [quote] };
  const intent = createX402SpendIntent({ idempotencyKey: 'pause-original', resource, challenge, environment, buyer: config.buyer, authority, now });
  const reserve = (target = ledger, key = intent.idempotencyKey) => target.reserve({ ...intent, id: key === intent.idempotencyKey ? intent.id : randomUUID(), idempotencyKey: key },
    quote, now, config.mode, principal.cardMemberId, ledger.paymentScope(config, config.mode));
  const record = reserve();
  expect(record.status).toBe('APPROVED');
  const walletEntered = barrier(); const walletRelease = barrier();
  const signerEntered = barrier(); const signerRelease = barrier();
  const dnsEntered = barrier(); const dnsRelease = barrier();
  const httpEntered = barrier(); const httpRelease = barrier();
  if (!options.holdWallet) walletRelease.resolve();
  if (!options.holdSigner) signerRelease.resolve();
  if (!options.holdDns) dnsRelease.resolve();
  if (!options.holdHttp) httpRelease.resolve();
  let completedSignatures = 0;
  let signedWire: string | undefined;
  const signTransactions = vi.fn<typeof ephemeral.signTransactions>(async (transactions, signingConfig) => {
    signerEntered.resolve();
    await signerRelease.promise;
    const signatures = await ephemeral.signTransactions(transactions, signingConfig);
    expect(transactions).toHaveLength(1);
    signedWire = getBase64EncodedWireTransaction({ ...transactions[0], signatures: { ...transactions[0].signatures, ...signatures[0] } });
    completedSignatures++;
    return signatures;
  });
  const signer = { ...ephemeral, signTransactions };
  vi.mocked(loadBuyerSigner).mockImplementation(async () => { walletEntered.resolve(); await walletRelease.promise; return signer; });
  const blockhash = Keypair.generate().publicKey.toBase58();
  const rpcCalls: string[] = [];
  const RpcRequest = z.object({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.array(z.unknown()).default([]) });
  let settled: { signature: string; wire: string } | undefined;
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { owner, mint: config.mint,
    state: 'initialized', tokenAmount: { amount: '100000', decimals: 6 } } } } });
  transport.fetcher.mockImplementation(async (input, init) => {
    if (String(input) !== config.rpcUrl) throw new Error('Unexpected external destination in offline fixture');
    const request = RpcRequest.parse(JSON.parse(String(init?.body)));
    rpcCalls.push(request.method);
    let result: unknown;
    switch (request.method) {
      case 'getGenesisHash': result = config.genesisHash; break;
      case 'getMultipleAccounts': result = { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
        token(config.buyer), token(recipient)] }; break;
      case 'getBalance': result = { value: 100000 }; break;
      case 'getAccountInfo': {
        const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
        result = { context: { slot: 1 }, value: { owner: TOKEN_PROGRAM, data: [mint.toString('base64'), 'base64'],
          lamports: 1, executable: false, rentEpoch: 0, space: 82 } }; break;
      }
      case 'getLatestBlockhash': result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 123456 } }; break;
      case 'simulateTransaction': result = { value: { err: null } }; break;
      case 'getTransaction':
        expect(settled, 'chain read requires the original fake merchant exchange').toBeDefined();
        expect(request.params[0]).toBe(settled?.signature);
        result = settled ? { transaction: [settled.wire, 'base64'], meta: { err: null } } : null; break;
      case 'getSignaturesForAddress': result = []; break;
      default: throw new Error('Unexpected RPC method: ' + request.method);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  transport.lookup.mockImplementation(async () => {
    dnsEntered.resolve(); await dnsRelease.promise;
    return [{ address: '8.8.8.8', family: 4 }];
  });
  transport.request.mockImplementation((url: URL, requestOptions: RequestOptions, receive: (incoming: IncomingMessage) => void) => {
    expect(url.href).toBe(resource.request.url);
    const payload = ledger.savedPayload(record.approvalId);
    if (!payload || typeof payload.payload.transaction !== 'string') throw new Error('Merchant requires original persisted credential');
    expect(ledger.savedOriginalPayment(record.approvalId)?.state).toBe('SUBMISSION_ATTEMPTED');
    const headers = new Headers(requestOptions.headers as Record<string, string>);
    expect(headers.get('PAYMENT-SIGNATURE')).toBe(new Headers(paymentSignatureHeaders(payload)).get('PAYMENT-SIGNATURE'));
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, 'base64'));
    tx.sign([feePayer]);
    settled = { signature: getBase58Decoder().decode(tx.signatures[0]), wire: Buffer.from(tx.serialize()).toString('base64') };
    const outgoing = new PassThrough();
    outgoing.on('finish', () => {
      void httpRelease.promise.then(() => {
        const incoming = new IncomingMessage(new Socket());
        incoming.statusCode = 200;
        incoming.headers = { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify({ success: true,
          network: config.network, payer: config.buyer, amount: quote.amount, transaction: settled?.signature })).toString('base64') };
        receive(incoming); incoming.push(Buffer.from('{"ok":true}')); incoming.push(null);
      });
    });
    httpEntered.resolve();
    return outgoing;
  });
  const current = (target = ledger) => target.getOwned(intent.idempotencyKey, principal.cardMemberId)!;
  const summary = (target = ledger) => target.managedSummary(now, config.mode, record.monetaryScope);
  const events = (target = ledger) => target.eventsForOwner(intent.idempotencyKey, principal.cardMemberId).map(event => event.type);
  const execute = (target = ledger) => executeApprovedPayment(target, record.approvalId, config, resource.request.url);
  const payload = (): PaymentPayload => {
    if (!signedWire) throw new Error('Signer has not completed');
    return { x402Version: 2, resource: challenge.resource, accepted: quote, payload: { transaction: signedWire } };
  };
  return { ledger, open, config, record, intent, quote, principal, resource, reserve, execute, current, summary, events, rpcCalls,
    walletEntered, walletRelease, signerEntered, signerRelease, dnsEntered, dnsRelease, httpEntered, httpRelease, signTransactions,
    completedSignatures: () => completedSignatures, payload, settled: () => settled };
}

it('control: the unpaused real SDK, guards, pinned transport and original-proof accounting complete one offline purchase', async () => {
  const f = await fixture();
  await expect(f.execute()).resolves.toMatchObject({ data: { ok: true } });
  expect(f.current()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', transaction: f.settled()?.signature });
  expect(f.summary()).toMatchObject({ paid: '10000', reserved: '0', remaining: '90000', unresolved: 0 });
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.completedSignatures()).toBe(1);
  expect(transport.lookup).toHaveBeenCalledExactlyOnceWith('merchant.pause.invalid', { all: true, verbatim: true });
  expect(transport.request).toHaveBeenCalledOnce();
  expect(f.rpcCalls).toContain('simulateTransaction');
  expect(f.rpcCalls).toContain('getTransaction');
  expect(f.events().filter(type => type === 'payment.PAID')).toHaveLength(1);
  const original = f.ledger.savedOriginalPayment(f.record.approvalId)!;
  expect(original.state).toBe('CONFIRMED');
  expect(original.evidence.identity).toMatchObject({ amount: '10000', payer: f.config.buyer, recipient: f.quote.payTo,
    mint: f.config.mint, lastValidBlockHeight: '123456' });
  expect(original.evidence.identity).toEqual(createSignedPaymentIdentity(f.payload(), f.config, undefined,
    { recentBlockhash: original.evidence.identity.recentBlockhash, lastValidBlockHeight: '123456' }));
  expect(original.evidence.payloadHash).toBe(hash(f.ledger.savedPayload(f.record.approvalId)));
});

it('Pause wins the pending claim: the reserved approval stays reserved and both claim and new reserve are blocked', async () => {
  const f = await fixture(); const management = f.open();
  const claimReady = barrier(); const claimRelease = barrier();
  const pauseReady = barrier(); const pauseRelease = barrier();
  const order: string[] = [];
  // Both actors are pending before choosing the linearization order. The real
  // synchronous SQLite transactions run intact; no claim/guard is mocked.
  const claiming = (async () => { claimReady.resolve(); await claimRelease.promise; order.push('claim'); return f.execute(); })();
  const claimed = Promise.allSettled([claiming]);
  const pausing = (async () => { pauseReady.resolve(); await pauseRelease.promise; management.setPaused(true, f.config.mode); order.push('pause-ack'); })();
  await Promise.all([claimReady.promise, pauseReady.promise]);
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', unresolved: 0, paused: false });
  pauseRelease.resolve(); await pausing;
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', remaining: '90000', paused: true });
  claimRelease.resolve();
  const [result] = await claimed;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.reason).toEqual(new Error('Payments are paused'));
  expect(order).toEqual(['pause-ack', 'claim']);
  expect(f.current().status).toBe('APPROVED');
  expect(f.reserve(management, 'new-after-pause')).toMatchObject({ status: 'DENIED', decision: { reason: 'PAYMENTS_PAUSED' } });
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', remaining: '90000', unresolved: 0 });
  expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toBeUndefined();
  expect(f.events()).not.toContain('payment.PAYING');
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(f.signTransactions).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
  expect(transport.fetcher).not.toHaveBeenCalled();
});

it('claim wins Pause: only one competing executor claims, and Pause blocks it before signing and safely releases the reservation', async () => {
  const f = await fixture({ holdWallet: true }); const management = f.open();
  const contendersReady = [barrier(), barrier()]; const claimRelease = barrier();
  const pauseReady = barrier(); const pauseRelease = barrier();
  const order: string[] = [];
  const outcomes = Promise.allSettled([f.ledger, management].map(async (actor, index) => {
    contendersReady[index].resolve(); await claimRelease.promise;
    return f.execute(actor);
  }));
  const pausing = (async () => { pauseReady.resolve(); await pauseRelease.promise; management.setPaused(true, f.config.mode); order.push('pause-ack'); })();
  await Promise.all([...contendersReady.map(ready => ready.promise), pauseReady.promise]);
  claimRelease.resolve(); await f.walletEntered.promise;
  order.push('claim-committed');
  expect(f.current().status).toBe('PAYING');
  expect(f.events().filter(type => type === 'payment.PAYING')).toHaveLength(1);
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
  expect(f.signTransactions).not.toHaveBeenCalled();
  pauseRelease.resolve(); await pausing;
  expect(f.summary()).toMatchObject({ paused: true, reserved: '10000' });
  f.walletRelease.resolve();
  const results = await outcomes;
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(results.filter(result => result.status === 'rejected' && result.reason instanceof Error
    && result.reason.message === 'Approval inactive or expired')).toHaveLength(1);
  expect(order).toEqual(['claim-committed', 'pause-ack']);
  expect(f.current().status).toBe('FAILED');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '0', remaining: '100000', unresolved: 0 });
  expect(f.events().filter(type => type === 'payment.FAILED_BEFORE_SUBMISSION')).toHaveLength(1);
  expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toBeUndefined();
  expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.signTransactions).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
  management.setPaused(false, f.config.mode);
  await expect(f.execute()).rejects.toThrow('inactive');
  expect(f.reserve().status).toBe('FAILED');
  expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(f.signTransactions).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
});

it('Pause after the underlying signer entered permits its late result but rejects persistence and starts no payment HTTP', async () => {
  const f = await fixture({ holdSigner: true }); const management = f.open();
  const saving = vi.spyOn(f.ledger, 'savePayload'); // Call-through: retain the real guard and transaction.
  const stopped = expect(f.execute()).rejects.toThrow('Payment stopped');
  await f.signerEntered.promise;
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.completedSignatures()).toBe(0);
  expect(f.rpcCalls).toContain('simulateTransaction');
  expect(f.current().status).toBe('PAYING');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
  expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toBeUndefined();
  management.setPaused(true, f.config.mode);
  expect(f.summary()).toMatchObject({ paused: true, reserved: '10000' });
  expect(f.completedSignatures()).toBe(0); // Pause acknowledgement does not mean signer quiescence.
  f.signerRelease.resolve(); await stopped;
  expect(f.completedSignatures()).toBe(1);
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(saving).toHaveBeenCalledOnce();
  expect(saving.mock.results[0]).toEqual({ type: 'throw', value: new Error('Payments were paused before submission') });
  const attemptedEvidence = saving.mock.calls[0][3];
  if (!attemptedEvidence) throw new Error('Must reach persistence with valid signed original evidence');
  expect(attemptedEvidence.identity).toEqual(createSignedPaymentIdentity(f.payload(), f.config, undefined,
    { recentBlockhash: attemptedEvidence.identity.recentBlockhash, lastValidBlockHeight: '123456' }));
  expect(attemptedEvidence.payloadHash).toBe(hash(f.payload()));
  expect(f.current().status).toBe('FAILED');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '0', remaining: '100000', unresolved: 0 });
  expect(f.ledger.savedPayload(f.record.approvalId)).toBeUndefined();
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toBeUndefined();
  expect(f.events().filter(type => type === 'payment.FAILED_BEFORE_SUBMISSION')).toHaveLength(1);
  expect(f.events()).not.toContain('payment.SUBMISSION_ATTEMPTED');
  expect(transport.lookup).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
  management.setPaused(false, f.config.mode);
  await expect(f.execute()).rejects.toThrow('inactive');
  expect(f.reserve().status).toBe('FAILED');
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(loadBuyerSigner).toHaveBeenCalledOnce();
  expect(transport.request).not.toHaveBeenCalled();
});

it('Pause while real safe-transport DNS is pending rejects the send marker, retains original evidence and releases only unsubmitted money', async () => {
  const f = await fixture({ holdDns: true }); const management = f.open();
  const marking = vi.spyOn(f.ledger, 'markSubmissionAttempt');
  const stopped = expect(f.execute()).rejects.toThrow('Payment stopped');
  await f.dnsEntered.promise;
  expect(transport.lookup).toHaveBeenCalledExactlyOnceWith('merchant.pause.invalid', { all: true, verbatim: true });
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.completedSignatures()).toBe(1);
  expect(f.current().status).toBe('PAYING');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
  const original = f.ledger.savedOriginalPayment(f.record.approvalId)!;
  const payload = f.ledger.savedPayload(f.record.approvalId)!;
  expect(original).toMatchObject({ state: 'SIGNED_NOT_SUBMITTED', submissionAttemptedAt: null });
  expect(original.evidence.identity).toEqual(createSignedPaymentIdentity(payload, f.config, undefined,
    { recentBlockhash: original.evidence.identity.recentBlockhash, lastValidBlockHeight: '123456' }));
  expect(original.evidence.payloadHash).toBe(hash(payload));
  expect(marking).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
  management.setPaused(true, f.config.mode);
  expect(f.summary()).toMatchObject({ paused: true, reserved: '10000' });
  f.dnsRelease.resolve(); await stopped;
  expect(marking).toHaveBeenCalledOnce();
  expect(marking.mock.results[0]).toEqual({ type: 'throw', value: new Error('Payments were paused before submission') });
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toMatchObject({ state: 'NOT_SUBMITTED', submissionAttemptedAt: null, evidence: original.evidence });
  expect(f.ledger.savedPayload(f.record.approvalId)).toEqual(payload);
  expect(f.current().status).toBe('FAILED');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '0', remaining: '100000', unresolved: 0 });
  expect(f.events().filter(type => type === 'payment.FAILED_BEFORE_SUBMISSION')).toHaveLength(1);
  expect(f.events()).not.toContain('payment.SUBMISSION_ATTEMPTED');
  expect(transport.request).not.toHaveBeenCalled();
  expect(f.rpcCalls).not.toContain('getTransaction');
  management.setPaused(false, f.config.mode);
  await expect(f.execute()).rejects.toThrow('inactive');
  expect(f.reserve().status).toBe('FAILED');
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(transport.lookup).toHaveBeenCalledOnce();
  expect(transport.request).not.toHaveBeenCalled();
});

it('Pause after first payment HTTP started still confirms the original once, transfers reserved to paid, and survives replay and reopen', async () => {
  const f = await fixture({ holdHttp: true }); const management = f.open();
  const payment = f.execute();
  // Attach a rejection observer before awaiting a boundary; unexpected failures
  // remain test failures without generating an unhandled-rejection false signal.
  const completed = expect(payment).resolves.toMatchObject({ data: { ok: true } });
  await f.httpEntered.promise;
  expect(transport.lookup).toHaveBeenCalledExactlyOnceWith('merchant.pause.invalid', { all: true, verbatim: true });
  expect(transport.request).toHaveBeenCalledOnce();
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(f.completedSignatures()).toBe(1);
  expect(f.current().status).toBe('PAYING');
  expect(f.summary()).toMatchObject({ paid: '0', reserved: '10000', remaining: '90000', unresolved: 1 });
  const before = f.ledger.savedOriginalPayment(f.record.approvalId)!;
  const payload = f.ledger.savedPayload(f.record.approvalId)!;
  expect(before.state).toBe('SUBMISSION_ATTEMPTED');
  expect(before.submissionAttemptedAt).toBeTypeOf('number');
  expect(before.evidence.payloadHash).toBe(hash(payload));
  const commitment = f.ledger.spendGrantSummary(f.intent.createdAt, f.config.mode, f.principal.cardMemberId)!.committed;
  management.setPaused(true, f.config.mode);
  expect(f.summary()).toMatchObject({ paused: true, paid: '0', reserved: '10000', unresolved: 1 });
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toEqual(before);
  expect(f.events()).not.toContain('payment.PAID');
  expect(f.events()).not.toContain('payment.FAILED_BEFORE_SUBMISSION');
  expect(f.rpcCalls).not.toContain('getTransaction');
  expect(f.reserve(management, 'blocked-after-http').status).toBe('DENIED');
  f.httpRelease.resolve(); await completed;
  expect(f.current()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', transaction: f.settled()?.signature,
    paymentEvidence: { version: 3, source: 'buyer_rpc', messageHash: before.evidence.identity.messageHash,
      originalEvidenceHash: hash(before.evidence), transaction: f.settled()?.signature } });
  expect(f.summary()).toMatchObject({ paused: true, paid: '10000', reserved: '0', remaining: '90000', unresolved: 0 });
  expect(f.ledger.spendGrantSummary(f.intent.createdAt, f.config.mode, f.principal.cardMemberId)!.committed).toBe(commitment);
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toMatchObject({ state: 'CONFIRMED', evidence: before.evidence,
    submissionAttemptedAt: before.submissionAttemptedAt, transaction: f.settled()?.signature });
  expect(f.ledger.savedPayload(f.record.approvalId)).toEqual(payload);
  const settlement = f.settled();
  if (!settlement) throw new Error('Original fake settlement is missing');
  expect(transactionMessageHash(settlement.wire)).toBe(before.evidence.identity.messageHash);
  expect(f.rpcCalls).toContain('getTransaction'); // Real reconciler, not a mocked CONFIRMED outcome.
  const readCount = transport.fetcher.mock.calls.length;
  await reconcileApprovedPayment(f.ledger, f.intent.idempotencyKey, f.config, undefined, f.principal.cardMemberId);
  await recoverApprovedPayment(f.ledger, f.intent.idempotencyKey, f.config, f.resource.request.url, undefined, f.principal.cardMemberId);
  const reopened = f.open();
  reopened.recoverUnsubmittedOnStartup();
  expect(f.reserve(reopened)).toMatchObject({ approvalId: f.record.approvalId, status: 'PAID', transaction: settlement.signature });
  expect(f.current(reopened).paymentEvidence).toEqual(f.current().paymentEvidence);
  expect(f.summary(reopened)).toMatchObject({ paused: true, paid: '10000', reserved: '0', remaining: '90000', unresolved: 0 });
  await expect(f.execute(reopened)).rejects.toThrow('inactive');
  expect(f.events(reopened).filter(type => type === 'payment.PAID')).toHaveLength(1);
  expect(f.events(reopened).filter(type => type === 'payment.SUBMISSION_ATTEMPTED')).toHaveLength(1);
  expect(transport.fetcher).toHaveBeenCalledTimes(readCount);
  expect(transport.request).toHaveBeenCalledOnce();
  expect(f.signTransactions).toHaveBeenCalledOnce();
  expect(loadBuyerSigner).toHaveBeenCalledOnce();
});
