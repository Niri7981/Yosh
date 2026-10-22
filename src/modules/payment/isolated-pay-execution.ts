import { isPayDevelopmentDirectory } from '../pay-dev/isolation';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { assertIsTransactionWithinSizeLimit, blockhash, getBase64EncodedWireTransaction, getTransactionDecoder, type TransactionPartialSigner } from '@solana/kit';
import { z } from 'zod';
import { X402ChallengeSchema, SolanaPublicKeySchema } from '../resources/http-resource';
import { hash } from '../purchases/spending-policy';
import type { PurchaseLedger } from '../purchases/purchase-ledger';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, type PaymentConfig } from './payment-config';
import { assertUnsignedPaymentBindings, decodeOriginalTransaction } from './original-payment-evidence';
import type { PaymentExecutionContext, PaymentExecutor } from './payment-execution-contract';
import { solanaRpc } from './solana-payment';

const owners = new Map<string, symbol>();

/** No environment flag enables pay in the installed product. The new Ledger fences
 * durable permits, but warm legacy-process credential egress remains blocked. */
export function assertIsolatedPaymentDirectory(directory: string) {
  if (isPayDevelopmentDirectory(directory)) return realpathSync(directory);
  if (process.env.NODE_ENV !== 'test' || !process.env.VITEST) throw new Error('PAY_EXECUTOR_PRODUCTION_BLOCKED');
  const info = lstatSync(directory);
  const path = realpathSync(directory);
  const withinTemporary = relative(realpathSync(tmpdir()), path);
  if (!info.isDirectory() || info.isSymbolicLink() || !withinTemporary || withinTemporary.startsWith('..')
    || isAbsolute(withinTemporary) || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new Error('PAY_EXECUTOR_PRIVATE_TEMP_DIRECTORY_REQUIRED');
  }
  return path;
}

function loopback(value: string) {
  const url = new URL(value);
  // An IP literal avoids DNS and proxy/rebinding ambiguity in the isolated engine.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash) {
    throw new Error('PAY_EXECUTOR_LOOPBACK_REQUIRED');
  }
  return url;
}

export const PreparedSchema = z.object({ ok: z.literal(true), transaction: z.string().max(1644),
  recentBlockhash: SolanaPublicKeySchema, lastValidBlockHeight: z.string().regex(/^(0|[1-9]\d*)$/).max(20) }).strict();
const QuoteSchema = z.object({ ok: z.literal(true), challenge: X402ChallengeSchema,
  requirement: z.unknown(), classifier: z.literal('pay-core') }).strict();
const InterpretedSchema = z.object({ ok: z.literal(true), receipt: z.object({ success: z.boolean(), network: z.string(),
  payer: z.string().optional() }).strict().nullable(), repeatedPaymentRequired: z.boolean() }).strict();

export type IsolatedPayHooks = {
  beforePrepare?: () => Promise<void>;
  beforeSign?: () => Promise<void>;
  afterSigned?: () => Promise<void>;
};

/** Real unsigned Rust builder, with a Yosh-owned offline test signer. This
 * factory is test-only: it cannot admit Mainnet, real RPCs or a user ledger. */
export function createIsolatedPayExecution(options: {
  directory: string; enginePath: string; merchantOrigin: string; rpcUrl: string;
  signer: TransactionPartialSigner; hooks?: IsolatedPayHooks;
  unsignedPreparation?: (context: PaymentExecutionContext) => Promise<unknown>;
}) {
  const directory = assertIsolatedPaymentDirectory(options.directory);
  const merchant = loopback(options.merchantOrigin);
  const rpc = loopback(options.rpcUrl);
  if (owners.has(directory)) throw new Error('PAY_EXECUTOR_OWNER_EXISTS');
  const owner = Symbol('isolated-pay-owner');
  owners.set(directory, owner);
  let alive = true;
  let generation = 0;
  let ledger: PurchaseLedger | undefined;
  const prepared = new Map<string, { generation: number; context: PaymentExecutionContext; phase: 'claimed' | 'preparing' }>();
  const calls = { quote: 0, prepare: 0, interpret: 0 };
  const live = () => {
    if (!alive || owners.get(directory) !== owner) throw new Error('PAY_EXECUTOR_STALE_OWNER');
  };
  const invoke = async (input: object): Promise<unknown> => {
    live();
    return new Promise((resolve, reject) => {
      // No product configuration, wallet source or inherited proxy crosses IPC.
      const child = spawn(options.enginePath, [], { cwd: directory,
        env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'ignore'] });
      let bytes = 0;
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => { child.kill(); reject(new Error('PAY_PROTOCOL_TIMEOUT')); }, 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 131_072) { child.kill(); reject(new Error('PAY_PROTOCOL_RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      child.on('error', () => { clearTimeout(timeout); reject(new Error('PAY_PROTOCOL_UNAVAILABLE')); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error('PAY_PROTOCOL_REJECTED')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('PAY_PROTOCOL_INVALID_RESPONSE')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  };
  const eligibility = (config: PaymentConfig, target: PurchaseLedger) => {
    live();
    if (target !== ledger) throw new Error('PAY_EXECUTOR_RUNTIME_BINDING_REQUIRED');
    // Yosh's fake HTTPS RPC transport is supplied by the test fixture. Rust
    // independently uses the literal loopback fake RPC, with no public fallback.
    const rpcIdentity = new URL(config.rpcUrl);
    if (config.mode !== 'live_devnet' || config.cluster !== 'devnet' || config.isProduction || config.productionExecutionEnabled
      || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT || config.buyer !== options.signer.address
      || rpcIdentity.protocol !== 'https:' || !rpcIdentity.hostname.endsWith('.invalid') || rpcIdentity.username || rpcIdentity.password) {
      throw new Error('PAY_EXECUTOR_ISOLATED_CONFIGURATION_REQUIRED');
    }
  };
  const assertCurrent = (context: PaymentExecutionContext) => {
    live();
    const token = prepared.get(context.record.approvalId);
    if (!token || token.generation !== generation || token.context !== context) throw new Error('PAY_EXECUTOR_STALE_GENERATION');
    context.beforeSign();
  };
  const executor: PaymentExecutor = {
    bindRuntime(runtimeDirectory, target) {
      live();
      if (assertIsolatedPaymentDirectory(runtimeDirectory) !== directory || ledger) throw new Error('PAY_EXECUTOR_RUNTIME_BINDING_REQUIRED');
      ledger = target;
    },
    assertEligibility: eligibility,
    invalidate() { generation++; },
    beginPreparation(context) {
      live();
      if (prepared.has(context.record.approvalId)) throw new Error('PAY_EXECUTOR_OPERATION_ALREADY_PREPARED');
      prepared.set(context.record.approvalId, { generation, context, phase: 'claimed' });
    },
    async prepare(context) {
      if (!ledger) throw new Error('PAY_EXECUTOR_RUNTIME_BINDING_REQUIRED');
      eligibility(context.config, ledger);
      const endpoint = loopback(context.endpoint);
      if (endpoint.origin !== merchant.origin || context.record.intent.httpRequest?.access !== 'test_loopback') {
        throw new Error('PAY_EXECUTOR_RESOURCE_BINDING_REQUIRED');
      }
      assertCurrent(context);
      const token = prepared.get(context.record.approvalId)!;
      if (token.phase !== 'claimed') throw new Error('PAY_EXECUTOR_OPERATION_ALREADY_PREPARED');
      token.phase = 'preparing';
      await options.hooks?.beforePrepare?.();
      assertCurrent(context);
      const result = PreparedSchema.parse(options.unsignedPreparation
        ? await options.unsignedPreparation(context)
        : await invoke({ operation: 'prepare', payer: context.config.buyer, rpcUrl: rpc.href, requirement: context.record.quote }));
      calls.prepare++;
      const transaction = decodeOriginalTransaction(result.transaction).transaction;
      if (transaction.signatures.some(signature => signature.some(byte => byte !== 0))
        || transaction.message.recentBlockhash !== result.recentBlockhash) throw new Error('PAY_EXECUTOR_UNSIGNED_REQUIRED');
      assertUnsignedPaymentBindings(result.transaction, context.config, context.record.quote);
      const simulation = await solanaRpc<unknown>(context.config, 'simulateTransaction', [result.transaction,
        { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
      z.object({ value: z.object({ err: z.null() }) }).parse(simulation);
      await options.hooks?.beforeSign?.();
      assertCurrent(context);
      // No await between the authority check and starting the local signer.
      const unsigned = { ...getTransactionDecoder().decode(Buffer.from(result.transaction, 'base64')),
        lifetimeConstraint: { blockhash: blockhash(result.recentBlockhash), lastValidBlockHeight: BigInt(result.lastValidBlockHeight) } };
      assertIsTransactionWithinSizeLimit(unsigned);
      const signatures = await options.signer.signTransactions([unsigned]);
      if (signatures.length !== 1) throw new Error('PAY_EXECUTOR_SINGLE_SIGNATURE_REQUIRED');
      const signed = getBase64EncodedWireTransaction({ ...unsigned, signatures: { ...unsigned.signatures, ...signatures[0] } });
      await options.hooks?.afterSigned?.();
      assertCurrent(context);
      const challenge = X402ChallengeSchema.parse(context.record.intent.x402Challenge);
      return { payload: { x402Version: 2, accepted: context.record.quote, resource: challenge.resource,
        ...(challenge.extensions ? { extensions: challenge.extensions } : {}), payload: { transaction: signed } },
        lifetime: { recentBlockhash: result.recentBlockhash, lastValidBlockHeight: result.lastValidBlockHeight } };
    },
    assertBeforeSubmission(context) { assertCurrent(context); prepared.delete(context.record.approvalId); },
    async interpretResponse(observation) {
      InterpretedSchema.parse(await invoke({ operation: 'interpret', status: observation.status,
        headers: observation.paymentResponse ? { 'payment-response': observation.paymentResponse } : {} }));
      calls.interpret++;
    },
  };
  const quoteFetcher: typeof fetch = async (input, init) => {
    const endpoint = loopback(String(input));
    if (endpoint.origin !== merchant.origin || (init?.method ?? 'GET') !== 'GET' || init?.body != null) throw new Error('PAY_EXECUTOR_QUOTE_BINDING_REQUIRED');
    const headers = Object.fromEntries(new Headers(init?.headers));
    if (Object.keys(headers).some(key => key !== 'accept')) throw new Error('PAY_EXECUTOR_QUOTE_HEADERS_REJECTED');
    const result = QuoteSchema.parse(await invoke({ operation: 'quote', url: endpoint.href, method: 'GET', headers }));
    const matches = result.challenge.accepts.filter(quote => hash(quote) === hash(result.requirement));
    if (matches.length !== 1 || matches[0].network !== DEVNET_NETWORK || matches[0].asset !== DEVNET_USDC_MINT) throw new Error('PAY_EXECUTOR_QUOTE_SELECTION_MISMATCH');
    calls.quote++;
    return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(result.challenge)).toString('base64') } });
  };
  return { executor, quoteFetcher, invalidate: () => executor.invalidate?.(),
    get calls() { return { ...calls }; },
    close() { alive = false; generation++; prepared.clear(); if (owners.get(directory) === owner) owners.delete(directory); } };
}
