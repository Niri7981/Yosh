import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { RuntimeResourceSchema } from '../../src/modules/resources/runtime-resource-registry';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
export const testResource = { resourceId: 'runtime-test', providerId: 'example', displayName: 'Runtime test API',
  request: { url: 'https://example.com/search', method: 'GET', access: 'https', headers: {} },
  network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT, decimals: 6, recipientSource: 'live_challenge',
  baseAmount: '5000', maximumAmount: '5000', deliveryRecovery: { kind: 'none' } };
it('adds immutable runtime data, immediately selectable and persistent after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-registry-')); dirs.push(dir); const path = join(dir, 'ledger.sqlite');
  const ledger = new PurchaseLedger(path, { managed: true }); ledger.resources.initialize([]);
  const before = ledger.resources.active(); ledger.resources.add(testResource);
  expect(ledger.resources.active()).toHaveLength(before.length + 1);
  expect(ledger.resources.inspect('runtime-test')).toMatchObject({ source: 'user', state: 'ACTIVE', definition: testResource });
  ledger.close();
  const reopened = new PurchaseLedger(path, { managed: true }); reopened.resources.initialize([]);
  expect(reopened.resources.active().find(r => r.resourceId === 'runtime-test')).toMatchObject(testResource);
  expect(reopened.resources.active().find(r => r.resourceId === 'you-web-search')).toBeDefined(); reopened.close();
});
it('tombstones user resources, reserves old IDs and leaves ledger history and grants untouched', () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true }); ledger.resources.initialize([]);
  const history = ledger.listForAdministration(); ledger.resources.add(testResource);
  ledger.resources.setState('runtime-test', 'DISABLED'); expect(ledger.resources.active().some(r => r.resourceId === 'runtime-test')).toBe(false);
  ledger.resources.setState('runtime-test', 'REMOVED'); expect(ledger.resources.inspect('runtime-test').state).toBe('REMOVED');
  expect(() => ledger.resources.add(testResource)).toThrow('RESOURCE_ID_EXISTS'); expect(ledger.listForAdministration()).toEqual(history);
  expect(() => ledger.resources.setState('you-web-search', 'REMOVED')).toThrow('RESOURCE_READ_ONLY'); ledger.close();
});
it('rejects credentials, unbounded prices, foreign assets, transaction facts and unsafe endpoints', () => {
  for (const change of [{ recipient: '11111111111111111111111111111111' }, { feePayer: '11111111111111111111111111111111' },
    { maximumAmount: undefined }, { maximumAmount: '4999' }, { mint: '11111111111111111111111111111111' },
    { request: { ...testResource.request, url: 'https://localhost/data' } },
    { request: { ...testResource.request, headers: { authorization: 'secret' } } }]) {
    expect(RuntimeResourceSchema.safeParse({ ...testResource, ...change }).success).toBe(false);
  }
});
it('migrates an older built-in You.com registration without changing user resources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-registry-migration-')); dirs.push(dir); const path = join(dir, 'ledger.sqlite');
  const first = new PurchaseLedger(path, { managed: true }); first.resources.initialize([]);
  first.resources.add(testResource); first.close();
  const db = new DatabaseSync(path);
  const old = JSON.parse(String(db.prepare("SELECT definition FROM resource_registry WHERE resource_id='you-web-search'").get()!.definition));
  delete old.requestInputs; delete old.deliveryPolicy;
  db.exec('DROP TRIGGER resource_definition_immutable');
  db.prepare('UPDATE resource_registry SET definition=? WHERE resource_id=?').run(JSON.stringify(old), 'you-web-search');
  db.prepare("DELETE FROM resource_registry_migrations WHERE id='012_builtin_request_policy'").run();
  db.close();
  const upgraded = new PurchaseLedger(path, { managed: true }); upgraded.resources.initialize([]);
  expect(upgraded.resources.inspect('you-web-search').definition).toMatchObject({ requestInputs: { query: ['query'] },
    deliveryPolicy: { format: 'json', maxBytes: 262_144 } });
  expect(upgraded.resources.inspect('runtime-test').definition).toMatchObject(testResource);
  expect(() => upgraded.resources.add(testResource)).toThrow('RESOURCE_ID_EXISTS');
  upgraded.close();
});
