import { z } from 'zod';
import { X402ResourceSchema } from './http-resource';
import { DEVNET_NETWORK, type PaymentEnvironment } from '../payment/payment-environment';

/** Registration is readable without a wallet, facilitator or execution permission. */
export function loadRegisteredResources(env: Record<string, string | undefined>, environment: PaymentEnvironment) {
  if (env.YOSH_MAINNET_RESOURCES === undefined) return [];
  let resources;
  try { resources = z.array(X402ResourceSchema).min(1).max(256).parse(JSON.parse(env.YOSH_MAINNET_RESOURCES)); }
  catch { throw new Error('MAINNET_RESOURCE_REGISTRATION_INVALID'); }
  const ids = new Set<string>();
  for (const resource of resources) {
    if (ids.has(resource.resourceId) || resource.request.access !== 'https' || resource.network !== environment.network
      || resource.mint !== environment.asset.mint || resource.decimals !== environment.asset.decimals) {
      throw new Error('MAINNET_RESOURCE_REGISTRATION_INVALID');
    }
    ids.add(resource.resourceId);
  }
  return resources;
}

export function registeredResourceSummary(resource: ReturnType<typeof loadRegisteredResources>[number]) {
  const number = (amount: string | undefined) => amount === undefined ? null
    : `${BigInt(amount) / 1_000_000n}.${String(BigInt(amount) % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')} ${resource.network === DEVNET_NETWORK ? 'Test USDC' : 'USDC'}`;
  return { resourceId: resource.resourceId, providerId: resource.providerId, name: resource.displayName ?? resource.resourceId,
    url: resource.request.url, method: resource.request.method, recipient: resource.recipient ?? null,
    requestInputs: resource.requestInputs ?? null,
    recipientSource: resource.recipientSource ?? 'registered', network: resource.network,
    assetId: resource.mint, assetDecimals: resource.decimals, baseAmount: resource.baseAmount ?? resource.amount ?? null,
    maximumAmount: resource.maximumAmount ?? resource.amount ?? null,
    basePriceDisplay: number(resource.baseAmount ?? resource.amount), maximumPriceDisplay: number(resource.maximumAmount ?? resource.amount) };
}
