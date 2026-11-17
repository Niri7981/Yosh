import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prepareSignedMppCharge } from '../../src/modules/payment/mpp-charge-execution';
import { createMppSignedPaymentIdentity } from '../../src/modules/payment/mpp-payment-evidence';
import { MppChargeQuoteSchema, readMppChargeRequest } from '../../src/modules/payment/mpp-contract';
import { encodeMppCredential, parseMppChallenge, prepareMppCharge } from '../../src/modules/payment/mpp-protocol-engine';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';
import { mppCredential, mppFixture } from '../helpers/mpp-fixture';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
vi.mock('../../src/modules/payment/mpp-protocol-engine', () => ({
  parseMppChallenge: vi.fn(), prepareMppCharge: vi.fn(), encodeMppCredential: vi.fn(),
}));

const binary = '/offline-fixture/mpp-sdk';
const rpcRequest = z.object({ id: z.unknown(), method: z.string(), params: z.array(z.unknown()) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('YOSH_PAY_MCP_DEVNET', ''); vi.stubEnv('YOSH_PAY_MCP_MAINNET', ''); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function setup(quotedBlockhash = false) {
  const f = mppFixture();
  const expiresAt = Date.now() + 120_000;
  const request = readMppChargeRequest(f.quote);
  if (quotedBlockhash) request.methodDetails.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const challenge = { ...f.quote.challenge, request: Buffer.from(JSON.stringify(request)).toString('base64url'), expires: new Date(expiresAt).toISOString() };
  const quote = MppChargeQuoteSchema.parse({ ...f.quote, challenge, expiresAt,
    challengeHeader: 'Payment ' + Object.entries(challenge).map(([name, value]) => `${name}="${value}"`).join(', ') });
  const parsed = { header: quote.challengeHeader, challenge, expiresAt, request: readMppChargeRequest(quote) };
  vi.mocked(parseMppChallenge).mockResolvedValue(parsed);
  vi.mocked(prepareMppCharge).mockResolvedValue({ ok: true, transaction: f.unsignedWire, ...f.lifetime });
  vi.mocked(encodeMppCredential).mockImplementation(async (_binary, input) => mppCredential(quote, input.transaction));
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(f.buyer.secretKey));
  const sign = vi.fn(signer.signTransactions);
  vi.mocked(loadBuyerSigner).mockResolvedValue({ ...signer, signTransactions: sign });
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
    owner, mint: f.config.mint, state: 'initialized', tokenAmount: { amount: '10000', decimals: 6 },
  } } } });
  const accounts = [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
    token(f.config.buyer), token(f.config.merchant)];
  const results: Record<string, unknown> = {
    getGenesisHash: f.config.genesisHash,
    getLatestBlockhash: { value: { blockhash: f.lifetime.recentBlockhash, lastValidBlockHeight: Number(f.lifetime.lastValidBlockHeight) } },
    getMultipleAccounts: { value: accounts }, isBlockhashValid: { value: true },
    getFeeForMessage: { value: 5001 }, getBalance: { value: 10000 }, simulateTransaction: { value: { err: null } },
  };
  const methods: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(f.config.rpcUrl);
    const request = rpcRequest.parse(JSON.parse(String(init?.body)));
    methods.push(request.method);
    if (!(request.method in results)) throw new Error('FIXTURE_FORBIDS_SUBMISSION');
    if (request.method === 'getMultipleAccounts') expect(request.params[0]).toEqual([
      f.config.mint, f.identity.sourceTokenAccount, f.identity.recipientTokenAccount,
    ]);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
  });
  vi.stubGlobal('fetch', fetcher);
  let paused = false;
  let now = Date.now();
  const beforeSign = vi.fn(() => {
    if (paused) throw new Error('AUTHORITY_PAUSED');
    if (now >= quote.expiresAt) throw new Error('AUTHORIZATION_EXPIRED');
  });
  const run = () => prepareSignedMppCharge(binary, f.config, quote, beforeSign, '10001');
  return { ...f, quote, parsed, accounts, results, methods, fetcher, signer, sign, beforeSign, run,
    pause: () => { paused = true; }, expire: () => { now = quote.expiresAt; } };
}

describe('MPP signing boundary with memory signer and fixture RPC', () => {
  it('binds a fresh RPC hash and its own expiry while preserving the merchant challenge', async () => {
    const f = await setup(true);
    const original = structuredClone(f.parsed.challenge);
    const result = await f.run();
    expect(prepareMppCharge).toHaveBeenCalledWith(binary, expect.objectContaining({ hostValidatedLifetime: f.lifetime }));
    expect(result.lifetime).toEqual(f.lifetime);
    expect(result.payment.quote.challenge).toEqual(original);
    expect(f.sign).toHaveBeenCalledOnce();
  });

  it('refuses an expired chosen blockhash before loading a signer', async () => {
    const f = await setup(true); f.results.isBlockhashValid = { value: false };
    await expect(f.run()).rejects.toThrow('MPP_BLOCKHASH_EXPIRED');
    expect(loadBuyerSigner).not.toHaveBeenCalled();
  });
  it('preflights the exact ATAs/fee and signs once with a real generated Ed25519 key', async () => {
    const f = await setup();
    const result = await f.run();
    expect(f.sign).toHaveBeenCalledOnce();
    expect(createMppSignedPaymentIdentity(result.payment, f.config, result.lifetime)).toMatchObject({
      protocol: 'mpp', payer: f.config.buyer, amount: f.quote.amount, actualMemo: '',
      sourceTokenAccount: f.identity.sourceTokenAccount, recipientTokenAccount: f.identity.recipientTokenAccount,
    });
    expect(f.methods).toEqual(['getGenesisHash', 'getLatestBlockhash', 'getGenesisHash', 'getMultipleAccounts',
      'isBlockhashValid', 'getFeeForMessage', 'getBalance', 'simulateTransaction']);
    expect(encodeMppCredential).toHaveBeenCalledOnce();
    expect(f.beforeSign).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['getGenesisHash', 'incorrect-genesis'],
    ['getFeeForMessage', { value: 10002 }], ['getFeeForMessage', { value: 0 }], ['getFeeForMessage', { value: null }],
    ['getBalance', { value: 5000 }], ['isBlockhashValid', { value: false }],
    ['simulateTransaction', { value: { err: { InstructionError: [2, 'InvalidAccountData'] } } }],
  ])('refuses invalid %s before loading a signer', async (method, value) => {
    const f = await setup(); f.results[String(method)] = value;
    await expect(f.run()).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
    expect(encodeMppCredential).not.toHaveBeenCalled();
  });

  it.each(['mint_program', 'mint_decimals', 'token_owner', 'frozen', 'balance', 'missing_destination'])('refuses invalid token state: %s', async failure => {
    const f = await setup();
    const source = { owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
      owner: failure === 'token_owner' ? Keypair.generate().publicKey.toBase58() : f.config.buyer,
      mint: f.config.mint, state: failure === 'frozen' ? 'frozen' : 'initialized',
      tokenAmount: { amount: failure === 'balance' ? '9999' : '10000', decimals: 6 },
    } } } };
    f.results.getMultipleAccounts = { value: [
      { owner: failure === 'mint_program' ? Keypair.generate().publicKey.toBase58() : TOKEN_PROGRAM,
        data: { parsed: { type: 'mint', info: { decimals: failure === 'mint_decimals' ? 9 : 6, isInitialized: true } } } },
      source, failure === 'missing_destination' ? null : f.accounts[2],
    ] };
    await expect(f.run()).rejects.toThrow();
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  });

  it('rejects an altered SDK transaction before preflight or signer loading', async () => {
    const f = await setup();
    vi.mocked(prepareMppCharge).mockResolvedValue({ ok: true, transaction: f.payment.transaction, ...f.lifetime });
    await expect(f.run()).rejects.toThrow('MPP_SIGNER_MISMATCH');
    expect(f.methods).toEqual(['getGenesisHash', 'getLatestBlockhash']);
    expect(loadBuyerSigner).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  });

  it('rejects changed challenge echo before preparing or loading a signer', async () => {
    const f = await setup();
    vi.mocked(parseMppChallenge).mockResolvedValue({ ...f.parsed, challenge: { ...f.parsed.challenge, id: 'changed' } });
    await expect(f.run()).rejects.toThrow('MPP_CHALLENGE_CHANGED');
    expect(prepareMppCharge).not.toHaveBeenCalled(); expect(loadBuyerSigner).not.toHaveBeenCalled();
  });

  it('rejects a different wallet identity before asking it to sign', async () => {
    const f = await setup();
    const wrong = await createKeyPairSignerFromBytes(new Uint8Array(Keypair.generate().secretKey));
    const wrongSign = vi.fn(wrong.signTransactions);
    vi.mocked(loadBuyerSigner).mockResolvedValue({ ...wrong, signTransactions: wrongSign });
    await expect(f.run()).rejects.toThrow('MPP_SIGNER_MISMATCH');
    expect(wrongSign).not.toHaveBeenCalled(); expect(encodeMppCredential).not.toHaveBeenCalled();
  });

  it.each(['initial', 'parse', 'prepare', 'preflight', 'wallet'] as const)('honors Pause introduced at %s boundary', async boundary => {
    const f = await setup();
    if (boundary === 'initial') f.pause();
    if (boundary === 'parse') vi.mocked(parseMppChallenge).mockImplementation(async () => { f.pause(); return f.parsed; });
    if (boundary === 'prepare') vi.mocked(prepareMppCharge).mockImplementation(async () => {
      f.pause(); return { ok: true, transaction: f.unsignedWire, ...f.lifetime };
    });
    if (boundary === 'preflight') f.fetcher.mockImplementation(async (_url, init) => {
      const request = rpcRequest.parse(JSON.parse(String(init?.body)));
      if (request.method === 'simulateTransaction') f.pause();
      return Response.json({ jsonrpc: '2.0', id: request.id, result: f.results[request.method] });
    });
    if (boundary === 'wallet') vi.mocked(loadBuyerSigner).mockImplementation(async () => {
      f.pause(); return { ...f.signer, signTransactions: f.sign };
    });
    await expect(f.run()).rejects.toThrow('AUTHORITY_PAUSED');
    expect(f.sign).not.toHaveBeenCalled(); expect(encodeMppCredential).not.toHaveBeenCalled();
  });

  it('rejects expired authorization after awaiting the wallet', async () => {
    const f = await setup();
    vi.mocked(loadBuyerSigner).mockImplementation(async () => { f.expire(); return { ...f.signer, signTransactions: f.sign }; });
    await expect(f.run()).rejects.toThrow('AUTHORIZATION_EXPIRED'); expect(f.sign).not.toHaveBeenCalled();
  });

  it('does not encode or release a credential if Pause arrives while signing', async () => {
    const f = await setup();
    f.sign.mockImplementation(async (...args) => { const result = await f.signer.signTransactions(...args); f.pause(); return result; });
    await expect(f.run()).rejects.toThrow('AUTHORITY_PAUSED');
    expect(f.sign).toHaveBeenCalledOnce(); expect(encodeMppCredential).not.toHaveBeenCalled();
  });

  it('does not release a credential if Pause arrives while encoding it', async () => {
    const f = await setup();
    vi.mocked(encodeMppCredential).mockImplementation(async (_binary, input) => { f.pause(); return mppCredential(f.quote, input.transaction); });
    await expect(f.run()).rejects.toThrow('AUTHORITY_PAUSED'); expect(f.sign).toHaveBeenCalledOnce();
  });

  it('refuses an empty signer response before formatting a credential', async () => {
    const f = await setup(); f.sign.mockResolvedValue([]);
    await expect(f.run()).rejects.toThrow('MPP_SINGLE_SIGNATURE_REQUIRED');
    expect(encodeMppCredential).not.toHaveBeenCalled();
  });
});
