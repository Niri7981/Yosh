import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { address } from '@solana/kit';
import { z } from 'zod';
import { readProductConfiguration } from '../app/product-configuration';
import { readExecutionSelection } from '../app/execution-selection';
import { ConnectionSchema } from '../mcp/connection';
import { resolvePaymentEnvironment } from '../payment/payment-environment';
import { assertDevelopmentDirectory, assertDevelopmentStorage, readDevelopmentEnvironment } from './environment';
import { LEGACY_PAY_DEV_MAINNET } from './mainnet-signer-selection';
import { IS_CODEX_PLUGIN_DEVELOPMENT, PAY_DEVELOPMENT_PROFILE } from './profile';

const directoryName = 'Yosh Pay Dev v0.1.1-rc.5';
const port = 13449;
const origin = 'http://127.0.0.1:13449';
const Proxy = z.object({ host: z.string().regex(/^[a-zA-Z0-9.-]+$/), port: z.number().int().min(1).max(65535) }).strict();
type HttpsProxy = z.infer<typeof Proxy>;
export type MainnetStandaloneConfiguration = Readonly<{
  root: string; directory: string; origin: typeof origin; port: typeof port; memberId: string;
  /** Backend-only credentials. Never serialize this object into status or logs. */
  environment: Readonly<Record<string, string>>;
}>;

function assertProfile() {
  if (IS_CODEX_PLUGIN_DEVELOPMENT || PAY_DEVELOPMENT_PROFILE.bundleIdentifier !== 'com.yosh.pay-development.v011rc5'
    || PAY_DEVELOPMENT_PROFILE.directoryName !== directoryName || PAY_DEVELOPMENT_PROFILE.backendPort !== port
    || PAY_DEVELOPMENT_PROFILE.keychainNamespace !== 'com.yosh.pay-development.v011rc5')
    throw new Error('MAINNET_STANDALONE_PROFILE_REQUIRED');
}

function privateFile(path: string, maximum: number, optional = false): string | undefined {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('MAINNET_STANDALONE_STORAGE_REJECTED');
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum
      || realpathSync(path) !== path) throw new Error('MAINNET_STANDALONE_STORAGE_REJECTED');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

function existingLedger(directory: string) {
  // Only metadata is read here. The exclusive backend owner opens the original
  // Ledger and validates its persisted wallet binding through AppRuntime.
  const file = join(directory, 'app-ledger.sqlite'), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || stat.size === 0 || realpathSync(file) !== file) throw new Error('MAINNET_STANDALONE_STORAGE_REJECTED');
  assertDevelopmentStorage(directory);
}

function proxyEnvironment(value?: HttpsProxy): Record<string, string> {
  if (value === undefined) return {};
  const parsed = Proxy.safeParse(value);
  if (!parsed.success) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  const url = `http://${parsed.data.host}:${parsed.data.port}`;
  return { HTTPS_PROXY: url, HTTP_PROXY: url };
}

/** Deterministic read boundary for temporary fixtures. Production calls only
 * loadMainnetStandaloneConfiguration, which supplies the OS account's home.
 * No directory, marker, wallet, Ledger or connection is created here. */
export function readMainnetStandaloneConfiguration(options: {
  home: string; runtimeDirectory: string; httpsProxy?: HttpsProxy;
}): MainnetStandaloneConfiguration {
  assertProfile();
  try {
    if (!isAbsolute(options.home) || !isAbsolute(options.runtimeDirectory)) throw new Error();
    const root = join(realpathSync(options.home), 'Library/Application Support', directoryName);
    const directory = join(root, 'Mainnet'), home = join(directory, 'home');
    try {
      assertDevelopmentDirectory(root, directoryName); assertDevelopmentDirectory(directory, 'Mainnet');
      assertDevelopmentDirectory(home, 'home'); existingLedger(directory);
    } catch { throw new Error('MAINNET_STANDALONE_STORAGE_REJECTED'); }
    // The existing reader's absent-file Offline default must not bootstrap this host.
    privateFile(join(root, 'development-environment.json'), 4096);
    const selection = readDevelopmentEnvironment(root);
    if (selection.environment !== 'mainnet' || !selection.mainnetRiskAccepted)
      throw new Error('MAINNET_STANDALONE_ENVIRONMENT_REQUIRED');
    const marker = z.object({ version: z.literal(1), kind: z.literal('yosh-pay-mainnet-development'), directory: z.literal(directory) }).strict();
    marker.parse(JSON.parse(privateFile(join(directory, 'pay-development-mainnet.json'), 4096)!));
    const descriptor = z.object({ version: z.literal(1), profile: z.literal('pay-mcp-mainnet'),
      origin: z.literal(origin), memberId: z.uuid() }).strict()
      .parse(JSON.parse(privateFile(join(directory, 'pay-mainnet-runtime.json'), 4096)!));
    const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(privateFile(join(directory, 'management-token'), 128));
    const connection = privateFile(join(directory, 'mcp-connection.json'), 16384, true);
    if (connection !== undefined) {
      const saved = ConnectionSchema.parse(JSON.parse(connection));
      if (saved.cardMemberId !== descriptor.memberId || saved.origin !== origin)
        throw new Error('MAINNET_STANDALONE_IDENTITY_MISMATCH');
    }
    if (privateFile(join(directory, 'execution-selection.json'), 4096, true) !== undefined
      && readExecutionSelection(directory) !== 'live_mainnet') throw new Error('MAINNET_STANDALONE_ENVIRONMENT_REQUIRED');
    const product = privateFile(join(directory, 'product-configuration.json'), 1_048_576, true) === undefined
      ? {} : readProductConfiguration(directory);
    // Match the original RC5 native launcher's allowlist, not the broader
    // production installation file. Selection remains the sole RPC source.
    const allowed = ['YOSH_ENABLE_MAINNET_EXECUTION', 'YOSH_MAINNET_RESOURCES', 'YOSH_MAINNET_WALLET_PUBLIC_KEY'];
    if (Object.keys(product).some(key => !allowed.includes(key))) throw new Error('MAINNET_STANDALONE_CONFIGURATION_INVALID');
    if (product.YOSH_MAINNET_WALLET_PUBLIC_KEY !== undefined) address(product.YOSH_MAINNET_WALLET_PUBLIC_KEY);
    const acceptance = privateFile(join(root, 'mainnet-signer-acceptance.json'), 1024, true);
    if (acceptance !== undefined) {
      z.object({ version: z.literal(1), identity: z.literal('legacy-pay-dev-mainnet') }).strict().parse(JSON.parse(acceptance));
      if (product.YOSH_MAINNET_WALLET_PUBLIC_KEY !== undefined && product.YOSH_MAINNET_WALLET_PUBLIC_KEY !== LEGACY_PAY_DEV_MAINNET.publicAddress)
        throw new Error('MAINNET_STANDALONE_IDENTITY_MISMATCH');
    }
    const environment: Record<string, string> = {
      HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), YOSH_PORT: String(port),
      YOSH_MANAGEMENT_TOKEN: token, APP2049_MANAGEMENT_TOKEN: token, YOSH_DATA_DIR: directory, APP2049_DATA_DIR: directory,
      YOSH_PACKAGED_RUNTIME_DIR: options.runtimeDirectory, YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'mainnet',
      YOSH_PAY_MCP_MAINNET: '1', YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_MAINNET_RPC_URL: selection.rpcUrl,
      YOSH_ENABLE_MAINNET_EXECUTION: product.YOSH_ENABLE_MAINNET_EXECUTION ?? '0',
      APP2049_ENABLE_MAINNET_EXECUTION: product.YOSH_ENABLE_MAINNET_EXECUTION ?? '0',
      NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1', ...product, ...proxyEnvironment(options.httpsProxy),
    };
    resolvePaymentEnvironment(environment);
    return Object.freeze({ root, directory, origin, port, memberId: descriptor.memberId, environment: Object.freeze(environment) });
  } catch (error) {
    if (error instanceof Error && /^MAINNET_STANDALONE_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('MAINNET_STANDALONE_CONFIGURATION_INVALID');
  }
}

/** Node initializes its global proxy agents before the backend imports finish.
 * Reloaded settings must match the launch environment; mutating env now cannot
 * repair a late or changed proxy configuration. Never expose values on failure. */
export function assertMainnetProxyStartupEnvironment(
  expected: Readonly<Record<string, string | undefined>>,
  actual: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (expected[key] !== actual[key]) throw new Error('MAINNET_STANDALONE_PROXY_STARTUP_MISMATCH');
  }
}

/** scutil exposes the same top-level HTTPS proxy selected by the native host.
 * Scoped dictionaries cannot replace it; credentials and arbitrary URLs fail closed. */
export function parseMainnetStandaloneSystemProxy(output: string): HttpsProxy | undefined {
  if (Buffer.byteLength(output) > 16384 || !/^\s*<dictionary>\s*\{/.test(output)) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  const values = new Map<string, string>(); let depth = 0;
  for (const line of output.split(/\r?\n/)) {
    if (depth === 1) {
      const match = /^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort)\s*:\s*(.*?)\s*$/.exec(line);
      if (match) {
        if (values.has(match[1])) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
        values.set(match[1], match[2]);
      }
    }
    if (/\{\s*$/.test(line)) depth++;
    if (/^\s*\}\s*$/.test(line)) depth--;
    if (depth < 0) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  }
  if (depth !== 0) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  const enabled = values.get('HTTPSEnable');
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1' || !/^\d{1,5}$/.test(values.get('HTTPSPort') ?? '')) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  const result = Proxy.safeParse({ host: values.get('HTTPSProxy'), port: Number(values.get('HTTPSPort')) });
  if (!result.success) throw new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE');
  return result.data;
}

/** Original OS account location only: ambient HOME, data-dir, signer and proxy
 * variables never select another wallet or inject inherited credentials. */
export async function loadMainnetStandaloneConfiguration(runtimeDirectory: string): Promise<MainnetStandaloneConfiguration> {
  const configuration = readMainnetStandaloneConfiguration({ home: userInfo().homedir, runtimeDirectory });
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 16384, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_ENV: 'production' } }, (error, stdout) => {
      if (error) reject(new Error('MAINNET_STANDALONE_PROXY_UNAVAILABLE')); else resolve(stdout);
    });
  });
  const proxy = parseMainnetStandaloneSystemProxy(output);
  return Object.freeze({ ...configuration, environment: Object.freeze({ ...configuration.environment, ...proxyEnvironment(proxy) }) });
}
