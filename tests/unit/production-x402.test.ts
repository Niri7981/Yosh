import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePaymentEnvironment, DEVNET_NETWORK, DEVNET_USDC_MINT } from '../../src/modules/payment/payment-environment';
import { fetchResourceChallenge, validateResourceChallenge } from '../../src/modules/payment/resource-challenge';
import { readPaymentRequiredHeader, readSettlementResponse, readSettlementTransactionHint } from '../../src/modules/payment/x402-client';
import { HttpResourceRequestSchema, X402ResourceSchema, type X402Resource } from '../../src/modules/resources/http-resource';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { checkPaymentBinding, executeApprovedPayment } from '../../src/modules/purchases/approved-payment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { reconcileStoredOriginalPayment } from '../../src/modules/payment/reconcile-transaction';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { signedPaymentFixture, FIXTURE_TRANSACTION_SIGNATURE } from '../helpers/signed-payment-fixture';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/solana-payment', async original => ({
  ...await original<typeof import('../../src/modules/payment/solana-payment')>(), prepareSolanaPayment: vi.fn(),
}));
vi.mock('../../src/modules/payment/reconcile-transaction', async original => ({
  ...await original<typeof import('../../src/modules/payment/reconcile-transaction')>(), reconcileStoredOriginalPayment: vi.fn(),
}));

const mainnet = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
const recipient = '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
const buyer = 'Hr937hUNE1yHzjDLhZngWn8rHUWGTuTRLMJoTzi9BUeH';
const feePayer = 'ComputeBudget111111111111111111111111111111';
const resource: X402Resource = { resourceId: 'registered-data', providerId: 'registered-provider', recipient,
  network: mainnet.network, mint: mainnet.asset.mint, decimals: 6,
  request: { url: 'https://api.provider.example/v1/data?asset=SOL', method: 'POST', access: 'https',
    headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{"asset":"SOL"}' } };
function challenge(memo?: string) {
  return { x402Version: 2 as const, resource: { url: resource.request.url, mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: mainnet.network, asset: mainnet.asset.mint, payTo: recipient,
      amount: '10000', maxTimeoutSeconds: 300, extra: { feePayer, ...(memo === undefined ? {} : { memo }) } }],
    extensions: { bazaar: { info: { input: { type: 'http', method: 'POST' } } },
      'builder-code': { info: { code: 'approved-reference' } } } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('fetches one external HTTPS challenge using the exact declared method, body and headers', async () => {
  const required = challenge();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } }));
  const result = await fetchResourceChallenge(resource, mainnet, fetcher);
  expect(result.challenge).toEqual(required);
  expect(result.quote).toEqual(required.accepts[0]);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(resource.request.url, expect.objectContaining({
    method: 'POST', body: resource.request.body, headers: resource.request.headers, redirect: 'error' }));
  expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(prepareSolanaPayment).not.toHaveBeenCalled();
});

it.each(['https://other.provider.example/v1/data?asset=SOL', 'https://api.provider.example/v2/data?asset=SOL',
  'https://api.provider.example/v1/data?asset=BTC', '/v1/data?asset=SOL'])('rejects a challenge for a different origin/path/query or relative production URL %s', url => {
  const required = challenge(); required.resource.url = url;
  expect(() => validateResourceChallenge(required, resource, mainnet)).toThrow('INVALID_X402_QUOTE');
});
it('rejects a challenge extension declaring the wrong HTTP method', () => {
  const required = challenge(); required.extensions.bazaar.info.input.method = 'GET';
  expect(() => validateResourceChallenge(required, resource, mainnet)).toThrow('RESOURCE_METHOD_MISMATCH');
});

it.each([{ network: DEVNET_NETWORK }, { network: 'solana:mainnet' }, { asset: DEVNET_USDC_MINT },
  { payTo: buyer }, { amount: '1.5' }, { amount: '9223372036854775808' }, { amount: '010000' },
  { scheme: 'upto' }, { maxTimeoutSeconds: 601 }, { maxTimeoutSeconds: 1.5 }])('rejects unsupported/changed production payment facts %j', change => {
  const required = challenge();
  expect(() => validateResourceChallenge({ ...required, accepts: [{ ...required.accepts[0], ...change }] }, resource, mainnet)).toThrow('INVALID_X402_QUOTE');
});

it.each([undefined, 'provider-issued-reference', '任意有效 memo', 'x'.repeat(256)])('accepts absent or arbitrary valid memo %s', memo => {
  expect(validateResourceChallenge(challenge(memo), resource, mainnet).quote.extra.memo).toBe(memo);
});
it.each(['', 'x'.repeat(257), '界'.repeat(86), '\ud800'])('rejects invalid or oversized UTF-8 memo', memo => {
  expect(() => validateResourceChallenge(challenge(memo), resource, mainnet)).toThrow('INVALID_X402_QUOTE');
});
it('preserves relevant extensions through decoding, intent creation and persisted restart', () => {
  const required = challenge('production-memo');
  const decoded = readPaymentRequiredHeader(encodePaymentRequiredHeader(required));
  const intent = createX402SpendIntent({ idempotencyKey: 'production-approval', resource, challenge: decoded, environment: mainnet, buyer });
  expect(intent.httpRequest).toEqual(resource.request);
  expect(intent.x402Challenge?.extensions).toEqual(required.extensions);
  const ledger = new PurchaseLedger(':memory:');
  try {
    expect(() => ledger.reserve(intent, decoded.accepts[0], Date.now(), 'live_mainnet')).toThrow('MAINNET_AUTHORITY_REQUIRED');
    expect(ledger.getForAdministration('production-approval')).toBeUndefined();
  } finally { ledger.close(); }
});

it.each(['http://api.provider.example/v1/data', 'https://localhost/v1/data', 'https://127.0.0.1/v1/data',
  'https://user:password@api.provider.example/v1/data', 'https://api.provider.example/v1/data#fragment'])('rejects unsafe production resource URL %s', url => {
  expect(HttpResourceRequestSchema.safeParse({ ...resource.request, url }).success).toBe(false);
});
it('rejects omitted recipient, test-loopback production resource and wrong configured environment before any request', async () => {
  const { recipient: _recipient, ...missing } = resource;
  expect(_recipient).toBe(recipient);
  expect(X402ResourceSchema.safeParse(missing).success).toBe(false);
  const fetcher = vi.fn<typeof fetch>();
  await expect(fetchResourceChallenge({ ...resource, request: { ...resource.request, access: 'test_loopback', url: 'http://127.0.0.1:3049/v1/data' } }, mainnet, fetcher)).rejects.toThrow();
  await expect(fetchResourceChallenge({ ...resource, mint: DEVNET_USDC_MINT }, mainnet, fetcher)).rejects.toThrow();
  await expect(fetchResourceChallenge(resource, { ...mainnet, network: DEVNET_NETWORK }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['not-base64', Buffer.from('{}').toString('base64'), Buffer.from(JSON.stringify({ ...challenge(), x402Version: 1 })).toString('base64')])('rejects malformed/unsupported protocol challenge', encoded => {
  expect(() => readPaymentRequiredHeader(encoded)).toThrow();
});
it('rejects ambiguous multiple payment alternatives', () => {
  const required = challenge(); required.accepts.push(required.accepts[0]);
  expect(() => validateResourceChallenge(required, resource, mainnet)).toThrow('INVALID_X402_QUOTE');
});

it.each(['price', 'metadata'] as const)('binds the explicit selected offer among %s alternatives without discarding the envelope', difference => {
  const required = challenge(); const first = required.accepts[0];
  const selected = { ...first, ...(difference === 'price' ? { amount: '9000' } : { extra: { ...first.extra, memo: 'selected-memo' } }) };
  required.accepts.push(selected);
  const parsed = validateResourceChallenge(required, resource, mainnet, selected);
  expect(parsed).toEqual({ challenge: required, quote: selected });
  const intent = createX402SpendIntent({ idempotencyKey: `selected-${difference}`, resource, challenge: required, environment: mainnet, buyer, selectedQuote: selected });
  expect(intent).toMatchObject({ amount: selected.amount, x402Challenge: required });
  expect(() => validateResourceChallenge(required, resource, mainnet)).toThrow('INVALID_X402_QUOTE');
  expect(() => validateResourceChallenge(required, resource, mainnet, { ...selected, amount: '8000' })).toThrow('INVALID_X402_QUOTE');
  expect(() => validateResourceChallenge({ ...required, accepts: [...required.accepts, selected] }, resource, mainnet, selected)).toThrow('INVALID_X402_QUOTE');
  expect(() => validateResourceChallenge({ ...required, accepts: [...required.accepts, { ...selected, network: DEVNET_NETWORK }] },
    resource, mainnet, { ...selected, network: DEVNET_NETWORK })).toThrow('INVALID_X402_QUOTE');
});

const receipt = { success: true, network: mainnet.network, payer: buyer, transaction: FIXTURE_TRANSACTION_SIGNATURE, amount: '10000' };
function settlement(raw: unknown) { return new Response(null, { headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(raw)).toString('base64') } }); }
it('decodes an exact Solana settlement receipt through the SDK and validates authoritative bindings', () => {
  expect(readSettlementResponse(settlement(receipt), { network: mainnet.network, payer: buyer, amount: '10000', transaction: receipt.transaction })).toEqual(receipt);
});
it.each([{ success: 'true' }, { payer: undefined }, { transaction: 'not-a-signature' }, { amount: 10000 },
  { amount: '0.01' }, { amount: '9223372036854775808' }, { network: 'eip155:8453' }, { errorReason: 'failure' }, { unknown: true }])('rejects malformed/unsupported settlement receipt %j', change => {
  expect(() => readSettlementResponse(settlement({ ...receipt, ...change }))).toThrow();
});
it.each([{ network: DEVNET_NETWORK }, { payer: recipient }, { amount: '10001' }])('rejects a validly encoded receipt for the wrong approved facts %j', change => {
  expect(() => readSettlementResponse(settlement({ ...receipt, ...change }), { network: mainnet.network, payer: buyer, amount: '10000' })).toThrow('SETTLEMENT_RECEIPT_BINDING_MISMATCH');
});

it('retains a signature observation from an unusable receipt without accepting it as settlement evidence', () => {
  const response = settlement({ ...receipt, amount: 10000, payer: undefined });
  expect(() => readSettlementResponse(response)).toThrow();
  expect(readSettlementTransactionHint(response)).toBe(FIXTURE_TRANSACTION_SIGNATURE);
});

it('uses the same existing executor for declarative external Devnet facts, preserves actual memo and never falls back to config merchant', async () => {
  const signer = await generateKeyPairSigner(); const fee = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({}, 'live_devnet');
  const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer: signer.address,
    merchant: buyer, facilitatorUrl: 'https://facilitator.example' };
  const declared: X402Resource = { ...resource, network: config.network, mint: config.mint };
  const required = { ...challenge(), accepts: [{ ...challenge().accepts[0], network: config.network, asset: config.mint, extra: { feePayer: fee.address } }] };
  const intent = createX402SpendIntent({ idempotencyKey: 'external-devnet', resource: declared, challenge: required, environment, buyer: signer.address });
  const directory = mkdtempSync(join(tmpdir(), 'yosh-http-binding-')); const path = join(directory, 'ledger.sqlite');
  const ledger = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: signer.address }); let closed = false;
  try {
    const record = ledger.reserve(intent, required.accepts[0]);
    const simulated = resolvePaymentEnvironment({}, 'simulated');
    expect(() => checkPaymentBinding(record, { ...config, ...simulated }, declared.request.url)).not.toThrow();
    expect(() => checkPaymentBinding({ ...record, intent: { ...intent, paymentScheme: 'unsupported' } }, config, declared.request.url)).toThrow('Approval binding changed');
    vi.mocked(loadBuyerSigner).mockResolvedValue(signer);
    vi.mocked(prepareSolanaPayment).mockImplementation(async (signedConfig, _signer, quote, beforeSign, authorized) => {
      beforeSign?.();
      expect(signedConfig.merchant).toBe(recipient); expect(authorized?.challenge).toEqual(required);
      return { ...await signedPaymentFixture(signer, signedConfig, quote), resource: required.resource, extensions: required.extensions };
    });
    vi.mocked(reconcileStoredOriginalPayment).mockResolvedValue({ status: 'CONFIRMED', transaction: FIXTURE_TRANSACTION_SIGNATURE, confirmationStatus: 'confirmed' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":"fixture"}', { headers: {
      'content-type': 'application/json', 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ ...receipt, network: config.network, payer: signer.address }) } }));
    vi.stubGlobal('fetch', fetcher);
    for (const changed of [{ ...declared.request, method: 'GET' as const, body: undefined },
      { ...declared.request, body: '{"asset":"BTC"}' }, { ...declared.request, headers: { accept: 'text/plain' } }]) {
      expect(() => checkPaymentBinding({ ...record, intent: { ...intent, httpRequest: changed } }, config, declared.request.url)).toThrow();
    }
    expect(() => checkPaymentBinding(record, config, 'https://other.provider.example/v1/data')).toThrow('Approval binding changed');
    await executeApprovedPayment(ledger, record.approvalId, config, declared.request.url);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(declared.request.url, expect.objectContaining({ method: 'POST', body: declared.request.body,
      headers: expect.objectContaining(declared.request.headers) }));
    expect(ledger.getForAdministration('external-devnet')).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: { data: 'fixture' } });
    expect(ledger.savedOriginalPayment(record.approvalId)?.evidence.identity.actualMemo).toBe('fixture-random-sdk-memo');
    const database = new DatabaseSync(path);
    expect(() => database.prepare('UPDATE purchases SET purchase=? WHERE id=?').run(JSON.stringify({ ...intent, httpRequest: { ...intent.httpRequest, body: 'changed' } }), intent.id))
      .toThrow('approved HTTP request/challenge is immutable');
    database.close();
    ledger.close(); closed = true;
    const reopened = new PurchaseLedger(path, { mode: 'live_devnet', walletIdentity: signer.address });
    try { expect(reopened.getForAdministration('external-devnet')?.intent.x402Challenge?.extensions).toEqual(required.extensions); }
    finally { reopened.close(); }
    expect(prepareSolanaPayment).toHaveBeenCalledOnce();
  } finally { if (!closed) ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
