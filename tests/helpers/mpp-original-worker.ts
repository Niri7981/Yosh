import { z } from 'zod';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { MppStoredPaymentSchema } from '../../src/modules/payment/mpp-contract';
import { OriginalPaymentRecordSchema } from '../../src/modules/purchases/original-payment-record';

// Synthetic signed fixtures and a temporary test database only; no signer/network.
const Setup = z.object({ path: z.string(), now: z.number(), walletIdentity: z.string(), approvalId: z.string(),
  payment: MppStoredPaymentSchema, original: OriginalPaymentRecordSchema }).strict();
let value: PurchaseLedger | undefined;
let setup: z.infer<typeof Setup> | undefined;
process.on('message', (raw: unknown) => {
  if (!setup) {
    setup = Setup.parse(raw);
    value = new PurchaseLedger(setup.path, { managed: true, mode: 'live_devnet', requireSpendGrant: true,
      walletIdentity: setup.walletIdentity, now: () => setup!.now });
    process.send?.({ ready: true }); return;
  }
  if (raw !== 'save') throw new Error('INVALID_TEST_MESSAGE');
  let status = 'saved';
  try {
    value!.claim(setup.approvalId, setup.now);
    value!.savePayload(setup.approvalId, setup.payment, undefined, setup.original);
  } catch (error) {
    value!.failUnsubmitted(setup.approvalId);
    status = error instanceof Error && error.message === 'MPP_ORIGINAL_TRANSACTION_ALREADY_USED'
      ? error.message : 'UNEXPECTED_SAVE_FAILURE';
  } finally { value!.close(); }
  process.send?.({ status }); process.disconnect?.();
});
