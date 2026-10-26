import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMainnetPayExecution, createPayExecution, readPayLifetime } from '../../src/modules/payment/mainnet-pay-execution';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { solanaRpc } from '../../src/modules/payment/solana-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';

const directories: string[] = [];
vi.mock('../../src/modules/payment/solana-payment', async original => ({
  ...await original<typeof import('../../src/modules/payment/solana-payment')>(), solanaRpc: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function devnetProfile() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-pay-networks-')));
  directories.push(parent);
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName);
  const directory = join(root, 'Devnet');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({
    version: 1, environment: 'devnet', mainnetRiskAccepted: false, rpcUrl: 'https://solana-rpc.publicnode.com',
  }), { mode: 0o600 });
  for (const [key, value] of Object.entries({ YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'devnet', YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_MAINNET_EXECUTION: '0',
    YOSH_DATA_DIR: directory, YOSH_PAY_MCP_MAINNET: undefined, YOSH_PAY_MCP_DEVNET: '1', SOLANA_DEVNET_RPC_URL: 'https://api.devnet.solana.com' })) vi.stubEnv(key, value);
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_devnet' });
  const config = { ...environment, buyer: '11111111111111111111111111111111',
    merchant: '11111111111111111111111111111111', mint: environment.asset.mint, facilitatorUrl: null };
  return { directory, config };
}

it('explicit real Devnet profile reaches the same bound Pay executor without Mainnet enablement', () => {
  const { directory, config } = devnetProfile();
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
  try {
    ledger.executionSafety.enable(Date.now());
    const options = { network: 'devnet' as const, takeUnsigned: async () => { throw new Error('UNSIGNED_NOT_REQUESTED'); } };
    const executor = createPayExecution(options);
    executor.bindRuntime?.(directory, ledger);
    expect(() => executor.assertEligibility(config, ledger)).not.toThrow();
  } finally { ledger.close(); }
});

it.each(['flag', 'profile', 'network', 'mint', 'production', 'unbound-ledger', 'fenced'] as const)(
  'rejects Devnet before unsigned preparation when %s is invalid', condition => {
    const { directory, config } = devnetProfile();
    const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
    const other = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
    const takeUnsigned = vi.fn();
    try {
      if (condition !== 'fenced') ledger.executionSafety.enable(Date.now());
      const executor = createPayExecution({ network: 'devnet', takeUnsigned });
      executor.bindRuntime?.(directory, ledger);
      if (condition === 'flag') vi.stubEnv('YOSH_PAY_MCP_DEVNET', undefined);
      if (condition === 'profile') vi.stubEnv('YOSH_PAY_DEV_ENV', 'offline');
      if (condition === 'network') config.network = MAINNET_NETWORK;
      if (condition === 'mint') config.mint = MAINNET_USDC_MINT;
      if (condition === 'production') config.productionExecutionEnabled = true;
      expect(() => executor.assertEligibility(config, condition === 'unbound-ledger' ? other : ledger))
        .toThrow(['network', 'mint', 'production'].includes(condition) ? 'INVALID_PAYMENT_ENVIRONMENT' : 'PAY_DEVNET_CONFIGURATION_REQUIRED');
      expect(takeUnsigned).not.toHaveBeenCalled();
    } finally { ledger.close(); other.close(); }
  },
);

it('the existing Mainnet factory does not become a Devnet entry when both runtime flags are set', () => {
  const { directory, config } = devnetProfile();
  const ledger = new PurchaseLedger(':memory:', { managed: true, mode: 'live_devnet' });
  try {
    ledger.executionSafety.enable(Date.now());
    vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1');
    const executor = createMainnetPayExecution({ takeUnsigned: vi.fn() });
    executor.bindRuntime?.(directory, ledger);
    expect(() => executor.assertEligibility(config, ledger)).toThrow('PAY_MAINNET_CONFIGURATION_REQUIRED');
  } finally { ledger.close(); }
});

it('reads an exact real Devnet lifetime only after matching its genesis hash', async () => {
  const { config } = devnetProfile();
  vi.mocked(solanaRpc).mockResolvedValueOnce(config.genesisHash).mockResolvedValueOnce({
    value: { blockhash: config.buyer, lastValidBlockHeight: 1234 },
  });
  await expect(readPayLifetime(config, 'devnet')).resolves.toEqual({ recentBlockhash: config.buyer, lastValidBlockHeight: '1234' });
  expect(solanaRpc).toHaveBeenNthCalledWith(1, config, 'getGenesisHash');
  expect(solanaRpc).toHaveBeenNthCalledWith(2, config, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
});

it('rejects another chain before obtaining a usable lifetime', async () => {
  const { config } = devnetProfile();
  vi.mocked(solanaRpc).mockResolvedValueOnce('wrong-genesis');
  await expect(readPayLifetime(config, 'devnet')).rejects.toThrow('PAY_RPC_NETWORK_MISMATCH');
  expect(solanaRpc).toHaveBeenCalledOnce();
});
