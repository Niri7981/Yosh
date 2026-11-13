import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { LocalControlAction, localControlDigest } from '../../src/modules/authority/local-control-approval';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
const now = 1794326400000;
function open(path = ':memory:') {
  const ledger = new PurchaseLedger(path, { managed: true, mode: 'live_devnet', now: () => now });
  cleanups.push(() => ledger.close());
  const store = ledger.localControlApprovals();
  const freeze = (raw: unknown) => {
    const frozen = store.freeze({ environment: 'offline', mode: 'live_devnet', memberId: ledger.defaultCardMember().id,
      agentLabel: 'Codex', sessionHash: 'a'.repeat(64), basis: createHash('sha256').update('basis').digest('hex'), action: LocalControlAction.parse(raw) }, now);
    return { frozen, receipt: { requestId: frozen.request.id, digest: frozen.digest } };
  };
  return { ledger, store, freeze };
}
it('commits pause/daily controls and receipts together, preserves purchases and refuses replay', () => {
  const { ledger, store, freeze } = open();
  for (const action of [{ type: 'pause', paused: true }, { type: 'daily_limit', amount: '1000000' }]) {
    const { receipt } = freeze(action);
    const apply = () => action.type === 'pause' ? ledger.setPaused(true, 'live_devnet', undefined, receipt)
      : ledger.setDailyLimit('1000000', 'live_devnet', undefined, receipt);
    apply(); expect(store.read(receipt.requestId).state).toBe('CONSUMED');
    expect(() => apply()).toThrow('ALREADY_USED');
  }
  expect(ledger.controls('live_devnet')).toMatchObject({ paused: true, dailyBudget: '1000000' });
  expect(ledger.listForAdministration()).toEqual([]);
});
it.each(['different action', 'wrong digest', 'cancelled', 'expired', 'wrong mode'])('rejects %s before changing controls', problem => {
  const { ledger, store, freeze } = open();
  const { receipt, frozen } = freeze({ type: 'pause', paused: true });
  if (problem === 'wrong digest') receipt.digest = 'f'.repeat(64);
  if (problem === 'cancelled') store.cancel(receipt.requestId, 'a'.repeat(64));
  const previous = ledger.controls('live_devnet');
  if (problem === 'expired') expect(() => store.assertPending(receipt, frozen.request.action, now + 300_000)).toThrow('EXPIRED');
  else expect(() => ledger.setPaused(problem !== 'different action', problem === 'wrong mode' ? 'live_mainnet' : 'live_devnet', undefined, receipt)).toThrow();
  expect(ledger.controls('live_devnet')).toEqual(previous);
});
it('binds all displayed control contents and session to its digest', () => {
  const { freeze } = open(), { frozen } = freeze({ type: 'pause', paused: true });
  for (const change of [{ agentLabel: 'other' }, { memberId: randomUUID() }, { sessionHash: 'b'.repeat(64) }, { action: { type: 'pause', paused: false } }])
    expect(localControlDigest({ ...frozen.request, ...change })).not.toBe(frozen.digest);
});
it('rolls back a control change if receipt persistence fails, and survives reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-control-')); cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'ledger.sqlite'), first = open(path);
  const { receipt } = first.freeze({ type: 'daily_limit', amount: '1000000' });
  const other = new DatabaseSync(path);
  other.exec("CREATE TRIGGER fail_control_consume BEFORE UPDATE OF state ON local_control_requests BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  const before = first.ledger.controls('live_devnet');
  expect(() => first.ledger.setDailyLimit('1000000', 'live_devnet', undefined, receipt)).toThrow();
  expect(first.ledger.controls('live_devnet')).toEqual(before);
  other.exec('DROP TRIGGER fail_control_consume'); other.close();
  first.ledger.setDailyLimit('1000000', 'live_devnet', undefined, receipt);
  first.ledger.close(); cleanups.pop();
  const reopened = open(path);
  expect(reopened.store.read(receipt.requestId).state).toBe('CONSUMED');
  expect(() => reopened.ledger.setDailyLimit('1000000', 'live_devnet', undefined, receipt)).toThrow('ALREADY_USED');
});

it('claims external setup once and preserves the unresolved request instead of repeating side effects', () => {
  const { store, freeze } = open();
  const action = { type: 'create_wallet', slot: 'devnet', network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT };
  const first = freeze(action), second = freeze(action);
  store.claimExternal(first.receipt, now);
  expect(() => store.claimExternal(first.receipt, now)).toThrow('ALREADY_USED');
  expect(() => store.claimExternal(second.receipt, now)).toThrow('RECONCILIATION_REQUIRED');
  expect(store.read(first.receipt.requestId).state).toBe('CLAIMED');
  store.consume(first.receipt, now);
  expect(store.read(first.receipt.requestId).state).toBe('CONSUMED');
});
