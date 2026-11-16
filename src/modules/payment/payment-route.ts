import { z } from 'zod';
import type { PurchaseRecord } from '../purchases/purchase-contract';
import { hash } from '../authority/authority-policy';

// Adapted from the preserved Payment Domain Routing implementation. The executor
// discriminator supports both onchain protocols without changing monetary scope.
const x402 = z.object({ domain: z.literal('onchain'), network: z.literal('solana'),
  protocol: z.literal('x402_exact'), executor: z.literal('pay_x402_solana'), asset: z.literal('USDC') }).strict();
const mpp = z.object({ domain: z.literal('onchain'), network: z.literal('solana'),
  protocol: z.literal('mpp_charge'), executor: z.literal('pay_mpp_solana_charge'), asset: z.literal('USDC') }).strict();
export const PaymentRouteSchema = z.discriminatedUnion('executor', [x402, mpp]);
export type PaymentRoute = Readonly<z.infer<typeof PaymentRouteSchema>>;
export type PaymentRail = PaymentRoute['executor'];
const routes = {
  pay_x402_solana: Object.freeze(x402.parse({ domain: 'onchain', network: 'solana', protocol: 'x402_exact', executor: 'pay_x402_solana', asset: 'USDC' })),
  pay_mpp_solana_charge: Object.freeze(mpp.parse({ domain: 'onchain', network: 'solana', protocol: 'mpp_charge', executor: 'pay_mpp_solana_charge', asset: 'USDC' })),
} satisfies Record<PaymentRail, PaymentRoute>;

/** Descriptors do not authorize spending or identify an asset by ticker alone. */
export function resolvePaymentRoute(raw: unknown = 'pay_x402_solana'): PaymentRoute {
  if (raw === 'pay_x402_solana' || raw === 'pay_mpp_solana_charge') return routes[raw];
  const parsed = PaymentRouteSchema.safeParse(raw);
  if (!parsed.success) throw new Error('PAYMENT_ROUTE_UNSUPPORTED');
  return Object.freeze(parsed.data);
}

/** Call only with a record read by the Ledger; callers cannot choose recovery protocol. */
export function storedPaymentRoute(record: Pick<PurchaseRecord, 'intent' | 'quote'>): PaymentRoute {
  if (record.intent.mpp) {
    if (hash(record.intent.mpp) !== hash(record.quote)) throw new Error('PAYMENT_ROUTE_BINDING_MISMATCH');
    return routes.pay_mpp_solana_charge;
  }
  if ('protocol' in record.quote) throw new Error('PAYMENT_ROUTE_BINDING_MISMATCH');
  return routes.pay_x402_solana;
}
