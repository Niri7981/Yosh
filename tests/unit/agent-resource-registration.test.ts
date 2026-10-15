import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { discoverResource, prepareDiscovery } from '../../src/modules/resources/mainnet-resource-discovery';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111', connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
const input = { url: 'https://example.com/price?fixed=usd', requestInputs: { query: { coins: { type: 'string', required: true } } },
  sample: { query: { coins: 'SOL' } }, documentation: { urls: ['https://example.com/docs'], uncertainties: ['Recovery is not verified.'] },
  deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 262144 } };
const read = vi.fn(async (url: string) => new Headers({ 'payment-required': encodePaymentRequiredHeader({ x402Version: 2,
  resource: { url }, accepts: [{ scheme: 'exact', network: MAINNET_NETWORK, asset: MAINNET_USDC_MINT,
    amount: '1000', payTo: '11111111111111111111111111111111', maxTimeoutSeconds: 300,
    extra: { feePayer: 'ComputeBudget111111111111111111111111111111' } }] }) }));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.clearAllMocks(); });
const registration = (discoveryId: string) => ({ discoveryId, resourceId: 'generic-price', providerId: 'example.com', displayName: 'Generic price' });
it('persists a validated discovery, registers once across restart and leaves money/authority untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-agent-registry-')); dirs.push(dir); const path = join(dir, 'ledger.sqlite');
  let ledger = new PurchaseLedger(path, { managed: true }); ledger.resources.initialize([]);
  const discovered = ledger.resources.recordDiscovery(await discoverResource(input, read), principal);
  const oldPurchases = ledger.listForAdministration(); const oldGrants = ledger.spendGrantSummaries(Date.now(), 'live_mainnet', principal.cardMemberId);
  ledger.close(); ledger = new PurchaseLedger(path, { managed: true });
  const entry = ledger.resources.addDiscovered(registration(discovered.discoveryId), principal);
  expect(entry).toMatchObject({ source: 'agent', state: 'ACTIVE', submission: { cardMemberId: principal.cardMemberId,
    sample: input.sample, documentation: input.documentation }, definition: { request: { url: input.url, method: 'GET' },
    requestInputs: input.requestInputs, deliveryPolicy: input.deliveryPolicy, deliveryRecovery: { kind: 'none' }, maximumAmount: '1000' } });
  expect(ledger.resources.addDiscovered(registration(discovered.discoveryId), principal)).toEqual(entry);
  expect(ledger.listForAdministration()).toEqual(oldPurchases); expect(ledger.spendGrantSummaries(Date.now(), 'live_mainnet', principal.cardMemberId)).toEqual(oldGrants);
  expect(read).toHaveBeenCalledTimes(1); ledger.close();
  ledger = new PurchaseLedger(path, { managed: true }); expect(ledger.resources.inspect(entry.definition.resourceId)).toEqual(entry);
  expect(ledger.resources.active().some(r => r.resourceId === entry.definition.resourceId)).toBe(true);
  ledger.resources.setState(entry.definition.resourceId, 'DISABLED');
  expect(() => ledger.resources.addDiscovered(registration(discovered.discoveryId), principal)).toThrow('RESOURCE_DISCOVERY_CONSUMED');
  ledger.close();
});
it('rejects fabricated, cross-agent, expired, altered and duplicate submissions atomically', async () => {
  const ledger = new PurchaseLedger(':memory:', { managed: true }); ledger.resources.initialize([]);
  const discovery = ledger.resources.recordDiscovery(await discoverResource(input, read), principal);
  for (const [raw, actor] of [
    [registration('33333333-3333-4333-8333-333333333333'), principal],
    [registration(discovery.discoveryId), { ...principal, cardMemberId: '33333333-3333-4333-8333-333333333333' }],
    [registration(discovery.discoveryId), { ...principal, connectionGeneration: 2 }],
    [{ ...registration(discovery.discoveryId), request: { url: 'https://evil.com/' } }, principal],
    [{ ...registration(discovery.discoveryId), grant: { total: '1000000' } }, principal],
  ] as const) expect(() => ledger.resources.addDiscovered(raw, actor)).toThrow();
  const entry = ledger.resources.addDiscovered(registration(discovery.discoveryId), principal);
  expect(() => ledger.resources.addDiscovered({ ...registration(discovery.discoveryId), displayName: 'Changed' }, principal)).toThrow('RESOURCE_DISCOVERY_CONSUMED');
  const second = ledger.resources.recordDiscovery(await discoverResource(input, read), principal);
  expect(() => ledger.resources.addDiscovered({ ...registration(second.discoveryId), resourceId: 'duplicate-price' }, principal)).toThrow('RESOURCE_REQUEST_EXISTS');
  expect(ledger.resources.inspect(entry.definition.resourceId).definition.displayName).toBe('Generic price');
  ledger.close();
  let now = 1000; const expiring = new PurchaseLedger(':memory:', { managed: true, now: () => now });
  const expired = expiring.resources.recordDiscovery(await discoverResource(input, read), principal); now += 1800001;
  expect(() => expiring.resources.addDiscovered(registration(expired.discoveryId), principal)).toThrow('RESOURCE_DISCOVERY_EXPIRED'); expiring.close();
});
it('retains POST consent before discovery, and registration never performs outbound I/O', async () => {
  const post = { ...input, method: 'POST', body: '{"fixed":true}', headers: { 'content-type': 'application/json' },
    requestInputs: { jsonBody: { query: { type: 'string', required: true } } }, sample: { jsonBody: { query: 'SOL' } } };
  await expect(discoverResource(post, read)).rejects.toThrow('RESOURCE_POST_APPROVAL_REQUIRED'); expect(read).not.toHaveBeenCalled();
  const result = await discoverResource(post, read, prepareDiscovery(post).review.requestHash);
  const ledger = new PurchaseLedger(':memory:', { managed: true });
  const ticket = ledger.resources.recordDiscovery(result, principal);
  ledger.resources.addDiscovered(registration(ticket.discoveryId), principal);
  expect(read).toHaveBeenCalledTimes(1); ledger.close();
});
it('rejects undocumented recovery capabilities and invalid metadata instead of guessing', async () => {
  await expect(discoverResource({ ...input, documentation: undefined, deliveryRecovery: { kind: 'idempotent_replay' } }, read)).rejects.toThrow();
  await expect(discoverResource({ ...input, deliveryPolicy: { ...input.deliveryPolicy, maxBytes: 262145 } }, read)).rejects.toThrow();
  await expect(discoverResource({ ...input, documentation: { urls: ['http://localhost/'] } }, read)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
