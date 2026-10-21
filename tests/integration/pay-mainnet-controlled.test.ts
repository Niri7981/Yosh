import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { VersionedTransaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { preparePayMainnetCutover } from '../../src/modules/payment/pay-mainnet-control';
import { loadPaymentConfig, MAINNET_GENESIS } from '../../src/modules/payment/payment-config';
import { readConnection } from '../../src/modules/mcp/connection';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { hash } from '../../src/modules/purchases/spending-policy';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import { recoverApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/reconcile-transaction', async original => ({
  ...await original<typeof import('../../src/modules/payment/reconcile-transaction')>(), reconcileStoredOriginalPayment: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('an upgraded directory cannot silently fall back to the JS payment entry when the Pay flag is missing', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-profile-lock-'))); chmodSync(directory, 0o700);
  let unexpected: AppRuntime | undefined;
  try {
    const old = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true }); old.close();
    preparePayMainnetCutover(directory, [2_147_483_647]);
    vi.stubEnv('YOSH_PAY_MCP_MAINNET', undefined);
    expect(() => { unexpected = new AppRuntime(directory); }).toThrow('PAY_MAINNET_PROFILE_REQUIRED');
  } finally { if (unexpected) { await unexpected.prepareQuit(); unexpected.close(); } rmSync(directory, { recursive: true, force: true }); }
});

it('stopped upgrade preserves committed WAL after an actual SIGKILL without deleting or replaying economic state', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-cutover-wal-'))); chmodSync(directory, 0o700);
  try {
    const path = join(directory, 'app-ledger.sqlite');
    const ledgerModule = resolve('src/modules/purchases/purchase-ledger.ts');
    const worker = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e',
      `import { PurchaseLedger } from ${JSON.stringify(ledgerModule)}; const ledger = new PurchaseLedger(process.argv[1], {managed:true, mode:'live_mainnet'}); ledger.setDailyLimit('777', 'live_mainnet'); process.kill(process.pid,'SIGKILL');`, path],
    { env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: 'test' }, stdio: 'pipe' });
    expect(worker.signal).toBe('SIGKILL');
    const result = preparePayMainnetCutover(directory, [worker.pid]);
    const backup = new DatabaseSync(join(directory, result.backup), { readOnly: true });
    try { expect(backup.prepare('SELECT * FROM monetary_controls').all().some(row => Object.values(row).includes('777'))).toBe(true); }
    finally { backup.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function fixture() {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const signer = await generateKeyPairSigner(), recipient = await generateKeyPairSigner(), sponsor = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1' });
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-pay-mainnet-'))); chmodSync(directory, 0o700);
  const path = join(directory, 'app-ledger.sqlite');
  const old = new PurchaseLedger(path, { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
  old.setDailyLimit('5000', 'live_mainnet'); old.close();
  expect(() => preparePayMainnetCutover(directory, [process.pid])).toThrow('PAY_OLD_PROCESS_STILL_RUNNING');
  const cutover = preparePayMainnetCutover(directory, [2_147_483_647]);
  expect(readFileSync(join(directory, cutover.backup)).length).toBeGreaterThan(0);
  vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet'); vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1');
  vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1'); vi.stubEnv('SOLANA_MAINNET_RPC_URL', 'https://rpc.integration.invalid/');
  vi.stubEnv('YOSH_MAINNET_WALLET_PUBLIC_KEY', signer.address);
  const resource = { resourceId: 'mainnet-fixture-data', providerId: 'fixture-provider', network: environment.network,
    mint: environment.asset.mint, decimals: 6 as const, recipient: recipient.address, amount: '1000',
    request: { url: 'https://merchant.integration.invalid/data?currency=usd', method: 'GET' as const, access: 'https' as const, headers: {} },
    requestInputs: { query: { coins: { type: 'string' as const, required: true } } },
    deliveryRecovery: { kind: 'idempotent_replay' as const } };
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const dependencies = { initializeWallet: async () => ({ address: signer.address, reused: true }),
    readWallets: async () => [{ id: 'mainnet' as const, label: 'Ephemeral Mainnet-profile fixture', address: signer.address, status: 'available' as const }] };
  let app = new AppRuntime(directory, dependencies);
  const origin = 'http://127.0.0.1:3049';
  await app.initializeWallet(); app.setAgentConnection(true, origin);
  const memberId = app.ledger.defaultCardMember().id;
  const principal = () => app.authenticateAgent(new Request(`${origin}/pay/authorize`, { headers: { authorization: `Bearer ${readConnection(directory).token}` } }), 'request_purchase');
  app.ledger.setPaused(false, 'live_mainnet');
  app.ledger.createSpendGrant({ totalLimit: '5000', singleLimit: '1000', expiresAt: Date.now() + 3600_000 }, principal(), {
    resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
    network: resource.network, assetId: resource.mint, assetDecimals: 6, payTo: recipient.address, paymentScheme: 'exact' }, Date.now(), 'live_mainnet');
  const config = loadPaymentConfig(process.env, 'live_mainnet', signer.address);
  const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '1000', payTo: recipient.address,
    maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address }, outputSchema: { type: 'object' } };
  const challenge = { x402Version: 2, resource: { url: 'https://merchant.integration.invalid/data' }, accepts: [quote],
    extensions: { 'payment-identifier': { info: { required: false } } } };
  const facts = { caller_id: memberId, operation_id: 'first-mainnet', attempt_id: randomUUID(), execution_network: 'mainnet',
    request: { method: 'GET', url: 'https://merchant.integration.invalid/data?coins=SOL&currency=usd', headers: [['accept', 'application/json']], body: null },
    amount_atomic: quote.amount, asset: quote.asset, network: quote.network, recipient: quote.payTo, accepted: quote, payment_required: challenge };
  const accept = (value = facts) => writeFileSync(join(directory, 'pay-mainnet-acceptance.json'), JSON.stringify({ version: 2,
    resourceId: resource.resourceId, providerId: resource.providerId, resourceUrl: value.request.url,
    callerId: memberId, operationId: value.operation_id, wallet: signer.address, network: quote.network, asset: quote.asset,
    recipient: quote.payTo, amountAtomic: quote.amount, requestHash: hash(value.request), quoteHash: hash(value.accepted),
    challengeHash: hash(value.payment_required), expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  const payload = { ...await signedPaymentFixture(signer, config, quote), resource: challenge.resource, extensions: challenge.extensions };
  const transaction = VersionedTransaction.deserialize(Buffer.from(String(payload.payload.transaction), 'base64'));
  transaction.signatures = transaction.signatures.map(() => new Uint8Array(64));
  const prepared = { transaction: Buffer.from(transaction.serialize()).toString('base64'),
    recentBlockhash: transaction.message.recentBlockhash, lastValidBlockHeight: '5000' };
  const rpc = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).startsWith('https://merchant.integration.invalid/data')) throw new Error('OFFLINE_MERCHANT_RESPONSE_LOST');
    const input = JSON.parse(String(init?.body));
    const result = input.method === 'getGenesisHash' ? MAINNET_GENESIS : input.method === 'getLatestBlockhash'
      ? { value: { blockhash: prepared.recentBlockhash, lastValidBlockHeight: 5000 } }
      : input.method === 'simulateTransaction' ? { value: { err: null } }
        : input.method === 'getBalance' ? { value: 100_000 } : input.method === 'getMultipleAccounts'
          ? { value: [
            { owner: environment.asset.tokenProgram, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
            ...[signer.address, recipient.address].map(owner => ({ owner: environment.asset.tokenProgram, data: { parsed: { type: 'account', info: {
              owner, mint: quote.asset, state: 'initialized', tokenAmount: { amount: '100000', decimals: 6 } } } } })),
          ] } : undefined;
    if (result === undefined) throw new Error('UNEXPECTED_TEST_RPC');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  vi.stubGlobal('fetch', rpc);
  vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
  vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'UNKNOWN' });
  // Startup is tested separately through reopen; avoid unrelated provider discovery here.
  vi.spyOn(app, 'start').mockResolvedValue();
  return { directory, facts, prepared, config, payload, signer, accept, rpc, principal,
    get app() { return app; }, record: () => app.ledger.listForOwner(memberId, 50)[0],
    async call(action: 'authorize' | 'plan' | 'execute', raw: unknown = facts) { return app.payMcpOperation(action, raw, principal(), origin); },
    async reopen() { await app.prepareQuit(); app.close(); app = new AppRuntime(directory, dependencies); await app.initializeWallet(); },
    async close() { await app.prepareQuit(); app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it('requires an operator acceptance independently of real Grant and Budget, then atomically reserves full Mainnet Pay facts', async () => {
  const f = await fixture();
  try {
    await expect(f.call('authorize')).rejects.toThrow(); expect(f.record()).toBeUndefined();
    f.accept(); expect(await f.call('authorize')).toEqual({ allow: true });
    const record = f.record()!;
    expect(record.status).toBe('APPROVED');
    const owned = f.app.ledger.getOwned(record.purchaseId, f.facts.caller_id)!;
    expect(f.app.ledger.executionSafety.permit(owned)).toMatchObject({ factsHash: hash(f.facts), quoteHash: hash(f.facts.accepted) });
    expect(f.app.ledger.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({ reserved: '1000', paid: '0' });
    expect(loadBuyerSigner).not.toHaveBeenCalled();
    expect(() => new AppRuntime(f.directory)).toThrow('DATA_DIRECTORY_IN_USE');
    expect(await f.call('plan', { facts: f.facts })).toMatchObject({ action: 'build', lifetime: {
      recentBlockhash: f.prepared.recentBlockhash, lastValidBlockHeight: '5000' } });
    await expect(f.call('execute', { facts: f.facts, unsigned: { ...f.prepared, lastValidBlockHeight: '5001' } })).rejects.toThrow('PAY_BLOCKHASH_BINDING_MISMATCH');
    expect(loadBuyerSigner).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('Mainnet controlled execution persists original Unknown and recovers once after restart without another signature or replacement', async () => {
  const f = await fixture();
  try {
    f.accept(); await f.call('authorize'); await f.call('plan', { facts: f.facts });
    await expect(f.call('execute', { facts: f.facts, unsigned: f.prepared })).rejects.toThrow();
    const initial = f.record()!; expect(initial.status).toBe('PAYMENT_UNKNOWN');
    const record = f.app.ledger.getOwned(initial.purchaseId, f.facts.caller_id)!;
    const original = f.app.ledger.savedOriginalPayment(record.approvalId);
    expect(original?.state).toBe('OUTCOME_UNKNOWN'); expect(loadBuyerSigner).toHaveBeenCalledOnce();
    await f.reopen();
    expect(f.record()!.status).toBe('PAYMENT_UNKNOWN');
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toEqual(original);
    f.app.setPaused(true);
    vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE });
    f.rpc.mockImplementation(async () => Response.json({ data: 'original data recovered' }));
    await recoverApprovedPayment(f.app.ledger, initial.purchaseId, { ...f.config, productionExecutionEnabled: false },
      f.facts.request.url, undefined, f.facts.caller_id);
    expect(f.record()).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    expect(f.app.ledger.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({ reserved: '0', paid: '1000' });
    await recoverApprovedPayment(f.app.ledger, initial.purchaseId, f.config, f.facts.request.url, undefined, f.facts.caller_id);
    expect(loadBuyerSigner).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('Pause during Keychain loading fences Mainnet signature and final HTTP even after Resume', async () => {
  const f = await fixture();
  try {
    f.accept(); await f.call('authorize'); await f.call('plan', { facts: f.facts });
    const sign = vi.fn(f.signer.signTransactions);
    vi.mocked(loadBuyerSigner).mockImplementation(async () => { f.app.setPaused(true); f.app.setPaused(false); return { ...f.signer, signTransactions: sign }; });
    await expect(f.call('execute', { facts: f.facts, unsigned: f.prepared })).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([url]) => String(url) === f.facts.request.url)).toBe(false);
  } finally { await f.close(); }
});
