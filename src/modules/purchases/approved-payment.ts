import type { ExternalExecutionPermit } from './execution-safety';
import type { Trace } from '../demo/trace';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { assertPaymentConfigExecutionEnabled, type PaymentConfig } from '../payment/payment-config';
import { prepareSolanaPayment, MARKET_RESOURCE } from '../payment/solana-payment';
import { reconcileStoredOriginalPayment, type ChainOutcome } from '../payment/reconcile-transaction';
import { createSignedPaymentIdentity, type OriginalPaymentLifetime } from '../payment/original-payment-evidence';
import { OriginalPaymentRecordSchema } from './original-payment-record';
import { monetaryScopeId } from './monetary-scope';
import { loadBuyerSigner } from '../payment/wallet';
import { PAID_RESOURCE_SCOPE_ID, paidResource, PaidResourceIdSchema, type PaidResourceId } from '../resources/paid-resources';
import type { SpendIntent } from '../authority/spend-intent';
import { PurchaseLedger, type PurchaseRecord } from './purchase-ledger';
import { hash } from './spending-policy';
import { runPaymentPreflight } from '../payment/payment-preflight';
import { MarketOfferIdSchema, marketOffer } from '../resources/market-offers';
import { paymentSignatureHeaders, readPaymentRequiredHeader, readSettlementResponse, readSettlementTransactionHint } from '../payment/x402-client';
import type { PaymentExecutionContext, PaymentExecutor, PaymentResponseObservation, PreparedPayment } from '../payment/payment-execution-contract';
import { resourcePaymentBinding, validateResourceChallenge } from '../payment/resource-challenge';
import { HttpResourceRequestSchema } from '../resources/http-resource';
import { prepareSafeResourceFetch } from '../resources/safe-resource-fetch';
import { assertProductionPaymentGate } from './production-execution-gate';
import { purchaseSigningAuthorization } from './purchase-signing-authorization';
import { observeDeliveryReceipt, receiveOriginalDelivery, recoverPaidDelivery } from './delivery-recovery';
import type { ReconciliationCode } from './payment-reconciliation';

export function paymentEndpoint(origin: string, offerId?: string) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Purchase only calls the configured local API');
  return new URL(offerId ? `${MARKET_RESOURCE}&offer=${MarketOfferIdSchema.parse(offerId)}` : MARKET_RESOURCE, url).href;
}
export function paymentEndpointForResource(origin: string, id: PaidResourceId) {
  const base = new URL(paymentEndpoint(origin));
  return new URL(paidResource(id).path, base).href;
}
export function paymentEndpointForIntent(origin: string, intent: SpendIntent) {
  if (intent.httpRequest) {
    const request = HttpResourceRequestSchema.parse(intent.httpRequest);
    if (request.access === 'test_loopback' && new URL(origin).origin !== new URL(request.url).origin) throw new Error('Approval binding changed');
    return request.url;
  }
  if (!intent.resourcePath) return paymentEndpoint(origin, intent.offerId);
  const id = PaidResourceIdSchema.parse(intent.resourceId);
  if (intent.resourcePath !== paidResource(id).path) throw new Error('Resource binding changed');
  return paymentEndpointForResource(origin, id);
}
export function paymentBinding(config: PaymentConfig, endpoint: string, quote?: PaymentRequirements) {
  const facts = [config.cluster, config.network, config.mint, config.buyer, config.merchant, endpoint];
  return hash(quote ? [...facts, 'GET', quote] : facts);
}
export function checkPaymentBinding(record: PurchaseRecord, config: PaymentConfig, endpoint: string) {
  const intent = record.intent;
  if (intent.httpRequest && intent.x402Challenge) {
    if (intent.paymentRequiredHeader && hash(readPaymentRequiredHeader(intent.paymentRequiredHeader,
      intent.x402Challenge.accepts.some(quote => Object.hasOwn(quote, 'outputSchema')))) !== hash(intent.x402Challenge))
      throw new Error('Approval quote evidence changed');
    const { quote } = validateResourceChallenge(intent.x402Challenge, { resourceId: intent.resourceId, providerId: intent.providerId,
      request: intent.httpRequest, network: config.network, mint: intent.assetId, decimals: 6,
      recipientSource: 'live_challenge', maximumAmount: intent.amount }, config, record.quote);
    if (intent.paymentScheme !== quote.scheme || intent.assetDecimals !== config.asset.decimals || intent.network !== config.network || endpoint !== intent.httpRequest.url
      || hash(quote) !== intent.quoteFingerprint || hash(record.quote) !== intent.quoteFingerprint
      || intent.executionBinding !== resourcePaymentBinding(config, config.buyer, intent.httpRequest, intent.x402Challenge, intent.deliveryRecovery, intent.paymentRequiredHeader)) throw new Error('Approval binding changed');
    return;
  }
  if (intent.executionBinding !== paymentBinding(config, endpoint, intent.offerId || intent.resourcePath ? record.quote : undefined) || intent.quoteFingerprint !== hash(record.quote) || String(intent.amount) !== record.quote.amount
    || intent.assetId !== config.mint || intent.network !== config.network || intent.payTo !== config.merchant) throw new Error('Approval binding changed');
  if (intent.paymentScheme !== record.quote.scheme || record.quote.asset !== intent.assetId || record.quote.network !== intent.network || record.quote.payTo !== intent.payTo) throw new Error('Approval terms changed');
  if (intent.offerId) {
    const offer = marketOffer(MarketOfferIdSchema.parse(intent.offerId));
    if (endpoint !== paymentEndpoint(endpoint, intent.offerId) || record.quote.amount !== offer.amount) throw new Error('Offer binding changed');
  }
  if (intent.resourcePath) {
    const id = PaidResourceIdSchema.parse(intent.resourceId);
    if (intent.offerId || intent.resourcePath !== paidResource(id).path || endpoint !== paymentEndpointForResource(endpoint, id)) throw new Error('Resource binding changed');
    if (intent.resourceScopeId !== PAID_RESOURCE_SCOPE_ID) throw new Error('Resource scope changed');
  }
}
function originalEvidence(record: PurchaseRecord, payload: PaymentPayload, config: PaymentConfig, lifetime?: OriginalPaymentLifetime) {
  const identity = createSignedPaymentIdentity(payload, config, {
    payer: config.buyer, recipient: record.intent.payTo, mint: record.intent.assetId,
    amount: record.intent.amount, decimals: record.intent.assetDecimals,
    ...(typeof record.quote.extra?.feePayer === 'string' ? { feePayer: record.quote.extra.feePayer } : {}),
  }, lifetime);
  return OriginalPaymentRecordSchema.parse({ version: 1, purchaseId: record.intent.id, requestId: record.intent.idempotencyKey,
    monetaryScope: record.monetaryScope, scopeId: monetaryScopeId(record.monetaryScope),
    executionBinding: record.intent.executionBinding, quoteFingerprint: record.intent.quoteFingerprint,
    payloadHash: hash(payload), recordedAt: Date.now(), identity });
}

/** Buyer-side accounting recovery. No signer, merchant request or transaction submission. */
export async function reconcileApprovedPayment(ledger: PurchaseLedger, taskId: string, config: PaymentConfig, trace: Trace = () => {}, memberId?: string,
  options: { automatic?: boolean; signal?: AbortSignal } = {}): Promise<ChainOutcome | undefined> {
  const record = memberId ? ledger.getOwned(taskId, memberId) : ledger.getLegacy(taskId);
  if (!record || !['live_devnet', 'live_mainnet'].includes(record.executionMode) || !['PAYING', 'PAYMENT_UNKNOWN'].includes(record.status)) return;
  if (record.executionMode === 'live_mainnet' || config.mode === 'live_mainnet') {
    ledger.assertReplayAllowed(record, config.mode);
    ledger.assertReplayAllowed(record, config.mode, ledger.paymentScope(config, config.mode));
  }
  const claim = ledger.reconciliation.claim(record.intent.id, options.automatic);
  if (!claim) return { status: 'UNKNOWN' };
  let code: ReconciliationCode = 'UNKNOWN';
  try {
    options.signal?.throwIfAborted();
    trace('RECOVERY_STARTED');
    const payload = ledger.savedPayload(record.approvalId);
    if (!payload) { code = 'EVIDENCE_UNAVAILABLE'; return { status: 'UNKNOWN' }; } // Initial signer might still own the claim.
    let original = ledger.savedOriginalPayment(record.approvalId);
    if (!original) {
      // Signed legacy rows have no trustworthy send marker. Validate their original
      // bytes, retain possible submission, and never infer failure from that absence.
      try {
        ledger.attachLegacyOriginalPayment(record.approvalId, originalEvidence(record, payload, { ...config, merchant: record.intent.payTo }));
        original = ledger.savedOriginalPayment(record.approvalId);
      } catch { code = 'BINDING_MISMATCH'; return { status: 'UNKNOWN' }; }
    }
    if (!original || !['SUBMISSION_ATTEMPTED', 'OUTCOME_UNKNOWN'].includes(original.state)) { code = 'EVIDENCE_UNAVAILABLE'; return { status: 'UNKNOWN' }; }
    const identity = original.evidence.identity;
    if (identity.payer !== config.buyer || identity.network !== config.network || identity.mint !== config.mint) { code = 'BINDING_MISMATCH'; return { status: 'UNKNOWN' }; }
    let outcome: ChainOutcome;
    try {
      outcome = await reconcileStoredOriginalPayment(config, identity, original.transaction ?? ledger.observedTransactionSignature(record.approvalId) ?? record.transaction,
        signature => ledger.observeTransactionSignature(record.approvalId, signature),
        { before: claim.before, onCursor: before => ledger.reconciliation.saveCursor(claim, before), signal: options.signal });
    } catch { outcome = { status: 'UNKNOWN' }; }
    if (outcome.status === 'CONFIRMED') {
      ledger.confirmOriginalPayment(record.approvalId, outcome.transaction, outcome.confirmationStatus ?? 'confirmed');
      trace('CHAIN_CONFIRMED', outcome.transaction);
    } else if (outcome.status === 'FAILED') ledger.failOriginalPayment(record.approvalId, outcome.transaction);
    else ledger.unknown(record.approvalId);
    code = outcome.status;
    return outcome;
  } catch {
    code = options.signal?.aborted ? 'INTERRUPTED' : 'BINDING_MISMATCH';
    return { status: 'UNKNOWN' };
  } finally { ledger.reconciliation.finish(claim, code); }
}

async function prepareJavaScriptPayment(context: PaymentExecutionContext): Promise<PreparedPayment> {
  const { config, record, endpoint, beforeSign, production } = context;
  const signer = await loadBuyerSigner(config.buyer, process.env, config);
  beforeSign();
  let lifetime: OriginalPaymentLifetime | undefined;
  const payload = await prepareSolanaPayment(config, signer, record.quote, beforeSign,
    record.intent.httpRequest ? { amount: record.quote.amount, resource: record.intent.httpRequest.url, challenge: record.intent.x402Challenge }
      : record.intent.offerId || record.intent.resourcePath ? { amount: record.quote.amount, resource: new URL(endpoint).pathname + new URL(endpoint).search } : undefined,
    value => { lifetime = value; }, ...(production ? [production] : []));
  return { payload, ...(lifetime ? { lifetime } : {}) };
}

function paymentResponseObservation(response: Response, config: PaymentConfig, record: PurchaseRecord): PaymentResponseObservation {
  try {
    const receipt = readSettlementResponse(response, { network: config.network, payer: config.buyer, amount: record.intent.amount });
    // An untrusted receipt can repeat the signed buyer bytes in any arbitrary
    // string field. Share only bounded protocol facts that cannot carry them.
    const safe = { success: receipt.success, network: receipt.network, ...(receipt.payer ? { payer: receipt.payer } : {}),
      ...(receipt.amount === undefined ? {} : { amount: receipt.amount }) };
    return { status: response.status, paymentResponse: Buffer.from(JSON.stringify(safe)).toString('base64') };
  } catch { return { status: response.status }; }
}

/** Internal approval ID is the only caller-supplied payment parameter.
 * Executors are internal dependencies; Agent/UI input never selects one. */
export async function executeApprovedPayment(ledger: PurchaseLedger, approvalId: string, config: PaymentConfig, endpoint: string, trace: Trace = () => {}, executor?: PaymentExecutor, permit?: ExternalExecutionPermit) {
  assertPaymentConfigExecutionEnabled(config);
  executor?.assertEligibility(config, ledger);
  const validate = (record: PurchaseRecord) => {
    checkPaymentBinding(record, config, endpoint);
    assertProductionPaymentGate(ledger, record, config, endpoint);
  };
  const record = ledger.claim(approvalId, undefined, validate, config.mode, permit);
  // Recipient is approved data, never a product/Demo default for a generic resource.
  const signerConfig = record.intent.httpRequest ? { ...config, merchant: record.intent.payTo } : config;
  const beforeSign = () => ledger.assertCanSign(approvalId, undefined, validate, permit);
  const context: PaymentExecutionContext = { config: signerConfig, record, endpoint, beforeSign,
    ...(config.mode === 'live_mainnet' ? { production: purchaseSigningAuthorization(ledger, approvalId, signerConfig, endpoint, permit) } : {}) };
  let reconciliationStarted = false;
  try {
    executor?.beginPreparation?.(context);
    checkPaymentBinding(record, config, endpoint);
    if (record.intent.offerId || record.intent.resourcePath) {
      const preflight = await runPaymentPreflight(config, { amount: record.quote.amount });
      if (preflight.facilitator.feePayer !== record.quote.extra?.feePayer) throw new Error('Quote fee payer changed');
    }
    beforeSign(); trace('SIGNING');
    const { payload, lifetime } = await (executor ? executor.prepare(context) : prepareJavaScriptPayment(context));
    ledger.savePayload(approvalId, payload, validate, originalEvidence(record, payload, signerConfig, lifetime), permit);
    trace('SIGNED');
    // Encode before committing the send marker. The guarded write and fetch call
    // are synchronous neighbors; pause/exit cannot start a new submission after acknowledgement.
    const request = record.intent.httpRequest;
    const headers = { ...request?.headers, ...paymentSignatureHeaders(payload) };
    const init = { headers, ...(request ? { method: request.method, ...(request.body === undefined ? {} : { body: request.body }) } : {}),
      signal: AbortSignal.timeout(55_000), redirect: 'error' as const };
    const submit = request?.access === 'https' ? await prepareSafeResourceFetch(endpoint, init) : () => fetch(endpoint, init);
    executor?.assertBeforeSubmission(context);
    ledger.markSubmissionAttempt(approvalId, validate, undefined, permit);
    const pendingResponse = submit();
    trace('SUBMITTED');
    const response = await pendingResponse;
    try {
      const signature = readSettlementTransactionHint(response);
      if (signature) ledger.observeTransactionSignature(approvalId, signature);
    } catch { /* A missing/unusable merchant receipt cannot erase buyer evidence. */ }
    const submitted = record.ownerCardMemberId ? ledger.getOwned(record.intent.idempotencyKey, record.ownerCardMemberId) : ledger.getLegacy(record.intent.idempotencyKey);
    observeDeliveryReceipt(ledger, submitted!, response, config);
    try {
      reconciliationStarted = true;
      await reconcileApprovedPayment(ledger, record.intent.idempotencyKey, config, trace, record.ownerCardMemberId);
      const paid = (record.ownerCardMemberId ? ledger.getOwned(record.intent.idempotencyKey, record.ownerCardMemberId) : ledger.getLegacy(record.intent.idempotencyKey))!;
      if (paid.status !== 'PAID') { await response.body?.cancel().catch(() => {}); throw new Error('Original transaction unresolved or failed'); }
      return await receiveOriginalDelivery(ledger, paid, response, config, endpoint, trace);
    } finally {
      // Persist the original delivery before this advisory subprocess can fail
      // or delay it. Only independent original-transaction proof permits delivery.
      if (executor?.interpretResponse) {
        try { await executor.interpretResponse(paymentResponseObservation(response, config, record)); }
        catch { process.emitWarning('Protocol response interpretation unavailable; original payment reconciliation continues',
          { code: 'PAY_PROTOCOL_OBSERVATION_FAILED' }); }
      }
    }
  } catch {
    const original = ledger.savedOriginalPayment(approvalId);
    if (original?.state === 'SIGNED_NOT_SUBMITTED' || (!original && !ledger.savedPayload(approvalId))) ledger.failUnsubmitted(approvalId);
    else {
      ledger.unknown(approvalId);
      if (!reconciliationStarted) await reconcileApprovedPayment(ledger, record.intent.idempotencyKey, config, trace, record.ownerCardMemberId);
    }
    throw new Error('Payment stopped; use the same task for reconciliation, never create a replacement payment');
  }
}

/** Original payment is reconciled first; existing delivery recovery is only used after PAID. */
export async function recoverApprovedPayment(ledger: PurchaseLedger, taskId: string, config: PaymentConfig, endpoint: string, trace: Trace = () => {}, memberId?: string,
  options: { fetcher?: typeof fetch; automatic?: boolean; signal?: AbortSignal } = {}) {
  let record = memberId ? ledger.getOwned(taskId, memberId) : ledger.getLegacy(taskId);
  if (!record || !['live_devnet', 'live_mainnet'].includes(record.executionMode)) return;
  if (record.executionMode === 'live_mainnet' || config.mode === 'live_mainnet') {
    ledger.assertReplayAllowed(record, config.mode);
    ledger.assertReplayAllowed(record, config.mode, ledger.paymentScope(config, config.mode));
  }
  if (['PAYING', 'PAYMENT_UNKNOWN'].includes(record.status)) {
    await reconcileApprovedPayment(ledger, taskId, config, trace, memberId, options);
    record = memberId ? ledger.getOwned(taskId, memberId) : ledger.getLegacy(taskId);
  }
  if (!record || record.status !== 'PAID' || record.deliveryStatus !== 'PENDING') return;
  return recoverPaidDelivery(ledger, record, config, endpoint, current => checkPaymentBinding(current, config, endpoint), trace, options.fetcher);
}
