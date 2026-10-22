import { z } from 'zod';
import { hash } from '../purchases/spending-policy';
import { assertPayControlledExtensions, validateResourceChallenge } from './resource-challenge';
import { MAINNET_NETWORK, MAINNET_USDC_MINT, resolvePaymentEnvironment } from './payment-environment';

export const MAINNET_REFERENCE_API = 'https://agent402.tools/api/crypto-price?coins=BTC%2CETH%2CSOL&currency=usd';
export const MAINNET_REFERENCE_RPC = 'https://api.mainnet-beta.solana.com/';

/** Quote compatibility only. No runtime, wallet, grant, ledger, signer or sender.
 * Keep the observed envelope intact; stripping metadata to obtain a passing
 * result would not prove that the actual Pay MCP request is compatible. */
export function inspectPayMainnetQuote(raw: unknown, url = MAINNET_REFERENCE_API) {
  const request = { method: 'GET' as const, url: z.url().parse(url), access: 'https' as const, headers: { accept: 'application/json' } };
  const environment = resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
  const { challenge, quote } = validateResourceChallenge(raw, { resourceId: 'mainnet-acceptance-reference',
    providerId: 'mainnet-acceptance-reference', request, network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT,
    decimals: 6, maximumAmount: '1000', recipientSource: 'live_challenge', deliveryRecovery: { kind: 'none' } }, environment);
  const blockers: string[] = [];
  try { assertPayControlledExtensions(challenge); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('PAY_CONTROLLED_')) throw error;
    blockers.push(error.message);
  }
  // A route identifies the resource, not the exact HTTP request. Bind both,
  // together with every alternative/extension, without rewriting either URL.
  const immutableRequest = { method: request.method, url: request.url,
    headers: Object.entries(request.headers), body: null };
  return { paymentSent: false, signerUsed: false, quoteHash: hash(quote), challengeHash: hash(challenge),
    requestHash: hash(immutableRequest), requestQuoteBindingHash: hash([immutableRequest, challenge, quote]),
    network: quote.network, asset: quote.asset, amountAtomic: quote.amount, recipient: quote.payTo,
    feePayer: String(quote.extra.feePayer), maxTimeoutSeconds: quote.maxTimeoutSeconds,
    extensionNames: Object.keys(challenge.extensions ?? {}), yoshQuoteCompatible: true,
    controlledEnvelopeCompatible: blockers.length === 0, blockers, executionEnabled: false,
    remainingExecutionGates: ['MAINNET_AUTHORITY_ADMISSION_DISABLED', 'PUBLIC_RPC_CONTROLLED_PREPARE_NOT_ENABLED',
      'CONTROLLED_KEYCHAIN_SIGNER_NOT_WIRED', 'STOP_OLD_START_NEW_UPGRADE_NOT_VERIFIED', 'USER_PAYMENT_CONFIRMATION_REQUIRED'],
    deliveryRecovery: 'not_advertised_or_verified' };
}
