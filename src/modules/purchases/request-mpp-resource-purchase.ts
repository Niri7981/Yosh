import { randomUUID } from 'node:crypto';
import { SpendIntentSchema } from '../authority/spend-intent';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import type { PaymentConfig } from '../payment/payment-config';
import { assertMppExecutionEnabled, fetchMppResourceQuote, mppPaymentBinding } from '../payment/mpp-resource-charge';
import { PurchaseRequestInputSchema } from './purchase-request-input';
import { requestForPurchase } from './request-registered-resource-purchase';
import { executeApprovedMppCharge, type MppChargeDependencies } from './approved-mpp-charge';
import { recoverMppCharge } from './recover-mpp-charge';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import { readAgentPurchase } from './agent-purchase-read';
import { hash } from './spending-policy';
import { routeStoredApprovedPayment } from '../payment/payment-router';

/** Agent inputs identify a registered resource only. The backend obtains and
 * binds the actual MPP challenge, then reuses atomic Grant/budget reservation. */
export async function requestMppResourcePurchase(raw: unknown, options: {
  config: PaymentConfig; ledger: PurchaseLedger; principal: SpendPrincipal; dependencies: MppChargeDependencies;
  assertAccepting?: () => void;
}) {
  const input = PurchaseRequestInputSchema.parse(raw);
  const principal = SpendPrincipalSchema.parse(options.principal);
  const { config, ledger, dependencies } = options;
  ledger.assertCardMemberActive(principal.cardMemberId);
  const inputHash = hash({ query: input.query ?? null, request: input.request ?? null });
  const finish = () => readAgentPurchase(ledger, principal.cardMemberId, { purchaseId: input.requestId })!;
  async function reuse(record: PurchaseRecord) {
    if (!record.intent.mpp || record.intent.resourceId !== input.resourceId || record.intent.reason !== input.reason
      || record.intent.requestInputFingerprint !== inputHash) throw new Error('REQUEST_ID_CONFLICT');
    ledger.assertReplayAllowed(record, config.mode, ledger.paymentScope(config, config.mode));
    if (['PAYING', 'PAYMENT_UNKNOWN', 'PAID'].includes(record.status))
      await recoverMppCharge(ledger, record, config, record.intent.httpRequest!.url, dependencies);
    // An existing APPROVED record needs its original execution owner/permit.
    // A repeated client request never prepares a new transaction.
    return finish();
  }
  const existing = ledger.getOwned(input.requestId, principal.cardMemberId);
  if (existing) return reuse(existing);
  assertMppExecutionEnabled(config);
  options.assertAccepting?.();
  const declared = config.registeredResources?.find(resource => resource.resourceId === input.resourceId);
  if (!declared) throw new Error('MPP_REGISTERED_RESOURCE_REQUIRED');
  const resource = requestForPurchase(declared, input);
  const quote = await fetchMppResourceQuote(resource, config, dependencies.binary, dependencies.fetcher);
  options.assertAccepting?.();
  const winner = ledger.getOwned(input.requestId, principal.cardMemberId);
  if (winner) return reuse(winner);
  const now = Date.now();
  const authority = ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, config.mode, resource.resourceId);
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: input.requestId,
    requestHash: hash({ resourceId: resource.resourceId, providerId: resource.providerId, request: resource.request, reason: input.reason }),
    requestInputFingerprint: inputHash, resourceId: resource.resourceId, providerId: resource.providerId, reason: input.reason,
    httpRequest: resource.request, mpp: quote, deliveryRecovery: resource.deliveryRecovery ?? { kind: 'none' }, deliveryPolicy: resource.deliveryPolicy,
    amount: quote.amount, currency: 'USDC', assetDecimals: 6, assetId: quote.asset, network: quote.network, payTo: quote.payTo,
    paymentScheme: 'mpp_charge', quoteFingerprint: hash(quote), createdAt: now, expiresAt: quote.expiresAt,
    executionBinding: mppPaymentBinding(config, resource.request, quote, resource.deliveryRecovery, resource.deliveryPolicy), authority });
  ledger.executionSafety.enable(now);
  const facts = { callerId: principal.cardMemberId, operationId: input.requestId, attemptId: randomUUID(),
    factsHash: hash([intent.requestHash, quote]), requestHash: hash({ method: resource.request.method, url: resource.request.url,
      headers: Object.entries(resource.request.headers).sort(([a], [b]) => a.localeCompare(b)), body: resource.request.body ?? null }), quoteHash: hash(quote) };
  const record = ledger.reserve(intent, quote, now, config.mode, principal.cardMemberId, ledger.paymentScope(config, config.mode), facts);
  if (record.status === 'APPROVED') {
    const permit = ledger.executionSafety.permit(record);
    try {
      await routeStoredApprovedPayment(record, {
        pay_mpp_solana_charge: () => executeApprovedMppCharge(ledger, record.approvalId, config, resource.request.url, dependencies, permit),
        pay_x402_solana: () => { throw new Error('PAYMENT_PROTOCOL_MISMATCH'); },
      });
    } catch { /* The persisted original payment state, including UNKNOWN, is authoritative. */ }
  }
  return finish();
}
