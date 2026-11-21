import { z } from 'zod';
import { PurchaseRequestInputSchema } from '../purchases/purchase-request-input';
import type { X402Resource } from '../resources/http-resource';

export const PurchaseResourceLookup = PurchaseRequestInputSchema.pick({ resourceId: true }).strict();

const QueryField = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/), type: z.literal('string'),
  required: z.boolean(), minLength: z.number().int().min(1).max(300), maxLength: z.number().int().min(1).max(300),
  enum: z.array(z.string().min(1).max(300)).min(1).max(32).optional(),
}).strict();
export const PurchaseResourceContract = z.object({
  resourceId: PurchaseResourceLookup.shape.resourceId, name: z.string().min(1).max(200), method: z.literal('GET'),
  protocol: z.enum(['x402', 'mpp']), networkFeeCap: z.enum(['required', 'omit']),
  query: z.object({
    mode: z.enum(['fixed', 'dynamic']), fields: z.array(QueryField).max(16), requiresAtLeastOne: z.boolean(),
  }).strict(),
}).strict();

export function describePurchaseResource(resource: X402Resource) {
  const policy = resource.requestInputs?.query;
  const fields = Array.isArray(policy)
    ? policy.map(name => ({name, type: 'string' as const, required: policy.length === 1, minLength: 1, maxLength: 300}))
    : Object.entries(policy ?? {}).map(([name, field]) => ({name, type: field.type, required: field.required ?? false,
      minLength: field.minLength ?? 1, maxLength: field.maxLength ?? 300, ...(field.enum ? {enum: field.enum} : {})}));
  const mpp = resource.paymentProtocol === 'mpp_solana_charge';
  return PurchaseResourceContract.parse({
    resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId, method: resource.request.method,
    protocol: mpp ? 'mpp' : 'x402', networkFeeCap: mpp ? 'required' : 'omit',
    query: {mode: fields.length ? 'dynamic' : 'fixed', fields, requiresAtLeastOne: Array.isArray(policy) && policy.length > 0},
  });
}
