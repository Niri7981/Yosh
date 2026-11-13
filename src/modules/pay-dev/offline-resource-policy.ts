import { DiscoveryInput } from '../resources/mainnet-resource-discovery';
import { MAX_RESOURCE_DELIVERY_BYTES, type HttpResourceRequest, type X402Resource } from '../resources/http-resource';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../payment/payment-environment';
import { TEST_CACHED_DELIVERY } from '../resources/delivery-capability';
import { PAID_RESOURCES, PAID_RESOURCE_SCOPE_ID } from '../resources/paid-resources';
import { IS_CODEX_PLUGIN_DEVELOPMENT } from './profile';
import { isPayDevelopmentDirectory } from './isolation';

// Dedicated routes cannot alias a legacy fixture's broad historical Grant.
export const PLUGIN_OFFLINE_RESOURCE_PATHS = ['/api/paid/plugin-snapshot?asset=SOL', '/api/paid/plugin-risk?asset=SOL'] as const;

/** Backend-constructed capability for this one Offline service. Neither an
 * Agent field nor an environment override can admit another origin or path. */
export function createOfflineResourcePolicy(directory: string, origin: string) {
  const base = new URL(origin);
  const assertActive = () => {
    if (!IS_CODEX_PLUGIN_DEVELOPMENT || !isPayDevelopmentDirectory(directory) || process.env.YOSH_PAY_DEV_ENV !== 'offline'
      || base.origin !== origin || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port)
      throw new Error('OFFLINE_RESOURCE_SCOPE_REJECTED');
  };
  assertActive();
  const urls = PLUGIN_OFFLINE_RESOURCE_PATHS.map(path => new URL(path, origin).href);
  const assertRequest = (request: HttpResourceRequest) => {
    assertActive();
    if (!urls.includes(request.url) || request.method !== 'GET' || request.access !== 'test_loopback' || request.body !== undefined
      || Object.entries(request.headers).some(([name, value]) => name !== 'accept' || value !== 'application/json'))
      throw new Error('OFFLINE_RESOURCE_SCOPE_REJECTED');
  };
  const assertResource = (resource: X402Resource) => {
    assertRequest(resource.request);
    if (Object.hasOwn(PAID_RESOURCES, resource.resourceId) || resource.resourceId === PAID_RESOURCE_SCOPE_ID
      || resource.network !== DEVNET_NETWORK || resource.mint !== DEVNET_USDC_MINT || resource.decimals !== 6
      || resource.requestInputs !== undefined) throw new Error('OFFLINE_RESOURCE_SCOPE_REJECTED');
  };
  return {
    origin, assertRequest, assertResource,
    includesUrl(url: string) { assertActive(); return urls.includes(url); },
    discoveryInput(raw: unknown) {
      assertActive();
      const input = DiscoveryInput.parse(raw);
      if (input.method !== 'GET' || input.body !== undefined || input.requestInputs !== undefined
        || (input.sample !== undefined && Object.keys(input.sample).length !== 0)
        || input.deliveryRecovery !== undefined || input.deliveryPolicy !== undefined)
        throw new Error('OFFLINE_RESOURCE_SCOPE_REJECTED');
      return { ...input, deliveryPolicy: { format: 'json' as const, mimeTypes: ['application/json'], maxBytes: MAX_RESOURCE_DELIVERY_BYTES },
        deliveryRecovery: TEST_CACHED_DELIVERY, documentation: { urls: [], uncertainties: ['Offline fixture; no real funds or external API.'] } };
    },
    async readHeaders(url: string, method: 'GET' | 'POST', body?: string, headers: Record<string, string> = {}) {
      assertRequest({ url, method, access: 'test_loopback', headers, ...(body === undefined ? {} : { body }) });
      const response = await fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      try { if (response.status !== 402) throw new Error('OFFLINE_RESOURCE_QUOTE_UNAVAILABLE'); return response.headers; }
      finally { await response.body?.cancel(); }
    },
  };
}
export type OfflineResourcePolicy = ReturnType<typeof createOfflineResourcePolicy>;
