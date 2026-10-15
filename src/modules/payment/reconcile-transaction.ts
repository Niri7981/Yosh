import { getBase58Decoder } from '@solana/kit';
import { z } from 'zod';
import type { PaymentConfig } from './payment-config';
import { DEVNET_GENESIS, MAINNET_GENESIS, validatePaymentEnvironment } from './payment-environment';
import { solanaRpc } from './solana-payment';
import { decodeOriginalTransaction, matchesSignedPaymentIdentity, SignedPaymentIdentitySchema,
  TransactionSignatureSchema, transactionMessageHash, verifyOriginalTransactionSignatures,
  type SignedPaymentIdentity } from './original-payment-evidence';
export { transactionMessageHash } from './original-payment-evidence';

export type ChainOutcome = { status: 'CONFIRMED'; transaction: string; confirmationStatus?: 'confirmed' | 'finalized' }
  | { status: 'FAILED'; transaction: string } | { status: 'UNKNOWN' };
const unknown: ChainOutcome = { status: 'UNKNOWN' };
export const RECONCILIATION_MAX_PAGES = 5;
export const RECONCILIATION_MAX_CANDIDATES = 20;
export const RECONCILIATION_TIMEOUT_MS = 30_000;
export type ReconciliationSearch = { before?: string; onCursor?: (before: string | undefined) => void; signal?: AbortSignal };
const TransactionResultSchema = z.object({
  transaction: z.tuple([z.string().max(1_644), z.literal('base64')]),
  meta: z.object({ err: z.union([z.null(), z.string().min(1), z.object({}).passthrough()]) }).passthrough().nullable(),
}).passthrough().nullable();
const HistorySchema = z.array(z.object({ signature: TransactionSignatureSchema, memo: z.string().max(1_024).nullable() })
  .passthrough()).max(100);
type ReadRpc = (method: string, params?: unknown[]) => Promise<unknown>;

/** A separate bounded buyer read path; it never contacts the merchant or sends a transaction. */
async function boundedRpc(config: PaymentConfig, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('ORIGINAL_PAYMENT_RPC_UNAVAILABLE'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1_024) throw new Error('ORIGINAL_PAYMENT_RPC_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown() }).passthrough().parse(result);
  if (!Object.hasOwn(envelope, 'result') || Object.hasOwn(envelope, 'error')) throw new Error('ORIGINAL_PAYMENT_RPC_INVALID');
  return envelope.result;
}

/** Cursor advances only after inspection. Failure keeps that candidate available next time.
 * Reaching the end restarts at the head on the next pass, so late indexing is not lost. */
async function searchHistory(read: ReadRpc, payer: string, memo: string, matches: MatchTransaction,
  onSignature: (signature: string) => void, options: ReconciliationSearch = {}): Promise<ChainOutcome> {
  let before = options.before === undefined ? undefined : TransactionSignatureSchema.parse(options.before);
  const seen = new Set<string>(); let inspected = 0;
  for (let page = 0; page < RECONCILIATION_MAX_PAGES; page++) {
    options.signal?.throwIfAborted();
    const history = HistorySchema.parse(await read('getSignaturesForAddress', [payer,
      { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) }]));
    if (!history.length) { options.onCursor?.(undefined); return unknown; }
    for (const item of history) {
      if (seen.has(item.signature) || item.signature === before) return unknown;
      seen.add(item.signature); options.signal?.throwIfAborted();
      if (item.memo?.includes(memo)) {
        if (before !== undefined) options.onCursor?.(before);
        const outcome = await inspect(read, item.signature, matches, onSignature);
        if (outcome.status !== 'UNKNOWN') return outcome;
        inspected++;
      }
      before = item.signature;
      if (inspected >= RECONCILIATION_MAX_CANDIDATES) { options.onCursor?.(before); return unknown; }
    }
    options.onCursor?.(before);
    if (history.length < 100) { options.onCursor?.(undefined); return unknown; }
  }
  return unknown;
}

async function correctNetwork(config: PaymentConfig, read: ReadRpc, identity?: SignedPaymentIdentity) {
  const { mode, cluster, genesisHash, rpcUrl, network, asset, isProduction } = config;
  validatePaymentEnvironment({ mode, cluster, genesisHash, rpcUrl, network, asset, isProduction });
  if (config.mint !== asset.mint) return false;
  if (identity && (identity.network !== network || identity.mint !== config.mint || identity.payer !== config.buyer
    || identity.decimals !== asset.decimals || identity.tokenProgram !== asset.tokenProgram
    || identity.genesisHash !== genesisHash)) return false;
  const genesis = await read('getGenesisHash');
  if (typeof genesis !== 'string' || genesisHash === null || genesis !== genesisHash) return false;
  if (cluster === 'localnet' && (genesis === DEVNET_GENESIS || genesis === MAINNET_GENESIS
    || (network !== 'solana:localnet' && network !== `solana:${genesis.slice(0, 32)}`))) return false;
  return true;
}

type MatchTransaction = (wire: string, signature: string) => boolean;
async function inspect(read: ReadRpc, signature: string, matches: MatchTransaction,
  onOriginalSignature: (signature: string) => void = () => {}): Promise<ChainOutcome> {
  if (!TransactionSignatureSchema.safeParse(signature).success) return unknown;
  const readTransaction = async (commitment: 'confirmed' | 'finalized') => TransactionResultSchema.parse(await read('getTransaction',
    [signature, { encoding: 'base64', commitment, maxSupportedTransactionVersion: 0 }]));
  const result = await readTransaction('confirmed');
  if (!result || !matches(result.transaction[0], signature)) return unknown;
  onOriginalSignature(signature);
  if (!result.meta) return unknown;
  if (result.meta.err === null) return { status: 'CONFIRMED', transaction: signature, confirmationStatus: 'confirmed' };
  // A failed confirmed fork is not a conclusive failure of the original payment.
  const finalized = await readTransaction('finalized');
  if (!finalized?.meta || !matches(finalized.transaction[0], signature)) return unknown;
  return finalized.meta.err === null
    ? { status: 'CONFIRMED', transaction: signature, confirmationStatus: 'finalized' }
    : { status: 'FAILED', transaction: signature };
}

/** Reconcile immutable buyer-signed facts; disappearance, expiry, or absent history remains unknown. */
export async function reconcileStoredOriginalPayment(config: PaymentConfig, stored: SignedPaymentIdentity, knownSignature?: string,
  onSignature: (signature: string) => void = () => {}, options: ReconciliationSearch = {}): Promise<ChainOutcome> {
  try {
    const identity = SignedPaymentIdentitySchema.parse(stored);
    const timeout = AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const read: ReadRpc = (method, params) => boundedRpc(config, method, params, signal);
    const signatures = [...new Set([identity.knownSignature, knownSignature].filter((value): value is string => value !== undefined))];
    // Receipt signatures remain observations until exact signed-message verification succeeds.
    for (const signature of signatures) if (TransactionSignatureSchema.safeParse(signature).success) onSignature(signature);
    if (!await correctNetwork(config, read, identity)) return unknown;
    const matches: MatchTransaction = (wire, signature) => matchesSignedPaymentIdentity(wire, identity, config, signature);
    for (const signature of signatures) {
      const outcome = await inspect(read, signature, matches);
      if (outcome.status !== 'UNKNOWN') return outcome;
    }
    return await searchHistory(read, identity.payer, identity.actualMemo, matches, onSignature, { ...options, signal });
  } catch { return unknown; }
}

function legacyMatches(config: PaymentConfig, messageHash: string): MatchTransaction {
  return (wire, signature) => {
    try {
      const tx = decodeOriginalTransaction(wire).transaction;
      const buyerIndex = tx.message.staticAccountKeys.findIndex(key => key.toBase58() === config.buyer);
      return buyerIndex >= 0 && buyerIndex < tx.message.header.numRequiredSignatures
        && verifyOriginalTransactionSignatures(tx, true) && transactionMessageHash(wire) === messageHash
        && getBase58Decoder().decode(tx.signatures[0]) === signature;
    } catch { return false; }
  };
}

/** Compatibility for the existing test merchant's already-validated message-hash records. */
export async function inspectOriginalTransaction(config: PaymentConfig, signature: string, messageHash: string): Promise<ChainOutcome> {
  try {
    const read: ReadRpc = (method, params) => solanaRpc<unknown>(config, method, params);
    if (!/^[a-f0-9]{64}$/.test(messageHash) || !await correctNetwork(config, read)) return unknown;
    return await inspect(read, signature, legacyMatches(config, messageHash));
  } catch { return unknown; }
}

/** Compatibility lookup retains exact message matching; arbitrary actual SDK memos are accepted. */
export async function reconcileOriginalTransaction(config: PaymentConfig, messageHash: string, memo: string, knownSignature?: string): Promise<ChainOutcome> {
  try {
    if (!/^[a-f0-9]{64}$/.test(messageHash) || typeof memo !== 'string' || memo.length === 0 || Buffer.byteLength(memo) > 256) return unknown;
    const read: ReadRpc = (method, params) => solanaRpc<unknown>(config, method, params);
    if (!await correctNetwork(config, read)) return unknown;
    const matches = legacyMatches(config, messageHash);
    if (knownSignature) {
      const known = await inspect(read, knownSignature, matches);
      if (known.status !== 'UNKNOWN') return known;
    }
    return await searchHistory(read, config.buyer, memo, matches, () => {});
  } catch { return unknown; }
}
