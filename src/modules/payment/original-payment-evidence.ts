import { createHash, createPublicKey, verify } from 'node:crypto';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { PaymentPayload } from '@x402/core/types';
import { z } from 'zod';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { TOKEN_PROGRAM, validatePaymentEnvironment } from './payment-environment';
import type { PaymentConfig } from './payment-config';
import { matchesMppSignedPaymentIdentity } from './mpp-payment-evidence';

const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const publicKey = z.string().refine(value => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TransactionSignatureSchema = z.string().refine(value => {
  try { return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) && getBase58Encoder().encode(value).length === 64; }
  catch { return false; }
});
const amount = z.string().refine(value => PositiveAtomicAmountSchema.safeParse(value).success);
export const SignedPaymentIdentitySchema = z.object({
  version: z.literal(1), protocol: z.literal('mpp').optional(), payer: publicKey, recipient: publicKey, mint: publicKey,
  amount, decimals: z.number().int().min(0).max(255), network: z.templateLiteral(['solana:', z.string().min(1).max(193)]),
  genesisHash: publicKey.nullable(), tokenProgram: z.literal(TOKEN_PROGRAM),
  sourceTokenAccount: publicKey, recipientTokenAccount: publicKey,
  messageHash: hash, wireHash: hash, buyerSignature: TransactionSignatureSchema,
  buyerSignerIndex: z.number().int().min(0).max(31), feePayer: publicKey,
  actualMemo: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 256),
  recentBlockhash: publicKey, lastValidBlockHeight: z.string().regex(/^(0|[1-9]\d*)$/).max(20).optional(),
  knownSignature: TransactionSignatureSchema.optional(),
}).strict().superRefine((identity, ctx) => {
  // Legacy x402 evidence still requires the SDK memo. Only MPP's explicitly
  // identified, fully buyer-signed charge may have no memo at all.
  if (identity.protocol === 'mpp'
    ? identity.buyerSignerIndex !== 0 || identity.feePayer !== identity.payer || identity.knownSignature !== identity.buyerSignature
    : identity.actualMemo.length === 0) ctx.addIssue({ code: 'custom', message: 'INVALID_ORIGINAL_PAYMENT_IDENTITY' });
});
export type SignedPaymentIdentity = Readonly<z.infer<typeof SignedPaymentIdentitySchema>>;
export type AuthorizedTransfer = Readonly<{
  payer: string; recipient: string; mint: string; amount: string; decimals: number; feePayer?: string;
}>;
export type OriginalPaymentLifetime = Readonly<{ recentBlockhash: string; lastValidBlockHeight: string }>;

function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

export function decodeOriginalTransaction(wire: string) {
  // Solana's packet limit also bounds parsing of hostile merchant/RPC input.
  if (typeof wire !== 'string' || wire.length > 1_644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(wire)) throw new Error('INVALID_ORIGINAL_PAYMENT');
  const bytes = Buffer.from(wire, 'base64');
  if (bytes.length > 1_232 || bytes.toString('base64') !== wire) throw new Error('INVALID_ORIGINAL_PAYMENT');
  const transaction = VersionedTransaction.deserialize(bytes);
  if (!Buffer.from(transaction.serialize()).equals(bytes) || transaction.message.addressTableLookups.length !== 0) {
    throw new Error('UNSUPPORTED_ORIGINAL_PAYMENT');
  }
  return { transaction, bytes, message: transaction.message.serialize() };
}

function signedBy(transaction: VersionedTransaction, signerIndex: number) {
  const signature = transaction.signatures[signerIndex];
  const key = transaction.message.staticAccountKeys[signerIndex];
  if (!signature || !key || signerIndex >= transaction.message.header.numRequiredSignatures) return false;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]), format: 'der', type: 'spki' });
  return signature.length === 64 && verify(null, transaction.message.serialize(), publicKey, signature);
}

export function verifyOriginalTransactionSignatures(transaction: VersionedTransaction, requireComplete = false) {
  for (let index = 0; index < transaction.message.header.numRequiredSignatures; index++) {
    const present = transaction.signatures[index]?.some(byte => byte !== 0);
    if ((requireComplete || present) && !signedBy(transaction, index)) return false;
  }
  return true;
}

export function transactionMessageHash(wire: string) { return digest(decodeOriginalTransaction(wire).message); }

function tokenAccount(owner: string, mint: string) {
  return PublicKey.findProgramAddressSync([
    new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer(),
  ], ASSOCIATED_TOKEN_PROGRAM)[0].toBase58();
}

/** Decode the SDK's signed transfer; quote metadata is not evidence of what was signed. */
export function createSignedPaymentIdentity(payload: PaymentPayload, config: PaymentConfig,
  authorized: AuthorizedTransfer = { payer: config.buyer, recipient: config.merchant, mint: config.mint,
    amount: payload.accepted.amount, decimals: config.asset.decimals },
  lifetime?: OriginalPaymentLifetime): SignedPaymentIdentity {
  const { mode, cluster, genesisHash, rpcUrl, network, asset, isProduction } = config;
  validatePaymentEnvironment({ mode, cluster, genesisHash, rpcUrl, network, asset, isProduction });
  if (config.mint !== config.asset.mint || payload.accepted.scheme !== 'exact' || payload.accepted.network !== config.network || payload.accepted.asset !== config.mint
    || payload.accepted.payTo !== config.merchant || payload.accepted.amount !== authorized.amount
    || authorized.payer !== config.buyer || authorized.recipient !== config.merchant || authorized.mint !== config.mint
    || authorized.decimals !== config.asset.decimals || !amount.safeParse(authorized.amount).success
    || typeof payload.payload.transaction !== 'string') throw new Error('ORIGINAL_PAYMENT_AUTHORIZATION_MISMATCH');
  return identifySignedTransfer(payload, authorized, config.network, config.genesisHash, lifetime);
}

function identifySignedTransfer(payload: PaymentPayload, authorized: AuthorizedTransfer, network: string,
  genesisHash: string | null, lifetime?: OriginalPaymentLifetime, requireBuyerSignature = true): SignedPaymentIdentity {
  if (payload.accepted.scheme !== 'exact' || payload.accepted.network !== network || payload.accepted.asset !== authorized.mint
    || payload.accepted.payTo !== authorized.recipient || payload.accepted.amount !== authorized.amount
    || !amount.safeParse(authorized.amount).success || typeof payload.payload.transaction !== 'string') {
    throw new Error('ORIGINAL_PAYMENT_AUTHORIZATION_MISMATCH');
  }
  const { transaction, bytes, message } = decodeOriginalTransaction(payload.payload.transaction);
  const keys = transaction.message.staticAccountKeys;
  const feePayer = keys[0]?.toBase58();
  if (!feePayer || feePayer !== payload.accepted.extra?.feePayer || (authorized.feePayer !== undefined && authorized.feePayer !== feePayer)) {
    throw new Error('ORIGINAL_PAYMENT_FEE_PAYER_MISMATCH');
  }
  const buyerSignerIndex = keys.findIndex(key => key.toBase58() === authorized.payer);
  const expectedSignerCount = feePayer === authorized.payer ? 1 : 2;
  if (transaction.message.header.numRequiredSignatures !== expectedSignerCount || buyerSignerIndex < 0 || buyerSignerIndex >= expectedSignerCount
    || (requireBuyerSignature && (!signedBy(transaction, buyerSignerIndex)
      || !verifyOriginalTransactionSignatures(transaction)))) throw new Error('ORIGINAL_PAYMENT_SIGNER_MISMATCH');
  const sourceTokenAccount = tokenAccount(authorized.payer, authorized.mint);
  const recipientTokenAccount = tokenAccount(authorized.recipient, authorized.mint);
  let transferCount = 0;
  let actualMemo: string | undefined;
  const computeKinds = new Set<number>();
  for (const instruction of transaction.message.compiledInstructions) {
    const program = keys[instruction.programIdIndex]?.toBase58();
    const accounts = instruction.accountKeyIndexes.map(index => keys[index]?.toBase58());
    const data = Buffer.from(instruction.data);
    if (program === TOKEN_PROGRAM) {
      transferCount++;
      if (transferCount !== 1 || data.length !== 10 || data[0] !== 12 || data.readBigUInt64LE(1).toString() !== authorized.amount
        || data[9] !== authorized.decimals || accounts.length !== 4 || accounts[0] !== sourceTokenAccount
        || accounts[1] !== authorized.mint || accounts[2] !== recipientTokenAccount || accounts[3] !== authorized.payer
        || !transaction.message.isAccountWritable(instruction.accountKeyIndexes[0])
        || !transaction.message.isAccountWritable(instruction.accountKeyIndexes[2])) throw new Error('ORIGINAL_PAYMENT_TRANSFER_MISMATCH');
    } else if (program === MEMO_PROGRAM) {
      if (actualMemo !== undefined || accounts.length !== 0 || data.length === 0 || data.length > 256) throw new Error('ORIGINAL_PAYMENT_MEMO_MISMATCH');
      actualMemo = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } else if (program === COMPUTE_PROGRAM) {
      // These are the locked SDK's bounded fee settings, not arbitrary buyer instructions.
      const kind = data[0];
      if (accounts.length !== 0 || computeKinds.has(kind)
        || !((kind === 2 && data.length === 5 && data.readUInt32LE(1) === 20_000)
          || (kind === 3 && data.length === 9 && data.readBigUInt64LE(1) === 1n))) throw new Error('UNSUPPORTED_ORIGINAL_PAYMENT');
      computeKinds.add(kind);
    } else throw new Error('UNSUPPORTED_ORIGINAL_PAYMENT');
  }
  if (transferCount !== 1 || actualMemo === undefined) throw new Error('ORIGINAL_PAYMENT_TRANSFER_MISMATCH');
  const quotedMemo = payload.accepted.extra?.memo;
  if (quotedMemo !== undefined && (typeof quotedMemo !== 'string' || quotedMemo !== actualMemo)) {
    throw new Error('ORIGINAL_PAYMENT_MEMO_MISMATCH');
  }
  const recentBlockhash = transaction.message.recentBlockhash;
  if (lifetime && (lifetime.recentBlockhash !== recentBlockhash || !/^(0|[1-9]\d*)$/.test(lifetime.lastValidBlockHeight))) {
    throw new Error('ORIGINAL_PAYMENT_LIFETIME_MISMATCH');
  }
  const knownSignature = transaction.signatures[0].some(byte => byte !== 0)
    ? getBase58Decoder().decode(transaction.signatures[0]) : undefined;
  return Object.freeze(SignedPaymentIdentitySchema.parse({ version: 1, ...authorized, feePayer,
    network, genesisHash, tokenProgram: TOKEN_PROGRAM,
    sourceTokenAccount, recipientTokenAccount, messageHash: digest(message), wireHash: digest(bytes),
    buyerSignature: getBase58Decoder().decode(transaction.signatures[buyerSignerIndex]), buyerSignerIndex,
    actualMemo, recentBlockhash, ...(lifetime ? { lastValidBlockHeight: lifetime.lastValidBlockHeight } : {}),
    ...(knownSignature ? { knownSignature } : {}),
  }));
}

/** Inspect the official SDK transaction before signing with the same bounded
 * transfer/memo/program rules used for durable original-payment evidence.
 * Unsigned inspection never yields a payment proof or accounting identity. */
export function assertUnsignedPaymentBindings(wire: string, config: PaymentConfig, requirement: PaymentPayload['accepted']) {
  if (requirement.network !== config.network || requirement.asset !== config.mint || requirement.payTo !== config.merchant) {
    throw new Error('ORIGINAL_PAYMENT_AUTHORIZATION_MISMATCH');
  }
  identifySignedTransfer({ x402Version: 2, accepted: requirement, payload: { transaction: wire } },
    { payer: config.buyer, recipient: config.merchant, mint: config.mint, amount: requirement.amount,
      decimals: config.asset.decimals, feePayer: String(requirement.extra?.feePayer) }, config.network, config.genesisHash, undefined, false);
}

/** The durable identity must prove the saved payload itself, independent of mutable configuration. */
export function validateSignedPaymentIdentity(payload: PaymentPayload, stored: SignedPaymentIdentity): boolean {
  try {
    const identity = SignedPaymentIdentitySchema.parse(stored);
    const derived = identifySignedTransfer(payload, { payer: identity.payer, recipient: identity.recipient, mint: identity.mint,
      amount: identity.amount, decimals: identity.decimals, feePayer: identity.feePayer }, identity.network, identity.genesisHash,
    identity.lastValidBlockHeight === undefined ? undefined : {
      recentBlockhash: identity.recentBlockhash, lastValidBlockHeight: identity.lastValidBlockHeight,
    });
    return JSON.stringify(derived) === JSON.stringify(identity);
  } catch { return false; }
}

/** Fee-payer signature completion may change wire bytes, never the buyer-signed message. */
export function matchesSignedPaymentIdentity(wire: string, identity: SignedPaymentIdentity, config: PaymentConfig, signature: string) {
  if (identity.protocol === 'mpp') return matchesMppSignedPaymentIdentity(wire, identity, config, signature);
  try {
    const decoded = decodeOriginalTransaction(wire).transaction;
    const derived = createSignedPaymentIdentity({ x402Version: 2, resource: { url: 'original-payment-reconciliation' },
      accepted: { scheme: 'exact', network: identity.network, asset: identity.mint, amount: identity.amount,
        payTo: identity.recipient, maxTimeoutSeconds: 1, extra: { feePayer: identity.feePayer } }, payload: { transaction: wire } },
    { ...config, merchant: identity.recipient },
    { payer: identity.payer, recipient: identity.recipient, mint: identity.mint, amount: identity.amount, decimals: identity.decimals,
      feePayer: identity.feePayer });
    return verifyOriginalTransactionSignatures(decoded, true) && derived.knownSignature === signature
      && derived.messageHash === identity.messageHash && derived.buyerSignature === identity.buyerSignature
      && derived.buyerSignerIndex === identity.buyerSignerIndex && derived.actualMemo === identity.actualMemo
      && derived.recentBlockhash === identity.recentBlockhash && derived.sourceTokenAccount === identity.sourceTokenAccount
      && derived.recipientTokenAccount === identity.recipientTokenAccount;
  } catch { return false; }
}
