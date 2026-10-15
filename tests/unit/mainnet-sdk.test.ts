import { randomUUID } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import { MintLayout } from '@solana/spl-token';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePaymentEnvironment, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { prepareSolanaPayment } from '../../src/modules/payment/solana-payment';
import { assertUnsignedPaymentBindings, createSignedPaymentIdentity } from '../../src/modules/payment/original-payment-evidence';
import { createX402SpendIntent } from '../../src/modules/resources/market-spend-adapter';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { purchaseSigningAuthorization } from '../../src/modules/purchases/purchase-signing-authorization';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../../src/modules/authority/spend-grant';
import type { X402Challenge, X402Resource } from '../../src/modules/resources/http-resource';

afterEach(() => vi.unstubAllGlobals());

it('the real locked official x402 SDK constructs and signs Mainnet USDC using fixture RPC only, and unsigned inspection rejects altered transfer instructions', async () => {
  const signer = await generateKeyPairSigner(); const recipient = await generateKeyPairSigner(); const sponsor = await generateKeyPairSigner();
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1', SOLANA_MAINNET_RPC_URL: 'https://rpc.fixture.example' });
  const resource: X402Resource = { resourceId: 'registered', providerId: 'provider', request: { url: 'https://provider.fixture.example/v1/data',
    method: 'GET', access: 'https', headers: {} }, network: environment.network, mint: environment.asset.mint, decimals: 6, recipient: recipient.address };
  const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer: signer.address, merchant: recipient.address,
    facilitatorUrl: 'https://facilitator.fixture.example', registeredResources: [resource] };
  const challenge: X402Challenge = { x402Version: 2, resource: { url: resource.request.url }, accepts: [
    { scheme: 'exact', network: 'eip155:8453', asset: '0x0000000000000000000000000000000000000001',
      payTo: '0x0000000000000000000000000000000000000002', amount: '10000', maxTimeoutSeconds: 300, extra: {} },
    { scheme: 'exact', network: config.network,
      asset: config.mint, payTo: recipient.address, amount: '10000', maxTimeoutSeconds: 300, extra: { feePayer: sponsor.address } }] };
  const ledger = new PurchaseLedger(':memory:', { managed: true, requireSpendGrant: true, mode: 'live_mainnet' });
  const principal = { cardMemberId: ledger.defaultCardMember().id, connectionId: randomUUID(), connectionGeneration: 1 };
  const now = Date.now();
  try {
    ledger.setDailyLimit('100000', 'live_mainnet'); ledger.setPaused(false, 'live_mainnet');
    ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '10000', expiresAt: now + 3600_000 }, principal,
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: config.network, assetId: config.mint, assetDecimals: 6, payTo: recipient.address, paymentScheme: 'exact' }, now, 'live_mainnet');
    const intent = createX402SpendIntent({ idempotencyKey: 'real-sdk-fixture', resource, challenge, environment, buyer: signer.address,
      authority: ledger.spendAuthority(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'live_mainnet'), now });
    const record = ledger.reserve(intent, challenge.accepts[1], now, 'live_mainnet', principal.cardMemberId, ledger.paymentScope(config, 'live_mainnet'));
    ledger.claim(record.approvalId, now, undefined, 'live_mainnet');
    const mintBytes = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: new PublicKey(signer.address), supply: 1_000_000n,
      decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: new PublicKey(signer.address) }, mintBytes);
    const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { owner, mint: config.mint,
      state: 'initialized', tokenAmount: { amount: '10000', decimals: 6 } } } } });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === `${config.facilitatorUrl}/supported`) return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: config.network, extra: { feePayer: sponsor.address } }] });
      expect(String(url)).toBe(config.rpcUrl);
      const request = JSON.parse(String(init?.body));
      const results: Record<string, unknown> = {
        getGenesisHash: environment.genesisHash,
        getMultipleAccounts: { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } }, token(signer.address), token(recipient.address)] },
        getBalance: { value: 100_000 },
        getAccountInfo: { context: { slot: 1 }, value: { data: [mintBytes.toString('base64'), 'base64'], owner: TOKEN_PROGRAM, executable: false, lamports: 1_461_600, rentEpoch: 0, space: 82 } },
        getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: sponsor.address, lastValidBlockHeight: 12345 } },
        simulateTransaction: { value: { err: null } },
      };
      if (!(request.method in results)) throw new Error('Fixture permits no submission or merchant call');
      return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
    });
    vi.stubGlobal('fetch', fetcher);
    const signTransactions = vi.fn(signer.signTransactions);
    const observedSigner = { ...signer, signTransactions };
    const payload = await prepareSolanaPayment(config, observedSigner, record.quote, () => ledger.assertCanSign(record.approvalId),
      { amount: record.intent.amount, resource: resource.request.url, challenge }, () => {}, purchaseSigningAuthorization(ledger, record.approvalId, config, resource.request.url));
    expect(signTransactions).toHaveBeenCalledOnce();
    const identity = createSignedPaymentIdentity(payload, config);
    expect(identity).toMatchObject({ network: config.network, mint: config.mint, amount: '10000', payer: signer.address, recipient: recipient.address,
      feePayer: sponsor.address, recentBlockhash: sponsor.address });
    expect(identity.knownSignature).toBeUndefined(); // Sponsor has not completed or submitted this fixture.
    const transaction = VersionedTransaction.deserialize(Buffer.from(String(payload.payload.transaction), 'base64'));
    transaction.signatures = transaction.signatures.map(signature => new Uint8Array(signature.length));
    const unsigned = () => Buffer.from(transaction.serialize()).toString('base64');
    expect(() => assertUnsignedPaymentBindings(unsigned(), config, record.quote)).not.toThrow();
    const transfer = transaction.message.compiledInstructions.find(instruction => transaction.message.staticAccountKeys[instruction.programIdIndex].toBase58() === TOKEN_PROGRAM)!;
    transfer.data[1] ^= 1;
    expect(() => assertUnsignedPaymentBindings(unsigned(), config, record.quote)).toThrow('ORIGINAL_PAYMENT_TRANSFER_MISMATCH');
    const methods = fetcher.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init?.body)).method);
    expect(methods).toEqual(['getGenesisHash', 'getMultipleAccounts', 'getBalance', 'getAccountInfo', 'getLatestBlockhash', 'simulateTransaction']);
  } finally { ledger.close(); }
});
