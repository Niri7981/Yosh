import type { PaymentConfig } from '../payment/payment-config';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import { reconcileApprovedPayment } from './approved-payment';
import { checkMppPaymentBinding, isMppExecutionActive, receiveMppDelivery } from './approved-mpp-charge';
import { validateDeliveryCapability } from '../resources/delivery-capability';
import { safeResourceFetch } from '../resources/safe-resource-fetch';

/** Recovery imports no signer or credential encoder. It only queries the exact
 * saved transaction and, after PAID, a merchant-declared read-only identifier API. */
export async function recoverMppCharge(ledger: PurchaseLedger, initial: PurchaseRecord, config: PaymentConfig, endpoint: string,
  options: { binary?: string; fetcher?: typeof fetch; automatic?: boolean; signal?: AbortSignal } = {}) {
  ledger.assertReplayAllowed(initial, config.mode, ledger.paymentScope(config, config.mode));
  checkMppPaymentBinding(initial, config, endpoint, false);
  if (isMppExecutionActive(ledger, initial.approvalId)) return;
  if (['PAYING', 'PAYMENT_UNKNOWN'].includes(initial.status))
    await reconcileApprovedPayment(ledger, initial.intent.idempotencyKey, config, undefined, initial.ownerCardMemberId, options);
  const record = ledger.getOwned(initial.intent.idempotencyKey, initial.ownerCardMemberId!)!;
  if (record.status !== 'PAID' || record.deliveryStatus !== 'PENDING') return;
  const approved = validateDeliveryCapability(ledger.deliveryCapability(record.approvalId), record.intent.httpRequest!);
  if (approved.kind !== 'payment_identifier') { ledger.blockDeliveryRecovery(record.approvalId, 'DELIVERY_RECOVERY_UNSUPPORTED'); return; }
  const binary = options.binary ?? process.env.YOSH_MPP_PROTOCOL_ENGINE;
  if (!binary) return; // No protocol adapter available; retain the paid delivery for a later safe retry.
  const request = { ...approved.request, headers: { ...approved.request.headers } };
  const identifier = approved.identifier === 'transaction' ? record.transaction! : record.intent.id;
  const headers: Record<string, string> = { ...request.headers };
  if (approved.location === 'header') headers[approved.name] = identifier;
  else {
    const url = new URL(request.url);
    if (url.searchParams.has(approved.name)) throw new Error('MPP_RECOVERY_IDENTIFIER_CONFLICT');
    url.searchParams.set(approved.name, identifier); request.url = url.href;
  }
  options.signal?.throwIfAborted();
  const token = ledger.claimDelivery(record.approvalId, 'retry', current => checkMppPaymentBinding(current, config, endpoint, false));
  if (!token) return;
  try {
    const init = { method: 'GET', headers, redirect: 'error' as const,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) };
    const response = request.access === 'https' ? await safeResourceFetch(request.url, init, options.fetcher)
      : await (options.fetcher ?? fetch)(request.url, init);
    return await receiveMppDelivery(ledger, record, response, request.url, binary, 'retry', token);
  } catch { ledger.failDeliveryAttempt(record.approvalId, token); }
}
