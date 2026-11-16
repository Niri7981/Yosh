import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MppChargeQuoteSchema, MppStoredPaymentSchema, readMppChargeRequest } from '../../src/modules/payment/mpp-contract';
import { assertMppUnsignedBindings, createMppSignedPaymentIdentity, validateMppSignedPaymentIdentity } from '../../src/modules/payment/mpp-payment-evidence';
import { createSignedPaymentIdentity, decodeOriginalTransaction, matchesSignedPaymentIdentity, SignedPaymentIdentitySchema } from '../../src/modules/payment/original-payment-evidence';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { mppCredential, mppFixture } from '../helpers/mpp-fixture';

afterEach(() => vi.unstubAllGlobals());

function modified(f: ReturnType<typeof mppFixture>, instructions: TransactionInstruction[], signed = false, payer = f.buyer) {
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey,
    recentBlockhash: f.lifetime.recentBlockhash, instructions }).compileToV0Message());
  if (signed) transaction.sign(payer === f.buyer ? [f.buyer] : [f.buyer, payer]);
  const wire = Buffer.from(transaction.serialize()).toString('base64');
  return { protocol: 'mpp' as const, quote: f.quote, credential: mppCredential(f.quote, wire), transaction: wire };
}

describe('MPP charge compiled transaction bindings', () => {
  it.each([undefined, 'external-charge-123'])('validates a complete client-paid charge with memo %s', memo => {
    const f = mppFixture({ memo });
    expect(() => assertMppUnsignedBindings(f.unsignedWire, f.config, f.quote, f.lifetime)).not.toThrow();
    expect(f.identity).toMatchObject({ protocol: 'mpp', buyerSignerIndex: 0, feePayer: f.config.buyer,
      actualMemo: memo ?? '', knownSignature: f.signature, lastValidBlockHeight: f.lifetime.lastValidBlockHeight });
    expect(validateMppSignedPaymentIdentity(f.payment, f.identity)).toBe(true);
    expect(matchesSignedPaymentIdentity(f.payment.transaction, f.identity, f.config, f.signature)).toBe(true);
  });

  it('rejects any nonzero signature before signing and verifies the actual buyer signature afterward', () => {
    const f = mppFixture();
    expect(() => assertMppUnsignedBindings(f.payment.transaction, f.config, f.quote)).toThrow('MPP_SIGNER_MISMATCH');
    const transaction = decodeOriginalTransaction(f.unsignedWire).transaction;
    transaction.signatures[0][0] = 1;
    const wire = Buffer.from(transaction.serialize()).toString('base64');
    expect(() => assertMppUnsignedBindings(wire, f.config, f.quote)).toThrow('MPP_SIGNER_MISMATCH');
    const tampered = { ...f.payment, transaction: wire, credential: mppCredential(f.quote, wire) };
    expect(() => createMppSignedPaymentIdentity(tampered, f.config)).toThrow('MPP_SIGNER_MISMATCH');
    expect(() => createMppSignedPaymentIdentity({ ...f.payment, transaction: f.unsignedWire,
      credential: mppCredential(f.quote, f.unsignedWire) }, f.config)).toThrow('MPP_SIGNER_MISMATCH');
  });

  it.each(['amount', 'decimals', 'recipient', 'mint', 'authority'] as const)('rejects a changed transfer %s', field => {
    const f = mppFixture();
    const instructions = f.instructions;
    if (field === 'amount') instructions[2].data.writeBigUInt64LE(10001n, 1);
    else if (field === 'decimals') instructions[2].data[9] = 9;
    else instructions[2].keys[field === 'recipient' ? 2 : field === 'mint' ? 1 : 3].pubkey = Keypair.generate().publicKey;
    const payment = modified(f, instructions);
    expect(() => assertMppUnsignedBindings(payment.transaction, f.config, f.quote)).toThrow();
  });

  it.each(['limit', 'price', 'omit', 'duplicate', 'order'] as const)('rejects changed compute fee policy: %s', field => {
    const f = mppFixture();
    if (field === 'limit') f.instructions[0].data.writeUInt32LE(200_001, 1);
    if (field === 'price') f.instructions[1].data.writeBigUInt64LE(2n, 1);
    if (field === 'omit') f.instructions.splice(0, 1);
    if (field === 'duplicate') f.instructions.push(f.instructions[0]);
    if (field === 'order') [f.instructions[0], f.instructions[1]] = [f.instructions[1], f.instructions[0]];
    expect(() => assertMppUnsignedBindings(modified(f, f.instructions).transaction, f.config, f.quote)).toThrow();
  });

  it('rejects additional programs, ATA creation, extra transfers and sponsored payers', () => {
    const f = mppFixture();
    for (const instruction of [SystemProgram.transfer({ fromPubkey: f.buyer.publicKey, toPubkey: f.merchant.publicKey, lamports: 1 }),
      new TransactionInstruction({ programId: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), keys: [], data: Buffer.from([1]) }),
      f.instructions[2]]) {
      expect(() => assertMppUnsignedBindings(modified(f, [...f.instructions, instruction]).transaction, f.config, f.quote)).toThrow();
    }
    expect(() => assertMppUnsignedBindings(modified(f, f.instructions, false, Keypair.generate()).transaction, f.config, f.quote)).toThrow('MPP_SIGNER_MISMATCH');
  });

  it('rejects a changed/missing memo, writable mint or additional unused account', () => {
    const f = mppFixture({ memo: 'authorized-memo' });
    f.instructions[3].data = Buffer.from('changed-memo');
    expect(() => assertMppUnsignedBindings(modified(f, f.instructions).transaction, f.config, f.quote)).toThrow('MPP_MEMO_MISMATCH');
    expect(() => assertMppUnsignedBindings(modified(f, f.instructions.slice(0, 3)).transaction, f.config, f.quote)).toThrow();
    f.instructions[2].keys[1].isWritable = true;
    expect(() => assertMppUnsignedBindings(modified(f, f.instructions).transaction, f.config, f.quote)).toThrow('MPP_ACCOUNT_MISMATCH');
    const tx = decodeOriginalTransaction(f.unsignedWire).transaction;
    tx.message.staticAccountKeys.push(Keypair.generate().publicKey);
    expect(() => assertMppUnsignedBindings(Buffer.from(tx.serialize()).toString('base64'), f.config, f.quote)).toThrow('MPP_ACCOUNT_MISMATCH');
  });

  it('rejects message replacement, wrong captured blockhash and malformed wire', () => {
    const f = mppFixture();
    const other = mppFixture({ buyer: f.buyer, merchant: f.merchant });
    expect(matchesSignedPaymentIdentity(other.payment.transaction, f.identity, f.config, other.signature)).toBe(false);
    expect(() => assertMppUnsignedBindings(f.unsignedWire, f.config, f.quote,
      { ...f.lifetime, recentBlockhash: Keypair.generate().publicKey.toBase58() })).toThrow('MPP_LIFETIME_MISMATCH');
    expect(() => assertMppUnsignedBindings('not base64', f.config, f.quote)).toThrow();
  });

  it('rejects address lookup tables, legacy messages and unexplained signatures', () => {
    const f = mppFixture();
    const lookup = decodeOriginalTransaction(f.unsignedWire).transaction;
    if (lookup.message.version === 0) lookup.message.addressTableLookups.push({ accountKey: Keypair.generate().publicKey,
      writableIndexes: [0], readonlyIndexes: [] });
    expect(() => assertMppUnsignedBindings(Buffer.from(lookup.serialize()).toString('base64'), f.config, f.quote)).toThrow();
    const legacy = new VersionedTransaction(new TransactionMessage({ payerKey: f.buyer.publicKey,
      recentBlockhash: f.lifetime.recentBlockhash, instructions: f.instructions }).compileToLegacyMessage());
    expect(() => assertMppUnsignedBindings(Buffer.from(legacy.serialize()).toString('base64'), f.config, f.quote)).toThrow();
    const extraSignature = decodeOriginalTransaction(f.unsignedWire).transaction;
    extraSignature.signatures.push(new Uint8Array(64));
    expect(() => assertMppUnsignedBindings(Buffer.from(extraSignature.serialize()).toString('base64'), f.config, f.quote)).toThrow();
  });

  it('does not widen the x402 compute budget to accept an MPP charge', () => {
    const f = mppFixture({ memo: 'memo' });
    expect(() => createSignedPaymentIdentity({ x402Version: 2, accepted: { scheme: 'exact', network: f.config.network,
      asset: f.config.mint, payTo: f.config.merchant, amount: f.quote.amount, maxTimeoutSeconds: 120,
      extra: { feePayer: f.config.buyer } }, payload: { transaction: f.payment.transaction } }, f.config)).toThrow('UNSUPPORTED_ORIGINAL_PAYMENT');
  });
});

describe('MPP durable contract and original evidence', () => {
  it('requires native USDC, bound economics and known method terms', () => {
    const f = mppFixture();
    const request = readMppChargeRequest(f.quote);
    for (const changed of [{ amount: '10001' }, { currency: Keypair.generate().publicKey.toBase58() },
      { recipient: Keypair.generate().publicKey.toBase58() }, { amount: 10000 },
      { methodDetails: { ...request.methodDetails, feePayer: true } },
      { methodDetails: { ...request.methodDetails, splits: [] } },
      { methodDetails: { ...request.methodDetails, tokenProgram: Keypair.generate().publicKey.toBase58() } },
      { methodDetails: { ...request.methodDetails, transactionVersions: [1] } }, { unknownTerm: true }]) {
      const challenge = { ...f.quote.challenge, request: Buffer.from(JSON.stringify({ ...request, ...changed })).toString('base64url') };
      expect(MppChargeQuoteSchema.safeParse({ ...f.quote, challenge }).success).toBe(false);
    }
    expect(MppChargeQuoteSchema.safeParse({ ...f.quote, expiresAt: f.quote.expiresAt + 1 }).success).toBe(false);
  });

  it('does not accept a credential for another challenge, transaction or payload type', () => {
    const f = mppFixture(); const other = mppFixture();
    expect(MppStoredPaymentSchema.safeParse({ ...f.payment, credential: other.payment.credential }).success).toBe(false);
    const changed = { ...f.quote, challenge: { ...f.quote.challenge, id: 'different' } };
    expect(MppStoredPaymentSchema.safeParse({ ...f.payment, credential: mppCredential(changed, f.payment.transaction) }).success).toBe(false);
    const credential = 'Payment ' + Buffer.from(JSON.stringify({ challenge: f.quote.challenge,
      payload: { type: 'signature', signature: f.signature } })).toString('base64url');
    expect(MppStoredPaymentSchema.safeParse({ ...f.payment, credential }).success).toBe(false);
  });

  it('keeps legacy x402 memo requirements and rejects identity tampering after persistence', () => {
    const f = mppFixture();
    expect(SignedPaymentIdentitySchema.safeParse({ ...f.identity, protocol: undefined }).success).toBe(false);
    const persisted = JSON.parse(JSON.stringify(f.identity));
    expect(validateMppSignedPaymentIdentity(f.payment, persisted)).toBe(true);
    for (const change of [{ amount: '10001' }, { actualMemo: 'changed' }, { messageHash: 'a'.repeat(64) },
      { wireHash: 'b'.repeat(64) }, { decimals: 9 }, { buyerSignerIndex: 1 },
      { buyerSignature: mppFixture().signature }, { knownSignature: undefined }, { protocol: undefined }]) {
      expect(validateMppSignedPaymentIdentity(f.payment, { ...f.identity, ...change })).toBe(false);
    }
  });

  it('reconciles the exact original signature without a memo and leaves absent transactions unknown', async () => {
    const f = mppFixture();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: 1, result: request.method === 'getGenesisHash' ? f.config.genesisHash
        : request.method === 'getTransaction' ? { transaction: [f.payment.transaction, 'base64'], meta: { err: null } } : [] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await reconcileStoredOriginalPayment(f.config, f.identity)).toMatchObject({ status: 'CONFIRMED', transaction: f.signature });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: 1, result: request.method === 'getGenesisHash' ? f.config.genesisHash
        : request.method === 'getTransaction' ? null : [] });
    }));
    expect(await reconcileStoredOriginalPayment(f.config, f.identity)).toEqual({ status: 'UNKNOWN' });
  });
});
