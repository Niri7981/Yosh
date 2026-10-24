import { payMainnetConsentDecision } from '../../src/modules/payment/pay-authorization-outcome';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentRequired } from '@x402/core/types';
import { z } from 'zod';
import { vi } from 'vitest';
import { POST } from '../../src/app/api/agent/purchases/route';
import { GET } from '../../src/app/api/agent/route';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { readConnection } from '../../src/modules/mcp/connection';
import { paidResource } from '../../src/modules/resources/paid-resources';
import { createPayAuthorityAdapter } from '../../src/modules/payment/pay-authority-adapter';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { createIsolatedPayExecution } from '../../src/modules/payment/isolated-pay-execution';
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, TOKEN_PROGRAM } from '../../src/modules/payment/payment-config';
import { PurchaseRequestResultSchema } from './pay-production-result';

export const PAY_MCP_PATH = resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp');
export const ENGINE_PATH = resolve('build.noindex/pay-protocol-engine/yosh-execution-protocol');
export const FAKE_RPC_CONFIG_URL = 'https://rpc.yosh-isolated.invalid';
export const TEST_DELIVERY = Object.freeze({ resource_id: 'sol-market-snapshot', asset: 'SOL',
  as_of: '2026-10-18T04:00:00Z', source_label: 'Offline production-module integration fixture',
  spot_price_usd: 150, is_demo_snapshot: true });

export function deferred() {
  let resolvePromise: () => void = () => { throw new Error('DEFERRED_NOT_INITIALIZED'); };
  const promise = new Promise<void>(done => { resolvePromise = done; });
  return { promise, resolve: resolvePromise };
}

/** Fail immediately if the purchase finishes before reaching the expected race boundary. */
export function reachBoundary(boundary: ReturnType<typeof deferred>, operation: Promise<unknown>) {
  return Promise.race([boundary.promise, operation.then(() => { throw new Error('EXPECTED_EXECUTION_BOUNDARY_NOT_REACHED'); })]);
}

const RpcRequest = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]),
  method: z.string(), params: z.array(z.unknown()).optional() });
const TransactionPayload = z.object({ transaction: z.string() }).passthrough();
type StoredTransaction = { signature: string; memo: string; wire: string };
type ExecutionOptions = Parameters<typeof createIsolatedPayExecution>[0];
type RuntimeGlobals = typeof globalThis & { __yosh?: { runtime?: AppRuntime } };

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Production authority, ledger, signer validation and reconciliation stay real.
 * Only the merchant, chain and ephemeral signer are fixtures. Every HTTP request
 * is local; unexpected external endpoints and RPC submissions fail the test. */
export async function productionPayFixture(options: { hooks?: ExecutionOptions['hooks'];
  signerBarrier?: ReturnType<typeof deferred>; preflightBarrier?: ReturnType<typeof deferred>; grant?: boolean; payMcp?: boolean; quoteAmount?: string;
  routeLevelQuote?: boolean; quoteExtensions?: PaymentRequired['extensions']; quoteAlternatives?: 'price' | 'metadata' | 'duplicate' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-pay-production-'));
  chmodSync(directory, 0o700);
  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const sponsor = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const memorySigner = await createKeyPairSignerFromBytes(new Uint8Array(buyer.secretKey));
  const signerStarted = deferred();
  const preflightStarted = deferred();
  let signatureCalls = 0;
  const signer = { ...memorySigner, async signTransactions(...args: Parameters<typeof memorySigner.signTransactions>) {
    signatureCalls++;
    signerStarted.resolve();
    await options.signerBarrier?.promise;
    return memorySigner.signTransactions(...args);
  } };
  const transactions = new Map<string, StoredTransaction>();
  const rpcMethods: string[] = [];
  const paidHeaders: string[] = [];
  const paidRequestAccepts: string[] = [];
  const merchantArrived = deferred();
  let merchantResponseBarrier: ReturnType<typeof deferred> | undefined;
  let loseMerchantResponse = false;
  let loseAgentResponse = false;
  let unpaidRequests = 0;
  let paidRequests = 0;
  let networkError: Error | undefined;
  let app: AppRuntime | undefined;
  let execution: ReturnType<typeof createIsolatedPayExecution> | undefined;
  let origin = '';
  let authority: ReturnType<typeof createPayAuthorityAdapter> | undefined;
  let authorityFailure: 'deny' | 'timeout' | 'unavailable' | 'consent' | undefined;
  let loseControllerAck = false;
  let mutateUnsigned = false;
  let failPayInterpretation = false;
  let reflectCredential = false;
  let payProbeOffer: PaymentRequired['accepts'][number] | undefined;
  let lastFacts: unknown;
  let lastUnsigned: unknown;
  let bridgeCalls = 0;
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const globals = globalThis as RuntimeGlobals;
  const priorRuntime = globals.__yosh;
  const nativeFetch = globalThis.fetch;

  function acceptPayload(raw: unknown) {
    const payload = PaymentPayloadV2Schema.parse(raw);
    const wire = TransactionPayload.parse(payload.payload).transaction;
    const transaction = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
    const buyerIndex = transaction.message.staticAccountKeys.findIndex(key => key.equals(buyer.publicKey));
    if (buyerIndex < 0 || !transaction.signatures[buyerIndex]?.some(byte => byte !== 0)) throw new Error('BUYER_SIGNATURE_MISSING');
    if (!transaction.message.staticAccountKeys[0].equals(sponsor.publicKey)) throw new Error('SPONSOR_CHANGED');
    transaction.sign([sponsor]);
    const signature = getBase58Decoder().decode(transaction.signatures[0]);
    const memo = typeof payload.accepted.extra?.memo === 'string' ? payload.accepted.extra.memo : '';
    const stored = { signature, memo, wire: Buffer.from(transaction.serialize()).toString('base64') };
    transactions.set(signature, stored);
    return stored;
  }

  const rpc = createServer(async (request, response) => {
    try {
      const input = RpcRequest.parse(JSON.parse((await requestBody(request)).toString('utf8')));
      rpcMethods.push(input.method);
      const tokenAccount = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account',
        info: { owner, mint: DEVNET_USDC_MINT, state: 'initialized', tokenAmount: { amount: '100000000', decimals: 6 } } } } });
      let result: unknown;
      switch (input.method) {
        case 'getGenesisHash': result = DEVNET_GENESIS; break;
        case 'getLatestBlockhash': result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } }; break;
        case 'getBlockHeight': result = 1; break;
        case 'getBalance': result = { context: { slot: 1 }, value: 100_000_000 }; break;
        case 'getAccountInfo': {
          const encoding=z.object({encoding:z.string().optional()}).passthrough().safeParse(input.params?.[1]);
          if(input.params?.[0]===DEVNET_USDC_MINT && encoding.success && encoding.data.encoding==='base64') {
            const bytes=Buffer.alloc(82);bytes[44]=6;bytes[45]=1;
            result={context:{slot:1},value:{owner:TOKEN_PROGRAM,data:[bytes.toString('base64'),'base64'],lamports:1000000,executable:false,rentEpoch:0,space:82}};
          } else result = { context: { slot: 1 }, value: tokenAccount(buyer.publicKey.toBase58()) };
          break;
        }
        case 'getMultipleAccounts': result = { context: { slot: 1 }, value: [
          { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
          tokenAccount(buyer.publicKey.toBase58()), tokenAccount(merchant.publicKey.toBase58()),
        ] }; break;
        case 'simulateTransaction': result = { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 100 } }; break;
        case 'getSignaturesForAddress': result = [...transactions.values()].map(item => ({ signature: item.signature,
          memo: `[${item.memo.length}] ${item.memo}`, slot: 1, err: null, blockTime: 1, confirmationStatus: 'confirmed' })); break;
        case 'getTransaction': {
          const stored = transactions.get(String(input.params?.[0]));
          result = stored ? { transaction: [stored.wire, 'base64'], meta: { err: null } } : null;
          break;
        }
        case 'isBlockhashValid': result = { context: { slot: 1 }, value: true }; break;
        default: throw new Error(`UNSUPPORTED_FAKE_RPC_METHOD:${input.method}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    } catch (error) {
      networkError = error instanceof Error ? error : new Error('FAKE_RPC_FAILURE');
      response.writeHead(500); response.end();
    }
  });

  async function agentRequest(incoming: IncomingMessage, outgoing: ServerResponse) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
    const request = new Request(`${origin}${incoming.url ?? '/'}`, { method: incoming.method, headers,
      ...(incoming.method === 'POST' ? { body: await requestBody(incoming) } : {}) });
    const response = incoming.method === 'GET' ? await GET(request) : await POST(request);
    if (loseAgentResponse && incoming.method === 'POST') { loseAgentResponse = false; outgoing.destroy(); return; }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url?.startsWith('/pay/')) {
        bridgeCalls++;
        try {
          if (!app || !authority) throw new Error('PAY_BRIDGE_NOT_READY');
          const auth = new Request(`${origin}${incoming.url}`, { headers: { authorization: incoming.headers.authorization ?? '' } });
          const principal = app.authenticateAgent(auth, 'request_purchase');
          const bytes = await requestBody(incoming);
          if (bytes.length > 131_072) throw new Error('PAY_BRIDGE_INPUT_TOO_LARGE');
          const raw: unknown = JSON.parse(bytes.toString('utf8'));
          let result: unknown;
          if (incoming.url === '/pay/authorize') {
            lastFacts = raw;
            if (authorityFailure === 'unavailable') throw new Error('TEST_AUTHORITY_UNAVAILABLE');
            if (authorityFailure === 'timeout') { outgoing.setTimeout(200, () => outgoing.destroy()); return; }
            result = authorityFailure === 'deny' ? { allow: false } : authorityFailure === 'consent'
              ? payMainnetConsentDecision(() => { throw new Error('PAY_MAINNET_ACCEPTANCE_REQUIRED'); }) : authority.authorizeSpend(raw, principal);
          } else {
            const input = z.object({ facts: z.unknown(), unsigned: z.unknown().optional() }).strict().parse(raw);
            if (incoming.url === '/pay/plan') { lastFacts = input.facts; result = await authority.prepareControlled(input.facts, principal); }
            else if (incoming.url === '/pay/execute') {
              lastUnsigned = input.unsigned;
              let prepared = input.unsigned;
              if (mutateUnsigned) {
                const parsed = z.object({transaction:z.string(), recentBlockhash:z.string(), lastValidBlockHeight:z.string()}).parse(prepared);
                const tx = VersionedTransaction.deserialize(Buffer.from(parsed.transaction, 'base64'));
                const transfer = tx.message.compiledInstructions.find(ix => ix.data[0] === 12 && ix.data.length === 10);
                if (!transfer) throw new Error('TEST_TRANSFER_NOT_FOUND');
                transfer.data[1] ^= 1;
                prepared = { ...parsed, transaction: Buffer.from(tx.serialize()).toString('base64') };
              }
              result = await authority.execute(input.facts, prepared, principal);
              if (failPayInterpretation) result = { status: 402, headers: [], body: [] };
              if (loseControllerAck) { loseControllerAck = false; outgoing.destroy(); return; }
            } else throw new Error('PAY_BRIDGE_PATH_REJECTED');
          }
          outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(result));
        } catch {
          outgoing.writeHead(403, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ code: 'PAY_BRIDGE_REJECTED' }));
        }
        return;
      }
      if (incoming.url?.startsWith('/api/agent')) { await agentRequest(incoming, outgoing); return; }
      if (incoming.url === '/supported') {
        preflightStarted.resolve();
        await options.preflightBarrier?.promise;
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET_NETWORK,
          extra: { feePayer: sponsor.publicKey.toBase58() } }], extensions: [], signers: {} })); return;
      }
      const encoded = incoming.headers['payment-signature'];
      if (typeof encoded !== 'string') {
        unpaidRequests++;
        const request = new URL(incoming.url ?? '/', origin);
        const challenge: PaymentRequired = { x402Version: 2,
          resource: { url: options.routeLevelQuote ? `${request.origin}${request.pathname}` : request.href,
            ...(options.routeLevelQuote ? { description: 'Offline route-level SDK compatibility fixture', mimeType: 'application/json' } : {}) },
          accepts: [payProbeOffer ?? { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount: options.quoteAmount ?? '200000',
            payTo: merchant.publicKey.toBase58(), maxTimeoutSeconds: 300,
            extra: { decimals: 6, feePayer: sponsor.publicKey.toBase58(), memo: `yosh-production-pay-isolated-${unpaidRequests}` } }],
          ...(options.quoteExtensions ? { extensions: options.quoteExtensions } : {}) };
        if (options.quoteAlternatives) {
          const quote = challenge.accepts[0];
          challenge.accepts.push(options.quoteAlternatives === 'price' ? { ...quote, amount: '400000' }
            : options.quoteAlternatives === 'metadata' ? { ...quote, extra: { ...quote.extra, memo: 'alternative-memo' } } : quote);
        }
        outgoing.writeHead(402, { 'payment-required': encodePaymentRequiredHeader(challenge), 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'PAYMENT_REQUIRED' })); return;
      }
      paidRequests++; paidHeaders.push(encoded); paidRequestAccepts.push(incoming.headers.accept ?? '');
      const original = acceptPayload(decodePaymentSignatureHeader(encoded));
      merchantArrived.resolve();
      await merchantResponseBarrier?.promise;
      if (loseMerchantResponse) { loseMerchantResponse = false; outgoing.destroy(); return; }
      outgoing.writeHead(200, { 'content-type': 'application/json', 'payment-response': encodePaymentResponseHeader({
        success: true, network: DEVNET_NETWORK, transaction: original.signature, payer: buyer.publicKey.toBase58(),
      }) });
      const transaction = VersionedTransaction.deserialize(Buffer.from(original.wire, 'base64'));
      const buyerIndex = transaction.message.staticAccountKeys.findIndex(key => key.equals(buyer.publicKey));
      outgoing.end(JSON.stringify(reflectCredential ? { ...TEST_DELIVERY, source_label: getBase58Decoder().decode(transaction.signatures[buyerIndex]) } : TEST_DELIVERY));
    } catch (error) {
      networkError = error instanceof Error ? error : new Error('FAKE_MERCHANT_FAILURE');
      outgoing.writeHead(500); outgoing.end();
    }
  });

  try {
    rpc.listen(0, '127.0.0.1'); server.listen(0, '127.0.0.1');
    await Promise.all([once(rpc, 'listening'), once(server, 'listening')]);
    const rpcAddress = rpc.address(); const serverAddress = server.address();
    if (!rpcAddress || typeof rpcAddress === 'string' || !serverAddress || typeof serverAddress === 'string') throw new Error('FAKE_PORT_MISSING');
    const rpcUrl = `http://127.0.0.1:${rpcAddress.port}`;
    origin = `http://127.0.0.1:${serverAddress.port}`;
    const environment: Record<string, string | undefined> = {
      YOSH_EXECUTION_MODE: 'live_devnet', APP2049_EXECUTION_MODE: undefined,
      YOSH_ENABLE_DEVNET_PURCHASES: '1', APP2049_ENABLE_DEVNET_PURCHASES: undefined,
      YOSH_ENABLE_MAINNET_EXECUTION: '0', APP2049_ENABLE_MAINNET_EXECUTION: undefined,
      YOSH_ENABLE_LEGACY_DEMO_TASKS: '0', APP2049_ENABLE_LEGACY_DEMO_TASKS: undefined,
      YOSH_USE_PRODUCT_WALLET: '0', APP2049_USE_PRODUCT_WALLET: undefined,
      YOSH_DATA_DIR: directory, APP2049_DATA_DIR: undefined,
      SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: FAKE_RPC_CONFIG_URL,
      SOLANA_DEVNET_RPC_URL: undefined, SOLANA_GENESIS_HASH: DEVNET_GENESIS,
      SOLANA_NETWORK: DEVNET_NETWORK, USDC_MINT: DEVNET_USDC_MINT,
      X402_FACILITATOR_URL: 'https://facilitator.yosh-isolated.invalid',
      DEMO_BUYER_PUBLIC_KEY: buyer.publicKey.toBase58(), DEMO_MERCHANT_PUBLIC_KEY: merchant.publicKey.toBase58(),
      DEMO_BUYER_PRIVATE_KEY: undefined, DEMO_BUYER_KEYPAIR: undefined, DEMO_BUYER_KEYCHAIN_SERVICE: undefined,
    };
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    const networkFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.origin === FAKE_RPC_CONFIG_URL) return nativeFetch(rpcUrl, init);
      if (url.origin === 'https://facilitator.yosh-isolated.invalid') return nativeFetch(`${origin}${url.pathname}`, init);
      if (url.origin !== origin && url.origin !== rpcUrl) throw new Error('UNEXPECTED_EXTERNAL_NETWORK');
      return nativeFetch(input, init);
    };
    vi.stubGlobal('fetch', networkFetch);
    execution = createIsolatedPayExecution({ directory, enginePath: ENGINE_PATH, merchantOrigin: origin, rpcUrl,
      signer, ...(options.payMcp ? { unsignedPreparation: context => { if (!authority) throw new Error('PAY_AUTHORITY_REQUIRED'); return authority.takeUnsigned(context); } } : {}), ...(options.hooks ? { hooks: options.hooks } : {}) });
    const dependencies = { initializeWallet: async () => ({ address: memorySigner.address, reused: true }),
      readWallets: async () => [{ id: 'mainnet' as const, label: 'Mainnet', address: null, status: 'missing' as const },
        { id: 'devnet' as const, label: 'Devnet · Test', address: memorySigner.address, status: 'available' as const }],
      timeZone: () => 'Asia/Shanghai', fetcher: execution.quoteFetcher, paymentExecutor: execution.executor };
    app = new AppRuntime(directory, dependencies);
    globals.__yosh = { runtime: app };
    if (options.payMcp) authority = createPayAuthorityAdapter({ directory, runtime: () => { if (!app) throw new Error('APP_CLOSED'); return app; },
      config: () => loadPaymentConfig(process.env, undefined, buyer.publicKey.toBase58()), executor: execution.executor, origin, rpcUrl });
    await app.initializeWallet();
    app.setDailyLimit('5000000');
    app.setAgentConnection(true, origin);
    if (options.grant !== false) app.createSpendGrant({ totalLimit: '5000000', singleLimit: '500000', expiresAt: Date.now() + 600_000 });
    const memberId = readConnection(directory).cardMemberId;

    return {
      directory, buyer, merchant, signer, signerStarted, preflightStarted, origin, rpcUrl, rpcMethods, paidHeaders, merchantArrived,
      execution, dependencies, acceptPayload, transactions,
      get app() { if (!app) throw new Error('APP_CLOSED'); return app; },
      get signatureCalls() { return signatureCalls; },
      get unpaidRequests() { return unpaidRequests; },
      get paidRequests() { return paidRequests; },
      get paidRequestAccepts() { return paidRequestAccepts; },
      memberId,
      get authority() { if (!authority) throw new Error('AUTHORITY_REQUIRED'); return authority; },
      get lastFacts() { return lastFacts; },
      get lastUnsigned() { return lastUnsigned; },
      get bridgeCalls() { return bridgeCalls; },
      authorityFailure(mode: 'deny' | 'timeout' | 'unavailable' | 'consent' | undefined) { authorityFailure = mode; },
      loseControllerAckOnce() { loseControllerAck = true; },
      mutateUnsigned() { mutateUnsigned = true; },
      failPayInterpretationOnce() { failPayInterpretation = true; },
      reflectCredential() { reflectCredential = true; },
      get principal() { return app!.authenticateAgent(new Request(`${origin}/pay/authorize`, { headers: { authorization: `Bearer ${readConnection(directory).token}` } }), 'request_purchase'); },
      controllerPost(path: string, body: unknown) { return nativeFetch(`${origin}${path}`, { method: 'POST', headers: {
        authorization: `Bearer ${readConnection(directory).token}`, 'content-type': 'application/json',
      }, body: JSON.stringify(body) }); },
      payRecord(operation: string) { return app?.ledger.getOwned(authority!.purchaseId(memberId, operation), memberId); },
      async connectPay(config: { caller?: string; token?: string; timeout?: number; member?: string } = {}) {
        const configFile = join(directory, `pay-host-${clients.length}.json`);
        writeFileSync(configFile, JSON.stringify({ origin, caller: config.caller ?? memberId,
          token: config.token ?? readConnection(directory, config.member).token, timeout_ms: config.timeout ?? 5000 }), { mode: 0o600 });
        const client = new Client({ name: 'pay-mcp-first-integration', version: '1' });
        const transport = new StdioClientTransport({ command: PAY_MCP_PATH, args: [configFile], cwd: directory,
          env: { NODE_ENV: 'test', HOME: directory, PATH: '/usr/bin:/bin' }, stderr: 'pipe' });
        await client.connect(transport); clients.push({ client, transport }); return client;
      },
      async callPay(client: Client, operation: string, freshOffer = false) {
        // Recovery tests must present the original offer. A fresh memo is a
        // different accepted offer and must now conflict, not silently replay.
        payProbeOffer = freshOffer ? undefined : app?.ledger.getOwned(authority!.purchaseId(memberId, operation), memberId)?.quote;
        return client.callTool({ name: 'curl', arguments: { operation_id: operation, url: new URL(paidResource('market-snapshot').path, origin).href } });
      },
      record(requestId: string) { return app?.ledger.getOwned(requestId, memberId); },
      pauseMerchantResponse(barrier: ReturnType<typeof deferred>) { merchantResponseBarrier = barrier; },
      loseMerchantResponseOnce() { loseMerchantResponse = true; },
      loseAgentResponseOnce() { loseAgentResponse = true; },
      async connect() {
        const client = new Client({ name: 'yosh-pay-production-integration', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath,
          args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/mcp.ts')], cwd: tmpdir(),
          env: { YOSH_DATA_DIR: directory }, stderr: 'pipe' });
        await client.connect(transport); clients.push({ client, transport }); return client;
      },
      async purchase(client: Client, requestId: string) {
        const response = await client.callTool({ name: 'request_purchase', arguments: {
          requestId, resourceId: 'market-snapshot', reason: 'Offline production integration check',
        } });
        if (response.isError || !Array.isArray(response.content)) throw new Error('MCP_PURCHASE_FAILED');
        const text = z.object({ type: z.literal('text'), text: z.string() }).parse(response.content[0]).text;
        return PurchaseRequestResultSchema.parse(JSON.parse(text));
      },
      async post(requestId: string, token = readConnection(directory).token) {
        return nativeFetch(`${origin}/api/agent/purchases`, { method: 'POST', headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
        }, body: JSON.stringify({ requestId, resourceId: 'market-snapshot', reason: 'Offline production integration check' }) });
      },
      async reopenWithoutPayExecutor() {
        if (app) { await app.prepareQuit(); app.close(); }
        execution?.close(); execution = undefined;
        app = new AppRuntime(directory, { ...dependencies, fetcher: networkFetch, paymentExecutor: undefined });
        globals.__yosh = { runtime: app };
        if (options.payMcp) {
          const disabled = { assertEligibility() { throw new Error('PAY_EXECUTION_DISABLED'); },
            async prepare() { throw new Error('PAY_EXECUTION_DISABLED'); }, assertBeforeSubmission() { throw new Error('PAY_EXECUTION_DISABLED'); } };
          authority = createPayAuthorityAdapter({directory, runtime: () => {if (!app) throw new Error('APP_CLOSED');return app;},
            config: () => loadPaymentConfig(), executor: disabled, origin, rpcUrl});
        }
        await app.initializeWallet();
        return app;
      },
      async crashAfterSubmissionMarker(requestId: string, stage: 'before'|'after'|'http'|'authorization' = 'after') {
        if (app) { await app.prepareQuit(); app.close(); app = undefined; }
        execution?.close(); execution = undefined;
        globals.__yosh = {};
        const signerFile = join(directory, 'offline-test-buyer.json');
        writeFileSync(signerFile, JSON.stringify([...buyer.secretKey]), { mode: 0o600 });
        const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
          resolve('tests/helpers/pay-production-crash-worker.ts')], { cwd: process.cwd(),
          env: { ...environment, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
            NODE_ENV: 'test', VITEST: '1', ...(stage === 'before' ? {TEST_CRASH_BEFORE_MARKER:'1'} : {}), ...(stage === 'http' ? {TEST_CRASH_AFTER_HTTP:'1'} : {}), ...(stage === 'authorization' ? {TEST_CRASH_AFTER_AUTHORIZATION:'1'} : {}), ...(options.payMcp ? {TEST_PAY_MCP_FIRST: '1'} : {}), TEST_RPC_URL: rpcUrl, TEST_MERCHANT_ORIGIN: origin,
            TEST_PAY_ENGINE_PATH: ENGINE_PATH, TEST_BUYER_KEYPAIR: signerFile, TEST_REQUEST_ID: requestId },
          stdio: ['ignore', 'ignore', 'pipe'] });
        const timeout = setTimeout(() => child.kill(), 10_000);
        let failureStage = '';
        child.stderr.on('data', (data: Buffer) => { failureStage += data.toString(); });
        try {
          const exited = once(child, 'exit');
          if (stage === 'http') {
            await Promise.race([merchantArrived.promise, exited.then(() => { throw new Error('HTTP_BOUNDARY_NOT_REACHED'); })]);
            child.kill('SIGKILL');
          }
          const [code, signal] = await exited;
          if (code !== null || signal !== 'SIGKILL') throw new Error(`WORKER_DID_NOT_CRASH_AFTER_MARKER:${failureStage}`);
        } finally { clearTimeout(timeout); }
      },
      async close() {
        for (const { client, transport } of clients) { await client.close(); await transport.close(); }
        if (app) { await app.prepareQuit(); app.close(); app = undefined; }
        execution?.close();
        await Promise.all([new Promise<void>(done => server.close(() => done())), new Promise<void>(done => rpc.close(() => done()))]);
        globals.__yosh = priorRuntime;
        vi.unstubAllGlobals(); vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
        if (networkError) throw networkError;
      },
    };
  } catch (error) {
    if (app) { await app.prepareQuit(); app.close(); }
    execution?.close(); server.close(); rpc.close();
    globals.__yosh = priorRuntime;
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
