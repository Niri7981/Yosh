import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { X402ResourceSchema } from '../../src/modules/resources/http-resource';
import { resolvePaymentEnvironment, MAINNET_GENESIS, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { preparePayUnsigned, runPayUnsignedPreflight } from '../../src/modules/payment/pay-unsigned-preflight';

// Public merchant fixture, real Pay classifier/builder, no private key or Ledger.
const challenge: unknown = JSON.parse(readFileSync(resolve('../pay/rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json'), 'utf8'));
const wallet = '11111111111111111111111111111111';
const recipient = 'J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg';
const sponsor = 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP';
const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_MAINNET_RPC_URL: 'https://rpc.fixture.invalid/' });
const resource = X402ResourceSchema.parse({ resourceId: 'fixture-crypto', providerId: 'fixture-provider',
  request: { url: 'https://agent402.tools/api/crypto-price?coins=BTC%2CETH%2CSOL&currency=usd', method: 'GET', access: 'https', headers: { accept: 'application/json' } },
  network: environment.network, mint: environment.asset.mint, decimals: 6, recipient, amount: '1000' });
const binary = resolve('build.noindex/pay-mcp-target/debug/yosh-controlled-mcp');

function fixture(change?: { fee?: number | null; sponsorBalance?: number; simulationError?: unknown; accountMissing?: boolean; frozen?: boolean; signed?: boolean }) {
  const methods: string[] = [];
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { owner,
    mint: environment.asset.mint, state: change?.frozen ? 'frozen' : 'initialized', tokenAmount: { amount: '2000', decimals: 6 } } } } });
  const fetcher = async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') } });
    const input = JSON.parse(String(init.body)); methods.push(input.method);
    const values: Record<string, unknown> = {
      getGenesisHash: MAINNET_GENESIS,
      getLatestBlockhash: { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 5000 } },
      getMultipleAccounts: { value: [ { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
        change?.accountMissing ? null : token(wallet), token(recipient) ] },
      getBalance: { value: input.params[0] === sponsor ? change?.sponsorBalance ?? 100_000 : 3_000_000 },
      getFeeForMessage: { value: change && 'fee' in change ? change.fee : 10_001 },
      simulateTransaction: { value: { err: change?.simulationError ?? null, unitsConsumed: 13_180 } },
    };
    if (!(input.method in values)) throw new Error('UNEXPECTED_RPC_METHOD');
    return Response.json({ jsonrpc: '2.0', id: 1, result: values[input.method] });
  };
  return { methods, run: (override = resource) => runPayUnsignedPreflight({ wallet, resource: override, environment, binary, fetcher,
    prepare: async (path, input) => {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
        const result = rpc.method === 'isBlockhashValid' ? { context: { slot: 1 }, value: true }
          : rpc.method === 'getAccountInfo' ? { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'],
            executable: false, lamports: 1000000, owner: TOKEN_PROGRAM, rentEpoch: 0 } } : null;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_RPC_REQUIRED');
      try {
        const raw = await preparePayUnsigned(path, { ...z.record(z.string(), z.unknown()).parse(input), rpcUrl: `http://127.0.0.1:${address.port}` });
        if (!change?.signed) return raw;
        const value = JSON.parse(JSON.stringify(raw));
        const transaction = VersionedTransaction.deserialize(Buffer.from(value.result.unsigned.transaction, 'base64'));
        transaction.signatures[0][0] = 1;
        value.result.unsigned.transaction = Buffer.from(transaction.serialize()).toString('base64');
        return value;
      } finally { server.closeAllConnections(); server.close(); }
    } }) };
}

it('uses the Pay SDK without signatures while execution remains disabled and estimates the actual sponsored fee', async () => {
  const f = fixture();
  expect(environment.productionExecutionEnabled).toBe(false);
  const result = await f.run();
  expect(result).toMatchObject({ unsignedValidated: true, paymentSent: false, signerUsed: false,
    wallet, feePayer: sponsor, feeLamports: '10001', buyerFeeLamports: '0', accountCreationLamports: '0', buyerUsdcAtomic: '2000' });
  expect(f.methods).toEqual(['getGenesisHash', 'getLatestBlockhash', 'getMultipleAccounts', 'getBalance', 'getBalance', 'getFeeForMessage', 'simulateTransaction']);
  expect(result.challenge.extensions).toBeDefined();
});

it.each([{ fee: null }, { fee: 0 }, { sponsorBalance: 10_000 }, { simulationError: { InstructionError: [2, 'InvalidAccountData'] } },
  { accountMissing: true }, { frozen: true }, { signed: true }])('keeps fee/account/simulation/unsigned failures blocked: %j', async change => {
  await expect(fixture(change).run()).rejects.toThrow();
});

it.each([{ recipient: wallet }, { amount: '999' }, { mint: wallet }, { network: 'solana:wrong' as const }])('never weakens exact authorized economic scope: %j', async change => {
  await expect(fixture().run({ ...resource, ...change })).rejects.toThrow();
});

it('requires a fixed recipient and amount rather than turning discovery into spending authority', async () => {
  await expect(fixture().run({ ...resource, amount: undefined })).rejects.toThrow('PAY_PREFLIGHT_EXACT_ECONOMIC_SCOPE_REQUIRED');
});
