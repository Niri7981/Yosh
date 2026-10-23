import { randomUUID } from 'node:crypto';
import type { PaymentRequirements } from '@x402/core/types';
import { SpendIntentSchema, type SpendIntent } from '../authority/spend-intent';
import { hash } from '../authority/authority-policy';
import type { SpendAuthorityBinding } from '../authority/spend-grant';
import { MarketSnapshotInputSchema, type ResourceMetadata } from './resource-schema';
import { DEMO_MARKET_DATA_PROVIDER_ID, PREMIUM_SOL_MARKET_SNAPSHOT_ID } from './static-resource-registry';
import { X402ResourceSchema, type X402Resource } from './http-resource';
import { resourcePaymentBinding, validateResourceChallenge } from '../payment/resource-challenge';
import { readPaymentRequiredHeader } from '../payment/x402-client';
import type { PaymentEnvironment } from '../payment/payment-environment';
import { TEST_CACHED_DELIVERY } from './delivery-capability';

/** The same authority intent, using server-declared HTTP facts rather than Demo identities. */
export function createX402SpendIntent(input: {
  idempotencyKey: string; resource: X402Resource; challenge: unknown; environment: PaymentEnvironment;
  buyer: string; reason?: string; now?: number; authority?: SpendAuthorityBinding;
  requestInputFingerprint?: string;
  paymentRequiredHeader?: string;
  selectedQuote?: unknown;
}): SpendIntent {
  const resource = X402ResourceSchema.parse(input.resource);
  const { challenge, quote } = validateResourceChallenge(input.challenge, resource, input.environment, input.selectedQuote);
  if (input.paymentRequiredHeader && hash(readPaymentRequiredHeader(input.paymentRequiredHeader,
    challenge.accepts.some(quote => Object.hasOwn(quote, 'outputSchema')))) !== hash(challenge))
    throw new Error('MERCHANT_QUOTE_EVIDENCE_MISMATCH');
  const now = input.now ?? Date.now();
  return SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: input.idempotencyKey,
    requestHash: hash({ resourceId: resource.resourceId, providerId: resource.providerId, request: resource.request, reason: input.reason }),
    ...(input.requestInputFingerprint ? { requestInputFingerprint: input.requestInputFingerprint } : {}),
    resourceId: resource.resourceId, providerId: resource.providerId, httpRequest: resource.request, x402Challenge: challenge,
    ...(input.paymentRequiredHeader ? { paymentRequiredHeader: input.paymentRequiredHeader } : {}),
    ...(resource.deliveryRecovery ? { deliveryRecovery: resource.deliveryRecovery } : {}),
    ...(resource.deliveryPolicy ? { deliveryPolicy: resource.deliveryPolicy } : {}),
    ...(input.reason ? { reason: input.reason } : {}), amount: quote.amount, currency: 'USDC', assetDecimals: resource.decimals,
    assetId: quote.asset, network: quote.network, payTo: quote.payTo, paymentScheme: quote.scheme, quoteFingerprint: hash(quote),
    createdAt: now, expiresAt: now + quote.maxTimeoutSeconds * 1000,
    executionBinding: resourcePaymentBinding(input.environment, input.buyer, resource.request, challenge, resource.deliveryRecovery, input.paymentRequiredHeader),
    ...(input.authority ? { authority: input.authority } : {}) });
}

export function createMarketSnapshotSpendIntent(input: {
  idempotencyKey: string;
  request: unknown;
  requestHash: string;
  resource: ResourceMetadata;
  quote: PaymentRequirements;
  executionBinding: string;
  now?: number;
  authority?: SpendAuthorityBinding;
  offerId?: string;
  reason?: string;
}): SpendIntent {
  const now = input.now ?? Date.now();
  const resource = input.resource;
  const quote = input.quote;
  MarketSnapshotInputSchema.parse(input.request);
  if (!resource.enabled || resource.resource_id !== PREMIUM_SOL_MARKET_SNAPSHOT_ID) throw new Error('RESOURCE_NOT_ALLOWED');
  if (resource.provider_id !== DEMO_MARKET_DATA_PROVIDER_ID) throw new Error('PROVIDER_NOT_ALLOWED');
  if (resource.payment_scheme !== 'exact' || quote.scheme !== resource.payment_scheme) throw new Error('SCHEME_NOT_ALLOWED');
  if (quote.asset !== resource.asset_id || quote.network !== resource.network || quote.payTo !== resource.allowed_pay_to) throw new Error('PAYMENT_TERMS_CHANGED');
  if (quote.amount !== String(resource.expected_price_minor)) throw new Error('PRICE_CHANGED');
  if (!Number.isFinite(quote.maxTimeoutSeconds) || quote.maxTimeoutSeconds <= 0) throw new Error('QUOTE_EXPIRED_OR_INVALID');

  return SpendIntentSchema.parse({
    id: randomUUID(),
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    resourceId: resource.resource_id,
    providerId: resource.provider_id,
    deliveryRecovery: TEST_CACHED_DELIVERY,
    ...(input.offerId ? { offerId: input.offerId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    amount: resource.expected_price_minor,
    currency: resource.currency,
    assetDecimals: resource.asset_decimals,
    assetId: resource.asset_id,
    network: resource.network,
    payTo: resource.allowed_pay_to,
    paymentScheme: resource.payment_scheme,
    quoteFingerprint: hash(quote),
    createdAt: now,
    expiresAt: now + Math.min(quote.maxTimeoutSeconds, 300) * 1000,
    executionBinding: input.executionBinding,
    ...(input.authority ? { authority: input.authority } : {}),
  });
}
