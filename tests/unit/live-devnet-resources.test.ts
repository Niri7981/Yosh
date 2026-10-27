import { expect, it } from 'vitest';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_USDC_MINT, resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { RuntimeResourceSchema } from '../../src/modules/resources/runtime-resource-registry';
import { prepareDiscovery } from '../../src/modules/resources/mainnet-resource-discovery';

const buyer = '11111111111111111111111111111111';
const resource = { resourceId: 'test-api', providerId: 'test.example', displayName: 'Test API',
  request: { url: 'https://test.example/data', method: 'GET', access: 'https', headers: { accept: 'application/json' } },
  network: DEVNET_NETWORK, mint: DEVNET_USDC_MINT, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '1000' };

it('loads registered Devnet resources with an explicit wallet and no Demo identity', () => {
  const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_devnet', YOSH_PAY_MCP_DEVNET: '1',
    YOSH_MAINNET_RESOURCES: JSON.stringify([resource]) }, 'live_devnet', buyer);
  expect(config).toMatchObject({ buyer, mode: 'live_devnet', network: DEVNET_NETWORK,
    mint: DEVNET_USDC_MINT, registeredResources: [resource] });
  expect(config.productionExecutionEnabled).toBe(false);
});

it('accepts canonical Devnet registration and rejects a cross-network mint', () => {
  expect(RuntimeResourceSchema.safeParse(resource).success).toBe(true);
  expect(RuntimeResourceSchema.safeParse({ ...resource, mint: MAINNET_USDC_MINT }).success).toBe(false);
});

it('prepares discovery against the explicitly selected network', () => {
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
  expect(prepareDiscovery({ url: resource.request.url }, environment).policy).toMatchObject({
    network: DEVNET_NETWORK, mint: DEVNET_USDC_MINT });
});
