import type { ExternalExecutionFacts } from './execution-safety';
import { requestRegisteredResourcePurchase } from './request-registered-resource-purchase';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SpendIntentSchema } from '../authority/spend-intent';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import { assertPaymentConfigExecutionEnabled, type PaymentConfig } from '../payment/payment-config';
import { PAID_RESOURCE_SCOPE_ID, PaidResourceIdSchema, paidResource, parsePaidResourceDelivery } from '../resources/paid-resources';
import { executeApprovedPayment, paymentEndpointForIntent, recoverApprovedPayment } from './approved-payment';
import { displayAmount, fetchPaidResourceQuote } from './paid-resource-quote';
import { PurchaseLedger, type DeliveryStatus, type PurchaseExecutionMode, type SpendReservation } from './purchase-ledger';
import type { ReceiptStatus, DeliveryRecoveryState } from './delivery-state';
import type { PurchaseStatus } from './purchase-state';
import { hash } from './spending-policy';
import { resourcePaymentBinding } from '../payment/resource-challenge';
import { TEST_CACHED_DELIVERY } from '../resources/delivery-capability';

export const PurchaseRequestInputSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  resourceId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(240),
  query: z.string().trim().min(1).max(300).optional(),
  request: z.object({ query: z.record(z.string(), z.string().min(1).max(300)).optional(),
    jsonBody: z.record(z.string(), z.json()).optional() }).strict().optional(),
}).strict();
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInputSchema>;

export type PurchaseRequestResult = {
  purchaseId: string; resourceId: PurchaseRequestInput['resourceId']; amount: string; display: string; status: PurchaseStatus;
  decision: SpendReservation['decision'];
  quote: { resourceId: string; resourceUrl: string; providerId: string; network: string; assetId: string; assetDecimals: number; payTo: string; amount: string; expiresAt: number; fingerprint: string };
  grant: { id: string; version: number } | null;
  paymentStatus: 'NOT_STARTED' | 'PAYING' | 'PAYMENT_UNKNOWN' | 'PAID' | 'FAILED';
  executionMode: PurchaseExecutionMode; deliveryStatus: Exclude<DeliveryStatus, 'NOT_PAID'> | 'NOT_DELIVERED';
  receiptStatus: ReceiptStatus; deliveryRecovery: DeliveryRecoveryState;
  reused: boolean; resource?: unknown; deliveryRetrieval?: { purchaseId: string; totalBytes: number; chunkBytes: number };
};

function result(record: SpendReservation, reused: boolean, executionMode: PurchaseExecutionMode): PurchaseRequestResult {
  const mainnet = executionMode === 'live_mainnet';
  const id = mainnet ? record.intent.resourceId : PaidResourceIdSchema.parse(record.intent.resourceId);
  const authority = record.intent.authority;
  if (!authority && (record.decision.decision !== 'DENIED' || record.decision.reason !== 'SPEND_GRANT_REQUIRED')) throw new Error('SPEND_GRANT_REQUIRED');
  const resource = record.status === 'PAID' && record.deliveryStatus === 'COMPLETE'
    ? mainnet ? record.data : parsePaidResourceDelivery(PaidResourceIdSchema.parse(id), record.data) : undefined;
  const encoded = resource === undefined ? undefined : Buffer.from(JSON.stringify(resource));
  return { purchaseId: record.intent.idempotencyKey, resourceId: id, amount: String(record.intent.amount),
    display: displayAmount(String(record.intent.amount)).replace('test USDC', mainnet ? 'USDC' : 'test USDC'), status: record.status, decision: record.decision,
    quote: { resourceId: id, resourceUrl: mainnet ? record.intent.httpRequest!.url : paidResource(PaidResourceIdSchema.parse(id)).path, providerId: record.intent.providerId, network: record.intent.network,
      assetId: record.intent.assetId, assetDecimals: record.intent.assetDecimals, payTo: record.intent.payTo,
      amount: String(record.intent.amount), expiresAt: record.intent.expiresAt, fingerprint: record.intent.quoteFingerprint },
    grant: authority ? { id: authority.grantId, version: authority.grantVersion } : null,
    paymentStatus: record.status === 'PAID' ? 'PAID' : record.status === 'PAYING' ? 'PAYING' : record.status === 'PAYMENT_UNKNOWN' ? 'PAYMENT_UNKNOWN' : record.status === 'FAILED' ? 'FAILED' : 'NOT_STARTED',
    executionMode, deliveryStatus: record.deliveryStatus === 'NOT_PAID' ? 'NOT_DELIVERED' : record.deliveryStatus, reused,
    receiptStatus: record.receiptStatus, deliveryRecovery: record.deliveryRecovery,
    ...(encoded && encoded.length > 32_768 ? { deliveryRetrieval: { purchaseId: record.intent.idempotencyKey,
      totalBytes: encoded.length, chunkBytes: 16_384 } } : resource !== undefined ? { resource } : {}) };
}

/** The Agent selects only a registered resource. Fresh server terms own the price. */
export async function requestPaidResourcePurchase(raw: unknown, options: {
  config: PaymentConfig; ledger: PurchaseLedger; origin: string; principal: SpendPrincipal;
  fetcher?: typeof fetch; now?: () => number; execute?: boolean;
  /** Backend-only two-stage authority/execution seam; monetary mode stays live. */
  deferExecution?: boolean;
  externalExecution?: ExternalExecutionFacts;
  externalQuote?: unknown;
  externalRequest?: import('../resources/http-resource').HttpResourceRequest;
  pay?: typeof executeApprovedPayment; recover?: typeof recoverApprovedPayment;
}): Promise<PurchaseRequestResult> {
  if (options.config.mode === 'live_mainnet') {
    const input = PurchaseRequestInputSchema.parse(raw);
    const reused = Boolean(options.ledger.getOwned(input.requestId, options.principal.cardMemberId));
    const record = await requestRegisteredResourcePurchase(input, options);
    return result(record, reused, 'live_mainnet');
  }
  if (options.execute === true) assertPaymentConfigExecutionEnabled(options.config);
  const input = PurchaseRequestInputSchema.extend({ resourceId: PaidResourceIdSchema }).parse(raw);
  if (input.query !== undefined || input.request !== undefined) throw new Error('RESOURCE_REQUEST_INPUT_UNSUPPORTED');
  const principal = SpendPrincipalSchema.parse(options.principal);
  options.ledger.assertCardMemberActive(principal.cardMemberId);
  const clock = options.now ?? Date.now;
  const requestStartedAt = clock();
  const executionMode: PurchaseExecutionMode = options.execute === false ? 'simulated' : options.config.mode;
  const requestHash = hash({ resourceId: input.resourceId, reason: input.reason });
  async function complete(record: SpendReservation, reused: boolean) {
    options.ledger.assertReplayAllowed(record, executionMode, options.ledger.paymentScope(options.config, executionMode));
    if (record.decision.decision !== 'APPROVED' || executionMode === 'simulated' || options.deferExecution) return result(record, reused, executionMode);
    const endpoint = paymentEndpointForIntent(options.origin, record.intent);
    if (record.status === 'APPROVED') {
      try { await (options.pay ?? executeApprovedPayment)(options.ledger, record.approvalId, options.config, endpoint); }
      catch { /* Persisted approval remains authoritative for replay or recovery. */ }
    } else if (['PAYING', 'PAYMENT_UNKNOWN'].includes(record.status) || record.deliveryStatus === 'PENDING') {
      await (options.recover ?? recoverApprovedPayment)(options.ledger, input.requestId, options.config, endpoint, undefined, principal.cardMemberId);
    }
    return result(options.ledger.getOwned(input.requestId, principal.cardMemberId)!, reused, executionMode);
  }
  const existing = options.ledger.getOwned(input.requestId, principal.cardMemberId);
  if (existing) {
    options.ledger.assertReplayAllowed(existing, executionMode, options.ledger.paymentScope(options.config, executionMode));
    if (existing.intent.requestHash !== requestHash || existing.intent.resourceId !== input.resourceId || !existing.intent.resourcePath) throw new Error('REQUEST_ID_CONFLICT');
    return complete(existing, true);
  }
  const { quote, challenge, request: quotedRequest } = await fetchPaidResourceQuote(input.resourceId, options.origin, options.config, options.fetcher);
  // The isolated Pay GET profile authorizes Accept: application/json. Persist
  // it in the same immutable request used for binding, signing and final HTTP.
  // ExecutionSafety checks this exact request against the external requestHash.
  const request = options.externalExecution ? { ...quotedRequest, headers: { accept: 'application/json' } } : quotedRequest;
  const descriptor = paidResource(input.resourceId);
  const now = clock();
  const authority = options.ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, executionMode);
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: input.requestId, requestHash,
    resourceId: descriptor.id, resourceScopeId: PAID_RESOURCE_SCOPE_ID, resourcePath: descriptor.path,
    httpRequest: request, x402Challenge: challenge, deliveryRecovery: TEST_CACHED_DELIVERY,
    providerId: descriptor.providerId, reason: input.reason, amount: quote.amount, currency: 'USDC', assetDecimals: 6,
    assetId: quote.asset, network: quote.network, payTo: quote.payTo, paymentScheme: quote.scheme,
    quoteFingerprint: hash(quote), createdAt: requestStartedAt,
    expiresAt: now + Math.min(quote.maxTimeoutSeconds, 300) * 1000,
    executionBinding: resourcePaymentBinding(options.config, options.config.buyer, request, challenge, TEST_CACHED_DELIVERY), ...(authority ? { authority } : {}) });
  const winner = options.ledger.getOwned(input.requestId, principal.cardMemberId);
  if (winner) {
    options.ledger.assertReplayAllowed(winner, executionMode, options.ledger.paymentScope(options.config, executionMode));
    if (winner.intent.requestHash !== requestHash || winner.intent.resourceId !== input.resourceId || !winner.intent.resourcePath) throw new Error('REQUEST_ID_CONFLICT');
    return complete(winner, true);
  }
  const reserved = options.ledger.reserve(intent, quote, now, executionMode, principal.cardMemberId, options.ledger.paymentScope(options.config, executionMode), options.externalExecution);
  const binding = reserved.intent.authority;
  if (reserved.ownerCardMemberId !== principal.cardMemberId || (binding && binding.cardMemberId !== principal.cardMemberId)) throw new Error('PURCHASE_REQUEST_OWNER_MISMATCH');
  return complete(reserved, reserved.intent.id !== intent.id);
}
