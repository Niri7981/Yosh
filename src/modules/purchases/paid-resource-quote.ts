import { DEVNET_NETWORK, DEVNET_USDC_MINT, loadPaymentConfig, type PaymentConfig } from '../payment/payment-config';
import { PAID_RESOURCES, paidResource, type PaidResourceId } from '../resources/paid-resources';
import { paymentEndpointForResource } from './approved-payment';
import { fetchResourceChallenge } from '../payment/resource-challenge';

export function displayAmount(amount: string) {
  const units = BigInt(amount);
  const whole = units / 1_000_000n;
  const fraction = String(units % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction} test USDC`;
}

/** Always reads a fresh, server-issued HTTP 402; the descriptor contains no price. */
export async function fetchPaidResourceQuote(id: PaidResourceId, origin: string, config: PaymentConfig, fetcher: typeof fetch = fetch, selectedQuote?: unknown) {
  if (config.cluster !== 'devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT) throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
  const resource = paidResource(id);
  const endpoint = paymentEndpointForResource(origin, id);
  return fetchResourceChallenge({ resourceId: resource.id, providerId: resource.providerId,
    request: { url: endpoint, method: 'GET', headers: {}, access: 'test_loopback' },
    network: config.network, mint: config.mint, decimals: config.asset.decimals, recipient: config.merchant }, config, fetcher, selectedQuote);
}

export async function readPaidResourceQuotes(origin: string, config: PaymentConfig = loadPaymentConfig(), fetcher: typeof fetch = fetch) {
  const resources = await Promise.all((Object.keys(PAID_RESOURCES) as PaidResourceId[]).map(async id => {
    const descriptor = paidResource(id);
    const { quote } = await fetchPaidResourceQuote(id, origin, config, fetcher);
    return { resourceId: id, name: descriptor.name, resourceUrl: descriptor.path, amount: quote.amount,
      decimals: 6, display: displayAmount(quote.amount), asset: quote.asset, network: quote.network, payTo: quote.payTo };
  }));
  return { resources, testEnvironment: true };
}
