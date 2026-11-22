import { constants, closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export function requirePrivatePairingDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || !stat.isDirectory() ||
    stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('REMOTE_READ_PRIVATE_DIRECTORY_REQUIRED');
}

/** Publish a complete credential without replacing any existing file. An
 * interrupted consent request must not leave an empty destination behind. */
export async function saveNewPairingCredential<T>(file: string, issue: () => Promise<{ credential: string; metadata: T }>,
  revoke?: (metadata: T) => Promise<void>): Promise<T> {
  const directory = dirname(file);
  requirePrivatePairingDirectory(directory);
  if (lstatSync(file, { throwIfNoEntry: false })) throw new Error('REMOTE_READ_CREDENTIAL_FILE_EXISTS');
  const staging = mkdtempSync(join(directory, '.pairing-'));
  const staged = join(staging, 'credential');
  try {
    const { credential, metadata } = await issue();
    try {
      const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, credential, 'utf8'); fsyncSync(fd); }
      finally { closeSync(fd); }
      linkSync(staged, file);
    } catch (error) {
      if (revoke) {
        try { await revoke(metadata); }
        catch { throw new Error('REMOTE_READ_CREDENTIAL_REVOKE_REQUIRED'); }
      }
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('REMOTE_READ_CREDENTIAL_FILE_EXISTS');
      throw error;
    }
    return metadata;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
