import { paymentStatusFor } from './purchase-state';
import { payOperationPurchaseId } from '../payment/pay-authority-adapter';
import type { PurchaseLedger } from './purchase-ledger';
import { AgentPurchaseReadInput, AgentPurchaseSummary } from '../mcp/purchase-read-contract';

/** Read original owner-bound facts only. Never claims execution, reconciles a
 * transaction, releases a reservation or returns signed payment credentials. */
export function readAgentPurchase(ledger: PurchaseLedger, owner: string, raw: unknown) {
  const input = AgentPurchaseReadInput.parse(raw);
  const id = input.purchaseId ?? payOperationPurchaseId(owner, input.operationId!);
  let record = ledger.getOwned(id, owner);
  if (input.operationId) {
    const direct = ledger.getOwned(input.operationId, owner);
    if (direct?.intent.mpp && direct.intent.paymentScheme === 'mpp_charge') {
      if (record && record.intent.id !== direct.intent.id) throw new Error('PURCHASE_OPERATION_AMBIGUOUS');
      record = direct;
    }
  }
  if (!record) return undefined;
  const provenance = ledger.executionSafety.provenance(record.intent.id);
  const operationId = provenance?.origin === 'external_pay' && provenance.caller_id === owner
    ? String(provenance.operation_id) : input.operationId ?? null;
  return AgentPurchaseSummary.parse({ purchaseId: record.intent.idempotencyKey, operationId, status: record.status,
    paymentStatus: paymentStatusFor(record.status),
    deliveryStatus: record.deliveryStatus, failure: ledger.executionFailure(record.intent.id), policyCode: /^[A-Z][A-Z0-9_]{1,100}$/.test(record.decision.reason)
      ? record.decision.reason : 'POLICY_REASON_UNAVAILABLE',
    resourceId: record.intent.resourceId, amount: record.intent.amount.toString(), network: record.intent.network,
    assetId: record.intent.assetId, assetDecimals: record.intent.assetDecimals, transaction: record.transaction ?? null });
}
