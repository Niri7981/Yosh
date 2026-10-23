import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { assertPayMainnetAcceptance, recordPayMainnetAcceptance, consentEconomicIntentV3 } from '../../src/modules/payment/pay-mainnet-control';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { hash } from '../../src/modules/purchases/spending-policy';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-exact-approval-')); chmodSync(directory, 0o700); directories.push(directory);
  writeFileSync(join(directory, 'pay-mainnet-cutover.json'), '{}', { mode: 0o600 });
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const config = { ...environment, buyer: '11111111111111111111111111111111', merchant: 'J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg',
    mint: environment.asset.mint, facilitatorUrl: null };
  const resource = { resourceId: 'agent402-crypto-price', providerId: 'agent402.tools', resourceUrl: 'https://agent402.tools/api/crypto-price?coins=BTC%2CETH%2CSOL&currency=usd' };
  const facts = { caller_id: randomUUID(), operation_id: 'stable-first-purchase', request: { method: 'GET', url: resource.resourceUrl, headers: [['accept', 'application/json']], body: null },
    accepted: { amount: '1000', extra: { feePayer: 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP' } },
    payment_required: { resource: { url: resource.resourceUrl }, extensions: { bazaar: { info: {} } } },
    network: environment.network, asset: config.mint, recipient: config.merchant, amount_atomic: '1000' };
  const receipt = { version: 2, callerId: facts.caller_id, operationId: facts.operation_id, wallet: config.buyer,
    ...resource, network: facts.network, asset: facts.asset, recipient: facts.recipient, amountAtomic: facts.amount_atomic,
    requestHash: hash(facts.request), quoteHash: hash(facts.accepted), challengeHash: hash(facts.payment_required), expiresAt: Date.now() + 60_000 };
  writeFileSync(join(directory, 'pay-mainnet-acceptance.json'), JSON.stringify(receipt), { mode: 0o600 });
  return { directory, config, facts, resource, receipt };
}

it('requires all exact facts independently of execution enablement; approval never enables execution', () => {
  const f = fixture();
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, f.facts, f.resource)).not.toThrow();
  expect(f.config.productionExecutionEnabled).toBe(false);
  expect(() => recordPayMainnetAcceptance(f.directory, { ...f.receipt, version: 1 })).toThrow();
});

it.each(['caller_id', 'operation_id', 'request', 'accepted', 'payment_required', 'network', 'asset', 'recipient', 'amount_atomic'] as const)(
  'cannot reuse confirmation across changed %s', field => {
    const f = fixture();
    const changed = { ...f.facts, [field]: typeof f.facts[field] === 'string' ? 'different' : { changed: true } };
    expect(() => assertPayMainnetAcceptance(f.directory, f.config, changed, f.resource)).toThrow('PAY_MAINNET_ACCEPTANCE_REQUIRED');
  });

it.each(['resourceId', 'providerId', 'resourceUrl'] as const)('explicitly binds %s as well as the complete request and challenge hashes', field => {
  const f = fixture();
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, f.facts, { ...f.resource, [field]: 'different' })).toThrow();
});

it('rejects wallet replacement and expiry, including after a persistent receipt is reopened', () => {
  const f = fixture();
  expect(() => assertPayMainnetAcceptance(f.directory, { ...f.config, buyer: f.config.merchant }, f.facts, f.resource)).toThrow();
  vi.useFakeTimers(); vi.setSystemTime(f.receipt.expiresAt + 1);
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, f.facts, f.resource)).toThrow();
});


it('v3 allows only known blockhash freshness across attempts and rejects economic or unknown mutation', () => {
  const f = fixture();
  const offer = { ...f.facts.accepted, scheme: 'exact', network: f.facts.network, asset: f.facts.asset,
    payTo: f.facts.recipient, maxTimeoutSeconds: 300,
    extra: { ...f.facts.accepted.extra, recentBlockhash: f.config.buyer, memo: 'order-1' } };
  const envelope = { x402Version: 2, resource: { url: f.resource.resourceUrl }, accepts: [offer], extensions: { bazaar: { info: {} } } };
  const facts = { ...f.facts, accepted: offer, payment_required: envelope };
  const { quoteHash: _quote, challengeHash: _challenge, ...base } = f.receipt;
  void _quote; void _challenge;
  recordPayMainnetAcceptance(f.directory, { ...base, version: 3, ...consentEconomicIntentV3(offer, envelope) });
  const fresh = { ...offer, extra: { ...offer.extra, recentBlockhash: f.config.merchant } };
  const next = { ...facts, accepted: fresh, payment_required: { ...envelope, resource: { ...envelope.resource, description: 'updated display text' },
    accepts: [fresh, { ...fresh, amount: '2000' }] } };
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, next, f.resource)).not.toThrow();
  const { payment_required: _envelope, ...spend } = next;
  void _envelope;
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, spend, f.resource)).not.toThrow();
  for (const changed of [
    { ...fresh, amount: '2000' }, { ...fresh, payTo: f.config.buyer },
    { ...fresh, asset: f.config.buyer }, { ...fresh, network: 'solana:other' },
    { ...fresh, scheme: 'other' }, { ...fresh, extra: { ...fresh.extra, feePayer: f.config.buyer } },
    { ...fresh, extra: { ...fresh.extra, memo: 'other-order' } },
    { ...fresh, extra: { ...fresh.extra, unknown: 'new' } },
  ]) expect(() => assertPayMainnetAcceptance(f.directory, f.config, { ...next, accepted: changed }, f.resource)).toThrow();
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, { ...next,
    payment_required: { ...next.payment_required, extensions: { unknown: { responsibility: 'buyer' } } } }, f.resource)).toThrow();
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, { ...next, request: { ...next.request, url: 'https://other.invalid' } }, f.resource)).toThrow();
});

it('new issuance requires v3; existing v2 remains exact and is never upgraded', () => {
  const f = fixture();
  expect(() => recordPayMainnetAcceptance(f.directory, f.receipt)).toThrow('PAY_MAINNET_ACCEPTANCE_V3_REQUIRED');
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, f.facts, f.resource)).not.toThrow();
  expect(() => assertPayMainnetAcceptance(f.directory, f.config, { ...f.facts,
    accepted: { ...f.facts.accepted, extra: { ...f.facts.accepted.extra, recentBlockhash: f.config.buyer } } }, f.resource)).toThrow();
});
