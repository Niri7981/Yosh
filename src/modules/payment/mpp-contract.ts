import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_NETWORK, MAINNET_USDC_MINT, TOKEN_PROGRAM } from './payment-environment';

const publicKey = z.string().refine(value => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const base64url = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const wire = z.string().min(1).max(1_644).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const amount = z.string().refine(value => PositiveAtomicAmountSchema.safeParse(value).success);

/** The deliberately small subset accepted from the pinned SDK parser. Unknown
 * payment terms are rejected, never silently stripped from authorization. */
export const MppChargeRequestSchema = z.object({
  amount, currency: publicKey, recipient: publicKey,
  description: z.string().max(1_024).optional(),
  externalId: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 256).optional(),
  methodDetails: z.object({
    network: z.enum(['mainnet', 'devnet']), decimals: z.literal(6), tokenProgram: z.literal(TOKEN_PROGRAM),
    feePayer: z.literal(false).optional(), recentBlockhash: publicKey.optional(),
    transactionVersions: z.tuple([z.literal(0)]).optional(),
  }).strict(),
}).strict();
export type MppChargeRequest = z.infer<typeof MppChargeRequestSchema>;

export const MppChallengeEchoSchema = z.object({
  id: z.string().min(1).max(1_024), realm: z.string().min(1).max(2_048),
  method: z.literal('solana'), intent: z.literal('charge'), request: base64url,
  expires: z.iso.datetime({ offset: true }), description: z.string().max(2_048).optional(), opaque: base64url.optional(),
}).strict();

function decodeJson(encoded: string): unknown {
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('INVALID_MPP_ENCODING');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function readMppChargeRequest(quote: { challenge: { request: string } }): MppChargeRequest {
  return MppChargeRequestSchema.parse(decodeJson(base64url.parse(quote.challenge.request)));
}

export const MppChargeQuoteSchema = z.object({
  protocol: z.literal('mpp'), method: z.literal('solana'), intent: z.literal('charge'), scheme: z.literal('mpp_charge'),
  network: z.enum([DEVNET_NETWORK, MAINNET_NETWORK]), asset: publicKey, payTo: publicKey, amount,
  challenge: MppChallengeEchoSchema,
  challengeHeader: z.string().min(1).max(32_768).refine(value => !/[\r\n\0]/.test(value)),
  expiresAt: z.number().int().positive().safe(),
}).strict().superRefine((quote, ctx) => {
  try {
    const request = readMppChargeRequest(quote);
    const mainnet = request.methodDetails.network === 'mainnet';
    if (quote.network !== (mainnet ? MAINNET_NETWORK : DEVNET_NETWORK)
      || quote.asset !== (mainnet ? MAINNET_USDC_MINT : DEVNET_USDC_MINT)
      || quote.asset !== request.currency || quote.payTo !== request.recipient || quote.amount !== request.amount
      || quote.expiresAt !== Date.parse(quote.challenge.expires)) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'MPP_QUOTE_BINDING_MISMATCH' }); }
});
export type MppChargeQuote = z.infer<typeof MppChargeQuoteSchema>;

const CredentialSchema = z.object({
  challenge: MppChallengeEchoSchema,
  payload: z.object({ type: z.literal('transaction'), transaction: wire }).strict(),
}).strict();

export const MppStoredPaymentSchema = z.object({
  protocol: z.literal('mpp'), quote: MppChargeQuoteSchema,
  credential: z.string().max(32_768).startsWith('Payment '), transaction: wire,
}).strict().superRefine((payment, ctx) => {
  try {
    // This checks local durable bindings. The official SDK creates the header;
    // this is not a second protocol encoder or merchant verification service.
    const encoded = z.string().min(1).max(32_760).regex(/^[A-Za-z0-9_-]+$/).parse(payment.credential.slice(8));
    const credential = CredentialSchema.parse(decodeJson(encoded));
    if (!isDeepStrictEqual(credential.challenge, payment.quote.challenge)
      || credential.payload.transaction !== payment.transaction) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'MPP_CREDENTIAL_BINDING_MISMATCH' }); }
});
export type MppStoredPayment = z.infer<typeof MppStoredPaymentSchema>;
