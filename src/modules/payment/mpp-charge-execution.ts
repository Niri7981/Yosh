import { assertIsTransactionWithinSizeLimit, blockhash, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit';
import { z } from 'zod';
import { TOKEN_PROGRAM } from './payment-environment';
import type { PaymentConfig } from './payment-config';
import { getStandardTokenAccount } from './payment-preflight';
import { solanaRpc } from './solana-payment';
import { readPayLifetime } from './mainnet-pay-execution';
import { loadBuyerSigner } from './wallet';
import { parseMppChallenge, prepareMppCharge, encodeMppCredential } from './mpp-protocol-engine';
import { assertMppUnsignedBindings } from './mpp-payment-evidence';
import { decodeOriginalTransaction } from './original-payment-evidence';
import type { MppChargeQuote } from './mpp-contract';
import { hash } from '../purchases/spending-policy';
import { assertMppExecutionEnabled } from './mpp-resource-charge';
import { paymentFailure, type PaymentFailureStage } from './pay-controller-diagnostics';

const lamports = z.number().int().safe().nonnegative();
const atomic = z.string().regex(/^(0|[1-9]\d*)$/).max(20);

/** Read-only preflight is independent of x402's sponsored-fee assumptions. */
export async function preflightMppCharge(config: PaymentConfig, quote: MppChargeQuote, wire: string, maximumNetworkFeeLamports: string) {
  const rpc = (method: string, params: unknown[] = []) => solanaRpc<unknown>(config, method, params);
  if (await rpc('getGenesisHash') !== config.genesisHash) throw new Error('MPP_RPC_NETWORK_MISMATCH');
  const [source, destination] = await Promise.all([getStandardTokenAccount(config.buyer, quote.asset), getStandardTokenAccount(quote.payTo, quote.asset)]);
  const accounts = z.object({ value: z.array(z.unknown()).length(3) }).parse(await rpc('getMultipleAccounts', [[quote.asset, source, destination], { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
  z.object({ owner: z.literal(TOKEN_PROGRAM), data: z.object({ parsed: z.object({ type: z.literal('mint'),
    info: z.object({ decimals: z.literal(6), isInitialized: z.literal(true) }) }) }) }).parse(accounts[0]);
  const balance = (raw: unknown, owner: string) => z.object({ owner: z.literal(TOKEN_PROGRAM), data: z.object({ parsed: z.object({
    type: z.literal('account'), info: z.object({ owner: z.literal(owner), mint: z.literal(quote.asset), state: z.literal('initialized'),
      tokenAmount: z.object({ amount: atomic, decimals: z.literal(6) }) }) }) }) }).parse(raw).data.parsed.info.tokenAmount.amount;
  if (BigInt(balance(accounts[1], config.buyer)) < BigInt(quote.amount)) throw new Error('MPP_INSUFFICIENT_USDC');
  balance(accounts[2], quote.payTo);
  const { transaction, message } = decodeOriginalTransaction(wire);
  const valid = z.object({ value: z.boolean() }).parse(await rpc('isBlockhashValid', [transaction.message.recentBlockhash, { commitment: 'confirmed' }]));
  if (!valid.value) throw new Error('MPP_BLOCKHASH_EXPIRED');
  const fee = z.object({ value: lamports }).parse(await rpc('getFeeForMessage', [Buffer.from(message).toString('base64'), { commitment: 'confirmed' }])).value;
  if (fee <= 0 || BigInt(fee) > BigInt(atomic.parse(maximumNetworkFeeLamports))) throw new Error('MPP_NETWORK_FEE_LIMIT');
  const sol = z.object({ value: lamports }).parse(await rpc('getBalance', [config.buyer, { commitment: 'confirmed' }])).value;
  if (sol < fee) throw new Error('MPP_INSUFFICIENT_SOL');
  z.object({ value: z.object({ err: z.null() }) }).parse(await rpc('simulateTransaction', [wire,
    { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]));
}

/** Official SDK constructs unsigned bytes; only this backend loads its existing
 * wallet signer. Every asynchronous boundary is followed by authority recheck. */
export async function prepareSignedMppCharge(binary: string, config: PaymentConfig, quote: MppChargeQuote,
  beforeSign: () => void, maximumNetworkFeeLamports: string) {
  let stage: PaymentFailureStage = 'preparation';
  try {
    assertMppExecutionEnabled(config);
    beforeSign();
    const selected = await parseMppChallenge(binary, quote.challengeHeader);
    if (hash(selected.challenge) !== hash(quote.challenge) || selected.expiresAt !== quote.expiresAt) throw new Error('MPP_CHALLENGE_CHANGED');
    // MPP's merchant hash is advisory. Pin both hash and expiry from one RPC
    // response; do not pair the merchant hash with another hash's expiry height.
    const lifetime = await readPayLifetime(config, config.mode === 'live_mainnet' ? 'mainnet' : 'devnet');
    beforeSign();
    const prepared = await prepareMppCharge(binary, { challenge: selected, payer: config.buyer, hostValidatedLifetime: lifetime });
    stage = 'unsigned_bindings';
    assertMppUnsignedBindings(prepared.transaction, config, quote, lifetime);
    stage = 'preflight';
    await preflightMppCharge(config, quote, prepared.transaction, maximumNetworkFeeLamports);
    stage = 'signer_authorization';
    beforeSign();
    stage = 'signer_load';
    const signer = await loadBuyerSigner(config.buyer, process.env, config);
    stage = 'signer_authorization';
    beforeSign();
    if (signer.address !== config.buyer) throw new Error('MPP_SIGNER_MISMATCH');
    stage = 'transaction_decode';
    const unsigned = { ...getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64')),
      lifetimeConstraint: { blockhash: blockhash(lifetime.recentBlockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) } };
    assertIsTransactionWithinSizeLimit(unsigned);
    stage = 'signing';
    const signatures = await signer.signTransactions([unsigned]);
    stage = 'signature_validation';
    if (signatures.length !== 1 || Object.keys(signatures[0]).length !== 1 || Object.keys(signatures[0])[0] !== signer.address)
      throw new Error('MPP_SINGLE_SIGNATURE_REQUIRED');
    stage = 'signer_authorization'; beforeSign();
    stage = 'payload_encode';
    const transaction = getBase64EncodedWireTransaction({ ...unsigned, signatures: { ...unsigned.signatures, ...signatures[0] } });
    const credential = await encodeMppCredential(binary, { challenge: selected, transaction });
    stage = 'signer_authorization'; beforeSign();
    return { payment: { protocol: 'mpp' as const, quote, credential, transaction }, lifetime };
  } catch (error) { throw paymentFailure(error, stage); }
}
