import type { PurchaseLedger } from './purchase-ledger';

/** Called only after matching the original merchant receipt to the signed transaction.
 * Keep the same bounded body promise for the proof-gated fallback on validation or I/O failure. */
export async function saveBoundOriginalBody(ledger: PurchaseLedger, approvalId: string, body: Promise<unknown>) {
  try {
    return { data: ledger.saveOriginalMerchantDelivery(approvalId, await body) };
  } catch { return undefined; }
}
