import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { address } from '@solana/kit';
import { z } from 'zod';
import { APP_WALLET_KEYCHAIN, MAINNET_WALLET_KEYCHAIN, productWalletSlotKeychain } from '../payment/keychain';
import { DEVNET_NETWORK, MAINNET_NETWORK } from '../payment/payment-environment';
import { PRODUCT_MAINNET_WALLET_ID, PRODUCT_TEST_WALLET_ID } from '../purchases/monetary-scope';

const SlotSchema = z.enum(['mainnet', 'devnet']);
export type WalletSlot = z.infer<typeof SlotSchema>;
const PublicKeySchema = z.string().refine(value => { try { address(value); return true; } catch { return false; } });
export type WalletProvisioningState = 'checking' | 'absent_fresh' | 'existing' | 'access_denied_or_locked' | 'corrupt'
  | 'identity_conflict' | 'isolation_unverified' | 'restore_required' | 'setup_pending';
export type WalletInventoryEntry = { id: string; label: string; address: string | null; status: 'missing' | 'available' | 'unavailable'; failure?: 'corrupt' | 'access_denied_or_locked' };
export type WalletAccountObservation = WalletInventoryEntry & { provisioningState: WalletProvisioningState; accountId?: string };
export type WalletAccount = Readonly<{ accountId: string; slot: WalletSlot; publicKey: string; network: string;
  legacyWalletIdentity: string; origin: 'legacy'; backupState: 'legacy_unverified'; createdAt: number;
  credentialRef: Readonly<{ domain: 'user-default-search-list'; service: string; account: string; accessBackend: 'legacy-security' }> }>;
export type WalletObservationOptions = { mainnetAssertion?: string };

function slotIdentity(slot: WalletSlot) {
  const item = process.env.YOSH_PAY_DEV === '1' && process.env.YOSH_PAY_DEV_ENV === 'mainnet'
    ? productWalletSlotKeychain(slot) : slot === 'mainnet' ? MAINNET_WALLET_KEYCHAIN : APP_WALLET_KEYCHAIN;
  return slot === 'mainnet' ? { item, walletIdentity: PRODUCT_MAINNET_WALLET_ID, network: MAINNET_NETWORK }
    : { item, walletIdentity: PRODUCT_TEST_WALLET_ID, network: DEVNET_NETWORK };
}

/** Metadata only: this class cannot read, create, replace or delete Keychain material.
 * The legacy scope IDs remain unchanged; an immutable public-key pin closes the
 * same-slot/new-key path without rebinding historical grants or reservations. */
export class WalletAccounts {
  constructor(private db: DatabaseSync, private now: () => number,
    private historicalPayer: (approvalId: string) => string | undefined) {
    this.atomic(() => {
      if (db.prepare("SELECT id FROM ledger_schema_migrations WHERE id='017_wallet_account_identity'").get()) return;
      db.exec(`CREATE TABLE wallet_accounts (
        account_id TEXT PRIMARY KEY, slot TEXT NOT NULL UNIQUE CHECK(slot IN ('mainnet','devnet')),
        public_key TEXT NOT NULL UNIQUE, network TEXT NOT NULL, legacy_wallet_identity TEXT NOT NULL UNIQUE,
        keychain_domain TEXT NOT NULL CHECK(keychain_domain='user-default-search-list'), keychain_service TEXT NOT NULL,
        keychain_account TEXT NOT NULL, access_backend TEXT NOT NULL CHECK(access_backend='legacy-security'),
        origin TEXT NOT NULL CHECK(origin='legacy'), backup_state TEXT NOT NULL CHECK(backup_state='legacy_unverified'), created_at INTEGER NOT NULL);
        CREATE TRIGGER wallet_accounts_identity_immutable BEFORE UPDATE ON wallet_accounts
          BEGIN SELECT RAISE(ABORT,'wallet account identity is immutable'); END;
        CREATE TRIGGER wallet_accounts_identity_preserved BEFORE DELETE ON wallet_accounts
          BEGIN SELECT RAISE(ABORT,'wallet account identity is immutable'); END;`);
      db.prepare('INSERT INTO ledger_schema_migrations VALUES (?,?)').run('017_wallet_account_identity', now());
    });
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(slot: WalletSlot): WalletAccount | undefined {
    const selected = SlotSchema.parse(slot);
    const row = this.db.prepare('SELECT * FROM wallet_accounts WHERE slot=?').get(selected);
    if (!row) return undefined;
    const identity = slotIdentity(selected);
    if (row.network !== identity.network || row.legacy_wallet_identity !== identity.walletIdentity
      || row.keychain_domain !== 'user-default-search-list' || row.keychain_service !== identity.item.service
      || row.keychain_account !== identity.item.account || row.access_backend !== 'legacy-security'
      || row.origin !== 'legacy' || row.backup_state !== 'legacy_unverified') throw new Error('WALLET_IDENTITY_CONFLICT');
    return Object.freeze({ accountId: z.uuid().parse(row.account_id), slot: selected, publicKey: PublicKeySchema.parse(row.public_key),
      network: identity.network, legacyWalletIdentity: identity.walletIdentity, origin: 'legacy', backupState: 'legacy_unverified',
      createdAt: z.number().int().nonnegative().parse(row.created_at), credentialRef: Object.freeze({ domain: 'user-default-search-list',
        service: identity.item.service, account: identity.item.account, accessBackend: 'legacy-security' }) });
  }

  private purchaseRows(slot: WalletSlot) {
    return this.db.prepare(`SELECT p.approval_id FROM purchases p JOIN monetary_scopes m ON m.id=p.monetary_scope_id
      WHERE m.wallet_identity=?`).all(slotIdentity(slot).walletIdentity);
  }

  private hasFinancialHistory(slot: WalletSlot) {
    const walletIdentity = slotIdentity(slot).walletIdentity;
    if (this.purchaseRows(slot).length) return true;
    // A default empty scope/clock or NULL + paused controls can be initialized
    // without ever having a wallet. Only non-default financial facts block fresh setup.
    if (this.db.prepare(`SELECT 1 FROM monetary_controls c JOIN monetary_scopes m ON m.id=c.scope_id
      WHERE m.wallet_identity=? AND (c.daily_limit IS NOT NULL OR (m.environment='live_mainnet' AND c.paused<>1)) LIMIT 1`).get(walletIdentity)) return true;
    const grants = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spend_grants'").get();
    return Boolean(grants && this.db.prepare(`SELECT 1 FROM spend_grants g JOIN monetary_scopes m ON m.id=g.monetary_scope_id
      WHERE m.wallet_identity=? LIMIT 1`).get(walletIdentity));
  }

  private assertPinned(slot: WalletSlot, publicKey: string, assertion?: string) {
    try {
      PublicKeySchema.parse(publicKey);
      if (assertion !== undefined && PublicKeySchema.parse(assertion) !== publicKey) throw new Error();
      const pin = this.get(slot);
      if (pin && pin.publicKey !== publicKey) throw new Error();
      const opposite = this.get(slot === 'mainnet' ? 'devnet' : 'mainnet');
      if (opposite?.publicKey === publicKey) throw new Error();
      for (const row of this.purchaseRows(slot)) {
        const payer = this.historicalPayer(String(row.approval_id));
        if (payer !== undefined && PublicKeySchema.parse(payer) !== publicKey) throw new Error();
      }
    } catch { throw new Error('WALLET_IDENTITY_CONFLICT'); }
  }

  private adopt(slot: WalletSlot, publicKey: string, assertion?: string) {
    this.assertPinned(slot, publicKey, assertion);
    if (this.get(slot)) return;
    const identity = slotIdentity(slot);
    this.db.prepare(`INSERT INTO wallet_accounts VALUES (?,?,?,?,?,'user-default-search-list',?,?,'legacy-security','legacy','legacy_unverified',?)`)
      .run(randomUUID(), slot, publicKey, identity.network, identity.walletIdentity, identity.item.service, identity.item.account, this.now());
  }

  /** Call after a trusted read-only loader derives the actual signer address. */
  assertIdentity(slot: WalletSlot, publicKey: string, assertion?: string): void {
    this.atomic(() => this.adopt(SlotSchema.parse(slot), publicKey, assertion));
  }

  observe(inventory: readonly WalletInventoryEntry[], options: WalletObservationOptions = {}): WalletAccountObservation[] {
    return this.atomic(() => {
      const slots = inventory.map(entry => SlotSchema.parse(entry.id));
      if (new Set(slots).size !== slots.length) throw new Error('WALLET_INVENTORY_INVALID');
      const observations = inventory.map((entry, index): WalletAccountObservation => {
        const slot = slots[index]; const pin = this.get(slot);
        const assertion = slot === 'mainnet' ? options.mainnetAssertion : undefined;
        let provisioningState: WalletProvisioningState;
        if (entry.status === 'unavailable') provisioningState = entry.failure === 'corrupt' ? 'corrupt' : 'access_denied_or_locked';
        else if (entry.status === 'missing') provisioningState = pin || assertion !== undefined || this.hasFinancialHistory(slot) ? 'restore_required' : 'absent_fresh';
        else {
          try {
            if (!entry.address) throw new Error();
            this.assertPinned(slot, entry.address, assertion);
            const opposite = inventory.find(other => other.id === (slot === 'mainnet' ? 'devnet' : 'mainnet'));
            if (opposite?.status === 'available' && entry.address === opposite.address) throw new Error();
            provisioningState = slot === 'mainnet' && (!opposite || opposite.status === 'unavailable') ? 'isolation_unverified' : 'existing';
          } catch { provisioningState = 'identity_conflict'; }
        }
        const blocked = provisioningState === 'identity_conflict' || provisioningState === 'isolation_unverified';
        return { ...entry, ...(blocked ? { status: 'unavailable' as const, address: null } : {}),
          provisioningState, ...(pin ? { accountId: pin.accountId } : {}) };
      });
      for (let index = 0; index < observations.length; index++) {
        const entry = observations[index];
        if (entry.provisioningState !== 'existing' || !entry.address) continue;
        this.adopt(slots[index], entry.address, slots[index] === 'mainnet' ? options.mainnetAssertion : undefined);
        entry.accountId = this.get(slots[index])!.accountId;
      }
      return observations;
    });
  }
}
