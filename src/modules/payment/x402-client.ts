import { x402Client, x402HTTPClient } from '@x402/core/client';
import { PaymentRequiredV2Schema, PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { z } from 'zod';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { SolanaPublicKeySchema, X402ChallengeSchema } from '../resources/http-resource';
import { TransactionSignatureSchema } from './original-payment-evidence';

const MAX_PAYMENT_HEADER_BYTES = 16_384;
const protocol = new x402HTTPClient(new x402Client());

function boundedHeader(value: string | null, name: string) {
  if (!value) throw new Error(`Missing ${name}`);
  if (value.length > MAX_PAYMENT_HEADER_BYTES) throw new Error(`${name} is too large`);
  return value;
}

/** Decode wire headers through the official x402 HTTP adapter, then validate the result. */
export function readPaymentRequiredHeader(encoded: string, preserveOfferMetadata = false): PaymentRequired {
  const value = boundedHeader(encoded, 'PAYMENT-REQUIRED');
  const decoded = protocol.getPaymentRequiredResponse(name => name === 'PAYMENT-REQUIRED' ? value : null);
  const parsed = PaymentRequiredV2Schema.parse(decoded);
  const source = z.object({ accepts: z.array(z.object({ outputSchema: z.json().optional() }).passthrough()) }).passthrough().parse(decoded);
  // The pinned JS SDK projects V2 requirements and drops legacy informational
  // outputSchema; Pay's SDK preserves its original accepted object. Opt in for
  // Pay, while retaining the exact historical JS evidence-reading contract.
  return X402ChallengeSchema.parse({ ...parsed, accepts: parsed.accepts.map((requirement, index) => ({ ...requirement, extra: requirement.extra ?? {},
    ...(preserveOfferMetadata && Object.hasOwn(source.accepts[index], 'outputSchema') ? { outputSchema: source.accepts[index].outputSchema } : {}) })),
    ...(parsed.extensions === null ? { extensions: undefined } : {}) });
}

export function paymentSignatureHeaders(payload: PaymentPayload): Record<string, string> {
  PaymentPayloadV2Schema.parse(payload);
  const headers = protocol.encodePaymentSignatureHeader(payload);
  for (const value of Object.values(headers)) boundedHeader(value, 'PAYMENT-SIGNATURE');
  return headers;
}

const receiptFields = {
  network: z.templateLiteral(['solana:', z.string().min(1).max(193)]),
  transactionId: TransactionSignatureSchema.optional(), signature: TransactionSignatureSchema.optional(),
  amount: z.string().refine(value => PositiveAtomicAmountSchema.safeParse(value).success).optional(), extensions: z.record(z.string(), z.json()).optional(),
  extensionResponses: z.record(z.string(), z.json()).optional(),
  extra: z.record(z.string(), z.json()).optional(),
};
export const SettlementReceiptSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), ...receiptFields, payer: SolanaPublicKeySchema,
    transaction: TransactionSignatureSchema }).strict(),
  z.object({ success: z.literal(false), ...receiptFields, payer: SolanaPublicKeySchema.optional(),
    transaction: z.union([z.literal(''), TransactionSignatureSchema]),
    errorReason: z.string().min(1).max(240).optional(), errorMessage: z.string().max(1024).optional() }).strict(),
]);
export type SettlementReceiptBinding = { network: string; payer: string; amount: string; transaction?: string };

export function validateSettlementReceipt(raw: unknown, expected?: SettlementReceiptBinding): SettleResponse {
  const parsed = SettlementReceiptSchema.parse(raw);
  // Some V2 merchants include client compatibility aliases. They can repeat
  // only the same public signature; they never supply alternative evidence.
  if ((parsed.transactionId !== undefined && parsed.transactionId !== parsed.transaction)
    || (parsed.signature !== undefined && parsed.signature !== parsed.transaction)) throw new Error('SETTLEMENT_RECEIPT_BINDING_MISMATCH');
  const { transactionId: _id, signature: _signature, ...receipt } = parsed;
  void _id; void _signature;
  if (expected && (receipt.network !== expected.network || receipt.payer !== expected.payer
    || (receipt.amount !== undefined && receipt.amount !== expected.amount)
    || (expected.transaction !== undefined && receipt.transaction !== expected.transaction))) throw new Error('SETTLEMENT_RECEIPT_BINDING_MISMATCH');
  return receipt;
}

export function readSettlementResponse(response: Response, expected?: SettlementReceiptBinding): SettleResponse {
  boundedHeader(response.headers.get('PAYMENT-RESPONSE'), 'PAYMENT-RESPONSE');
  return validateSettlementReceipt(protocol.getPaymentSettleResponse(name => response.headers.get(name)), expected);
}

/** An unusable receipt may still reveal the original signature. This is only a
 * durable search hint; it cannot authorize PAID or release any reservation. */
export function readSettlementTransactionHint(response: Response): string | undefined {
  boundedHeader(response.headers.get('PAYMENT-RESPONSE'), 'PAYMENT-RESPONSE');
  const decoded: unknown = protocol.getPaymentSettleResponse(name => response.headers.get(name));
  const parsed = z.object({ transaction: TransactionSignatureSchema }).passthrough().safeParse(decoded);
  return parsed.success ? parsed.data.transaction : undefined;
}
