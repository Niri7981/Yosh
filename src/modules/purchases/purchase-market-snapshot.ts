import type { PaymentRequirements } from '@x402/core/types';
import type { Trace } from '../demo/trace';
import { demoSnapshot } from '../paid-market-api/paid-market-api';
import { assertPaymentConfigExecutionEnabled, DEVNET_NETWORK, DEVNET_USDC_MINT, PAYMENT_AMOUNT, type PaymentConfig } from '../payment/payment-config';
import { runPaymentPreflight } from '../payment/payment-preflight';
import { selectPaymentQuote } from '../payment/solana-payment';
import { createStaticResourceRegistry } from '../resources/static-resource-registry';
import { createMarketSnapshotSpendIntent } from '../resources/market-spend-adapter';
import { executeApprovedPayment, paymentBinding, paymentEndpoint, recoverApprovedPayment } from './approved-payment';
import { PurchaseLedger, type PurchaseExecutionMode, type PurchaseRecord } from './purchase-ledger';
import { hash } from './spending-policy';
import type { SpendAuthorityBinding } from '../authority/spend-grant';

export type MarketSnapshotPurchaseMode = PurchaseExecutionMode;
export type MarketSnapshotPurchaseOptions = {
  config: PaymentConfig;
  ledger: PurchaseLedger;
  origin: string;
  mode: MarketSnapshotPurchaseMode;
  preflight?: typeof runPaymentPreflight;
  pay?: typeof executeApprovedPayment;
  trace?: Trace;
  now?: () => number;
  legacyBindings?: string[];
  authority?: SpendAuthorityBinding;
  ownerCardMemberId?: string;
};

export type MarketSnapshotPurchaseResult = {
  record: PurchaseRecord;
  reused: boolean;
  simulated: boolean;
};

/** Shared App/MCP-facing purchase entry. It owns no model planning or UI behavior. */
export async function purchaseMarketSnapshot(
  input: { purchaseId: string; intent: string },
  options: MarketSnapshotPurchaseOptions,
): Promise<MarketSnapshotPurchaseResult> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.purchaseId) || !input.intent.trim()) throw new Error('Invalid purchase request');
  const { config, ledger } = options;
  if (options.mode === 'live_mainnet' || config.mode === 'live_mainnet') throw new Error('MAINNET_EXECUTION_DISABLED');
  if (options.mode !== 'simulated') assertPaymentConfigExecutionEnabled(config);
  if (config.cluster !== 'devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT) {
    throw new Error('Purchase service only supports Circle USDC on Devnet');
  }
  const trace = options.trace ?? (() => {});
  const endpoint = paymentEndpoint(options.origin);
  const binding = paymentBinding(config, endpoint);
  const ownerCardMemberId = options.ownerCardMemberId ?? options.authority?.cardMemberId;
  const savedRecord = () => ownerCardMemberId ? ledger.getOwned(input.purchaseId, ownerCardMemberId) : ledger.getLegacy(input.purchaseId);
  const existing = savedRecord();
  if (existing) {
    ledger.assertReplayAllowed(existing, options.mode, ledger.paymentScope(config, options.mode));
    const acceptedBindings = [binding, ...(options.legacyBindings ?? [])];
    if (existing.intent.requestHash !== hash(input.intent) || !acceptedBindings.includes(existing.intent.executionBinding)) {
      throw new Error('Purchase ID already belongs to different input or configuration');
    }
    if (options.mode === 'live_devnet') await recoverApprovedPayment(ledger, input.purchaseId, config, endpoint, trace, ownerCardMemberId);
    const saved = savedRecord()!;
    return { record: saved, reused: true, simulated: saved.executionMode === 'simulated' };
  }
  const resources = createStaticResourceRegistry({
    endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot',
    asset_id: config.mint,
    network: config.network,
    allowed_pay_to: config.merchant,
  });
  let quote: PaymentRequirements;
  if (options.mode === 'live_devnet') {
    trace('PREFLIGHT');
    const preflight = await (options.preflight ?? runPaymentPreflight)(config);
    trace('QUOTE_REQUESTED');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (response.status !== 402 || !header) throw new Error('Expected a valid x402 quote');
    quote = selectPaymentQuote(header, config, preflight.facilitator.feePayer);
  } else {
    quote = {
      scheme: 'exact', network: config.network, asset: config.mint, amount: PAYMENT_AMOUNT,
      payTo: config.merchant, maxTimeoutSeconds: 300,
      extra: { feePayer: config.buyer, memo: `app-test:${input.purchaseId}` },
    };
  }
  trace('QUOTE_RECEIVED', '0.01 测试 USDC · Solana Devnet');
  const now = options.now?.() ?? Date.now();
  const spendIntent = createMarketSnapshotSpendIntent({
    idempotencyKey: input.purchaseId,
    request: { asset: 'SOL' },
    requestHash: hash(input.intent),
    resource: resources[0],
    quote,
    executionBinding: binding,
    now,
    authority: options.authority,
  });
  const reserved = ledger.reserve(spendIntent, quote, now, options.mode, ownerCardMemberId, ledger.paymentScope(config, options.mode));
  trace(reserved.status === 'APPROVED' ? 'POLICY_APPROVED' : 'POLICY_STOPPED', reserved.decision.reason);
  if (reserved.intent.id !== spendIntent.id || reserved.status !== 'APPROVED') {
    return { record: reserved, reused: reserved.intent.id !== spendIntent.id, simulated: options.mode === 'simulated' };
  }

  if (options.mode === 'simulated') {
    ledger.claim(reserved.approvalId, now);
    ledger.finish(reserved.approvalId, { transaction: `simulated-${input.purchaseId}`, data: demoSnapshot }, now);
  } else {
    try { await (options.pay ?? executeApprovedPayment)(ledger, reserved.approvalId, config, endpoint, trace); }
    catch {
      trace('PAYMENT_PAUSED');
      await recoverApprovedPayment(ledger, input.purchaseId, config, endpoint, trace, ownerCardMemberId);
    }
  }
  return { record: savedRecord()!, reused: false, simulated: options.mode === 'simulated' };
}
