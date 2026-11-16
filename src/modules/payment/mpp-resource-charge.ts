import { z } from 'zod';
import { MppChargeQuoteSchema, type MppChargeQuote } from './mpp-contract';
import { parseMppChallenge } from './mpp-protocol-engine';
import { type PaymentConfig, assertPaymentConfigExecutionEnabled } from './payment-config';
import { HttpResourceRequestSchema, X402ResourceSchema, type HttpResourceRequest, type X402Resource } from '../resources/http-resource';
import { safeResourceFetch } from '../resources/safe-resource-fetch';
import { hash } from '../purchases/spending-policy';

/** Explicit registration is protocol consent, not permission to spend. */
export function assertMppResource(raw: X402Resource, config: PaymentConfig) {
  const resource = X402ResourceSchema.parse(raw);
  if (resource.paymentProtocol !== 'mpp_solana_charge' || resource.request.method !== 'GET'
    || resource.request.body !== undefined || resource.network !== config.network || resource.mint !== config.mint
    || resource.decimals !== config.asset.decimals || (config.isProduction && resource.request.access !== 'https'))
    throw new Error('MPP_RESOURCE_UNSUPPORTED');
  // Payment credentials are single-use. The first slice supports an explicitly
  // declared read-only recovery endpoint, never an inferred paid-request replay.
  if (resource.deliveryRecovery && !['none', 'payment_identifier'].includes(resource.deliveryRecovery.kind))
    throw new Error('MPP_DELIVERY_REPLAY_UNSUPPORTED');
  return resource;
}

export function validateMppQuote(raw: unknown, resource: X402Resource, config: PaymentConfig, now = Date.now()) {
  const quote = MppChargeQuoteSchema.parse(raw);
  assertMppResource(resource, config);
  if (quote.network !== config.network || quote.asset !== config.mint || quote.payTo === config.buyer
    || (resource.recipient !== undefined && resource.recipient !== quote.payTo)
    || (resource.amount !== undefined && resource.amount !== quote.amount)
    || (resource.maximumAmount !== undefined && BigInt(quote.amount) > BigInt(resource.maximumAmount))
    || quote.expiresAt <= now || quote.expiresAt > now + 600_000) throw new Error('MPP_QUOTE_BINDING_INVALID');
  return quote;
}

export async function fetchMppResourceQuote(resource: X402Resource, config: PaymentConfig, binary: string,
  fetcher: typeof fetch = fetch, now = Date.now()) {
  assertMppResource(resource, config);
  const request = HttpResourceRequestSchema.parse(resource.request);
  const init = { method: request.method, headers: request.headers, redirect: 'error' as const, signal: AbortSignal.timeout(15_000) };
  const response = request.access === 'https' ? await safeResourceFetch(request.url, init, fetcher) : await fetcher(request.url, init);
  try {
    if (response.status !== 402 || (response.url && response.url !== request.url)) throw new Error('MPP_CHALLENGE_REQUIRED');
    const header = z.string().min(1).max(16_384).parse(response.headers.get('www-authenticate'));
    const selected = await parseMppChallenge(binary, header);
    return validateMppQuote({ protocol: 'mpp', method: 'solana', intent: 'charge', scheme: 'mpp_charge',
      network: config.network, asset: selected.request.currency, payTo: selected.request.recipient,
      amount: selected.request.amount, challenge: selected.challenge, challengeHeader: header, expiresAt: selected.expiresAt }, resource, config, now);
  } finally { await response.body?.cancel().catch(() => {}); }
}

export function mppPaymentBinding(config: PaymentConfig, request: HttpResourceRequest, quote: MppChargeQuote,
  deliveryRecovery: unknown = { kind: 'none' }, deliveryPolicy?: unknown) {
  return hash(['mpp-solana-charge-v1', config.network, config.genesisHash, config.buyer, config.asset,
    HttpResourceRequestSchema.parse(request), MppChargeQuoteSchema.parse(quote), deliveryRecovery, deliveryPolicy ?? null]);
}

export function assertMppExecutionEnabled(config: PaymentConfig) {
  assertPaymentConfigExecutionEnabled(config);
  if (!['live_devnet', 'live_mainnet'].includes(config.mode)) throw new Error('MPP_EXECUTION_MODE_UNSUPPORTED');
}
