import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

it.each(['first use', 'existing member'])('%s uses the native owner and executes only the approved original purchase through member Pay', async mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-host-purchase-')));
  const registration = randomUUID(), memberId = randomUUID(), label = 'Independent local agent';
  const intent = { requestId: 'one', resourceId: 'resource', reason: 'A price for my research' };
  const fixedUrl = 'https://merchant.example/api?coins=BTC,ETH,SOL&currency=usd';
  const contract = { resourceId: intent.resourceId, name: 'BTC, ETH and SOL prices in USD', method: 'GET', protocol: 'x402',
    query: { mode: 'fixed', fields: [], requiresAtLeastOne: false }, networkFeeCap: 'omit' };
  const receipt = { purchaseId: 'original', operationId: intent.requestId, resourceId: intent.resourceId,
    status: 'PAID', paymentStatus: 'PAID', deliveryStatus: 'COMPLETE', policyCode: 'APPROVED', amount: '1000',
    network: 'solana', assetId: 'fixture', assetDecimals: 6, transaction: 'fixture' };
  const mppReceipt = { ...receipt, purchaseId: 'original-mpp', operationId: 'original-mpp', resourceId: 'fixture-sol-mpp' };
  const entry = join(root, 'host.cjs');
  const first = mode === 'first use';
  const client = new Client({ name: 'independent-host-fixture', version: '1' });
  try {
    // Substitute only the OS registration and the native owner/payment service.
    // Both installed front doors, the signed-owner CLI arguments and both MCP transports use their production code.
    await build({ entryPoints: [resolve(first ? 'scripts/first-use-mcp.ts' : 'scripts/local-plugin-mcp.ts')],
      outfile: entry, bundle: true, platform: 'node', format: 'cjs',
      define: { __YOSH_LOCAL_AUTH_DEV__: 'true', __YOSH_PLUGIN_DEV__: 'true', __YOSH_STANDALONE_DEV__: 'true', __YOSH_RC5__: 'false' },
      plugins: [{ name: 'registered-host-fixture', setup(builder) {
        builder.onResolve({ filter: /\/installed-host$/ }, () => ({ path: 'binding', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const resolveInstalledHost = () => (' + JSON.stringify({ registration, label }) + ');',
        }));
      } }] });
    symlinkSync(process.execPath, join(root, 'node'));
    writeFileSync(join(root, 'standalone.cjs'), 'console.log(JSON.stringify({enabled:false,connectionState:"disconnected",paused:true}));');
    writeFileSync(join(root, 'mainnet.cjs'), `
      const fs = require('node:fs');
      const action = process.argv[2];
      if (action === 'start') process.exit(0);
      if (action === 'describe-host-resource') {
        const args = process.argv.slice(3), input = JSON.parse(fs.readFileSync(0, 'utf8'));
        fs.appendFileSync('resource-calls', JSON.stringify({args,input}) + '\\n');
        if (input.resourceId !== ${JSON.stringify(intent.resourceId)}) {
          console.error('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED'); process.exit(1);
        }
        console.log(JSON.stringify(${JSON.stringify(contract)}));
      } else if (action === 'authorize-host-purchase') {
        const args = process.argv.slice(3);
        const intent = JSON.parse(fs.readFileSync(0, 'utf8'));
        fs.appendFileSync('owner-calls', JSON.stringify({args,intent}) + '\\n');
        if (!fs.existsSync('approve')) { console.error('LOCAL_CONFIRMATION_DECLINED'); process.exit(1); }
        console.log(JSON.stringify({memberId:${JSON.stringify(memberId)},requestId:intent.requestId,resourceId:intent.resourceId,
          protocol:'x402',url:${JSON.stringify(fixedUrl)}}));
      } else if (action === 'lookup-host-purchase-member') {
        fs.appendFileSync('member-calls', JSON.stringify(process.argv.slice(3)) + '\\n');
        console.log(JSON.stringify({memberId:${JSON.stringify(memberId)}}));
      } else if (action === 'install-mcp') {
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const {method,params,id} = JSON.parse(line);
          if (id === undefined) return;
          let result;
          if (method === 'initialize') result = {protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
          else if (method === 'tools/list') result = {tools:[]};
          else if (method === 'tools/call') {
            const text = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
            fs.appendFileSync('pay-calls',JSON.stringify({tool:params.name,member:process.env.YOSH_CARD_MEMBER_ID,args:params.arguments})+'\\n');
            if (params.name === 'get_purchase_delivery') result = text({
              purchaseId:params.arguments.purchaseId, encoding:'base64', contentType:'application/json', totalBytes:2, offset:0, nextOffset:null, chunk:'e30='
            });
            else if (params.name === 'recover_purchase_delivery') result = params.arguments.purchaseId === ${JSON.stringify(mppReceipt.purchaseId)}
              ? text(${JSON.stringify(mppReceipt)}) : {isError:true,content:[{type:'text',text:'PURCHASE_NOT_FOUND: unknown owner-bound order.'}]};
            else if (params.name === 'get_purchase') result = fs.existsSync('paid') ? text(${JSON.stringify(receipt)})
              : {isError:true,content:[{type:'text',text:'PURCHASE_NOT_FOUND: read only.'}]};
            else if (params.name === 'curl') { fs.writeFileSync('paid','1'); result = text({}); }
            else throw new Error('unexpected tool');
          } else result = {};
          console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
        });
      } else process.exit(3);
    `);
    const hostArgs = ['--registration', registration, '--label', label];
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, ...(first ? hostArgs : ['--data-dir', root])],
      cwd: root, stderr: 'ignore', env: { PATH: '/usr/bin:/bin', ...(first ? {} : { YOSH_VERIFIED_REGISTRATION: registration,
        YOSH_VERIFIED_HOST_LABEL: label, YOSH_VERIFIED_LEGACY_MEMBER: memberId, YOSH_CARD_MEMBER_ID: memberId }) } }));
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    expect(tools.find(tool => tool.name === 'describe_purchase_resource')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find(tool => tool.name === 'request_purchase')?.description).toContain('describe_purchase_resource');
    expect(names).toContain('request_purchase');
    expect(names).toContain(first ? 'list_account_purchases' : 'open_local_settings');
    const describe = (args: Record<string, unknown>) => client.callTool({ name: 'describe_purchase_resource', arguments: args });
    expect((await describe({ resourceId: intent.resourceId, url: fixedUrl })).isError).toBe(true);
    expect(existsSync(join(root, 'resource-calls'))).toBe(false);
    expect(await describe({ resourceId: 'unknown' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED') }] });
    const result = await describe({ resourceId: intent.resourceId });
    expect(result.isError).not.toBe(true);
    const described = JSON.parse(z.array(z.object({ text: z.string() })).parse(result.content)[0].text);
    expect(described).toEqual(contract);
    const wrongNetwork = await client.callTool({ name: 'request_purchase', arguments: { ...intent, environment: 'devnet' } });
    expect(wrongNetwork.isError).toBe(true);
    expect(existsSync(join(root, 'owner-calls'))).toBe(false);
    expect(existsSync(join(root, 'pay-calls'))).toBe(false);
    const buy = (offset?: number) => client.callTool({ name: 'request_purchase', arguments: { ...intent, ...(offset === undefined ? {} : {deliveryOffset: offset}) } });
    expect(await buy()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('LOCAL_CONFIRMATION_DECLINED') }] });
    expect(existsSync(join(root, 'pay-calls'))).toBe(false);
    writeFileSync(join(root, 'approve'), '1');
    for (let attempt = 0; attempt < 2; attempt++) {
      const [{ text }] = z.array(z.object({ type: z.literal('text'), text: z.string() })).length(1).parse((await buy(attempt === 0 ? undefined : 0)).content);
      expect(JSON.parse(text)).toEqual({ ...receipt, delivery: { encoding: 'json', contentType: 'application/json', value: {} } });
    }
    const log = (file: string) => readFileSync(join(root, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(log('owner-calls')).toEqual([{args: hostArgs, intent}, {args: hostArgs, intent}, {args: hostArgs, intent:{...intent, existingOnly:true}}]);
    expect(log('resource-calls')).toEqual([{args: hostArgs, input: {resourceId:'unknown'}}, {args: hostArgs, input:{resourceId:intent.resourceId}}]);
    const lookup = { tool: 'get_purchase', member: memberId, args: { operationId: intent.requestId } };
    const delivery = { tool: 'get_purchase_delivery', member: memberId, args: { purchaseId: receipt.purchaseId, offset: 0 } };
    expect(log('pay-calls')).toEqual([lookup, { tool: 'curl', member: memberId, args: { operation_id: intent.requestId, url: fixedUrl } },
      lookup, delivery, lookup, delivery]);
    if (first) {
      const recover = (purchaseId: string) => client.callTool({ name: 'recover_purchase_delivery', arguments: { purchaseId, environment: 'mainnet' } });
      expect(await recover('unknown')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('PURCHASE_NOT_FOUND') }] });
      expect(await recover(mppReceipt.purchaseId)).toMatchObject({ content: [{ text: expect.stringContaining('"encoding":"json"') }] });
      expect(log('member-calls')).toEqual([hostArgs, hostArgs]);
      expect(log('pay-calls').slice(6)).toEqual([
        { tool: 'recover_purchase_delivery', member: memberId, args: { purchaseId: 'unknown' } },
        { tool: 'recover_purchase_delivery', member: memberId, args: { purchaseId: mppReceipt.purchaseId } },
        { ...delivery, args: { purchaseId: mppReceipt.purchaseId, offset: 0 } }]);
      expect(log('owner-calls')).toHaveLength(3);
    }
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
