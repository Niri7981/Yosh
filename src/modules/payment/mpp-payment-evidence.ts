import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getBase58Decoder } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { MppChargeQuoteSchema, MppStoredPaymentSchema, readMppChargeRequest,
  type MppChargeQuote, type MppStoredPayment } from './mpp-contract';
import { decodeOriginalTransaction, SignedPaymentIdentitySchema, verifyOriginalTransactionSignatures,
  type OriginalPaymentLifetime, type SignedPaymentIdentity } from './original-payment-evidence';
import type { PaymentConfig } from './payment-config';
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_GENESIS, MAINNET_NETWORK,
  MAINNET_USDC_MINT, TOKEN_PROGRAM, validatePaymentEnvironment } from './payment-environment';

const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_PROGRAM = 'ComputeBudget111111111111111111111111111111';
type TransferBinding = Readonly<{ payer: string; recipient: string; mint: string; amount: string;
  network: string; genesisHash: string | null; memo: string; quotedBlockhash?: string }>;

function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function tokenAccount(owner: string, mint: string) {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(),
    new PublicKey(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0].toBase58();
}

function assertEnvironment(config: PaymentConfig) {
  const { mode, cluster, genesisHash, rpcUrl, network, asset, isProduction } = config;
  validatePaymentEnvironment({ mode, cluster, genesisHash, rpcUrl, network, asset, isProduction });
  if (cluster === 'localnet' || mode === 'simulated' || config.mint !== asset.mint) throw new Error('MPP_ENVIRONMENT_MISMATCH');
}

function quoteBinding(quote: MppChargeQuote, payer: string, genesisHash: string | null): TransferBinding {
  const request = readMppChargeRequest(quote);
  return { payer, recipient: quote.payTo, mint: quote.asset, amount: quote.amount, network: quote.network, genesisHash,
    memo: request.externalId ?? '', quotedBlockhash: request.methodDetails.recentBlockhash };
}

function authorizedQuote(config: PaymentConfig, input: MppChargeQuote): MppChargeQuote {
  assertEnvironment(config);
  const quote = MppChargeQuoteSchema.parse(input);
  if (quote.network !== config.network || quote.asset !== config.mint || quote.payTo !== config.merchant
    || config.buyer === config.merchant) throw new Error('MPP_AUTHORIZATION_MISMATCH');
  return quote;
}

/** Inspect the actual compiled SDK message, not merely its proposed request.
 * This phase accepts only the locked SDK's V0, one-transfer, client-paid shape. */
function inspect(wire: string, binding: TransferBinding, signed: boolean, lifetime?: OriginalPaymentLifetime) {
  const { transaction, bytes, message } = decodeOriginalTransaction(wire);
  const tx = transaction.message;
  if (tx.version !== 0 || tx.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1
    || tx.header.numReadonlySignedAccounts !== 0 || tx.staticAccountKeys[0]?.toBase58() !== binding.payer
    || (signed ? !verifyOriginalTransactionSignatures(transaction, true)
      : transaction.signatures.some(signature => signature.some(byte => byte !== 0)))) throw new Error('MPP_SIGNER_MISMATCH');
  const mainnet = binding.network === MAINNET_NETWORK;
  if ((!mainnet && binding.network !== DEVNET_NETWORK) || binding.mint !== (mainnet ? MAINNET_USDC_MINT : DEVNET_USDC_MINT)
    || binding.genesisHash !== (mainnet ? MAINNET_GENESIS : DEVNET_GENESIS)) throw new Error('MPP_ENVIRONMENT_MISMATCH');
  const sourceTokenAccount = tokenAccount(binding.payer, binding.mint);
  const recipientTokenAccount = tokenAccount(binding.recipient, binding.mint);
  if (sourceTokenAccount === recipientTokenAccount) throw new Error('MPP_TRANSFER_MISMATCH');
  const expectedKeys = new Set([binding.payer, sourceTokenAccount, recipientTokenAccount, binding.mint, TOKEN_PROGRAM,
    COMPUTE_PROGRAM, ...(binding.memo ? [MEMO_PROGRAM] : [])]);
  const writable = new Set([binding.payer, sourceTokenAccount, recipientTokenAccount]);
  if (expectedKeys.size !== (binding.memo ? 7 : 6) || tx.staticAccountKeys.length !== expectedKeys.size
    || new Set(tx.staticAccountKeys.map(key => key.toBase58())).size !== expectedKeys.size
    || tx.staticAccountKeys.some((key, index) => !expectedKeys.has(key.toBase58())
      || tx.isAccountWritable(index) !== writable.has(key.toBase58()))) throw new Error('MPP_ACCOUNT_MISMATCH');
  if (tx.compiledInstructions.length !== (binding.memo ? 4 : 3)) throw new Error('MPP_INSTRUCTION_MISMATCH');
  for (const [index, instruction] of tx.compiledInstructions.entries()) {
    const program = tx.staticAccountKeys[instruction.programIdIndex]?.toBase58();
    const accounts = instruction.accountKeyIndexes.map(key => tx.staticAccountKeys[key]?.toBase58());
    const data = Buffer.from(instruction.data);
    if (index < 2) {
      // Locked solana-pay-kit 0.10.0: 200,000 CU / 1 micro-lamport. Both
      // instructions are mandatory so omission cannot change the fee policy.
      if (program !== COMPUTE_PROGRAM || accounts.length !== 0 || (index === 0
        ? data.length !== 5 || data[0] !== 2 || data.readUInt32LE(1) !== 200_000
        : data.length !== 9 || data[0] !== 3 || data.readBigUInt64LE(1) !== 1n)) throw new Error('MPP_FEE_MISMATCH');
    } else if (index === 2) {
      if (program !== TOKEN_PROGRAM || data.length !== 10 || data[0] !== 12
        || data.readBigUInt64LE(1).toString() !== binding.amount || data[9] !== 6
        || !isDeepStrictEqual(accounts, [sourceTokenAccount, binding.mint, recipientTokenAccount, binding.payer])) {
        throw new Error('MPP_TRANSFER_MISMATCH');
      }
    } else if (program !== MEMO_PROGRAM || accounts.length !== 0 || !data.equals(Buffer.from(binding.memo, 'utf8'))) {
      throw new Error('MPP_MEMO_MISMATCH');
    }
  }
  if ((binding.quotedBlockhash !== undefined && tx.recentBlockhash !== binding.quotedBlockhash)
    || (lifetime && (lifetime.recentBlockhash !== tx.recentBlockhash
      || !/^(0|[1-9]\d{0,19})$/.test(lifetime.lastValidBlockHeight)))) throw new Error('MPP_LIFETIME_MISMATCH');
  return { transaction, bytes, message, sourceTokenAccount, recipientTokenAccount };
}

export function assertMppUnsignedBindings(wire: string, config: PaymentConfig, quote: MppChargeQuote,
  lifetime?: OriginalPaymentLifetime): void {
  inspect(wire, quoteBinding(authorizedQuote(config, quote), config.buyer, config.genesisHash), false, lifetime);
}

function identify(wire: string, binding: TransferBinding, lifetime?: OriginalPaymentLifetime): SignedPaymentIdentity {
  const { transaction, bytes, message, sourceTokenAccount, recipientTokenAccount } = inspect(wire, binding, true, lifetime);
  const signature = getBase58Decoder().decode(transaction.signatures[0]);
  return Object.freeze(SignedPaymentIdentitySchema.parse({ version: 1, protocol: 'mpp', payer: binding.payer,
    recipient: binding.recipient, mint: binding.mint, amount: binding.amount, decimals: 6, network: binding.network,
    genesisHash: binding.genesisHash, tokenProgram: TOKEN_PROGRAM, sourceTokenAccount, recipientTokenAccount,
    messageHash: digest(message), wireHash: digest(bytes), buyerSignature: signature, buyerSignerIndex: 0,
    feePayer: binding.payer, actualMemo: binding.memo, recentBlockhash: transaction.message.recentBlockhash,
    ...(lifetime ? { lastValidBlockHeight: lifetime.lastValidBlockHeight } : {}), knownSignature: signature,
  }));
}

export function createMppSignedPaymentIdentity(input: MppStoredPayment, config: PaymentConfig,
  lifetime?: OriginalPaymentLifetime): SignedPaymentIdentity {
  const payment = MppStoredPaymentSchema.parse(input);
  const quote = authorizedQuote(config, payment.quote);
  return identify(payment.transaction, quoteBinding(quote, config.buyer, config.genesisHash), lifetime);
}

function storedLifetime(identity: SignedPaymentIdentity): OriginalPaymentLifetime | undefined {
  return identity.lastValidBlockHeight === undefined ? undefined
    : { recentBlockhash: identity.recentBlockhash, lastValidBlockHeight: identity.lastValidBlockHeight };
}

/** Pure verification survives config changes and process restarts; it performs
 * no network access and cannot replace the original payment. */
export function validateMppSignedPaymentIdentity(input: MppStoredPayment, stored: SignedPaymentIdentity): boolean {
  try {
    const payment = MppStoredPaymentSchema.parse(input);
    const identity = SignedPaymentIdentitySchema.parse(stored);
    if (identity.protocol !== 'mpp') return false;
    const derived = identify(payment.transaction, quoteBinding(payment.quote, identity.payer, identity.genesisHash), storedLifetime(identity));
    return isDeepStrictEqual(derived, identity);
  } catch { return false; }
}

/** MPP charges have one complete signature from the outset. Chain evidence must
 * preserve the entire original wire as well as the signed message. */
export function matchesMppSignedPaymentIdentity(wire: string, stored: SignedPaymentIdentity, config: PaymentConfig, signature: string): boolean {
  try {
    assertEnvironment(config);
    const identity = SignedPaymentIdentitySchema.parse(stored);
    if (identity.protocol !== 'mpp' || identity.network !== config.network || identity.mint !== config.mint
      || identity.payer !== config.buyer || identity.genesisHash !== config.genesisHash || identity.knownSignature !== signature) return false;
    const derived = identify(wire, { payer: identity.payer, recipient: identity.recipient, mint: identity.mint,
      amount: identity.amount, network: identity.network, genesisHash: identity.genesisHash, memo: identity.actualMemo }, storedLifetime(identity));
    return isDeepStrictEqual(derived, identity);
  } catch { return false; }
}
