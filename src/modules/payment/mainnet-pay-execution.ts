import { assertIsTransactionWithinSizeLimit, blockhash, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit';
import { z } from 'zod';
import { assertPaymentConfigExecutionEnabled, DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_NETWORK, MAINNET_USDC_MINT, type PaymentConfig } from './payment-config';
import type { PaymentExecutor, PaymentExecutionContext } from './payment-execution-contract';
import { loadBuyerSigner } from './wallet';
import { runPaymentPreflight } from './payment-preflight';
import { solanaRpc } from './solana-payment';
import { PreparedSchema } from './isolated-pay-execution';
import { assertUnsignedPaymentBindings, decodeOriginalTransaction } from './original-payment-evidence';
import { X402ChallengeSchema, SolanaPublicKeySchema } from '../resources/http-resource';
import type { PurchaseLedger } from '../purchases/purchase-ledger';
import { assertPayMainnetAcceptance } from './pay-mainnet-control';
import { isDevnetDevelopment } from '../pay-dev/environment';

export async function readPayMainnetLifetime(config: PaymentConfig) {
  return readPayLifetime(config, 'mainnet');
}

export async function readPayLifetime(config: PaymentConfig, network: 'mainnet' | 'devnet') {
  assertPaymentConfigExecutionEnabled(config);
  if (network === 'mainnet' ? config.mode !== 'live_mainnet' || config.network !== MAINNET_NETWORK || config.mint !== MAINNET_USDC_MINT
    : config.mode !== 'live_devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT
      || config.isProduction || config.productionExecutionEnabled) throw new Error(network === 'mainnet' ? 'PAY_MAINNET_CONFIGURATION_REQUIRED' : 'PAY_DEVNET_CONFIGURATION_REQUIRED');
  if (await solanaRpc<unknown>(config, 'getGenesisHash') !== config.genesisHash) throw new Error('PAY_RPC_NETWORK_MISMATCH');
  const latest = z.object({ value: z.object({ blockhash: SolanaPublicKeySchema,
    lastValidBlockHeight: z.number().int().safe().positive() }) }).parse(await solanaRpc<unknown>(config, 'getLatestBlockhash', [{ commitment: 'confirmed' }]));
  return { recentBlockhash: latest.value.blockhash, lastValidBlockHeight: String(latest.value.lastValidBlockHeight) };
}

/** Pay builds unsigned bytes; only Yosh can load the existing product signer.
 * Persistence, the final HTTP marker, transport and reconciliation remain in
 * executeApprovedPayment. There is no alternative sender or transaction retry. */
export function createMainnetPayExecution(options: {
  takeUnsigned: (context: PaymentExecutionContext) => Promise<unknown>;
}) {
  return createPayExecution({ ...options, network: 'mainnet' });
}

/** Both live networks use the same custody and original-payment path. Devnet
 * admission selects its isolated profile; it never relaxes Mainnet approval. */
export function createPayExecution(options: {
  network: 'mainnet' | 'devnet';
  takeUnsigned: (context: PaymentExecutionContext) => Promise<unknown>;
}) {
  const mainnet = options.network === 'mainnet';
  let ledger: PurchaseLedger | undefined;
  let directory = '';
  let generation = 0;
  const claims = new Map<string, { context: PaymentExecutionContext; generation: number; started: boolean }>();
  const assertCurrent = (context: PaymentExecutionContext) => {
    const claim = claims.get(context.record.approvalId);
    if (!claim || claim.context !== context || claim.generation !== generation) throw new Error('PAY_EXECUTOR_STALE_GENERATION');
    context.beforeSign();
    const row = ledger?.executionSafety.provenance(context.record.intent.id);
    if (row?.origin !== 'external_pay') throw new Error('EXTERNAL_PROVENANCE_REQUIRED');
    if (mainnet) {
      const request = context.record.intent.httpRequest!;
      assertPayMainnetAcceptance(directory, context.config, { caller_id: String(row.caller_id), operation_id: String(row.operation_id),
        request: { method: request.method, url: request.url, headers: Object.entries(request.headers).sort(), body: request.body ?? null },
        accepted: context.record.quote, payment_required: context.record.intent.x402Challenge, network: context.record.quote.network,
        asset: context.record.quote.asset, recipient: context.record.quote.payTo, amount_atomic: context.record.quote.amount }, {
        resourceId: context.record.intent.resourceId, providerId: context.record.intent.providerId, resourceUrl: request.url });
    }
  };
  const eligibility = (config: PaymentConfig, target: PurchaseLedger) => {
    assertPaymentConfigExecutionEnabled(config);
    if (mainnet ? process.env.YOSH_PAY_MCP_MAINNET !== '1' || target !== ledger || !ledger.executionSafety.active
      || config.mode !== 'live_mainnet' || config.network !== MAINNET_NETWORK || config.mint !== MAINNET_USDC_MINT
      : process.env.YOSH_PAY_MCP_DEVNET !== '1' || !isDevnetDevelopment(directory) || target !== ledger || !ledger.executionSafety.active
        || config.mode !== 'live_devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT
        || config.isProduction || config.productionExecutionEnabled)
      throw new Error(mainnet ? 'PAY_MAINNET_CONFIGURATION_REQUIRED' : 'PAY_DEVNET_CONFIGURATION_REQUIRED');
  };
  const executor: PaymentExecutor = {
    bindRuntime(path, target) { if (ledger) throw new Error('PAY_RUNTIME_ALREADY_BOUND'); directory = path; ledger = target; },
    assertEligibility: eligibility,
    invalidate() { generation++; },
    beginPreparation(context) {
      if (claims.has(context.record.approvalId)) throw new Error('PAY_OPERATION_ALREADY_STARTED');
      claims.set(context.record.approvalId, { context, generation, started: false });
    },
    async prepare(context) {
      if (!ledger) throw new Error('PAY_RUNTIME_REQUIRED');
      eligibility(context.config, ledger); assertCurrent(context);
      const claim = claims.get(context.record.approvalId)!;
      if (claim.started) throw new Error('PAY_OPERATION_ALREADY_STARTED');
      claim.started = true;
      const value = PreparedSchema.parse(await options.takeUnsigned(context));
      const decoded = decodeOriginalTransaction(value.transaction).transaction;
      if (decoded.signatures.some(signature => signature.some(byte => byte !== 0))
        || decoded.message.recentBlockhash !== value.recentBlockhash) throw new Error('PAY_UNSIGNED_REQUIRED');
      assertUnsignedPaymentBindings(value.transaction, context.config, context.record.quote);
      await runPaymentPreflight(context.config, { amount: context.record.quote.amount, feePayer: String(context.record.quote.extra.feePayer) });
      const simulation = await solanaRpc<unknown>(context.config, 'simulateTransaction', [value.transaction,
        { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
      z.object({ value: z.object({ err: z.null() }) }).parse(simulation);
      assertCurrent(context);
      if (mainnet) context.production?.assertCanSign(context.record.quote, { amount: context.record.intent.amount,
        resource: context.endpoint, challenge: X402ChallengeSchema.parse(context.record.intent.x402Challenge) });
      const signer = await loadBuyerSigner(context.config.buyer, process.env, context.config);
      assertCurrent(context);
      if (signer.address !== context.config.buyer || (mainnet && !context.production)) throw new Error(mainnet ? 'MAINNET_RESERVED_APPROVAL_REQUIRED' : 'PAY_DEVNET_SIGNER_MISMATCH');
      if (mainnet) context.production!.assertCanSign(context.record.quote, { amount: context.record.intent.amount,
        resource: context.endpoint, challenge: X402ChallengeSchema.parse(context.record.intent.x402Challenge) });
      const unsigned = { ...getTransactionDecoder().decode(Buffer.from(value.transaction, 'base64')),
        lifetimeConstraint: { blockhash: blockhash(value.recentBlockhash), lastValidBlockHeight: BigInt(value.lastValidBlockHeight) } };
      assertIsTransactionWithinSizeLimit(unsigned);
      const signatures = await signer.signTransactions([unsigned]);
      if (signatures.length !== 1 || Object.keys(signatures[0]).some(address => address !== signer.address)) throw new Error('PAY_SINGLE_BUYER_SIGNATURE_REQUIRED');
      assertCurrent(context);
      const transaction = getBase64EncodedWireTransaction({ ...unsigned, signatures: { ...unsigned.signatures, ...signatures[0] } });
      const challenge = X402ChallengeSchema.parse(context.record.intent.x402Challenge);
      return { payload: { x402Version: 2, accepted: context.record.quote, resource: challenge.resource,
        ...(challenge.extensions ? { extensions: challenge.extensions } : {}), payload: { transaction } },
        lifetime: { recentBlockhash: value.recentBlockhash, lastValidBlockHeight: value.lastValidBlockHeight } };
    },
    assertBeforeSubmission(context) { assertCurrent(context); claims.delete(context.record.approvalId); },
  };
  return executor;
}
