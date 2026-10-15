import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DeliveryRecoveryCapabilitySchema, type DeliveryRecoveryCapability } from '../resources/delivery-capability';
import { initializeDeliveryState } from './delivery-migration';
import { DELIVERY_RETRY_LIMIT, DeliveryRecoveryStateSchema, ReceiptStatusSchema, type DeliveryRecoveryState, type ReceiptStatus } from './delivery-state';

/** Internal persistence for delivery only. The ledger validates paid ownership and
 * evidence first and owns the shared transaction, including result and audit writes.
 * This module neither opens transactions nor holds a payment/signing capability. */
export class PurchaseDeliveryStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  private assertTransaction() {
    if (!this.db.isTransaction) throw new Error('DELIVERY_TRANSACTION_REQUIRED');
  }
  private event(purchaseId: string, type: string) {
    this.db.prepare('INSERT INTO purchase_events (purchase_id,type,at) VALUES (?,?,?)').run(purchaseId, type, this.now());
  }
  initialize(row: Parameters<typeof initializeDeliveryState>[1]) {
    this.assertTransaction();
    initializeDeliveryState(this.db, row);
  }
  state(purchaseId: string): DeliveryRecoveryState {
    const row = this.db.prepare('SELECT * FROM purchase_delivery WHERE purchase_id=?').get(purchaseId);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    return DeliveryRecoveryStateSchema.parse({ status: row.state, receiptStatus: row.receipt_state,
      retryCount: Number(row.retry_count), retryLimit: DELIVERY_RETRY_LIMIT, nextAttemptAt: Number(row.next_attempt_at), lastError: row.last_error });
  }
  capability(purchaseId: string): DeliveryRecoveryCapability {
    const row = this.db.prepare('SELECT capability FROM purchase_delivery WHERE purchase_id=?').get(purchaseId);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    return DeliveryRecoveryCapabilitySchema.parse(JSON.parse(String(row.capability)));
  }
  recordReceipt(purchaseId: string, outcome: ReceiptStatus, receipt?: { transaction: string; network: string; payer?: string; amount?: string }) {
    this.assertTransaction();
    // Once verified, a later missing/invalid response does not erase that receipt fact.
    this.db.prepare(`UPDATE purchase_delivery SET receipt_state=?,receipt=COALESCE(?,receipt)
      WHERE purchase_id=? AND receipt_state<>'CONFIRMED'`).run(ReceiptStatusSchema.parse(outcome), receipt ? JSON.stringify(receipt) : null, purchaseId);
  }
  claim(purchaseId: string, kind: 'initial' | 'retry', now: number): string | undefined {
    this.assertTransaction();
    const row = this.db.prepare('SELECT * FROM purchase_delivery WHERE purchase_id=?').get(purchaseId);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    if (row.state !== 'PENDING') return;
    if (kind === 'retry') {
      if (this.capability(purchaseId).kind === 'none') { this.terminal(purchaseId, 'DELIVERY_RECOVERY_UNSUPPORTED', 'UNSUPPORTED'); return; }
      if (Number(row.retry_count) >= DELIVERY_RETRY_LIMIT) { this.terminal(purchaseId, 'DELIVERY_RETRY_EXHAUSTED', 'EXHAUSTED'); return; }
      if (Number(row.next_attempt_at) > now) return;
    } else if (row.initial_attempted === 1) return;
    const token = randomUUID();
    const update = this.db.prepare(`UPDATE purchase_delivery SET state='DELIVERING',claim_token=?,claim_kind=?,claim_at=?,
      retry_count=retry_count+?,initial_attempted=CASE WHEN ?='initial' THEN 1 ELSE initial_attempted END
      WHERE purchase_id=? AND state='PENDING'`).run(token, kind, now, kind === 'retry' ? 1 : 0, kind, purchaseId);
    if (update.changes !== 1) return;
    this.event(purchaseId, kind === 'retry' ? 'delivery.RETRY_CLAIMED' : 'delivery.INITIAL_CLAIMED');
    return token;
  }
  terminal(purchaseId: string, code: string, state: 'UNSUPPORTED' | 'EXHAUSTED') {
    this.assertTransaction();
    const changed = this.db.prepare("UPDATE purchase_delivery SET state=?,last_error=? WHERE purchase_id=? AND state='PENDING'").run(state, code, purchaseId);
    if (changed.changes) this.event(purchaseId, `delivery.${state}`);
  }
  failAttempt(purchaseId: string, token: string, code: string, now: number) {
    this.assertTransaction();
    const row = this.db.prepare("SELECT * FROM purchase_delivery WHERE purchase_id=? AND state='DELIVERING' AND claim_token=?").get(purchaseId, token);
    if (!row) return; // A stale response cannot release another owner's claim.
    const state = this.capability(purchaseId).kind === 'none' ? 'UNSUPPORTED' : Number(row.retry_count) >= DELIVERY_RETRY_LIMIT ? 'EXHAUSTED' : 'PENDING';
    const next = row.claim_kind === 'retry' ? now + 1000 * 2 ** Math.max(0, Number(row.retry_count) - 1) : now;
    this.db.prepare(`UPDATE purchase_delivery SET state=?,claim_token=NULL,claim_kind=NULL,claim_at=NULL,next_attempt_at=?,last_error=?
      WHERE purchase_id=? AND claim_token=?`).run(state, next, state === 'UNSUPPORTED' ? 'DELIVERY_RECOVERY_UNSUPPORTED' : code, purchaseId, token);
    this.event(purchaseId, state === 'PENDING' ? 'delivery.RETRY_PENDING' : `delivery.${state}`);
  }
  /** Returns false for an already completed order; the caller saves result data and
   * its audit event in this same transaction. No partial completion may commit. */
  complete(purchaseId: string, token?: string): boolean {
    this.assertTransaction();
    const row = this.db.prepare('SELECT state,claim_token FROM purchase_delivery WHERE purchase_id=?').get(purchaseId);
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    if ((token && (row.state !== 'DELIVERING' || row.claim_token !== token)) || (!token && row.state === 'DELIVERING')) throw new Error('DELIVERY_CLAIM_MISMATCH');
    if (row.state === 'COMPLETE') return false;
    if (!['PENDING', 'NOT_PAID', 'DELIVERING'].includes(String(row.state))) throw new Error('DELIVERY_TERMINAL');
    this.db.prepare("UPDATE purchase_delivery SET state='COMPLETE',claim_token=NULL,claim_kind=NULL,claim_at=NULL,last_error=NULL WHERE purchase_id=?").run(purchaseId);
    return true;
  }
  interruptedClaims() {
    return this.db.prepare("SELECT p.approval_id,d.claim_token FROM purchase_delivery d JOIN purchases p ON p.id=d.purchase_id WHERE d.state='DELIVERING'").all()
      .map(row => ({ approvalId: String(row.approval_id), token: String(row.claim_token) }));
  }
  due(now: number) {
    return this.db.prepare(`SELECT task_id,owner_card_member_id FROM purchases p JOIN purchase_delivery d ON d.purchase_id=p.id
      WHERE p.status='PAID' AND p.execution_mode IN ('live_devnet','live_mainnet') AND d.state='PENDING' AND d.next_attempt_at<=?`).all(now)
      .map(row => ({ requestId: String(row.task_id), ownerCardMemberId: row.owner_card_member_id ? String(row.owner_card_member_id) : undefined }));
  }
}
