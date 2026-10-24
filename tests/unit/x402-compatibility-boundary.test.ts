import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolvePaymentEnvironment } from '../../src/modules/payment/payment-environment';
import { readPaymentRequiredHeader, readSettlementResponse } from '../../src/modules/payment/x402-client';
import { validateResourceChallenge } from '../../src/modules/payment/resource-challenge';
import { assertAuthorizedRequestInstance, type X402Resource } from '../../src/modules/resources/http-resource';
import { requestForPurchase } from '../../src/modules/purchases/request-registered-resource-purchase';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { readBoundedResourceDelivery } from '../../src/modules/resources/read-market-snapshot';

const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
const agent402 = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/agent402-crypto-price-v2.json', import.meta.url)), 'utf8')) as unknown;
const agent402Header = Buffer.from(JSON.stringify(agent402)).toString('base64');
const resource: X402Resource = { resourceId: 'agent402-crypto-price', providerId: 'agent402.tools',
  network: environment.network, mint: environment.asset.mint, decimals: 6, recipientSource: 'live_challenge',
  maximumAmount: '5000', request: { url: 'https://agent402.tools/api/crypto-price?coins=BTC%2CETH%2CSOL&currency=usd',
    method: 'GET', access: 'https', headers: { accept: 'application/json' } } };

it('preserves informational outputSchema in every raw v2 offer instead of dropping authorized evidence through SDK projection', () => {
  const original = readPaymentRequiredHeader(agent402Header);
  const outputSchema = { type: 'object', properties: { price: { type: 'number' } } };
  const raw = { ...original, accepts: original.accepts.map(offer => ({ ...offer, outputSchema })) };
  const header = Buffer.from(JSON.stringify(raw)).toString('base64');
  expect(readPaymentRequiredHeader(header).accepts[0]).not.toHaveProperty('outputSchema');
  const challenge = readPaymentRequiredHeader(header, true);
  expect(challenge.accepts[0]).toMatchObject({ outputSchema });
  expect(validateResourceChallenge(challenge, resource, environment).quote).toMatchObject({ outputSchema });
});

it('accepts the real 13-option Agent402 V2 challenge with Solana at position 11 and retains wire evidence', () => {
  const header = agent402Header;
  const challenge = readPaymentRequiredHeader(header);
  expect(challenge.accepts).toHaveLength(13);
  expect(challenge.accepts[10].network).toBe(environment.network);
  const selected = validateResourceChallenge(challenge, resource, environment);
  expect(selected.challenge.accepts).toHaveLength(13);
  expect(selected.quote).toEqual(challenge.accepts[10]);
  expect(selected.quote.amount).toBe('1000');
  const intent = createX402SpendIntent({ idempotencyKey: 'agent402-fixture', resource, challenge,
    environment, buyer: 'Hr937hUNE1yHzjDLhZngWn8rHUWGTuTRLMJoTzi9BUeH', paymentRequiredHeader: header });
  expect(intent.paymentRequiredHeader).toBe(header);
  expect(intent.x402Challenge?.accepts).toHaveLength(13);
});

it('selects only implemented Solana USDC authorization and rejects unsupported flows or methods', () => {
  const original = readPaymentRequiredHeader(agent402Header);
  const unsupported = { ...original, accepts: [{ ...original.accepts[10], extra: { ...original.accepts[10].extra, paymentFlow: 'upfront' } }] };
  expect(() => validateResourceChallenge(unsupported, resource, environment)).toThrow('INVALID_X402_QUOTE');
  const transfer = { ...original, accepts: [{ ...original.accepts[10], extra: { ...original.accepts[10].extra, assetTransferMethod: 'permit2' } }] };
  expect(() => validateResourceChallenge(transfer, resource, environment)).toThrow('INVALID_X402_QUOTE');
  const mixed = { ...original, accepts: [...original.accepts, unsupported.accepts[0]] };
  expect(validateResourceChallenge(mixed, resource, environment).quote).toEqual(original.accepts[10]);
  const defaultFlow = { ...original, accepts: [{ ...original.accepts[10],
    extra: { ...original.accepts[10].extra, paymentFlow: null, assetTransferMethod: null } }] };
  expect(validateResourceChallenge(defaultFlow, resource, environment).quote.extra.paymentFlow).toBeNull();
});

it('binds approved dynamic GET query and POST JSON request instances without merchant names', () => {
  const getResource: X402Resource = { ...resource, request: { ...resource.request, url: 'https://api.example.com/v1/search?fixed=1' },
    requestInputs: { query: ['query', 'page'] } };
  const get = requestForPurchase(getResource, { requestId: 'get', resourceId: getResource.resourceId, reason: 'lookup',
    request: { query: { query: 'solana', page: '2' } } });
  expect(get.request.url).toBe('https://api.example.com/v1/search?fixed=1&page=2&query=solana');
  expect(assertAuthorizedRequestInstance(getResource, get.request)).toEqual(get.request);
  expect(() => assertAuthorizedRequestInstance(getResource, { ...get.request, url: get.request.url.replace('fixed=1', 'fixed=2') })).toThrow();
  expect(() => requestForPurchase(getResource, { requestId: 'get', resourceId: getResource.resourceId, reason: 'lookup',
    request: { query: { unapproved: 'x' } } })).toThrow('RESOURCE_REQUEST_INPUT_UNSUPPORTED');
  const postResource: X402Resource = { ...resource, request: { url: 'https://api.example.com/v1/search', method: 'POST', access: 'https',
    headers: { 'content-type': 'application/json', accept: 'application/json' } }, requestInputs: { jsonBody: ['query'] } };
  const post = requestForPurchase(postResource, { requestId: 'post', resourceId: postResource.resourceId, reason: 'lookup',
    request: { jsonBody: { query: 'solana' } } });
  expect(assertAuthorizedRequestInstance(postResource, post.request)).toEqual(post.request);
  expect(() => assertAuthorizedRequestInstance(postResource, { ...post.request, body: '{"query":"changed"', method: 'GET' })).toThrow();
  expect(() => assertAuthorizedRequestInstance(postResource, { ...post.request, headers: { accept: 'text/plain' } })).toThrow();
});

it('allows the You.com 600-second authorization window and binds expiry to the same quote', () => {
  const you: X402Resource = { ...resource, request: { url: 'https://api.you.com/v1/search?query=solana', method: 'GET', access: 'https', headers: {} },
    requestInputs: { query: ['query'] } };
  const original = readPaymentRequiredHeader(agent402Header);
  const quote = { ...original, resource: { url: 'https://api.you.com/v1/search' },
    accepts: [{ ...original.accepts[10], maxTimeoutSeconds: 600 }] };
  expect(validateResourceChallenge(quote, you, environment).quote.maxTimeoutSeconds).toBe(600);
  const intent = createX402SpendIntent({ idempotencyKey: 'you-600', resource: you, challenge: quote,
    environment, buyer: 'Hr937hUNE1yHzjDLhZngWn8rHUWGTuTRLMJoTzi9BUeH', now: 1_000_000 });
  expect(intent.expiresAt).toBe(1_600_000);
});

it('accepts optional SDK receipt extensions but still enforces settlement identity', () => {
  const selected = readPaymentRequiredHeader(agent402Header).accepts[10];
  const raw = { success: true, network: environment.network, payer: selected.payTo,
    transaction: '4'.repeat(88), extensionResponses: { bazaar: { mode: 'test' } } };
  const response = new Response('{}', { headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(raw)).toString('base64') } });
  expect(readSettlementResponse(response, { network: environment.network, payer: selected.payTo, amount: selected.amount }).extensionResponses).toEqual(raw.extensionResponses);
  expect(() => readSettlementResponse(response, { network: environment.network, payer: resource.request.url, amount: selected.amount })).toThrow();
});

it('delivers bounded arrays, scalars and declared text while rejecting undeclared MIME and excess bytes', async () => {
  expect(await readBoundedResourceDelivery(new Response('[1,2]', { headers: { 'content-type': 'application/json' } }))).toEqual([1, 2]);
  expect(await readBoundedResourceDelivery(new Response('plain', { headers: { 'content-type': 'text/plain' } }),
    { format: 'text', mimeTypes: ['text/plain'], maxBytes: 20 })).toBe('plain');
  await expect(readBoundedResourceDelivery(new Response('plain', { headers: { 'content-type': 'text/plain' } }))).rejects.toThrow();
  await expect(readBoundedResourceDelivery(new Response('long', { headers: { 'content-type': 'text/plain' } }),
    { format: 'text', mimeTypes: ['text/plain'], maxBytes: 3 })).rejects.toThrow();
});

it('accepts the byte-policy boundary and rejects oversized delivery without truncation', async () => {
  const policy = { format: 'json' as const, mimeTypes: ['application/json'], maxBytes: 262_144 };
  for (const bytes of [65_535, 65_536, 65_537, 262_144]) {
    const wire = JSON.stringify('x'.repeat(bytes - 2));
    expect(Buffer.byteLength(wire)).toBe(bytes);
    const data = await readBoundedResourceDelivery(new Response(wire, {
      headers: { 'content-type': 'application/json' },
    }), policy);
    expect(data).toBe('x'.repeat(bytes - 2));
  }
  const oversized = JSON.stringify('x'.repeat(262_143));
  expect(Buffer.byteLength(oversized)).toBe(262_145);
  await expect(readBoundedResourceDelivery(new Response(oversized, {
    headers: { 'content-type': 'application/json' },
  }), policy)).rejects.toThrow('Resource data too large');
});
