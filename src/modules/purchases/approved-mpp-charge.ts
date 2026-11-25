import { type PaymentConfig } from '../payment/payment-config';
import { assertMppExecutionEnabled, mppPaymentBinding, validateMppQuote } from '../payment/mpp-resource-charge';
import { createMppSignedPaymentIdentity } from '../payment/mpp-payment-evidence';
import { prepareSignedMppCharge } from '../payment/mpp-charge-execution';
import { MppStoredPaymentSchema, type MppStoredPayment } from '../payment/mpp-contract';
import type { OriginalPaymentLifetime } from '../payment/original-payment-evidence';
import { parseMppReceipt } from '../payment/mpp-protocol-engine';
import { assertAuthorizedRequestInstance } from '../resources/http-resource';
import { prepareSafeResourceFetch } from '../resources/safe-resource-fetch';
import { readBoundedResourceDelivery } from '../resources/read-market-snapshot';
import { OriginalPaymentRecordSchema } from './original-payment-record';
import { monetaryScopeId } from './monetary-scope';
import { hash } from './spending-policy';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import type { ExternalExecutionPermit } from './execution-safety';
import { saveBoundOriginalBody } from './original-merchant-delivery';
import { reconcileApprovedPayment } from './approved-payment';
import { paymentFailure, type PaymentFailureStage } from '../payment/pay-controller-diagnostics';

// The single runtime owner must let its original paid HTTP response finish before
// a retry decides whether delivery needs recovery. This is not spending authority:
// durable claims still prevent duplicate payment, and restart clears only this wait.
const activeExecutions = new WeakMap<PurchaseLedger, Set<string>>();
export function isMppExecutionActive(ledger: PurchaseLedger, approvalId: string): boolean {
  return activeExecutions.get(ledger)?.has(approvalId) ?? false;
}

export type MppChargeDependencies = {
  binary: string;
  fetcher?: typeof fetch;
  deferReconciliation?: boolean;
  /** Internal test boundary only; never populated from HTTP/MCP input. */
  prepare?: (config: PaymentConfig, record: PurchaseRecord, beforeSign: () => void, maximumNetworkFeeLamports: string) => Promise<{
    payment: MppStoredPayment; lifetime: OriginalPaymentLifetime;
  }>;
};

export function checkMppPaymentBinding(record: PurchaseRecord, config: PaymentConfig, endpoint: string, checkExpiry = true) {
  const intent = record.intent;
  const quote = intent.mpp;
  const request = intent.httpRequest;
  if (!quote || !request || intent.x402Challenge || intent.paymentScheme !== 'mpp_charge'
    || endpoint !== request.url || hash(quote) !== hash(record.quote) || hash(quote) !== intent.quoteFingerprint
    || quote.amount !== intent.amount || quote.network !== intent.network || quote.asset !== intent.assetId
    || quote.payTo !== intent.payTo || intent.assetDecimals !== 6
    || intent.executionBinding !== mppPaymentBinding(config, request, quote, intent.deliveryRecovery, intent.deliveryPolicy)
    || record.monetaryScope.network !== config.network || record.monetaryScope.assetId !== config.mint
    || record.monetaryScope.assetDecimals !== config.asset.decimals || record.executionMode !== config.mode)
    throw new Error('MPP_PAYMENT_BINDING_MISMATCH');
  if (!checkExpiry) return;
  assertMppExecutionEnabled(config);
  const resource = config.registeredResources?.find(item => item.resourceId === intent.resourceId);
  if (!resource || resource.providerId !== intent.providerId || hash(resource.deliveryRecovery ?? { kind: 'none' }) !== hash(intent.deliveryRecovery ?? { kind: 'none' })
    || hash(resource.deliveryPolicy ?? null) !== hash(intent.deliveryPolicy ?? null)) throw new Error('MPP_REGISTERED_RESOURCE_REQUIRED');
  assertAuthorizedRequestInstance(resource, request);
  validateMppQuote(quote, resource, config);
}

function isMppDeliveryResponse(response: Response, endpoint: string) {
  return [200, 201].includes(response.status) && (!response.url || response.url === endpoint)
    && !/(?:^|,)\s*Payment(?:\s|,|$)/i.test(response.headers.get('www-authenticate') ?? '');
}

async function mppReceiptStatus(response: Response, binary: string, transaction: string | undefined) {
  const header = response.headers.get('payment-receipt');
  if (header === null) return 'UNAVAILABLE';
  try {
    const receipt = await parseMppReceipt(binary, header);
    return receipt.reference === transaction ? 'MATCHED' : 'INVALID';
  } catch { return 'INVALID'; }
}

export async function receiveMppDelivery(ledger: PurchaseLedger, record: PurchaseRecord, response: Response, endpoint: string, binary: string,
  kind: 'initial' | 'retry' = 'initial', token?: string,
  original?: { receipt: Awaited<ReturnType<typeof mppReceiptStatus>>; body?: Promise<unknown> }) {
  const claim = token ?? ledger.claimDelivery(record.approvalId, kind);
  if (!claim) { await response.body?.cancel().catch(() => {}); return; }
  try {
    if (!isMppDeliveryResponse(response, endpoint)) throw new Error('MPP_DELIVERY_RESPONSE_INVALID');
    const receipt = original?.receipt ?? await mppReceiptStatus(response, binary, record.transaction);
    if (receipt === 'MATCHED') {
      ledger.recordReceipt(record.approvalId, 'CONFIRMED', { transaction: record.transaction!, network: record.intent.network,
        ...(record.paymentEvidence?.version !== 1 ? { payer: record.paymentEvidence?.payer } : {}), amount: record.intent.amount });
    } else {
      ledger.recordReceipt(record.approvalId, receipt);
      if (receipt === 'INVALID') throw new Error('MPP_RECEIPT_MISMATCH');
    }
    const data = await (original?.body ?? readBoundedResourceDelivery(response, record.intent.deliveryPolicy));
    ledger.finish(record.approvalId, { transaction: record.transaction!, data }, undefined, claim);
    return { transaction: record.transaction!, data };
  } catch {
    ledger.failDeliveryAttempt(record.approvalId, claim, 'DELIVERY_RESPONSE_INVALID');
    throw new Error('MPP_DELIVERY_PENDING');
  } finally { await response.body?.cancel().catch(() => {}); }
}

export async function executeApprovedMppCharge(ledger: PurchaseLedger, approvalId: string, config: PaymentConfig, endpoint: string,
  dependencies: MppChargeDependencies, permit?: ExternalExecutionPermit) {
  assertMppExecutionEnabled(config);
  const validate = (record: PurchaseRecord) => {
    if (monetaryScopeId(record.monetaryScope) !== monetaryScopeId(ledger.paymentScope(config, config.mode))) throw new Error('MONETARY_SCOPE_MISMATCH');
    checkMppPaymentBinding(record, config, endpoint);
  };
  const record = ledger.claim(approvalId, undefined, validate, config.mode, permit);
  const active = activeExecutions.get(ledger) ?? new Set<string>();
  active.add(approvalId);
  activeExecutions.set(ledger, active);
  const beforeSign = () => ledger.assertCanSign(approvalId, undefined, validate, permit);
  let stage: PaymentFailureStage = 'preparation';
  let reconciliationStarted = false;
  try {
    const grant = record.intent.authority ? ledger.spendGrantById(record.intent.authority.grantId) : undefined;
    const maximumNetworkFeeLamports = grant?.maximumNetworkFeeLamports;
    if (!maximumNetworkFeeLamports) throw new Error('MPP_NETWORK_FEE_CONSENT_REQUIRED');
    const signerConfig = { ...config, merchant: record.intent.payTo };
    const prepared = await (dependencies.prepare
      ? dependencies.prepare(signerConfig, record, beforeSign, maximumNetworkFeeLamports)
      : prepareSignedMppCharge(dependencies.binary, signerConfig, record.intent.mpp!, beforeSign, maximumNetworkFeeLamports));
    const payment = MppStoredPaymentSchema.parse(prepared.payment);
    const identity = createMppSignedPaymentIdentity(payment, signerConfig, prepared.lifetime);
    stage = 'payload_persistence';
    ledger.savePayload(approvalId, payment, validate, OriginalPaymentRecordSchema.parse({ version: 1,
      purchaseId: record.intent.id, requestId: record.intent.idempotencyKey, monetaryScope: record.monetaryScope,
      scopeId: monetaryScopeId(record.monetaryScope), executionBinding: record.intent.executionBinding,
      quoteFingerprint: record.intent.quoteFingerprint, payloadHash: hash(payment), recordedAt: Date.now(), identity }), permit);
    stage = 'submission_prepare';
    const request = record.intent.httpRequest!;
    const init = { method: request.method, headers: { ...request.headers, Authorization: payment.credential },
      redirect: 'error' as const, signal: AbortSignal.timeout(55_000) };
    const submit = request.access === 'https' ? await prepareSafeResourceFetch(endpoint, init, dependencies.fetcher)
      : () => (dependencies.fetcher ?? fetch)(endpoint, init);
    beforeSign();
    ledger.markSubmissionAttempt(approvalId, validate, undefined, permit);
    stage = 'submission';
    const response = await submit();
    try {
      const transaction = identity.knownSignature!;
      const receipt = await mppReceiptStatus(response, dependencies.binary, transaction);
      let body: Promise<unknown> | undefined;
      if (receipt === 'MATCHED' && isMppDeliveryResponse(response, endpoint)) {
        ledger.recordReceipt(approvalId, 'UNVERIFIED', { transaction, network: identity.network, payer: identity.payer, amount: identity.amount });
        stage = 'delivery';
        body = readBoundedResourceDelivery(response, record.intent.deliveryPolicy);
        const saved = await saveBoundOriginalBody(ledger, approvalId, body);
        if (saved) {
          ledger.unknown(approvalId);
          if (!dependencies.deferReconciliation) {
            reconciliationStarted = true;
            await reconcileApprovedPayment(ledger, record.intent.idempotencyKey, config, undefined, record.ownerCardMemberId);
          }
          return { transaction, data: saved.data };
        }
      } else if (receipt !== 'MATCHED') ledger.recordReceipt(approvalId, receipt);
      stage = 'settlement_reconciliation';
      reconciliationStarted = true;
      await reconcileApprovedPayment(ledger, record.intent.idempotencyKey, config, undefined, record.ownerCardMemberId);
      const current = ledger.getOwned(record.intent.idempotencyKey, record.ownerCardMemberId!)!;
      if (current.status !== 'PAID') throw new Error('MPP_ORIGINAL_OUTCOME_UNRESOLVED');
      stage = 'delivery';
      return await receiveMppDelivery(ledger, current, response, endpoint, dependencies.binary, 'initial', undefined, { receipt, body });
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    const failure = paymentFailure(error, stage, record.intent.idempotencyKey);
    ledger.recordExecutionFailure(approvalId, failure);
    const original = ledger.savedOriginalPayment(approvalId);
    if (original?.state === 'SIGNED_NOT_SUBMITTED' || (!original && !ledger.savedMppPayment(approvalId))) ledger.failUnsubmitted(approvalId);
    else {
      ledger.unknown(approvalId);
      if (!reconciliationStarted) await reconcileApprovedPayment(ledger, record.intent.idempotencyKey, config, undefined, record.ownerCardMemberId);
    }
    throw failure;
  } finally {
    active.delete(approvalId);
    if (!active.size) activeExecutions.delete(ledger);
  }
}
