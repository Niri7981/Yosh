import { Keypair, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { createSignedPaymentIdentity, decodeOriginalTransaction, matchesSignedPaymentIdentity,
  SignedPaymentIdentitySchema, transactionMessageHash, validateSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { reconcileStoredOriginalPayment, RECONCILIATION_MAX_PAGES, RECONCILIATION_MAX_CANDIDATES } from '../../src/modules/payment/reconcile-transaction';

const buyer = Keypair.generate();
const feePayer = Keypair.generate();
const merchant = Keypair.generate();
const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: buyer.publicKey.toBase58(), DEMO_MERCHANT_PUBLIC_KEY: merchant.publicKey.toBase58() });
const memo = '0123456789abcdef0123456789abcdef'; // The SDK-generated memo need not be a seller quote memo.
function tokenAccount(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), mint.toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
}
function fixture(options: { recipient?: PublicKey; mint?: PublicKey; amount?: bigint; decimals?: number; memo?: string;
  extra?: boolean; complete?: boolean } = {}) {
  const mint = options.mint ?? new PublicKey(config.mint);
  const recipient = options.recipient ?? merchant.publicKey;
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(options.amount ?? 10_000n, 1); data[9] = options.decimals ?? 6;
  const transfer = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data, keys: [
    { pubkey: tokenAccount(buyer.publicKey, mint), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenAccount(recipient, mint), isSigner: false, isWritable: true },
    { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
  ] });
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }),
      transfer, new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
        keys: [], data: Buffer.from(options.memo ?? memo) }),
      ...(options.extra ? [SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: merchant.publicKey, lamports: 1 })] : []),
    ] }).compileToV0Message());
  transaction.sign([buyer]);
  const wire = Buffer.from(transaction.serialize()).toString('base64');
  transaction.sign([feePayer]);
  const fullWire = Buffer.from(transaction.serialize()).toString('base64');
  const signature = getBase58Decoder().decode(transaction.signatures[0]);
  const payload: PaymentPayload = { x402Version: 2, resource: { url: '/fixture' }, accepted: { scheme: 'exact', network: config.network,
    asset: config.mint, amount: '10000', payTo: config.merchant, maxTimeoutSeconds: 120,
    extra: { feePayer: feePayer.publicKey.toBase58() } }, payload: { transaction: options.complete ? fullWire : wire } };
  return { transaction, wire, fullWire, signature, payload, rpc: { transaction: [fullWire, 'base64'], meta: { err: null } } };
}
const RpcRequestSchema = z.object({ method: z.string(), params: z.array(z.unknown()) });
function mockRpc(handler: (method: string, params: unknown[]) => unknown | Promise<unknown>) {
  const mocked = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = RpcRequestSchema.parse(JSON.parse(String(init?.body)));
    const result = request.method === 'getGenesisHash' ? config.genesisHash : await handler(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  vi.stubGlobal('fetch', mocked);
  return mocked;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('durable original buyer-signed Solana identity', () => {
  it('retains buyer partial signature, actual memo, message identity, token accounts and lifetime', () => {
    const f = fixture();
    const identity = createSignedPaymentIdentity(f.payload, config, undefined,
      { recentBlockhash: f.transaction.message.recentBlockhash, lastValidBlockHeight: '123456' });
    expect(identity).toMatchObject({ payer: config.buyer, recipient: config.merchant, mint: config.mint, amount: '10000',
      decimals: 6, buyerSignerIndex: 1, feePayer: feePayer.publicKey.toBase58(), actualMemo: memo,
      recentBlockhash: f.transaction.message.recentBlockhash, lastValidBlockHeight: '123456', messageHash: transactionMessageHash(f.wire) });
    expect(identity.knownSignature).toBeUndefined();
    expect(identity.buyerSignature).toBe(getBase58Decoder().decode(f.transaction.signatures[1]));
    expect(SignedPaymentIdentitySchema.parse(JSON.parse(JSON.stringify(identity)))).toEqual(identity);
    expect(matchesSignedPaymentIdentity(f.fullWire, identity, config, f.signature)).toBe(true);
    expect(createSignedPaymentIdentity({ ...f.payload, payload: { transaction: f.fullWire } }, config).knownSignature).toBe(f.signature);
  });
  it('does not trust merchant-supplied lifetime hints and rejects a mismatched captured blockhash', () => {
    const f = fixture();
    const identity = createSignedPaymentIdentity({ ...f.payload, accepted: { ...f.payload.accepted,
      extra: { ...f.payload.accepted.extra, recentBlockhash: f.transaction.message.recentBlockhash, lastValidBlockHeight: '999999' } } }, config);
    expect(identity.lastValidBlockHeight).toBeUndefined();
    expect(() => createSignedPaymentIdentity(f.payload, config, undefined,
      { recentBlockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: '123' })).toThrow('LIFETIME_MISMATCH');
  });
  it('preserves an explicitly authorized quote memo binding', () => {
    const f = fixture();
    expect(() => createSignedPaymentIdentity({ ...f.payload, accepted: { ...f.payload.accepted,
      extra: { ...f.payload.accepted.extra, memo: 'changed-memo' } } }, config)).toThrow('MEMO_MISMATCH');
  });
  it.each([
    { recipient: Keypair.generate().publicKey }, { mint: Keypair.generate().publicKey }, { amount: 10_001n }, { decimals: 9 },
  ])('rejects signed transfers outside authorized recipient/mint/amount/decimals', options => {
    expect(() => createSignedPaymentIdentity(fixture(options).payload, config)).toThrow('TRANSFER_MISMATCH');
  });
  it('rejects a tampered buyer signature, a replacement message, or additional instructions', () => {
    const f = fixture();
    const identity = createSignedPaymentIdentity(f.payload, config);
    const changed = decodeOriginalTransaction(f.wire).transaction;
    changed.signatures[1][0] ^= 1;
    expect(() => createSignedPaymentIdentity({ ...f.payload, payload: { transaction: Buffer.from(changed.serialize()).toString('base64') } }, config)).toThrow('SIGNER_MISMATCH');
    const unrelated = fixture();
    expect(matchesSignedPaymentIdentity(unrelated.fullWire, identity, config, unrelated.signature)).toBe(false);
    expect(() => createSignedPaymentIdentity(fixture({ extra: true }).payload, config)).toThrow('UNSUPPORTED_ORIGINAL_PAYMENT');
  });
  it('rejects wrong authorized payer/network and malformed transaction input', () => {
    const f = fixture();
    expect(() => createSignedPaymentIdentity(f.payload, config, { payer: Keypair.generate().publicKey.toBase58(),
      recipient: config.merchant, mint: config.mint, amount: '10000', decimals: 6 })).toThrow('AUTHORIZATION_MISMATCH');
    expect(() => createSignedPaymentIdentity({ ...f.payload, accepted: { ...f.payload.accepted, network: 'solana:wrong' } }, config)).toThrow('AUTHORIZATION_MISMATCH');
    expect(() => createSignedPaymentIdentity({ ...f.payload, payload: { transaction: 'invalid-wire' } }, config)).toThrow();
  });
  it('validates durable identity against the original payload without configuration or RPC', () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    expect(validateSignedPaymentIdentity(f.payload, identity)).toBe(true);
    const unrelated = fixture(); const different = createSignedPaymentIdentity(unrelated.payload, config);
    expect(validateSignedPaymentIdentity(f.payload, different)).toBe(false);
    for (const changed of [
      { messageHash: different.messageHash }, { wireHash: different.wireHash }, { buyerSignature: different.buyerSignature },
      { payer: Keypair.generate().publicKey.toBase58() }, { buyerSignerIndex: 0 }, { actualMemo: 'changed' },
      { amount: '10001' }, { mint: Keypair.generate().publicKey.toBase58() }, { recipient: Keypair.generate().publicKey.toBase58() },
      { recipientTokenAccount: Keypair.generate().publicKey.toBase58() }, { sourceTokenAccount: Keypair.generate().publicKey.toBase58() },
      { feePayer: Keypair.generate().publicKey.toBase58() }, { recentBlockhash: Keypair.generate().publicKey.toBase58() },
      { knownSignature: unrelated.signature },
    ]) expect(validateSignedPaymentIdentity(f.payload, { ...identity, ...changed })).toBe(false);
  });
});

describe('merchant-independent original-payment reconciliation', () => {
  it('finds an original transaction beyond the first 100 history entries using the RPC before cursor', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const firstPage = Array.from({ length: 100 }, () => ({ signature: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))), memo: null }));
    mockRpc((method, params) => {
      if (method === 'getTransaction') return f.rpc;
      const options = z.object({ before: z.string().optional() }).parse(params[1]);
      return options.before === firstPage.at(-1)!.signature ? [{ signature: f.signature, memo }] : firstPage;
    });
    expect(await reconcileStoredOriginalPayment(config, identity)).toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
  });
  it('does not discard the original transaction after three unrelated memo candidates', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const unrelated = Array.from({ length: 4 }, () => fixture());
    mockRpc((method, params) => method === 'getSignaturesForAddress'
      ? [...unrelated.map(item => ({ signature: item.signature, memo })), { signature: f.signature, memo }]
      : unrelated.find(item => item.signature === params[0])?.rpc ?? f.rpc);
    expect(await reconcileStoredOriginalPayment(config, identity)).toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
  });
  it('bounds a history pass and preserves a continuation cursor instead of restarting at the head', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const history = Array.from({ length: 700 }, () => ({ signature: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))), memo: null }));
    let cursor: string | undefined;
    const fetcher = mockRpc((_method, params) => {
      const before = z.object({ before: z.string().optional() }).parse(params[1]).before;
      const offset = before === undefined ? 0 : history.findIndex(item => item.signature === before) + 1;
      return history.slice(offset, offset + 100);
    });
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, () => {}, { onCursor: before => { cursor = before; } })).toEqual({ status: 'UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(RECONCILIATION_MAX_PAGES + 1);
    expect(cursor).toBe(history[499].signature);
    const checkpoints = vi.fn();
    await reconcileStoredOriginalPayment(config, identity, undefined, () => {}, { before: cursor, onCursor: checkpoints });
    expect(checkpoints).toHaveBeenLastCalledWith(undefined);
    const requests = fetcher.mock.calls.map(([, init]) => RpcRequestSchema.parse(JSON.parse(String(init?.body))));
    expect(requests.filter(request => request.method === 'getSignaturesForAddress')[5].params[1]).toMatchObject({ before: history[499].signature });
  });
  it('bounds memo candidate inspection without skipping the next candidate or interpreting absence as failure', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const history = Array.from({ length: 30 }, () => ({ signature: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))), memo }));
    let cursor: string | undefined;
    const fetcher = mockRpc(method => method === 'getSignaturesForAddress' ? history : null);
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, () => {}, { onCursor: before => { cursor = before; } })).toEqual({ status: 'UNKNOWN' });
    expect(cursor).toBe(history[RECONCILIATION_MAX_CANDIDATES - 1].signature);
    expect(fetcher).toHaveBeenCalledTimes(RECONCILIATION_MAX_CANDIDATES + 2);
  });
  it('keeps the cursor before a candidate when its RPC lookup fails, and stops a cancelled pass', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const checkpoints = vi.fn();
    const fetcher = mockRpc(method => {
      if (method === 'getSignaturesForAddress') return [{ signature: f.signature, memo }];
      throw new Error('rate limited');
    });
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, () => {}, { onCursor: checkpoints })).toEqual({ status: 'UNKNOWN' });
    expect(checkpoints).not.toHaveBeenCalled();
    const count = fetcher.mock.calls.length; const abort = new AbortController(); abort.abort();
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, () => {}, { signal: abort.signal })).toEqual({ status: 'UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('enforces a total read deadline even when each RPC individually answers within its timeout', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const abort = new AbortController(); setTimeout(() => abort.abort(), ms); return abort.signal;
    });
    const signatures = Array.from({ length: 5 }, () => ({ signature: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))), memo }));
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
      const request = RpcRequestSchema.parse(JSON.parse(String(init?.body)));
      const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
      const timer = setTimeout(() => {
        init?.signal?.removeEventListener('abort', abort);
        resolve(Response.json({ jsonrpc: '2.0', id: 1,
          result: request.method === 'getGenesisHash' ? config.genesisHash : request.method === 'getSignaturesForAddress' ? signatures : null }));
      }, 10_000);
      init?.signal?.addEventListener('abort', abort, { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = reconcileStoredOriginalPayment(config, identity);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ status: 'UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100_000); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('recovers confirmed transfer directly and observes a returned signature before the first RPC wait', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const observed = vi.fn();
    mockRpc((method) => { expect(observed).toHaveBeenCalledWith(f.signature); return method === 'getTransaction' ? f.rpc : []; });
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature, observed)).toEqual({ status: 'CONFIRMED', transaction: f.signature, confirmationStatus: 'confirmed' });
  });
  it('recovers a missing receipt by the actual random SDK memo without contacting the merchant', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const observed = vi.fn();
    const fetcher = mockRpc(method => method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo: '[32] ' + memo }] : f.rpc);
    expect(await reconcileStoredOriginalPayment({ ...config, merchant: Keypair.generate().publicKey.toBase58() }, identity, undefined, observed))
      .toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
    expect(observed).toHaveBeenCalledWith(f.signature);
    expect(fetcher.mock.calls.every(([url]) => url === config.rpcUrl)).toBe(true);
  });
  it('releases only after matching finalized failure and persists signature before finality lookup', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const failed = { ...f.rpc, meta: { err: { InstructionError: [2, 'InsufficientFunds'] } } };
    const observed = vi.fn();
    mockRpc((method, params) => {
      if (method === 'getSignaturesForAddress') return [{ signature: f.signature, memo }];
      if (JSON.stringify(params).includes('finalized')) expect(observed).toHaveBeenCalledWith(f.signature);
      return failed;
    });
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, observed)).toEqual({ status: 'FAILED', transaction: f.signature });
  });
  it('confirmed failure without finalized proof remains unknown', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    mockRpc((method, params) => method === 'getSignaturesForAddress' ? []
      : JSON.stringify(params).includes('finalized') ? null : { ...f.rpc, meta: { err: 'AccountNotFound' } });
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it('accepts definitive finalized success after a failed confirmed fork', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    mockRpc((_method, params) => JSON.stringify(params).includes('finalized') ? f.rpc : { ...f.rpc, meta: { err: 'AccountNotFound' } });
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'CONFIRMED', transaction: f.signature, confirmationStatus: 'finalized' });
  });
  it('absence and expired blockhash are never evidence that the original payment failed', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config, undefined,
      { recentBlockhash: f.transaction.message.recentBlockhash, lastValidBlockHeight: '1' });
    mockRpc(method => method === 'getTransaction' ? null : []);
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it('RPC unavailable, malformed result, or missing meta remains unknown', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    mockRpc(() => { throw new Error('offline'); });
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
    mockRpc(() => ({ ...f.rpc, meta: null }));
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
    mockRpc(() => ({ meta: { err: null } }));
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it('persists an identified original signature even when chain outcome metadata is unavailable', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    const observed = vi.fn();
    mockRpc(method => method === 'getSignaturesForAddress' ? [{ signature: f.signature, memo }]
      : { ...f.rpc, meta: null });
    expect(await reconcileStoredOriginalPayment(config, identity, undefined, observed)).toEqual({ status: 'UNKNOWN' });
    expect(observed).toHaveBeenCalledExactlyOnceWith(f.signature);
  });
  it('rejects unrelated receipt/history transactions despite equal transfer amount and recipient', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config); const unrelated = fixture();
    mockRpc(method => method === 'getSignaturesForAddress' ? [{ signature: unrelated.signature, memo }] : unrelated.rpc);
    expect(await reconcileStoredOriginalPayment(config, identity, unrelated.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it.each(['payer', 'recipient', 'mint', 'amount', 'network'] as const)('rejects mismatched stored %s facts', async field => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    mockRpc(() => f.rpc);
    const value = field === 'amount' ? '10001' : field === 'network' ? 'solana:wrong' : Keypair.generate().publicKey.toBase58();
    expect(await reconcileStoredOriginalPayment(config, { ...identity, [field]: value }, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it('rejects wrong RPC genesis', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: Keypair.generate().publicKey.toBase58() }))));
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
  it('keeps an unpinned local-chain original payment unknown', async () => {
    const f = fixture();
    const localConfig = loadPaymentConfig({ SOLANA_CLUSTER: 'localnet', USDC_MINT: config.mint,
      DEMO_BUYER_PUBLIC_KEY: config.buyer, DEMO_MERCHANT_PUBLIC_KEY: config.merchant, X402_FACILITATOR_URL: 'http://127.0.0.1:8080' });
    const identity = createSignedPaymentIdentity({ ...f.payload, accepted: { ...f.payload.accepted, network: localConfig.network } }, localConfig);
    const fetcher = mockRpc(() => f.rpc);
    expect(identity.genesisHash).toBeNull();
    expect(await reconcileStoredOriginalPayment(localConfig, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('repeated recovery after JSON persistence is deterministic and only reads the chain', async () => {
    const f = fixture(); const identity = SignedPaymentIdentitySchema.parse(JSON.parse(JSON.stringify(createSignedPaymentIdentity(f.payload, config))));
    const fetcher = mockRpc(() => f.rpc);
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toMatchObject({ status: 'CONFIRMED' });
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toMatchObject({ status: 'CONFIRMED' });
    expect(fetcher.mock.calls.map(([, init]) => RpcRequestSchema.parse(JSON.parse(String(init?.body))).method))
      .toEqual(['getGenesisHash', 'getTransaction', 'getGenesisHash', 'getTransaction']);
  });
  it('bounds hostile RPC response bodies', async () => {
    const f = fixture(); const identity = createSignedPaymentIdentity(f.payload, config);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(256 * 1_024 + 1))));
    expect(await reconcileStoredOriginalPayment(config, identity, f.signature)).toEqual({ status: 'UNKNOWN' });
  });
});
