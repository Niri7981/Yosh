import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';
import { payOperationPurchaseId } from '../../src/modules/payment/pay-authority-adapter';
import { readAgentPurchase } from '../../src/modules/purchases/agent-purchase-read';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';

const state = vi.hoisted(() => ({ app: null as null | { authenticateAgent: (request: Request) => { cardMemberId: string }; ledger: PurchaseLedger } }));
vi.mock('../../src/modules/app/app-runtime', () => ({ appRuntime: () => state.app }));
import { GET } from '../../src/app/api/agent/purchase/route';

beforeEach(() => { state.app = null; });
it('reads only the authenticated owner, reports durable refusal, and never recovers or exposes payment credentials', async () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
  try {
    const member = ledger.defaultCardMember();
    const other = ledger.createCardMember('Another Agent');
    const operation = 'durable-paused-operation';
    const purchaseId = payOperationPurchaseId(member.id, operation);
    const now = Date.now();
    const facts = { id: randomUUID(), idempotencyKey: purchaseId, requestHash: hash({ operation }), resourceId: 'fixture',
      providerId: 'fixture', amount: '1000', currency: 'Test USDC', assetDecimals: 6,
      assetId: 'fixture-asset', network: 'fixture-network', payTo: 'fixture-merchant', paymentScheme: 'exact',
      quoteFingerprint: 'fixture-quote', createdAt: now, expiresAt: now + 60_000, executionBinding: 'fixture' };
    ledger.setDailyLimit('100000', 'live_devnet'); ledger.setPaused(true, 'live_devnet');
    const record = ledger.reserve(facts, { scheme: 'exact', amount: '1000', network: 'solana:fixture', asset: 'fixture-asset',
      payTo: 'fixture-merchant', maxTimeoutSeconds: 60, extra: {} }, now, 'live_devnet', member.id);
    expect(record.status).toBe('DENIED');
    const read = vi.spyOn(ledger, 'getOwned');
    state.app = { ledger, authenticateAgent: request => {
      const cardMemberId = request.headers.get('x-test-member');
      if (!cardMemberId) throw new Error('unauthorized');
      return { cardMemberId };
    } };
    const query = (parameters: string, owner: string = member.id) => GET(new Request(`http://127.0.0.1/api/agent/purchase?${parameters}`,
      { headers: owner ? { 'x-test-member': owner } : {} }));
    expect((await query(`operationId=${operation}`, '')).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const result = await query(`operationId=${operation}`);
    expect(result.status).toBe(200);
    const body: unknown = await result.json();
    expect(body).toMatchObject({ purchaseId, operationId: operation, status: 'DENIED', policyCode: 'PAYMENTS_PAUSED',
      paymentStatus: 'NOT_STARTED', deliveryStatus: 'NOT_PAID', amount: '1000', transaction: null });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['amount', 'assetDecimals', 'assetId', 'deliveryStatus',
      'network', 'operationId', 'paymentStatus', 'policyCode', 'purchaseId', 'resourceId', 'status', 'transaction'].sort());
    // Current controls do not rewrite the reason for this original purchase.
    ledger.setPaused(false, 'live_devnet');
    expect(await (await query(`purchaseId=${purchaseId}`)).json()).toMatchObject({ policyCode: 'PAYMENTS_PAUSED' });
    expect((await query(`purchaseId=${purchaseId}`, other.id)).status).toBe(404);
    expect((await query(`operationId=${operation}`, other.id)).status).toBe(404);
    expect((await query(`purchaseId=${purchaseId}&operationId=${operation}`)).status).toBe(400);
    expect((await query('operationId=unknown&approved=true')).status).toBe(400);
    expect((await query('operationId=unknown')).status).toBe(404);
    expect(ledger.getOwned(purchaseId, member.id)?.status).toBe('DENIED');
  } finally { ledger.close(); }
});

it('an unknown-payment read retains the original record and reservation without running recovery', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
  try {
    const member = ledger.defaultCardMember(), now = Date.now();
    ledger.setDailyLimit('100000', 'live_devnet');
    const intent = { id: randomUUID(), idempotencyKey: payOperationPurchaseId(member.id, 'unknown-original'),
      requestHash: hash({ request: 'unknown-original' }), resourceId: 'fixture', providerId: 'fixture', amount: '1000',
      currency: 'Test USDC', assetDecimals: 6, assetId: DEVNET_USDC_MINT, network: DEVNET_NETWORK,
      payTo: 'fixture-merchant', paymentScheme: 'exact', quoteFingerprint: 'fixture-quote',
      createdAt: now, expiresAt: now + 60_000, executionBinding: 'fixture' };
    const record = ledger.reserve(intent, { scheme: 'exact', amount: '1000', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT,
      payTo: 'fixture-merchant', maxTimeoutSeconds: 60, extra: {} }, now, 'live_devnet', member.id);
    ledger.claim(record.approvalId, now, undefined, 'live_devnet'); ledger.unknown(record.approvalId);
    const before = ledger.getOwned(intent.idempotencyKey, member.id);
    const summary = ledger.managedSummary(now, 'live_devnet');
    for (let count = 0; count < 2; count++) expect(readAgentPurchase(ledger, member.id, { operationId: 'unknown-original' }))
      .toMatchObject({ purchaseId: intent.idempotencyKey, paymentStatus: 'PAYMENT_UNKNOWN', deliveryStatus: 'NOT_PAID', transaction: null });
    expect(ledger.getOwned(intent.idempotencyKey, member.id)).toEqual(before);
    expect(ledger.managedSummary(now, 'live_devnet')).toEqual(summary);
    expect(summary).toMatchObject({ reserved: '1000', paid: '0', unresolved: 1 });
  } finally { ledger.close(); }
});
