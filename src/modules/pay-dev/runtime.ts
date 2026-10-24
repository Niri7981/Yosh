import { PAY_DEVELOPMENT_PROFILE } from './profile';
import { serveDevelopmentRuntime } from './management-server';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { z } from 'zod';
import { AppRuntime } from '../app/app-runtime';
import { createPayAuthorityAdapter } from '../payment/pay-authority-adapter';
import { createIsolatedPayExecution } from '../payment/isolated-pay-execution';
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, loadPaymentConfig } from '../payment/payment-config';
import { startOfflineServices } from './offline-services';
import { isPayDevelopmentDirectory } from './isolation';
import { paidResource } from '../resources/paid-resources';
const RPC_IDENTITY = 'https://rpc.yosh-pay-dev.invalid';
const FACILITATOR_IDENTITY = 'https://facilitator.yosh-pay-dev.invalid';
function privateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('PAY_DEVELOPMENT_PRIVATE_FILE_REQUIRED');
}

/** Real product AppRuntime and its existing management routes. Only the
 * merchant/chain and isolated offline signer are development facilities. */
export async function startPayDevelopmentBackend(options: { directory: string; runtimeDirectory: string; port?: number;
  merchantPort?: number; rpcPort?: number }) {
  if (process.env.YOSH_PAY_DEV !== '1') throw new Error('PAY_DEVELOPMENT_ONLY');
  const directory = resolve(options.directory);
  if (directory !== options.directory || basename(directory) !== PAY_DEVELOPMENT_PROFILE.directoryName) throw new Error('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  const port = options.port ?? PAY_DEVELOPMENT_PROFILE.backendPort;
  const origin = `http://127.0.0.1:${port}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid?.()
    || (directoryStat.mode & 0o777) !== 0o700) throw new Error('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  if (existsSync(join(directory, 'app-ledger.sqlite')) && !existsSync(join(directory, 'pay-development.json')))
    throw new Error('PAY_DEVELOPMENT_EXISTING_LEDGER_REJECTED');
  for (const file of ['app-ledger.sqlite', 'backend-owner.sqlite', 'app-ledger.sqlite.writer-lock']) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const info = lstatSync(join(directory, file + suffix));
        if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.()) throw new Error('PAY_DEVELOPMENT_STORAGE_REJECTED');
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  const secretPath = join(directory, 'offline-buyer.json');
  let seed: Uint8Array;
  if (existsSync(secretPath)) {
    privateFile(secretPath);
    seed = new Uint8Array(z.array(z.number().int().min(0).max(255)).length(32).parse(JSON.parse(readFileSync(secretPath, 'utf8'))));
  } else {
    seed = randomBytes(32);
    writeFileSync(secretPath, JSON.stringify([...seed]), { mode: 0o600, flag: 'wx', flush: true });
  }
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed); seed.fill(0);
  const markerPath = join(directory, 'pay-development.json');
  const marker = { version: 1, kind: 'yosh-pay-offline-development', buyer: signer.address, network: DEVNET_NETWORK };
  if (!existsSync(markerPath)) writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx', flush: true });
  else {
    privateFile(markerPath);
    if (JSON.stringify(JSON.parse(readFileSync(markerPath, 'utf8'))) !== JSON.stringify(marker)) throw new Error('PAY_DEVELOPMENT_IDENTITY_CHANGED');
  }
  Object.assign(process.env, { YOSH_DATA_DIR: directory, YOSH_PORT: String(port),
    YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_DEVNET_PURCHASES: '1', YOSH_ENABLE_MAINNET_EXECUTION: '0',
    YOSH_USE_PRODUCT_WALLET: '0', YOSH_ENABLE_LEGACY_DEMO_TASKS: '0', SOLANA_CLUSTER: 'devnet',
    SOLANA_RPC_URL: RPC_IDENTITY, SOLANA_GENESIS_HASH: DEVNET_GENESIS, SOLANA_NETWORK: DEVNET_NETWORK,
    USDC_MINT: DEVNET_USDC_MINT, DEMO_BUYER_PUBLIC_KEY: signer.address, X402_FACILITATOR_URL: FACILITATOR_IDENTITY });
  // The native dev launcher does not inherit product configuration. Reject
  // ambiguous aliases instead of silently admitting a different runtime.
  isPayDevelopmentDirectory(directory);
  mkdirSync(join(directory, 'simulator'), { mode: 0o700, recursive: true });
  const simulator = await startOfflineServices({ directory: join(directory, 'simulator'), buyer: signer.address,
    publicOrigin: origin, merchantPort: options.merchantPort ?? PAY_DEVELOPMENT_PROFILE.merchantPort, rpcPort: options.rpcPort ?? PAY_DEVELOPMENT_PROFILE.rpcPort });
  process.env.DEMO_MERCHANT_PUBLIC_KEY = simulator.merchant;
  const nativeFetch = globalThis.fetch;
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === RPC_IDENTITY) return nativeFetch(simulator.rpcUrl, init);
    if (url.origin === FACILITATOR_IDENTITY) return nativeFetch(`${simulator.merchantOrigin}${url.pathname}`, init);
    if (![origin, simulator.merchantOrigin, simulator.rpcUrl].includes(url.origin))
      throw new Error('PAY_DEVELOPMENT_EXTERNAL_NETWORK_REJECTED');
    return nativeFetch(input, init);
  };
  globalThis.fetch = localFetch;
  const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  const previousRuntime = globals.__yosh;
  let failedRuntime: AppRuntime | undefined;
  let failedExecutor: ReturnType<typeof createIsolatedPayExecution> | undefined;
  try {
  const executor = createIsolatedPayExecution({ directory, enginePath: join(options.runtimeDirectory, 'pay-protocol-engine'),
    merchantOrigin: origin, rpcUrl: simulator.rpcUrl, signer,
    unsignedPreparation: context => {
      if (!authority) throw new Error('PAY_AUTHORITY_NOT_READY');
      return authority.takeUnsigned(context);
    } });
  failedExecutor = executor;
  const app = new AppRuntime(directory, { paymentExecutor: executor.executor, fetcher: localFetch,
    initializeWallet: async () => ({ address: signer.address, reused: true }),
    readWallets: async () => [{ id: 'devnet', label: 'Offline · No real funds', address: signer.address, status: 'available' },
      { id: 'mainnet', label: 'Mainnet disabled', address: null, status: 'missing' }] });
  failedRuntime = app;
  globals.__yosh = { runtime: app };
  const authority: ReturnType<typeof createPayAuthorityAdapter> = createPayAuthorityAdapter({ directory, runtime: () => app,
    config: () => loadPaymentConfig(process.env, 'live_devnet', signer.address), executor: executor.executor, origin, rpcUrl: simulator.rpcUrl });
  await app.initializeWallet();
  const descriptor = { version: 1, profile: 'isolated-pay-dev', origin,
    memberId: app.ledger.defaultCardMember().id, merchantUrl: new URL(paidResource('market-snapshot').path, origin).href };
  writeFileSync(join(directory, 'pay-dev-runtime.json'), JSON.stringify(descriptor), { mode: 0o600, flush: true });
  chmodSync(join(directory, 'pay-dev-runtime.json'), 0o600);
  return await serveDevelopmentRuntime({ app, origin, port, descriptor, authority, simulator, async cleanup() {
    executor.close(); globalThis.fetch = nativeFetch; globals.__yosh = previousRuntime;
    await simulator.close();
  } });
  } catch (error) {
    if (failedRuntime) { await failedRuntime.prepareQuit(); failedRuntime.close(); }
    failedExecutor?.close(); globalThis.fetch = nativeFetch; globals.__yosh = previousRuntime;
    await simulator.close(); throw error;
  }
}
