import { randomUUID } from 'node:crypto';
import { address, type TransactionSigner } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePaymentEnvironment, DEVNET_GENESIS, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { purchaseSigningAuthorization } from '../../src/modules/purchases/purchase-signing-authorization';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import type { X402Resource } from '../../src/modules/resources/http-resource';

const sdk = vi.hoisted(() => ({ constructor: vi.fn(), createPaymentPayload: vi.fn() }));
vi.mock('@x402/svm/exact/client', () => ({ ExactSvmScheme: class {
  readonly scheme = 'exact';
  constructor(...args: unknown[]) { sdk.constructor(...args); }
  createPaymentPayload(...args: unknown[]) { return sdk.createPaymentPayload(...args); }
} }));
vi.mock('@solana/kit', async original => ({ ...await original<typeof import('@solana/kit')>(),
  getBase64EncodedWireTransaction: vi.fn(() => 'unsigned-fixture') }));
vi.mock('../../src/modules/payment/original-payment-evidence', async original => ({
  ...await original<typeof import('../../src/modules/payment/original-payment-evidence')>(), assertUnsignedPaymentBindings: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1' });
  const buyer = '11111111111111111111111111111111'; const recipient = TOKEN_PROGRAM;
  const sponsor = 'ComputeBudget111111111111111111111111111111';
  const resource: X402Resource = { resourceId: 'registered', providerId: 'provider', network: environment.network, mint: environment.asset.mint,
    decimals: 6, recipient, request: { url: 'https://api.provider.example/v1/data', method: 'GET', access: 'https', headers: {} } };
  const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer, merchant: recipient,
    facilitatorUrl: 'https://facilitator.example', registeredResources: [resource] };
  const ledger = new PurchaseLedger(':memory:', { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  const now = Date.now();
  ledger.setDailyLimit('100000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
  ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: now + 3600_000 }, principal,
    { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
      network: environment.network, assetId: config.mint, assetDecimals: 6, payTo: recipient, paymentScheme: 'exact' }, now, 'live_mainnet');
  const challenge = { x402Version: 2 as const, resource: { url: resource.request.url }, accepts: [{ scheme: 'exact', network: config.network,
    asset: config.mint, amount: '10000', payTo: recipient, maxTimeoutSeconds: 300, extra: { feePayer: sponsor } }] };
  const authority = ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet');
  const intent = createX402SpendIntent({ idempotencyKey: 'signing', resource, challenge, environment, buyer, authority, now });
  const record = ledger.reserve(intent, challenge.accepts[0], now, 'live_mainnet', principal.cardMemberId, ledger.paymentScope(config, 'live_mainnet'));
  ledger.claim(record.approvalId, now, undefined, 'live_mainnet');
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { owner, mint: config.mint,
    state: 'initialized', tokenAmount: { amount: '10000', decimals: 6 } } } } });
  const mint = { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } };
  const buyerAccount = token(buyer); const merchantAccount = token(recipient);
  const state = { genesis: environment.genesisHash, mint, buyerAccount, merchantAccount, feePayer: sponsor, feeBalance: 100_000,
    network: environment.network, simulationError: null as unknown, beforeSimulationResponse: () => {} };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/supported')) return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: state.network, extra: { feePayer: state.feePayer } }] });
    expect(String(url)).toBe(config.rpcUrl);
    const request = JSON.parse(String(init?.body));
    const results: Record<string, unknown> = { getGenesisHash: state.genesis,
      getMultipleAccounts: { value: [state.mint, state.buyerAccount, state.merchantAccount] }, getBalance: { value: state.feeBalance },
      simulateTransaction: { value: { err: state.simulationError } } };
    if (!(request.method in results)) throw new Error('Unexpected RPC');
    if (request.method === 'simulateTransaction') state.beforeSimulationResponse();
    return Response.json({ result: results[request.method] });
  });
  vi.stubGlobal('fetch', fetcher);
  const signTransactions = vi.fn().mockResolvedValue([{}]);
  const signer: TransactionSigner = { address: address(buyer), signTransactions };
  sdk.createPaymentPayload.mockImplementation(async () => {
    const guardedSigner = sdk.constructor.mock.lastCall![0];
    await guardedSigner.signTransactions([{ messageBytes: new Uint8Array(), signatures: {},
      lifetimeConstraint: { blockhash: buyer, lastValidBlockHeight: 12345n } }]);
    return { x402Version: 2, payload: { transaction: 'fixture' } };
  });
  const sign = (selected = config) => prepareSolanaPayment(selected, signer, challenge.accepts[0], () => {},
    { amount: '10000', resource: resource.request.url, challenge }, () => {}, purchaseSigningAuthorization(ledger, record.approvalId, selected, resource.request.url));
  return { config, ledger, state, signer, signTransactions, fetcher, record, sign, challenge, resource };
}

it('requires a reserved backend approval even when production is enabled; direct payment-only calls cannot sign', async () => {
  const f = fixture();
  try {
    await expect(prepareSolanaPayment(f.config, f.signer, f.challenge.accepts[0])).rejects.toThrow('MAINNET_RESERVED_APPROVAL_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(sdk.constructor).not.toHaveBeenCalled(); expect(f.signTransactions).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['genesis', 'mint-program', 'mint-decimals', 'buyer-mint', 'buyer-state', 'buyer-balance', 'recipient', 'sponsor-network', 'sponsor', 'sponsor-balance', 'simulation'])(
  'stops Mainnet before the underlying signer when %s is wrong', async condition => {
    const f = fixture();
    try {
      if (condition === 'genesis') f.state.genesis = DEVNET_GENESIS;
      if (condition === 'mint-program') f.state.mint.owner = f.config.buyer;
      if (condition === 'mint-decimals') f.state.mint.data.parsed.info.decimals = 9;
      if (condition === 'buyer-mint') f.state.buyerAccount.data.parsed.info.mint = f.config.buyer;
      if (condition === 'buyer-state') f.state.buyerAccount.data.parsed.info.state = 'frozen';
      if (condition === 'buyer-balance') f.state.buyerAccount.data.parsed.info.tokenAmount.amount = '9999';
      if (condition === 'recipient') f.state.merchantAccount.data.parsed.info.owner = f.config.buyer;
      if (condition === 'sponsor-network') f.state.network = resolvePaymentEnvironment({}, 'live_devnet').network;
      if (condition === 'sponsor') f.state.feePayer = f.config.buyer;
      if (condition === 'sponsor-balance') f.state.feeBalance = 1;
      if (condition === 'simulation') f.state.simulationError = { InstructionError: [1, 'InsufficientFunds'] };
      await expect(f.sign()).rejects.toThrow();
      expect(f.signTransactions).not.toHaveBeenCalled();
      expect(f.fetcher.mock.calls.every(([url]) => [f.config.rpcUrl, `${f.config.facilitatorUrl}/supported`].includes(String(url)))).toBe(true);
    } finally { f.ledger.close(); }
  });

it.each(['pause', 'limit', 'revoke', 'quit'])( 'rechecks authority after simulation immediately before signing: %s', async condition => {
  const f = fixture();
  try {
    f.state.beforeSimulationResponse = () => {
      if (condition === 'pause') f.ledger.setPaused(true, 'live_mainnet');
      if (condition === 'limit') f.ledger.setDailyLimit('9999', 'live_mainnet');
      if (condition === 'revoke') f.ledger.revokeActiveSpendGrant();
      if (condition === 'quit') f.ledger.stopPayments();
    };
    await expect(f.sign()).rejects.toThrow();
    expect(f.signTransactions).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it('requires the exact reserved quote at the SDK boundary and checks signer identity before SDK invocation', async () => {
  const f = fixture();
  try {
    await expect(prepareSolanaPayment(f.config, f.signer, { ...f.challenge.accepts[0], amount: '10001' }, () => {},
      { amount: '10001', resource: f.resource.request.url, challenge: f.challenge }, () => {},
      purchaseSigningAuthorization(f.ledger, f.record.approvalId, f.config, f.resource.request.url))).rejects.toThrow('MAINNET_PAYMENT_BINDING_MISMATCH');
    const signer: TransactionSigner = { address: address(f.config.merchant), signTransactions: f.signTransactions };
    await expect(prepareSolanaPayment(f.config, signer, f.challenge.accepts[0], () => {},
      { amount: '10000', resource: f.resource.request.url, challenge: f.challenge }, () => {},
      purchaseSigningAuthorization(f.ledger, f.record.approvalId, f.config, f.resource.request.url))).rejects.toThrow('matching the configured buyer');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(sdk.constructor).not.toHaveBeenCalled(); expect(f.signTransactions).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it.each(['resource', 'challenge', 'approval'])(
  'the purchase authorization capability rejects a different reserved %s before RPC or signing', async binding => {
    const f = fixture();
    try {
      const authorized = { amount: '10000', resource: f.resource.request.url, challenge: f.challenge };
      if (binding === 'resource') authorized.resource += '?different=1';
      if (binding === 'challenge') authorized.challenge = { ...f.challenge, resource: { url: `${f.resource.request.url}/different` } };
      const approvalId = binding === 'approval' ? randomUUID() : f.record.approvalId;
      await expect(prepareSolanaPayment(f.config, f.signer, f.challenge.accepts[0], () => {}, authorized, () => {},
        purchaseSigningAuthorization(f.ledger, approvalId, f.config, f.resource.request.url))).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled(); expect(sdk.constructor).not.toHaveBeenCalled(); expect(f.signTransactions).not.toHaveBeenCalled();
    } finally { f.ledger.close(); }
  });

it('rechecks the purchase resource policy after simulation through the supplied capability', async () => {
  const f = fixture();
  try {
    f.state.beforeSimulationResponse = () => { f.resource.recipient = f.config.buyer; };
    await expect(f.sign()).rejects.toThrow('MAINNET_RESOURCE_BINDING_MISMATCH');
    expect(f.signTransactions).not.toHaveBeenCalled();
  } finally { f.ledger.close(); }
});

it('valid Mainnet preflight and simulation permit one fixture signature with the selected Mainnet RPC and sponsored fees', async () => {
  const f = fixture();
  try {
    await f.sign();
    expect(sdk.constructor).toHaveBeenCalledExactlyOnceWith(expect.anything(), { rpcUrl: f.config.rpcUrl });
    expect(f.signTransactions).toHaveBeenCalledOnce();
    const methods = f.fetcher.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init?.body)).method);
    expect(methods).toEqual(['getGenesisHash', 'getMultipleAccounts', 'getBalance', 'simulateTransaction']);
  } finally { f.ledger.close(); }
});
