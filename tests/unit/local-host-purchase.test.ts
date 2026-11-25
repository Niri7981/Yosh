import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { executeHostPurchase, LocalHostPurchasePlan } from '../../src/modules/mcp/local-host-purchase';

const input = { requestId: 'one', resourceId: 'registered', reason: 'One research call' };
const plan = LocalHostPurchasePlan.parse({ memberId: randomUUID(), resourceId: input.resourceId, requestId: input.requestId,
  protocol: 'x402', url: 'https://merchant.example/api' });
const receipt = { purchaseId: 'original', operationId: input.requestId, resourceId: input.resourceId, status: 'PAID',
  paymentStatus: 'PAID', deliveryStatus: 'COMPLETE', policyCode: 'APPROVED', amount: '1000',
  network: 'solana', assetId: 'usdc', assetDecimals: 6, transaction: 'original-signature' };
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const missing = { isError: true, content: [{ type: 'text', text: 'PURCHASE_NOT_FOUND: read only.' }] };
const signal = new AbortController().signal;

it.each(['x402', 'mpp'] as const)('executes one %s purchase and returns its ledger result after a transport failure and repeat', async protocol => {
  const query = { query: { asset: 'SOL' } };
  const purchase = { ...input, request: query };
  const page = { purchaseId: receipt.purchaseId, encoding: 'base64', contentType: 'application/json', offset: 0, totalBytes: 2, chunk: 'e30=', nextOffset: null };
  const result = { ...receipt, delivery: { encoding: 'json', contentType: 'application/json', value: {} } };
  let paid = false;
  const call = vi.fn(async (tool: string) => {
    if (tool === 'get_purchase') return paid ? text(receipt) : missing;
    if (tool === 'get_purchase_delivery') return text(page);
    paid = true;
    throw new Error('connection closed after submission');
  });
  await expect(executeHostPurchase({ ...plan, protocol }, purchase, call, signal)).resolves.toEqual(result);
  await expect(executeHostPurchase({ ...plan, protocol }, purchase, call, signal)).resolves.toEqual(result);
  expect(call.mock.calls.map(([name]) => name)).toEqual(['get_purchase', protocol === 'x402' ? 'curl' : 'request_mpp_purchase', 'get_purchase', 'get_purchase_delivery', 'get_purchase', 'get_purchase_delivery']);
  expect(call).toHaveBeenNthCalledWith(2, protocol === 'x402' ? 'curl' : 'request_mpp_purchase',
    protocol === 'x402' ? { operation_id: input.requestId, url: plan.url } : purchase, signal);
});

it.each(['x402', 'mpp'] as const)('returns an original %s delivery even if payment reconciliation is pending', async protocol => {
  const pending = { ...receipt, status: 'PAYMENT_UNKNOWN', paymentStatus: 'PAYMENT_UNKNOWN', transaction: null };
  const value = { BTC: 60000, ETH: 3000, SOL: 100 };
  const body = Buffer.from(JSON.stringify(value));
  const call = vi.fn().mockResolvedValueOnce(missing).mockRejectedValueOnce(new Error('Original settlement unresolved'))
    .mockResolvedValueOnce(text(pending)).mockResolvedValueOnce(text({ purchaseId: receipt.purchaseId, encoding: 'base64',
      contentType: 'application/json', offset: 0, nextOffset: null, totalBytes: body.length, chunk: body.toString('base64') }));
  await expect(executeHostPurchase({ ...plan, protocol }, input, call, signal)).resolves.toMatchObject({
    ...pending, delivery: { encoding: 'json', value },
  });
  expect(call.mock.calls.map(([tool]) => tool)).toEqual(['get_purchase', protocol === 'x402' ? 'curl' : 'request_mpp_purchase',
    'get_purchase', 'get_purchase_delivery']);
});

it('only treats explicit not-found as permission to dispatch and checks member receipt bindings', async () => {
  const call = vi.fn().mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'AGENT_UNAUTHORIZED: read only.' }] })
    .mockResolvedValueOnce(text({ ...receipt, resourceId: 'another' }));
  await expect(executeHostPurchase(plan, { ...input, requestId: 'different' }, call, signal)).rejects.toThrow('LOCAL_PURCHASE_BINDING_MISMATCH');
  await expect(executeHostPurchase(plan, input, call, signal)).rejects.toThrow('LOCAL_PURCHASE_LOOKUP_UNAVAILABLE');
  await expect(executeHostPurchase(plan, input, call, signal)).rejects.toThrow('LOCAL_PURCHASE_BINDING_MISMATCH');
  expect(call.mock.calls.map(([name]) => name)).toEqual(['get_purchase', 'get_purchase']);
});

it('reports missing receipt when the merchant says success and the local ledger has no result', async () => {
  const call = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(text({ success: true })).mockResolvedValueOnce(missing);
  await expect(executeHostPurchase(plan, input, call, signal)).rejects.toThrow('LOCAL_PURCHASE_RECEIPT_UNAVAILABLE');
  expect(call.mock.calls.map(([name]) => name)).toEqual(['get_purchase', 'curl', 'get_purchase']);
});

it('reads only saved pages of an original purchase, preserves the receipt if a delivery fails and never dispatches a merchant call', async () => {
  const page = { purchaseId: receipt.purchaseId, encoding: 'base64', contentType: 'application/json', offset: 10, totalBytes: 11, chunk: 'fQ==', nextOffset: null };
  const call = vi.fn().mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(text(receipt)).mockResolvedValueOnce(text(page))
    .mockResolvedValueOnce(text(receipt)).mockResolvedValueOnce(text({ ...page, purchaseId: 'different' }))
    .mockResolvedValueOnce(text({ ...receipt, status: 'PAYMENT_UNKNOWN', paymentStatus: 'PAYMENT_UNKNOWN', deliveryStatus: 'NOT_PAID' }));
  await expect(executeHostPurchase(plan, input, call, signal, 10)).rejects.toThrow('LOCAL_PURCHASE_NOT_FOUND');
  await expect(executeHostPurchase(plan, input, call, signal, 10)).resolves.toMatchObject({ ...receipt, delivery: page });
  await expect(executeHostPurchase(plan, input, call, signal, 10)).resolves.toMatchObject({ ...receipt, delivery: { code: 'LOCAL_SAVED_DELIVERY_UNAVAILABLE' } });
  await expect(executeHostPurchase(plan, input, call, signal)).resolves.toMatchObject({ paymentStatus: 'PAYMENT_UNKNOWN' });
  expect(call.mock.calls.map(([name]) => name)).toEqual(['get_purchase', 'get_purchase', 'get_purchase_delivery', 'get_purchase',
    'get_purchase_delivery', 'get_purchase']);
});
