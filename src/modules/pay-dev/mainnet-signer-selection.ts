import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isMainnetDevelopment } from './environment';
import { PAY_DEVELOPMENT_PROFILE } from './profile';

export const LEGACY_PAY_DEV_MAINNET = Object.freeze({
  service: 'com.yosh.pay-development.wallet.mainnet.v1', account: 'consumer-wallet-mainnet-v1',
  publicAddress: '5jgN7QN4uYdYLHrEcUvZczciV144TRxz2Xjr1MYPJYHj',
});
const Acceptance = z.object({ version: z.literal(1), identity: z.literal('legacy-pay-dev-mainnet') }).strict();

/** Operator-owned candidate configuration, never an MCP argument or service-name override.
 * This only selects an existing read-only slot; absence never provisions a wallet. */
export function legacyMainnetSignerSelected(): boolean {
  if (process.env.YOSH_PAY_DEV !== '1') return false;
  if (!isMainnetDevelopment()) throw new Error('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  const directory = process.env.YOSH_DATA_DIR;
  if (!directory) throw new Error('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  const path = join(dirname(directory), 'mainnet-signer-acceptance.json');
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  }
  if (PAY_DEVELOPMENT_PROFILE.bundleIdentifier !== 'com.yosh.pay-development.v011rc5'
    || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
    throw new Error('LEGACY_MAINNET_ACCEPTANCE_REJECTED');
  try {
    if (!Acceptance.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success) throw new Error();
  } catch { throw new Error('LEGACY_MAINNET_ACCEPTANCE_REJECTED'); }
  return true;
}
export function assertLegacyMainnetSignerAddress(actual: string) {
  if (legacyMainnetSignerSelected() && actual !== LEGACY_PAY_DEV_MAINNET.publicAddress)
    throw new Error('LEGACY_MAINNET_SIGNER_IDENTITY_MISMATCH');
}
