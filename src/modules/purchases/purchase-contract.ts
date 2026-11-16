import type { PaymentRequirements } from '@x402/core/types';
import type { AuthorityDecision } from '../authority/authority-policy';
import type { SpendIntent } from '../authority/spend-intent';
import type { MonetaryScope } from './monetary-scope';
import type { PurchaseStatus } from './purchase-state';
import type { DeliveryStatus, ReceiptStatus, DeliveryRecoveryState } from './delivery-state';
import type { PaymentEvidence, StoredPurchaseExecutionMode } from './purchase-ledger';
import type { MppChargeQuote } from '../payment/mpp-contract';

export type PurchaseQuote = PaymentRequirements | MppChargeQuote;

export type SpendReservation = {
  monetaryScope: MonetaryScope; intent: SpendIntent; quote: PurchaseQuote; approvalId: string; decision: AuthorityDecision; status: PurchaseStatus; deliveryStatus: DeliveryStatus;
  executionMode: StoredPurchaseExecutionMode; paymentPayloadPresent: boolean; paymentPayloadHash?: string; paymentEvidence?: PaymentEvidence;
  receiptStatus: ReceiptStatus; deliveryRecovery: DeliveryRecoveryState;
  ownerCardMemberId?: string; transaction?: string; data?: unknown; answer?: string;
};
/** Compatibility name for callers that still expose the market purchase use case. */
export type PurchaseRecord = SpendReservation;
export type X402PurchaseRecord = SpendReservation & { quote: PaymentRequirements; intent: SpendIntent & { mpp?: undefined } };

/** Historical x402 entrypoints must fail closed before inspecting protocol fields. */
export function assertX402Purchase(record: SpendReservation): asserts record is X402PurchaseRecord {
  if (record.intent.mpp || 'protocol' in record.quote) throw new Error('MPP_PAYMENT_REQUIRES_PROTOCOL_API');
}
