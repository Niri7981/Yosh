import type { PaymentPayload } from '@x402/core/types';
import type { PurchaseRecord } from '../purchases/purchase-contract';
import type { PurchaseLedger } from '../purchases/purchase-ledger';
import type { OriginalPaymentLifetime } from './original-payment-evidence';
import type { PaymentConfig } from './payment-config';
import type { PaymentSigningAuthorization } from './solana-payment';

export type PaymentExecutionContext = Readonly<{
  config: PaymentConfig;
  record: PurchaseRecord;
  endpoint: string;
  beforeSign: () => void;
  production?: PaymentSigningAuthorization;
}>;

export type PreparedPayment = Readonly<{
  payload: PaymentPayload;
  lifetime?: OriginalPaymentLifetime;
}>;

/** Only public, validated receipt fields cross the protocol-engine boundary.
 * Merchant-controlled transaction/error/extension strings could echo a buyer
 * signature and must remain inside Yosh until independently verified. */
export type PaymentResponseObservation = Readonly<{
  status: number;
  paymentResponse?: string;
}>;

/** Backend-only preparation seam. Yosh retains original evidence, the sole
 * credential-bearing transport, and authority over reconciliation and delivery.
 * A controlled executor must reject an unsafe runtime before any claim. */
export interface PaymentExecutor {
  /** Optional isolated-runtime binding; never selected from Agent input. */
  bindRuntime?(directory: string, ledger: PurchaseLedger): void;
  assertEligibility(config: PaymentConfig, ledger: PurchaseLedger): void;
  /** Synchronous: capture this claim's generation before any preflight await. */
  beginPreparation?(context: PaymentExecutionContext): void;
  /** Fence unfinished preparation/signing work when Pause or shutdown wins. */
  invalidate?(): void;
  prepare(context: PaymentExecutionContext): Promise<PreparedPayment>;
  /** Synchronous: no permit or credential is handed to another sender. */
  assertBeforeSubmission(context: PaymentExecutionContext): void;
  interpretResponse?(observation: PaymentResponseObservation): Promise<void>;
}
