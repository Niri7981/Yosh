/** LEGACY offer purchase adapter; the current Agent path uses request-paid-resource-purchase. */
import type { PaymentRequirements } from '@x402/core/types';
import { z } from 'zod';
import { address } from '@solana/kit';
import { executeApprovedPayment, paymentBinding, paymentEndpoint, recoverApprovedPayment } from './approved-payment';
import { LEGACY_MARKET_SNAPSHOT_OPERATION, SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import { assertPaymentConfigExecutionEnabled, DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from '../payment/payment-config';
import { readPaymentRequiredHeader } from '../payment/x402-client';
import { MarketOfferIdSchema, marketOffer, marketOfferResource } from '../resources/market-offers';
import { createMarketSnapshotSpendIntent } from '../resources/market-spend-adapter';
import { MarketSnapshotOutputSchema, type MarketSnapshotOutput } from '../resources/resource-schema';
import { PurchaseLedger, type DeliveryStatus, type PurchaseExecutionMode, type SpendReservation } from './purchase-ledger';
import type { ReceiptStatus, DeliveryRecoveryState } from './delivery-state';
import type { PurchaseStatus } from './purchase-state';
import { hash } from './spending-policy';
import { validX402Memo } from '../payment/resource-challenge';

export const PurchaseRequestInputSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  offerId: MarketOfferIdSchema,
  reason: z.string().trim().min(1).max(240),
}).strict();
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInputSchema>;

export type PurchaseRequestResult = {
  purchaseId: string;
  offerId: PurchaseRequestInput['offerId'];
  amount: string;
  display: string;
  status: PurchaseStatus;
  decision: SpendReservation['decision'];
  quote: { resourceId: string; providerId: string; network: string; assetId: string; assetDecimals: number; payTo: string; amount: string; expiresAt: number; fingerprint: string };
  grant: { id: string; version: number } | null;
  paymentStatus: 'NOT_STARTED' | 'PAYING' | 'PAYMENT_UNKNOWN' | 'PAID' | 'FAILED';
  executionMode: PurchaseExecutionMode;
  deliveryStatus: Exclude<DeliveryStatus, 'NOT_PAID'> | 'NOT_DELIVERED';
  receiptStatus: ReceiptStatus; deliveryRecovery: DeliveryRecoveryState;
  reused: boolean;
  resource?: MarketSnapshotOutput;
};

function result(record: SpendReservation, offerId: PurchaseRequestInput['offerId'], reused: boolean, executionMode: PurchaseExecutionMode): PurchaseRequestResult {
  const offer = marketOffer(offerId);
  const authority = record.intent.authority;
  if (!authority && (record.decision.decision !== 'DENIED' || record.decision.reason !== 'SPEND_GRANT_REQUIRED')) throw new Error('SPEND_GRANT_REQUIRED');
  const resource = record.status === 'PAID' && record.deliveryStatus === 'COMPLETE'
    ? MarketSnapshotOutputSchema.parse(record.data)
    : undefined;
  return { purchaseId: record.intent.idempotencyKey, offerId, amount: String(record.intent.amount), display: offer.display,
    status: record.status, decision: record.decision,
    quote: { resourceId: record.intent.resourceId, providerId: record.intent.providerId, network: record.intent.network, assetId: record.intent.assetId,
      assetDecimals: record.intent.assetDecimals, payTo: record.intent.payTo, amount: String(record.intent.amount), expiresAt: record.intent.expiresAt, fingerprint: record.intent.quoteFingerprint },
    grant: authority ? { id: authority.grantId, version: authority.grantVersion } : null, paymentStatus: record.status === 'PAID' ? 'PAID' : record.status === 'PAYING' ? 'PAYING' : record.status === 'PAYMENT_UNKNOWN' ? 'PAYMENT_UNKNOWN' : record.status === 'FAILED' ? 'FAILED' : 'NOT_STARTED',
    executionMode, deliveryStatus: record.deliveryStatus === 'NOT_PAID' ? 'NOT_DELIVERED' : record.deliveryStatus, reused,
    receiptStatus: record.receiptStatus, deliveryRecovery: record.deliveryRecovery,
    ...(resource ? { resource } : {}) };
}

/** Reserves the server quote once; execution consumes only the persisted approval. */
export async function requestMarketPurchase(raw: unknown, options: {
  config: PaymentConfig;
  ledger: PurchaseLedger;
  origin: string;
  principal: SpendPrincipal;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Explicit policy-only operation for disabled live execution and quote tests. */
  execute?: boolean;
  pay?: typeof executeApprovedPayment;
  recover?: typeof recoverApprovedPayment;
}): Promise<PurchaseRequestResult> {
  const input = PurchaseRequestInputSchema.parse(raw);
  const principal = SpendPrincipalSchema.parse(options.principal);
  options.ledger.assertCardMemberActive(principal.cardMemberId);
  const clock = options.now ?? Date.now;
  const requestStartedAt = clock();
  if (options.config.mode === 'live_mainnet') throw new Error('MAINNET_EXECUTION_DISABLED');
  if (options.execute === true) assertPaymentConfigExecutionEnabled(options.config);
  const executionMode: PurchaseExecutionMode = options.execute === false ? 'simulated' : options.config.mode;
  const requestHash = hash({ offerId: input.offerId, reason: input.reason });
  async function complete(record: SpendReservation, reused: boolean) {
    options.ledger.assertReplayAllowed(record, executionMode, options.ledger.paymentScope(options.config, executionMode));
    // A denied decision is answered exclusively from durable facts, before even
    // resolving the payment endpoint or touching preflight/claim/wallet code.
    if (record.decision.decision !== 'APPROVED' || executionMode === 'simulated') return result(record, input.offerId, reused, executionMode);
    const endpoint = paymentEndpoint(options.origin, record.intent.offerId);
    if (record.status === 'APPROVED') {
      try { await (options.pay ?? executeApprovedPayment)(options.ledger, record.approvalId, options.config, endpoint); }
      catch { /* Return the durable state; a duplicate never creates another claim. */ }
    } else if (['PAYING', 'PAYMENT_UNKNOWN'].includes(record.status) || record.deliveryStatus === 'PENDING') {
      await (options.recover ?? recoverApprovedPayment)(options.ledger, input.requestId, options.config, endpoint, undefined, principal.cardMemberId);
    }
    return result(options.ledger.get(input.requestId, principal.cardMemberId)!, input.offerId, reused, executionMode);
  }
  const existing = options.ledger.get(input.requestId, principal.cardMemberId);
  if (existing) {
    options.ledger.assertReplayAllowed(existing, executionMode, options.ledger.paymentScope(options.config, executionMode));
    if (existing.intent.requestHash !== requestHash || existing.intent.offerId !== input.offerId) throw new Error('REQUEST_ID_CONFLICT');
    return complete(existing, true);
  }
  const { config } = options;
  if (config.cluster !== 'devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT) throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
  const offer = marketOffer(input.offerId);
  const resourcePath = `/api/paid/market-snapshot?asset=SOL&offer=${input.offerId}`;
  const endpoint = new URL(paymentEndpoint(options.origin, input.offerId));
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('INVALID_PURCHASE_ORIGIN');
  const response = await (options.fetcher ?? fetch)(endpoint, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  let quote: PaymentRequirements;
  try {
    if (response.status !== 402) throw new Error('INVALID_X402_QUOTE');
    const required = readPaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED') ?? '');
    if (required.resource?.url !== resourcePath || required.accepts.length !== 1) throw new Error('INVALID_X402_QUOTE');
    quote = required.accepts[0];
    if (quote.scheme !== 'exact' || quote.network !== config.network || quote.asset !== config.mint || quote.payTo !== config.merchant ||
      quote.amount !== offer.amount || !validX402Memo(quote.extra?.memo) ||
      typeof quote.extra?.feePayer !== 'string' || quote.maxTimeoutSeconds <= 0 || quote.maxTimeoutSeconds > 300) throw new Error('INVALID_X402_QUOTE');
    address(quote.extra.feePayer);
  } finally { await response.body?.cancel(); }

  const now = clock();
  const authority = options.ledger.spendAuthorityForDecision(principal, LEGACY_MARKET_SNAPSHOT_OPERATION, now, executionMode);
  const resource = marketOfferResource({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: config.mint,
    network: config.network, allowed_pay_to: config.merchant }, input.offerId);
  const intent = createMarketSnapshotSpendIntent({ idempotencyKey: input.requestId, request: { asset: 'SOL' }, requestHash, resource, quote,
    executionBinding: paymentBinding(config, endpoint.href, quote), authority, offerId: input.offerId, reason: input.reason, now: requestStartedAt });
  // Another request can finish its quote while this one is in flight. Reuse its
  // immutable nonce/quote instead of comparing or replacing it with a new one.
  const winner = options.ledger.get(input.requestId, principal.cardMemberId);
  if (winner) {
    options.ledger.assertReplayAllowed(winner, executionMode, options.ledger.paymentScope(options.config, executionMode));
    if (winner.intent.requestHash !== requestHash || winner.intent.offerId !== input.offerId) throw new Error('REQUEST_ID_CONFLICT');
    return complete(winner, true);
  }
  const reserved = options.ledger.reserve(intent, quote, now, executionMode, principal.cardMemberId, options.ledger.paymentScope(options.config, executionMode));
  const reservedBinding = reserved.intent.authority;
  if (reserved.ownerCardMemberId !== principal.cardMemberId || (reservedBinding && reservedBinding.cardMemberId !== principal.cardMemberId)) {
    throw new Error('PURCHASE_REQUEST_OWNER_MISMATCH');
  }
  return complete(reserved, reserved.intent.id !== intent.id);
}
