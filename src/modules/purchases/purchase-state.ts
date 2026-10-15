import { z } from 'zod';

export const PurchaseStatusSchema = z.enum([
  'APPROVED', 'DENIED', 'REQUIRES_APPROVAL', 'EXPIRED', 'PAYING', 'PAYMENT_UNKNOWN', 'PAID', 'FAILED',
]);
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>;

/** Historical authority names are read compatibly without rewriting financial rows. */
export function parseStoredPurchaseStatus(value: unknown): PurchaseStatus {
  if (value === 'REJECTED') return 'DENIED';
  if (value === 'NEEDS_CONFIRMATION') return 'REQUIRES_APPROVAL';
  return PurchaseStatusSchema.parse(value);
}

export type PurchaseTransition =
  | 'START_PAYMENT'
  | 'EXPIRE_APPROVAL'
  | 'MARK_PAYMENT_UNKNOWN'
  | 'CONFIRM_PAYMENT'
  | 'FAIL_BEFORE_SUBMISSION'
  | 'FAIL_FINALIZED_PAYMENT'
  | 'CONFIRM_SIMULATED_PAYMENT';

const transitions: Record<PurchaseTransition, { from: readonly PurchaseStatus[]; to: PurchaseStatus }> = {
  START_PAYMENT: { from: ['APPROVED'], to: 'PAYING' },
  EXPIRE_APPROVAL: { from: ['APPROVED'], to: 'EXPIRED' },
  MARK_PAYMENT_UNKNOWN: { from: ['PAYING', 'PAYMENT_UNKNOWN'], to: 'PAYMENT_UNKNOWN' },
  CONFIRM_PAYMENT: { from: ['PAYING', 'PAYMENT_UNKNOWN', 'PAID'], to: 'PAID' },
  FAIL_BEFORE_SUBMISSION: { from: ['PAYING', 'PAYMENT_UNKNOWN'], to: 'FAILED' },
  FAIL_FINALIZED_PAYMENT: { from: ['PAYING', 'PAYMENT_UNKNOWN', 'FAILED'], to: 'FAILED' },
  CONFIRM_SIMULATED_PAYMENT: { from: ['PAYING', 'PAID'], to: 'PAID' },
};

/** This guards state ordering only. The caller must independently verify ownership,
 * execution mode and original payment evidence inside the same transaction. In
 * particular, uncertainty never proves non-submission or finalized chain failure. */
export function purchaseStatusAfter(status: PurchaseStatus, operation: PurchaseTransition): PurchaseStatus {
  const transition = transitions[operation];
  if (!transition.from.includes(status)) throw new Error('PURCHASE_STATE_TRANSITION_INVALID');
  return transition.to;
}
