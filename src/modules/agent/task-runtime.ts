import type { Trace } from '../demo/trace';
import { MarketSnapshotOutputSchema, type MarketSnapshotOutput } from '../resources/resource-schema';
import { z } from 'zod';
import type { CapabilityPlanner } from './capability-plan';
import { runDiscovery, type PlannerMode } from './discovery-runtime';
import { createStaticResourceRegistry } from '../resources/static-resource-registry';
import type { PaymentConfig } from '../payment/payment-config';
import { runPaymentPreflight } from '../payment/payment-preflight';
import { PurchaseLedger, type PurchaseRecord } from '../purchases/purchase-ledger';
import { executeApprovedPayment } from '../purchases/approved-payment';
import { purchaseMarketSnapshot } from '../purchases/purchase-market-snapshot';

const TaskSchema = z.object({ taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), task: z.string().trim().min(1).max(1000) }).strict();
function publicResult(record: PurchaseRecord, ledger: PurchaseLedger) {
  const snapshot = record.data ? MarketSnapshotOutputSchema.parse(record.data) : undefined;
  return { taskId: record.intent.idempotencyKey, status: record.status, deliveryStatus: record.deliveryStatus, policy: record.decision, amountUSDC: Number(record.intent.amount) / 1_000_000,
    transaction: record.transaction, data: snapshot, answer: record.answer, events: ledger.eventsForLegacy(record.intent.idempotencyKey),
    summary: snapshot ? `示例快照（${snapshot.as_of}）：SOL 价格 $${snapshot.spot_price_usd}，24 小时变化 ${snapshot.change_24h_pct}%，RSI ${snapshot.rsi_14d}。数据来自 Demo fixture，不是实时行情。` : undefined };
}
export async function runTask(input: { taskId: string; task: string }, options: {
  planner: CapabilityPlanner; plannerMode: PlannerMode; config: PaymentConfig; ledger: PurchaseLedger; origin: string;
  // Trusted composition dependencies for integration tests, never model/tool inputs.
  preflight?: typeof runPaymentPreflight; pay?: typeof executeApprovedPayment;
  answer?: (task: string, data: MarketSnapshotOutput) => Promise<string>;
  trace?: Trace;
}) {
  const { taskId, task } = TaskSchema.parse(input);
  const { config, ledger } = options;
  const trace: Trace = options.trace ?? (() => {});
  async function result(record: PurchaseRecord) {
    if (['PAYING', 'PAYMENT_UNKNOWN'].includes(record.status)) trace('PAYMENT_UNKNOWN', '保留原任务，只读查询原交易；禁止重新付款');
    if (record.status === 'FAILED') trace('PAYMENT_FAILED', '原任务保留失败证据，不会自动重新购买');
    let answerStatus = record.answer ? 'COMPLETE' : 'NOT_REQUESTED';
    if (record.status === 'PAID' && record.data && !record.answer && options.answer) {
      try {
        trace('ANALYSIS_STARTED');
        const answer = await options.answer(task, MarketSnapshotOutputSchema.parse(record.data));
        ledger.saveAnswer(taskId, answer);
        answerStatus = 'COMPLETE';
        trace('COMPLETED');
      } catch { answerStatus = 'FAILED'; trace('ANALYSIS_FAILED'); }
    }
    return { ...publicResult(ledger.getLegacy(taskId) ?? record, ledger), answerStatus };
  }
  const existing = ledger.getLegacy(taskId);
  if (existing) {
    if (existing.deliveryStatus === 'COMPLETE') trace('CACHE_HIT', '复用已购买的数据，本次新增付款 0 USDC');
    const purchase = await purchaseMarketSnapshot({ purchaseId: taskId, intent: task }, {
      config, ledger, origin: options.origin, mode: 'live_devnet', preflight: options.preflight, pay: options.pay, trace,
    });
    return { ...await result(purchase.record), reused: true };
  }
  // Registry endpoint is a logical HTTPS identity. Only the fixed local endpoint
  // above is routable in this desktop demo; no URL ever comes from the model.
  const resources = createStaticResourceRegistry({ endpoint: 'https://purchase.local.invalid/api/paid/market-snapshot', asset_id: config.mint, network: config.network, allowed_pay_to: config.merchant });
  trace('PLANNING');
  const discovery = await runDiscovery({ task, planner: options.planner, plannerMode: options.plannerMode, resources });
  if (discovery.discovery?.status !== 'found' || !discovery.discovery.resource) { trace('NO_PURCHASE', '未找到受支持的付费资源，未签名或付款'); return { taskId, status: 'NO_PURCHASE', discovery }; }
  trace('RESOURCE_FOUND', 'Premium SOL Market Snapshot');
  const purchase = await purchaseMarketSnapshot({ purchaseId: taskId, intent: task }, {
    config, ledger, origin: options.origin, mode: 'live_devnet', preflight: options.preflight, pay: options.pay, trace,
  });
  return { ...await result(purchase.record), discovery };
}
