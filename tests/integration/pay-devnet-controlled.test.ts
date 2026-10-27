import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import { VersionedTransaction } from '@solana/web3.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { readConnection } from '../../src/modules/mcp/connection';
import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';
import { loadPaymentConfig, DEVNET_GENESIS, MAINNET_NETWORK, TOKEN_PROGRAM } from '../../src/modules/payment/payment-config';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { preparePayUnsigned } from '../../src/modules/payment/pay-unsigned-preflight';
import { payOperationPurchaseId } from '../../src/modules/payment/pay-authority-adapter';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { hash } from '../../src/modules/purchases/spending-policy';
import { FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';

// Opt-in prepared Pay dependency, built from the frozen source and Yosh overlay.
const binary = process.env.YOSH_TEST_LIVE_NETWORK_PAY_BINARY ?? resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp');
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/reconcile-transaction', async original => ({
  ...await original<typeof import('../../src/modules/payment/reconcile-transaction')>(), reconcileStoredOriginalPayment: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** All keys, balances and chain outcomes here are ephemeral fixtures. The real
 * pinned Pay builder creates unsigned bytes; no external RPC or Keychain runs. */
async function fixture() {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const signer = await generateKeyPairSigner(), recipient = await generateKeyPairSigner(), sponsor = await generateKeyPairSigner();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-live-devnet-')));
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName), directory = join(root, 'Devnet');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet',
    mainnetRiskAccepted: false, rpcUrl: 'https://solana-rpc.publicnode.com' }), { mode: 0o600 });
  for (const [key, value] of Object.entries({ YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'devnet', YOSH_PAY_MCP_DEVNET: '1',
    YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_DEVNET_PURCHASES: '1', YOSH_ENABLE_MAINNET_EXECUTION: '0',
    YOSH_DATA_DIR: directory, SOLANA_RPC_URL: 'https://api.devnet.solana.com' })) vi.stubEnv(key, value);
  const environment = resolvePaymentEnvironment();
  const resource = { resourceId: 'devnet-fixture-data', providerId: 'fixture-provider', network: environment.network,
    mint: environment.asset.mint, decimals: 6, recipient: recipient.address, amount: '1000',
    request: { url: 'https://merchant.devnet-fixture.invalid/data?currency=usd', method: 'GET', access: 'https', headers: {} },
    requestInputs: { query: { coins: { type: 'string', required: true } } }, deliveryRecovery: { kind: 'idempotent_replay' } };
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const dependencies = { initializeWallet: async () => ({ address: signer.address, reused: true }),
    readWallets: async () => [{ id: 'devnet' as const, label: 'Ephemeral Devnet fixture', address: signer.address, status: 'available' as const }] };
  let app = new AppRuntime(directory, dependencies);
  const origin = `http://127.0.0.1:${PAY_DEVELOPMENT_PROFILE.backendPort}`;
  await app.initializeWallet(); app.setAgentConnection(true, origin);
  const memberId = app.ledger.defaultCardMember().id;
  const principal = () => app.authenticateAgent(new Request(`${origin}/pay/authorize`, { headers: { authorization: `Bearer ${readConnection(directory).token}` } }), 'request_purchase');
  app.ledger.setDailyLimit('5000', 'live_devnet'); app.ledger.setPaused(false, 'live_devnet');
  app.ledger.createSpendGrant({ totalLimit: '5000', singleLimit: '1000', expiresAt: Date.now() + 3600_000 }, principal(), {
    resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
    network: resource.network, assetId: resource.mint, assetDecimals: 6, payTo: recipient.address, paymentScheme: 'exact' }, Date.now(), 'live_devnet');
  const config = loadPaymentConfig(process.env, 'live_devnet', signer.address);
  const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '1000', payTo: recipient.address,
    maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address } };
  const challenge = { x402Version: 2, resource: { url: 'https://merchant.devnet-fixture.invalid/data' }, accepts: [quote],
    extensions: { 'payment-identifier': { info: { required: false } } } };
  const facts = { caller_id: memberId, operation_id: 'devnet-controlled', attempt_id: randomUUID(), execution_network: 'devnet',
    request: { method: 'GET', url: `${resource.request.url}&coins=SOL`, headers: [['accept', 'application/json']], body: null },
    amount_atomic: quote.amount, asset: quote.asset, network: quote.network, recipient: quote.payTo, accepted: quote, payment_required: challenge };
  const blockhash = (await generateKeyPairSigner()).address;
  const state = { loseResponse: false, genesis: DEVNET_GENESIS, simulationError: null as unknown, beforeSimulation: () => {} };
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { owner, mint: quote.asset,
    state: 'initialized', tokenAmount: { amount: '100000', decimals: 6 } } } } });
  const rpc = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).startsWith(resource.request.url)) {
      if (state.loseResponse) throw new Error('OFFLINE_FIXTURE_RESPONSE_LOST');
      return Response.json({ data: 'fixture Devnet data' }, { headers: { 'payment-response': encodePaymentResponseHeader({ success: true,
        network: config.network, transaction: FIXTURE_TRANSACTION_SIGNATURE, payer: signer.address }) } });
    }
    expect(new URL(String(url)).href).toBe(new URL(config.rpcUrl).href);
    const input = JSON.parse(String(init?.body));
    const results: Record<string, unknown> = { getGenesisHash: state.genesis,
      getLatestBlockhash: { value: { blockhash, lastValidBlockHeight: 5000 } }, simulateTransaction: { value: { err: state.simulationError } },
      getBalance: { value: 100_000 }, getMultipleAccounts: { value: [
        { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } }, token(signer.address), token(recipient.address),
      ] } };
    if (!(input.method in results)) throw new Error('UNEXPECTED_FIXTURE_RPC');
    if (input.method === 'simulateTransaction') state.beforeSimulation();
    return Response.json({ jsonrpc: '2.0', id: 1, result: results[input.method] });
  });
  vi.stubGlobal('fetch', rpc);
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
  vi.spyOn(app, 'start').mockResolvedValue();
  const record = () => app.ledger.getOwned(payOperationPurchaseId(memberId, facts.operation_id), memberId);
  return { directory, facts, config, signer, principal, rpc, state, record,
    get app() { return app; },
    async call(action: 'authorize' | 'plan' | 'execute', raw: unknown = facts) {
      const input = action === 'authorize' ? Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(raw)).filter(([key]) => key !== 'payment_required')) : raw;
      return app.payMcpOperation(action, input, principal(), origin);
    },
    async unsigned(plan: unknown) {
      const lifetime = z.object({ lifetime: z.object({ recentBlockhash: z.string(), lastValidBlockHeight: z.string() }) }).parse(plan).lifetime;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
        const result = input.method === 'isBlockhashValid' ? { context: { slot: 1 }, value: true }
          : input.method === 'getAccountInfo' ? { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'],
            executable: false, lamports: 1000000, owner: TOKEN_PROGRAM, rentEpoch: 0 } } : null;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_RPC_REQUIRED');
      try {
        const result = z.object({ ok: z.literal(true), result: z.object({ accepted: z.unknown(), unsigned: z.object({
          transaction: z.string(), recentBlockhash: z.string(), lastValidBlockHeight: z.string() }) }) }).parse(await preparePayUnsigned(binary, {
          payer: signer.address, rpcUrl: `http://127.0.0.1:${address.port}`, lifetime, url: facts.request.url, paymentRequired: challenge,
        })).result;
        expect(hash(result.accepted)).toBe(hash(quote));
        expect(VersionedTransaction.deserialize(Buffer.from(result.unsigned.transaction, 'base64')).signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
        return result.unsigned;
      } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    },
    async reopen() {
      await app.prepareQuit(); app.close(); app = new AppRuntime(directory, dependencies); await app.initializeWallet();
      vi.spyOn(app, 'start').mockResolvedValue();
    },
    async close() { await app.prepareQuit(); app.close(); rmSync(parent, { recursive: true, force: true }); },
  };
}

it('uses the pinned Pay unsigned builder and the existing Devnet Grant, budget, signature, original evidence and replay path', async () => {
  const f = await fixture();
  try {
    expect(f.config.facilitatorUrl).toBeNull();
    expect(await f.call('authorize')).toEqual({ allow: true });
    const unsigned = await f.unsigned(await f.call('plan', { facts: f.facts }));
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '1000', paid: '0' });
    expect(await f.call('execute', { facts: f.facts, unsigned })).toMatchObject({ status: 200 });
    expect(f.record()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    const original = f.app.ledger.savedOriginalPayment(f.record()!.approvalId)!;
    expect(original.evidence.identity).toMatchObject({ network: f.config.network, mint: f.config.mint, payer: f.config.buyer, amount: '1000' });
    expect(f.app.ledger.savedPayload(f.record()!.approvalId)).toMatchObject({ resource: f.facts.payment_required.resource,
      extensions: f.facts.payment_required.extensions, accepted: f.facts.accepted });
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: '1000' });
    await f.reopen();
    const replay = { ...f.facts, attempt_id: randomUUID() };
    expect(await f.call('authorize', replay)).toEqual({ allow: true });
    expect(await f.call('plan', { facts: replay })).toMatchObject({ action: 'replay' });
    expect(loadBuyerSigner).toHaveBeenCalledOnce();
    expect(f.app.ledger.savedOriginalPayment(f.record()!.approvalId)).toEqual(original);
    expect(f.rpc.mock.calls.filter(([url]) => String(url) === f.facts.request.url)).toHaveLength(1);
  } finally { await f.close(); }
}, 30_000);

it.each(['grant', 'daily-limit', 'pause'] as const)('Devnet %s denial prevents signing and keeps the same authority rules', async denial => {
  const f = await fixture();
  try {
    if (denial === 'grant') f.app.ledger.revokeActiveSpendGrant();
    if (denial === 'daily-limit') f.app.ledger.setDailyLimit('999', 'live_devnet');
    if (denial === 'pause') f.app.setPaused(true);
    await f.call('authorize');
    await expect(f.call('plan', { facts: f.facts })).rejects.toThrow('PAY_AUTHORIZATION_REJECTED');
    expect(f.record()?.status).toBe('DENIED');
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: '0' });
  } finally { await f.close(); }
});

it('rejects a Mainnet offer in Devnet before recording an external authority claim', async () => {
  const f = await fixture();
  try {
    await expect(f.call('authorize', { ...f.facts, network: MAINNET_NETWORK })).rejects.toThrow('PAY_ECONOMIC_FACTS_MISMATCH');
    expect(f.app.ledger.executionSafety.hasExternalAuthorityClaim(f.facts.caller_id, f.facts.operation_id)).toBe(false);
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('Devnet binds the original lifetime and unsigned economics before reaching the wallet', async () => {
  const f = await fixture();
  try {
    await f.call('authorize'); const unsigned = await f.unsigned(await f.call('plan', { facts: f.facts }));
    await expect(f.call('execute', { facts: f.facts, unsigned: { ...unsigned, lastValidBlockHeight: '5001' } }))
      .rejects.toThrow('PAY_BLOCKHASH_BINDING_MISMATCH');
    const transaction = VersionedTransaction.deserialize(Buffer.from(unsigned.transaction, 'base64'));
    const transfer = transaction.message.compiledInstructions.find(instruction => instruction.data[0] === 12 && instruction.data.length === 10);
    if (!transfer) throw new Error('FIXTURE_TRANSFER_REQUIRED');
    transfer.data[1] ^= 1;
    await expect(f.call('execute', { facts: f.facts, unsigned: { ...unsigned, transaction: Buffer.from(transaction.serialize()).toString('base64') } })).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([url]) => String(url) === f.facts.request.url)).toBe(false);
  } finally { await f.close(); }
}, 30_000);

it('Devnet Unknown retains the original reservation and recovers after restart while paused without another signature', async () => {
  const f = await fixture();
  try {
    f.state.loseResponse = true;
    vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
    await f.call('authorize'); const unsigned = await f.unsigned(await f.call('plan', { facts: f.facts }));
    await expect(f.call('execute', { facts: f.facts, unsigned })).rejects.toThrow();
    const record = f.record()!;
    expect(record.status).toBe('PAYMENT_UNKNOWN');
    const original = f.app.ledger.savedOriginalPayment(record.approvalId);
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '1000', paid: '0' });
    await f.reopen(); f.app.setPaused(true);
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toEqual(original);
    f.state.loseResponse = false;
    vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
    await recoverApprovedPayment(f.app.ledger, record.intent.idempotencyKey, f.config, f.facts.request.url, undefined, f.facts.caller_id);
    expect(f.record()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '0', paid: '1000' });
    expect(loadBuyerSigner).toHaveBeenCalledOnce();
  } finally { await f.close(); }
}, 30_000);

it('the real Pay host admits the production Devnet flag and keeps loopback resources blocked', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-devnet-host-')));
  const config = join(directory, 'host.json');
  writeFileSync(config, JSON.stringify({ origin: 'http://127.0.0.1:1', caller: randomUUID(), token: randomUUID(), timeout_ms: 500 }), { mode: 0o600 });
  const client = new Client({ name: 'devnet-host-policy-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: binary, args: [config], cwd: directory,
    env: { NODE_ENV: 'production', YOSH_PAY_MCP_DEVNET: '1', HOME: directory, PATH: '/usr/bin:/bin' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === 'curl')).toBe(true);
    const response = await client.callTool({ name: 'curl', arguments: { operation_id: 'devnet-loopback-denied', url: 'http://127.0.0.1:1/private' } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/blocked|private|public|unsafe/i);
  } finally { await client.close(); await transport.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
