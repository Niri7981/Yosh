import type { PaymentPayload } from '@x402/core/types';
import { getBase58Encoder } from '@solana/kit';
import { z } from 'zod';
import { paymentSignatureHeaders } from '../payment/x402-client';

/** Reject direct copies of known credentials, not arbitrary information encoded
 * by a malicious merchant. Inspect the whole delivery before chunking it. */
export function assertCredentialFreeDelivery(data: unknown, payload?: PaymentPayload, buyerSignature?: string) {
  if (!payload) return;
  const secrets = [JSON.stringify(payload), Buffer.from(JSON.stringify(payload)).toString('base64'),
    ...Object.values(paymentSignatureHeaders(payload))];
  const transaction = z.object({ transaction: z.string().min(1) }).passthrough().safeParse(payload.payload);
  if (transaction.success) secrets.push(transaction.data.transaction);
  if (buyerSignature) {
    const bytes = getBase58Encoder().encode(buyerSignature);
    secrets.push(buyerSignature, Buffer.from(bytes).toString('base64'), Buffer.from(bytes).toString('hex'));
  }
  const body = JSON.stringify(data);
  if (secrets.some(secret => body.includes(secret))) throw new Error('PAY_CREDENTIAL_REFLECTION_REJECTED');
}
