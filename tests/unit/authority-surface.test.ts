import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { authoritySurface } from '../../src/modules/app/authority-surface';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { storeMonetaryScope } from '../../src/modules/purchases/monetary-migration';
import { SpendIntentSchema } from '../../src/modules/authority/spend-intent';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { initializeProductWallet, readExistingProductWallets } from '../../src/modules/app-wallet/product-wallet';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';

vi.mock('../../src/modules/app-wallet/product-wallet', () => ({ initializeProductWallet: vi.fn(), readExistingProductWallets: vi.fn() }));
const dirs: string[] = [];
const now = Date.now();
const unavailable = { address: '', status: 'unavailable' as const, balance: null };
const mainnet = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
const devnet = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'yosh-authority-surface-')); dirs.push(dir); return dir; }
const ledgerFiles = new WeakMap<PurchaseLedger, string>();
function ledgerFixture() { const file = join(directory(), 'ledger.sqlite'); const ledger = new PurchaseLedger(file, { managed: true, requireSpendGrant: true, mode: 'simulated', now: () => now }); ledgerFiles.set(ledger, file); return ledger; }
function surface(ledger: PurchaseLedger, env = mainnet) { return authoritySurface(ledger, env, ledger.defaultCardMember().id, unavailable, undefined, now); }
function insertAccountingFixture(ledger: PurchaseLedger, amount: string, status: 'PAID' | 'PAYMENT_UNKNOWN') {
  const mode = 'live_mainnet'; const scope = ledger.scope(mode); const day = ledger.managedSummary(now, mode).day;
  const intent = SpendIntentSchema.parse({ id: randomUUID(), idempotencyKey: randomUUID(), requestHash: 'fixture-only', resourceId: 'fixture', providerId: 'fixture',
    amount, currency: 'USDC', assetDecimals: 6, assetId: mainnet.asset.mint, network: mainnet.network, payTo: 'fixture-payee', paymentScheme: 'exact',
    quoteFingerprint: 'fixture', createdAt: now, expiresAt: now + 300_000, executionBinding: 'fixture' });
  const db = new DatabaseSync(ledgerFiles.get(ledger)!);
  const scopeId = storeMonetaryScope(db, scope);
  db.prepare('INSERT INTO purchases (id,task_id,approval_id,purchase,quote,decision,status,amount,confirmed_day,transaction_id,data,payload,owner_card_member_id,execution_mode,payment_evidence,monetary_scope_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(intent.id, intent.idempotencyKey, randomUUID(), JSON.stringify(intent),
    JSON.stringify({ scheme: 'exact', network: mainnet.network, asset: mainnet.asset.mint, amount, payTo: 'fixture-payee', maxTimeoutSeconds: 300 }),
    JSON.stringify({ decision: 'APPROVED', reason: 'FIXTURE_ONLY', committedBefore: '0', remainingAfter: '0' }), status, amount, status === 'PAID' ? day : null,
    'fixture-transaction', null, 'fixture-payload', null, mode, null, scopeId);
  db.close();
}
it('maps exact scoped Available/Reserved/Paid without borrowing Devnet amounts or asset semantics', () => {
  const ledger = ledgerFixture();
  try {
    ledger.setDailyLimit('9000000', 'live_devnet'); ledger.setDailyLimit('5000000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
    insertAccountingFixture(ledger, '1000000', 'PAYMENT_UNKNOWN'); insertAccountingFixture(ledger, '2000000', 'PAID');
    expect(surface(ledger)).toMatchObject({ available: '2000000', reserved: '1000000', paid: '2000000', availableDisplay: '2.00', reservedDisplay: '1.00', paidDisplay: '2.00', assetLabel: 'USDC' });
    expect(surface(ledger, devnet)).toMatchObject({ available: '9000000', reserved: '0', paid: '0', availableDisplay: '9.00', assetLabel: 'Test USDC' });
  } finally { ledger.close(); }
});
it('distinguishes required, paused, active and exhausted daily authority, preserving exact large integers', () => {
  const ledger = ledgerFixture();
  try {
    expect(surface(ledger).dailyState).toBe('required'); ledger.setDailyLimit('9007199254740993', 'live_mainnet');
    expect(surface(ledger)).toMatchObject({ dailyState: 'paused', availableDisplay: '9007199254.740993' });
    ledger.setPaused(false, 'live_mainnet'); expect(surface(ledger).dailyState).toBe('active');
    ledger.setDailyLimit('0', 'live_mainnet'); expect(surface(ledger)).toMatchObject({ dailyState: 'insufficient', blockers: expect.arrayContaining(['Insufficient available authority']) });
  } finally { ledger.close(); }
});
it('test grants never appear as Mainnet delegation and a member does not borrow another member grant', () => {
  const ledger = ledgerFixture();
  try {
    const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
    ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: now + 3600000 }, principal,
      { resourceId: 'fixture', providerId: 'fixture', operation: 'paid.resource.purchase', network: devnet.network, assetId: devnet.asset.mint, assetDecimals: 6, payTo: 'fixture', paymentScheme: 'exact' }, now, 'live_devnet');
    expect(surface(ledger).grant).toBeNull(); expect(surface(ledger).blockers).toContain('Spend Grant required');
    expect(surface(ledger, devnet).grant?.remainingDisplay).toBe('0.10');
    const second = ledger.createCardMember('Other member');
    expect(authoritySurface(ledger, devnet, second.id, unavailable, undefined, now).grant).toBeNull();
  } finally { ledger.close(); }
});
function runtimeFixture(walletAddress?: string) {
  vi.mocked(readExistingProductWallets).mockResolvedValue([
    { id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' },
    { id: 'devnet', label: 'Devnet', address: null, status: 'missing' },
  ]);
  for (const key of Object.keys(process.env)) if (key.startsWith('YOSH_') || key.startsWith('APP2049_') || key.startsWith('SOLANA_') || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated'); if (walletAddress) vi.stubEnv('YOSH_MAINNET_WALLET_PUBLIC_KEY', walletAddress);
  const app = new AppRuntime(directory()); app.setDailyLimit('3000000'); app.setPaused(false); app.setExecution('live_mainnet'); return app;
}
it('selecting and reading missing Mainnet wallet fails closed without creating or unpausing authority', async () => {
  const app = runtimeFixture();
  try {
    expect((await app.overview()).authority).toMatchObject({ available: null, dailyState: 'required', wallet: { address: '', status: 'unavailable' } });
    expect(await app.readAuthorityBalance()).toMatchObject({ available: false, display: 'Mainnet wallet unavailable' });
    expect(app.ledger.controls('live_mainnet')).toMatchObject({ dailyBudget: null, paused: true });
    expect(initializeProductWallet).not.toHaveBeenCalled(); expect(readExistingProductWallets).toHaveBeenCalledTimes(1);
  } finally { app.close(); }
});
it('configured but missing dedicated signer never falls back to a test wallet or reads RPC', async () => {
  const signer = await generateKeyPairSigner(); const app = runtimeFixture(signer.address); const rpc = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', rpc);
  vi.mocked(readExistingProductWallets).mockRejectedValue(new Error('fixture missing Keychain item'));
  try {
    expect(app.authority().wallet.status).toBe('unavailable');
    expect(await app.readAuthorityBalance()).toMatchObject({ available: false, display: 'Mainnet wallet unavailable' });
    expect(app.authority().wallet).toMatchObject({ address: '', status: 'unavailable', network: 'Solana Mainnet' });
    expect(initializeProductWallet).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  } finally { app.close(); }
});
it('read-only verified Mainnet balance uses its own mint, reports insufficient USDC, and exposes no signing material', async () => {
  const signer = await generateKeyPairSigner(); const app = runtimeFixture(signer.address);
  vi.mocked(readExistingProductWallets).mockResolvedValue([
    { id: 'mainnet', label: 'Mainnet', address: signer.address, status: 'available' },
    { id: 'devnet', label: 'Devnet', address: null, status: 'missing' },
  ]);
  const rpc = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: mainnet.genesisHash })).mockResolvedValueOnce(Response.json({ result: { value: null } }));
  vi.stubGlobal('fetch', rpc);
  try {
    expect(await app.readAuthorityBalance()).toMatchObject({ amount: '0', display: '0.00 USDC', available: true, network: mainnet.network, assetId: mainnet.asset.mint });
    expect(app.authority().blockers).toContain('Insufficient USDC');
    expect(app.authority().wallet.status).toBe('available');
    expect(JSON.stringify(await app.overview())).not.toMatch(/privateKey|seed|keyPair|signTransactions|buyerSignature/);
    expect(initializeProductWallet).not.toHaveBeenCalled();
  } finally { app.close(); }
});
it('Mainnet grant reports registered API, commitment, expiration and inactive states from its own scope', async () => {
  const buyer = await generateKeyPairSigner(); const payee = await generateKeyPairSigner();
  const resource = { resourceId: 'registered-api', providerId: 'provider', network: mainnet.network, mint: mainnet.asset.mint, decimals: 6 as const, recipient: payee.address,
    amount: '10000', request: { url: 'https://provider.example/data', method: 'GET' as const, access: 'https' as const, headers: {} } };
  const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_MAINNET_WALLET_PUBLIC_KEY: buyer.address, YOSH_MAINNET_RESOURCES: JSON.stringify([resource]), X402_FACILITATOR_URL: 'https://facilitator.example' }, 'live_devnet', buyer.address);
  const ledger = ledgerFixture(); const memberId = ledger.defaultCardMember().id;
  try {
    ledger.resources.initialize([resource]);
    ledger.createSpendGrant({ totalLimit: '1000000', singleLimit: '10000', expiresAt: now + 3600000 }, { cardMemberId: memberId, connectionId: randomUUID(), connectionGeneration: 1 },
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: 'paid.resource.purchase', network: mainnet.network, assetId: mainnet.asset.mint, assetDecimals: 6, payTo: payee.address, paymentScheme: 'exact' }, now, 'live_mainnet');
    const read = (time = now) => authoritySurface(ledger, mainnet, memberId, unavailable, config, time);
    expect(read().grant).toMatchObject({ resourceId: 'registered-api', api: resource.request.url, network: 'Solana Mainnet', assetLabel: 'USDC', totalDisplay: '1.00', remainingDisplay: '1.00', committedDisplay: '0.00', status: 'ACTIVE', expiresAt: now + 3600000 });
    expect(read(now + 3600001).grant?.status).toBe('EXPIRED');
    ledger.createSpendGrant({ totalLimit: '1000000', singleLimit: '10000', expiresAt: now + 7200000 }, { cardMemberId: memberId, connectionId: randomUUID(), connectionGeneration: 1 },
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: 'paid.resource.purchase', network: mainnet.network, assetId: mainnet.asset.mint, assetDecimals: 6, payTo: payee.address, paymentScheme: 'exact' }, now + 3600002, 'live_mainnet');
    ledger.revokeActiveSpendGrant(now + 3600003, 'fixture-revoked', memberId);
    expect(read(now + 3600004).grant).toMatchObject({ status: 'REVOKED', usable: false });
  } finally { ledger.close(); }
});

it.each(['x402', 'mpp_solana_charge'] as const)('keeps %s registry and Grant ready when only facilitator configuration is invalid', async paymentProtocol => {
  const buyer = await generateKeyPairSigner(); const payee = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1' });
  const resource = { ...(paymentProtocol === 'mpp_solana_charge' ? { paymentProtocol } : {}), resourceId: 'readiness-resource', providerId: 'provider', network: environment.network,
    mint: environment.asset.mint, decimals: 6 as const, recipient: payee.address, amount: '5000',
    request: { url: 'https://provider.example/data', method: 'GET' as const, access: 'https' as const, headers: {} } };
  const ledger = ledgerFixture(); const memberId = ledger.defaultCardMember().id;
  try {
    ledger.resources.initialize([resource]); ledger.setDailyLimit('10000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
    ledger.createSpendGrant({ totalLimit: '10000', singleLimit: '5000', expiresAt: now + 3600000 },
      { cardMemberId: memberId, connectionId: randomUUID(), connectionGeneration: 1 },
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: 'paid.resource.purchase',
        network: environment.network, assetId: environment.asset.mint, assetDecimals: 6, payTo: payee.address,
        paymentScheme: paymentProtocol === 'x402' ? 'exact' : 'mpp_charge', ...(paymentProtocol === 'mpp_solana_charge' ? { maximumNetworkFeeLamports: '10000' } : {}) }, now, 'live_mainnet');
    const wallet = { address: buyer.address, status: 'available' as const, balance: '10000' };
    const broken = authoritySurface(ledger, environment, memberId, wallet, undefined, now, {
      facilitator: { ready: false, code: 'FACILITATOR_CONFIGURATION_INVALID', mode: 'configured_endpoint' },
      configurationCode: 'FACILITATOR_CONFIGURATION_INVALID', connectionEnabled: true });
    expect(broken.readiness).toMatchObject({ environment: { ready: true }, wallet: { ready: true },
      dailyAuthority: { ready: true }, resourceRegistration: { ready: true }, spendGrantAuthorization: { ready: true },
      facilitator: { ready: false, code: 'FACILITATOR_CONFIGURATION_INVALID' },
      transactionExecution: { eligible: false, code: 'FACILITATOR_CONFIGURATION_INVALID', quotePreflightRequired: true } });
    expect(broken.grant).toMatchObject({ usable: true, api: resource.request.url });
    expect(broken.blockers).toContain('Payment facilitator configuration invalid');
    expect(broken.blockers).not.toContain('Spend Grant required');
    expect(broken.blockers).not.toContain('Registered API setup required');

    const merchantManaged = authoritySurface(ledger, environment, memberId, wallet, undefined, now, {
      facilitator: { ready: true, code: null, mode: 'merchant_quote' }, connectionEnabled: true });
    expect(merchantManaged.readiness.facilitator).toMatchObject({ ready: true, mode: 'merchant_quote', verification: 'quote_required' });
    expect(merchantManaged.readiness.transactionExecution).toEqual({ eligible: true, code: null, quotePreflightRequired: true });
  } finally { ledger.close(); }
});
