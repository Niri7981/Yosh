import { z } from 'zod';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { MppChargeQuoteSchema } from '../../src/modules/payment/mpp-contract';

// Temporary SQLite only. Parent passes public test facts over IPC after spawn.
const Setup = z.object({ path: z.string(), now: z.number(), intent: SpendIntentSchema, quote: MppChargeQuoteSchema }).strict();
let ledger: PurchaseLedger | undefined;
let setup: z.infer<typeof Setup> | undefined;
process.on('message', (raw: unknown) => {
  if (!setup) {
    setup = Setup.parse(raw);
    ledger = new PurchaseLedger(setup.path, { managed: true, mode: 'live_devnet', requireSpendGrant: true, now: () => setup!.now });
    process.send?.({ ready: true });
    return;
  }
  try {
    if (raw !== 'reserve') {
      const { claimDelivery } = z.object({ claimDelivery: z.string().uuid() }).strict().parse(raw);
      const token = ledger!.claimMppCredentialDelivery(claimDelivery, () => {}, true, setup.now);
      process.send?.({ token: token ?? null });
      return;
    }
    const record = ledger!.reserve(setup.intent, setup.quote, setup.now);
    process.send?.({ status: record.status });
  } catch (error) {
    process.send?.({ code: error instanceof Error && error.message === 'MPP_CHALLENGE_ALREADY_USED'
      ? error.message : 'UNEXPECTED_RESERVATION_FAILURE' });
  } finally { ledger!.close(); process.disconnect?.(); }
});
