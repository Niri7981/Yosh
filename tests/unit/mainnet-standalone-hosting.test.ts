import { randomUUID } from 'node:crypto';
import type { ConfirmLocalGrant } from '../../src/modules/authority/native-grant-confirmation';
import type { ConfirmStatementPairing } from '../../src/modules/authority/local-statement-pairing';
import { handleRemoteReadMcp } from '../../src/modules/remote/mcp';
import type { ReadConsent } from '../../src/modules/remote/pairings';
import { handleAccountRead } from '../../src/modules/mcp/account-read-route';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { CodexIntegration } from '../../src/modules/mcp/codex-integration';
import { readConnection } from '../../src/modules/mcp/connection';
import { preparePayMainnetCutover } from '../../src/modules/payment/pay-mainnet-control';
import * as mppCharge from '../../src/modules/payment/mpp-resource-charge';
import { MppChargeQuoteSchema } from '../../src/modules/payment/mpp-contract';
import { MAINNET_GENESIS, TOKEN_PROGRAM, resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { preparePayUnsigned } from '../../src/modules/payment/pay-unsigned-preflight';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';

vi.mock('../../src/modules/payment/pay-unsigned-preflight', () => ({ preparePayUnsigned: vi.fn() }));
vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
const directories: string[] = [];
const runtimes = new Set<AppRuntime>();
afterEach(async () => {
  for (const app of runtimes) { await app.prepareQuit(); app.close(); }
  runtimes.clear();
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(confirmRemoteStatement?: (facts: ReadConsent) => Promise<boolean>) {
  for (const key of Object.keys(process.env)) {
    if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') vi.stubEnv(key, undefined);
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-hosting-')));
  directories.push(directory);
  const packaged = join(directory, 'packaged'); mkdirSync(packaged);
  writeFileSync(join(packaged, 'mcp.cjs'), 'fixture-only');
  const payMcpPath = join(packaged, 'pay-mcp'); writeFileSync(payMcpPath, 'fixture-only');
  const runtimeDigest = 'a'.repeat(64);
  vi.stubEnv('YOSH_EXECUTION_MODE', 'live_mainnet');
  vi.stubEnv('YOSH_ENABLE_MAINNET_EXECUTION', '1');
  vi.stubEnv('YOSH_PAY_MCP_MAINNET', '1');
  vi.stubEnv('YOSH_PACKAGED_RUNTIME_DIR', packaged);
  const environment = resolvePaymentEnvironment();
  const buyer = '11111111111111111111111111111111';
  const resource = {
    resourceId: 'hosting-fixture', providerId: 'fixture', network: environment.network,
    mint: environment.asset.mint, decimals: 6, recipient: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', amount: '1000',
    request: { url: 'https://merchant.hosting.invalid/data', method: 'GET', access: 'https', headers: {} },
  };
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const previous = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true, mode: 'live_mainnet' });
  const memberId = previous.defaultCardMember().id; previous.close();
  preparePayMainnetCutover(directory, [2_147_483_647]);
  const integration = new CodexIntegration(directory, memberId);
  const original = { name: integration.legacyServerName, enabled: true, transport: {
    type: 'stdio', command: process.execPath, args: ['--import', '/old-app/loader.mjs', '/old-app/mcp.ts'],
    env: { YOSH_DATA_DIR: directory, YOSH_CARD_MEMBER_ID: memberId, YOSH_MCP_PROVIDER: 'codex' },
  } };
  mkdirSync(join(directory, 'members', memberId), { recursive: true });
  writeFileSync(integration.recordPath, JSON.stringify({ provider: 'codex', memberId, config: original }));
  const configPath = join(directory, 'original-codex-config.json');
  const entries: unknown[] = [original];
  const persist = () => writeFileSync(configPath, JSON.stringify(entries)); persist();
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === 'list') return JSON.stringify(entries);
    if (args[1] === 'remove') entries.splice(0);
    else if (args[1] === 'add') {
      const separator = args.indexOf('--');
      entries.push({ name: args[2], enabled: true, transport: { type: 'stdio', command: args[separator + 1],
        args: args.slice(separator + 2), env: original.transport.env } });
    } else throw new Error('UNEXPECTED_FIXTURE_CODEX_COMMAND');
    persist(); return '';
  });
  const open = (standalone = true, binary = payMcpPath, confirmStatementPairing?: ConfirmStatementPairing, confirmPurchaseGrant?: ConfirmLocalGrant, fetcher?: typeof fetch, legacyMemberForRegistration?: (registration: string, label: string) => string | null) => {
    const app = new AppRuntime(directory, { codex: { run }, fetcher, initializeWallet: async () => ({ address: buyer, reused: true }),
      ...(standalone ? { hosting: { kind: 'mainnet-standalone' as const, payMcpPath: binary, runtimeDigest, purchaseResourceLookup: true, confirmRemoteStatement, confirmStatementPairing, confirmPurchaseGrant, legacyMemberForRegistration, mppProtocolEnginePath: join(packaged, 'mpp-protocol-engine') } } : {}) });
    runtimes.add(app); return app;
  };
  return { directory, memberId, payMcpPath, runtimeDigest, configPath, recordPath: integration.recordPath, run, open, buyer, resource };
}

it('standalone startup and repeated member connection preserve the original App MCP registration across restart', async () => {
  const f = fixture();
  const config = readFileSync(f.configPath), record = readFileSync(f.recordPath);
  let app = f.open();
  app.setAgentConnection(true, 'http://127.0.0.1:3049');
  const connection = readConnection(f.directory);
  await app.start('http://127.0.0.1:3049');
  await app.setMemberConnection(true, 'http://127.0.0.1:3049', f.memberId);
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  await app.start('http://127.0.0.1:3049');
  expect(readConnection(f.directory)).toEqual(connection);
  expect(readFileSync(f.configPath)).toEqual(config);
  expect(readFileSync(f.recordPath)).toEqual(record);
  expect(f.run).not.toHaveBeenCalled();
});

it('rejects a standalone hosting dependency outside its admitted Mainnet profile or with a noncanonical Pay path', () => {
  const f = fixture();
  for (const path of ['relative/pay-mcp', '/runtime/../pay-mcp', '/runtime/node']) {
    expect(() => f.open(true, path)).toThrow('MAINNET_STANDALONE_HOSTING_REJECTED');
  }
  vi.stubEnv('YOSH_PAY_MCP_MAINNET', undefined);
  expect(() => f.open()).toThrow('MAINNET_STANDALONE_HOSTING_REJECTED');
});

it('reports the standalone runtime contract and digest without leaking its Pay path; an ordinary App retains its health and migration behavior', async () => {
  const f = fixture();
  const hosted = f.open();
  expect(hosted.healthStatus()).toMatchObject({ hosting: { kind: 'mainnet-standalone', apiVersion: 1,
    dataContract: 'existing-mainnet-v1', runtimeDigest: f.runtimeDigest } });
  expect(JSON.stringify(hosted.healthStatus())).not.toContain(f.payMcpPath);
  await hosted.prepareQuit(); hosted.close(); runtimes.delete(hosted);
  const ordinary = f.open(false);
  expect(ordinary.healthStatus()).not.toHaveProperty('hosting');
  await ordinary.start('http://127.0.0.1:3049');
  expect(f.run.mock.calls.some(([args]) => args[1] === 'remove')).toBe(true);
  expect(f.run.mock.calls.some(([args]) => args[1] === 'add')).toBe(true);
});

it('prepayment recovery after standalone restart uses its packaged Pay binary and retains the original reservation on build failure', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    if (!['getGenesisHash', 'getLatestBlockhash'].includes(method)) throw new Error('UNEXPECTED_FIXTURE_RPC');
    return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'getGenesisHash' ? MAINNET_GENESIS
      : { value: { blockhash: f.buyer, lastValidBlockHeight: 5000 } } });
  }));
  let app = f.open(); app.setAgentConnection(true, origin);
  await app.initializeWallet();
  app.setDailyLimit('1000'); app.setPaused(false);
  const connection = readConnection(f.directory);
  const principal = () => app.authenticateAgent(new Request(origin + '/pay/authorize', {
    headers: { authorization: `Bearer ${connection.token}` },
  }), 'request_purchase');
  await app.createSpendGrant({ resourceId: f.resource.resourceId, totalLimit: '1000', singleLimit: '1000', expiresAt: Date.now() + 3600_000 });
  const quote = { scheme: 'exact', network: f.resource.network, asset: f.resource.mint, amount: '1000',
    payTo: f.resource.recipient, maxTimeoutSeconds: 300, extra: { feePayer: f.resource.recipient } };
  const facts = { caller_id: f.memberId, operation_id: 'standalone-original', attempt_id: crypto.randomUUID(), execution_network: 'mainnet',
    request: { method: 'GET', url: f.resource.request.url, headers: [['accept', 'application/json']], body: null },
    amount_atomic: quote.amount, asset: quote.asset, network: quote.network, recipient: quote.payTo, accepted: quote,
    payment_required: { x402Version: 2, resource: { url: f.resource.request.url }, accepts: [quote] } };
  const spend = Object.fromEntries(Object.entries(facts).filter(([key]) => key !== 'payment_required'));
  await app.payMcpOperation('authorize', spend, principal(), origin);
  await app.payMcpOperation('plan', { facts }, principal(), origin);
  const purchase = app.ledger.listForOwner(f.memberId)[0];
  const budget = app.ledger.managedSummary(Date.now(), 'live_mainnet');
  const grant = app.spendGrantSummary();
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  vi.mocked(preparePayUnsigned).mockResolvedValue({ ok: false, code: 'UNSIGNED_PREPARE_FAILED' });
  await expect(app.payMcpRecovery({ operationId: facts.operation_id }, principal(), origin)).rejects.toThrow();
  expect(preparePayUnsigned).toHaveBeenCalledWith(f.payMcpPath, expect.objectContaining({ payer: f.buyer }));
  expect(app.ledger.listForOwner(f.memberId)).toHaveLength(1);
  expect(app.ledger.listForOwner(f.memberId)[0]).toMatchObject({ purchaseId: purchase.purchaseId, status: 'APPROVED' });
  expect(app.ledger.managedSummary(Date.now(), 'live_mainnet')).toEqual(budget);
  expect(app.spendGrantSummary()).toEqual(grant);
  expect(readConnection(f.directory)).toEqual(connection);
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

it('pairs only after native confirmation, scopes the credential, and honors revocation across launches', async () => {
  const f = fixture();
  const origin = 'http://127.0.0.1:3049';
  const registration = { hostId: randomUUID(), label: 'Example host' };
  let allow: () => void = () => { throw new Error('Missing pending confirmation'); };
  const confirm = vi.fn(async () => new Promise<void>(resolve => { allow = resolve; }));
  let app = f.open(true, f.payMcpPath, confirm);
  const before = app.ledger.cardMembers();
  const first = app.pairStatementHost(registration, origin);
  const duplicate = app.pairStatementHost(registration, origin);
  expect(app.ledger.cardMembers()).toEqual(before);
  await expect(app.pairStatementHost({ ...registration, hostId: randomUUID() }, origin)).rejects.toThrow('LOCAL_CONFIRMATION_BUSY');
  allow();
  const paired = await first;
  expect(await duplicate).toEqual(paired);
  expect(confirm).toHaveBeenCalledTimes(1);
  const descriptor = readConnection(f.directory, paired.memberId);
  expect(descriptor.capabilities).toEqual(['read_statement']);
  expect(app.memberOverview(paired.memberId).grants).toHaveLength(0);
  const req = new Request(origin + '/api/agent/account/statement', { headers: { authorization: 'Bearer ' + descriptor.token } });
  expect(handleAccountRead(app, 'statement', req).status).toBe(200);
  expect(handleAccountRead(app, 'result', req).status).toBe(401);
  expect(() => app.authenticateAgent(req, 'request_purchase')).toThrow('AGENT_UNAUTHORIZED');
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open(true, f.payMcpPath, confirm);
  expect(await app.pairStatementHost(registration, origin)).toEqual(paired);
  await expect(app.pairStatementHost({ ...registration, label: 'Other' }, origin)).rejects.toThrow('LOCAL_STATEMENT_IDENTITY_MISMATCH');
  expect(handleAccountRead(app, 'statement', req).status).toBe(200);
  await app.setMemberConnection(false, origin, paired.memberId);
  await expect(app.pairStatementHost(registration, origin)).rejects.toThrow('LOCAL_STATEMENT_CONNECTION_REVOKED');
  expect(handleAccountRead(app, 'statement', req).status).toBe(401);
  expect(confirm).toHaveBeenCalledTimes(1);
  await app.setMemberConnection(true, origin, paired.memberId);
  expect(readConnection(f.directory, paired.memberId).capabilities).toEqual(['read_statement']);
});

it('makes no member on declined first use and does not link identities by a shared display label', async () => {
  const f = fixture();
  const confirm = vi.fn(async () => {}).mockRejectedValueOnce(new Error('LOCAL_CONFIRMATION_DECLINED'));
  const app = f.open(true, f.payMcpPath, confirm);
  const origin = 'http://127.0.0.1:3049', label = 'Same label';
  const a = { hostId: randomUUID(), label }, b = { hostId: randomUUID(), label };
  const initial = app.ledger.cardMembers();
  await expect(app.pairStatementHost(a, origin)).rejects.toThrow('LOCAL_CONFIRMATION_DECLINED');
  expect(app.ledger.cardMembers()).toEqual(initial);
  const first = await app.pairStatementHost(a, origin), second = await app.pairStatementHost(b, origin);
  expect(first.memberId).not.toBe(second.memberId);
  expect(app.ledger.cardMembers()).toHaveLength(initial.length + 2);
});

it('rolls back enrollment when persisting the read credential fails, allowing a clean retry', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  const confirm = vi.fn(async () => {});
  const app = f.open(true, f.payMcpPath, confirm);
  const before = app.ledger.cardMembers();
  const registration = { hostId: randomUUID(), label: 'Fixture client' };
  const members = join(f.directory, 'members');
  renameSync(members, members + '.saved');
  writeFileSync(members, 'fixture: unwriteable directory');
  await expect(app.pairStatementHost(registration, origin)).rejects.toThrow();
  expect(app.ledger.cardMembers()).toEqual(before);
  rmSync(members);
  renameSync(members + '.saved', members);
  const { memberId } = await app.pairStatementHost(registration, origin);
  expect(app.ledger.cardMember(memberId)?.label).toBe('Fixture client');
  expect(app.ledger.cardMembers()).toHaveLength(before.length + 1);
  expect(confirm).toHaveBeenCalledTimes(2);
});

it('cannot consume an approval after the originating host disconnects', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049', lifetime = new AbortController();
  let finish: () => void = () => { throw new Error('Missing confirmation'); };
  const app = f.open(true, f.payMcpPath, async (_, signal) => {
    expect(signal).toBe(lifetime.signal);
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const before = app.ledger.cardMembers();
  const input = { hostId: randomUUID(), label: 'Disconnected host' };
  const pairing = app.pairStatementHost(input, origin, lifetime.signal);
  lifetime.abort();
  finish();
  await expect(pairing).rejects.toThrow('LOCAL_STATEMENT_REQUEST_CANCELLED');
  expect(app.ledger.cardMembers()).toEqual(before);
});

it('binds one native purchase consent to its member, request and exact quote, independently of statement consent', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  const registration = {hostId: randomUUID(), label: 'Local CLI'};
  const input = {...registration, resourceId: f.resource.resourceId, reason: 'Retrieve the sample', requestId: 'sample-order'};
  const quote = {scheme: 'exact', amount: '1000', network: f.resource.network, asset: f.resource.mint,
    payTo: f.resource.recipient, maxTimeoutSeconds: 300, extra: {feePayer: f.resource.recipient}};
  const challenge = {x402Version: 2, resource: {url: f.resource.request.url}, accepts: [quote]};
  const merchant = vi.fn<typeof fetch>(async url => {
    expect(String(url)).toBe(f.resource.request.url);
    return new Response(null, {status: 402, headers: {'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64')}});
  });
  const confirm = vi.fn<ConfirmLocalGrant>(async () => {});
  const statement = vi.fn<ConfirmStatementPairing>(async () => {});
  let app = f.open(true, f.payMcpPath, statement, confirm, merchant, () => null);
  expect(() => app.boundHostPurchaseMember(registration)).toThrow('LOCAL_HOST_BINDING_MISMATCH');
  confirm.mockRejectedValueOnce(new Error('LOCAL_CONFIRMATION_DECLINED'));
  const before = app.ledger.cardMembers();
  await expect(app.authorizeHostPurchase({...input, existingOnly: true}, origin)).rejects.toThrow('LOCAL_PURCHASE_NOT_FOUND');
  expect(merchant).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  await expect(app.authorizeHostPurchase({...input, requestId: 'declined'}, origin)).rejects.toThrow('LOCAL_CONFIRMATION_DECLINED');
  expect(app.ledger.cardMembers()).toEqual(before);
  expect(app.ledger.listForAdministration(50)).toHaveLength(0);
  const [plan, duplicate] = await Promise.all([app.authorizeHostPurchase(input, origin), app.authorizeHostPurchase(input, origin)]);
  expect(duplicate).toEqual(plan); expect(confirm).toHaveBeenCalledTimes(2);
  expect(statement).not.toHaveBeenCalled();
  expect(confirm.mock.calls[1][0]).toMatchObject({binding: {input: {totalLimit: '1000', singleLimit: '1000'},
    scope: {payTo: quote.payTo}}, purchase: {requestId: input.requestId, reason: input.reason}});
  expect(app.boundHostPurchaseMember(registration)).toEqual({memberId: plan.memberId});
  expect(() => app.boundHostPurchaseMember({...registration, hostId: randomUUID()})).toThrow('LOCAL_HOST_BINDING_MISMATCH');
  const credential = readConnection(f.directory, plan.memberId);
  expect(credential.capabilities).toEqual(['request_purchase']);
  const req = new Request(origin, {headers: {authorization: 'Bearer ' + credential.token}});
  expect(handleAccountRead(app, 'statement', req).status).toBe(401);
  const principal = app.authenticateAgent(req, 'request_purchase');
  const facts = {caller_id: plan.memberId, operation_id: input.requestId, attempt_id: randomUUID(), execution_network: 'mainnet',
    request: {method: 'GET', url: plan.url, headers: [['accept', 'application/json']], body: null}, amount_atomic: quote.amount,
    asset: quote.asset, network: quote.network, recipient: quote.payTo, accepted: quote};
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    if (method !== 'getGenesisHash' && method !== 'getLatestBlockhash') throw new Error('UNEXPECTED_FIXTURE_RPC');
    return Response.json({jsonrpc: '2.0', id: 1, result: method === 'getGenesisHash' ? MAINNET_GENESIS
      : {value: {blockhash: f.buyer, lastValidBlockHeight: 5000}}});
  }));
  app.setDailyLimit('1000'); app.setPaused(false);
  await expect(app.payMcpOperation('authorize', {...facts, operation_id: 'unreviewed'}, principal, origin)).rejects.toThrow('LOCAL_PURCHASE_CONSENT_REQUIRED');
  await expect(app.payMcpOperation('authorize', {...facts, accepted: {...quote, amount: '999'}}, principal, origin)).rejects.toThrow('LOCAL_PURCHASE_BINDING_MISMATCH');
  expect(await app.payMcpOperation('authorize', facts, principal, origin)).toEqual({allow: true});
  await app.payMcpOperation('plan', {facts: {...facts, payment_required: challenge}}, principal, origin);
  expect(app.ledger.listForOwner(plan.memberId)[0].status).toBe('APPROVED');
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open(true, f.payMcpPath, statement, confirm, merchant);
  expect(await app.authorizeHostPurchase(input, origin)).toEqual(plan);
  await expect(app.authorizeHostPurchase({...input, reason: 'Other request'}, origin)).rejects.toThrow('LOCAL_PURCHASE_BINDING_MISMATCH');
  expect(confirm).toHaveBeenCalledTimes(2);
  await app.pairStatementHost(registration, origin);
  expect(statement).toHaveBeenCalledTimes(1);
  expect(handleAccountRead(app, 'statement', req).status).toBe(401);
  const updated = readConnection(f.directory, plan.memberId);
  expect(updated.capabilities).toEqual(['request_purchase','read_statement']);
  expect(handleAccountRead(app, 'statement', new Request(origin, {headers: {authorization: 'Bearer ' + updated.token}})).status).toBe(200);
});

it('keeps an established host identity and its standing grant across one-shot approvals and retries', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  const quote = {scheme: 'exact', amount: f.resource.amount, network: f.resource.network, asset: f.resource.mint,
    payTo: f.resource.recipient, maxTimeoutSeconds: 300, extra: {feePayer: f.resource.recipient}};
  const merchant = vi.fn<typeof fetch>(async url => {
    expect(String(url)).toBe(f.resource.request.url);
    return new Response(null, {status: 402, headers: {'payment-required': Buffer.from(JSON.stringify({
      x402Version: 2, resource: {url: f.resource.request.url}, accepts: [quote]})).toString('base64')}});
  });
  const registration = {hostId: randomUUID(), label: 'Established client'};
  const resolver = (id: string, label: string) => id === registration.hostId && label === registration.label ? 'default' : null;
  const confirm = vi.fn<ConfirmLocalGrant>(async () => {});
  const app = f.open(true, f.payMcpPath, undefined, confirm, merchant, resolver);
  app.setAgentConnection(true, origin); await app.initializeWallet();
  expect(app.boundHostPurchaseMember(registration)).toEqual({memberId: f.memberId});
  const credential = readConnection(f.directory), before = app.ledger.cardMembers();
  const input = {...registration, requestId: 'first', resourceId: f.resource.resourceId, reason: 'Market price'};
  expect(await app.authorizeHostPurchase(input, origin)).toMatchObject({memberId: f.memberId});
  expect(app.ledger.cardMembers()).toEqual(before);
  expect(readConnection(f.directory)).toEqual(credential);
  expect(confirm).toHaveBeenCalledTimes(1);
  await app.createSpendGrant({resourceId: f.resource.resourceId, singleLimit: '200', totalLimit: '10000', expiresAt: Date.now() + 3600_000});
  const small = app.spendGrantSummary()!;
  expect(await app.authorizeHostPurchase({...input, requestId: 'second'}, origin)).toMatchObject({memberId: f.memberId});
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(app.ledger.spendGrantById(small.id)!.status).toBe('ACTIVE');
  const broad = await app.createSpendGrant({resourceId: f.resource.resourceId, singleLimit: '2000', totalLimit: '10000', expiresAt: Date.now() + 3600_000});
  // A standing Grant can cover a higher price than the user requested for this particular order.
  const capped = {...input, requestId: 'explicit-price-limit', maximumAmountAtomic: '999'};
  await expect(app.authorizeHostPurchase(capped, origin)).rejects.toThrow('LOCAL_PURCHASE_PRICE_LIMIT_EXCEEDED');
  expect(app.ledger.localPurchaseConsent(f.memberId, capped.requestId)).toBeUndefined();
  expect(confirm).toHaveBeenCalledTimes(2);
  await expect(app.authorizeHostPurchase({...capped, requestId: 'exact-price-limit', maximumAmountAtomic: '1000'}, origin)).resolves.toMatchObject({memberId: f.memberId});
  for (const requestId of ['under-budget', 'also-under-budget', 'under-budget']) {
    await app.authorizeHostPurchase({...input, requestId}, origin);
    const permit = app.ledger.localPurchaseConsent(f.memberId, requestId);
    expect(permit?.grantId).toEqual(broad.id);
  }
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(app.ledger.listForAdministration(50)).toHaveLength(0);
  expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('uses the exact confirmed MPP challenge and independent fee ceiling, with no second merchant challenge or signature', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049', expiresAt = Date.now() + 240_000;
  const input = {hostId: randomUUID(), label: 'Local agent', requestId: 'mpp-order', resourceId: 'mpp-api', reason: 'Query price'};
  const request = {amount: '1000', currency: f.resource.mint, recipient: f.resource.recipient,
    methodDetails: {network: 'mainnet', decimals: 6, tokenProgram: TOKEN_PROGRAM}};
  const quote = MppChargeQuoteSchema.parse({protocol: 'mpp', method: 'solana', intent: 'charge', scheme: 'mpp_charge',
    network: f.resource.network, asset: f.resource.mint, payTo: f.resource.recipient, amount: '1000', expiresAt,
    challenge: {id: 'opaque-id', realm: 'fixture', method: 'solana', intent: 'charge', expires: new Date(expiresAt).toISOString(),
      request: Buffer.from(JSON.stringify(request)).toString('base64url')}, challengeHeader: 'Payment fixture'});
  const merchant = vi.spyOn(mppCharge, 'fetchMppResourceQuote').mockResolvedValue(quote);
  const confirm = vi.fn<ConfirmLocalGrant>(async () => {});
  const app = f.open(true, f.payMcpPath, undefined, confirm);
  app.addRegisteredResource({resourceId: input.resourceId, displayName: 'MPP', providerId: 'fixture', paymentProtocol: 'mpp_solana_charge',
    request: {method: 'GET', url: 'https://mpp.invalid/data', headers: {}, access: 'https'},
    network: f.resource.network, mint: f.resource.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '1000'});
  await expect(app.authorizeHostPurchase(input, origin)).rejects.toThrow('MPP_NETWORK_FEE_CONSENT_REQUIRED');
  expect(confirm).not.toHaveBeenCalled();
  const plan = await app.authorizeHostPurchase({...input, maximumNetworkFeeLamports: '10000'}, origin);
  expect(confirm.mock.calls[0][0].binding.scope.maximumNetworkFeeLamports).toBe('10000');
  expect(plan.protocol).toBe('mpp');
  const connection = readConnection(f.directory, plan.memberId);
  const principal = app.authenticateAgent(new Request(origin, {headers: {authorization: 'Bearer ' + connection.token}}), 'request_purchase');
  app.setPaused(true);
  const order = {requestId: input.requestId, resourceId: input.resourceId, reason: input.reason};
  expect(await app.requestMppPurchase(order, origin, principal)).toMatchObject({status: 'DENIED'});
  expect(app.ledger.getOwned(order.requestId, plan.memberId)?.intent.mpp).toEqual(quote);
  await expect(app.recoverPurchaseDelivery(order.requestId, principal)).rejects.toThrow('MPP_PAID_DELIVERY_REQUIRED');
  await expect(app.recoverPurchaseDelivery('unrecorded-purchase', principal)).rejects.toThrow('PURCHASE_NOT_FOUND');
  expect(merchant).toHaveBeenCalledTimes(1);
  expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('presents and binds the full registered GET query, enforcing the declared fields before consent', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049', endpoint = 'https://example.invalid/prices';
  const input = {hostId: randomUUID(), label: 'Price agent', resourceId: 'price-api', requestId: 'price', reason: 'Get prices'};
  const request = {query: {currency: 'usd', coins: 'BTC,ETH,SOL'}};
  const fullUrl = endpoint + '?coins=BTC%2CETH%2CSOL&currency=usd';
  const quote = {scheme: 'exact', amount: '1000', network: f.resource.network, asset: f.resource.mint, payTo: f.resource.recipient,
    maxTimeoutSeconds: 300, extra: {feePayer: f.resource.recipient}};
  const fetcher = vi.fn<typeof fetch>(async url => {
    expect(String(url)).toBe(fullUrl);
    return new Response(null, {status: 402, headers: {'payment-required': Buffer.from(JSON.stringify(
      {x402Version: 2, resource: {url: endpoint}, accepts: [quote]})).toString('base64')}});
  });
  const confirm = vi.fn<ConfirmLocalGrant>(async () => {});
  const app = f.open(true, f.payMcpPath, undefined, confirm, fetcher);
  app.addRegisteredResource({resourceId: input.resourceId, displayName: 'Price API', providerId: 'fixture',
    request: {method: 'GET', url: endpoint, headers: {}, access: 'https'}, requestInputs: {query: {
      coins: {type: 'string', required: true}, currency: {type: 'string', required: true, enum: ['usd']}}},
    network: f.resource.network, mint: f.resource.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: '1000'});
  await expect(app.authorizeHostPurchase({...input, request: {query: {address: 'wrong'}}}, origin)).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(await app.authorizeHostPurchase({...input, request}, origin)).toMatchObject({url: fullUrl});
  expect(confirm.mock.calls[0][0].purchase?.url).toBe(fullUrl);
  await expect(app.authorizeHostPurchase({...input, request: {query: {...request.query, coins: 'BTC'}}}, origin))
    .rejects.toThrow('LOCAL_PURCHASE_BINDING_MISMATCH');
});

it('classifies the unsigned merchant exchange before opening a purchase prompt or reserving funds', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  const input = {hostId: randomUUID(), label: 'Fixture caller', resourceId: f.resource.resourceId, requestId: 'quote-error', reason: 'Read prices'};
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(Object.assign(new Error('private host'), {code: 'ENOTFOUND'}))
    .mockResolvedValueOnce(new Response(null, {status: 503}))
    .mockResolvedValueOnce(new Response(null, {status: 402, headers: {'payment-required': 'malformed'}}))
    .mockRejectedValueOnce(new Error('RESOURCE_DESTINATION_UNSAFE'));
  const confirm = vi.fn<ConfirmLocalGrant>();
  const app = f.open(true, f.payMcpPath, undefined, confirm, fetcher);
  const wallet = vi.spyOn(app, 'initializeWallet');
  await expect(app.authorizeHostPurchase({...input, request: {query: {symbols: 'A,B'}}}, origin))
    .rejects.toThrow('LOCAL_PURCHASE_QUERY_NOT_ALLOWED');
  expect(wallet).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  for (const code of ['LOCAL_PURCHASE_QUOTE_UNAVAILABLE', 'LOCAL_PURCHASE_QUOTE_UNAVAILABLE',
    'LOCAL_PURCHASE_QUOTE_INVALID', 'LOCAL_PURCHASE_DESTINATION_REJECTED']) {
    await expect(app.authorizeHostPurchase(input, origin)).rejects.toThrow(code);
  }
  expect(confirm).not.toHaveBeenCalled();
  expect(loadBuyerSigner).not.toHaveBeenCalled();
  expect(app.ledger.listForAdministration(10)).toHaveLength(0);
});

it('uses a fixed registered price URL when an agent corrects an unsupported query on the same unpaid request', async () => {
  const f = fixture(), origin = 'http://127.0.0.1:3049';
  const endpoint = 'https://merchant.hosting.invalid/crypto-price';
  const url = endpoint + '?coins=BTC%2CETH%2CSOL&currency=usd';
  const resource = {...f.resource, request: {...f.resource.request, url}};
  vi.stubEnv('YOSH_MAINNET_RESOURCES', JSON.stringify([resource]));
  const input = {hostId: randomUUID(), label: 'Price client', requestId: 'price-order', resourceId: resource.resourceId, reason: 'Read prices'};
  const quote = {scheme: 'exact', network: resource.network, asset: resource.mint, amount: resource.amount,
    payTo: resource.recipient, maxTimeoutSeconds: 300, extra: {feePayer: resource.recipient}};
  const merchant = vi.fn<typeof fetch>(async () => new Response(null, {status: 402, headers: {
    'payment-required': Buffer.from(JSON.stringify({x402Version: 2, resource: {url: endpoint}, accepts: [quote]})).toString('base64'),
  }}));
  const confirm = vi.fn<ConfirmLocalGrant>(async () => { throw new Error('LOCAL_CONFIRMATION_DECLINED'); });
  const app = f.open(true, f.payMcpPath, undefined, confirm, merchant);

  await expect(app.authorizeHostPurchase({...input, request: {query: {symbols: 'BTC,ETH,SOL'}}}, origin))
    .rejects.toThrow('LOCAL_PURCHASE_QUERY_NOT_ALLOWED');
  expect(merchant).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await expect(app.authorizeHostPurchase(input, origin)).rejects.toThrow('LOCAL_CONFIRMATION_DECLINED');
  expect(merchant.mock.calls.map(([target]) => String(target))).toEqual([url]);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toMatchObject({purchase: {requestId: input.requestId, url}, binding: {input: {singleLimit: '1000'}}});
  expect(app.ledger.listForAdministration(10)).toHaveLength(0);
  expect(app.ledger.managedSummary(Date.now(), 'live_mainnet')).toMatchObject({paid: '0', reserved: '0'});
  expect(loadBuyerSigner).not.toHaveBeenCalled();
});

it('describes only the active GET purchase contract to a registered host before any consent or merchant call', () => {
  const f = fixture();
  const host = {hostId: randomUUID(), label: 'Installed agent'};
  const verifyHost = vi.fn((id: string, label: string) => {
    if (id !== host.hostId || label !== host.label) throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
    return null;
  });
  const confirm = vi.fn<ConfirmLocalGrant>(), merchant = vi.fn<typeof fetch>();
  const app = f.open(true, f.payMcpPath, undefined, confirm, merchant, verifyHost);
  const fixed = app.describeHostResource({...host, resourceId: f.resource.resourceId});
  expect(fixed).toEqual({resourceId: f.resource.resourceId, name: f.resource.resourceId, method: 'GET', protocol: 'x402',
    query: {mode: 'fixed', fields: [], requiresAtLeastOne: false}, networkFeeCap: 'omit'});
  const lookup = (resourceId: string) => app.describeHostResource({...host, resourceId});
  expect(lookup('you-web-search').query).toMatchObject({mode: 'dynamic', requiresAtLeastOne: true, fields: [{name: 'query'}]});
  const request = {method: 'GET', url: 'https://merchant.invalid/api?key=private', headers: {}, access: 'https'};
  const template = {displayName: 'Fixture', providerId: 'fixture', request, network: f.resource.network, mint: f.resource.mint,
    decimals: 6, recipientSource: 'live_challenge', maximumAmount: '1000'};
  app.addRegisteredResource({...template, resourceId: 'mpp-contract', paymentProtocol: 'mpp_solana_charge',
    requestInputs: {query: {ticker: {type: 'string', required: true, enum: ['SOL'], maxLength: 3}, units: {type: 'string'}}}});
  expect(lookup('mpp-contract')).toEqual({resourceId: 'mpp-contract', name: 'Fixture', method: 'GET', protocol: 'mpp', networkFeeCap: 'required',
    query: {mode: 'dynamic', requiresAtLeastOne: false, fields: [
      {name: 'ticker', type: 'string', required: true, minLength: 1, maxLength: 3, enum: ['SOL']},
      {name: 'units', type: 'string', required: false, minLength: 1, maxLength: 300},
    ]}});
  for (const [id, requestVariant] of [
    ['post-api', {...request, method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}],
    ['different-accept', {...request, headers: {accept: 'text/html'}}],
  ] as const) {
    app.addRegisteredResource({...template, request: requestVariant, resourceId: id});
    expect(() => lookup(id)).toThrow('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
  }
  app.disableRegisteredResource('mpp-contract', 'DISABLED');
  expect(() => lookup('mpp-contract')).toThrow('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
  expect(() => lookup('unknown')).toThrow('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
  expect(() => app.describeHostResource({...host, label: 'unregistered', resourceId: f.resource.resourceId})).toThrow('LOCAL_HOST_REGISTRATION_INVALID');
  expect(verifyHost).toHaveBeenCalledWith(host.hostId, host.label);
  expect(confirm).not.toHaveBeenCalled(); expect(merchant).not.toHaveBeenCalled();
});

it('binds the Mainnet tunnel reader to the original wallet and a native statement-only pairing across restarts', async () => {
  const consent = vi.fn<(facts: ReadConsent) => Promise<boolean>>(async () => true);
  const f = fixture(consent);
  let app = f.open();
  const rpc = (token: string, method = 'tools/list', params: object = {}) => {
    const request = new Request('http://127.0.0.1:3049/api/agent/remote-mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return handleRemoteReadMcp(app, request);
  };
  await expect(app.issueRemoteReadPairing('Dot', ['statement'])).rejects.toMatchObject({ code: 'REMOTE_READ_WALLET_REQUIRED' });
  app.ledger.walletAccounts.assertIdentity('mainnet', f.buyer);
  await expect(app.issueRemoteReadPairing('Dot', ['statement','result'])).rejects.toMatchObject({ code: 'REMOTE_READ_FORBIDDEN' });
  await expect(app.issueRemotePurchasePairing('Dot')).rejects.toThrow('REMOTE_PURCHASE_SIMULATED_ONLY');
  expect(consent).not.toHaveBeenCalled();
  consent.mockResolvedValueOnce(false);
  await expect(app.issueRemoteReadPairing('Dot', ['statement'])).rejects.toMatchObject({ code: 'REMOTE_READ_CONSENT_DENIED' });
  expect(app.listRemoteReadPairings()).toEqual([]);
  const reader = await app.issueRemoteReadPairing('Dot', ['statement']);
  expect(consent).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Dot', account: expect.stringContaining(f.buyer), scopes: ['statement'], environment: 'live_mainnet' }));
  expect(reader.memberId).not.toBe(f.memberId);
  expect(JSON.stringify(app.listRemoteReadPairings())).not.toContain(reader.token);
  // Existing rows issued against the generic slot or with broader scopes cannot
  // gain access when a Mainnet installation upgrades to this connection type.
  const oldScope = app.ledger.scope('live_mainnet');
  const old = app.ledger.issueRemoteReadPairing('Old reader', ['statement'], oldScope);
  expect((await rpc(old.token)).status).toBe(401);
  const pin = app.ledger.walletAccounts.get('mainnet')!;
  const broad = app.ledger.issueRemoteReadPairing('Broad reader', ['result','statement'], {
    ...oldScope, walletIdentity: pin.accountId + ' / ' + pin.publicKey });
  expect((await rpc(broad.token)).status).toBe(401);
  expect(() => app.setMemberConnection(true, 'http://127.0.0.1:3049', reader.memberId)).toThrow('REMOTE_MEMBER_READ_ONLY');
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  const tools = await (await rpc(reader.token)).json();
  expect(tools.result.tools.map((tool: {name: string}) => tool.name)).toEqual(['list_account_purchases']);
  const result = await (await rpc(reader.token, 'tools/call', { name: 'list_account_purchases', arguments: {} })).json();
  expect(JSON.parse(result.result.content[0].text)).toEqual(app.ledger.readAccountStatement(f.memberId, 'live_mainnet', {}));
  for (const name of ['read_account_result', 'request_purchase', 'recover_payment', 'sign']) {
    const reply = await (await rpc(reader.token, 'tools/call', { name, arguments: {} })).json();
    expect(reply.result?.isError === true || reply.error !== undefined).toBe(true);
  }
  app.revokeRemoteReadPairing(reader.id);
  expect((await rpc(reader.token)).status).toBe(401);
  await app.prepareQuit(); app.close(); runtimes.delete(app);
  app = f.open();
  expect((await rpc(reader.token)).status).toBe(401);
  expect(loadBuyerSigner).not.toHaveBeenCalled();
});
