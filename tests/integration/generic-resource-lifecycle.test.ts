import { postRequestPolicyHash } from '../../src/modules/resources/post-request-authorization';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generateKeyPairSigner } from '@solana/kit';
import { expect, it, vi } from 'vitest';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { discoverResource, prepareDiscovery } from '../../src/modules/resources/mainnet-resource-discovery';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import { requestForPurchase } from '../../src/modules/purchases/request-registered-resource-purchase';
import { fetchResourceChallenge } from '../../src/modules/payment/resource-challenge';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';

it('takes an unknown JSON POST from unpaid discovery to resource-scoped purchase eligibility without execution', async () => {
  const buyer = await generateKeyPairSigner(); const merchant = await generateKeyPairSigner(); const sponsor = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const url = 'https://previously-unknown.example/v1/analyze';
  const challenge = (amount: string) => ({ x402Version: 2 as const, resource: { url }, accepts: [{ scheme: 'exact',
    network: environment.network, asset: environment.asset.mint, amount, payTo: merchant.address,
    maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address } }] });
  const unpaid = vi.fn().mockResolvedValue(new Headers({ 'payment-required': encodePaymentRequiredHeader(challenge('5000')) }));
  const discoveryInput = { url, method: 'POST', requestInputs: { jsonBody: { prompt: { type: 'string', required: true, maxLength: 300 }, detail: { type: 'object', required: false, maxProperties: 2 } } },
    sample: { jsonBody: { prompt: 'sample' } } };
  const discovery = await discoverResource(discoveryInput, unpaid, prepareDiscovery(discoveryInput).review.requestHash);
  expect(discovery.paymentSent).toBe(false);
  const directory = mkdtempSync(join(tmpdir(), 'yosh-generic-resource-'));
  const path = join(directory, 'ledger.sqlite');
  const ledger = new PurchaseLedger(path, { managed: true, requireRegisteredResource: true, requireSpendGrant: true, mode: 'live_mainnet' });
  try {
    const definition = ledger.resources.add({ resourceId: 'unknown-json-post', providerId: 'synthetic.example',
      displayName: 'Synthetic Analyze', ...discovery.proposal,
      request: discovery.proposal.request, maximumAmount: '8000', baseAmount: '5000',
      deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 32_768 } }).definition;
    const second = ledger.resources.add({ ...definition, resourceId: 'second-get', displayName: 'Second resource',
      request: { url: 'https://second.example/v1/data', method: 'GET', access: 'https', headers: {} },
      requestInputs: undefined }).definition;
    const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
    const now = Date.now(); ledger.setDailyLimit('20000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
    const grantInput = { totalLimit: '10000', singleLimit: '8000', expiresAt: now + 3_600_000 };
    for (const resource of [definition, second]) ledger.createSpendGrant(grantInput, principal, {
      resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: environment.network, assetId: environment.asset.mint, assetDecimals: 6, payTo: merchant.address,
      paymentScheme: 'exact', ...(resource.request.method === 'POST' ? { postPolicyHash: postRequestPolicyHash(resource) } : {}) }, now, 'live_mainnet');
    expect(ledger.spendGrantSummaries(now, 'live_mainnet', principal.cardMemberId).filter(grant => grant.status === 'ACTIVE')).toHaveLength(2);
    const actual = requestForPurchase(definition, { requestId: 'unknown-post-1', resourceId: definition.resourceId,
      reason: 'synthetic check', request: { jsonBody: { prompt: 'actual', detail: { depth: 2 } } } });
    const fresh = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 402,
      headers: { 'payment-required': encodePaymentRequiredHeader(challenge('6000')) } }));
    const { quote, challenge: issued } = await fetchResourceChallenge(actual, environment, fresh);
    expect(fresh).toHaveBeenCalledOnce();
    expect(quote.amount).toBe('6000');
    const authority = ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet', definition.resourceId);
    const intent = createX402SpendIntent({ idempotencyKey: 'unknown-post-1', resource: actual, challenge: issued,
      environment, buyer: buyer.address, reason: 'synthetic check', authority, now });
    const result = ledger.reserve(intent, quote, now, 'live_mainnet', principal.cardMemberId,
      ledger.paymentScope({ network: environment.network, mint: environment.asset.mint, buyer: buyer.address }, 'live_mainnet'));
    expect(result.decision.decision).toBe('APPROVED');
    expect(result.status).toBe('APPROVED');
    expect(ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet', second.resourceId)?.grantId)
      .not.toBe(authority?.grantId);
    expect(() => requestForPurchase(definition, { requestId: 'unsafe', resourceId: definition.resourceId,
      reason: 'synthetic check', request: { jsonBody: { undeclared: true } } })).toThrow('RESOURCE_REQUEST_INPUT_UNSUPPORTED');
    ledger.close();
    const reopened = new PurchaseLedger(path, { managed: true, requireRegisteredResource: true, requireSpendGrant: true, mode: 'live_mainnet' });
    try {
      expect(reopened.getOwned('unknown-post-1', principal.cardMemberId)?.status).toBe('APPROVED');
      expect(reopened.resources.inspect(definition.resourceId).state).toBe('ACTIVE');
      expect(reopened.spendGrantSummaries(now, 'live_mainnet', principal.cardMemberId).filter(grant => grant.status === 'ACTIVE')).toHaveLength(2);
      reopened.revokeActiveSpendGrant(now, 'grant.REVOKED', principal.cardMemberId, second.resourceId);
      expect(reopened.spendGrantSummary(now, 'live_mainnet', principal.cardMemberId, definition.resourceId)?.status).toBe('ACTIVE');
      expect(reopened.spendGrantSummary(now, 'live_mainnet', principal.cardMemberId, second.resourceId)?.status).toBe('REVOKED');
    } finally { reopened.close(); }
  } finally { try { ledger.close(); } catch { /* Already closed before reopen. */ } rmSync(directory, { recursive: true, force: true }); }
});
