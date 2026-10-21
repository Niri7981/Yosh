import type { PaymentRequirements } from '@x402/core/types';
import type { AuthorityDecision } from '../authority/authority-policy';
import type { SpendIntent } from '../authority/spend-intent';
import type { MonetaryScope } from './monetary-scope';
import type { PurchaseStatus } from './purchase-state';
import type { DeliveryStatus, ReceiptStatus, DeliveryRecoveryState } from './delivery-state';
import type { PaymentEvidence, StoredPurchaseExecutionMode } from './purchase-ledger';

export type SpendReservation = {
  monetaryScope: MonetaryScope; intent: SpendIntent; quote: PaymentRequirements; approvalId: string; decision: AuthorityDecision; status: PurchaseStatus; deliveryStatus: DeliveryStatus;
  executionMode: StoredPurchaseExecutionMode; paymentPayloadPresent: boolean; paymentPayloadHash?: string; paymentEvidence?: PaymentEvidence;
  receiptStatus: ReceiptStatus; deliveryRecovery: DeliveryRecoveryState;
  ownerCardMemberId?: string; transaction?: string; data?: unknown; answer?: string;
};
/** Compatibility name for callers that still expose the market purchase use case. */
export type PurchaseRecord = SpendReservation;
