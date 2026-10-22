import { hash } from '../authority/authority-policy';
import type { PaymentConfig } from '../payment/payment-config';
import type { PaymentSigningAuthorization } from '../payment/solana-payment';
import type { PurchaseLedger } from './purchase-ledger';
import { assertProductionPaymentGate } from './production-execution-gate';
import type { ExternalExecutionPermit } from './execution-safety';

/** Rechecks the original reserved purchase synchronously at each signing boundary. */
export function purchaseSigningAuthorization(
  ledger: PurchaseLedger, approvalId: string, config: PaymentConfig, endpoint: string, permit?: ExternalExecutionPermit,
): PaymentSigningAuthorization {
  return {
    assertCanSign(requirement, authorized) {
      if (ledger.savedPayload(approvalId)) throw new Error('MAINNET_PAYMENT_ALREADY_SIGNED');
      ledger.assertCanSign(approvalId, undefined, record => {
        assertProductionPaymentGate(ledger, record, config, endpoint);
        if (hash(record.quote) !== hash(requirement) || hash(record.intent.x402Challenge) !== hash(authorized.challenge)
          || record.intent.amount !== authorized.amount || record.intent.httpRequest?.url !== authorized.resource) {
          throw new Error('MAINNET_PAYMENT_BINDING_MISMATCH');
        }
      }, permit);
    },
  };
}
