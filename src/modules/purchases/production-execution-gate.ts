import { assertGrantPostScope } from '../resources/post-request-authorization';
import { assertPaymentConfigExecutionEnabled, type PaymentConfig } from '../payment/payment-config';
import { resourcePaymentBinding, validateResourceChallenge } from '../payment/resource-challenge';
import { X402ResourceSchema, assertAuthorizedRequestInstance } from '../resources/http-resource';
import { hash } from '../authority/authority-policy';
import { monetaryScopeId } from './monetary-scope';
import type { PurchaseLedger, PurchaseRecord } from './purchase-ledger';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../authority/spend-grant';
import { assertSupportedMainnetResourceRequest } from '../resources/supported-resource-request';

/** Policy gate only. Wire format and transaction construction stay in the official SDK. */
export function assertProductionPaymentGate(ledger: PurchaseLedger, record: PurchaseRecord, config: PaymentConfig, endpoint: string) {
  assertPaymentConfigExecutionEnabled(config);
  if (config.mode !== 'live_mainnet') return;
  if (record.executionMode !== 'live_mainnet'
    || monetaryScopeId(record.monetaryScope) !== monetaryScopeId(ledger.paymentScope(config, 'live_mainnet'))) {
    throw new Error('MONETARY_SCOPE_MISMATCH');
  }
  const intent = record.intent;
  if (!intent.authority || intent.authority.operation !== PAID_RESOURCE_PURCHASE_OPERATION
    || intent.resourcePath || intent.offerId || intent.resourceScopeId || !intent.httpRequest || !intent.x402Challenge) {
    throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  }
  const resource = config.registeredResources?.find(candidate => candidate.resourceId === intent.resourceId);
  if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
  const declared = X402ResourceSchema.parse(resource);
  assertSupportedMainnetResourceRequest(declared.request, true);
  assertSupportedMainnetResourceRequest(intent.httpRequest);
  if (declared.request.access !== 'https' || endpoint !== intent.httpRequest.url || declared.providerId !== intent.providerId
    || hash(declared.deliveryRecovery ?? { kind: 'none' }) !== hash(intent.deliveryRecovery ?? { kind: 'none' })
    || (intent.deliveryPolicy !== undefined && hash(declared.deliveryPolicy ?? null) !== hash(intent.deliveryPolicy))
    || intent.payTo === config.buyer || (declared.recipient !== undefined && declared.recipient !== intent.payTo) || intent.assetDecimals !== config.asset.decimals) {
    throw new Error('MAINNET_RESOURCE_BINDING_MISMATCH');
  }
  assertAuthorizedRequestInstance(declared, intent.httpRequest);
  const grant = ledger.spendGrantById(intent.authority.grantId);
  assertGrantPostScope(declared, grant);
  if (declared.request.method === 'POST' && grant?.id !== intent.authority.grantId) throw new Error('SPEND_GRANT_INACTIVE');
  const instance = { ...declared, request: intent.httpRequest };
  const { quote } = validateResourceChallenge(intent.x402Challenge, instance, config);
  if (hash(quote) !== hash(record.quote) || quote.amount !== intent.amount || quote.asset !== intent.assetId || quote.network !== intent.network
    || hash(quote) !== intent.quoteFingerprint || intent.paymentScheme !== quote.scheme
    || intent.executionBinding !== resourcePaymentBinding(config, config.buyer, intent.httpRequest, intent.x402Challenge, declared.deliveryRecovery, intent.paymentRequiredHeader)
    || quote.extra?.feePayer === config.buyer) throw new Error('MAINNET_PAYMENT_BINDING_MISMATCH');
}
