import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { z } from 'zod';
import { readLibraryWalletKeychain, createLibraryWalletKeychain } from '../payment/keychain';
import { ManagementApiError } from '../app/management-auth';

const PublicAddress = z.string().refine(value => { try { address(value); return true; } catch { return false; } });
export const AddWalletSchema = z.discriminatedUnion('kind', [
  z.object({ requestId: z.uuid(), label: z.string().trim().min(1).max(48), kind: z.literal('create') }).strict(),
  z.object({ requestId: z.uuid(), label: z.string().trim().min(1).max(48), kind: z.literal('import'), privateKey: z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/) }).strict(),
  z.object({ requestId: z.uuid(), label: z.string().trim().min(1).max(48), kind: z.literal('watch'), address: PublicAddress }).strict(),
]);
type AddWallet = z.infer<typeof AddWalletSchema>;
export type LibraryWallet = { id: string; label: string; address: string | null; kind: AddWallet['kind']; status: 'saved' | 'setup_pending'; createdAt: number };
export type LibrarySecretStore = { read(id: string): Promise<string | undefined>; create(id: string, secret: string): Promise<void> };
const systemStore: LibrarySecretStore = { read: readLibraryWalletKeychain, create: createLibraryWalletKeychain };
const fail = (code: string, message: string, status = 409) => new ManagementApiError(code, status, message);

async function publicKey(secret: string) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(secret));
    if (bytes.length !== 64) throw new Error();
    return (await createKeyPairSignerFromBytes(bytes)).address;
  } catch { throw fail('WALLET_KEY_INVALID', 'Enter a valid Solana Base58 private key.', 400); }
  finally { bytes?.fill(0); }
}
async function generateSecret() {
  const seed = new Uint8Array(randomBytes(32));
  let bytes: Uint8Array | undefined;
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
    bytes = new Uint8Array([...seed, ...pub]);
    return getBase58Decoder().decode(bytes);
  } finally { seed.fill(0); bytes?.fill(0); }
}

/** An additive wallet library. These credentials never replace the pinned payment
 * signer or inherit grants. Pending intents survive a crash around Keychain writes. */
export class WalletLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private db: DatabaseSync, private store: LibrarySecretStore = systemStore, private now = Date.now) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT id FROM ledger_schema_migrations WHERE id='018_wallet_library'").get()) {
        db.exec(`CREATE TABLE wallet_library (
          id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','import','watch')),
          address TEXT UNIQUE, intended_address TEXT, status TEXT NOT NULL CHECK(status IN ('setup_pending','saved')), created_at INTEGER NOT NULL);
          CREATE TRIGGER wallet_library_saved_identity BEFORE UPDATE ON wallet_library WHEN OLD.status='saved'
          BEGIN SELECT RAISE(ABORT,'saved wallet is immutable'); END;`);
        db.prepare('INSERT INTO ledger_schema_migrations VALUES (?,?)').run('018_wallet_library', now());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  list(): LibraryWallet[] {
    return this.db.prepare('SELECT * FROM wallet_library ORDER BY created_at,id').all().map(row => ({
      id: z.uuid().parse(row.id), label: z.string().parse(row.label), address: row.address === null ? null : PublicAddress.parse(row.address),
      kind: z.enum(['create', 'import', 'watch']).parse(row.kind), status: z.enum(['saved', 'setup_pending']).parse(row.status), createdAt: z.number().parse(row.created_at),
    }));
  }
  add(raw: unknown, existingAddresses: readonly string[] = []): Promise<LibraryWallet> {
    const input = AddWalletSchema.parse(raw);
    const operation = this.queue.then(() => this.performAdd(input, existingAddresses));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async performAdd(input: AddWallet, existingAddresses: readonly string[]) {
    const intended = input.kind === 'import' ? await publicKey(input.privateKey) : input.kind === 'watch' ? input.address : null;
    let row = this.db.prepare('SELECT * FROM wallet_library WHERE id=?').get(input.requestId);
    if (row && (row.label !== input.label || row.kind !== input.kind || (input.kind !== 'create' && row.intended_address !== intended)))
      throw fail('WALLET_REQUEST_CONFLICT', 'This setup request belongs to a different wallet.');
    if (row?.status === 'saved') return this.list().find(item => item.id === input.requestId)!;
    if (intended && (existingAddresses.includes(intended) || this.list().some(item => item.address === intended && item.id !== input.requestId)))
      throw fail('WALLET_ALREADY_SAVED', 'This address is already in Yosh.');
    if (!row) {
      if (this.list().length >= 32) throw fail('WALLET_LIBRARY_FULL', 'You can save up to 32 wallets on this Mac.');
      this.db.prepare("INSERT INTO wallet_library VALUES (?,?,?,NULL,?,'setup_pending',?)")
        .run(input.requestId, input.label, input.kind, intended, this.now());
      row = this.db.prepare('SELECT * FROM wallet_library WHERE id=?').get(input.requestId)!;
    }
    let walletAddress: string;
    if (input.kind === 'watch') walletAddress = input.address;
    else {
      try {
        let secret = await this.store.read(input.requestId);
        if (!secret) {
          secret = input.kind === 'create' ? await generateSecret() : input.privateKey;
          const expectedAddress = await publicKey(secret);
          this.db.prepare("UPDATE wallet_library SET intended_address=? WHERE id=? AND status='setup_pending'")
            .run(expectedAddress, input.requestId);
          // Create-only. A failed or ambiguous write is never retried with a new ID.
          await this.store.create(input.requestId, secret);
        }
        const verified = await this.store.read(input.requestId);
        if (!verified) throw new Error();
        walletAddress = await publicKey(verified);
        const pinned = this.db.prepare('SELECT intended_address FROM wallet_library WHERE id=?').get(input.requestId)?.intended_address;
        if (pinned !== walletAddress) throw fail('WALLET_IDENTITY_CONFLICT', 'The saved key does not match this wallet.');
      } catch (error) {
        if (error instanceof ManagementApiError) throw error;
        throw fail('WALLET_KEYCHAIN_UNAVAILABLE', 'Wallet setup is unfinished. Allow Keychain access, then retry the same request.', 503);
      }
    }
    if (existingAddresses.includes(walletAddress) || this.list().some(item => item.address === walletAddress && item.id !== input.requestId))
      throw fail('WALLET_ALREADY_SAVED', 'This address is already in Yosh.');
    this.db.prepare("UPDATE wallet_library SET address=?,status='saved' WHERE id=? AND status='setup_pending'")
      .run(walletAddress, input.requestId);
    return this.list().find(item => item.id === input.requestId)!;
  }
}
