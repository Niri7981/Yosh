import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { purchasePairingRequest, remotePurchaseToken } from '../../src/modules/remote/pairings';

it('a simulated spending credential stays a distinct single-generation principal after restart and cannot be repurposed or revived', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-p2-identity-'));
  const open = () => new PurchaseLedger(join(dir, 'app-ledger.sqlite'), { managed: true, mode: 'simulated' });
  let ledger = open();
  try {
    const store = ledger.remoteReadPairings(), sim = ledger.scope('simulated');
    const r = ledger.issueRemoteReadPairing('Existing read member', ['result'], sim);
    const spendMember = ledger.createCardMember('Sim buyer').id;
    const request = purchasePairingRequest.parse({ label: 'Sim buyer', scopes: ['purchase'] });
    expect(() => store.issue(spendMember, request, ledger.scope('live_devnet'), 1)).toThrow('REMOTE_PURCHASE_SIMULATED_ONLY');
    expect(store.list()).toHaveLength(1);
    const p = store.issue(spendMember, request, sim, 2);
    expect(p.token).toMatch(remotePurchaseToken);
    const principal = { cardMemberId: spendMember, connectionId: p.id, connectionGeneration: 1 };
    expect(store.purchasePrincipal(p.id, sim)).toEqual(principal);
    expect(purchasePairingRequest.safeParse({ label: 'Sim buyer', scopes: ['purchase','result'] }).success).toBe(false);
    ledger.close(); ledger = open();
    const reopened = ledger.remoteReadPairings();
    expect(reopened.purchasePrincipal(p.id, sim)).toEqual(principal);
    expect(() => reopened.purchasePrincipal(r.id, sim)).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(() => reopened.authenticatePurchase(r.token, sim)).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(() => reopened.authenticatePurchase(r.token.replace('yrr1_', 'yrp1_'), sim)).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(() => reopened.authenticate(p.token, sim)).toThrow('REMOTE_READ_UNAUTHORIZED');
    expect(() => reopened.authenticatePurchase(p.token, { ...sim, walletIdentity: 'other' })).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(() => reopened.authenticatePurchase(p.token, ledger.scope('live_mainnet'))).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(reopened.authenticatePurchase(p.token, sim).memberId).toBe(spendMember);
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.list().some(metadata => 'token' in metadata || 'token_hash' in metadata)).toBe(false);
    ledger.revokeCardMember(spendMember);
    expect(() => reopened.authenticatePurchase(p.token, sim)).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(() => reopened.purchasePrincipal(p.id, sim)).toThrow('REMOTE_PURCHASE_UNAUTHORIZED');
    expect(reopened.authenticate(r.token, sim).id).toBe(r.id);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
