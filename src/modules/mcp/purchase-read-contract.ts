import { z } from 'zod';
import { PurchaseStatusSchema } from '../purchases/purchase-state';
import { DeliveryRecoveryStateSchema, DeliveryStatusSchema } from '../purchases/delivery-state';
import { PaymentFailureDetails } from '../payment/pay-controller-diagnostics';

export const AgentPurchaseReadInput = z.object({
  operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).optional(),
  purchaseId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
}).strict().refine(input => Boolean(input.operationId) !== Boolean(input.purchaseId));

export const AgentDeliveryRecoveryInput = z.object({ purchaseId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict();
export const DeliveryRecoveryErrors = {
  PURCHASE_NOT_FOUND: 404, MPP_PAID_DELIVERY_REQUIRED: 409, SERVICE_STOPPING: 503, MPP_DELIVERY_RECOVERY_UNAVAILABLE: 503,
} as const;
const deliveryError = z.enum(['DELIVERY_RECOVERY_UNSUPPORTED', 'DELIVERY_RETRY_EXHAUSTED', 'DELIVERY_ATTEMPT_INTERRUPTED',
  'DELIVERY_PAYMENT_EVIDENCE_INVALID', 'DELIVERY_RECOVERY_BINDING_INVALID', 'DELIVERY_RESPONSE_INVALID',
  'DELIVERY_RECEIPT_INVALID', 'DELIVERY_RESPONSE_UNAVAILABLE', 'MPP_DELIVERY_REPLAY_REJECTED']);
// Old stores accept free-form failure text. Publish only recognized diagnostic codes.
const recoverySummary = DeliveryRecoveryStateSchema.pick({ status: true, retryCount: true, retryLimit: true, nextAttemptAt: true })
  .extend({ lastError: deliveryError.nullable().catch('DELIVERY_RESPONSE_UNAVAILABLE') });

export const AgentPurchaseSummary = z.object({
  purchaseId: z.string(), operationId: z.string().nullable(), status: PurchaseStatusSchema,
  paymentStatus: z.enum(['NOT_STARTED', 'PAYING', 'PAYMENT_UNKNOWN', 'PAID', 'FAILED']),
  deliveryStatus: DeliveryStatusSchema, deliveryRecovery: recoverySummary.optional(), policyCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/),
  failure: PaymentFailureDetails.optional(),
  resourceId: z.string(), amount: z.string().regex(/^\d+$/), network: z.string(),
  assetId: z.string(), assetDecimals: z.number().int().min(0).max(255), transaction: z.string().nullable(),
}).strict();
