import type { SpendIntent } from '../authority/spend-intent';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../payment/payment-environment';
import { PAID_RESOURCE_SCOPE_ID, PaidResourceIdSchema, paidResource } from '../resources/paid-resources';

// Account sharing requires a trusted data contract. Even an opted-in service's
// recognizable credential envelope is withheld in full rather than redacted into different bytes.
const credentialField = /^(?:authorization|proxyauthorization|cookie|setcookie|(?:x)?apikey|accesstoken|refreshtoken|idtoken|clientsecret|password|privatekey|secretkey|seedphrase|paymentcredential|paymentsignature|xpayment)$/i;
function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') return /(?:^|\s)Bearer [A-Za-z0-9._~+/=-]+|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => credentialField.test(key.replace(/[-_]/g, '')) || containsCredential(child));
}

/** Only first-party test products have an unambiguous historical public-output contract.
 * An external resource with the same label or today's registration never opts in an old order. */
export function canShareSavedResult(intent: SpendIntent, data: unknown) {
  if (intent.resultAudience !== undefined) return intent.resultAudience === 'account' && !containsCredential(data);
  if (intent.resourceScopeId !== PAID_RESOURCE_SCOPE_ID || intent.httpRequest?.access !== 'test_loopback' || intent.httpRequest.method !== 'GET'
    || intent.network !== DEVNET_NETWORK || intent.assetId !== DEVNET_USDC_MINT) return false;
  const id = PaidResourceIdSchema.safeParse(intent.resourceId);
  if (!id.success) return false;
  const descriptor = paidResource(id.data);
  const url = new URL(intent.httpRequest.url);
  return intent.providerId === descriptor.providerId && intent.resourcePath === descriptor.path
    && url.pathname + url.search === descriptor.path && descriptor.output.safeParse(data).success && !containsCredential(data);
}
