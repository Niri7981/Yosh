import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createAgentServer } from '../../src/modules/mcp/server';
import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';
import { PurchaseRequestInputSchema } from '../../src/modules/purchases/request-paid-resource-purchase';

const request = { requestId: 'namespace-isolation-request', resourceId: 'market-snapshot', reason: 'Read fixture data' };
const namespaceInput = { ...request, keychainNamespace: 'com.yosh.pay-development' };

it('Agent purchase input cannot select a Keychain namespace', () => {
  expect(PurchaseRequestInputSchema.safeParse(request).success).toBe(true);
  expect(PurchaseRequestInputSchema.safeParse(namespaceInput).success).toBe(false);
  expect(PAY_DEVELOPMENT_PROFILE.keychainNamespace).toBe('com.yosh.pay-development.v011rc5');
});

it('MCP rejects namespace input before invoking the purchase handler', async () => {
  const requestPurchase = vi.fn(async () => ({ status: 'NOT_STARTED' }));
  const server = createAgentServer(async () => ({}), requestPurchase);
  const client = new Client({ name: 'namespace-isolation-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: 'request_purchase', arguments: namespaceInput });
    expect(result.isError).toBe(true);
    expect(requestPurchase).not.toHaveBeenCalled();
    expect(PAY_DEVELOPMENT_PROFILE.keychainNamespace).toBe('com.yosh.pay-development.v011rc5');
  } finally { await client.close(); await server.close(); }
});
