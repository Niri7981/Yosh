import { buildSync } from 'esbuild';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { executeHostPurchase } from '../../src/modules/mcp/local-host-purchase';
import { paidResource } from '../../src/modules/resources/paid-resources';
import { PAY_MCP_PATH, productionPayFixture, TEST_DELIVERY } from '../helpers/pay-production-fixture';

it('settles and delivers once per authorized member through the official Pay executable, including repeated order IDs across clients', async () => {
  const f = await productionPayFixture({ payMcp: true });
  const clients: Client[] = [];
  try {
    const second = f.app.createCardMember('Independent fixture host').member;
    f.app.setAgentConnection(true, f.origin, second.id);
    await f.app.createSpendGrant({ totalLimit: '200000', singleLimit: '200000', expiresAt: Date.now() + 600000 }, second.id);
    const wrapper = join(f.directory, 'mcp.cjs');
    buildSync({entryPoints: [resolve('scripts/pay-dev-mcp.ts')], platform: 'node', bundle: true, format: 'cjs',
      outfile: wrapper, define: {__YOSH_RC5__: 'false'}});
    copyFileSync(PAY_MCP_PATH, join(f.directory, 'pay-mcp'));
    writeFileSync(join(f.directory, 'pay-dev-runtime.json'), JSON.stringify({version: 1, profile: 'isolated-pay-dev',
      origin: f.origin, memberId: f.memberId}), {mode: 0o600});
    const input = {resourceId: 'market-snapshot', requestId: 'same-task', reason: 'Fixture market quote'};
    const url = new URL(paidResource('market-snapshot').path, f.origin).href;
    const originalReceipts = new Map<string, string>();
    for (const memberId of [f.memberId, second.id]) {
      const client = new Client({name: 'independent-yosh-acceptance', version: '1'});
      await client.connect(new StdioClientTransport({command: process.execPath, args: [wrapper, '--data-dir', f.directory],
        env: {HOME: f.directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test', YOSH_CARD_MEMBER_ID: memberId}, stderr: 'ignore'}));
      clients.push(client);
      const run = () => executeHostPurchase({memberId, url, resourceId: input.resourceId, requestId: input.requestId, protocol: 'x402'},
        input, (name, args, signal) => client.callTool({name, arguments: args}, undefined, {signal}), new AbortController().signal);
      const receipt = await run();
      expect(receipt).toMatchObject({paymentStatus:'PAID', deliveryStatus:'COMPLETE', amount:'200000', operationId:input.requestId,
        delivery: { encoding: 'json', value: TEST_DELIVERY }});
      expect(await run()).toEqual(receipt);
      const stored = f.app.ledger.getOwned(receipt.purchaseId, memberId);
      expect(stored?.data).toEqual(TEST_DELIVERY);
      expect(stored?.ownerCardMemberId).toBe(memberId);
      originalReceipts.set(memberId, receipt.purchaseId);
    }
    expect(f.paidRequests).toBe(2);
    expect(f.signatureCalls).toBe(2);
    expect(f.transactions.size).toBe(2);
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({paid:'400000', reserved:'0'});
    expect(new Set(originalReceipts.values()).size).toBe(2);
    await f.reopenWithoutPayExecutor();
    for (const [memberId, purchaseId] of originalReceipts) {
      expect(f.app.ledger.getOwned(purchaseId, memberId)).toMatchObject({status:'PAID', deliveryStatus:'COMPLETE', data:TEST_DELIVERY});
      expect(f.app.ledger.getOwned(purchaseId, memberId === f.memberId ? second.id : f.memberId)).toBeUndefined();
    }
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await f.close();
  }
}, 60000);
