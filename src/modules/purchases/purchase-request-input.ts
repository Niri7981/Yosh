import { z } from 'zod';

export const PurchaseRequestInputSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  resourceId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(240),
  query: z.string().trim().min(1).max(300).optional(),
  request: z.object({ query: z.record(z.string(), z.string().min(1).max(300)).optional(),
    jsonBody: z.record(z.string(), z.json()).optional() }).strict().optional(),
}).strict();
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInputSchema>;
