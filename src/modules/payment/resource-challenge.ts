import type { PaymentRequirements } from '@x402/core/types';
import { X402ChallengeSchema, X402ResourceSchema, SolanaPublicKeySchema, type X402Challenge, type X402Resource } from '../resources/http-resource';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { validatePaymentEnvironment, type PaymentEnvironment } from './payment-environment';
import { readPaymentRequiredHeader } from './x402-client';
import { hash } from '../authority/authority-policy';
import { HttpResourceRequestSchema, type HttpResourceRequest } from '../resources/http-resource';
import { safeResourceFetch } from '../resources/safe-resource-fetch';
import { validateDeliveryCapability, type DeliveryRecoveryCapability } from '../resources/delivery-capability';
import { assertSupportedMainnetResourceRequest } from '../resources/supported-resource-request';
import { z } from 'zod';

/** Match the pinned pay-kit PaymentExtensions/PaymentIdentifierInfo types, while
 * retaining the original JSON for authorization and echo. Required identifiers
 * need durable outbound-ID support; this controlled profile cannot invent one. */
export function assertPayControlledExtensions(challenge: X402Challenge) {
  const extensions = challenge.extensions;
  if (extensions && Object.hasOwn(extensions, 'sign-in-with-x')) throw new Error('PAY_CONTROLLED_SIGN_IN_UNSUPPORTED');
  const raw = extensions?.['payment-identifier'];
  if (raw === undefined) return;
  const identifier = z.object({ info: z.object({ required: z.boolean().nullish(), id: z.string().nullish() })
    .passthrough().optional(), schema: z.json().optional() }).passthrough().safeParse(raw);
  if (!identifier.success) throw new Error('PAY_CONTROLLED_EXTENSIONS_INVALID');
  if (identifier.data.info?.required === true) throw new Error('PAY_CONTROLLED_REQUIRED_PAYMENT_IDENTIFIER_UNSUPPORTED');
  // The controller echoes immutable JSON. Admit only a shape the SDK's typed
  // echo would preserve, rather than silently normalize or discard fields.
  const { required, id } = identifier.data.info ?? {};
  const sdkEcho = { info: { ...(required == null ? {} : { required }), ...(id == null ? {} : { id }) },
    ...(identifier.data.schema == null ? {} : { schema: identifier.data.schema }) };
  if (hash(sdkEcho) !== hash(raw)) throw new Error('PAY_CONTROLLED_EXTENSIONS_INVALID');
}

export function resourcePaymentBinding(environment: PaymentEnvironment, buyer: string, request: HttpResourceRequest, challenge: X402Challenge, recovery?: DeliveryRecoveryCapability, header?: string) {
  // Execution permission belongs to the immutable ledger scope. Presentation or
  // switching to simulation must not prevent read-only recovery of a paid Devnet request.
  return hash(['x402-http-v1', environment.cluster, environment.genesisHash, environment.network,
    { network: environment.asset.network, mint: environment.asset.mint, tokenProgram: environment.asset.tokenProgram, decimals: environment.asset.decimals },
    SolanaPublicKeySchema.parse(buyer), HttpResourceRequestSchema.parse(request), X402ChallengeSchema.parse(challenge),
    ...(recovery ? [validateDeliveryCapability(recovery, request)] : []), ...(header ? [header] : [])]);
}

/** Optional quote memo follows the SDK's UTF-8 limit; absence lets the SDK generate it. */
export function validX402Memo(value: unknown) {
  return value === undefined || (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
    && new TextDecoder().decode(new TextEncoder().encode(value)) === value);
}

function validatedResource(declared: X402Resource, environment: PaymentEnvironment) {
  const { mode, cluster, genesisHash, rpcUrl, network, asset, isProduction, productionExecutionEnabled } = environment;
  const validated = validatePaymentEnvironment({ mode, cluster, genesisHash, rpcUrl, network, asset, isProduction, productionExecutionEnabled });
  const resource = X402ResourceSchema.parse(declared);
  if (validated.isProduction) assertSupportedMainnetResourceRequest(resource.request);
  if (resource.deliveryRecovery) validateDeliveryCapability(resource.deliveryRecovery, resource.request);
  if (resource.network !== validated.network || resource.mint !== validated.asset.mint || resource.decimals !== validated.asset.decimals
    || (validated.isProduction && resource.request.access !== 'https')) throw new Error('RESOURCE_ENVIRONMENT_MISMATCH');
  return { resource, validated };
}

export function validateResourceChallenge(raw: unknown, declared: X402Resource, environment: PaymentEnvironment): { challenge: X402Challenge; quote: PaymentRequirements } {
  const { resource, validated } = validatedResource(declared, environment);
  const challenge = X402ChallengeSchema.parse(raw);
  const challengeUrl = resource.request.access === 'test_loopback' && challenge.resource.url.startsWith('/') && !challenge.resource.url.startsWith('//')
    ? new URL(challenge.resource.url, resource.request.url).href : challenge.resource.url;
  // V2 resource.url may identify a route. The saved HTTP request is the exact
  // execution identity, including its query, body, method and approved headers.
  let matchesRequest = challengeUrl === resource.request.url;
  if (!matchesRequest) {
    try {
      const route = new URL(challengeUrl); const instance = new URL(resource.request.url);
      matchesRequest = route.origin === instance.origin && route.pathname === instance.pathname
        && !route.search && !route.hash && !route.username && !route.password;
    } catch { /* Reject malformed resource identifiers. */ }
  }
  if (!matchesRequest) throw new Error('INVALID_X402_QUOTE');
  const candidates = challenge.accepts.filter(item => item.scheme === 'exact' && item.network === validated.network && item.asset === validated.asset.mint
    && (item.extra.paymentFlow == null || item.extra.paymentFlow === 'authorization')
    && (item.extra.assetTransferMethod == null || item.extra.assetTransferMethod === 'default'));
  if (candidates.length !== 1) throw new Error('INVALID_X402_QUOTE');
  const quote = candidates[0];
  if (quote.scheme !== 'exact' || quote.network !== validated.network || quote.asset !== validated.asset.mint
    || !SolanaPublicKeySchema.safeParse(quote.payTo).success
    || (resource.recipient !== undefined && quote.payTo !== resource.recipient) || !PositiveAtomicAmountSchema.safeParse(quote.amount).success
    || (resource.amount !== undefined && quote.amount !== resource.amount)
    || (resource.maximumAmount !== undefined && BigInt(quote.amount) > BigInt(resource.maximumAmount))
    || !Number.isSafeInteger(quote.maxTimeoutSeconds) || quote.maxTimeoutSeconds <= 0 || quote.maxTimeoutSeconds > 600
    || !SolanaPublicKeySchema.safeParse(quote.extra.feePayer).success || !validX402Memo(quote.extra.memo)) throw new Error('INVALID_X402_QUOTE');
  // If discovery metadata declares an HTTP method, it cannot override this approved request.
  const bazaar = challenge.extensions?.bazaar;
  if (bazaar && typeof bazaar === 'object' && !Array.isArray(bazaar)) {
    const info = bazaar.info;
    const input = info && typeof info === 'object' && !Array.isArray(info) ? info.input : undefined;
    const method = input && typeof input === 'object' && !Array.isArray(input) ? input.method : undefined;
    if (method !== undefined && method !== resource.request.method) throw new Error('RESOURCE_METHOD_MISMATCH');
  }
  // Persist every merchant alternative as quote evidence. Signing must select
  // the separately authorized requirement without mutating this challenge.
  return { challenge, quote };
}

/** One fresh challenge for the exact approved request; no redirect or unsigned retry. */
export async function fetchResourceChallenge(resource: X402Resource, environment: PaymentEnvironment, fetcher?: typeof fetch) {
  const { resource: declared } = validatedResource(resource, environment);
  const { url, method, headers, body } = declared.request;
  const response = declared.request.access === 'https'
    ? await safeResourceFetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(10_000) }, fetcher)
    : await (fetcher ?? fetch)(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  try {
    if (response.status !== 402 || (response.url && response.url !== url)) throw new Error('INVALID_X402_QUOTE');
    const paymentRequiredHeader = response.headers.get('PAYMENT-REQUIRED') ?? '';
    const parsed = validateResourceChallenge(readPaymentRequiredHeader(paymentRequiredHeader), declared, environment);
    return { endpoint: url, request: declared.request, paymentRequiredHeader, ...parsed };
  } finally { await response.body?.cancel(); }
}
