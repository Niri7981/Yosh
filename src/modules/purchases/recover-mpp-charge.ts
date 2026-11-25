import type { PaymentConfig } from '../payment/payment-config';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import { reconcileApprovedPayment } from './approved-payment';
import { checkMppPaymentBinding, isMppExecutionActive, receiveMppDelivery } from './approved-mpp-charge';
import { validateDeliveryCapability } from '../resources/delivery-capability';
import type { DeliveryRecoveryCapability, HttpResourceRequest } from '../resources/http-resource';
import { safeResourceFetch } from '../resources/safe-resource-fetch';
import { hash } from './spending-policy';

function identifierRequest(approved: Extract<DeliveryRecoveryCapability, { kind: 'payment_identifier' }>, record: PurchaseRecord) {
  const identifier = approved.identifier === 'transaction' ? record.transaction! : record.intent.id;
  const headers: Record<string, string> = { ...approved.request.headers };
  const url = new URL(approved.request.url);
  if (approved.location === 'header') headers[approved.name] = identifier;
  else {
    if (url.searchParams.has(approved.name)) throw new Error('MPP_RECOVERY_IDENTIFIER_CONFLICT');
    url.searchParams.set(approved.name, identifier);
  }
  return { url: url.href, headers, access: approved.request.access };
}

/** Reconcile the original transfer first. Delivery can query the bound merchant cache
 * or present the original, already-settled credential to the exact purchased GET. */
export async function recoverMppCharge(ledger: PurchaseLedger, initial: PurchaseRecord, config: PaymentConfig, endpoint: string,
  options: { binary?: string; fetcher?: typeof fetch; automatic?: boolean; signal?: AbortSignal; replayCredential?: boolean } = {}) {
  try {
    ledger.assertReplayAllowed(initial, config.mode, ledger.paymentScope(config, config.mode));
  } catch (error) {
    if (error instanceof Error && error.message === 'LIVE_PAYMENT_EVIDENCE_INVALID')
      ledger.blockDeliveryRecovery(initial.approvalId, 'DELIVERY_PAYMENT_EVIDENCE_INVALID');
    throw error;
  }
  const validate = (current: PurchaseRecord) => checkMppPaymentBinding(current, config, endpoint, false);
  validate(initial);
  if (isMppExecutionActive(ledger, initial.approvalId)) return;
  if (options.replayCredential && initial.status !== 'PAID') return;
  if (['PAYING', 'PAYMENT_UNKNOWN'].includes(initial.status))
    await reconcileApprovedPayment(ledger, initial.intent.idempotencyKey, config, undefined, initial.ownerCardMemberId, options);
  const record = ledger.getOwned(initial.intent.idempotencyKey, initial.ownerCardMemberId!)!;
  if (record.status !== 'PAID' || (record.deliveryStatus !== 'PENDING'
    && !(options.replayCredential && record.deliveryStatus === 'UNSUPPORTED'))) return;
  const binary = options.binary ?? process.env.YOSH_MPP_PROTOCOL_ENGINE;
  if (!binary) return;

  const original = record.intent.httpRequest!;
  let approved: DeliveryRecoveryCapability;
  try {
    approved = validateDeliveryCapability(ledger.deliveryCapability(record.approvalId), original);
    if (hash(approved) !== hash(record.intent.deliveryRecovery ?? { kind: 'none' })) throw new Error('MPP_RECOVERY_BINDING_MISMATCH');
    if (approved.kind !== 'payment_identifier' && (approved.kind !== 'none' || original.method !== 'GET'
      || original.body !== undefined || (config.isProduction && original.access !== 'https'))) throw new Error('MPP_RECOVERY_BINDING_MISMATCH');
  } catch {
    ledger.blockDeliveryRecovery(record.approvalId, 'DELIVERY_RECOVERY_BINDING_INVALID');
    return;
  }
  options.signal?.throwIfAborted();
  let request: { url: string; headers: Record<string, string>; access: HttpResourceRequest['access'] };
  let token: string | undefined;
  if (approved.kind === 'payment_identifier') {
    request = identifierRequest(approved, record);
    token = ledger.claimDelivery(record.approvalId, 'retry', validate);
  } else {
    // This claim verifies the persisted credential against the confirmed original wire,
    // scope and approval. No new challenge, signer or settlement is involved.
    token = ledger.claimMppCredentialDelivery(record.approvalId, validate, options.replayCredential === true);
    request = { ...original, headers: { ...original.headers } };
  }
  if (!token) return;
  try {
    if (approved.kind === 'none') {
      const payment = ledger.savedMppPayment(record.approvalId);
      if (!payment) throw new Error('MPP_ORIGINAL_PAYMENT_REQUIRED');
      request.headers.Authorization = payment.credential;
    }
    const timeout = AbortSignal.timeout(15_000);
    const init = { method: 'GET', headers: request.headers, redirect: 'error' as const,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
    const response = request.access === 'https' ? await safeResourceFetch(request.url, init, options.fetcher)
      : await (options.fetcher ?? fetch)(request.url, init);
    const freshChallenge = /(?:^|,)\s*Payment(?:\s|,|$)/i.test(response.headers.get('www-authenticate') ?? '');
    if (approved.kind === 'none' && (freshChallenge || [401, 402, 403, 409].includes(response.status))) {
      // A new challenge or an already-used credential is a terminal merchant answer.
      ledger.rejectMppCredentialDelivery(record.approvalId, token);
      await response.body?.cancel().catch(() => {});
      return;
    }
    return await receiveMppDelivery(ledger, record, response, request.url, binary, 'retry', token);
  } catch { ledger.failDeliveryAttempt(record.approvalId, token); }
}
