import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { CodexIntegration } from '../../src/modules/mcp/codex-integration';
import { readConnection } from '../../src/modules/mcp/connection';
import { preparePayMainnetCutover } from '../../src/modules/payment/pay-mainnet-control';
import { MAINNET_GENESIS, resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { preparePayUnsigned } from '../../src/modules/payment/pay-unsigned-preflight';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';

vi.mock('../../src/modules/payment/pay-unsigned-preflight', () => ({ preparePayUnsigned: vi.fn() }));
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
const directories: string[] = [];
const runtimes = new Set<AppRuntime>();
afterEach(async () => {
  for (const app of runtimes) { await app.prepareQuit(); app.close(); }
  runtimes.clear();
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  for (const key of Object.keys(process.env)) {
    if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-hosting-')));
  directories.push(directory);
  const packaged = join(directory, 'packaged'); mkdirSync(packaged);
  writeFileSync(join(packaged, 'mcp.cjs'), 'fixture-only');
  const payMcpPath = join(packaged, 'pay-mcp'); writeFileSync(payMcpPath, 'fixture-only');
  const runtimeDigest = 'a'.repeat(64);
  vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1');
  vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1');
  vi.stubEnv('YOSH_PACKAGED_RUNTIME_DIR', packaged);
  const environment = resolvePaymentEnvironment();
  const buyer = '11111111111111111111111111111111';
  const resource = {
    resourceId: 'hosting-fixture', providerId: 'fixture', network: environment.network,
    mint: environment.asset.mint, decimals: 6, recipient: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', amount: '1000',
    request: { url: 'https://merchant.hosting.invalid/data', method: 'GET', access: 'https', headers: {} },
  };
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const previous = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true, mode: 'live_mainnet' });
  const memberId = previous.defaultCardMember().id; previous.close();
  preparePayMainnetCutover(directory, [2_147_483_647]);
  const integration = new CodexIntegration(directory, memberId);
  const original = { name: integration.legacyServerName, enabled: true, transport: {
    type: 'stdio', command: process.execPath, args: ['--import', '/old-app/loader.mjs', '/old-app/mcp.ts'],
    env: { YOSH_DATA_DIR: directory, YOSH_CARD_MEMBER_ID: memberId, YOSH_MCP_PROVIDER: 'codex' },
  } };
  mkdirSync(join(directory, 'members', memberId), { recursive: true });
  writeFileSync(integration.recordPath, JSON.stringify({ provider: 'codex', memberId, config: original }));
  const configPath = join(directory, 'original-codex-config.json');
  const entries: unknown[] = [original];
  const persist = () => writeFileSync(configPath, JSON.stringify(entries)); persist();
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === 'list') return JSON.stringify(entries);
    if (args[1] === 'remove') entries.splice(0);
    else if (args[1] === 'add') {
      const separator = args.indexOf('--');
      entries.push({ name: args[2], enabled: true, transport: { type: 'stdio', command: args[separator + 1],
        args: args.slice(separator + 2), env: original.transport.env } });
    } else throw new Error('UNEXPECTED_FIXTURE_CODEX_COMMAND');
    persist(); return '';
  });
  const open = (standalone = true, binary = payMcpPath) => {
    const app = new AppRuntime(directory, { codex: { run }, initializeWallet: async () => ({ address: buyer, reused: true }),
      ...(standalone ? { hosting: { kind: 'mainnet-standalone' as const, payMcpPath: binary, runtimeDigest } } : {}) });
    runtimes.add(app); return app;
  };
  return { directory, memberId, payMcpPath, runtimeDigest, configPath, recordPath: integration.recordPath, run, open, buyer, resource };
}

it('standalone startup and repeated member connection preserve the original App MCP registration across restart', async () => {
  const f = fixture();
  const config = readFileSync(f.configPath), record = readFileSync(f.recordPath);
  let app = f.open();
  app.setAgentConnection(true, 'http://127.0.0.1:3049');
  const connection = readConnection(f.directory);
  await app.start('http://127.0.0.1:3049');
  await app.setMemberConnection(true, 'http://127.0.0.1:3049', f.memberId);
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  await app.start('http://127.0.0.1:3049');
  expect(readConnection(f.directory)).toEqual(connection);
  expect(readFileSync(f.configPath)).toEqual(config);
  expect(readFileSync(f.recordPath)).toEqual(record);
  expect(f.run).not.toHaveBeenCalled();
});

it('rejects a standalone hosting dependency outside its admitted Mainnet profile or with a noncanonical Pay path', () => {
  const f = fixture();
  for (const path of ['relative/pay-mcp', '/runtime/../pay-mcp', '/runtime/node']) {
    expect(() => f.open(true, path)).toThrow('MAINNET_STANDALONE_HOSTING_REJECTED');
  }
  vi.stubEnv('YOSH_PAY_MCP_MAINNET', undefined);
  expect(() => f.open()).toThrow('MAINNET_STANDALONE_HOSTING_REJECTED');
});

it('reports the standalone runtime contract and digest without leaking its Pay path; an ordinary App retains its health and migration behavior', async () => {
  const f = fixture();
  const hosted = f.open();
  expect(hosted.healthStatus()).toMatchObject({ hosting: { kind: 'mainnet-standalone', apiVersion: 1,
    dataContract: 'existing-mainnet-v1', runtimeDigest: f.runtimeDigest } });
  expect(JSON.stringify(hosted.healthStatus())).not.toContain(f.payMcpPath);
  await hosted.prepareQuit(); hosted.close(); runtimes.delete(hosted);
  const ordinary = f.open(false);
  expect(ordinary.healthStatus()).not.toHaveProperty('hosting');
  await ordinary.start('http://127.0.0.1:3049');
  expect(f.run.mock.calls.some(([args]) => args[1] === 'remove')).toBe(true);
  expect(f.run.mock.calls.some(([args]) => args[1] === 'add')).toBe(true);
});

it('prepayment recovery after standalone restart uses its packaged Pay binary and retains the original reservation on build failure', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    if (!['getGenesisHash', 'getLatestBlockhash'].includes(method)) throw new Error('UNEXPECTED_FIXTURE_RPC');
    return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'getGenesisHash' ? MAINNET_GENESIS
      : { value: { blockhash: f.buyer, lastValidBlockHeight: 5000 } } });
  }));
  let app = f.open(); app.setAgentConnection(true, origin);
  await app.initializeWallet();
  app.setDailyLimit('1000'); app.setPaused(false);
  const connection = readConnection(f.directory);
  const principal = () => app.authenticateAgent(new Request(origin + '/pay/authorize', {
    headers: { authorization: `Bearer ${connection.token}` },
  }), 'request_purchase');
  await app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '1000', singleLimit: '1000', expiresAt: Date.now() + 3600_000 });
  const quote = { scheme: 'exact', network: f.resource.network, asset: f.resource.mint, amount: '1000',
    payTo: f.resource.recipient, maxTimeoutSeconds: 300, extra: { feePayer: f.resource.recipient } };
  const facts = { caller_id: f.memberId, operation_id: 'standalone-original', attempt_id: crypto.randomUUID(), execution_network: 'mainnet',
    request: { method: 'GET', url: f.resource.request.url, headers: [['accept', 'application/json']], body: null },
    amount_atomic: quote.amount, asset: quote.asset, network: quote.network, recipient: quote.payTo, accepted: quote,
    payment_required: { x402Version: 2, resource: { url: f.resource.request.url }, accepts: [quote] } };
  const spend = Object.fromEntries(Object.entries(facts).filter(([key]) => key !== 'payment_required'));
  await app.payMcpOperation('authorize', spend, principal(), origin);
  await app.payMcpOperation('plan', { facts }, principal(), origin);
  const purchase = app.ledger.listForOwner(f.memberId)[0];
  const budget = app.ledger.managedSummary(Date.now(), 'live_mainnet');
  const grant = app.spendGrantSummary();
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  vi.mocked(preparePayUnsigned).mockResolvedValue({ ok: false, code: 'UNSIGNED_PREPARE_FAILED' });
  await expect(app.payMcpRecovery({ operationId: facts.operation_id }, principal(), origin)).rejects.toThrow();
  expect(preparePayUnsigned).toHaveBeenCalledWith(f.payMcpPath, expect.objectContaining({ payer: f.buyer }));
  expect(app.ledger.listForOwner(f.memberId)).toHaveLength(1);
  expect(app.ledger.listForOwner(f.memberId)[0]).toMatchObject({ purchaseId: purchase.purchaseId, status: 'APPROVED' });
  expect(app.ledger.managedSummary(Date.now(), 'live_mainnet')).toEqual(budget);
  expect(app.spendGrantSummary()).toEqual(grant);
  expect(readConnection(f.directory)).toEqual(connection);
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
