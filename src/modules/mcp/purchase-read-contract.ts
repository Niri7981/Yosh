import { z } from 'zod';
import { PurchaseStatusSchema } from '../purchases/purchase-state';
import { DeliveryStatusSchema } from '../purchases/delivery-state';

export const AgentPurchaseReadInput = z.object({
  operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).optional(),
  purchaseId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
}).strict().refine(input => Boolean(input.operationId) !== Boolean(input.purchaseId));

export const AgentPurchaseSummary = z.object({
  purchaseId: z.string(), operationId: z.string().nullable(), status: PurchaseStatusSchema,
  paymentStatus: z.enum(['NOT_STARTED', 'PAYING', 'PAYMENT_UNKNOWN', 'PAID', 'FAILED']),
  deliveryStatus: DeliveryStatusSchema, policyCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/),
  resourceId: z.string(), amount: z.string().regex(/^\d+$/), network: z.string(),
  assetId: z.string(), assetDecimals: z.number().int().min(0).max(255), transaction: z.string().nullable(),
}).strict();
