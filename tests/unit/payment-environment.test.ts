import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, type TransactionSigner } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { managementError } from '../../src/modules/app/management-auth';
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_GENESIS, MAINNET_NETWORK,
  MAINNET_USDC_MINT, TOKEN_PROGRAM, assertPaymentExecutionEnabled, resolvePaymentEnvironment,
  validatePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { loadPaymentConfig, type PaymentConfig } from '../../src/modules/payment/payment-config';
import { readWalletBalance } from '../../src/modules/app/wallet-balance';
import { runPaymentPreflight } from '../../src/modules/payment/payment-preflight';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { executeApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { purchaseMarketSnapshot } from '../../src/modules/purchases/purchase-market-snapshot';
import { PurchaseExecutionModeSchema, PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';

const buyer = '11111111111111111111111111111111';
const merchant = TOKEN_PROGRAM;
const wallets = { DEMO_BUYER_PUBLIC_KEY: buyer, DEMO_MERCHANT_PUBLIC_KEY: merchant };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const simulated = () => resolvePaymentEnvironment({});
const devnet = () => resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
const mainnet = () => resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });

describe('single payment environment', () => {
  it('preserves simulation default and freezes its exact asset identity', () => {
    const environment = simulated();
    expect(environment).toEqual({ mode: 'simulated', cluster: 'devnet', genesisHash: DEVNET_GENESIS,
      rpcUrl: 'https://api.devnet.solana.com', network: DEVNET_NETWORK, isProduction: false, productionExecutionEnabled: false,
      asset: { network: DEVNET_NETWORK, mint: DEVNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM,
        decimals: 6, symbol: 'USDC', displayLabel: 'Simulated test USDC' } });
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.asset)).toBe(true);
  });

  it('resolves Devnet through both current and legacy settings without changing payment projections', () => {
    expect(resolvePaymentEnvironment({ YOSH_ENABLE_DEVNET_PURCHASES: '1' })).toEqual(devnet());
    expect(resolvePaymentEnvironment({ APP2049_ENABLE_DEVNET_PURCHASES: '1' })).toEqual(devnet());
    expect(resolvePaymentEnvironment({ APP2049_EXECUTION_MODE: 'live_devnet' })).toEqual(devnet());
    const config = loadPaymentConfig(wallets);
    expect(config).toMatchObject(devnet());
    expect(config.mint).toBe(config.asset.mint);
    expect(Object.isFrozen(config)).toBe(true);
    // Existing CLI fixtures omit App switches; the payment-only default stays explicit.
    expect(loadPaymentConfig(wallets, 'simulated')).toMatchObject(simulated());
  });

  it('represents Mainnet without requiring any wallet or recipient', () => {
    expect(mainnet()).toEqual({ mode: 'live_mainnet', cluster: 'mainnet-beta', genesisHash: MAINNET_GENESIS,
      rpcUrl: 'https://api.mainnet-beta.solana.com', network: MAINNET_NETWORK, isProduction: true, productionExecutionEnabled: false,
      asset: { network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM,
        decimals: 6, symbol: 'USDC', displayLabel: 'USDC' } });
    expect(PurchaseExecutionModeSchema.parse('live_mainnet')).toBe('live_mainnet');
    expect(mainnet()).not.toHaveProperty('buyer');
    expect(mainnet()).not.toHaveProperty('merchant');
  });

  it.each([
    { YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_CLUSTER: 'devnet' },
    { YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_CLUSTER: 'localnet', LOCAL_USDC_MINT: DEVNET_USDC_MINT },
    { YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_CLUSTER: 'mainnet-beta' },
    { YOSH_EXECUTION_MODE: 'simulated', SOLANA_CLUSTER: 'mainnet-beta' },
    { YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_GENESIS_HASH: DEVNET_GENESIS },
    { YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_GENESIS_HASH: MAINNET_GENESIS },
    { YOSH_EXECUTION_MODE: 'live_mainnet', USDC_MINT: DEVNET_USDC_MINT },
    { YOSH_EXECUTION_MODE: 'live_devnet', USDC_MINT: MAINNET_USDC_MINT },
    { YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_NETWORK: DEVNET_NETWORK },
    { YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_NETWORK: MAINNET_NETWORK },
    { YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_RPC_URL: 'https://api.devnet.solana.com' },
    { YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' },
    { YOSH_EXECUTION_MODE: 'unknown' },
  ])('rejects contradictory or unsupported identity %j', env => {
    expect(() => resolvePaymentEnvironment(env)).toThrow('INVALID_PAYMENT_ENVIRONMENT');
  });

  it.each([
    { YOSH_EXECUTION_MODE: 'simulated', APP2049_EXECUTION_MODE: 'live_devnet' },
    { YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_DEVNET_PURCHASES: '1' },
    { YOSH_EXECUTION_MODE: 'live_devnet', APP2049_ENABLE_DEVNET_PURCHASES: '0' },
    { YOSH_EXECUTION_MODE: 'simulated', YOSH_ENABLE_DEVNET_PURCHASES: '1' },
    { YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_RPC_URL: 'https://rpc.example', SOLANA_DEVNET_RPC_URL: 'https://other.example' },
    { SOLANA_CLUSTER: 'localnet', USDC_MINT: DEVNET_USDC_MINT, LOCAL_USDC_MINT: buyer },
    { SOLANA_CLUSTER: 'localnet', LOCAL_USDC_MINT: DEVNET_USDC_MINT,
      SOLANA_NETWORK: 'solana:localnet', SOLANA_LOCALNET_NETWORK: 'solana:11111111111111111111111111111111' },
  ])('never chooses a winner for conflicting configuration %j', env => {
    expect(() => resolvePaymentEnvironment(env)).toThrow(/conflict/i);
  });

  it.each([
    { isProduction: true }, { genesisHash: null },
    { asset: { ...devnet().asset, network: MAINNET_NETWORK } },
    { asset: { ...devnet().asset, tokenProgram: buyer } },
    { asset: { ...devnet().asset, decimals: 9 } },
    { asset: { ...devnet().asset, symbol: 'OTHER' } },
    { asset: { ...devnet().asset, displayLabel: 'USDC' } },
  ])('validates immutable asset and production facts from unknown input %j', overrides => {
    expect(() => validatePaymentEnvironment({ ...devnet(), ...overrides })).toThrow('INVALID_PAYMENT_ENVIRONMENT');
  });

  it('preserves the loopback local validator harness without treating it as production', () => {
    const environment = resolvePaymentEnvironment({ SOLANA_CLUSTER: 'localnet', LOCAL_USDC_MINT: DEVNET_USDC_MINT,
      SOLANA_LOCALNET_RPC_URL: 'http://[::1]:8899', SOLANA_LOCALNET_NETWORK: 'solana:localnet' }, 'live_devnet');
    expect(environment).toMatchObject({ mode: 'live_devnet', cluster: 'localnet', genesisHash: null, isProduction: false });
    expect(() => assertPaymentExecutionEnabled(environment)).not.toThrow();
    expect(() => validatePaymentEnvironment({ ...environment, genesisHash: MAINNET_GENESIS })).toThrow('local genesis');
  });

  it('leaves arbitrary HTTPS providers to runtime genesis verification and sanitizes configuration errors', async () => {
    const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_RPC_URL: 'https://rpc.example/private?token=secret' });
    expect(environment.rpcUrl).toBe('https://rpc.example/private?token=secret');
    let failure: unknown;
    try { resolvePaymentEnvironment({ SOLANA_RPC_URL: 'http://rpc.example/private?token=secret' }); } catch (error) { failure = error; }
    expect(String(failure)).not.toContain('secret');
    const response = managementError(failure);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PAYMENT_ENVIRONMENT' });
  });

  it('uses the same configured RPC for App balance reads and rejects conflicting RPCs before fetching', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://unified-rpc.example');
    vi.stubEnv('SOLANA_DEVNET_RPC_URL', undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: { value: null } }));
    expect(await readWalletBalance(buyer, fetcher)).toMatchObject({ available: true });
    expect(String(fetcher.mock.calls[0][0])).toBe('https://unified-rpc.example/');
    fetcher.mockClear();
    vi.stubEnv('SOLANA_DEVNET_RPC_URL', 'https://conflicting-rpc.example');
    expect(await readWalletBalance(buyer, fetcher)).toMatchObject({ available: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('no Mainnet or simulated execution side effects', () => {
  it('has no Mainnet recipient/resource fallback, even with an explicit Mainnet wallet configured', () => {
    const env = { YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_MAINNET_WALLET_PUBLIC_KEY: buyer,
      get DEMO_BUYER_PUBLIC_KEY(): string { throw new Error('must not read test buyer'); },
      get DEMO_MERCHANT_PUBLIC_KEY(): string { throw new Error('must not read test recipient'); } };
    expect(() => loadPaymentConfig(env)).toThrow('Demo configuration is forbidden');
    const environment = mainnet();
    expect(environment).not.toHaveProperty('merchant');
    expect(environment).not.toHaveProperty('resource');
  });

  it('blocks Mainnet before reading Demo wallet configuration or opening the App store', () => {
    expect(() => loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_mainnet' })).toThrow('Mainnet wallet identity');
    expect(() => loadPaymentConfig({ ...wallets, YOSH_EXECUTION_MODE: 'live_mainnet' })).toThrow('Demo configuration is forbidden');
    vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
    vi.stubEnv('YOSH_ENABLE_DEVNET_PURCHASES', undefined);
    vi.stubEnv('APP2049_ENABLE_DEVNET_PURCHASES', undefined);
    const parent = mkdtempSync(join(tmpdir(), 'environment-disabled-')); dirs.push(parent);
    const directory = join(parent, 'never-opened');
    const initializeWallet = vi.fn();
    const app = new AppRuntime(directory, { initializeWallet });
    expect(app.execution().configurationReady).toBe(false);
    app.close();
    expect(existsSync(directory)).toBe(true);
    expect(initializeWallet).not.toHaveBeenCalled();
  });

  it.each(['simulated', 'live_mainnet'] as const)('blocks %s before preflight, claim, SDK and signing', async mode => {
    const environment = mode === 'simulated' ? simulated() : mainnet();
    const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer, merchant, facilitatorUrl: 'https://facilitator.invalid' };
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const signer: TransactionSigner = { address: address(buyer), signTransactions: vi.fn() };
    const ledger = new PurchaseLedger(':memory:');
    const claim = vi.spyOn(ledger, 'claim');
    const quote = { scheme: 'exact', network: config.network, asset: config.mint, amount: '10000', payTo: merchant, maxTimeoutSeconds: 300, extra: {} };
    try {
      await expect(runPaymentPreflight(config, { fetch: fetcher })).rejects.toThrow('EXECUTION_DISABLED');
      await expect(prepareSolanaPayment(config, signer, quote)).rejects.toThrow('EXECUTION_DISABLED');
      await expect(executeApprovedPayment(ledger, 'never-approved', config, 'https://resource.invalid')).rejects.toThrow('EXECUTION_DISABLED');
      expect(claim).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(signer.signTransactions).not.toHaveBeenCalled();
      expect(ledger.listForAdministration()).toEqual([]);
    } finally { ledger.close(); }
  });

  it('cannot fall through a new mode to a simulated purchase or reuse history', async () => {
    const ledger = new PurchaseLedger(':memory:');
    const config = loadPaymentConfig(wallets);
    try {
      await expect(purchaseMarketSnapshot({ purchaseId: 'new-mainnet', intent: 'disabled' },
        { config, ledger, origin: 'http://127.0.0.1:3049', mode: 'live_mainnet' })).rejects.toThrow('MAINNET_EXECUTION_DISABLED');
      expect(ledger.listForAdministration()).toEqual([]);
    } finally { ledger.close(); }
  });

  it('rejects a contradictory legacy mint projection before RPC or signer use', async () => {
    const config = { ...loadPaymentConfig(wallets), mint: MAINNET_USDC_MINT };
    const fetcher = vi.fn<typeof fetch>();
    await expect(runPaymentPreflight(config, { fetch: fetcher })).rejects.toThrow('asset projection');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
