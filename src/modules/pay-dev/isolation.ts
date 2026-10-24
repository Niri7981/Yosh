import { PAY_DEVELOPMENT_PROFILE } from './profile';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { DEVNET_NETWORK } from '../payment/payment-config';
import { isMainnetDevelopment } from './environment';

const Marker = z.object({ version: z.literal(1), kind: z.literal('yosh-pay-offline-development'),
  buyer: z.string().min(32).max(44), network: z.literal(DEVNET_NETWORK) }).strict();

/** Explicit offline delivery profile. It never admits an existing user ledger.
 * Both the native child and Pay run in a loopback-only OS sandbox as well. */
export function isPayDevelopmentDirectory(directory: string) {
  if (process.env.YOSH_PAY_DEV !== '1') return false;
  if (isMainnetDevelopment(directory)) return false;
  const info = lstatSync(directory);
  const canonical = realpathSync(directory);
  if (canonical !== directory || basename(canonical) !== PAY_DEVELOPMENT_PROFILE.directoryName || !info.isDirectory() || info.isSymbolicLink()
    || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || process.env.YOSH_DATA_DIR !== directory)
    throw new Error('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  const marker = join(directory, 'pay-development.json');
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('PAY_DEVELOPMENT_MARKER_REQUIRED');
  Marker.parse(JSON.parse(readFileSync(marker, 'utf8')));
  return true;
}
