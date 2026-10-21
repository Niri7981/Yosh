import { PassThrough } from 'node:stream';
import { ChildProcess, spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { APP_WALLET_KEYCHAIN, MAINNET_WALLET_KEYCHAIN, readAppWalletKeychain,
  readMainnetWalletKeychain, createMainnetWalletKeychain } from '../../src/modules/payment/keychain';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function securityResult(code: number, output = '') {
  const stdin = new PassThrough();
  vi.spyOn(stdin, 'end');
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin,
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => { child.stdout.emit('data', output); child.emit('close', code); });
    return child;
  });
  return child;
}

it('reads distinct fixed Keychain items without changing the existing test identity', async () => {
  securityResult(44);
  expect(await readAppWalletKeychain()).toBeUndefined();
  expect(spawn).toHaveBeenLastCalledWith('/usr/bin/security', ['find-generic-password', '-s', APP_WALLET_KEYCHAIN.service,
    '-a', APP_WALLET_KEYCHAIN.account, '-w'], { stdio: ['pipe', 'pipe', 'pipe'] });
  expect(await readMainnetWalletKeychain()).toBeUndefined();
  expect(spawn).toHaveBeenLastCalledWith('/usr/bin/security', ['find-generic-password', '-s', MAINNET_WALLET_KEYCHAIN.service,
    '-a', MAINNET_WALLET_KEYCHAIN.account, '-w'], { stdio: ['pipe', 'pipe', 'pipe'] });
});

it.each([36, 128, 1])('treats Keychain failure %i as inaccessible, never as item absence', async code => {
  securityResult(code, 'sensitive-diagnostic');
  await expect(readMainnetWalletKeychain()).rejects.toThrow('Keychain item could not be accessed');
});

it('fails closed when Keychain is unavailable on this platform', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  await expect(readMainnetWalletKeychain()).rejects.toThrow('requires macOS Keychain');
});

it('writes Mainnet only through stdin without replacement or broad access flags', async () => {
  const child = securityResult(0);
  // Encoding fixture only, deliberately not a usable cryptographic keypair.
  const fixture = '1'.repeat(88);
  await createMainnetWalletKeychain(fixture);
  expect(spawn).toHaveBeenLastCalledWith('/usr/bin/security', ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
  expect(child.stdin.end).toHaveBeenCalledWith(`add-generic-password -s ${MAINNET_WALLET_KEYCHAIN.service} -a ${MAINNET_WALLET_KEYCHAIN.account} -w ${fixture}\n`);
});

it('distinguishes corrupt item encoding from denied access without returning the item contents', async () => {
  const secret = 'invalid-sensitive-fixture';
  securityResult(0, secret);
  const error: unknown = await readMainnetWalletKeychain().catch(value => value);
  expect(error).toMatchObject({ code: 'WALLET_KEYCHAIN_CORRUPT' });
  expect(String(error)).not.toContain(secret);
});
