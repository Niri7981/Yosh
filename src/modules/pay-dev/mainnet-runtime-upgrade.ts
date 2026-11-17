import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireDataDirectoryOwnership } from '../app/data-directory-owner';
import { installMainnetRuntime, verifyMainnetRuntime } from './mainnet-runtime-artifact';
import { claimMainnetProcessLock, inspectMainnetBackend, readMainnetOwner, stopMainnetBackend,
  writeMainnetOwner, type MainnetOwnerConfiguration } from './mainnet-standalone-owner';

/** Explicit operator handoff, never called by MCP startup or a payment retry.
 * Program versions change only after the original owner has drained. Financial
 * state and production settings are not copied, replaced or reset. */
export async function upgradeMainnetRuntime(source: string, configuration: MainnetOwnerConfiguration & { root: string }, fetcher?: typeof fetch) {
  const { digest } = verifyMainnetRuntime(source);
  const installed = installMainnetRuntime(source, configuration.root);
  const previous = readMainnetOwner(configuration.directory);
  if (!previous || previous.runtimeDigest === digest) return installed;
  const oldRuntime = join(dirname(configuration.root), 'Yosh Mainnet Runtime', previous.runtimeDigest);
  if (verifyMainnetRuntime(oldRuntime).digest !== previous.runtimeDigest) throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
  await stopMainnetBackend({ configuration, digest: previous.runtimeDigest, fetcher });
  const startup = claimMainnetProcessLock(configuration.directory, 'mainnet-standalone-start.sqlite');
  try {
    const service = claimMainnetProcessLock(configuration.directory, 'mainnet-standalone-service.sqlite');
    try {
      // The App also takes this lock. A stopped TCP listener alone is not
      // proof that signing, recovery or another product entry has stopped.
      const core = acquireDataDirectoryOwnership(configuration.directory);
      try {
        const stopped = readMainnetOwner(configuration.directory);
        if (!stopped || stopped.runtimeDigest !== previous.runtimeDigest || stopped.ready)
          throw new Error('MAINNET_RUNTIME_HANDOFF_CHANGED');
        if (await inspectMainnetBackend({ configuration, digest: previous.runtimeDigest, fetcher }))
          throw new Error('MAINNET_STOP_INCOMPLETE');
        writeFileSync(join(configuration.directory, 'mainnet-runtime-upgrade-' + randomBytes(16).toString('hex') + '.json'),
          JSON.stringify({ version: 1, previous: stopped, nextDigest: digest, installed }), { mode: 0o600, flag: 'wx', flush: true });
        writeMainnetOwner(configuration.directory, digest, false);
      } finally { core.release(); }
    } finally { service.release(); }
  } finally { startup.release(); }
  return installed;
}
