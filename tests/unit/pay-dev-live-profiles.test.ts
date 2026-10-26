import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { admitDevnetDevelopment, admitSimulatedDevelopment, DEFAULT_DEVNET_RPC, DEFAULT_DEV_RPC,
  isDevnetDevelopment, isSimulatedDevelopment, readDevelopmentEnvironment } from '../../src/modules/pay-dev/environment';
import { isPayDevelopmentDirectory } from '../../src/modules/pay-dev/isolation';
import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(profile: 'devnet' | 'simulated' = 'devnet') {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-live-profile-'))); directories.push(parent);
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, profile === 'devnet' ? 'Devnet' : 'Simulated'); mkdirSync(directory, { mode: 0o700 });
  const selection = { version: 1, environment: profile, mainnetRiskAccepted: false, rpcUrl: DEFAULT_DEV_RPC };
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify(selection), { mode: 0o600 });
  vi.stubEnv('YOSH_PAY_DEV', '1'); vi.stubEnv('YOSH_PAY_DEV_ENV', profile); vi.stubEnv('YOSH_DATA_DIR', directory);
  vi.stubEnv('YOSH_EXECUTION_MODE', profile === 'devnet' ? 'live_devnet' : 'simulated');
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '0'); vi.stubEnv('SOLANA_RPC_URL', DEFAULT_DEVNET_RPC);
  return { root, directory, selection };
}

it.each(['devnet', 'simulated'] as const)('admits %s without touching Mainnet/Offline data or changing four-field selection', profile => {
  const { root, directory, selection } = fixture(profile);
  const mainnet = join(root, 'Mainnet'); mkdirSync(mainnet, { mode: 0o700 });
  writeFileSync(join(mainnet, 'app-ledger.sqlite'), 'mainnet-sentinel');
  writeFileSync(join(root, 'app-ledger.sqlite'), 'offline-sentinel');
  expect(readDevelopmentEnvironment(root)).toEqual(selection);
  expect(isDevnetDevelopment(directory)).toBe(profile === 'devnet');
  expect(isSimulatedDevelopment(directory)).toBe(profile === 'simulated');
  expect(isPayDevelopmentDirectory(directory)).toBe(false);
  const admit = profile === 'devnet' ? admitDevnetDevelopment : admitSimulatedDevelopment;
  admit(directory);
  const marker = join(directory, `pay-development-${profile}.json`);
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ version: 1, kind: `yosh-pay-${profile}-development`, directory });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  // Once admitted, existing evidence is retained across the next startup.
  writeFileSync(join(directory, 'app-ledger.sqlite'), 'own-ledger-sentinel', { mode: 0o600 });
  admit(directory);
  expect(readFileSync(join(directory, 'app-ledger.sqlite'), 'utf8')).toBe('own-ledger-sentinel');
  expect(readFileSync(join(mainnet, 'app-ledger.sqlite'), 'utf8')).toBe('mainnet-sentinel');
  expect(readFileSync(join(root, 'app-ledger.sqlite'), 'utf8')).toBe('offline-sentinel');
  expect(JSON.parse(readFileSync(join(root, 'development-environment.json'), 'utf8'))).toEqual(selection);
  expect(existsSync(join(directory, 'offline-buyer.json'))).toBe(false);
});

it('rejects an unmarked existing ledger, mismatched profile, wrong RPC and production enablement', () => {
  const { root, directory, selection } = fixture();
  writeFileSync(join(directory, 'app-ledger.sqlite'), 'unowned-evidence', { mode: 0o600 });
  expect(() => admitDevnetDevelopment(directory)).toThrow('PAY_DEVELOPMENT_EXISTING_LEDGER_REJECTED');
  expect(readFileSync(join(directory, 'app-ledger.sqlite'), 'utf8')).toBe('unowned-evidence');
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ ...selection, environment: 'mainnet', mainnetRiskAccepted: true }));
  expect(() => isDevnetDevelopment()).toThrow('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify(selection));
  vi.stubEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');
  expect(() => isDevnetDevelopment()).toThrow();
  vi.stubEnv('SOLANA_RPC_URL', DEFAULT_DEVNET_RPC); vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1');
  expect(() => isDevnetDevelopment()).toThrow();
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '0'); vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1');
  expect(() => isDevnetDevelopment()).toThrow('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
});

it('rejects aliases, weak selection permissions and tampered admission markers', () => {
  const { root, directory } = fixture();
  const alias = join(root, 'alias'); symlinkSync(directory, alias);
  vi.stubEnv('YOSH_DATA_DIR', alias);
  expect(() => isDevnetDevelopment()).toThrow('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  vi.stubEnv('YOSH_DATA_DIR', directory);
  chmodSync(join(root, 'development-environment.json'), 0o644);
  expect(() => isDevnetDevelopment()).toThrow('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  chmodSync(join(root, 'development-environment.json'), 0o600);
  admitDevnetDevelopment(directory);
  writeFileSync(join(directory, 'pay-development-devnet.json'), '{}');
  expect(() => admitDevnetDevelopment(directory)).toThrow('PAY_DEVELOPMENT_MARKER_REQUIRED');
});

it('binds an optional Devnet RPC independently of the retained Mainnet endpoint', () => {
  const { root, directory, selection } = fixture();
  const rpc = 'https://devnet-rpc.fixture.example/public';
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ ...selection, devnetRpcUrl: rpc }));
  vi.stubEnv('SOLANA_RPC_URL', rpc);
  expect(isDevnetDevelopment(directory)).toBe(true);
  expect(readDevelopmentEnvironment(root).rpcUrl).toBe(DEFAULT_DEV_RPC);
  vi.stubEnv('SOLANA_RPC_URL', DEFAULT_DEVNET_RPC);
  expect(() => isDevnetDevelopment(directory)).toThrow('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
});
