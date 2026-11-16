import { executePayX402Solana } from './pay-x402-solana';
import { storedPaymentRoute } from './payment-route';
import type { PurchaseRecord } from '../purchases/purchase-contract';
export type { PaymentRail } from './payment-route';

/** Legacy x402 facade preserves the original arguments, errors and promise. */
export function routeApprovedPayment(args: Parameters<typeof executePayX402Solana>): ReturnType<typeof executePayX402Solana> {
  return executePayX402Solana(...args);
}

/** Backend-only dispatch from immutable stored facts. The selected executor still
 * performs the unique claim and every signing gate. Never retry on another rail. */
export function routeStoredApprovedPayment<T>(record: Pick<PurchaseRecord, 'intent' | 'quote'>, execute: {
  pay_x402_solana: () => T; pay_mpp_solana_charge: () => T;
}): T {
  return execute[storedPaymentRoute(record).executor]();
}
