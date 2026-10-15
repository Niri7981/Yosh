import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadPaymentConfig } from '../src/modules/payment/payment-config';
import { runPaymentPreflight } from '../src/modules/payment/payment-preflight';
import { runTask } from '../src/modules/agent/task-runtime';
import { openAICapabilityPlanner } from '../src/modules/agent/openai-capability-planner';
import { openAIMarketAnswer } from '../src/modules/agent/openai-market-answer';
import { PurchaseLedger } from '../src/modules/purchases/purchase-ledger';
import { executeApprovedPayment, recoverApprovedPayment, paymentEndpoint } from '../src/modules/purchases/approved-payment';
import { spendingDay } from '../src/modules/purchases/spending-policy';
import { createPaidMarketApi } from '../src/modules/paid-market-api/paid-market-api';
import { SettlementStore } from '../src/modules/paid-market-api/settlement-store';
import { transactionMessageHash } from '../src/modules/payment/reconcile-transaction';
import { createHash } from 'node:crypto';
import { paymentSignatureHeaders } from '../src/modules/payment/x402-client';

let stage = 'preflight';
async function main() {
  assert(process.env.OPENAI_API_KEY, 'A real model is required');
  const config = loadPaymentConfig();
  assert.equal(config.cluster, 'devnet');
  const origin = process.env.DAY4_API_ORIGIN || 'http://127.0.0.1:3000';
  const before = await runPaymentPreflight(config);
  assert(BigInt(before.buyer.balanceBaseUnits) >= 50_000n, 'Five runs require 0.05 test USDC');
  const task = '根据价格、成交量和 RSI 分析 SOL 市场情况';
  const date = spendingDay(Date.now());
  const [batch = '', ...extra] = process.argv.slice(2);
  assert(/^[a-zA-Z0-9_-]{0,32}$/.test(batch) && extra.length === 0, 'Invalid batch label');
  const prefix = `day6-devnet-${date}${batch ? '-' + batch : ''}`;
  mkdirSync('.data/day6', { recursive: true, mode: 0o700 });
  const ledger = new PurchaseLedger();
  const results: unknown[] = [];
  try {
    for (let i = 1; i <= 5; i++) {
      const taskId = `${prefix}-${i}`;
      const options = { config, origin, ledger,
        planner: { plan: async (input: string) => { stage = `run-${i}:planner`; return openAICapabilityPlanner.plan(input); } },
        preflight: async (c: typeof config) => { stage = `run-${i}:preflight`; return runPaymentPreflight(c); },
        pay: async (...args: Parameters<typeof executeApprovedPayment>) => { stage = `run-${i}:payment`; return executeApprovedPayment(...args); },
        plannerMode: 'openai_agent' as const,
        answer: async (...args: Parameters<typeof openAIMarketAnswer>) => { stage = `run-${i}:answer`; return openAIMarketAnswer(...args); } };
      const result = await runTask({ taskId, task }, options);
      const resultPath = `.data/day6/${taskId}.json`;
      // Keep the original discovery trace when verifying an already-complete task.
      if (!existsSync(resultPath) || !('reused' in result)) writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
      assert.equal(result.status, 'PAID', `Run ${i} payment did not complete; retry this same task`);
      assert('answerStatus' in result && result.answerStatus === 'COMPLETE', `Run ${i} analysis did not complete; retry this same task`);
      assert('transaction' in result && result.transaction);
      // Retry through a separate SQLite connection, with all external dependencies forbidden.
      const reopened = new PurchaseLedger();
      try {
        const forbidden = async (): Promise<never> => { throw new Error('Cached retry touched an external dependency'); };
        const cached = await runTask({ taskId, task }, { ...options, ledger: reopened, planner: { plan: forbidden }, preflight: forbidden, pay: forbidden, answer: forbidden });
        assert('answer' in cached && cached.answer === result.answer);
        assert('transaction' in cached && cached.transaction === result.transaction);
        assert.deepEqual('events' in cached && cached.events, result.events);
      } finally { reopened.close(); }
      results.push({ taskId, transaction: result.transaction, fresh: !('reused' in result), retryPassed: true });
      console.log(JSON.stringify({ run: i, taskId, status: 'PAID', answerStatus: 'COMPLETE', fresh: !('reused' in result), retryPassed: true, transaction: result.transaction }));
    }
    const first = ledger.getLegacy(`${prefix}-1`)!;
    const payload = ledger.savedPayload(first.approvalId)!;
    assert(payload);
    // Reconstruct a crashed client in an isolated in-memory ledger. Original production
    // records stay intact. Recovery talks to the live API using the exact original payload.
    const shadow = new PurchaseLedger(':memory:');
    try {
      const reserved = shadow.reserve(first.intent, first.quote, first.intent.createdAt, first.executionMode);
      shadow.claim(reserved.approvalId, first.intent.createdAt); shadow.savePayload(reserved.approvalId, payload); shadow.unknown(reserved.approvalId);
      await recoverApprovedPayment(shadow, first.intent.idempotencyKey, config, paymentEndpoint(origin));
      assert.equal(shadow.getLegacy(first.intent.idempotencyKey)?.status, 'PAID');
      assert.equal(shadow.getLegacy(first.intent.idempotencyKey)?.transaction, first.transaction);
    } finally { shadow.close(); }
    // Reconstruct a server that lost the settlement receipt. No facilitator method may
    // run. It must find the original transaction on the real chain by the unique memo.
    const store = new SettlementStore(':memory:');
    try {
      const wire = String(payload.payload.transaction);
      const messageHash = transactionMessageHash(wire);
      const memo = String(first.quote.extra?.memo);
      store.saveQuote({ id: memo, resource: '/api/paid/market-snapshot?asset=SOL', requirements: first.quote, expiresAt: first.intent.expiresAt });
      store.claim(messageHash, memo, createHash('sha256').update(Buffer.from(wire, 'base64')).digest('hex'), JSON.stringify(first.data));
      const forbidden = async (): Promise<never> => { throw new Error('Recovery tried to contact facilitator'); };
      const handler = createPaidMarketApi(config, { getSupported: forbidden, verify: forbidden, settle: forbidden }, store);
      const response = await handler({ asset: 'SOL' }, paymentSignatureHeaders(payload)['PAYMENT-SIGNATURE'], true);
      assert.equal(response.status, 200, 'Lost receipt recovery did not find the original transaction');
      assert.deepEqual(await response.json(), first.data);
      assert.equal(store.get(messageHash)?.receipt?.transaction, first.transaction);
    } finally { store.close(); }
    const after = await runPaymentPreflight(config);
    const delta = BigInt(before.buyer.balanceBaseUnits) - BigInt(after.buyer.balanceBaseUnits);
    const received = BigInt(after.merchant.balanceBaseUnits) - BigInt(before.merchant.balanceBaseUnits);
    const fresh = results.filter(r => (r as { fresh: boolean }).fresh).length;
    assert.equal(delta, BigInt(fresh) * 10_000n);
    assert.equal(received, delta);
    const report = { date, batch, consecutiveFreshRuns: fresh === 5, results, buyerBefore: before.buyer.balanceBaseUnits, buyerAfter: after.buyer.balanceBaseUnits,
      merchantBefore: before.merchant.balanceBaseUnits, merchantAfter: after.merchant.balanceBaseUnits,
      spentBaseUnits: String(delta), lostDataRecovery: true, lostReceiptChainRecovery: true };
    writeFileSync(`.data/day6/acceptance${batch ? '-' + batch : ''}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ complete: true, freshRuns: fresh, spentTestUSDC: Number(delta) / 1_000_000, lostDataRecovery: true, lostReceiptChainRecovery: true }));
  } finally { ledger.close(); }
}
main().catch(error => {
  const message = (error instanceof Error ? error.message : 'Unknown failure')
    .replaceAll(process.env.OPENAI_API_KEY || 'NO_KEY_CONFIGURED', '[redacted]').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 300);
  console.error(JSON.stringify({ stage, error: error instanceof Error ? error.name : 'Error', message }));
  process.exitCode = 1;
});
