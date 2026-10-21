import { randomBytes } from 'node:crypto';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { createAppWalletKeychain, readAppWalletKeychain, createMainnetWalletKeychain, readMainnetWalletKeychain, WalletKeychainError } from '../payment/keychain';
import { resolvePaymentEnvironment, validatePaymentEnvironment, type PaymentEnvironment } from '../payment/payment-environment';

export type WalletSecretStore = { read(): Promise<string | undefined>; create(secret: string): Promise<void> };
export const macOSWalletSecretStore: WalletSecretStore = { read: readAppWalletKeychain, create: createAppWalletKeychain };
export type ProductWalletStores = Readonly<{ test: WalletSecretStore; mainnet: WalletSecretStore }>;
const macOSWalletStores: ProductWalletStores = {
  test: macOSWalletSecretStore,
  mainnet: { read: readMainnetWalletKeychain, create: createMainnetWalletKeychain },
};

export async function readExistingProductWallets(
  stores: Readonly<{ test: Pick<WalletSecretStore, 'read'>; mainnet: Pick<WalletSecretStore, 'read'> }> = macOSWalletStores,
) {
  const identities = [
    { id: 'mainnet', label: 'Mainnet', store: stores.mainnet },
    { id: 'devnet', label: 'Devnet · Test', store: stores.test },
  ];
  return Promise.all(identities.map(async ({ id, label, store }) => {
    let secret: string | undefined;
    try { secret = await store.read(); }
    catch (error) {
      const failure = error instanceof Error && 'code' in error && error.code === 'WALLET_KEYCHAIN_CORRUPT'
        ? 'corrupt' as const : 'access_denied_or_locked' as const;
      return { id, label, address: null, status: 'unavailable' as const, failure };
    }
    if (secret === undefined) return { id, label, address: null, status: 'missing' as const };
    try { return { id, label, address: (await signerFromSecret(secret)).address, status: 'available' as const }; }
    catch { return { id, label, address: null, status: 'unavailable' as const, failure: 'corrupt' as const }; }
  }));
}

async function signerFromSecret(secret: string) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(secret));
    if (bytes.length !== 64) throw new Error();
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    throw new Error('The Yosh Keychain wallet is invalid; it was not replaced');
  } finally {
    bytes?.fill(0);
  }
}

async function initializeStoredWallet(store: WalletSecretStore) {
  const saved = await store.read();
  if (saved) return { address: (await signerFromSecret(saved)).address, reused: true };

  const seed = new Uint8Array(randomBytes(32));
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
    const secretBytes = new Uint8Array([...seed, ...publicBytes]);
    try {
      const encoded = getBase58Decoder().decode(secretBytes);
      try { await store.create(encoded); }
      catch {
        // Another instance may have won the fixed-item create race. Reuse only a
        // signer that can actually be read back; never silently substitute one.
        const raced = await store.read();
        if (!raced) throw new WalletKeychainError('WALLET_KEYCHAIN_UNAVAILABLE');
        return { address: (await signerFromSecret(raced)).address, reused: true };
      }
      const verified = await store.read();
      if (!verified) throw new WalletKeychainError('WALLET_KEYCHAIN_UNAVAILABLE');
      const storedSigner = await signerFromSecret(verified);
      if (storedSigner.address !== signer.address) throw new Error('The saved Yosh wallet does not match the generated signer');
      return { address: signer.address, reused: false };
    } finally { secretBytes.fill(0); }
  } finally { seed.fill(0); }
}

async function loadStoredSigner(expectedAddress: string | undefined, store: WalletSecretStore) {
  const secret = await store.read();
  if (!secret) throw new Error('The Yosh wallet is unavailable in Keychain');
  const signer = await signerFromSecret(secret);
  if (expectedAddress !== undefined && signer.address !== expectedAddress) throw new Error('The Yosh signer does not match the configured wallet');
  return signer;
}

export function assertTestWalletEnvironment() {
  if (resolvePaymentEnvironment(process.env, 'live_devnet').mode === 'live_mainnet') {
    throw new Error('MAINNET_WALLET_ISOLATION: explicit environment wallet required');
  }
}

/** Compatibility entry points remain test-only, even after an ambient environment switch. */
export async function initializeProductWallet(store: WalletSecretStore = macOSWalletSecretStore) {
  assertTestWalletEnvironment();
  return initializeStoredWallet(store);
}
export async function loadProductWalletSigner(expectedAddress: string, store: WalletSecretStore = macOSWalletSecretStore) {
  assertTestWalletEnvironment();
  return loadStoredSigner(expectedAddress, store);
}

async function testWalletAddress(stores: ProductWalletStores) {
  // A denied read is not absence: isolation cannot be proved in that case.
  const secret = await stores.test.read();
  return secret ? (await signerFromSecret(secret)).address : undefined;
}
function assertDistinctWallet(actualAddress: string, testAddress: string | undefined) {
  if (actualAddress === testAddress) throw new Error('MAINNET_WALLET_ISOLATION: test wallet identity is forbidden');
}

/** Explicit backend provisioning only; App startup never creates a Mainnet wallet. */
export async function initializeEnvironmentWallet(environment: PaymentEnvironment, stores: ProductWalletStores = macOSWalletStores) {
  const selected = validatePaymentEnvironment(environment);
  if (selected.mode !== 'live_mainnet') return initializeStoredWallet(stores.test);
  if (stores.test === stores.mainnet) throw new Error('MAINNET_WALLET_ISOLATION: separate Keychain stores required');
  const testAddress = await testWalletAddress(stores);
  const saved = await stores.mainnet.read();
  if (saved) {
    const actualAddress = (await signerFromSecret(saved)).address;
    assertDistinctWallet(actualAddress, testAddress);
    return { address: actualAddress, reused: true };
  }
  const wallet = await initializeStoredWallet(stores.mainnet);
  assertDistinctWallet(wallet.address, testAddress);
  return wallet;
}

/** Loading never creates/replaces a missing item and proves the configured public identity. */
export async function loadEnvironmentWalletSigner(expectedAddress: string | undefined, environment: PaymentEnvironment,
  stores: ProductWalletStores = macOSWalletStores) {
  const selected = validatePaymentEnvironment(environment);
  if (selected.mode !== 'live_mainnet') {
    if (!expectedAddress) throw new Error('Test wallet identity required');
    return loadStoredSigner(expectedAddress, stores.test);
  }
  if (stores.test === stores.mainnet) throw new Error('MAINNET_WALLET_ISOLATION: separate Keychain stores required');
  const testAddress = await testWalletAddress(stores);
  if (expectedAddress !== undefined) assertDistinctWallet(expectedAddress, testAddress);
  const signer = await loadStoredSigner(expectedAddress, stores.mainnet);
  assertDistinctWallet(signer.address, testAddress);
  return signer;
}
