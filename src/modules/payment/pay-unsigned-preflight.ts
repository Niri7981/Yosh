import { spawn } from 'node:child_process';
import { z } from 'zod';
import { safeResourceFetch } from '../resources/safe-resource-fetch';
import { type X402Resource, X402ResourceSchema, SolanaPublicKeySchema } from '../resources/http-resource';
import { validateResourceChallenge, assertPayControlledExtensions } from './resource-challenge';
import { readPaymentRequiredHeader } from './x402-client';
import { type PaymentEnvironment, MAINNET_GENESIS, TOKEN_PROGRAM } from './payment-environment';
import { readPaymentJson } from './read-payment-json';
import { assertUnsignedPaymentBindings, decodeOriginalTransaction } from './original-payment-evidence';
import { getStandardTokenAccount } from './payment-preflight';
import { hash } from '../purchases/spending-policy';

const lamports = z.number().int().safe().nonnegative();
const atomic = z.string().regex(/^(0|[1-9]\d*)$/);
const Prepared = z.object({ transaction: z.string().max(1644), recentBlockhash: SolanaPublicKeySchema,
  lastValidBlockHeight: atomic }).strict();

/** Same installed Pay binary, classifier and controlled unsigned builder. This
 * subcommand has no account store, authority, signer or payment transport. */
export async function preparePayUnsigned(binary: string, input: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(binary, ['--unsigned-preflight'], { env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let size = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PAY_UNSIGNED_TIMEOUT')); }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 131_072) { child.kill(); reject(new Error('PAY_UNSIGNED_RESPONSE_TOO_LARGE')); }
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('PAY_UNSIGNED_UNAVAILABLE')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error('PAY_UNSIGNED_UNAVAILABLE')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('PAY_UNSIGNED_RESPONSE_INVALID')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Read-only, including when execution is disabled or payments paused. Does not
 * import AppRuntime/wallet/signers or create an operation, reservation or grant. */
export async function runPayUnsignedPreflight(options: {
  wallet: string; resource: X402Resource; environment: PaymentEnvironment; binary: string;
  fetcher?: typeof safeResourceFetch; prepare?: typeof preparePayUnsigned;
}) {
  const { environment, wallet } = options;
  const resource = X402ResourceSchema.parse(options.resource);
  SolanaPublicKeySchema.parse(wallet);
  if (environment.mode !== 'live_mainnet' || environment.genesisHash !== MAINNET_GENESIS || resource.request.method !== 'GET')
    throw new Error('PAY_PREFLIGHT_MAINNET_GET_REQUIRED');
  if (!resource.recipient || !resource.amount) throw new Error('PAY_PREFLIGHT_EXACT_ECONOMIC_SCOPE_REQUIRED');
  if (process.env.NODE_ENV !== 'test' && (options.fetcher || options.prepare)) throw new Error('PAY_PREFLIGHT_FIXTURE_DEPENDENCY_FORBIDDEN');
  const fetcher = options.fetcher ?? safeResourceFetch;
  const request = { ...resource.request, headers: { ...resource.request.headers, accept: resource.request.headers.accept ?? 'application/json' } };
  const response = await fetcher(request.url, { method: 'GET', headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const header = response.headers.get('payment-required'); await response.body?.cancel();
  if (response.status !== 402 || !header) throw new Error('PAY_PREFLIGHT_QUOTE_REQUIRED');
  const { challenge, quote } = validateResourceChallenge(readPaymentRequiredHeader(header, true), { ...resource, request }, environment);
  assertPayControlledExtensions(challenge);
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetcher(new URL(environment.rpcUrl).href, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('PAY_PREFLIGHT_RPC_UNAVAILABLE');
    return z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown(), error: z.never().optional() })
      .parse(await readPaymentJson(response, 131_072)).result;
  };
  if (await rpc('getGenesisHash') !== MAINNET_GENESIS) throw new Error('PAY_PREFLIGHT_NETWORK_MISMATCH');
  const latest = z.object({ value: z.object({ blockhash: SolanaPublicKeySchema, lastValidBlockHeight: lamports }) })
    .parse(await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
  const lifetime = { recentBlockhash: latest.value.blockhash, lastValidBlockHeight: String(latest.value.lastValidBlockHeight) };
  const raw = await (options.prepare ?? preparePayUnsigned)(options.binary, { payer: wallet, rpcUrl: environment.rpcUrl,
    lifetime, url: request.url, paymentRequired: challenge });
  const result = z.object({ ok: z.literal(true), result: z.object({ accepted: z.unknown(), unsigned: Prepared }).strict() }).strict().parse(raw).result;
  if (hash(result.accepted) !== hash(quote)) throw new Error('PAY_PREFLIGHT_SELECTED_QUOTE_MISMATCH');
  const wire = result.unsigned.transaction;
  const decoded = decodeOriginalTransaction(wire);
  if (decoded.transaction.signatures.some(signature => signature.some(byte => byte !== 0))
    || result.unsigned.recentBlockhash !== lifetime.recentBlockhash || decoded.transaction.message.recentBlockhash !== lifetime.recentBlockhash
    || result.unsigned.lastValidBlockHeight !== lifetime.lastValidBlockHeight) throw new Error('PAY_PREFLIGHT_UNSIGNED_BINDING_MISMATCH');
  assertUnsignedPaymentBindings(wire, { ...environment, buyer: wallet, merchant: quote.payTo, mint: environment.asset.mint, facilitatorUrl: null }, quote);
  const buyerAta = await getStandardTokenAccount(wallet, environment.asset.mint);
  const recipientAta = await getStandardTokenAccount(quote.payTo, environment.asset.mint);
  const feePayer = SolanaPublicKeySchema.parse(quote.extra.feePayer);
  if (feePayer === wallet) throw new Error('PAY_PREFLIGHT_SPONSORED_FEES_REQUIRED');
  const accounts = z.object({ value: z.tuple([z.unknown(), z.unknown(), z.unknown()]) })
    .parse(await rpc('getMultipleAccounts', [[environment.asset.mint, buyerAta, recipientAta], { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
  z.object({ owner: z.literal(TOKEN_PROGRAM), data: z.object({ parsed: z.object({ type: z.literal('mint'),
    info: z.object({ decimals: z.literal(6), isInitialized: z.literal(true) }) }) }) }).parse(accounts[0]);
  const tokenBalance = (account: unknown, owner: string) => z.object({ owner: z.literal(TOKEN_PROGRAM), data: z.object({ parsed: z.object({
    type: z.literal('account'), info: z.object({ owner: z.literal(owner), mint: z.literal(environment.asset.mint), state: z.literal('initialized'),
      tokenAmount: z.object({ amount: atomic, decimals: z.literal(6) }) }) }) }) }).parse(account).data.parsed.info.tokenAmount.amount;
  const buyerBalance = tokenBalance(accounts[1], wallet); tokenBalance(accounts[2], quote.payTo);
  if (BigInt(buyerBalance) < BigInt(quote.amount)) throw new Error('PAY_PREFLIGHT_INSUFFICIENT_USDC');
  const payerBalance = z.object({ value: lamports }).parse(await rpc('getBalance', [feePayer, { commitment: 'confirmed' }])).value;
  const buyerSol = z.object({ value: lamports }).parse(await rpc('getBalance', [wallet, { commitment: 'confirmed' }])).value;
  const fee = z.object({ value: lamports }).parse(await rpc('getFeeForMessage', [Buffer.from(decoded.message).toString('base64'), { commitment: 'confirmed' }])).value;
  if (fee <= 0 || payerBalance < fee) throw new Error('PAY_PREFLIGHT_INSUFFICIENT_FEE_PAYER_SOL');
  const simulation = z.object({ value: z.object({ err: z.null(), unitsConsumed: lamports.optional() }) })
    .parse(await rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]));
  // Strict instruction validation admits no account creation or SOL transfer;
  // both existing token accounts are verified above. No rent estimate is guessed.
  return { checkedAt: Date.now(), wallet, resourceId: resource.resourceId, providerId: resource.providerId,
    request: { method: request.method, url: request.url, headers: Object.entries(request.headers).sort(), body: null },
    challenge, quote, quoteHash: hash(quote), challengeHash: hash(challenge), lifetime,
    unsignedHash: hash(wire), feePayer, feeLamports: String(fee), accountCreationLamports: '0',
    buyerFeeLamports: '0', feePayerBalanceLamports: String(payerBalance), buyerSolLamports: String(buyerSol),
    buyerUsdcAtomic: buyerBalance, simulationUnits: simulation.value.unitsConsumed ?? null,
    unsignedValidated: true as const, signerUsed: false as const, paymentSent: false as const };
}
