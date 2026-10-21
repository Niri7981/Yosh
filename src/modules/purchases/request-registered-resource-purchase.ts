import { assertGrantPostScope } from '../resources/post-request-authorization';
import { z } from 'zod';
import { assertPaymentConfigExecutionEnabled, type PaymentConfig } from '../payment/payment-config';
import { fetchResourceChallenge, validateResourceChallenge } from '../payment/resource-challenge';
import { createX402SpendIntent } from '../resources/market-spend-adapter';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import { executeApprovedPayment, recoverApprovedPayment } from './approved-payment';
import type { PurchaseLedger, SpendReservation } from './purchase-ledger';
import { assertAuthorizedRequestInstance, authorizedRequestInstance, ResourceRequestInputSchema, resourceInputNames, type HttpResourceRequest, type X402Resource } from '../resources/http-resource';
import { hash } from './spending-policy';
import type { ExternalExecutionFacts } from './execution-safety';

const RequestSchema = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  resourceId: z.string().min(1).max(200), reason: z.string().trim().min(1).max(240),
  query: z.string().trim().min(1).max(300).optional(),
  request: ResourceRequestInputSchema.optional() }).strict();

export function requestForPurchase(resource: X402Resource, input: z.infer<typeof RequestSchema>): X402Resource {
  const queryNames = resourceInputNames(resource.requestInputs?.query);
  if (input.query !== undefined && (queryNames.length !== 1 || input.request?.query)) throw new Error('RESOURCE_REQUEST_INPUT_UNSUPPORTED');
  return { ...resource, request: authorizedRequestInstance(resource, input.query === undefined ? input.request ?? {}
    : { ...input.request, query: { [queryNames[0]]: input.query } }) };
}

/** Internal backend service. Agents select an ID; only backend configuration registers facts.
 * Uses the existing reserve/claim/executor/recovery pipeline, with no second payment stack. */
export async function requestRegisteredResourcePurchase(raw: unknown, options: {
  deferExecution?: boolean;
  externalExecution?: ExternalExecutionFacts;
  externalQuote?: unknown;
  externalRequest?: HttpResourceRequest;
  config: PaymentConfig; ledger: PurchaseLedger; principal: SpendPrincipal; fetcher?: typeof fetch; now?: () => number;
}) {
  const input = RequestSchema.parse(raw); const principal = SpendPrincipalSchema.parse(options.principal);
  const { config, ledger } = options;
  ledger.assertCardMemberActive(principal.cardMemberId);
  async function reuse(existing: SpendReservation) {
    ledger.assertReplayAllowed(existing, config.mode, ledger.paymentScope(config, config.mode));
    const request = existing.intent.httpRequest;
    if (existing.intent.requestInputFingerprint !== undefined
      ? existing.intent.requestInputFingerprint !== hash({ query: input.query ?? null, request: input.request ?? null })
      : input.request !== undefined || (input.query !== undefined && (!request || new URL(request.url).searchParams.get('query') !== input.query)))
      throw new Error('REQUEST_ID_CONFLICT');
    const requestHash = hash({ resourceId: existing.intent.resourceId, providerId: existing.intent.providerId, request, reason: input.reason });
    if (!request || existing.intent.resourceId !== input.resourceId || existing.intent.requestHash !== requestHash) throw new Error('REQUEST_ID_CONFLICT');
    if (options.deferExecution) return existing;
    // Recovery uses the original immutable endpoint, even after registration changes.
    // It remains available with execution disabled and cannot create another signature.
    if (['PAYING', 'PAYMENT_UNKNOWN', 'PAID'].includes(existing.status)) {
      await recoverApprovedPayment(ledger, input.requestId, config, request.url, undefined, principal.cardMemberId);
    } else if (existing.status === 'APPROVED') {
      try { await executeApprovedPayment(ledger, existing.approvalId, config, request.url); } catch { /* Return authoritative persisted state, including unknown submission. */ }
    }
    return ledger.getOwned(input.requestId, principal.cardMemberId)!;
  }
  const existing = ledger.getOwned(input.requestId, principal.cardMemberId);
  if (existing) return reuse(existing);
  const resource = config.registeredResources?.find(candidate => candidate.resourceId === input.resourceId);
  if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  const instance = requestForPurchase(resource, input);
  let approvedRequest = options.externalExecution && instance.request.method === 'GET'
    ? { ...instance, request: { ...instance.request, headers: { ...instance.request.headers, accept: instance.request.headers.accept ?? 'application/json' } } } : instance;
  if (options.externalRequest) {
    if (!options.externalExecution) throw new Error('EXTERNAL_PROVENANCE_REQUIRED');
    const request = assertAuthorizedRequestInstance({ ...resource, request: { ...resource.request, headers: approvedRequest.request.headers } }, options.externalRequest);
    const expected = new URL(approvedRequest.request.url), actual = new URL(request.url);
    expected.searchParams.sort(); actual.searchParams.sort();
    if (expected.href !== actual.href) throw new Error('PAY_IMMUTABLE_REQUEST_MISMATCH');
    approvedRequest = { ...approvedRequest, request };
  }
  assertPaymentConfigExecutionEnabled(config);
  const quoteRequestedAt = options.now?.() ?? Date.now();
  assertGrantPostScope(resource, ledger.activeSpendGrant(quoteRequestedAt, principal.cardMemberId, config.mode, resource.resourceId), quoteRequestedAt);
  if (options.externalQuote !== undefined && !options.externalExecution) throw new Error('EXTERNAL_PROVENANCE_REQUIRED');
  const { challenge, quote, paymentRequiredHeader } = options.externalQuote === undefined
    ? await fetchResourceChallenge(approvedRequest, config, options.fetcher)
    : { ...validateResourceChallenge(options.externalQuote, approvedRequest, config),
      paymentRequiredHeader: Buffer.from(JSON.stringify(options.externalQuote)).toString('base64') };
  const winner = ledger.getOwned(input.requestId, principal.cardMemberId);
  if (winner) return reuse(winner);
  const now = options.now?.() ?? Date.now();
  const authority = ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, config.mode, resource.resourceId);
  const intent = createX402SpendIntent({ idempotencyKey: input.requestId, resource: approvedRequest, challenge, environment: config,
    buyer: config.buyer, reason: input.reason, now: quoteRequestedAt, authority,
    requestInputFingerprint: hash({ query: input.query ?? null, request: input.request ?? null }), paymentRequiredHeader });
  const record = ledger.reserve(intent, quote, now, config.mode, principal.cardMemberId, ledger.paymentScope(config, config.mode), options.externalExecution);
  if (record.status === 'APPROVED' && !options.deferExecution) {
    try { await executeApprovedPayment(ledger, record.approvalId, config, approvedRequest.request.url); } catch { /* Never translate a lost submission response into 'no payment'. */ }
  }
  return ledger.getOwned(input.requestId, principal.cardMemberId)!;
}
