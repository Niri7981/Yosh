import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { assertPaymentConfigExecutionEnabled, DEVNET_GENESIS, PAYMENT_AMOUNT, TOKEN_PROGRAM, type PaymentConfig } from "./payment-config";
import { readPaymentJson } from './read-payment-json';
import { safeResourceFetch } from '../resources/safe-resource-fetch';

const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const REQUEST_TIMEOUT_MS = 10_000;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

export async function getStandardTokenAccount(owner: string, mint: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(address(owner)), encoder.encode(address(TOKEN_PROGRAM)), encoder.encode(address(mint))],
  });
  return ata;
}

export type PaymentPreflightSummary = {
  cluster: PaymentConfig["cluster"];
  network: PaymentConfig["network"];
  mint: string;
  paymentAmount: string;
  buyer: { publicKey: string; ata: string; balanceBaseUnits: string };
  merchant: { publicKey: string; ata: string; balanceBaseUnits: string };
  facilitator: { feePayer: string; feePayerLamports: number };
  readyForSettlement: true;
};

/** Stable, non-sensitive classifications for read-only quote inspection. */
export function classifyPaymentPreflightError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Merchant standard associated token account')) return 'RECIPIENT_TOKEN_ACCOUNT_UNAVAILABLE';
  if (message.startsWith('Buyer standard associated token account')) return 'BUYER_TOKEN_ACCOUNT_UNAVAILABLE';
  if (message.startsWith('Buyer associated token account has less')) return 'INSUFFICIENT_USDC';
  if (message.startsWith('Facilitator fee payer must have SOL')) return 'FEE_PAYER_SOL_INSUFFICIENT';
  if (message.startsWith('Facilitator does not support')) return 'FACILITATOR_QUOTE_MISMATCH';
  if (message.startsWith('Facilitator supported') || message.startsWith('A bound Mainnet quote fee payer')
    || message.startsWith('Mainnet requires sponsored') || message.startsWith('Facilitator supported response')) return 'FACILITATOR_QUOTE_INVALID';
  if (message.startsWith('RPC genesis hash')) return 'RPC_NETWORK_MISMATCH';
  if (message.startsWith('RPC ') || message.startsWith('Payment mint')) return 'RPC_PAYMENT_ASSET_UNVERIFIED';
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'PAYMENT_PREFLIGHT_FAILED';
}

/** Fail closed; never include RPC URLs, provider payloads, or credentials in errors. */
export async function runPaymentPreflight(
  config: PaymentConfig,
  dependencies: { fetch?: typeof fetch; amount?: string; feePayer?: string } = {},
): Promise<PaymentPreflightSummary> {
  // Read-only readiness is not available for disabled production or simulation execution.
  assertPaymentConfigExecutionEnabled(config);
  const amount = dependencies.amount ?? PAYMENT_AMOUNT;
  if (!/^[1-9]\d*$/.test(amount)) throw new Error("Invalid payment amount");
  const fetcher = dependencies.fetch || (config.mode === 'live_mainnet' && process.env.YOSH_PAY_MCP_MAINNET === '1'
    ? (input: string | URL | Request, init?: RequestInit) => safeResourceFetch(new URL(input instanceof Request ? input.url : String(input)).href, init ?? {}) : fetch);
  async function json(url: string, label: string, init: RequestInit = {}): Promise<JsonObject> {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
      if (!response.ok) throw new Error();
      return object(await readPaymentJson(response));
    } catch {
      throw new Error(`${label} request failed or timed out`);
    }
  }
  async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const response = await json(config.rpcUrl, `RPC ${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.error || !("result" in response)) throw new Error(`RPC ${method} returned an error`);
    return response.result;
  }

  const genesis = await rpc("getGenesisHash");
  if (typeof genesis !== "string" || (config.cluster !== "localnet" && genesis !== config.genesisHash)) {
    throw new Error(config.cluster === 'mainnet-beta' ? 'RPC genesis hash does not match Solana Mainnet' : 'RPC genesis hash does not match Solana Devnet');
  }
  if (config.cluster === "localnet" && (genesis === DEVNET_GENESIS
    || genesis.startsWith("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
    || (config.genesisHash !== null && genesis !== config.genesisHash)
    || (config.network !== "solana:localnet" && config.network !== `solana:${genesis.slice(0, 32)}`))) {
    throw new Error("RPC genesis hash does not match the configured local test chain");
  }
  // A Mainnet buyer receives the fee payer in the merchant's bound 402 quote.
  // The merchant, not Yosh, selects and calls its settlement facilitator. A
  // separate public /supported endpoint may advertise another sponsor and is
  // therefore not evidence that it will settle this merchant's transaction.
  let rawFeePayer: unknown = dependencies.feePayer;
  if (config.facilitatorUrl !== null) {
    const supportedUrl = new URL(config.facilitatorUrl);
    supportedUrl.pathname = `${supportedUrl.pathname.replace(/\/$/, "")}/supported`;
    const supported = await json(supportedUrl.toString(), "Facilitator supported");
    const kind = (Array.isArray(supported.kinds) ? supported.kinds : []).map(object).find(
      (item) => item.x402Version === 2 && item.scheme === "exact" && item.network === config.network
        && (dependencies.feePayer === undefined || object(item.extra).feePayer === dependencies.feePayer),
    );
    if (!kind) throw new Error("Facilitator does not support x402 v2 exact payments on the configured network");
    rawFeePayer = object(kind.extra).feePayer;
  } else if (config.mode !== 'live_mainnet' || dependencies.feePayer === undefined) {
    throw new Error('A bound Mainnet quote fee payer is required');
  }
  let feePayer: string;
  try {
    if (typeof rawFeePayer !== "string") throw new Error();
    feePayer = address(rawFeePayer);
  } catch {
    throw new Error("Facilitator supported response must provide a valid feePayer");
  }
  if (config.mode === 'live_mainnet' && feePayer === config.buyer) throw new Error('Mainnet requires sponsored transaction fees');
  const [buyerAta, merchantAta] = await Promise.all([
    getStandardTokenAccount(config.buyer, config.mint), getStandardTokenAccount(config.merchant, config.mint),
  ]);
  const [accounts, feeBalance] = await Promise.all([
    rpc("getMultipleAccounts", [[config.mint, buyerAta, merchantAta], { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc("getBalance", [feePayer, { commitment: "confirmed" }]),
  ]);
  const values = object(accounts).value;
  if (!Array.isArray(values) || values.length !== 3) throw new Error("RPC returned invalid token accounts");
  const [mintAccount, buyerAccount, merchantAccount] = values.map(object);
  const parsedMint = object(object(mintAccount.data).parsed);
  const mintInfo = object(parsedMint.info);
  if (mintAccount.owner !== TOKEN_PROGRAM || parsedMint.type !== "mint" || mintInfo.decimals !== 6 || mintInfo.isInitialized !== true) {
    throw new Error("Payment mint must be an initialized classic SPL token with 6 decimals");
  }
  function tokenBalance(account: JsonObject, owner: string, label: string): string {
    const parsed = object(object(account.data).parsed);
    const info = object(parsed.info);
    const amount = object(info.tokenAmount);
    if (account.owner !== TOKEN_PROGRAM || parsed.type !== "account" || info.owner !== owner || info.mint !== config.mint
      || info.state !== "initialized" || amount.decimals !== 6 || typeof amount.amount !== "string" || !/^\d+$/.test(amount.amount)) {
      throw new Error(`${label} standard associated token account is missing, frozen, or invalid`);
    }
    return amount.amount;
  }
  const buyerBalance = tokenBalance(buyerAccount, config.buyer, "Buyer");
  const merchantBalance = tokenBalance(merchantAccount, config.merchant, "Merchant");
  if (BigInt(buyerBalance) < BigInt(amount)) throw new Error(amount === PAYMENT_AMOUNT ? "Buyer associated token account has less than 0.01 USDC" : "Buyer associated token account has less than the quoted amount");
  const feePayerLamports = object(feeBalance).value;
  // Two signatures at 5,000 lamports plus the SDK's minimal priority fee.
  if (typeof feePayerLamports !== "number" || !Number.isSafeInteger(feePayerLamports) || feePayerLamports < 10_001) {
    throw new Error("Facilitator fee payer must have SOL for transaction fees");
  }
  return {
    cluster: config.cluster, network: config.network, mint: config.mint, paymentAmount: amount,
    buyer: { publicKey: config.buyer, ata: buyerAta, balanceBaseUnits: buyerBalance },
    merchant: { publicKey: config.merchant, ata: merchantAta, balanceBaseUnits: merchantBalance },
    facilitator: { feePayer, feePayerLamports }, readyForSettlement: true,
  };
}
