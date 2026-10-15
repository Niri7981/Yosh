import { ExactSvmScheme } from "@x402/svm/exact/client";
import { x402Client } from "@x402/core/client";
import { getBase64EncodedWireTransaction, type TransactionSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { isDeepStrictEqual } from "node:util";
import { assertPaymentConfigExecutionEnabled, DEVNET_NETWORK, PAYMENT_AMOUNT, type PaymentConfig } from "./payment-config";
import { readPaymentRequiredHeader } from "./x402-client";
import { validX402Memo } from './resource-challenge';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';
import { SolanaPublicKeySchema, X402ChallengeSchema, type X402Challenge } from '../resources/http-resource';
import { runPaymentPreflight } from './payment-preflight';
import { assertUnsignedPaymentBindings } from './original-payment-evidence';
import { readPaymentJson } from './read-payment-json';

export const MARKET_RESOURCE = "/api/paid/market-snapshot?asset=SOL";

export type AuthorizedPayment = { amount: string; resource: string; challenge?: X402Challenge };

/** Supplied by the purchase service; checks must complete before signing can begin. */
export type PaymentSigningAuthorization = {
  assertCanSign(requirement: PaymentRequirements, authorized: AuthorizedPayment): undefined;
};

export function selectPaymentQuote(encoded: string, config: PaymentConfig, feePayer: string) {
  if (encoded.length > 16_384) throw new Error("Payment quote is too large");
  const quote = readPaymentRequiredHeader(encoded);
  if (quote.resource.url !== MARKET_RESOURCE || quote.accepts.length !== 1) {
    throw new Error("Unexpected resource or payment options");
  }
  const requirement = quote.accepts[0];
  if (requirement.scheme !== "exact" || requirement.network !== config.network ||
      requirement.asset !== config.mint || requirement.payTo !== config.merchant ||
      requirement.amount !== PAYMENT_AMOUNT || requirement.extra?.feePayer !== feePayer ||
      !validX402Memo(requirement.extra?.memo) || requirement.maxTimeoutSeconds > 300 ||
      requirement.maxTimeoutSeconds <= 0) {
    throw new Error("Quote does not match the fixed payment");
  }
  return requirement as PaymentRequirements;
}

export async function solanaRpc<T>(config: Pick<PaymentConfig, "rpcUrl">, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(config.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);
  const body = await readPaymentJson(response);
  if (typeof body !== 'object' || body === null || !('result' in body) || ('error' in body && body.error)) throw new Error(`RPC ${method} failed`);
  return body.result as T;
}

// The signer stays inside this script-only payment boundary. No Agent/UI import.
export async function prepareSolanaPayment(
  config: PaymentConfig, signer: TransactionSigner, requirement: PaymentRequirements,
  onSimulation: () => void = () => {},
  authorized: AuthorizedPayment = { amount: PAYMENT_AMOUNT, resource: MARKET_RESOURCE },
  onLifetime: (lifetime: { recentBlockhash: string; lastValidBlockHeight: string }) => void = () => {},
  production?: PaymentSigningAuthorization,
): Promise<PaymentPayload> {
  assertPaymentConfigExecutionEnabled(config);
  const productionGuard = () => {
    if (config.mode !== 'live_mainnet') return;
    if (!production) throw new Error('MAINNET_RESERVED_APPROVAL_REQUIRED');
    production.assertCanSign(requirement, authorized);
  };
  productionGuard();
  if (requirement.scheme !== "exact" || requirement.network !== config.network || requirement.asset !== config.mint ||
      requirement.payTo !== config.merchant || requirement.amount !== authorized.amount || !PositiveAtomicAmountSchema.safeParse(authorized.amount).success
      || !SolanaPublicKeySchema.safeParse(requirement.extra?.feePayer).success || !validX402Memo(requirement.extra?.memo)
      || !Number.isSafeInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds <= 0 || requirement.maxTimeoutSeconds > (authorized.challenge ? 600 : 300)
      || (requirement.extra?.paymentFlow != null && requirement.extra.paymentFlow !== 'authorization')
      || (requirement.extra?.assetTransferMethod != null && requirement.extra.assetTransferMethod !== 'default')) {
    throw new Error("Signer rejected a payment outside the fixed payment configuration");
  }
  if (signer.address !== config.buyer || !("signTransactions" in signer)) {
    throw new Error("A partial signer matching the configured buyer is required");
  }
  if (config.mode === 'live_mainnet') {
    const preflight = await runPaymentPreflight(config, { amount: requirement.amount, feePayer: String(requirement.extra?.feePayer) });
    if (preflight.facilitator.feePayer !== requirement.extra?.feePayer) throw new Error('Quote fee payer changed');
    productionGuard();
  }
  let productionSignatureStarted = false;
  const checkedSigner: TransactionSigner = {
    address: signer.address,
    async signTransactions(transactions, signingConfig) {
      if (config.mode === 'live_mainnet' && (transactions.length !== 1 || productionSignatureStarted)) throw new Error('MAINNET_SINGLE_SIGNATURE_REQUIRED');
      for (const transaction of transactions) {
        if (config.mode === 'live_mainnet') assertUnsignedPaymentBindings(getBase64EncodedWireTransaction(transaction), config, requirement);
        const result = await solanaRpc<{ value: { err: unknown } }>(config, "simulateTransaction", [
          getBase64EncodedWireTransaction(transaction),
          { encoding: "base64", sigVerify: false, commitment: "confirmed" },
        ]);
        if (result?.value?.err !== null) throw new Error('Payment simulation failed; nothing was signed or submitted');
      }
      for (const transaction of transactions) {
        const lifetime = transaction.lifetimeConstraint;
        if (lifetime && 'blockhash' in lifetime && 'lastValidBlockHeight' in lifetime) {
          onLifetime({ recentBlockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() });
        }
      }
      onSimulation();
      productionGuard();
      if (config.mode === 'live_mainnet') {
        if (productionSignatureStarted) throw new Error('MAINNET_SINGLE_SIGNATURE_REQUIRED');
        productionSignatureStarted = true;
      }
      return signer.signTransactions(transactions, signingConfig);
    },
  };
  // Use our RPC for blockhashes instead of trusting a remote quote's optional hints.
  // SDK 2.25 dispatches RPC clients only for named Solana clusters. The explicit
  // loopback RPC remains authoritative for localnet; the wire quote keeps its real network.
  const safeExtra = { ...requirement.extra };
  for (const key of ['blockhash', 'recentBlockhash', 'lastValidBlockHeight', 'rpcUrl', 'feePayerRpcUrl']) delete safeExtra[key];
  const safeRequirement = { ...requirement, network: config.cluster === "localnet" ? DEVNET_NETWORK : requirement.network, extra: safeExtra };
  const challenge = authorized.challenge ? X402ChallengeSchema.parse(authorized.challenge) : undefined;
  if (challenge && (challenge.accepts.filter(item => isDeepStrictEqual(item, requirement)).length !== 1
    || !(challenge.resource.url === authorized.resource || (() => {
      try { const route = new URL(challenge.resource.url); const request = new URL(authorized.resource);
        return route.origin === request.origin && route.pathname === request.pathname && !route.search && !route.hash; }
      catch { return false; }
    })()))) throw new Error('Approval challenge changed');
  const scheme = new ExactSvmScheme(checkedSigner, { rpcUrl: config.rpcUrl });
  const client = new x402Client()
    .register(safeRequirement.network, scheme)
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: safeRequirement.network, asset: safeRequirement.asset, maxAmountPerPayment: authorized.amount }],
    })
    .registerPolicy((_version, requirements) => requirements.filter(candidate => isDeepStrictEqual(candidate, safeRequirement)));
  const created = await client.createPaymentPayload({
    x402Version: 2,
    resource: challenge?.resource ?? { url: authorized.resource },
    ...(challenge?.extensions ? { extensions: challenge.extensions } : {}),
    accepts: challenge ? challenge.accepts.map(item => isDeepStrictEqual(item, requirement) ? safeRequirement : item) : [safeRequirement],
  });
  return { ...created, accepted: requirement };
}

export async function confirmSolanaTransaction(config: PaymentConfig, transaction: string) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await solanaRpc<{ value: Array<null | { err: unknown; confirmationStatus: string }> }>(
      config, "getSignatureStatuses", [[transaction], { searchTransactionHistory: true }],
    );
    const status = result?.value?.[0];
    if (status && status.err !== null) throw new Error("Transaction failed on chain or returned an invalid status");
    if (status?.err === null && ["confirmed", "finalized"].includes(status.confirmationStatus)) return status.confirmationStatus;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Confirmation is UNKNOWN; reuse the saved payment, do not create another");
}
