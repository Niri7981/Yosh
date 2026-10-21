import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getBase58Decoder } from '@solana/kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { preparePayMainnetCutover, recordPayMainnetAcceptance } from '../../src/modules/payment/pay-mainnet-control';
import { safeResourceFetch } from '../../src/modules/resources/safe-resource-fetch';
import { readPaymentRequiredHeader } from '../../src/modules/payment/x402-client';
import { MAINNET_REFERENCE_API } from '../../src/modules/payment/pay-mainnet-preflight';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { readConnection } from '../../src/modules/mcp/connection';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { hash } from '../../src/modules/purchases/spending-policy';
import { decodeOriginalTransaction } from '../../src/modules/payment/original-payment-evidence';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { runPaymentPreflight, classifyPaymentPreflightError } from '../../src/modules/payment/payment-preflight';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn(() => { throw new Error('LIVE_PREFLIGHT_SIGNER_FORBIDDEN'); }) }));
vi.mock('../../src/modules/payment/payment-preflight', async original => {
  const actual = await original<typeof import('../../src/modules/payment/payment-preflight')>();
  return { ...actual, runPaymentPreflight: vi.fn(actual.runPaymentPreflight) };
});

// Explicit opt-in: public GET + read-only RPC, random public bytes with NO
// corresponding private key. It must stop before signer loading or final HTTP.
it.skipIf(process.env.YOSH_LIVE_MAINNET_PREFLIGHT !== '1')('real Mainnet Pay MCP reaches real Yosh reservation and validates SDK unsigned bytes without a wallet signature', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-public-preflight-'))); chmodSync(directory, 0o700);
  let app: AppRuntime | undefined;
  let client: Client | undefined;
  const errors: string[] = [];
  const stages: string[] = [];
  const failures: unknown[] = [];
  let unsignedValidated = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!app) throw new Error('RUNTIME_UNAVAILABLE');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 131_072) throw new Error('INPUT_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
      const request = new Request(`${origin}${incoming.url}`, { headers: { authorization: incoming.headers.authorization ?? '' } });
      const principal = app.authenticateAgent(request, 'request_purchase');
      const action = z.enum(['authorize', 'plan', 'execute']).parse(incoming.url?.slice('/pay/'.length));
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (action === 'execute') {
        const value = z.object({ unsigned: z.object({ transaction: z.string() }) }).passthrough().parse(raw);
        expect(decodeOriginalTransaction(value.unsigned.transaction).transaction.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
        unsignedValidated = true;
      }
      const result = await app.payMcpOperation(action, raw, principal, origin);
      outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(result));
    } catch (error) {
      failures.push({ type: error instanceof Error ? error.name : 'unknown',
        issues: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message })) : undefined,
        code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined });
      errors.push(error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'CONTROLLED_PREFLIGHT_STOPPED'); outgoing.writeHead(403); outgoing.end('{}');
    }
  });
  let origin = '';
  try {
    for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
    const response = await safeResourceFetch(MAINNET_REFERENCE_API, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(402);
    const raw = readPaymentRequiredHeader(response.headers.get('payment-required') ?? '', true); await response.body?.cancel();
    const quote = raw.accepts.find(offer => offer.network === MAINNET_NETWORK && offer.asset === MAINNET_USDC_MINT)!;
    expect(quote.amount).toBe('1000');
    const buyer = getBase58Decoder().decode(randomBytes(32));
    const resource = { resourceId: 'public-preflight', providerId: 'agent402.tools', request: { method: 'GET', url: MAINNET_REFERENCE_API,
      access: 'https', headers: {} }, network: quote.network, mint: quote.asset, decimals: 6, recipient: quote.payTo, amount: '1000' };
    const old = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true, requireSpendGrant: true, mode: 'live_mainnet' }); old.close();
    preparePayMainnetCutover(directory, [2_147_483_647]);
    vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet'); vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1'); vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1');
    vi.stubEnv('SOLANA_MAINNET_RPC_URL', 'https://solana-rpc.publicnode.com/'); vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
    app = new AppRuntime(directory, { initializeWallet: async () => ({ address: buyer, reused: true }),
      readWallets: async () => [{ id: 'mainnet', label: 'Public bytes only; no private key', address: buyer, status: 'available' }] });
    await app.initializeWallet();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('PORT_REQUIRED');
    origin = `http://127.0.0.1:${address.port}`; app.setAgentConnection(true, origin);
    const connection = readConnection(directory);
    const principal = app.authenticateAgent(new Request(origin, { headers: { authorization: `Bearer ${connection.token}` } }), 'request_purchase');
    app.setDailyLimit('1000'); app.setPaused(false);
    app.ledger.createSpendGrant({ totalLimit: '1000', singleLimit: '1000', expiresAt: Date.now() + 120_000 }, principal, {
      resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: quote.network, assetId: quote.asset, assetDecimals: 6, payTo: quote.payTo, paymentScheme: 'exact' }, Date.now(), 'live_mainnet');
    const operation = `unsigned-public-${randomUUID()}`;
    recordPayMainnetAcceptance(directory, { version: 1, callerId: principal.cardMemberId, operationId: operation, wallet: buyer,
      network: quote.network, asset: quote.asset, recipient: quote.payTo, amountAtomic: quote.amount,
      requestHash: hash({ method: 'GET', url: MAINNET_REFERENCE_API, headers: [['accept', 'application/json']], body: null }),
      quoteHash: hash(quote), challengeHash: hash(raw), expiresAt: Date.now() + 120_000 });
    const config = join(directory, 'host.json'); writeFileSync(config, JSON.stringify({ origin, token: connection.token, caller: principal.cardMemberId, timeout_ms: 5000 }), { mode: 0o600 });
    client = new Client({ name: 'unsigned-mainnet-preflight', version: '1' });
    const transport = new StdioClientTransport({ command: resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'), args: [config], cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test', YOSH_PAY_MCP_MAINNET: '1' }, stderr: 'pipe' });
    let traceBuffer = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      traceBuffer += chunk.toString('utf8');
      const lines = traceBuffer.split('\n'); traceBuffer = lines.pop() ?? '';
      if (traceBuffer.length > 8192) traceBuffer = '';
      for (const line of lines) {
        try { const event = z.object({ fields: z.object({ stage: z.string().regex(/^[a-z0-9_]{1,64}$/) }) }).parse(JSON.parse(line)); stages.push(event.fields.stage); } catch { /* Fixed stage fields only. */ }
      }
    });
    await client.connect(transport);
    const result = await client.callTool({ name: 'curl', arguments: { url: MAINNET_REFERENCE_API, operation_id: operation } }, undefined, { timeout: 60_000 });
    writeFileSync('integration/mainnet-execution/live-mcp-diagnostic.json', JSON.stringify({ stages, errors, failures, unsignedValidated,
      ledgerStates: app.ledger.listForOwner(principal.cardMemberId, 10).map(record => record.status),
      publicError: result.isError ? JSON.stringify(result.content).slice(0, 1024) : 'unexpected success' }, null, 2));
    expect(result.isError).toBe(true); expect(unsignedValidated).toBe(true); expect(errors).toHaveLength(1);
    expect(runPaymentPreflight).toHaveBeenCalledOnce();
    const observed = vi.mocked(runPaymentPreflight).mock.results[0].value;
    let gate: string | undefined;
    try { await observed; } catch (error) { gate = classifyPaymentPreflightError(error); }
    expect(gate).toBe('BUYER_TOKEN_ACCOUNT_UNAVAILABLE');
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    const record = app.ledger.listForOwner(principal.cardMemberId, 10)[0]!;
    expect(record.status).toBe('FAILED');
    const purchase = app.ledger.getOwned(record.purchaseId, principal.cardMemberId)!;
    expect(app.ledger.executionSafety.provenance(purchase.intent.id)?.origin).toBe('external_pay');
    expect(app.ledger.savedOriginalPayment(purchase.approvalId)).toBeUndefined();
    writeFileSync('integration/mainnet-execution/live-mcp-preflight.json', JSON.stringify({ checkedAt: new Date().toISOString(),
      realPayMcp: true, realYoshAuthorityAndLedger: true, mainnetQuoteBound: true, unsignedSdkTransactionValidated: true,
      rpc: 'PublicNode', stop: 'ephemeral public identity has no token account or funds; preflight stopped before signer',
      preflightGate: gate, purchaseOutcome: 'FAILED_BEFORE_SIGNING',
      signerCalls: 0, realKeychainCalls: 0, originalPaymentEvidence: false, paidHttpStarted: false, paymentSent: false }, null, 2));
  } finally {
    await client?.close(); if (app) { await app.prepareQuit(); app.close(); }
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
}, 90_000);
