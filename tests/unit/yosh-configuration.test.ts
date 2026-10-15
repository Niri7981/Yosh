import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { resolveYoshConfiguration } from '../../src/modules/app/yosh-configuration';
import { managementRoute, requireManagementRequest } from '../../src/modules/app/management-auth';
import { legacyDemoTasksAllowed } from '../../src/modules/app/product-mode';
import { initializeProductWallet, type WalletSecretStore } from '../../src/modules/app-wallet/product-wallet';
import { APP_WALLET_KEYCHAIN } from '../../src/modules/payment/keychain';
import { hash } from '../../src/modules/purchases/spending-policy';
import { signedManagementRequest } from '../helpers/management-request';

const directories: string[] = [];
const settingNames = ['PORT', 'REPOSITORY_ROOT', 'NODE_PATH', 'DATA_DIR', 'MANAGEMENT_TOKEN', 'CODEX_PATH',
  'CARD_MEMBER_ID', 'MCP_PROVIDER', 'ENABLE_DEVNET_PURCHASES', 'USE_PRODUCT_WALLET', 'ENABLE_LEGACY_DEMO_TASKS'];
beforeEach(() => {
  for (const name of settingNames) {
    vi.stubEnv(`YOSH_${name}`, undefined);
    vi.stubEnv(`APP2049_${name}`, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  const globals = globalThis as typeof globalThis & { __yoshManagementNonces?: Map<string, number> };
  globals.__yoshManagementNonces?.clear();
});

describe('Yosh configuration compatibility', () => {
  it('reads new names and legacy launch records without changing their identities', () => {
    const values = { PORT: '3049', REPOSITORY_ROOT: '/fixture/root', NODE_PATH: '/fixture/node', DATA_DIR: '/fixture/data',
      MANAGEMENT_TOKEN: 'test-installation-token'.repeat(2), CODEX_PATH: '/fixture/codex', CARD_MEMBER_ID: '00000000-0000-4000-8000-000000000001',
      MCP_PROVIDER: 'codex', ENABLE_DEVNET_PURCHASES: '1', USE_PRODUCT_WALLET: '1', ENABLE_LEGACY_DEMO_TASKS: '0' };
    const current = Object.fromEntries(Object.entries(values).map(([key, value]) => [`YOSH_${key}`, value]));
    const legacy = Object.fromEntries(Object.entries(values).map(([key, value]) => [`APP2049_${key}`, value]));
    expect(resolveYoshConfiguration(current)).toEqual(resolveYoshConfiguration(legacy));
    expect(resolveYoshConfiguration({ ...legacy, ...current })).toEqual(resolveYoshConfiguration(current));
    expect(resolveYoshConfiguration(current)).toMatchObject({ enableDevnetPurchases: true, useProductWallet: true, enableLegacyDemoTasks: false });
  });

  it.each(settingNames)('rejects conflicting %s settings before opening a data store', setting => {
    const boolean = setting.includes('ENABLE_') || setting === 'USE_PRODUCT_WALLET';
    const current = boolean ? '1' : setting === 'PORT' ? '3049' : 'current-private-value';
    const legacy = boolean ? '0' : setting === 'PORT' ? '3050' : 'legacy-private-value';
    vi.stubEnv(`YOSH_${setting}`, current);
    vi.stubEnv(`APP2049_${setting}`, legacy);
    const directory = join(tmpdir(), `yosh-conflict-${setting}-${process.pid}`);
    expect(() => new AppRuntime(directory)).toThrow('Conflicting Yosh configuration');
    expect(existsSync(directory)).toBe(false);
    try { resolveYoshConfiguration(); } catch (error) {
      expect(String(error)).not.toContain('current-private-value');
      expect(String(error)).not.toContain('legacy-private-value');
    }
  });

  it('does not let an empty new value override a populated legacy value', () => {
    expect(() => resolveYoshConfiguration({ YOSH_DATA_DIR: '', APP2049_DATA_DIR: '/existing' })).toThrow('Conflicting Yosh configuration');
  });

  it('rejects relative or empty storage overrides instead of selecting a fresh default store', () => {
    for (const value of ['', 'relative/data', '/invalid\0path']) {
      expect(() => resolveYoshConfiguration({ YOSH_DATA_DIR: value })).toThrow('Invalid Yosh configuration');
    }
    expect(() => resolveYoshConfiguration({ YOSH_PORT: '03049' })).toThrow('Invalid Yosh configuration');
  });

  it('rejects malformed switches and keeps legacy demo execution opt-in outside production', () => {
    expect(() => resolveYoshConfiguration({ YOSH_ENABLE_DEVNET_PURCHASES: 'true' })).toThrow('Invalid Yosh configuration');
    expect(() => resolveYoshConfiguration({ APP2049_USE_PRODUCT_WALLET: 'yes' })).toThrow('Invalid Yosh configuration');
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'development', YOSH_ENABLE_LEGACY_DEMO_TASKS: '1' })).toBe(true);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'production', YOSH_ENABLE_LEGACY_DEMO_TASKS: '1' })).toBe(false);
    expect(legacyDemoTasksAllowed({ NODE_ENV: 'test' })).toBe(false);
  });

  it('rejects a configuration conflict before an authenticated handler or startup runs', async () => {
    const token = 'original-installation-secret'.repeat(2);
    vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
    vi.stubEnv('APP2049_MANAGEMENT_TOKEN', 'different-installation-secret'.repeat(2));
    const handler = vi.fn(async () => Response.json({ ready: true }));
    const request = signedManagementRequest('http://127.0.0.1:3049/api/app/health', token);
    const response = await managementRoute(request, false, handler);
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ code: 'CONFIGURATION_CONFLICT', error: 'Conflicting Yosh configuration for YOSH_MANAGEMENT_TOKEN.' });
  });

  it('accepts the existing v1 HMAC proof using the new management-token name', () => {
    const token = 'unchanged-management-secret'.repeat(2);
    vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
    const request = signedManagementRequest('http://127.0.0.1:3049/api/app/health', token);
    expect(request.headers.has('x-2049-proof')).toBe(true);
    expect(() => requireManagementRequest(request)).not.toThrow();
  });
});

it('reuses the member, grant, ledger, purchase replay and wallet when only config names change', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-config-reuse-'));
  directories.push(directory);
  let secret: string | undefined;
  let creates = 0;
  const store: WalletSecretStore = {
    read: async () => secret,
    create: async value => { creates += 1; secret = value; },
  };
  const initializeWallet = () => initializeProductWallet(store);
  const origin = 'http://127.0.0.1:3049';
  vi.stubEnv('APP2049_DATA_DIR', directory);
  const first = new AppRuntime(undefined, { initializeWallet });
  const member = first.ledger.defaultCardMember();
  let grant: Awaited<ReturnType<AppRuntime['createSpendGrant']>>;
  let purchase: Awaited<ReturnType<AppRuntime['createTestPurchase']>>;
  let wallet: Awaited<ReturnType<AppRuntime['initializeWallet']>>;
  try {
    first.setDailyLimit('1000000');
    first.setAgentConnection(true, origin);
    grant = await first.createSpendGrant({ totalLimit: '1000000', singleLimit: '1000000', expiresAt: Date.now() + 60 * 60 * 1000 });
    wallet = await first.initializeWallet();
    purchase = await first.createTestPurchase('pre-rename-purchase', origin);
    expect(purchase).toMatchObject({ status: 'PAID', simulated: true });
    first.setPaused(true);
  } finally { first.close(); }

  vi.stubEnv('APP2049_DATA_DIR', undefined);
  vi.stubEnv('YOSH_DATA_DIR', directory);
  const second = new AppRuntime(undefined, { initializeWallet });
  try {
    expect(second.directory).toBe(directory);
    expect(second.ledger.defaultCardMember()).toEqual(member);
    expect((await second.overview()).budget).toMatchObject({ dailyLimit: '1000000', paused: true });
    expect(second.ledger.spendGrantSummary()).toMatchObject({ id: grant.id, version: grant.version, status: 'ACTIVE', totalLimit: '1000000' });
    const restored = second.ledger.getForAdministration('pre-rename-purchase');
    expect(restored?.intent.authority?.grantId).toBe(grant.id);
    expect(restored?.ownerCardMemberId).toBe(member.id);
    expect(restored?.intent.requestHash).toBe(hash('2049 App test purchase'));
    expect(await second.createTestPurchase('pre-rename-purchase', origin)).toEqual(purchase);
    expect(await second.initializeWallet()).toEqual({ address: wallet.address, reused: true });
    expect(second.ledger.listForAdministration()).toHaveLength(1);
    expect(creates).toBe(1);
    expect(APP_WALLET_KEYCHAIN).toEqual({ service: 'com.2049.wallet.v1', account: 'consumer-wallet-v1' });
  } finally { second.close(); }
});
