import { z } from 'zod';
import { AtomicAmountSchema, PositiveAtomicAmountSchema, atomicAmount } from './atomic-money';

const identifier = z.string().min(1).max(200);
const minorUnits = z.string().refine(value => AtomicAmountSchema.safeParse(value).success);
const networkFeeLimit = z.string().regex(/^[1-9]\d*$/).refine(value => PositiveAtomicAmountSchema.safeParse(value).success);
function validateFeeConsent(scope: { paymentScheme: string; maximumNetworkFeeLamports?: string }, ctx: z.RefinementCtx) {
  if ((scope.paymentScheme === 'mpp_charge') !== (scope.maximumNetworkFeeLamports !== undefined))
    ctx.addIssue({ code: 'custom', message: 'MPP_NETWORK_FEE_CONSENT_REQUIRED' });
}
export const PAID_RESOURCE_PURCHASE_OPERATION = 'paid.resource.purchase';
/** Stored in grants and in-flight purchases created before generic paid resources. */
export const LEGACY_MARKET_SNAPSHOT_OPERATION = 'market.snapshot.read';

export const SpendPrincipalSchema = z.object({
  cardMemberId: z.string().uuid(),
  connectionId: z.string().uuid(),
  connectionGeneration: z.number().int().positive().safe(),
}).strict();

export const SpendAuthorityBindingSchema = SpendPrincipalSchema.extend({
  grantId: z.string().uuid(),
  grantVersion: z.number().int().positive().safe(),
  operation: identifier,
}).strict();

export const SpendGrantInputSchema = z.object({
  totalLimit: minorUnits,
  singleLimit: minorUnits,
  expiresAt: z.number().int().positive().safe(),
}).strict();

export const SpendGrantScopeSchema = z.object({
  resourceId: identifier,
  providerId: identifier,
  operation: identifier,
  network: identifier,
  assetId: identifier,
  assetDecimals: z.number().int().nonnegative().max(255),
  payTo: identifier,
  paymentScheme: identifier,
  maximumNetworkFeeLamports: networkFeeLimit.optional(),
  postPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine(validateFeeConsent);

export const SpendGrantSchema = SpendPrincipalSchema.extend({
  id: z.string().uuid(),
  version: z.number().int().positive().safe(),
  resourceId: identifier,
  providerId: identifier,
  operation: identifier,
  network: identifier,
  assetId: identifier,
  assetDecimals: z.number().int().nonnegative().max(255),
  payTo: identifier,
  paymentScheme: identifier,
  maximumNetworkFeeLamports: networkFeeLimit.optional(),
  postPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  totalLimit: PositiveAtomicAmountSchema,
  singleLimit: PositiveAtomicAmountSchema,
  status: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']),
  createdAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
  revokedAt: z.number().int().nonnegative().safe().nullable(),
}).strict().superRefine(validateFeeConsent);

export type SpendPrincipal = z.infer<typeof SpendPrincipalSchema>;
export type SpendAuthorityBinding = z.infer<typeof SpendAuthorityBindingSchema>;
export type SpendGrantInput = z.infer<typeof SpendGrantInputSchema>;
export type SpendGrantScope = z.infer<typeof SpendGrantScopeSchema>;
export type SpendGrant = z.infer<typeof SpendGrantSchema>;

export function parseGrantAmount(value: string, name: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be an integer string`);
  const parsed = atomicAmount(value);
  if (parsed <= 0n) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
