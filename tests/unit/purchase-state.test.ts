import { describe, expect, it } from 'vitest';
import { parseStoredPurchaseStatus, purchaseStatusAfter, PurchaseStatusSchema, type PurchaseTransition } from '../../src/modules/purchases/purchase-state';

describe('persisted purchase statuses', () => {
  it('reads historical authority names using the canonical purchase contract', () => {
    expect(parseStoredPurchaseStatus('REJECTED')).toBe('DENIED');
    expect(parseStoredPurchaseStatus('NEEDS_CONFIRMATION')).toBe('REQUIRES_APPROVAL');
    for (const status of PurchaseStatusSchema.options) expect(parseStoredPurchaseStatus(status)).toBe(status);
  });

  it.each(['UNKNOWN', 'COMPLETE', 'PENDING', 'OUTCOME_UNKNOWN', 'confirmed', '', null, 1])(
    'rejects foreign or malformed status %s instead of treating it as financial state', status => {
      expect(() => parseStoredPurchaseStatus(status)).toThrow();
    },
  );
});

const reopenOperations: PurchaseTransition[] = ['START_PAYMENT', 'EXPIRE_APPROVAL', 'MARK_PAYMENT_UNKNOWN',
  'FAIL_BEFORE_SUBMISSION', 'FAIL_FINALIZED_PAYMENT'];

describe('payment state ordering', () => {
  it('keeps PAID terminal across claim, expiry, uncertainty and failure operations', () => {
    for (const operation of reopenOperations) {
      expect(() => purchaseStatusAfter('PAID', operation)).toThrow('PURCHASE_STATE_TRANSITION_INVALID');
    }
    expect(purchaseStatusAfter('PAID', 'CONFIRM_PAYMENT')).toBe('PAID');
  });

  it.each(['DENIED', 'REQUIRES_APPROVAL', 'EXPIRED', 'FAILED'] as const)(
    'cannot spend an existing %s decision through payment or simulation', status => {
      for (const operation of ['START_PAYMENT', 'CONFIRM_PAYMENT', 'CONFIRM_SIMULATED_PAYMENT'] as const) {
        expect(() => purchaseStatusAfter(status, operation)).toThrow('PURCHASE_STATE_TRANSITION_INVALID');
      }
    },
  );

  it('cannot expire, re-claim or simulate an uncertain submitted payment', () => {
    for (const operation of ['EXPIRE_APPROVAL', 'START_PAYMENT', 'CONFIRM_SIMULATED_PAYMENT'] as const) {
      expect(() => purchaseStatusAfter('PAYMENT_UNKNOWN', operation)).toThrow('PURCHASE_STATE_TRANSITION_INVALID');
    }
    expect(purchaseStatusAfter('PAYMENT_UNKNOWN', 'MARK_PAYMENT_UNKNOWN')).toBe('PAYMENT_UNKNOWN');
    expect(purchaseStatusAfter('PAYMENT_UNKNOWN', 'CONFIRM_PAYMENT')).toBe('PAID');
    // These operations require independent evidence checks at the ledger boundary.
    expect(purchaseStatusAfter('PAYMENT_UNKNOWN', 'FAIL_FINALIZED_PAYMENT')).toBe('FAILED');
    expect(purchaseStatusAfter('PAYMENT_UNKNOWN', 'FAIL_BEFORE_SUBMISSION')).toBe('FAILED');
  });

  it('expires only unclaimed authority and preserves the simulated payment sequence', () => {
    expect(purchaseStatusAfter('APPROVED', 'EXPIRE_APPROVAL')).toBe('EXPIRED');
    expect(() => purchaseStatusAfter('PAYING', 'EXPIRE_APPROVAL')).toThrow('PURCHASE_STATE_TRANSITION_INVALID');
    expect(() => purchaseStatusAfter('APPROVED', 'CONFIRM_SIMULATED_PAYMENT')).toThrow('PURCHASE_STATE_TRANSITION_INVALID');
    const claimed = purchaseStatusAfter('APPROVED', 'START_PAYMENT');
    expect(purchaseStatusAfter(claimed, 'CONFIRM_SIMULATED_PAYMENT')).toBe('PAID');
  });
});
