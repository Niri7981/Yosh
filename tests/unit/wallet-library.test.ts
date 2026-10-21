import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';
import { WalletLibrary, type LibrarySecretStore } from '../../src/modules/app-wallet/wallet-library';

const databases: DatabaseSync[] = [];
function database() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec('CREATE TABLE ledger_schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  return db;
}
function memoryStore() {
  const keys = new Map<string, string>();
  let writes = 0;
  const store: LibrarySecretStore = {
    read: async id => keys.get(id),
    create: async (id, secret) => { if (keys.has(id)) throw new Error('duplicate'); writes++; keys.set(id, secret); },
  };
  return { store, keys, writes: () => writes };
}
async function fixtureSecret(value: number) {
  const seed = new Uint8Array(32).fill(value);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
  return { secret: getBase58Decoder().decode(new Uint8Array([...seed, ...pub])), address: signer.address };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

describe('wallet library management boundary', () => {
  it('creates once across concurrent retries and metadata reopen without exposing keys', async () => {
    const db = database(); const memory = memoryStore(); const library = new WalletLibrary(db, memory.store);
    const input = { kind: 'create', label: 'Agent wallet', requestId: randomUUID() };
    const results = await Promise.all([library.add(input), library.add(input), library.add(input)]);
    expect(new Set(results.map(item => item.address)).size).toBe(1);
    expect(memory.writes()).toBe(1);
    const reopened = new WalletLibrary(db, memory.store);
    expect(await reopened.add(input)).toEqual(results[0]);
    expect(reopened.list()).toHaveLength(1);
    expect(JSON.stringify(reopened.list())).not.toContain([...memory.keys.values()][0]);
    expect(db.prepare('SELECT * FROM wallet_library').get()).not.toHaveProperty('private_key');
    await expect(reopened.add({ ...input, label: 'Changed' })).rejects.toMatchObject({ code: 'WALLET_REQUEST_CONFLICT' });
  });
  it('imports a verified key, rejects mismatched and duplicate identities, and never changes payment slots', async () => {
    const { secret, address } = await fixtureSecret(7);
    const memory = memoryStore(); const library = new WalletLibrary(database(), memory.store);
    const input = { requestId: randomUUID(), kind: 'import', label: 'Imported', privateKey: secret };
    await expect(library.add(input, [address])).rejects.toMatchObject({ code: 'WALLET_ALREADY_SAVED' });
    expect(memory.writes()).toBe(0);
    expect((await library.add(input)).address).toBe(address);
    await expect(library.add({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'WALLET_ALREADY_SAVED' });
    const other = await fixtureSecret(8);
    await expect(library.add({ ...input, privateKey: other.secret })).rejects.toMatchObject({ code: 'WALLET_REQUEST_CONFLICT' });
    expect([...memory.keys.keys()]).toEqual([input.requestId]);
  });
  it('saves watch-only addresses without touching any signer', async () => {
    const { address } = await fixtureSecret(9);
    const memory = memoryStore(); const library = new WalletLibrary(database(), memory.store);
    expect((await library.add({ requestId: randomUUID(), kind: 'watch', label: 'Observer', address })).kind).toBe('watch');
    expect(memory.writes()).toBe(0);
    expect(memory.keys.size).toBe(0);
  });
  it('recovers a Keychain write whose acknowledgement was lost after restart, without a second key', async () => {
    const db = database(); const memory = memoryStore();
    const interrupted: LibrarySecretStore = { read: memory.store.read, create: async (id, key) => {
      await memory.store.create(id, key); throw new Error('lost acknowledgement');
    } };
    const input = { requestId: randomUUID(), label: 'Recover me', kind: 'create' };
    const first = new WalletLibrary(db, interrupted);
    await expect(first.add(input)).rejects.toMatchObject({ code: 'WALLET_KEYCHAIN_UNAVAILABLE' });
    expect(first.list()[0].status).toBe('setup_pending');
    const recovered = await new WalletLibrary(db, memory.store).add(input);
    expect(recovered.status).toBe('saved'); expect(memory.writes()).toBe(1);
  });
  it('denied reads never cause creation; corrupt or wrong saved keys fail closed', async () => {
    const db = database(); let creates = 0;
    const input = { requestId: randomUUID(), kind: 'create', label: 'Locked' };
    const denied = new WalletLibrary(db, { read: async () => { throw new Error('locked'); }, create: async () => { creates++; } });
    await expect(denied.add(input)).rejects.toMatchObject({ code: 'WALLET_KEYCHAIN_UNAVAILABLE' });
    expect(creates).toBe(0);
    const intended = await fixtureSecret(10); const wrong = await fixtureSecret(11);
    const conflict = new WalletLibrary(db, { read: async () => wrong.secret, create: async () => { creates++; } });
    await expect(conflict.add({ requestId: randomUUID(), kind: 'import', label: 'Wrong', privateKey: intended.secret }))
      .rejects.toMatchObject({ code: 'WALLET_IDENTITY_CONFLICT' });
    expect(creates).toBe(0);
  });
  it('rejects malformed input and does not disclose the submitted secret', async () => {
    const library = new WalletLibrary(database(), memoryStore().store);
    await expect(library.add({ requestId: randomUUID(), kind: 'import', label: 'Invalid', privateKey: '1'.repeat(64) }))
      .rejects.toMatchObject({ code: 'WALLET_KEY_INVALID' });
    expect(() => library.add({ requestId: randomUUID(), kind: 'watch', label: 'Invalid', address: 'bad', approved: true })).toThrow();
    expect(library.list()).toEqual([]);
  });
});
