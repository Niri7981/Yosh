import { expect, it } from 'vitest';
import { inspectPayMainnetQuote, MAINNET_REFERENCE_API } from '../../src/modules/payment/pay-mainnet-preflight';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';

// Reduced public terms observed on 2026-10-20. This fixture is not a live quote
// or permission to pay; live-preflight.json records the separate live probe.
const quote = () => ({ x402Version: 2, resource: { url: 'https://agent402.tools/api/crypto-price' },
  accepts: [{ scheme: 'exact', network: MAINNET_NETWORK, asset: MAINNET_USDC_MINT, amount: '1000',
    payTo: 'J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg', maxTimeoutSeconds: 300,
    extra: { feePayer: 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP' } }],
  extensions: { bazaar: {}, 'builder-code': {}, 'payment-identifier': { info: { required: false } } } });

it('binds the real route-level resource and extensions without replacing the exact request or mutating the quote', () => {
  const raw = quote(), original = JSON.stringify(raw);
  const result = inspectPayMainnetQuote(raw);
  expect(result).toMatchObject({ yoshQuoteCompatible: true, controlledEnvelopeCompatible: true,
    network: MAINNET_NETWORK, asset: MAINNET_USDC_MINT, amountAtomic: '1000', executionEnabled: false,
    paymentSent: false, signerUsed: false });
  expect(result.blockers).toEqual([]);
  expect(result.requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.requestQuoteBindingHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.remainingExecutionGates).toContain('USER_PAYMENT_CONFIRMATION_REQUIRED');
  expect(JSON.stringify(raw)).toBe(original);
});

it('keeps query parameters and the complete merchant envelope in separate immutable binding facts', () => {
  const raw = quote();
  const first = inspectPayMainnetQuote(raw);
  const otherRequest = inspectPayMainnetQuote(raw, MAINNET_REFERENCE_API.replace('currency=usd', 'currency=eur'));
  expect(otherRequest.quoteHash).toBe(first.quoteHash);
  expect(otherRequest.challengeHash).toBe(first.challengeHash);
  expect(otherRequest.requestHash).not.toBe(first.requestHash);
  expect(otherRequest.requestQuoteBindingHash).not.toBe(first.requestQuoteBindingHash);
  const metadataChange = { ...raw, extensions: { ...raw.extensions, 'builder-code': { info: { a: 'different' } } } };
  const changed = inspectPayMainnetQuote(metadataChange);
  expect(changed.quoteHash).toBe(first.quoteHash);
  expect(changed.challengeHash).not.toBe(first.challengeHash);
  expect(changed.requestQuoteBindingHash).not.toBe(first.requestQuoteBindingHash);
});

it.each(['https://other.example/api/crypto-price', 'https://agent402.tools/api/crypto-price/other',
  'https://agent402.tools/api/crypto-price?currency=eur'])('rejects a merchant resource that cannot identify the exact approved route: %s', url => {
  expect(() => inspectPayMainnetQuote({ ...quote(), resource: { url } })).toThrow();
});

it('retains the required-payment-identifier gate instead of silently inventing an unbound identifier', () => {
  const raw = { ...quote(), extensions: { 'payment-identifier': { info: { required: true } } } };
  const result = inspectPayMainnetQuote(raw);
  expect(result.controlledEnvelopeCompatible).toBe(false);
  expect(result.blockers).toEqual(['PAY_CONTROLLED_REQUIRED_PAYMENT_IDENTIFIER_UNSUPPORTED']);
});

it.each([null, {}, { info: null }, { info: { required: 'false' } },
  { info: { required: false, unparsed: 'metadata' } }])('rejects extension shapes that the pinned SDK would reject or normalize: %j', identifier => {
  const result = inspectPayMainnetQuote({ ...quote(), extensions: { 'payment-identifier': identifier } });
  expect(result.controlledEnvelopeCompatible).toBe(false);
  expect(result.blockers).toEqual(['PAY_CONTROLLED_EXTENSIONS_INVALID']);
});

it.each(['amount', 'asset', 'network', 'feePayer'] as const)('rejects incompatible %s before any wallet or execution dependency exists', field => {
  const raw = quote();
  if (field === 'feePayer') raw.accepts[0].extra.feePayer = 'not-a-key';
  else raw.accepts[0][field] = field === 'amount' ? '1001' : 'unsupported';
  expect(() => inspectPayMainnetQuote(raw)).toThrow();
});

it('does not confuse a compatible envelope with permission or readiness to execute real funds', () => {
  const raw = { ...quote(), resource: { url: MAINNET_REFERENCE_API }, extensions: undefined };
  const result = inspectPayMainnetQuote(raw);
  expect(result.controlledEnvelopeCompatible).toBe(true);
  expect(result.executionEnabled).toBe(false);
  expect(result.remainingExecutionGates).toContain('CONTROLLED_KEYCHAIN_SIGNER_NOT_WIRED');
});
