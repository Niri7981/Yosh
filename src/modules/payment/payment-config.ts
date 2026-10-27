import { address } from "@solana/kit";
import { type X402Resource } from '../resources/http-resource';
import { loadRegisteredResources } from '../resources/registered-resources';
import { assertPaymentExecutionEnabled, PaymentEnvironmentError, paymentEndpoint, resolvePaymentEnvironment,
  type PaymentEnvironment, type PurchaseExecutionMode } from './payment-environment';
export { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_GENESIS, MAINNET_NETWORK,
  MAINNET_USDC_MINT, TOKEN_PROGRAM } from './payment-environment';
export const PAYMENT_AMOUNT = "10000";

export type PaymentConfig = PaymentEnvironment & Readonly<{
  /** Compatibility projection of asset.mint; not an independently configured asset. */
  mint: string;
  buyer: string;
  merchant: string;
  /** Mainnet merchants may sponsor their own quote; an override is optional there. */
  facilitatorUrl: string | null;
  /** Backend registration, never supplied by an Agent purchase request. */
  registeredResources?: readonly X402Resource[];
}>;

export type FacilitatorConfigurationCode = 'FACILITATOR_CONFIGURATION_REQUIRED' | 'FACILITATOR_CONFIGURATION_INVALID';

export class PaymentConfigurationError extends Error {
  constructor(readonly code: FacilitatorConfigurationCode, message: string) { super(message); }
}

/** One parser serves the installed-product status and the actual purchase configuration gate. */
export function resolveFacilitatorConfiguration(env: Record<string, string | undefined>,
  environment: Pick<PaymentEnvironment, 'mode' | 'cluster'>): string | null {
  const localnet = environment.cluster === 'localnet';
  const raw = env.X402_FACILITATOR_URL;
  if (raw === undefined && localnet) {
    throw new PaymentConfigurationError('FACILITATOR_CONFIGURATION_REQUIRED',
      'X402_FACILITATOR_URL is required for localnet');
  }
  if (raw === undefined && (environment.mode === 'live_mainnet' || env.YOSH_PAY_MCP_DEVNET === '1')) return null;
  const selected = raw === undefined ? 'https://x402.org/facilitator' : raw;
  let url: URL;
  try {
    if (selected !== selected.trim() || selected.length > 2048 || /[\u0000-\u001f\u007f]/.test(selected)) throw new Error();
    url = new URL(selected);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error();
  } catch {
    throw new PaymentConfigurationError('FACILITATOR_CONFIGURATION_INVALID', 'X402_FACILITATOR_URL must be a valid endpoint URL');
  }
  try { return paymentEndpoint(url.toString(), 'X402_FACILITATOR_URL', localnet); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'X402_FACILITATOR_URL is invalid';
    throw new PaymentConfigurationError('FACILITATOR_CONFIGURATION_INVALID', reason);
  }
}

export function inspectFacilitatorConfiguration(env: Record<string, string | undefined>,
  environment: Pick<PaymentEnvironment, 'mode' | 'cluster'>):
  { ready: true; code: null; mode: 'merchant_quote' | 'configured_endpoint' }
  | { ready: false; code: FacilitatorConfigurationCode; mode: 'configured_endpoint' } {
  try { const url = resolveFacilitatorConfiguration(env, environment);
    return { ready: true, code: null, mode: url === null ? 'merchant_quote' : 'configured_endpoint' }; }
  catch (error) {
    if (error instanceof PaymentConfigurationError) return { ready: false, code: error.code, mode: 'configured_endpoint' };
    throw error;
  }
}

function publicKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  try { return address(value); }
  catch { throw new Error(`${name} must be a valid Solana public key`); }
}

/** Resolve identity before touching wallet configuration. Mainnet has no Demo fallback. */
export function loadPaymentConfig(env: Record<string, string | undefined> = process.env,
  defaultMode: PurchaseExecutionMode = 'live_devnet', walletIdentity?: string): PaymentConfig {
  const environment = resolvePaymentEnvironment(env, defaultMode);
  if (environment.mode === 'live_mainnet') {
    if (Object.keys(env).some(key => key.startsWith('DEMO_'))) {
      throw new Error('MAINNET_WALLET_ISOLATION: Demo configuration is forbidden');
    }
    const buyer = publicKey(walletIdentity, 'Mainnet wallet identity');
    if (env.YOSH_MAINNET_WALLET_PUBLIC_KEY !== undefined && env.YOSH_MAINNET_WALLET_PUBLIC_KEY !== buyer) {
      throw new Error('MAINNET_WALLET_IDENTITY_MISMATCH');
    }
    const registeredResources = loadRegisteredResources(env, environment);
    if (registeredResources.length === 0) throw new Error('MAINNET_RESOURCE_REGISTRATION_REQUIRED');
    if (registeredResources.some(resource => resource.recipient === buyer)) throw new Error('MAINNET_RESOURCE_REGISTRATION_INVALID');
    const facilitatorUrl = resolveFacilitatorConfiguration(env, environment);
    // Parsed registration and the selected environment are captured for this service.
    return Object.freeze({ ...environment, mint: environment.asset.mint, buyer, merchant: registeredResources[0].recipient ?? '',
      facilitatorUrl, registeredResources: Object.freeze(registeredResources) });
  }
  if (env.YOSH_PAY_MCP_DEVNET === '1') {
    if (environment.mode !== 'live_devnet' || environment.cluster !== 'devnet'
      || Object.keys(env).some(key => key.startsWith('DEMO_'))) throw new Error('PAY_DEVNET_CONFIGURATION_REQUIRED');
    const buyer = publicKey(walletIdentity, 'Devnet wallet identity');
    const registeredResources = loadRegisteredResources(env, environment);
    if (!registeredResources.length) throw new Error('REGISTERED_RESOURCE_REQUIRED');
    if (registeredResources.some(resource => resource.recipient === buyer)) throw new Error('REGISTERED_RESOURCE_INVALID');
    return Object.freeze({ ...environment, mint: environment.asset.mint, buyer, merchant: registeredResources[0].recipient ?? '',
      facilitatorUrl: resolveFacilitatorConfiguration(env, environment), registeredResources: Object.freeze(registeredResources) });
  }
  const buyer = publicKey(env.DEMO_BUYER_PUBLIC_KEY, "DEMO_BUYER_PUBLIC_KEY");
  const merchant = publicKey(env.DEMO_MERCHANT_PUBLIC_KEY, "DEMO_MERCHANT_PUBLIC_KEY");
  if (buyer === merchant) throw new Error("Buyer and merchant must be different wallets");
  const facilitatorUrl = resolveFacilitatorConfiguration(env, environment);
  return Object.freeze({ ...environment, get mint() { return environment.asset.mint; }, buyer, merchant, facilitatorUrl });
}

export function assertPaymentConfigExecutionEnabled(config: PaymentConfig) {
  assertPaymentExecutionEnabled(config);
  if (config.mint !== config.asset.mint) throw new PaymentEnvironmentError('INVALID_PAYMENT_ENVIRONMENT', 'asset projection');
}
