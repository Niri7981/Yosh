import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { loadPaymentConfig, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { createStaticResourceRegistry } from '../../src/modules/resources/static-resource-registry';
import { createMarketSnapshotSpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { executeApprovedPayment, paymentBinding, reconcileApprovedPayment, recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';
import { monetaryScopeId } from '../../src/modules/purchases/monetary-scope';
import { hash } from '../../src/modules/purchases/spending-policy';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async () => {
  const original = await vi.importActual<typeof import('../../src/modules/payment/solana-payment')>('../../src/modules/payment/solana-payment');
  return { ...original, prepareSolanaPayment: vi.fn() };
});

const endpoint = 'http://127.0.0.1:3000/api/paid/market-snapshot?asset=SOL';
const directories: string[] = [];
const ledgers: PurchaseLedger[] = [];
const RpcRequestSchema = z.object({ method: z.string(), params: z.array(z.unknown()) });
type RpcRequest = z.infer<typeof RpcRequestSchema>;

function tokenAccount(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), mint.toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
}

function signedTransfer(config: PaymentConfig, buyer: Keypair, feePayer: Keypair, quote: PaymentRequirements,
  overrides: { recipient?: PublicKey; mint?: PublicKey; amount?: bigint } = {}) {
  const mint = overrides.mint ?? new PublicKey(config.mint);
  const recipient = overrides.recipient ?? new PublicKey(config.merchant);
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(overrides.amount ?? 10_000n, 1); data[9] = 6;
  const transfer = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data, keys: [
    { pubkey: tokenAccount(buyer.publicKey, mint), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenAccount(recipient, mint), isSigner: false, isWritable: true },
    { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
  ] });
  const actualMemo = '0123456789abcdef0123456789abcdef';
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }), transfer,
      new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
        keys: [], data: Buffer.from(actualMemo) }),
    ] }).compileToV0Message());
  tx.sign([buyer]);
  const payload: PaymentPayload = { x402Version: 2, resource: { url: '/fixture' }, accepted: quote,
    payload: { transaction: Buffer.from(tx.serialize()).toString('base64') } };
  tx.sign([feePayer]);
  const fullWire = Buffer.from(tx.serialize()).toString('base64');
  return { payload, fullWire, signature: getBase58Decoder().decode(tx.signatures[0]), actualMemo,
    lifetime: { recentBlockhash: tx.message.recentBlockhash, lastValidBlockHeight: '123456' },
    rpc: { transaction: [fullWire, 'base64'], meta: { err: null } } };
}

async function fixture(path = ':memory:') {
  const buyer = Keypair.generate(); const feePayer = Keypair.generate();
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: buyer.publicKey.toBase58(),
    DEMO_MERCHANT_PUBLIC_KEY: Keypair.generate().publicKey.toBase58() });
  const quote: PaymentRequirements = { scheme: 'exact', network: config.network, asset: config.mint,
    amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 300,
    extra: { feePayer: feePayer.publicKey.toBase58() } };
  const ledger = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: config.buyer });
  ledgers.push(ledger);
  const resource = createStaticResourceRegistry({ endpoint: 'https://example.com', asset_id: config.mint,
    network: config.network, allowed_pay_to: config.merchant })[0];
  const intent = createMarketSnapshotSpendIntent({ idempotencyKey: 'original-request', request: { asset: 'SOL' },
    requestHash: hash('original-request'), resource, quote, executionBinding: paymentBinding(config, endpoint), now: Date.now() });
  const record = ledger.reserve(intent, quote, undefined, 'live_devnet');
  const transfer = signedTransfer(config, buyer, feePayer, quote);
  vi.mocked(loadBuyerSigner).mockResolvedValue(await createKeyPairSignerFromBytes(buyer.secretKey));
  vi.mocked(prepareSolanaPayment).mockImplementation(async (_config, _signer, _requirement, beforeSign, _authorized, onLifetime) => {
    beforeSign?.(); onLifetime?.(transfer.lifetime); return transfer.payload;
  });
  return { ledger, record, config, quote, buyer, feePayer, ...transfer };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function saveOriginal(f: Fixture, attempted = true) {
  f.ledger.claim(f.record.approvalId);
  const evidence = OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: f.record.intent.id,
    requestId: f.record.intent.idempotencyKey, monetaryScope: f.record.monetaryScope,
    scopeId: monetaryScopeId(f.record.monetaryScope), executionBinding: f.record.intent.executionBinding,
    quoteFingerprint: f.record.intent.quoteFingerprint, payloadHash: hash(f.payload), recordedAt: Date.now(),
    identity: createSignedPaymentIdentity(f.payload, f.config, undefined, f.lifetime) });
  f.ledger.savePayload(f.record.approvalId, f.payload, undefined, evidence);
  if (attempted) { f.ledger.markSubmissionAttempt(f.record.approvalId); f.ledger.unknown(f.record.approvalId); }
}

function network(f: Fixture, rpc: (request: RpcRequest) => unknown | Promise<unknown>, merchant?: () => Response | Promise<Response>,
  genesis: string | null = f.config.genesisHash) {
  const requests: RpcRequest[] = [];
  const merchantRequests: Array<RequestInit | undefined> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== f.config.rpcUrl) {
      merchantRequests.push(init);
      if (!merchant) throw new Error('merchant disappeared');
      return merchant();
    }
    const request = RpcRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(request);
    const result = request.method === 'getGenesisHash' ? genesis : await rpc(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, requests, merchantRequests };
}
function originalRpc(f: Fixture, request: RpcRequest) {
  return request.method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: '[32] ' + f.actualMemo }] : f.rpc;
}
function absentRpc(request: RpcRequest) { return request.method === 'getSignaturesForAddress' ? [] : null; }
function receipt(f: Fixture, status = 503) {
  return new Response('{}', { status, headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true,
    network: f.config.network, payer: f.config.buyer, amount: '10000', transaction: f.signature })).toString('base64') } });
}
function accounting(f: Fixture) { return f.ledger.managedSummary(Date.now(), 'live_devnet', f.record.monetaryScope); }
function persistentPath() {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-original-recovery-'));
  directories.push(directory); return join(directory, 'ledger.sqlite');
}
function close(f: Fixture) { f.ledger.close(); ledgers.splice(ledgers.indexOf(f.ledger), 1); }
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.resetAllMocks();
});

it('failure before signing/submission conclusively releases reservation without contacting merchant or RPC', async () => {
  const f = await fixture(); const calls = network(f, absentRpc);
  vi.mocked(prepareSolanaPayment).mockRejectedValueOnce(new Error('simulation rejected'));
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow('reconciliation');
  expect(f.ledger.getLegacy('original-request')?.status).toBe('FAILED');
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '0', unresolved: 0 });
  expect(calls.fetcher).not.toHaveBeenCalled();
});

it('saved signed payload followed by failure before the send marker is provably unsubmitted', async () => {
  const f = await fixture(); const calls = network(f, absentRpc);
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint, event => {
    if (event === 'SIGNED') throw new Error('stop before HTTP send');
  })).rejects.toThrow('reconciliation');
  expect(f.ledger.savedPayload(f.record.approvalId)).toEqual(f.payload);
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toMatchObject({ state: 'NOT_SUBMITTED', submissionAttemptedAt: null });
  expect(accounting(f)).toMatchObject({ reserved: '0', paid: '0' });
  expect(calls.fetcher).not.toHaveBeenCalled();
});

it('exclusive startup releases newly evidenced unsubmitted payload while concurrent recovery does not', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f, false);
  const calls = network(f, absentRpc);
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toEqual({ status: 'UNKNOWN' });
  expect(f.ledger.getLegacy('original-request')?.status).toBe('PAYING');
  expect(accounting(f).reserved).toBe('10000'); expect(calls.fetcher).not.toHaveBeenCalled();
  close(f); const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  reopened.recoverUnsubmittedOnStartup();
  expect(reopened.getLegacy('original-request')?.status).toBe('FAILED');
  expect(reopened.savedOriginalPayment(f.record.approvalId)?.state).toBe('NOT_SUBMITTED');
});

it('legacy unknown without payload remains reserved across startup rather than becoming failure evidence', async () => {
  const path = persistentPath(); const f = await fixture(path);
  f.ledger.claim(f.record.approvalId); f.ledger.unknown(f.record.approvalId); close(f);
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  reopened.recoverUnsubmittedOnStartup();
  expect(reopened.getLegacy('original-request')?.status).toBe('PAYMENT_UNKNOWN');
  expect(reopened.managedSummary()).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
});

it('persists receipt signature before RPC polling when the merchant response body is unusable', async () => {
  const f = await fixture();
  const calls = network(f, request => {
    expect(f.ledger.observedTransactionSignature(f.record.approvalId)).toBe(f.signature);
    return originalRpc(f, request);
  }, () => receipt(f));
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
  expect(f.ledger.getLegacy('original-request')).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING', transaction: f.signature,
    paymentEvidence: { version: 3, source: 'buyer_rpc', settlementConfirmed: false } });
  expect(accounting(f)).toMatchObject({ reserved: '0', paid: '10000', unresolved: 0 });
  expect(calls.merchantRequests).toHaveLength(1); expect(prepareSolanaPayment).toHaveBeenCalledTimes(1);
});

it('lost HTTP response still resolves the original transfer from chain without any merchant retry', async () => {
  const f = await fixture(); const calls = network(f, request => originalRpc(f, request));
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
  expect(f.ledger.getLegacy('original-request')).toMatchObject({ status: 'PAID', transaction: f.signature, deliveryStatus: 'PENDING' });
  expect(accounting(f)).toMatchObject({ paid: '10000', reserved: '0' });
  await reconcileApprovedPayment(f.ledger, 'original-request', f.config);
  expect(calls.merchantRequests).toHaveLength(1);
  expect(calls.requests.every(request => ['getGenesisHash', 'getTransaction', 'getSignaturesForAddress'].includes(request.method))).toBe(true);
  expect(loadBuyerSigner).toHaveBeenCalledTimes(1); expect(prepareSolanaPayment).toHaveBeenCalledTimes(1);
});

it('submitted original payment finalized failed releases reserved authority only after conclusive matching chain failure', async () => {
  const f = await fixture(); saveOriginal(f);
  const failed = { ...f.rpc, meta: { err: { InstructionError: [2, 'InsufficientFunds'] } } };
  const calls = network(f, request => request.method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: f.actualMemo }] : failed);
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toEqual({ status: 'FAILED', transaction: f.signature });
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toMatchObject({ state: 'FINALIZED_FAILED', transaction: f.signature });
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '0', unresolved: 0 });
  expect(calls.requests.some(request => JSON.stringify(request.params).includes('finalized'))).toBe(true);
  expect(calls.merchantRequests).toHaveLength(0);
});

it('a confirmed failed fork followed by finalized success records original payment as paid', async () => {
  const f = await fixture(); saveOriginal(f);
  network(f, request => request.method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: f.actualMemo }]
    : JSON.stringify(request.params).includes('finalized') ? f.rpc : { ...f.rpc, meta: { err: 'AccountNotFound' } });
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toMatchObject({ status: 'CONFIRMED', confirmationStatus: 'finalized' });
  expect(accounting(f)).toMatchObject({ paid: '10000', reserved: '0' });
});

it.each(['absent', 'offline', 'confirmed_failure'] as const)('%s RPC outcome leaves original payment reserved and never resubmits', async mode => {
  const f = await fixture(); saveOriginal(f);
  const calls = network(f, request => {
    if (mode === 'offline') throw new Error('RPC temporarily unavailable');
    if (mode === 'absent') return absentRpc(request);
    return request.method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: f.actualMemo }]
      : JSON.stringify(request.params).includes('finalized') ? null : { ...f.rpc, meta: { err: 'AccountNotFound' } };
  });
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toEqual({ status: 'UNKNOWN' });
  await recoverApprovedPayment(f.ledger, 'original-request', f.config, endpoint);
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
  expect(calls.merchantRequests).toHaveLength(0);
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('an ambiguous HTTP attempt cannot be signed again or converted to a replacement purchase', async () => {
  const f = await fixture(); const calls = network(f, absentRpc);
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow();
  await expect(executeApprovedPayment(f.ledger, f.record.approvalId, f.config, endpoint)).rejects.toThrow('inactive');
  const replay = f.ledger.reserve(f.record.intent, f.quote, undefined, 'live_devnet');
  expect(replay.intent.id).toBe(f.record.intent.id); expect(replay.status).toBe('PAYMENT_UNKNOWN');
  await recoverApprovedPayment(f.ledger, 'original-request', f.config, endpoint);
  expect(calls.merchantRequests).toHaveLength(1); expect(prepareSolanaPayment).toHaveBeenCalledTimes(1);
  expect(accounting(f).reserved).toBe('10000');
});

it.each(['replacement', 'recipient', 'mint', 'amount'] as const)('an unrelated %s transaction cannot satisfy original-payment recovery', async field => {
  const f = await fixture(); saveOriginal(f);
  const unrelated = signedTransfer(f.config, f.buyer, f.feePayer, f.quote,
    field === 'recipient' ? { recipient: Keypair.generate().publicKey } : field === 'mint' ? { mint: Keypair.generate().publicKey }
      : field === 'amount' ? { amount: 10_001n } : {});
  network(f, request => request.method === 'getSignaturesForAddress' ? [{ signature: unrelated.signature, memo: f.actualMemo }] : unrelated.rpc);
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toEqual({ status: 'UNKNOWN' });
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '10000' });
});

it('wrong network genesis cannot turn a reservation into paid evidence', async () => {
  const f = await fixture(); saveOriginal(f);
  network(f, request => originalRpc(f, request), undefined, Keypair.generate().publicKey.toBase58());
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toEqual({ status: 'UNKNOWN' });
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '10000' });
});

it('a wrong merchant receipt observation does not prevent resolving the correct original history transaction', async () => {
  const f = await fixture(); saveOriginal(f);
  const unrelated = signedTransfer(f.config, f.buyer, f.feePayer, f.quote);
  f.ledger.observeTransactionSignature(f.record.approvalId, unrelated.signature);
  network(f, request => request.method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: f.actualMemo }]
    : request.params[0] === unrelated.signature ? unrelated.rpc : f.rpc);
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', f.config)).toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
  expect(f.ledger.getLegacy('original-request')?.transaction).toBe(f.signature);
});

it('merchant configuration changes cannot change the stored recipient of read-only original-payment recovery', async () => {
  const f = await fixture(); saveOriginal(f); network(f, request => originalRpc(f, request));
  expect(await reconcileApprovedPayment(f.ledger, 'original-request', { ...f.config, merchant: Keypair.generate().publicKey.toBase58() }))
    .toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
  expect(accounting(f)).toMatchObject({ paid: '10000', reserved: '0' });
});

it('restart preserves immutable original evidence and repeated recovery emits one paid event with no new signature', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f);
  const original = f.ledger.savedOriginalPayment(f.record.approvalId); close(f);
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  reopened.recoverUnsubmittedOnStartup();
  expect(reopened.savedOriginalPayment(f.record.approvalId)).toEqual(original);
  expect(reopened.getLegacy('original-request')?.status).toBe('PAYMENT_UNKNOWN');
  const calls = network(f, request => originalRpc(f, request));
  await Promise.all([1, 2].map(() => reconcileApprovedPayment(reopened, 'original-request', f.config)));
  await reconcileApprovedPayment(reopened, 'original-request', f.config);
  expect(reopened.getLegacy('original-request')).toMatchObject({ status: 'PAID', deliveryStatus: 'PENDING', transaction: f.signature });
  expect(reopened.managedSummary()).toMatchObject({ paid: '10000', reserved: '0', unresolved: 0 });
  expect(reopened.eventsForLegacy('original-request').filter(event => event.type === 'payment.PAID')).toHaveLength(1);
  expect(calls.merchantRequests).toHaveLength(0);
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('legacy settlement mutations cannot confirm or release an original-evidence reservation', async () => {
  const f = await fixture(); saveOriginal(f);
  expect(() => f.ledger.failConfirmed(f.record.approvalId, f.signature)).toThrow('ORIGINAL_PAYMENT_PROOF_REQUIRED');
  expect(() => f.ledger.confirmPayment(f.record.approvalId, f.signature, { payer: f.config.buyer,
    messageHash: hash('unrelated'), confirmationStatus: 'confirmed', settlementConfirmed: true })).toThrow('ORIGINAL_PAYMENT_PROOF_REQUIRED');
  expect(accounting(f)).toMatchObject({ reserved: '10000', paid: '0' });
});

it('repeated ambiguous recovery does not duplicate payment state events or release the reservation', async () => {
  const f = await fixture(); saveOriginal(f); network(f, absentRpc);
  const before = f.ledger.eventsForLegacy('original-request').filter(event => event.type === 'payment.PAYMENT_UNKNOWN').length;
  await reconcileApprovedPayment(f.ledger, 'original-request', f.config);
  await reconcileApprovedPayment(f.ledger, 'original-request', f.config);
  expect(f.ledger.eventsForLegacy('original-request').filter(event => event.type === 'payment.PAYMENT_UNKNOWN')).toHaveLength(before);
  expect(accounting(f)).toMatchObject({ reserved: '10000', paid: '0' });
  expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('legacy signed payload without a send marker remains possibly submitted and can be reconciled without replaying it', async () => {
  const path = persistentPath(); const f = await fixture(path);
  f.ledger.claim(f.record.approvalId); f.ledger.savePayload(f.record.approvalId, f.payload); f.ledger.unknown(f.record.approvalId); close(f);
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  reopened.recoverUnsubmittedOnStartup();
  expect(reopened.getLegacy('original-request')?.status).toBe('PAYMENT_UNKNOWN');
  const calls = network(f, request => originalRpc(f, request));
  await reconcileApprovedPayment(reopened, 'original-request', f.config);
  expect(reopened.getLegacy('original-request')?.status).toBe('PAID');
  expect(reopened.savedOriginalPayment(f.record.approvalId)).toMatchObject({ state: 'CONFIRMED', submissionAttemptedAt: null });
  expect(calls.merchantRequests).toHaveLength(0); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('SQLite rejects rewriting original evidence, signed payload, or the already committed submission attempt', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f);
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  const database = new DatabaseSync(path);
  try {
    expect(() => database.prepare('UPDATE original_payments SET evidence=? WHERE purchase_id=?')
      .run('{}', f.record.intent.id)).toThrow('original payment evidence is immutable');
    expect(() => database.prepare('UPDATE purchases SET payload=? WHERE id=?')
      .run('{}', f.record.intent.id)).toThrow('signed payment payload is immutable');
    expect(() => database.prepare('UPDATE original_payments SET submission_attempted_at=NULL WHERE purchase_id=?')
      .run(f.record.intent.id)).toThrow('original submission attempt is immutable');
  } finally { database.close(); }
  expect(f.ledger.savedOriginalPayment(f.record.approvalId)).toEqual(original);
  expect(accounting(f)).toMatchObject({ paid: '0', reserved: '10000', unresolved: 1 });
});

it('persists history continuation and backoff across restart, then confirms the original without signing or merchant calls', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f);
  const candidates = Array.from({ length: 24 }, () => ({ signature: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))), memo: f.actualMemo }));
  const history = [...candidates, { signature: f.signature, memo: f.actualMemo }];
  const calls = network(f, request => {
    if (request.method === 'getTransaction') return request.params[0] === f.signature ? f.rpc : null;
    const before = z.object({ before: z.string().optional() }).parse(request.params[1]).before;
    return history.slice(before === undefined ? 0 : history.findIndex(item => item.signature === before) + 1);
  });
  await reconcileApprovedPayment(f.ledger, 'original-request', f.config);
  const state = f.ledger.reconciliation.state(f.record.intent.id)!;
  expect(state).toMatchObject({ attempts: 1, before: candidates[19].signature, lastCode: 'UNKNOWN', claimed: false });
  const original = f.ledger.savedOriginalPayment(f.record.approvalId);
  close(f); const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  expect(reopened.reconciliation.state(f.record.intent.id)).toEqual(state);
  await reconcileApprovedPayment(reopened, 'original-request', f.config);
  expect(reopened.getLegacy('original-request')).toMatchObject({ status: 'PAID', transaction: f.signature });
  expect(reopened.savedOriginalPayment(f.record.approvalId)?.evidence).toEqual(original!.evidence);
  expect(reopened.reconciliation.state(f.record.intent.id)?.attempts).toBe(2);
  expect(calls.merchantRequests).toHaveLength(0); expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it('does not steal a read-only claim across SQLite handles or reset its backoff on exclusive startup', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f);
  const first = f.ledger.reconciliation.claim(f.record.intent.id)!;
  const state = f.ledger.reconciliation.state(f.record.intent.id)!;
  const other = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(other);
  expect(other.reconciliation.claim(f.record.intent.id)).toBeUndefined();
  expect(other.reconciliation.state(f.record.intent.id)).toEqual(state);
  close(f); other.reconciliation.recoverClaimsOnStartup();
  expect(other.reconciliation.state(f.record.intent.id)).toMatchObject({ attempts: 1, nextAttemptAt: state.nextAttemptAt, claimed: false, lastCode: 'INTERRUPTED' });
  expect(other.reconciliation.claim(f.record.intent.id, true)).toBeUndefined();
  const second = other.reconciliation.claim(f.record.intent.id)!;
  expect(() => other.reconciliation.saveCursor(first, f.signature)).toThrow('RECONCILIATION_CLAIM_MISMATCH');
  other.reconciliation.finish(first, 'CONFIRMED');
  expect(other.reconciliation.state(f.record.intent.id)?.claimed).toBe(true);
  other.reconciliation.finish(second, 'UNKNOWN');
  expect(other.managedSummary()).toMatchObject({ reserved: '10000', paid: '0', unresolved: 1 });
});

it('adds reconciliation metadata to an old ledger without rewriting purchase or original-payment evidence', async () => {
  const path = persistentPath(); const f = await fixture(path); saveOriginal(f); close(f);
  const db = new DatabaseSync(path);
  const purchases = db.prepare('SELECT * FROM purchases').all(); const original = db.prepare('SELECT * FROM original_payments').all();
  db.exec("DROP TABLE payment_reconciliation; DELETE FROM ledger_schema_migrations WHERE id='016_payment_reconciliation'"); db.close();
  const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: f.config.buyer }); ledgers.push(reopened);
  const verified = new DatabaseSync(path);
  try {
    expect(verified.prepare('SELECT * FROM purchases').all()).toEqual(purchases);
    expect(verified.prepare('SELECT * FROM original_payments').all()).toEqual(original);
    expect(verified.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(verified.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(reopened.reconciliation.state(f.record.intent.id)).toMatchObject({ attempts: 0, nextAttemptAt: 0, claimed: false });
  } finally { verified.close(); }
});
