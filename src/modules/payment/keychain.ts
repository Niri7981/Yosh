import { spawn } from "node:child_process";
import { address } from "@solana/kit";
import { validatePaymentEnvironment, type PaymentEnvironment } from './payment-environment';
import { isMainnetDevelopment } from '../pay-dev/environment';
import { userInfo } from 'node:os';

class KeychainCommandError extends Error {
  constructor(readonly exitCode: number | null) { super('Keychain command failed'); }
}

export class WalletKeychainError extends Error {
  constructor(readonly code: 'WALLET_KEYCHAIN_UNAVAILABLE' | 'WALLET_KEYCHAIN_CORRUPT') {
    super(code === 'WALLET_KEYCHAIN_CORRUPT' ? 'The Yosh wallet Keychain item is invalid'
      : 'The Yosh wallet Keychain item could not be accessed');
  }
}

function validateItem(service: string, account: string) {
  if (!/^com\.2049\.day4\.[a-f0-9]{16}$/.test(service)) throw new Error("Invalid Demo keychain service");
  address(account);
  if (process.platform !== "darwin") throw new Error("Demo keychain signing requires macOS");
}

function security(args: string[], input?: string): Promise<string> {
  // Private HOME isolates Dev configuration, not macOS's per-user default
  // Keychain. Restore the OS account home only for this narrowly scoped tool;
  // fixed Dev service/account names still select the isolated credentials.
  const development = process.env.YOSH_PAY_DEV === '1';
  if (development && !isMainnetDevelopment()) throw new Error('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  const environment = development ? { HOME: userInfo().homedir, PATH: '/usr/bin:/bin', NODE_ENV: process.env.NODE_ENV ?? 'production' } : undefined;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"], ...(environment ? { env: environment } : {}) });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Demo keychain access timed out")); }, 30_000);
    child.stdout.on("data", chunk => { output += chunk; });
    // Never forward security's diagnostic streams: they can include command input.
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new KeychainCommandError(null)); });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new KeychainCommandError(code));
      else resolve(output.trim());
    });
    child.stdin.end(input);
  });
}

export const APP_WALLET_KEYCHAIN = Object.freeze({ service: 'com.2049.wallet.v1', account: 'consumer-wallet-v1' });
export const MAINNET_WALLET_KEYCHAIN = Object.freeze({ service: 'com.yosh.wallet.mainnet.v1', account: 'consumer-wallet-mainnet-v1' });
export const DEV_MAINNET_WALLET_KEYCHAIN = Object.freeze({ service: 'com.yosh.pay-development.wallet.mainnet.v1', account: 'consumer-wallet-mainnet-v1' });
const DEV_OFFLINE_WALLET_KEYCHAIN = Object.freeze({ service: 'com.yosh.pay-development.wallet.offline.v1', account: 'consumer-wallet-offline-v1' });

function scopedWalletItem(item: Readonly<{ service: string; account: string }>) {
  if (process.env.YOSH_PAY_DEV !== '1') return item;
  // Fail closed before any Keychain command; HOME does not isolate macOS Keychain.
  if (!isMainnetDevelopment()) throw new Error('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  if (item === MAINNET_WALLET_KEYCHAIN) return DEV_MAINNET_WALLET_KEYCHAIN;
  if (item === APP_WALLET_KEYCHAIN) return DEV_OFFLINE_WALLET_KEYCHAIN;
  if (item.service === 'com.yosh.wallet.library.v1') return { ...item, service: 'com.yosh.pay-development.wallet.library.v1' };
  throw new Error('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
}

/** Keep the installed test item intact. Environment selection never copies its key. */
export function productWalletKeychain(environment: PaymentEnvironment) {
  return scopedWalletItem(validatePaymentEnvironment(environment).mode === 'live_mainnet' ? MAINNET_WALLET_KEYCHAIN : APP_WALLET_KEYCHAIN);
}
export function productWalletSlotKeychain(slot: 'mainnet' | 'devnet') {
  return scopedWalletItem(slot === 'mainnet' ? MAINNET_WALLET_KEYCHAIN : APP_WALLET_KEYCHAIN);
}

/** The product wallet uses one fixed Keychain item so a crash cannot orphan a newly-created signer. */
async function readWalletKeychain(item: Readonly<{ service: string; account: string }>): Promise<string | undefined> {
  item = scopedWalletItem(item);
  if (process.platform !== 'darwin') throw new Error('The Yosh wallet requires macOS Keychain');
  try {
    const secret = await security(['find-generic-password', '-s', item.service, '-a', item.account, '-w']);
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(secret)) throw new WalletKeychainError('WALLET_KEYCHAIN_CORRUPT');
    return secret;
  } catch (error) {
    if (error instanceof KeychainCommandError && error.exitCode === 44) return undefined;
    if (error instanceof WalletKeychainError) throw error;
    throw new WalletKeychainError('WALLET_KEYCHAIN_UNAVAILABLE');
  }
}

async function createWalletKeychain(item: Readonly<{ service: string; account: string }>, secret: string): Promise<void> {
  item = scopedWalletItem(item);
  if (process.platform !== 'darwin') throw new Error('The Yosh wallet requires macOS Keychain');
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(secret)) throw new Error('Invalid Yosh wallet signer encoding');
  await security(['-i'], `add-generic-password -s ${item.service} -a ${item.account} -w ${secret}\n`);
}

export const readAppWalletKeychain = () => readWalletKeychain(APP_WALLET_KEYCHAIN);
export const createAppWalletKeychain = (secret: string) => createWalletKeychain(APP_WALLET_KEYCHAIN, secret);
export const readMainnetWalletKeychain = () => readWalletKeychain(MAINNET_WALLET_KEYCHAIN);
export const createMainnetWalletKeychain = (secret: string) => createWalletKeychain(MAINNET_WALLET_KEYCHAIN, secret);

export async function readDemoKeychain(service: string, account: string): Promise<string> {
  validateItem(service, account);
  const secret = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(secret)) throw new Error("Invalid Demo keychain signer");
  return secret;
}

export async function createDemoKeychain(service: string, account: string, secret: string): Promise<void> {
  validateItem(service, account);
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(secret)) throw new Error("Invalid Demo signer encoding");
  // Interactive stdin keeps secret bytes out of process argv and shell history.
  // No -A, ACL changes or -U: do not broaden access or replace an existing item.
  await security(["-i"], `add-generic-password -s ${service} -a ${account} -w ${secret}\n`);
  if (await readDemoKeychain(service, account) !== secret) throw new Error("Demo signer was not saved; configuration was not changed");
}

// Library credentials use separate create-only items; never overwrite either payment slot.
function libraryWalletItem(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid wallet ID');
  return { service: 'com.yosh.wallet.library.v1', account: id.toLowerCase() };
}
export const readLibraryWalletKeychain = (id: string) => readWalletKeychain(libraryWalletItem(id));
export const createLibraryWalletKeychain = (id: string, secret: string) => createWalletKeychain(libraryWalletItem(id), secret);
