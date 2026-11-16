import type { Trace } from '../demo/trace';
import type { PaymentConfig } from '../payment/payment-config';
import { createSignedPaymentIdentity } from '../payment/original-payment-evidence';
import { paymentSignatureHeaders, readSettlementResponse } from '../payment/x402-client';
import { validateDeliveryCapability } from '../resources/delivery-capability';
import { parsePaidResourceDelivery, PaidResourceIdSchema } from '../resources/paid-resources';
import { readBoundedResourceDelivery, readBoundedResourceJson, readMarketSnapshot } from '../resources/read-market-snapshot';
import type { HttpResourceRequest } from '../resources/http-resource';
import { safeResourceFetch } from '../resources/safe-resource-fetch';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import { assertX402Purchase } from './purchase-contract';

/** Receipt observation is independent of both chain accounting and delivered data. */
export function observeDeliveryReceipt(ledger: PurchaseLedger, record: PurchaseRecord, response: Response, config: PaymentConfig) {
  if (!response.headers.has('PAYMENT-RESPONSE')) { ledger.recordReceipt(record.approvalId, 'UNAVAILABLE'); return 'UNAVAILABLE'; }
  try {
    const receipt = readSettlementResponse(response);
    const payer = record.paymentEvidence && record.paymentEvidence.version !== 1 ? record.paymentEvidence.payer : config.buyer;
    if (receipt.network !== record.intent.network || (receipt.payer !== undefined && receipt.payer !== payer)
      || (receipt.amount !== undefined && receipt.amount !== record.intent.amount)
      || (record.transaction && receipt.transaction !== record.transaction)) throw new Error('Receipt mismatch');
    const outcome = !receipt.success ? 'FAILED' : record.status === 'PAID' ? 'CONFIRMED' : 'UNVERIFIED';
    ledger.recordReceipt(record.approvalId, outcome, receipt);
    return outcome;
  } catch { ledger.recordReceipt(record.approvalId, 'INVALID'); return 'INVALID'; }
}

async function consumeDelivery(ledger: PurchaseLedger, record: PurchaseRecord, response: Response, config: PaymentConfig,
  expectedUrl: string, token: string, trace: Trace) {
  try {
    const receipt = observeDeliveryReceipt(ledger, record, response, config);
    if (![200, 201].includes(response.status) || (response.url && response.url !== expectedUrl)) throw new Error('DELIVERY_RESPONSE_UNAVAILABLE');
    // Chain proof already established PAID. Missing receipts do not prevent a
    // valid resource delivery; a contradictory/malformed receipt is rejected.
    if (receipt === 'INVALID' || receipt === 'FAILED') throw new Error('DELIVERY_RECEIPT_INVALID');
    const data = record.intent.resourcePath
      ? parsePaidResourceDelivery(PaidResourceIdSchema.parse(record.intent.resourceId), await readBoundedResourceJson(response))
      : record.intent.httpRequest ? await readBoundedResourceDelivery(response, record.intent.deliveryPolicy) : await readMarketSnapshot(response);
    ledger.finish(record.approvalId, { transaction: record.transaction!, data }, undefined, token);
    trace('DATA_VALIDATED');
    return { transaction: record.transaction!, data };
  } finally { await response.body?.cancel().catch(() => {}); }
}

export async function receiveOriginalDelivery(ledger: PurchaseLedger, record: PurchaseRecord, response: Response, config: PaymentConfig, endpoint: string, trace: Trace) {
  const token = ledger.claimDelivery(record.approvalId, 'initial');
  if (!token) { await response.body?.cancel().catch(() => {}); return; }
  try { return await consumeDelivery(ledger, record, response, config, endpoint, token, trace); }
  catch { ledger.failDeliveryAttempt(record.approvalId, token, 'DELIVERY_RESPONSE_INVALID'); throw new Error('DELIVERY_PENDING_OR_TERMINAL'); }
}

/** Delivery-only transport: imports no wallet, signer, payment constructor or
 * settlement API. It can only replay the saved bytes or query a declared cache. */
export async function recoverPaidDelivery(ledger: PurchaseLedger, record: PurchaseRecord, config: PaymentConfig, endpoint: string,
  validate: (record: PurchaseRecord) => void, trace: Trace = () => {}, fetcher?: typeof fetch) {
  assertX402Purchase(record);
  if (record.status !== 'PAID' || !['live_devnet', 'live_mainnet'].includes(record.executionMode) || record.deliveryStatus !== 'PENDING') return;
  const capability = ledger.deliveryCapability(record.approvalId);
  if (capability.kind === 'none') { ledger.blockDeliveryRecovery(record.approvalId, 'DELIVERY_RECOVERY_UNSUPPORTED'); return; }
  let request: HttpResourceRequest;
  let headers: Record<string, string>;
  try {
    validate(record);
    const original = record.intent.httpRequest ?? { url: endpoint, method: 'GET', access: 'test_loopback', headers: {} };
    const approved = validateDeliveryCapability(capability, original);
    request = { ...original };
    headers = { ...original.headers };
    if (approved.kind === 'payment_identifier') {
      request = { ...approved.request };
      headers = { ...request.headers };
      const identifier = approved.identifier === 'transaction' ? record.transaction! : record.intent.id;
      if (approved.location === 'header') headers[approved.name] = identifier;
      else {
        const url = new URL(request.url);
        if (url.searchParams.has(approved.name)) throw new Error('Duplicate recovery identifier');
        url.searchParams.set(approved.name, identifier); request.url = url.href;
      }
    } else {
      const payload = ledger.savedPayload(record.approvalId);
      if (!payload) throw new Error('Missing original credential');
      createSignedPaymentIdentity(payload, { ...config, merchant: record.intent.payTo }, { payer: config.buyer,
        recipient: record.intent.payTo, mint: record.intent.assetId, amount: record.intent.amount, decimals: record.intent.assetDecimals,
        ...(typeof record.quote.extra?.feePayer === 'string' ? { feePayer: record.quote.extra.feePayer } : {}) });
      Object.assign(headers, paymentSignatureHeaders(payload));
      if (approved.kind === 'cached_replay') headers[approved.replayHeader.name] = approved.replayHeader.value;
    }
  } catch { ledger.blockDeliveryRecovery(record.approvalId, 'DELIVERY_RECOVERY_BINDING_INVALID'); return; }
  const token = ledger.claimDelivery(record.approvalId, 'retry', validate);
  if (!token) return;
  try {
    const init = { method: request.method, headers,
      ...(request.body === undefined ? {} : { body: request.body }), signal: AbortSignal.timeout(55_000), redirect: 'error' as const };
    const response = request.access === 'https' ? await safeResourceFetch(request.url, init, fetcher) : await (fetcher ?? fetch)(request.url, init);
    return await consumeDelivery(ledger, record, response, config, request.url, token, trace);
  } catch { ledger.failDeliveryAttempt(record.approvalId, token); }
}
