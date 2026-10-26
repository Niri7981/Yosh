import type { PaymentEnvironment } from '../payment/payment-environment';
import type { PurchaseLedger } from '../purchases/purchase-ledger';
import type { PaymentConfig } from '../payment/payment-config';
import type { FacilitatorConfigurationCode } from '../payment/payment-config';
import type { X402Resource } from '../resources/http-resource';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../authority/spend-grant';

export type AuthorityWalletState = 'unavailable' | 'unverified' | 'available';
type Check = { ready: boolean; code: string | null };
export type AuthorityReadinessContext = {
  resourceId?: string;
  registeredLive?: boolean;
  facilitator?: { ready: boolean; code: FacilitatorConfigurationCode | null; mode: 'merchant_quote' | 'configured_endpoint' };
  connectionEnabled?: boolean;
  serviceAccepting?: boolean;
  configurationCode?: string | null;
};

function check(code: string | null): Check { return { ready: code === null, code }; }

function registeredForEnvironment(ledger: PurchaseLedger, environment: PaymentEnvironment): X402Resource[] {
  return ledger.resources.active().filter(resource => resource.network === environment.network
    && resource.mint === environment.asset.mint && resource.decimals === environment.asset.decimals);
}

/** Read-only local prerequisites. A fresh quote and RPC/facilitator preflight still gate each purchase. */
export function authoritySurface(ledger: PurchaseLedger, environment: PaymentEnvironment, memberId: string,
  wallet: { address: string; status: AuthorityWalletState; balance: string | null }, config: PaymentConfig | undefined, now: number,
  context: AuthorityReadinessContext = {}) {
  const registeredLive = environment.isProduction || context.registeredLive === true;
  const budget = ledger.managedSummary(now, environment.mode);
  const grant = ledger.spendGrantSummary(now, environment.mode, memberId, context.resourceId);
  const assetLabel = environment.isProduction ? environment.asset.symbol : `Test ${environment.asset.symbol}`;
  const number = (value: string) => {
    const amount = BigInt(value); const divisor = 10n ** BigInt(environment.asset.decimals);
    const fraction = String(amount % divisor).padStart(environment.asset.decimals, '0').replace(/0+$/, '').padEnd(2, '0');
    return `${amount / divisor}.${fraction}`;
  };
  const dailyState = budget.dailyLimit === null ? 'required' : budget.paused ? 'paused'
    : BigInt(budget.remaining ?? '0') === 0n ? 'insufficient' : 'active';
  // The registry is the purchase gate's authoritative resource source. Do not
  // project it through PaymentConfig: a facilitator error must not hide it.
  const resources = registeredForEnvironment(ledger, environment);
  const resource = resources.find(item => item.resourceId === grant?.resourceId);
  const scopeMatches = grant !== null && grant.network === environment.network && grant.assetId === environment.asset.mint
    && grant.assetDecimals === environment.asset.decimals;
  const grantScopeMatches = scopeMatches && (!registeredLive || (resource !== undefined
    && resource.providerId === grant.providerId && (resource.recipientSource === 'live_challenge' || resource.recipient === grant.payTo)
    && grant.operation === PAID_RESOURCE_PURCHASE_OPERATION && grant.paymentScheme === 'exact'));
  const environmentCheck = check(environment.mode === 'simulated' ? 'SIMULATED_EXECUTION_DISABLED'
    : environment.isProduction && !environment.productionExecutionEnabled ? 'MAINNET_EXECUTION_DISABLED' : null);
  const facilitator = context.facilitator ?? { ready: true, code: null,
    mode: config?.facilitatorUrl === null || environment.isProduction ? 'merchant_quote' as const : 'configured_endpoint' as const };
  const facilitatorCheck = check(facilitator.ready ? null : facilitator.code ?? 'FACILITATOR_CONFIGURATION_INVALID');
  const walletCheck = check(wallet.status === 'unavailable' ? 'WALLET_UNAVAILABLE'
    : wallet.status === 'unverified' ? 'WALLET_UNVERIFIED'
      : registeredLive && wallet.balance === null ? 'USDC_BALANCE_UNVERIFIED'
        : registeredLive && BigInt(wallet.balance ?? '0') === 0n ? 'INSUFFICIENT_USDC' : null);
  const dailyCheck = check(dailyState === 'required' ? 'DAILY_AUTHORITY_REQUIRED'
    : dailyState === 'paused' ? 'PAYMENTS_PAUSED'
      : dailyState === 'insufficient' ? 'DAILY_AUTHORITY_INSUFFICIENT' : null);
  const resourceCheck = check(!registeredLive ? null : resources.length === 0 ? 'REGISTERED_RESOURCE_REQUIRED'
    : grant && !resource ? 'GRANT_RESOURCE_UNREGISTERED' : null);
  const grantCheck = check(!grant ? 'SPEND_GRANT_REQUIRED'
    : grant.status === 'EXPIRED' || grant.expiresAt <= now ? 'SPEND_GRANT_EXPIRED'
      : grant.status === 'REVOKED' ? 'SPEND_GRANT_REVOKED'
        : !scopeMatches || (registeredLive && resource && !grantScopeMatches) ? 'SPEND_GRANT_SCOPE_MISMATCH'
          : BigInt(grant.remaining) === 0n ? 'SPEND_GRANT_EXHAUSTED' : null);
  const connectionCheck = check(context.connectionEnabled === false ? 'AGENT_CONNECTION_REQUIRED' : null);
  const serviceCheck = check(context.serviceAccepting === false ? 'SERVICE_STOPPING' : null);
  const localChecks = [environmentCheck, facilitatorCheck, walletCheck, dailyCheck, resourceCheck, grantCheck, connectionCheck, serviceCheck];
  const configurationCheck = check(context.configurationCode ?? null);
  const firstFailure = [...localChecks, configurationCheck].find(item => !item.ready)?.code ?? null;
  const transactionExecution = { eligible: firstFailure === null, code: firstFailure, quotePreflightRequired: true as const };
  const readiness = { environment: environmentCheck, facilitator: { ...facilitatorCheck, mode: facilitator.mode,
    verification: environment.isProduction ? 'quote_required' as const : 'configuration_only' as const }, wallet: walletCheck,
    dailyAuthority: dailyCheck, resourceRegistration: resourceCheck, spendGrantAuthorization: grantCheck,
    paymentConfiguration: configurationCheck,
    agentConnection: connectionCheck, service: serviceCheck, transactionExecution };
  const blockers: string[] = [];
  if (environment.isProduction) {
    if (!environmentCheck.ready) blockers.push('Mainnet execution is disabled');
    if (!facilitatorCheck.ready) blockers.push(facilitatorCheck.code === 'FACILITATOR_CONFIGURATION_REQUIRED'
      ? 'Payment facilitator setup required' : 'Payment facilitator configuration invalid');
    if (dailyState === 'required') blockers.push('Daily Authority required');
    else if (dailyState === 'paused') blockers.push('Payments are paused');
    else if (dailyState === 'insufficient') blockers.push('Insufficient available authority');
    if (resourceCheck.code === 'REGISTERED_RESOURCE_REQUIRED') blockers.push('Registered API setup required');
    else if (resourceCheck.code === 'GRANT_RESOURCE_UNREGISTERED') blockers.push('Registered API for Spend Grant unavailable');
    if (grantCheck.code === 'SPEND_GRANT_REQUIRED') blockers.push('Spend Grant required');
    else if (grantCheck.code === 'SPEND_GRANT_EXPIRED') blockers.push('Spend Grant expired');
    else if (grantCheck.code === 'SPEND_GRANT_REVOKED') blockers.push('Spend Grant revoked');
    else if (grantCheck.code === 'SPEND_GRANT_SCOPE_MISMATCH') blockers.push('Spend Grant does not match registered API');
    else if (grantCheck.code === 'SPEND_GRANT_EXHAUSTED') blockers.push('Spend Grant exhausted');
    if (wallet.status === 'unavailable') blockers.push('Mainnet wallet unavailable');
    else if (wallet.status === 'unverified') blockers.push('Mainnet wallet verification required');
    if (wallet.status === 'available') {
      if (wallet.balance === null) blockers.push('USDC balance not verified');
      else if (BigInt(wallet.balance) === 0n) blockers.push('Insufficient USDC');
    }
    if (!connectionCheck.ready) blockers.push('Agent connection required');
    if (!serviceCheck.ready) blockers.push('Yosh is stopping');
    if (!configurationCheck.ready && ![facilitatorCheck.code, walletCheck.code, resourceCheck.code].includes(configurationCheck.code)) {
      blockers.push('Payment configuration invalid');
    }
  }
  return { mode: environment.mode, network: environment.network, assetId: environment.asset.mint, assetDecimals: environment.asset.decimals,
    assetLabel, dailyLimit: budget.dailyLimit, available: budget.remaining, reserved: budget.reserved, paid: budget.paid,
    availableDisplay: budget.remaining === null ? '—' : number(budget.remaining), reservedDisplay: number(budget.reserved), paidDisplay: number(budget.paid),
    dailyLimitDisplay: budget.dailyLimit === null ? 'Daily Authority required' : `of ${number(budget.dailyLimit)} ${assetLabel} daily`,
    dailyState, blockers, readiness, wallet: { address: wallet.address, status: wallet.status,
      network: environment.isProduction ? 'Solana Mainnet' : 'Solana Devnet' },
    grant: grant && scopeMatches ? { id: grant.id, resourceId: grant.resourceId, api: resource?.request.url ?? null,
      network: environment.isProduction ? 'Solana Mainnet' : 'Solana Devnet', assetLabel,
      totalDisplay: number(grant.totalLimit), remainingDisplay: number(grant.remaining), committedDisplay: number(grant.committed),
      singleDisplay: number(grant.singleLimit), status: grant.status, expiresAt: grant.expiresAt,
      usable: grantScopeMatches && grantCheck.ready && resourceCheck.ready } : null };
}
