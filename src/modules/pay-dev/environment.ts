import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export const DevelopmentEnvironment = z.object({ version: z.literal(1), environment: z.enum(['offline', 'mainnet']),
  mainnetRiskAccepted: z.boolean(), rpcUrl: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && (!url.port || url.port === '443');
  }) }).strict().refine(value => value.environment !== 'mainnet' || value.mainnetRiskAccepted);
export const DEFAULT_DEV_RPC = 'https://solana-rpc.publicnode.com';
export function assertDevelopmentDirectory(directory: string, name: string) {
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || basename(directory) !== name || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
}
export function readDevelopmentEnvironment(root: string) {
  assertDevelopmentDirectory(root, 'Yosh Pay Dev');
  const path = join(root, 'development-environment.json');
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return DevelopmentEnvironment.parse({ version: 1, environment: 'offline', mainnetRiskAccepted: false, rpcUrl: DEFAULT_DEV_RPC });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
    throw new Error('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  return DevelopmentEnvironment.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** No environment variable can turn the production wallet into a Dev wallet.
 * The native Dev identity selects its own private directory and reviewed profile. */
export function isMainnetDevelopment(directory = process.env.YOSH_DATA_DIR ?? '') {
  if (process.env.YOSH_PAY_DEV !== '1' || process.env.YOSH_PAY_DEV_ENV !== 'mainnet') return false;
  assertDevelopmentDirectory(directory, 'Mainnet');
  const selection = readDevelopmentEnvironment(dirname(directory));
  if (selection.environment !== 'mainnet' || process.env.YOSH_DATA_DIR !== directory
    || process.env.SOLANA_MAINNET_RPC_URL !== selection.rpcUrl) throw new Error('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  return true;
}

export function assertDevelopmentStorage(directory: string) {
  for (const file of ['app-ledger.sqlite', 'backend-owner.sqlite', 'app-ledger.sqlite.writer-lock']) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const stat = lstatSync(join(directory, file + suffix));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('PAY_DEVELOPMENT_STORAGE_REJECTED');
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
}

/** Dev Mainnet is a fresh isolated store, never an import of a user Ledger.
 * The receipt is created before the first Ledger, then preserved across restart. */
export function admitMainnetDevelopment(directory: string) {
  if (!isMainnetDevelopment(directory)) throw new Error('PAY_MAINNET_CONFIGURATION_REQUIRED');
  const path = join(directory, 'pay-development-mainnet.json');
  const marker = { version: 1, kind: 'yosh-pay-mainnet-development', directory };
  if (!existsSync(path)) {
    if (['app-ledger.sqlite', 'app-ledger.sqlite-wal', 'app-ledger.sqlite-journal'].some(file => existsSync(join(directory, file))))
      throw new Error('PAY_DEVELOPMENT_EXISTING_LEDGER_REJECTED');
    writeFileSync(path, JSON.stringify(marker), { flag: 'wx', mode: 0o600, flush: true });
    const folder = openSync(directory, 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(marker)) throw new Error('PAY_DEVELOPMENT_MARKER_REQUIRED');
}
