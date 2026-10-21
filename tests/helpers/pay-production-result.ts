import { z } from 'zod';

/** Validate the actual MCP JSON boundary without asserting a cast to an internal record. */
export const PurchaseRequestResultSchema = z.object({ purchaseId: z.string(), resourceId: z.string(),
  amount: z.string(), status: z.string(), decision: z.object({ decision: z.string(), reason: z.string() }).passthrough(),
  paymentStatus: z.string(), executionMode: z.string(), deliveryStatus: z.string(), reused: z.boolean(),
  resource: z.unknown().optional() }).passthrough();
