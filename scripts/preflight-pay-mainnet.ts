import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { address } from '@solana/kit';
import { z } from 'zod';
import { safeResourceFetch } from '../src/modules/resources/safe-resource-fetch';
import { readPaymentRequiredHeader } from '../src/modules/payment/x402-client';
import { MAINNET_GENESIS, MAINNET_USDC_MINT, TOKEN_PROGRAM } from '../src/modules/payment/payment-environment';
import { inspectPayMainnetQuote, MAINNET_REFERENCE_API, MAINNET_REFERENCE_RPC } from '../src/modules/payment/pay-mainnet-preflight';

/** Only the explicitly selected RPC is probed; a failed probe never falls back. */
export function parsePayMainnetPreflightOptions(args: string[]) {
  const options = { rpcUrl: MAINNET_REFERENCE_RPC, outputPath: 'integration/mainnet-preparation/live-preflight.json' };
  if (args[0] !== '--live') throw new Error('READ_ONLY_LIVE_PREFLIGHT_FLAG_REQUIRED');
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--rpc-url', '--output'].includes(flag) || !value || value.startsWith('--') || seen.has(flag))
      throw new Error('READ_ONLY_PREFLIGHT_OPTIONS_INVALID');
    seen.add(flag);
    if (flag === '--rpc-url') options.rpcUrl = value;
    else options.outputPath = value;
  }
  let rpc: URL;
  try { rpc = new URL(options.rpcUrl); } catch { throw new Error('READ_ONLY_RPC_URL_INVALID'); }
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash || rpc.search || rpc.href !== options.rpcUrl)
    throw new Error('READ_ONLY_RPC_URL_INVALID');
  return options;
}

/** Explicit opt-in, read-only public probe. There is no payment/signing mode.
 * The existing HTTPS transport validates every DNS answer, pins the socket,
 * keeps TLS hostname verification, and never follows redirects or a proxy. */
export async function runPayMainnetPreflight(options: ReturnType<typeof parsePayMainnetPreflightOptions>) {
  const output: Record<string, unknown> = { checkedAt: new Date().toISOString(), paymentSent: false,
    signerUsed: false, walletAccessed: false, ledgerAccessed: false, rpcMethods: [], rpcOrigin: new URL(options.rpcUrl).origin };
  try {
    const response = await safeResourceFetch(MAINNET_REFERENCE_API, { method: 'GET', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const encoded = response.headers.get('payment-required');
    await response.body?.cancel();
    if (response.status !== 402 || !encoded) throw new Error('QUOTE_REQUIRED');
    output.quote = inspectPayMainnetQuote(readPaymentRequiredHeader(encoded, true));
  } catch { output.quoteError = 'MAINNET_QUOTE_PREFLIGHT_UNAVAILABLE'; }
  const methods: string[] = [];
  const rpc = async (method: 'getGenesisHash' | 'getLatestBlockhash' | 'getAccountInfo', params: unknown[]) => {
    methods.push(method);
    const response = await safeResourceFetch(options.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    output.rpcHttpStatus = response.status;
    if (!response.ok) throw new Error('RPC_UNAVAILABLE');
    const body: unknown = await response.json();
    return z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown(), error: z.never().optional() }).strict().parse(body).result;
  };
  try {
    if (await rpc('getGenesisHash', []) !== MAINNET_GENESIS) throw new Error('RPC_NETWORK_MISMATCH');
    const latest = z.object({ value: z.object({ blockhash: z.string().refine(value => {
      try { address(value); return true; } catch { return false; }
    }), lastValidBlockHeight: z.number().int().safe().nonnegative() }) })
      .parse(await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
    const mint = z.object({ value: z.object({ owner: z.literal(TOKEN_PROGRAM), data: z.tuple([z.string(), z.literal('base64')]) }) })
      .parse(await rpc('getAccountInfo', [MAINNET_USDC_MINT, { encoding: 'base64', commitment: 'confirmed' }]));
    const data = Buffer.from(mint.value.data[0], 'base64');
    if (data.toString('base64') !== mint.value.data[0] || data.length !== 82 || data[44] !== 6 || data[45] !== 1)
      throw new Error('USDC_MINT_MISMATCH');
    output.rpc = { genesisMatches: true, nativeUsdcMintVerified: true, mint: MAINNET_USDC_MINT, mintOwner: TOKEN_PROGRAM, decimals: 6,
      recentBlockhash: latest.value.blockhash, lastValidBlockHeight: String(latest.value.lastValidBlockHeight) };
  } catch (error) {
    output.rpcError = 'MAINNET_READ_ONLY_RPC_PREFLIGHT_UNAVAILABLE';
    if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) output.rpcFailureCode = error.message;
    const reason = z.object({ name: z.enum(['Error', 'AbortError', 'TimeoutError', 'ZodError']), code: z.string().optional() }).safeParse(error);
    if (reason.success) {
      output.rpcFailureType = reason.data.name;
      if (['ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(reason.data.code ?? ''))
        output.rpcNetworkCode = reason.data.code;
    }
  }
  output.rpcMethods = methods;
  output.readyForRealPayment = false;
  return output;
}

async function main() {
  const options = parsePayMainnetPreflightOptions(process.argv.slice(2));
  const output = await runPayMainnetPreflight(options);
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => { process.stderr.write('Read-only Mainnet preflight could not start. No payment requested.\n'); process.exitCode = 1; });
