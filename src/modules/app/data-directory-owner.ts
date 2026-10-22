import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export class DataDirectoryInUseError extends Error {
  constructor() { super('DATA_DIRECTORY_IN_USE'); }
}

/** A separate SQLite write lock protects the whole data directory before ledger recovery.
 * The OS releases it on process death; the lock database is never deleted or used for payments.
 */
export function acquireDataDirectoryOwnership(directory: string, lockName = 'backend-owner.sqlite') {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(directory), lockName);
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    if (error instanceof Error && error.message.includes('database is locked')) throw new DataDirectoryInUseError();
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}
