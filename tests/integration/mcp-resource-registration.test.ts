import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createAgentServer } from '../../src/modules/mcp/server';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { discoverResource } from '../../src/modules/resources/mainnet-resource-discovery';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import fixture from '../fixtures/agent402-crypto-price-v2.json';

it('uses generic MCP discovery-to-registration without management access, Grant or execution', async () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true }); ledger.resources.initialize([]);
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
  const outbound = vi.fn(async () => new Headers({ 'payment-required': Buffer.from(JSON.stringify(fixture)).toString('base64') }));
  const purchase = vi.fn();
  const server = createAgentServer(async () => ({}), purchase,
    async input => ledger.resources.recordDiscovery(await discoverResource(input, outbound), principal), undefined, undefined,
    async input => ledger.resources.addDiscovered(input, principal));
  const client = new Client({ name: 'generic-registration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const parse = (result: Awaited<ReturnType<typeof client.callTool>>) => {
    const content = result.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('missing text');
    return JSON.parse(String(content[0].text));
  };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const discovery = parse(await client.callTool({ name: 'discover_x402_resource', arguments: {
      url: 'https://agent402.tools/api/crypto-price', method: 'GET',
      requestInputs: { query: { coins: { type: 'string', required: true }, currency: { type: 'string', required: false } } },
      sample: { query: { coins: 'BTC,ETH,SOL', currency: 'usd' } },
      deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 262144 },
      documentation: { urls: ['https://agent402.tools/tools/crypto-price'], uncertainties: ['Recovery has not been verified.'] },
    } }));
    expect(discovery).toMatchObject({ paymentSent: false, network: MAINNET_NETWORK, assetId: MAINNET_USDC_MINT });
    const args = { discoveryId: discovery.discoveryId, resourceId: 'fixture-agent-price', providerId: 'agent402.tools', displayName: 'Fixture crypto price' };
    const invalid = await client.callTool({ name: 'register_x402_resource', arguments: { ...args, wallet: 'other', grant: true } });
    expect(invalid.isError).toBe(true);
    const results = await Promise.all([client.callTool({ name: 'register_x402_resource', arguments: args }), client.callTool({ name: 'register_x402_resource', arguments: args })]);
    expect(results.every(result => !result.isError)).toBe(true);
    expect(parse(results[0])).toMatchObject({ source: 'agent', state: 'ACTIVE' });
    expect(ledger.resources.list().filter(entry => entry.source === 'agent')).toHaveLength(1);
    expect(ledger.activeSpendGrant(Date.now(), principal.cardMemberId, 'live_mainnet', args.resourceId)).toBeUndefined();
    expect(ledger.listForAdministration()).toHaveLength(0); expect(outbound).toHaveBeenCalledTimes(1); expect(purchase).not.toHaveBeenCalled();
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).not.toContain('create_spend_grant');
  } finally { await client.close(); await server.close(); ledger.close(); }
});
