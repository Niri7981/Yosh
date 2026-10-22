import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/resources/safe-resource-fetch', () => ({ safeResourceFetch: vi.fn() }));
import { safeResourceFetch } from '../../src/modules/resources/safe-resource-fetch';
import { MAINNET_GENESIS, MAINNET_USDC_MINT, TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';
import { parsePayMainnetPreflightOptions, runPayMainnetPreflight } from '../../scripts/preflight-pay-mainnet';

const options = () => parsePayMainnetPreflightOptions(['--live', '--rpc-url', 'https://solana-rpc.publicnode.com/',
  '--output', 'integration/mainnet-quote-rpc/test-only.json']);
const methods: string[] = [];
let genesis: string, blockhash: string, mintOwner: string, mintData: Buffer, corruptBase64: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  methods.length = 0;
  genesis = MAINNET_GENESIS;
  blockhash = '11111111111111111111111111111111';
  mintOwner = TOKEN_PROGRAM;
  mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
  corruptBase64 = false;
  vi.mocked(safeResourceFetch).mockImplementation(async (_url, init) => {
    if (init.method === 'GET') return new Response('', { status: 503 });
    const body: unknown = JSON.parse(String(init.body));
    if (typeof body !== 'object' || body === null || !('method' in body) || typeof body.method !== 'string')
      throw new Error('UNEXPECTED_TEST_METHOD');
    methods.push(body.method);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = genesis;
    else if (body.method === 'getLatestBlockhash') result = { value: { blockhash, lastValidBlockHeight: 123 } };
    else if (body.method === 'getAccountInfo') result = { value: { owner: mintOwner,
      data: [mintData.toString('base64') + (corruptBase64 ? '!' : ''), 'base64'] } };
    else throw new Error('UNEXPECTED_TEST_METHOD');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
});

it('requires explicit read-only opt-in and explicit RPC selection without changing configuration', () => {
  expect(options().rpcUrl).toBe('https://solana-rpc.publicnode.com/');
  expect(() => parsePayMainnetPreflightOptions([])).toThrow('READ_ONLY_LIVE_PREFLIGHT_FLAG_REQUIRED');
  expect(() => parsePayMainnetPreflightOptions(['--live', '--pay'])).toThrow('READ_ONLY_PREFLIGHT_OPTIONS_INVALID');
  expect(() => parsePayMainnetPreflightOptions(['--live', '--rpc-url', 'https://rpc.example/', '--rpc-url', 'https://other.example/']))
    .toThrow('READ_ONLY_PREFLIGHT_OPTIONS_INVALID');
});

it.each(['http://rpc.example/', 'https://user:secret@rpc.example/', 'https://rpc.example/#fragment',
  'https://rpc.example/?api-key=secret', 'https://rpc.example'])('rejects unsafe or noncanonical RPC URL %s', url => {
  expect(() => parsePayMainnetPreflightOptions(['--live', '--rpc-url', url])).toThrow('READ_ONLY_RPC_URL_INVALID');
});

it('only sends the three read-only methods through the existing safe transport and verifies chain and mint', async () => {
  const result = await runPayMainnetPreflight(options());
  expect(result).toMatchObject({ paymentSent: false, signerUsed: false, walletAccessed: false, ledgerAccessed: false,
    readyForRealPayment: false, rpcOrigin: 'https://solana-rpc.publicnode.com',
    rpc: { genesisMatches: true, nativeUsdcMintVerified: true, mint: MAINNET_USDC_MINT, mintOwner: TOKEN_PROGRAM, decimals: 6 } });
  expect(methods).toEqual(['getGenesisHash', 'getLatestBlockhash', 'getAccountInfo']);
  const calls = vi.mocked(safeResourceFetch).mock.calls.filter(([, init]) => init.method === 'POST');
  expect(calls).toHaveLength(3);
  for (const [url, init] of calls) {
    expect(url).toBe(options().rpcUrl);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(JSON.parse(String(calls[2][1].body)).params).toEqual([MAINNET_USDC_MINT, { encoding: 'base64', commitment: 'confirmed' }]);
});

it('rejects another cluster after genesis without requesting blockhash or mint', async () => {
  genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const result = await runPayMainnetPreflight(options());
  expect(result.rpcFailureCode).toBe('RPC_NETWORK_MISMATCH');
  expect(methods).toEqual(['getGenesisHash']);
  expect(result).not.toHaveProperty('rpc');
});

it('rejects a malformed recent blockhash rather than treating HTTP 200 as RPC readiness', async () => {
  blockhash = 'not-a-blockhash';
  const result = await runPayMainnetPreflight(options());
  expect(result).toHaveProperty('rpcError');
  expect(result).not.toHaveProperty('rpc');
  expect(methods).toEqual(['getGenesisHash', 'getLatestBlockhash']);
});

it.each(['owner', 'decimals', 'uninitialized', 'size', 'base64'])('rejects incorrect USDC mint %s', async field => {
  if (field === 'owner') mintOwner = '11111111111111111111111111111111';
  if (field === 'decimals') mintData[44] = 9;
  if (field === 'uninitialized') mintData[45] = 0;
  if (field === 'size') mintData = Buffer.alloc(165);
  if (field === 'base64') corruptBase64 = true;
  const result = await runPayMainnetPreflight(options());
  expect(result).toHaveProperty('rpcError');
  expect(result).not.toHaveProperty('rpc');
  expect(result.readyForRealPayment).toBe(false);
});

it('retains DNS safety rejection, emits a fixed error, and never falls back to another RPC', async () => {
  vi.mocked(safeResourceFetch).mockImplementation(async (_url, init) => {
    if (init.method === 'GET') return new Response('', { status: 503 });
    throw new Error('RESOURCE_DESTINATION_UNSAFE');
  });
  const result = await runPayMainnetPreflight(options());
  expect(result.rpcFailureCode).toBe('RESOURCE_DESTINATION_UNSAFE');
  expect(result.rpcMethods).toEqual(['getGenesisHash']);
  expect(vi.mocked(safeResourceFetch).mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('distinguishes an RPC HTTP failure from the DNS policy rejection without exposing service bodies', async () => {
  vi.mocked(safeResourceFetch).mockImplementation(async (_url, init) => init.method === 'GET'
    ? new Response('', { status: 503 }) : new Response('untrusted upstream diagnostic', { status: 429 }));
  const result = await runPayMainnetPreflight(options());
  expect(result).toMatchObject({ rpcFailureCode: 'RPC_UNAVAILABLE', rpcHttpStatus: 429 });
  expect(JSON.stringify(result)).not.toContain('untrusted upstream diagnostic');
  expect(result).not.toHaveProperty('rpc');
});
