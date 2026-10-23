import { PAY_DEVELOPMENT_PROFILE } from '../../src/modules/pay-dev/profile';
import { z } from 'zod';
import * as resourceFetch from '../../src/modules/resources/safe-resource-fetch';
import agent402Quote from '../fixtures/agent402-crypto-price-v2.json';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { startMainnetDevelopmentBackend } from '../../src/modules/pay-dev/mainnet-runtime';
import { readDevelopmentEnvironment, DEFAULT_DEV_RPC, isMainnetDevelopment } from '../../src/modules/pay-dev/environment';
import { readMainnetWalletKeychain, MAINNET_WALLET_KEYCHAIN, DEV_MAINNET_WALLET_KEYCHAIN } from '../../src/modules/payment/keychain';
import { signedManagementRequest } from '../helpers/management-request';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readConnection } from '../../src/modules/mcp/connection';
import { MAINNET_NETWORK, MAINNET_USDC_MINT, resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { hash } from '../../src/modules/purchases/spending-policy';
import type { X402Resource } from '../../src/modules/resources/http-resource';
import type { PaymentRequirements } from '@x402/core/types';

const childRuntime = vi.hoisted(() => ({ spawn: undefined as typeof spawn | undefined }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>(); childRuntime.spawn = actual.spawn;
  return { ...actual, spawn: vi.fn() };
});
const secrets = new Map<string, string>();
const writes: string[] = [];
const directories: string[] = [];
let backend: Awaited<ReturnType<typeof startMainnetDevelopmentBackend>> | undefined;
afterEach(async () => {
  await backend?.close(); backend = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); secrets.clear(); writes.length = 0;
});

function fixture(behavior: { writeDenied?: boolean } = {}) {
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|DEMO_|SOLANA_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-dev-environments-'))); directories.push(parent);
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, 'Mainnet'); mkdirSync(directory, { mode: 0o700 });
  const privateHome = join(directory, 'home'); mkdirSync(privateHome, { mode: 0o700 });
  vi.stubEnv('HOME', privateHome);
  writeFileSync(join(root, 'offline-buyer.json'), 'offline-sentinel', { mode: 0o600 });
  writeFileSync(join(root, 'app-ledger.sqlite'), 'offline-history-sentinel', { mode: 0o600 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'mainnet', mainnetRiskAccepted: true, rpcUrl: DEFAULT_DEV_RPC }), { mode: 0o600 });
  const token = 'isolated-mainnet-dev-management-token-'.repeat(2);
  const env = { YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'mainnet', YOSH_PAY_MCP_MAINNET: '1', YOSH_DATA_DIR: directory,
    YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_MAINNET_RPC_URL: DEFAULT_DEV_RPC, YOSH_ENABLE_MAINNET_EXECUTION: '0', YOSH_MANAGEMENT_TOKEN: token };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  secrets.set(MAINNET_WALLET_KEYCHAIN.service, 'formal-untouched-sentinel');
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    if (command !== '/usr/bin/security' || !Array.isArray(args)) {
      if (!childRuntime.spawn) throw new Error('TEST_CHILD_REQUIRED');
      return childRuntime.spawn(command, args, options);
    }
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    const optionsForSecurity = options?.env;
    let input = '';
    child.stdin.on('data', chunk => { input += String(chunk); });
    queueMicrotask(() => {
      let code = 0;
      const keychainAvailable = (optionsForSecurity?.HOME ?? process.env.HOME) === userInfo().homedir;
      if (args[0] === 'find-generic-password') {
        const service = args[args.indexOf('-s') + 1];
        if (!service.startsWith('com.yosh.pay-development.')) throw new Error('FORMAL_KEYCHAIN_ACCESS_FORBIDDEN');
        const value = keychainAvailable ? secrets.get(service) : undefined;
        if (value) child.stdout.emit('data', value); else code = 44;
      } else {
        const match = /^add-generic-password -s (\S+) -a \S+ -w ([1-9A-HJ-NP-Za-km-z]+)\n$/.exec(input);
        if (!match || !match[1].startsWith('com.yosh.pay-development.')) throw new Error('FORMAL_KEYCHAIN_WRITE_FORBIDDEN');
        if (!keychainAvailable || behavior.writeDenied) code = 36;
        else if (secrets.has(match[1])) code = 45;
        else { secrets.set(match[1], match[2]); writes.push(match[1]); }
      }
      child.emit('close', code);
    });
    return child;
  });
  return { parent, root, directory, token };
}
async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
async function control(token: string, path: string, body?: unknown, method = 'POST') {
  const url = `${backend!.origin}${path}`;
  // Match the native management client's per-request session rather than reusing
  // an undici keepalive socket from a process deliberately stopped below.
  return fetch(signedManagementRequest(url, token, body === undefined ? { headers: { connection: 'close' } } : { method,
    headers: { origin: backend!.origin, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) }));
}

it('one Dev backend starts with no wallet or payment permission; authenticated Create Wallet uses only Dev Keychain and survives restart', async () => {
  const { root, directory, token } = fixture(); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  backend = await startMainnetDevelopmentBackend({ directory, port });
  expect(writes).toEqual([]);
  expect(backend.app.execution()).toMatchObject({ mode: 'live_mainnet', productionExecutionEnabled: false, spendingAuthorized: false });
  const first = await control(token, '/api/app/wallets'); expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ wallets: expect.arrayContaining([expect.objectContaining({ id: 'mainnet', status: 'missing' })]) });
  expect(writes).toEqual([]);
  expect((await fetch(`${backend.origin}/api/app/wallets`, { method: 'POST', headers: { 'content-type': 'application/json', origin: backend.origin }, body: JSON.stringify({ action: 'create_payment_wallet' }) })).status).toBe(401);
  const responses = await Promise.all([control(token, '/api/app/wallets', { action: 'create_payment_wallet' }), control(token, '/api/app/wallets', { action: 'create_payment_wallet' })]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  const wallet: unknown = await responses[0].json(); expect(await responses[1].json()).toEqual(wallet);
  expect(writes).toEqual([DEV_MAINNET_WALLET_KEYCHAIN.service]);
  expect(secrets.get(MAINNET_WALLET_KEYCHAIN.service)).toBe('formal-untouched-sentinel');
  expect(backend.app.ledger.controls('live_mainnet')).toMatchObject({ paused: true, dailyBudget: null });
  expect(backend.app.spendGrantSummary()).toBeNull();
  expect(backend.app.ledger.listForAdministration()).toEqual([]);
  expect(backend.app.execution().productionExecutionEnabled).toBe(false);
  expect(readFileSync(join(root, 'offline-buyer.json'), 'utf8')).toBe('offline-sentinel');
  expect(readFileSync(join(root, 'app-ledger.sqlite'), 'utf8')).toBe('offline-history-sentinel');
  await expect(backend.app.createTestPurchase('forbidden-js-path', backend.origin)).rejects.toMatchObject({ code: 'PAY_MCP_REQUIRED' });
  await backend.close(); backend = undefined;
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const replay = await control(token, '/api/app/wallets', { action: 'create_payment_wallet' });
  expect(replay.status).toBe(201); expect(await replay.json()).toMatchObject({ reused: true });
  expect(writes).toHaveLength(1);
  expect(backend.app.execution().productionExecutionEnabled).toBe(false);
  const account = backend.app.ledger.walletAccounts.get('mainnet');
  expect(account?.credentialRef.service).toBe(DEV_MAINNET_WALLET_KEYCHAIN.service);
});

it('Create Wallet reaches the OS account Keychain while every other Dev dependency retains its private HOME', async () => {
  const { directory, token } = fixture(); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  const privateHome = process.env.HOME;
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const response = await control(token, '/api/app/wallets', { action: 'create_payment_wallet' });
  expect(response.status).toBe(201);
  expect(writes).toEqual([DEV_MAINNET_WALLET_KEYCHAIN.service]);
  const commands = vi.mocked(spawn).mock.calls.filter(([command]) => command === '/usr/bin/security');
  expect(commands.length).toBeGreaterThan(0);
  for (const [, , options] of commands) expect(options?.env).toEqual({ HOME: userInfo().homedir, PATH: '/usr/bin:/bin', NODE_ENV: process.env.NODE_ENV });
  expect(process.env.HOME).toBe(privateHome);
  expect(secrets.get(MAINNET_WALLET_KEYCHAIN.service)).toBe('formal-untouched-sentinel');
  expect(backend.app.execution().productionExecutionEnabled).toBe(false);
});

it('a denied Dev Keychain write returns an actionable error without creating a replacement or changing spending authority', async () => {
  const { directory, token } = fixture({ writeDenied: true }); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const response = await control(token, '/api/app/wallets', { action: 'create_payment_wallet' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'WALLET_KEYCHAIN_UNAVAILABLE' });
  expect(writes).toEqual([]);
  expect(backend.app.ledger.walletAccounts.get('mainnet')).toBeUndefined();
  expect(backend.app.execution().productionExecutionEnabled).toBe(false);
  expect(secrets.get(MAINNET_WALLET_KEYCHAIN.service)).toBe('formal-untouched-sentinel');
});

it('the existing root MCP entry selects Mainnet and discovers the real Pay curl tool without a second host configuration', async () => {
  const { parent, root, directory } = fixture(); const port = PAY_DEVELOPMENT_PROFILE.backendPort; vi.stubEnv('YOSH_PORT', undefined);
  backend = await startMainnetDevelopmentBackend({ directory, port });
  await backend.app.setMemberConnection(true, backend.origin, backend.descriptor.memberId);
  const wrapper = join(parent, 'mcp.cjs');
  execFileSync(resolve('node_modules/.bin/esbuild'), ['scripts/pay-dev-mcp.ts', '--bundle', '--platform=node', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', `--outfile=${wrapper}`], { stdio: 'pipe' });
  copyFileSync(resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'), join(parent, 'pay-mcp')); chmodSync(join(parent, 'pay-mcp'), 0o755);
  const client = new Client({ name: 'mainnet-profile-discovery', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [wrapper, '--data-dir', root],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: parent, NODE_ENV: 'test' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === 'curl')).toBe(true);
    expect(tools.tools.find(tool => tool.name === 'get_spending_status')?.description).toContain('Mainnet');
    expect(tools.tools.find(tool => tool.name === 'recover_payment')).toMatchObject({ annotations: { readOnlyHint: false } });
    expect((await client.callTool({ name: 'recover_payment', arguments: { operationId: 'not-a-purchase', amount: '1' } })).isError).toBe(true);
    expect(backend.app.ledger.listForAdministration()).toEqual([]); expect(writes).toEqual([]);
  } finally { await client.close(); }
});

it('an original Unknown and its reservation block switching before and after restart', async () => {
  const { directory, token } = fixture(); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const created: { address: string } = await (await control(token, '/api/app/wallets', { action: 'create_payment_wallet' })).json();
  const app = backend.app, ledger = app.ledger, memberId = backend.descriptor.memberId, now = Date.now();
  await app.setMemberConnection(true, backend.origin, memberId);
  const connection = readConnection(directory);
  const principal = { cardMemberId: memberId, connectionId: connection.connectionId, connectionGeneration: connection.generation };
  const recipient = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
  const resource: X402Resource = { resourceId: 'unknown-switch', displayName: 'Unknown switch fixture', providerId: 'test.invalid',
    request: { method: 'GET', url: 'https://test.invalid/data', access: 'https', headers: {} },
    network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT, recipientSource: 'live_challenge', decimals: 6, maximumAmount: '1000' };
  ledger.resources.add(resource); ledger.setDailyLimit('5000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
  ledger.createSpendGrant({ totalLimit: '5000', singleLimit: '1000', expiresAt: now + 600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: resource.network, assetId: resource.mint, assetDecimals: 6, payTo: recipient, paymentScheme: 'exact' }, now, 'live_mainnet');
  const quote: PaymentRequirements = { scheme: 'exact', network: resource.network, asset: resource.mint, payTo: recipient, amount: '1000', maxTimeoutSeconds: 300,
    extra: { feePayer: recipient } };
  const intent = createX402SpendIntent({ idempotencyKey: 'original-unknown', resource, challenge: { x402Version: 2, resource: { url: resource.request.url }, accepts: [quote] },
    environment: resolvePaymentEnvironment(), buyer: created.address, authority: ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet'), now });
  const reserved = ledger.reserve(intent, quote, now, 'live_mainnet', memberId, undefined,
    { callerId: memberId, operationId: 'original-unknown', attemptId: randomUUID(), requestHash: hash({ method: 'GET', url: resource.request.url, headers: [], body: null }), quoteHash: hash(quote), factsHash: hash('original') });
  expect(reserved.status).toBe('APPROVED');
  const permit = ledger.executionSafety.permit(ledger.getOwned('original-unknown', memberId)!);
  ledger.claim(reserved.approvalId, now, undefined, 'live_mainnet', permit); ledger.unknown(reserved.approvalId);
  const blocked = await control(token, '/api/app/lifecycle', { action: 'prepareEnvironmentSwitch' });
  expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ code: 'EXECUTION_BUSY' });
  expect(ledger.managedSummary(now, 'live_mainnet').reserved).toBe('1000');
  await backend.close(); backend = undefined;
  backend = await startMainnetDevelopmentBackend({ directory, port });
  expect(backend.app.ledger.getOwned('original-unknown', memberId)?.status).toBe('PAYMENT_UNKNOWN');
  expect((await control(token, '/api/app/lifecycle', { action: 'prepareEnvironmentSwitch' })).status).toBe(409);
  expect(backend.app.ledger.managedSummary(now, 'live_mainnet').reserved).toBe('1000');
  expect(writes).toHaveLength(1);
});

it('missing original pinned key is restore-required and Create Wallet cannot replace it', async () => {
  const { directory, token } = fixture(); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  backend = await startMainnetDevelopmentBackend({ directory, port });
  expect((await control(token, '/api/app/wallets', { action: 'create_payment_wallet' })).status).toBe(201);
  await backend.close(); backend = undefined;
  secrets.delete(DEV_MAINNET_WALLET_KEYCHAIN.service);
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const response = await control(token, '/api/app/wallets', { action: 'create_payment_wallet' });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'WALLET_RESTORE_REQUIRED' });
  expect(writes).toHaveLength(1);
});

it('Mainnet cannot adopt an unmarked existing Ledger or a symlinked writer file', async () => {
  const { directory } = fixture();
  writeFileSync(join(directory, 'app-ledger.sqlite'), 'existing-evidence', { mode: 0o600 });
  await expect(startMainnetDevelopmentBackend({ directory })).rejects.toThrow('PAY_DEVELOPMENT_EXISTING_LEDGER_REJECTED');
  expect(readFileSync(join(directory, 'app-ledger.sqlite'), 'utf8')).toBe('existing-evidence');
  expect(existsSync(join(directory, 'pay-development-mainnet.json'))).toBe(false);
  rmSync(join(directory, 'app-ledger.sqlite'));
  symlinkSync(join(directory, 'missing'), join(directory, 'app-ledger.sqlite'));
  await expect(startMainnetDevelopmentBackend({ directory })).rejects.toThrow('PAY_DEVELOPMENT_STORAGE_REJECTED');
});

it('Offline, missing risk confirmation, or profile tampering fails before any Keychain access', async () => {
  const { root, directory } = fixture();
  vi.stubEnv('YOSH_PAY_DEV_ENV', 'offline');
  await expect(readMainnetWalletKeychain()).rejects.toThrow('PAY_DEVELOPMENT_KEYCHAIN_FORBIDDEN');
  expect(spawn).not.toHaveBeenCalled();
  vi.stubEnv('YOSH_PAY_DEV_ENV', 'mainnet');
  const path = join(root, 'development-environment.json');
  writeFileSync(path, JSON.stringify({ version: 1, environment: 'mainnet', mainnetRiskAccepted: false, rpcUrl: DEFAULT_DEV_RPC }));
  expect(() => isMainnetDevelopment(directory)).toThrow();
  await expect(readMainnetWalletKeychain()).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
  chmodSync(path, 0o644); expect(() => readDevelopmentEnvironment(root)).toThrow('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
});

const discoveryInput = { url: 'https://agent402.tools/api/crypto-price', method: 'GET',
  requestInputs: { query: { coins: { type: 'string', required: true }, currency: { type: 'string', required: false } } },
  sample: { query: { coins: 'BTC,ETH,SOL', currency: 'usd' } },
  deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 262144 } };
function publicQuote() {
  return vi.spyOn(resourceFetch, 'safeResourceFetch').mockImplementation(async () => new Response(null,
    { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(agent402Quote)).toString('base64') } }));
}
function toolJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('TEST_TOOL_TEXT_REQUIRED');
  return JSON.parse(String(result.content[0].text)) as unknown;
}
it('Dev exposes the original authenticated Add API discovery, preview, registration and inspection routes', async () => {
  const { directory, token } = fixture(); const port = await freePort(); const outbound = publicQuote();
  backend = await startMainnetDevelopmentBackend({ directory, port });
  for (const path of ['/api/app/resources', '/api/app/resources/discover', '/api/app/resources/prepare']) {
    expect((await fetch(backend.origin + path, { method: 'POST', headers: { origin: backend.origin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  }
  expect(outbound).not.toHaveBeenCalled();
  const preview = await control(token, '/api/app/resources/prepare', { kind: 'discovery', discovery: discoveryInput });
  expect(preview.status).toBe(200); expect(outbound).not.toHaveBeenCalled();
  const response = await control(token, '/api/app/resources/discover', discoveryInput);
  expect(response.status).toBe(200);
  const discovery = z.object({ proposal: z.record(z.string(), z.unknown()), paymentSent: z.literal(false) }).parse(await response.json());
  const resourceId = 'dev-ui-agent402';
  const added = await control(token, '/api/app/resources', { ...discovery.proposal, resourceId, providerId: 'agent402.tools', displayName: 'Agent402 UI' });
  expect(added.status).toBe(201);
  expect((await control(token, '/api/app/resources/' + resourceId)).status).toBe(200);
  expect(backend.app.registeredResources().some(resource => resource.resourceId === resourceId)).toBe(true);
  expect((await control(token, '/api/app/resources/' + resourceId, { state: 'DISABLED' }, 'PUT')).status).toBe(200);
  expect(backend.app.registeredResources().some(resource => resource.resourceId === resourceId)).toBe(false);
  expect(backend.app.spendGrantSummary()).toBeNull(); expect(backend.app.ledger.listForAdministration()).toEqual([]); expect(writes).toEqual([]);
});
it('same real Pay stdio host discovers and registers into Dev Grant choices without exposing another purchase or management tool', async () => {
  const { parent, root, directory, token } = fixture(); const port = PAY_DEVELOPMENT_PROFILE.backendPort; const outbound = publicQuote();
  backend = await startMainnetDevelopmentBackend({ directory, port });
  await backend.app.setMemberConnection(true, backend.origin, backend.descriptor.memberId);
  const wrapper = join(parent, 'mcp.cjs');
  execFileSync(resolve('node_modules/.bin/esbuild'), ['scripts/pay-dev-mcp.ts', '--bundle', '--platform=node', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', `--outfile=${wrapper}`], { stdio: 'pipe' });
  copyFileSync(resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'), join(parent, 'pay-mcp')); chmodSync(join(parent, 'pay-mcp'), 0o755);
  const client = new Client({ name: 'resource-lifecycle-host', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [wrapper, '--data-dir', root],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: parent, NODE_ENV: 'test' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['curl', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource']));
    expect(names).not.toEqual(expect.arrayContaining(['request_purchase'])); expect(names).not.toContain('create_spend_grant');
    const discovered = await client.callTool({ name: 'discover_x402_resource', arguments: discoveryInput });
    expect(discovered.isError).not.toBe(true);
    const { discoveryId } = z.object({ discoveryId: z.uuid() }).parse(toolJson(discovered));
    const args = { discoveryId, resourceId: 'dev-agent402', providerId: 'agent402.tools', displayName: 'Agent402' };
    expect((await client.callTool({ name: 'register_x402_resource', arguments: { ...args, approved: true } })).isError).toBe(true);
    const responses = await Promise.all([client.callTool({ name: 'register_x402_resource', arguments: args }), client.callTool({ name: 'register_x402_resource', arguments: args })]);
    for (const result of responses) { expect(result.isError).not.toBe(true); expect(toolJson(result)).toMatchObject({ registrationStatus: 'REGISTERED', spendingAuthorityCreated: false }); }
    const registered = z.object({ resources: z.array(z.object({ resourceId: z.string(), source: z.string() })) }).parse(await (await control(token, '/api/app/resources')).json());
    expect(registered.resources.filter(r => r.resourceId === args.resourceId)).toEqual([{ resourceId: args.resourceId, source: 'agent' }]);
    expect(backend.app.registeredResources().find(r => r.resourceId === args.resourceId)).toMatchObject({ source: 'agent', submission: { sample: discoveryInput.sample } });
    const quoted = await client.callTool({ name: 'quote_x402_resource', arguments: { resourceId: args.resourceId, sample: discoveryInput.sample } });
    expect(quoted.isError).not.toBe(true); expect(toolJson(quoted)).toMatchObject({ paymentSent: false, amount: '1000' });
    expect(backend.app.spendGrantSummary()).toBeNull(); expect(backend.app.ledger.listForAdministration()).toEqual([]); expect(writes).toEqual([]);
    await backend.app.setMemberConnection(false, backend.origin, backend.descriptor.memberId);
    const count = outbound.mock.calls.length;
    expect((await client.callTool({ name: 'discover_x402_resource', arguments: discoveryInput })).isError).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(count);
  } finally { await client.close(); }
});
it('Dev resource routes preserve discovery ownership and do not grant Agent access to management or the legacy purchase executor', async () => {
  const { directory } = fixture(); const port = await freePort(); const outbound = publicQuote();
  backend = await startMainnetDevelopmentBackend({ directory, port });
  const app = backend.app;
  await app.setMemberConnection(true, backend.origin, backend.descriptor.memberId);
  const first = readConnection(directory, backend.descriptor.memberId);
  const other = app.createCardMember('Other fixture Agent');
  await app.setMemberConnection(true, backend.origin, other.member.id);
  const second = readConnection(directory, other.member.id);
  const post = (path: string, token: string, input: unknown) => fetch(backend!.origin + path, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(path.startsWith('/api/app/') ? { origin: backend!.origin } : {}) }, body: JSON.stringify(input) });
  expect((await post('/api/agent/discovery', 'untrusted', discoveryInput)).status).toBe(401);
  expect(outbound).not.toHaveBeenCalled();
  const discoveryResponse = await post('/api/agent/discovery', first.token, discoveryInput);
  expect(discoveryResponse.status).toBe(200);
  const discovered = z.object({ discoveryId: z.uuid() }).parse(await discoveryResponse.json());
  const registration = { ...discovered, resourceId: 'owned-agent402', providerId: 'agent402.tools', displayName: 'Owned resource' };
  const denied = await post('/api/agent/resources', second.token, registration);
  expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ code: 'RESOURCE_DISCOVERY_NOT_FOUND' });
  expect((await post('/api/app/resources', first.token, registration)).status).toBe(401);
  expect((await post('/api/agent/purchases', first.token, {})).status).toBe(404);
  expect((await post('/api/agent/resources', first.token, registration)).status).toBe(201);
  expect(app.spendGrantSummary()).toBeNull(); expect(app.ledger.listForAdministration()).toEqual([]); expect(writes).toEqual([]);
});

it('controlled HTTP uses its 128 KiB envelope cap and records strict schema rejection before execution', async () => {
  const { directory } = fixture(); const port = await freePort(); vi.stubEnv('YOSH_PORT', String(port));
  backend = await startMainnetDevelopmentBackend({ directory, port });
  await backend.app.setMemberConnection(true, backend.origin, backend.descriptor.memberId);
  const connection = readConnection(directory);
  const payloads = [
    { endpoint: 'execute', body: { facts: { operation_id: 'fixture-size-only', attempt_id: randomUUID(), payment_required: { description: 'x'.repeat(9000) } }, unexpected: 'SECRET' } },
    { endpoint: 'recover', body: { operationId: 'fixture-size-only', unexpected: 'SECRET' } },
  ];
  for (const { endpoint, body } of payloads) {
    const response = await fetch(`${backend.origin}/pay/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
  const log = readFileSync(join(directory, 'pay-controller-diagnostics.jsonl'), 'utf8');
  const entries = log.trim().split('\n').map(line => JSON.parse(line));
  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(entry).toMatchObject({ httpStatus: 400, backendCode: 'CONTROLLER_INPUT_INVALID', validationStage: 'http_input', issues: [{ path: [], code: 'unrecognized_keys' }] });
  expect(log).not.toContain('SECRET');
  expect(backend.app.ledger.listForOwner(backend.descriptor.memberId, 50)).toHaveLength(0);
});
