import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { localGrantBytes, localGrantDigest } from '../../src/modules/authority/local-grant-approval';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';

const now = 1_794_326_400_000;
const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111', connectionId: randomUUID(), connectionGeneration: 1 };
const input = { totalLimit: '1000000', singleLimit: '200000', expiresAt: now + 86_400_000 };
const scope = { resourceId: 'local-test-api', providerId: 'test', operation: 'paid.resource.purchase', network: DEVNET_NETWORK,
  assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo: '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs', paymentScheme: 'exact' };
const binding = { input, principal, scope, mode: 'live_devnet' as const };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });
function open(path = ':memory:') {
  const ledger = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', defaultCardMemberId: principal.cardMemberId, now: () => now });
  cleanups.push(() => ledger.close());
  const approvals = ledger.localGrantApprovals();
  return { ledger, approvals };
}
function freeze(approvals: ReturnType<typeof open>['approvals']) {
  return approvals.freeze({ environment: 'offline', agentLabel: 'Codex', apiLabel: '测试 API',
    sessionHash: 'a'.repeat(64), resourceHash: 'b'.repeat(64), binding }, now);
}
function fixture() {
  const value = open(), frozen = freeze(value.approvals);
  const confirmation = { requestId: frozen.request.id, digest: frozen.digest };
  return { ...value, frozen, confirmation };
}
it('commits one Grant and its request receipt together, without unpausing or buying', () => {
  const { ledger, approvals, confirmation } = fixture();
  const before = ledger.managedSummary(now, 'live_devnet');
  const grant = ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation);
  expect(approvals.read(confirmation.requestId)).toMatchObject({ state: 'CONSUMED', grantId: grant.id });
  expect(ledger.managedSummary(now, 'live_devnet')).toEqual(before);
  expect(ledger.listForAdministration()).toEqual([]);
  expect(() => ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation)).toThrow('ALREADY_USED');
  expect(ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toHaveLength(1);
});
it.each(['total', 'single', 'expiry', 'recipient', 'network', 'asset', 'agent', 'connection', 'resource', 'digest'])(
  'rejects changed %s without consuming or granting', field => {
    const { ledger, approvals, confirmation } = fixture();
    const changedInput = { ...input }, changedScope = { ...scope }, changedPrincipal = { ...principal };
    if (field === 'total') changedInput.totalLimit = '2000000';
    if (field === 'single') changedInput.singleLimit = '300000';
    if (field === 'expiry') changedInput.expiresAt += 1000;
    if (field === 'recipient') changedScope.payTo = 'different';
    if (field === 'network') changedScope.network = 'wrong';
    if (field === 'asset') changedScope.assetId = 'wrong';
    if (field === 'agent') changedPrincipal.cardMemberId = randomUUID();
    if (field === 'connection') changedPrincipal.connectionGeneration++;
    if (field === 'resource') changedScope.resourceId = 'other';
    if (field === 'digest') confirmation.digest = 'f'.repeat(64);
    expect(() => ledger.createSpendGrant(changedInput, changedPrincipal, changedScope, now, 'live_devnet', confirmation)).toThrow();
    expect(approvals.read(confirmation.requestId).state).toBe('PENDING');
    expect(ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toHaveLength(0);
  });
it('binds frozen bytes to the browser session, labels and resource version', () => {
  const { frozen } = fixture();
  for (const change of [{ sessionHash: 'c'.repeat(64) }, { agentLabel: 'other' }, { resourceHash: 'd'.repeat(64) }, { payerWallet: '11111111111111111111111111111111' }]) {
    expect(localGrantDigest({ ...frozen.request, ...change })).not.toBe(frozen.digest);
  }
  expect(localGrantBytes(JSON.parse(localGrantBytes(frozen.request)))).toBe(localGrantBytes(frozen.request));
});
it('rejects display labels that inject new fields or reverse text direction', () => {
  const { frozen } = fixture();
  for (const agentLabel of ['Codex\n收款方：other', 'Codex\u202e123'])
    expect(() => localGrantBytes({ ...frozen.request, agentLabel })).toThrow();
  expect(() => localGrantBytes({ ...frozen.request, binding: { ...binding,
    scope: { ...scope, resourceId: 'api\n总额：0' } } })).toThrow();
});
it('rejects expired and future-dated confirmation', () => {
  const { ledger, confirmation } = fixture();
  for (const clock of [now - 1, now + 300_000]) {
    expect(() => ledger.createSpendGrant(input, principal, scope, clock, 'live_devnet', confirmation)).toThrow('EXPIRED');
  }
});
it('cancellation requires the same session and cannot resurrect a request', () => {
  const { ledger, approvals, confirmation } = fixture();
  expect(() => approvals.cancel(confirmation.requestId, 'b'.repeat(64))).toThrow('SESSION_MISMATCH');
  approvals.cancel(confirmation.requestId, 'a'.repeat(64));
  expect(() => ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation)).toThrow('ALREADY_USED');
});
it('rejects a confirmation exchanged between two identical-looking requests', () => {
  const { ledger, approvals, confirmation } = fixture();
  const second = freeze(approvals);
  expect(() => ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', { ...confirmation, requestId: second.request.id })).toThrow('CONTENT_CHANGED');
});
it('rolls back grant creation when its durable receipt fails; retries work after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-local-auth-'));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'ledger.sqlite');
  const first = open(path), frozen = freeze(first.approvals);
  const confirmation = { requestId: frozen.request.id, digest: frozen.digest };
  const db = new DatabaseSync(path); cleanups.push(() => db.close());
  db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON local_grant_requests BEGIN SELECT RAISE(ABORT,'test storage failure'); END");
  expect(() => first.ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation)).toThrow('test storage failure');
  expect(first.approvals.read(confirmation.requestId).state).toBe('PENDING');
  expect(first.ledger.spendGrantSummaries(now, 'live_devnet', principal.cardMemberId)).toHaveLength(0);
  db.exec('DROP TRIGGER reject_receipt');
  const second = open(path);
  const grant = second.ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation);
  expect(first.approvals.read(confirmation.requestId).grantId).toBe(grant.id);
  expect(() => first.ledger.createSpendGrant(input, principal, scope, now, 'live_devnet', confirmation)).toThrow('ALREADY_USED');
});

it('keeps mainnet receipts and legacy native App grants usable across restart without changing controls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mainnet-web-restart-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const mainnetScope = { ...scope, network: MAINNET_NETWORK, assetId: MAINNET_USDC_MINT };
  const mainnetBinding = { ...binding, scope: mainnetScope, mode: 'live_mainnet' as const };
  const first = new PurchaseLedger(path, { managed: true, mode: 'live_mainnet', defaultCardMemberId: principal.cardMemberId, now: () => now });
  const original = first.createSpendGrant(input, principal, mainnetScope, now, 'live_mainnet');
  const controls = first.controls('live_mainnet');
  const frozen = first.localGrantApprovals().freeze({ environment: 'mainnet', sessionHash: 'a'.repeat(64), agentLabel: 'Codex', apiLabel: 'API', resourceHash: 'b'.repeat(64), binding: mainnetBinding }, now);
  first.close();
  const reopened = new PurchaseLedger(path, { managed: true, mode: 'live_mainnet', defaultCardMemberId: principal.cardMemberId, now: () => now });
  try {
    expect(reopened.spendGrantSummary(now, 'live_mainnet')?.id).toBe(original.id);
    expect(reopened.controls('live_mainnet')).toEqual(controls);
    const confirmation = { requestId: frozen.request.id, digest: frozen.digest };
    const grant = reopened.createSpendGrant(input, principal, mainnetScope, now, 'live_mainnet', confirmation);
    expect(reopened.localGrantApprovals().read(frozen.request.id).grantId).toBe(grant.id);
    expect(() => reopened.createSpendGrant(input, principal, mainnetScope, now, 'live_mainnet', confirmation)).toThrow('ALREADY_USED');
    expect(() => localGrantBytes({ ...frozen.request, environment: 'devnet' })).toThrow();
    expect(() => localGrantBytes({ ...frozen.request, binding })).toThrow();
    expect(reopened.listForAdministration()).toEqual([]);
  } finally { reopened.close(); }
});
