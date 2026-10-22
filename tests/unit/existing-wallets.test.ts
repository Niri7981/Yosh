import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { readExistingProductWallets } from '../../src/modules/app-wallet/product-wallet';

async function fixture(value: number) {
  const seed = new Uint8Array(32).fill(value);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
  return { address: signer.address, secret: getBase58Decoder().decode(new Uint8Array([...seed, ...publicBytes])) };
}

describe('existing wallets read-only inventory', () => {
  it('preserves both legacy keypairs through repeated and concurrent reads without writes', async () => {
    const test = await fixture(11);
    const mainnet = await fixture(22);
    const stores = {
      test: { read: vi.fn(async () => test.secret), create: vi.fn() },
      mainnet: { read: vi.fn(async () => mainnet.secret), create: vi.fn() },
    };
    const expected = [
      { id: 'mainnet', label: 'Mainnet', address: mainnet.address, status: 'available' },
      { id: 'devnet', label: 'Devnet · Test', address: test.address, status: 'available' },
    ];
    expect(await readExistingProductWallets(stores)).toEqual(expected);
    expect(await Promise.all(Array.from({ length: 3 }, () => readExistingProductWallets(stores))))
      .toEqual([expected, expected, expected]);
    expect(await stores.test.read()).toBe(test.secret);
    expect(await stores.mainnet.read()).toBe(mainnet.secret);
    expect(stores.test.create).not.toHaveBeenCalled();
    expect(stores.mainnet.create).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(test.secret);
    expect(JSON.stringify(expected)).not.toContain(mainnet.secret);
  });

  it('keeps a fresh installation empty after repeated reads without creating keys', async () => {
    const store = { read: vi.fn(async () => undefined), create: vi.fn() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await readExistingProductWallets({ test: store, mainnet: store });
      expect(result.every(wallet => wallet.address === null && wallet.status === 'missing')).toBe(true);
    }
    expect(store.create).not.toHaveBeenCalled();
  });

  it('distinguishes denied access and invalid keys from absence, while retaining the other wallet', async () => {
    const test = await fixture(11);
    const testStore = { read: async () => test.secret };
    for (const [mainnet, failure] of [[{ read: async () => { throw new Error('private diagnostic'); } }, 'access_denied_or_locked'],
      [{ read: async () => 'invalid' }, 'corrupt']] as const) {
      expect(await readExistingProductWallets({ test: testStore, mainnet })).toEqual([
        { id: 'mainnet', label: 'Mainnet', address: null, status: 'unavailable', failure },
        { id: 'devnet', label: 'Devnet · Test', address: test.address, status: 'available' },
      ]);
    }
  });
});
