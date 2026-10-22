import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { paidResource } from '../../src/modules/resources/paid-resources';
import { createPayAuthorityAdapter } from '../../src/modules/payment/pay-authority-adapter';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { readFileSync, unlinkSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { readConnection } from '../../src/modules/mcp/connection';
import { createIsolatedPayExecution } from '../../src/modules/payment/isolated-pay-execution';

/** Run in a child process so SIGKILL bypasses every catch/finally and releases
 * SQLite ownership exactly as an unexpected backend process death would. */
let stage = 'input';
async function main() {
  const input = z.object({ YOSH_DATA_DIR: z.string(), TEST_RPC_URL: z.string(),
    TEST_MERCHANT_ORIGIN: z.string(), TEST_PAY_ENGINE_PATH: z.string(), TEST_BUYER_KEYPAIR: z.string(),
    TEST_REQUEST_ID: z.string(), SOLANA_RPC_URL: z.string() }).parse(process.env);
  const keyBytes = Uint8Array.from(z.array(z.number().int().min(0).max(255)).length(64)
    .parse(JSON.parse(readFileSync(input.TEST_BUYER_KEYPAIR, 'utf8'))));
  unlinkSync(input.TEST_BUYER_KEYPAIR);
  const signer = await createKeyPairSignerFromBytes(keyBytes);
  keyBytes.fill(0);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (value, init) => {
    const url = value instanceof Request ? new URL(value.url) : new URL(String(value));
    if (url.origin === input.SOLANA_RPC_URL) return nativeFetch(input.TEST_RPC_URL, init);
    if (url.origin === 'https://facilitator.yosh-isolated.invalid') return nativeFetch(`${input.TEST_MERCHANT_ORIGIN}${url.pathname}`, init);
    if (url.origin !== input.TEST_MERCHANT_ORIGIN) throw new Error('UNEXPECTED_EXTERNAL_NETWORK');
    return nativeFetch(value, init);
  };
  stage = 'factory';
  let authority: ReturnType<typeof createPayAuthorityAdapter> | undefined;
  const payMcp = process.env.TEST_PAY_MCP_FIRST === '1';
  const execution = createIsolatedPayExecution({ directory: input.YOSH_DATA_DIR, signer,
    enginePath: input.TEST_PAY_ENGINE_PATH, merchantOrigin: input.TEST_MERCHANT_ORIGIN, rpcUrl: input.TEST_RPC_URL,
    ...(payMcp ? { unsignedPreparation: context => {if (!authority) throw new Error('AUTHORITY_REQUIRED'); return authority.takeUnsigned(context);} } : {}) });
  stage = 'runtime';
  const app = new AppRuntime(input.YOSH_DATA_DIR, {
    initializeWallet: async () => ({ address: signer.address, reused: true }),
    fetcher: execution.quoteFetcher, paymentExecutor: execution.executor, timeZone: () => 'Asia/Shanghai',
  });
  stage = 'wallet';
  await app.initializeWallet();
  const marker = app.ledger.markSubmissionAttempt.bind(app.ledger);
  app.ledger.markSubmissionAttempt = (...args) => {
    if (process.env.TEST_CRASH_BEFORE_MARKER === '1') process.kill(process.pid, 'SIGKILL');
    marker(...args);
    if (process.env.TEST_CRASH_AFTER_HTTP !== '1') {
      process.kill(process.pid, 'SIGKILL');
      throw new Error('PROCESS_DID_NOT_EXIT');
    }
  };
  stage = 'authentication';
  const connection = readConnection(input.YOSH_DATA_DIR);
  const principal = app.authenticateAgent(new Request(`${input.TEST_MERCHANT_ORIGIN}/api/agent/purchases`, {
    headers: { authorization: `Bearer ${connection.token}` },
  }), 'request_purchase');
  if (payMcp) {
    authority = createPayAuthorityAdapter({ directory: input.YOSH_DATA_DIR, runtime: () => app, config: () => loadPaymentConfig(),
      executor: execution.executor, origin: input.TEST_MERCHANT_ORIGIN, rpcUrl: input.TEST_RPC_URL });
    const server = createServer(async (incoming, outgoing) => {
      try {
        const authenticated = app.authenticateAgent(new Request(`${input.TEST_MERCHANT_ORIGIN}/pay`, {
          headers: { authorization: incoming.headers.authorization ?? '' } }), 'request_purchase');
        const chunks: Buffer[] = []; let size=0;
        for await (const chunk of incoming) { const buffer=Buffer.from(chunk);size+=buffer.length;if(size>131_072) throw new Error('INPUT_TOO_LARGE');chunks.push(buffer); }
        const raw: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let result: unknown;
        if (incoming.url === '/pay/authorize') result = await authority!.authorize(raw, authenticated);
        else {
          const value=z.object({facts:z.unknown(),unsigned:z.unknown().optional()}).strict().parse(raw);
          if (incoming.url === '/pay/plan') result=authority!.plan(value.facts,authenticated);
          else if (incoming.url === '/pay/execute') result=await authority!.execute(value.facts,value.unsigned,authenticated);
          else throw new Error('PATH_REJECTED');
        }
        outgoing.writeHead(200,{'content-type':'application/json'});outgoing.end(JSON.stringify(result));
      } catch {outgoing.writeHead(403);outgoing.end();}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address || typeof address==='string') throw new Error('PORT_REQUIRED');
    const descriptor=join(input.YOSH_DATA_DIR,'crash-pay-host.json');
    writeFileSync(descriptor,JSON.stringify({origin:`http://127.0.0.1:${address.port}`,caller:principal.cardMemberId,token:connection.token,timeout_ms:5000}),{mode:0o600});
    const client=new Client({name:'pay-mcp-crash-test',version:'1'});
    const transport=new StdioClientTransport({command:resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'),args:[descriptor],cwd:input.YOSH_DATA_DIR,
      env:{NODE_ENV:'test',HOME:input.YOSH_DATA_DIR,PATH:'/usr/bin:/bin'},stderr:'ignore'});
    await client.connect(transport);stage='real-pay-mcp-tools-call';
    try {await client.callTool({name:'curl',arguments:{operation_id:input.TEST_REQUEST_ID,url:new URL(paidResource('market-snapshot').path,input.TEST_MERCHANT_ORIGIN).href}});}
    finally {await client.close();server.close();}
    throw new Error('PAY_MCP_DURABLE_MARKER_NOT_REACHED');
  }
  stage = 'purchase';
  const result = await app.requestPurchase({ requestId: input.TEST_REQUEST_ID, resourceId: 'market-snapshot',
    reason: 'Offline production integration check' }, input.TEST_MERCHANT_ORIGIN, principal);
  stage += `:${result.status}`;
  throw new Error('DURABLE_MARKER_NOT_REACHED');
}

main().catch(() => { process.stderr.write(`ISOLATED_CRASH_WORKER_FAILED:${stage}\n`); process.exitCode = 1; });
