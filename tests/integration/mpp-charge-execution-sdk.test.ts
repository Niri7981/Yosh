import { resolve } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prepareSignedMppCharge } from '../../src/modules/payment/mpp-charge-execution';
import { createMppSignedPaymentIdentity } from '../../src/modules/payment/mpp-payment-evidence';
import { MppChargeQuoteSchema } from '../../src/modules/payment/mpp-contract';
import { parseMppChallenge } from '../../src/modules/payment/mpp-protocol-engine';
import type { PaymentConfig } from '../../src/modules/payment/payment-config';
import { resolvePaymentEnvironment, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { loadBuyerSigner } from '../../src/modules/payment/wallet';

vi.mock('../../src/modules/payment/wallet', () => ({ loadBuyerSigner: vi.fn() }));
const binary = process.env.YOSH_MPP_PROTOCOL_TEST_BINARY ?? resolve('build.noindex/mpp-sdk/rust-target/debug/yosh-execution-protocol');
const rpcRequest = z.object({ id: z.unknown(), method: z.string(), params: z.array(z.unknown()) });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['devnet', 'mainnet'] as const)('signs actual pinned SDK %s USDC bytes with fixture RPC and a generated memory signer', async network => {
  vi.stubEnv('YOSH_PAY_MCP_DEVNET', ''); vi.stubEnv('YOSH_PAY_MCP_MAINNET', '');
  const signer = await generateKeyPairSigner(); const merchant = await generateKeyPairSigner();
  const recentBlockhash = (await generateKeyPairSigner()).address;
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: network === 'mainnet' ? 'live_mainnet' : 'live_devnet',
    ...(network === 'mainnet' ? { YOSH_ENABLE_MAINNET_EXECUTION: '1' } : {}), SOLANA_RPC_URL: 'https://rpc.fixture.example' });
  const config: PaymentConfig = { ...environment, mint: environment.asset.mint, buyer: signer.address,
    merchant: merchant.address, facilitatorUrl: null };
  const request = { amount: '10000', currency: config.mint, recipient: config.merchant,
    ...(network === 'mainnet' ? { externalId: 'sdk-charge-fixture' } : {}),
    methodDetails: { network, decimals: 6, tokenProgram: TOKEN_PROGRAM } };
  const header = `Payment id="signing-fixture", realm="merchant.invalid", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(request)).toString('base64url')}", expires="${new Date(Date.now() + 60_000).toISOString()}"`;
  const challenge = await parseMppChallenge(binary, header);
  const quote = MppChargeQuoteSchema.parse({ protocol: 'mpp', method: 'solana', intent: 'charge', scheme: 'mpp_charge',
    network: config.network, asset: config.mint, payTo: config.merchant, amount: request.amount,
    challenge: challenge.challenge, challengeHeader: header, expiresAt: challenge.expiresAt });
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
    owner, mint: config.mint, state: 'initialized', tokenAmount: { amount: '10000', decimals: 6 },
  } } } });
  const results: Record<string, unknown> = {
    getGenesisHash: config.genesisHash,
    getLatestBlockhash: { value: { blockhash: recentBlockhash, lastValidBlockHeight: 12345 } },
    getMultipleAccounts: { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
      token(config.buyer), token(config.merchant)] },
    isBlockhashValid: { value: true }, getFeeForMessage: { value: 5001 }, getBalance: { value: 10000 }, simulateTransaction: { value: { err: null } },
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(config.rpcUrl);
    const rpc = rpcRequest.parse(JSON.parse(String(init?.body)));
    if (!(rpc.method in results)) throw new Error('FIXTURE_FORBIDS_SUBMISSION');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] });
  });
  vi.stubGlobal('fetch', fetcher);
  const sign = vi.fn(signer.signTransactions);
  vi.mocked(loadBuyerSigner).mockResolvedValue({ ...signer, signTransactions: sign });
  const beforeSign = vi.fn(() => { if (Date.now() >= quote.expiresAt) throw new Error('FIXTURE_QUOTE_EXPIRED'); });
  const prepared = await prepareSignedMppCharge(binary, config, quote, beforeSign, '10001');
  const identity = createMppSignedPaymentIdentity(prepared.payment, config, prepared.lifetime);
  expect(identity).toMatchObject({ protocol: 'mpp', network: config.network, mint: config.mint,
    payer: signer.address, recipient: merchant.address, amount: '10000', actualMemo: network === 'mainnet' ? 'sdk-charge-fixture' : '',
    recentBlockhash, lastValidBlockHeight: '12345', buyerSignerIndex: 0, feePayer: signer.address });
  expect(sign).toHaveBeenCalledOnce();
  expect(beforeSign).toHaveBeenCalledTimes(6);
  expect(fetcher).toHaveBeenCalledTimes(8);
});
