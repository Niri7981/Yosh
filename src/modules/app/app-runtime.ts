import { readAgentPurchase } from '../purchases/agent-purchase-read';
import { randomUUID } from 'node:crypto';
import { StatementRegistration } from '../authority/local-statement-pairing';
import { describePurchaseResource, PurchaseResourceLookup } from '../mcp/purchase-resource-contract';
import { LocalHostPurchaseOwnerInput, LocalHostPurchasePlan, type HostPurchase } from '../mcp/local-host-purchase';
import { ResultInput, StatementInput } from '../mcp/account-read-contract';
import { checkSandboxDatabases, lookupSimulatedPurchase, purchaseInSimulator, sandboxWalletIdentity, simulationGrantScope, type RemotePurchaseConsent } from '../purchases/remote-simulated-purchase';
import { purchasePairingRequest, pairingRequest, type ReadScope, type ReadConsent } from '../remote/pairings';
import { IS_LOCAL_AUTH_DEVELOPMENT } from '../pay-dev/profile';
import { LocalControlAction, type LocalControlReceipt } from '../authority/local-control-approval';
import { basename, dirname, isAbsolute, resolve as resolveRuntimePath } from 'node:path';
import { isPayDevelopmentDirectory } from '../pay-dev/isolation';
import { IS_CODEX_PLUGIN_DEVELOPMENT } from '../pay-dev/profile';
import type { OfflineResourcePolicy } from '../pay-dev/offline-resource-policy';
import { admitDevnetDevelopment, admitSimulatedDevelopment, isDevnetDevelopment, isSimulatedDevelopment, assertDevelopmentStorage, isMainnetDevelopment } from '../pay-dev/environment';
import { readPayTrace } from '../payment/pay-execution-trace';
import { join } from 'node:path';
import { authoritySurface, type AuthorityWalletState } from './authority-surface';
import { homedir } from 'node:os';
import { initializeEnvironmentWallet, readExistingProductWallets } from '../app-wallet/product-wallet';
import type { WalletAccountObservation, WalletInventoryEntry } from '../app-wallet/wallet-accounts';
import { atomicAmount } from '../authority/atomic-money';
import { DEVNET_USDC_MINT, inspectFacilitatorConfiguration, loadPaymentConfig, PaymentConfigurationError } from '../payment/payment-config';
import { PurchaseLedger } from '../purchases/purchase-ledger';
import { executeApprovedPayment, paymentEndpointForIntent, recoverApprovedPayment, reconcileApprovedPayment } from '../purchases/approved-payment';
import type { PaymentExecutor } from '../payment/payment-execution-contract';
import type { MppChargeDependencies } from '../purchases/approved-mpp-charge';
import { requestMppResourcePurchase } from '../purchases/request-mpp-resource-purchase';
import { fetchMppResourceQuote } from '../payment/mpp-resource-charge';
import { assertIsolatedPaymentDirectory } from '../payment/isolated-pay-execution';
import { createPayExecution } from '../payment/mainnet-pay-execution';
import { createPayAuthorityAdapter } from '../payment/pay-authority-adapter';
import { admitPayMainnetRuntime, writePayMainnetDescriptor } from '../payment/pay-mainnet-control';
import { existsSync } from 'node:fs';
import { monetaryScopeId } from '../purchases/monetary-scope';
import { purchaseMarketSnapshot } from '../purchases/purchase-market-snapshot';
import { hash } from '../purchases/spending-policy';
import { AgentConnection } from '../mcp/connection';
import { CodexIntegration, type CodexIntegrationOptions } from '../mcp/codex-integration';
import { type McpSessionEvent } from '../mcp/session';
import { ManagementApiError } from './management-auth';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendGrantInputSchema, type SpendPrincipal } from '../authority/spend-grant';
import type { LocalGrantConfirmation } from '../authority/local-grant-approval';
import { DEMO_MARKET_DATA_PROVIDER_ID } from '../resources/static-resource-registry';
import { PAID_RESOURCE_SCOPE_ID } from '../resources/paid-resources';
import { DEVNET_NETWORK } from '../payment/payment-config';
import { requestPaidResourcePurchase, type PurchaseRequestResult } from '../purchases/request-paid-resource-purchase';
import { loadRegisteredResources, registeredResourceSummary } from '../resources/registered-resources';
import { discoverResource, prepareDiscovery } from '../resources/mainnet-resource-discovery';
import { RuntimeResourceSchema, resourceEntrySummary } from '../resources/runtime-resource-registry';
import { ResourceRequestInputSchema, resourceInputNames, authorizedRequestInstance } from '../resources/http-resource';
import { assertGrantPostScope, assertPostRequestApproval, postRequestPolicyHash, postRequestReview } from '../resources/post-request-authorization';
import { fetchResourceChallenge } from '../payment/resource-challenge';
import { classifyPaymentPreflightError, runPaymentPreflight } from '../payment/payment-preflight';
import { displayAmount } from '../purchases/paid-resource-quote';
import { z } from 'zod';
import type { PaymentRequirements } from '@x402/core/types';
import { readPaidResourceQuotes } from '../purchases/paid-resource-quote';
import { acquireDataDirectoryOwnership } from './data-directory-owner';
import { readWalletBalance } from './wallet-balance';
import { assembleAuthorityOverview } from './authority-overview';
import { resolveYoshConfiguration } from './yosh-configuration';
import { readExecutionSelection, writeExecutionSelection, executionProfile } from './execution-selection';
import { writeProductionExecutionSetting } from './product-configuration';
import { PaymentEnvironmentError, resolvePaymentEnvironment, PurchaseExecutionModeSchema, type PaymentEnvironment, type PurchaseExecutionMode } from '../payment/payment-environment';

type RuntimeState = { runtime?: AppRuntime };
export type TestPurchaseResult = { purchaseId: string; status: string; deliveryStatus: string; policy: { decision: string; reason: string }; transaction: string | null; simulated: boolean; warning?: string };
const globals = globalThis as typeof globalThis & { __yosh?: RuntimeState };

export function runtimeDataDirectory() {
  const configured = resolveYoshConfiguration().dataDirectory;
  // Reuse the installation's ledger, member identities and pending-payment evidence.
  return configured || join(homedir(), 'Library', 'Application Support', '2049');
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Supplied only by the trusted runtime entry after package verification. */
export type AppRuntimeHosting = Readonly<{ kind: 'mainnet-standalone'; payMcpPath: string; runtimeDigest: string;
  /** Supplied only by the verified standalone artifact, never Agent input or environment. */
  confirmStatementPairing?: import('../authority/local-statement-pairing').ConfirmStatementPairing;
  purchaseResourceLookup?: boolean;
  legacyMemberForRegistration?: (registration: string, label: string) => string | null;
  confirmPurchaseGrant?: import('../authority/native-grant-confirmation').ConfirmLocalGrant;
  mppProtocolEnginePath?: string }>;

export class AppRuntime {
  readonly ledger: PurchaseLedger;
  readonly agentConnection: AgentConnection;
  private readonly memberConnections = new Map<string, AgentConnection>();
  private readonly codexIntegration: CodexIntegration;
  private providerWrite: Promise<unknown> = Promise.resolve();
  private readonly owner: ReturnType<typeof acquireDataDirectoryOwnership>;
  private readonly hosting?: AppRuntimeHosting;
  private accepting = true;
  private readonly payDevelopment: boolean;
  private readonly devMainnet: boolean;
  private readonly devDevnet: boolean;
  private readonly devSimulated: boolean;
  private readonly payDevnet = process.env.YOSH_PAY_MCP_DEVNET === '1';
  private get controlledPay() { return this.payMainnet || this.payDevnet; }
  private get registeredLive() { return this.environment.mode === 'live_mainnet' || this.devDevnet; }
  private get offlineResources() { return IS_CODEX_PLUGIN_DEVELOPMENT && this.payDevelopment ? this.dependencies.offlineResources : undefined; }
  private get registeredResourceRequired() { return this.registeredLive || Boolean(this.offlineResources && this.activeResourceDefinitions().length); }
  private registeredResource(resourceId?: string) {
    const resource = this.activeResourceDefinitions().find(resource => resource.resourceId === resourceId);
    if (resource && this.offlineResources) this.offlineResources.assertResource(resource);
    return resource;
  }
  private pendingHostPurchase?: { key: string; result: Promise<z.infer<typeof LocalHostPurchasePlan>> };
  private walletProvisioning?: Promise<{ address: string; reused: boolean }>;
  private readonly payMainnet = process.env.YOSH_PAY_MCP_MAINNET === '1';
  private payAuthority?: ReturnType<typeof createPayAuthorityAdapter>;
  private active = new Set<Promise<unknown>>();
  private startup?: Promise<void>;
  private deliveryRecoveryTimer?: ReturnType<typeof setTimeout>;
  private readonly reconciliationAbort = new AbortController();
  private recoveryStatus: 'idle' | 'running' | 'complete' | 'pending' = 'idle';
  private wallet?: Promise<{ address: string; reused: boolean }>;
  private walletInventory?: Promise<WalletAccountObservation[]>;
  private walletInventoryExpiresAt = 0;
  private walletAddress?: string;
  private mainnetIdentity?: string;
  private authorityWalletStatus: AuthorityWalletState = 'unverified';
  private walletRetryAfter = 0;
  private authorityWalletBalance: string | null = null;
  private environment: PaymentEnvironment;
  private readonly configuredEnvironment = { ...process.env };
  private readonly profileKeys = new Set<string>();
  private readonly sandboxWallet?: string;
  private purchaseExecutionMode() {
    const current = resolvePaymentEnvironment();
    if (this.sandboxWallet && (current.mode !== 'simulated' || current.productionExecutionEnabled)) throw new Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    if (current.mode !== 'live_mainnet' && current.cluster !== 'devnet') throw new PaymentEnvironmentError('INVALID_PAYMENT_ENVIRONMENT', 'App requires Devnet or explicit Mainnet environment');
    if ((current.mode === 'live_mainnet' || this.environment.mode === 'live_mainnet') && hash(current) !== hash(this.environment)) throw new PaymentEnvironmentError('INVALID_PAYMENT_ENVIRONMENT', 'Restart Yosh before changing the payment environment');
    this.environment = current;
    return current.mode;
  }
  constructor(readonly directory = runtimeDataDirectory(), private dependencies: { remotePurchaseSandbox?: boolean; confirmRemotePurchaseConsent?: (facts: RemotePurchaseConsent) => Promise<boolean>; confirmRemoteReadPairing?: (facts: ReadConsent) => Promise<boolean>; initializeWallet?: () => Promise<{ address: string; reused: boolean }>; readWallets?: () => Promise<WalletInventoryEntry[]>; timeZone?: () => string; now?: () => number; fetcher?: typeof fetch; codex?: CodexIntegrationOptions; paymentExecutor?: PaymentExecutor; mpp?: MppChargeDependencies; offlineResources?: OfflineResourcePolicy; hosting?: AppRuntimeHosting } = {}) {
    dependencies = this.dependencies = { ...dependencies };
    this.hosting = dependencies.hosting ? Object.freeze({ ...dependencies.hosting }) : undefined;
    resolveYoshConfiguration();
    this.payDevelopment = isPayDevelopmentDirectory(directory);
    this.devMainnet = isMainnetDevelopment(directory);
    this.devDevnet = isDevnetDevelopment(directory);
    this.devSimulated = isSimulatedDevelopment(directory);
    if (dependencies.remotePurchaseSandbox) {
      this.sandboxWallet = sandboxWalletIdentity(directory);
      checkSandboxDatabases(directory);
      if (this.hosting || this.payDevelopment || this.devDevnet || this.devMainnet || this.devSimulated || this.controlledPay ||
          dependencies.offlineResources || dependencies.mpp || dependencies.paymentExecutor ||
          resolvePaymentEnvironment().mode !== 'simulated' || resolvePaymentEnvironment().productionExecutionEnabled)
        throw new Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    } else if (existsSync(join(directory, 'remote-purchase-sandbox-v1'))) throw new Error('REMOTE_PURCHASE_SANDBOX_REQUIRED');
    if (this.hosting && (this.hosting.kind !== 'mainnet-standalone' || !this.payMainnet || this.payDevnet
      || this.payDevelopment || dependencies.paymentExecutor || typeof this.hosting.payMcpPath !== 'string'
      || this.hosting.payMcpPath.includes('\0') || !isAbsolute(this.hosting.payMcpPath)
      || resolveRuntimePath(this.hosting.payMcpPath) !== this.hosting.payMcpPath || basename(this.hosting.payMcpPath) !== 'pay-mcp'
      || typeof this.hosting.runtimeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(this.hosting.runtimeDigest)))
      throw new Error('MAINNET_STANDALONE_HOSTING_REJECTED');
    if (dependencies.offlineResources && (!IS_CODEX_PLUGIN_DEVELOPMENT || !this.payDevelopment)) throw new Error('OFFLINE_RESOURCE_SCOPE_REJECTED');
    if (this.devDevnet) admitDevnetDevelopment(directory);
    if (this.devSimulated) admitSimulatedDevelopment(directory);
    if (this.payDevnet && (!this.devDevnet || this.payMainnet)) throw new Error('PAY_DEVNET_CONFIGURATION_REQUIRED');
    if (this.devMainnet) assertDevelopmentStorage(directory);
    if (!this.payMainnet && existsSync(join(directory, 'pay-mainnet-cutover.json'))) throw new Error('PAY_MAINNET_PROFILE_REQUIRED');
    // This seam cannot select pay for an installed/user runtime. Production
    // admission still waits for reliable warm legacy-process credential isolation.
    if (dependencies.paymentExecutor) assertIsolatedPaymentDirectory(directory);
    this.owner = acquireDataDirectoryOwnership(directory);
    let ledger: PurchaseLedger | undefined;
    try {
      // Product configuration holds operator policy; the persisted selection is
      // the active profile. Resolve it before validating the active environment.
      const selection = readExecutionSelection(directory);
      if (this.sandboxWallet && selection && selection !== 'simulated') throw new Error('REMOTE_PURCHASE_SIMULATED_ONLY');
      if (selection) this.applyExecutionProfile(selection);
      this.environment = resolvePaymentEnvironment();
      if (this.hosting && this.environment.mode !== 'live_mainnet') throw new Error('MAINNET_STANDALONE_HOSTING_REJECTED');
      this.purchaseExecutionMode();
      if (this.controlledPay) {
        if (this.payMainnet && (this.payDevelopment || this.environment.mode !== 'live_mainnet' || dependencies.paymentExecutor)) throw new Error('PAY_MAINNET_CONFIGURATION_REQUIRED');
        if (this.payDevnet && (this.environment.mode !== 'live_devnet' || dependencies.paymentExecutor)) throw new Error('PAY_DEVNET_CONFIGURATION_REQUIRED');
        if (this.payMainnet) admitPayMainnetRuntime(directory);
        dependencies.paymentExecutor = createPayExecution({ network: this.payMainnet ? 'mainnet' : 'devnet', takeUnsigned: context => {
          if (!this.payAuthority) throw new Error('PAY_AUTHORITY_NOT_READY');
          return this.payAuthority.takeUnsigned(context);
        } });
      }
      if (dependencies.paymentExecutor && !this.controlledPay && this.environment.mode !== 'live_devnet') throw new Error('PAY_EXECUTOR_PRODUCTION_BLOCKED');
      ledger = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true, walletIdentity: this.sandboxWallet, requireRegisteredResource: true, requireSpendGrant: true, mode: this.purchaseExecutionMode(), timeZone: dependencies.timeZone ?? localTimeZone, now: dependencies.now });
      this.ledger = ledger;
      if (this.controlledPay) ledger.executionSafety.enable(Date.now());
      dependencies.paymentExecutor?.bindRuntime?.(directory, ledger);
      // Import installation configuration once; subsequent reads use durable product data.
      if (!this.sandboxWallet) this.initializeRegisteredResources();
      const defaultMemberId = this.ledger.defaultCardMember().id;
      for (const member of this.ledger.cardMembers()) {
        this.memberConnections.set(member.id, new AgentConnection(directory, member.id, id => this.ledger.isCardMemberActive(id) && !this.ledger.remoteReadPairings().belongsToMember(id), member.id !== defaultMemberId, dependencies.now));
      }
      this.agentConnection = this.memberConnections.get(defaultMemberId)!;
      if (this.controlledPay) {
        const origin = `http://127.0.0.1:${resolveYoshConfiguration().port ?? '3049'}`;
        this.payAuthority = createPayAuthorityAdapter({ directory, runtime: () => this, config: () => this.paymentConfiguration(),
          executor: dependencies.paymentExecutor!, origin, rpcUrl: this.environment.rpcUrl, ...(this.payMainnet ? { mainnet: true } : { devnet: true }) });
        if (this.payMainnet) writePayMainnetDescriptor(directory, origin, defaultMemberId);
      }
      this.codexIntegration = new CodexIntegration(directory, defaultMemberId, this.sandboxWallet ? { root: directory, run: async () => { throw Error('REMOTE_PURCHASE_SANDBOX_ONLY'); } } : dependencies.codex);
      this.agentConnection.setIntegration(this.hosting || this.payDevelopment || this.devMainnet || this.devDevnet || this.devSimulated ? this.agentConnection.status().enabled : this.codexIntegration.configured,
        this.hosting || this.payDevelopment || this.devMainnet || this.devDevnet || this.devSimulated ? 'yosh-pay-dev' : this.codexIntegration.serverName);
      // A verified persisted connection survives a service restart. Host-session
      // liveness is still reset by AgentConnection, and purchase checks remain server-side.
    } catch (error) {
      ledger?.close();
      this.owner.release();
      this.restoreExecutionProfile();
      throw error;
    }
  }
  private initializeRegisteredResources() {
    const environment = this.devDevnet || this.devSimulated || this.offlineResources
      ? this.environment : resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' });
    const resources = this.ledger.resources.list().length ? [] : loadRegisteredResources(process.env, environment);
    // Installation configuration can introduce records too; it is not exempt
    // from the verified-capability boundary used by management registration.
    if (resources.some(resource => resource.paymentProtocol === 'mpp_solana_charge')) this.mppDependencies();
    this.ledger.resources.initialize(resources, environment.network);
  }
  private applyExecutionProfile(mode: PurchaseExecutionMode) {
    const profile = executionProfile(this.configuredEnvironment, mode);
    // This process owns the App runtime. The existing kernel reads this same active configuration.
    for (const key of new Set([...Object.keys(this.configuredEnvironment), ...Object.keys(profile)])) {
      if (profile[key] !== this.configuredEnvironment[key]) this.profileKeys.add(key);
    }
    // Wallet initialization may have added a test public identity after startup.
    if (mode === 'live_mainnet') for (const key of Object.keys(process.env)) if (key.startsWith('DEMO_')) this.profileKeys.add(key);
    for (const key of this.profileKeys) {
      if (profile[key] === undefined) delete process.env[key];
      else process.env[key] = profile[key];
    }
    this.environment = resolvePaymentEnvironment();
  }
  execution() {
    this.purchaseExecutionMode();
    const defaultMemberId = this.ledger.defaultCardMember().id;
    const readiness = this.authority(defaultMemberId).readiness;
    const resources = this.registeredLive ? this.activeResourceDefinitions().map(resource => resource.resourceId)
      : this.offlineResources ? [undefined, ...this.activeResourceDefinitions().map(resource => resource.resourceId)] : [undefined];
    const anyEligibleMember = this.ledger.cardMembers().some(member => resources.some(resourceId =>
      this.authority(member.id, resourceId).readiness.transactionExecution.eligible));
    return { mode: this.environment.mode, cluster: this.environment.cluster, network: this.environment.network,
      asset: this.environment.asset, productionExecutionEnabled: this.environment.productionExecutionEnabled,
      spendingAuthorized: anyEligibleMember,
      configurationReady: this.environment.mode === 'simulated' || readiness.paymentConfiguration.ready,
      transactionExecutionEligible: anyEligibleMember, quotePreflightRequired: this.registeredResourceRequired,
      readinessCardMemberId: defaultMemberId, readiness };
  }
  private paymentConfiguration(defaultMode: PurchaseExecutionMode = 'live_devnet') {
    if (this.registeredLive && this.authorityWalletStatus !== 'available') throw new Error('Wallet unavailable');
    const config = loadPaymentConfig(this.resourceConfiguration(), defaultMode, this.walletAddress);
    return this.offlineResources ? { ...config, registeredResources: this.activeResourceDefinitions() } : config;
  }
  private paymentConfigurationSnapshot() {
    if (this.environment.mode === 'simulated') return { config: undefined, code: null };
    try { return { config: this.paymentConfiguration(), code: null }; }
    catch (error) {
      if (error instanceof PaymentConfigurationError || error instanceof PaymentEnvironmentError) return { config: undefined, code: error.code };
      const message = error instanceof Error ? error.message : '';
      const code = message === 'Mainnet wallet unavailable' || message === 'Wallet unavailable' || message === 'DEMO_BUYER_PUBLIC_KEY is required'
        ? 'WALLET_UNAVAILABLE'
        : message === 'DEMO_MERCHANT_PUBLIC_KEY is required' ? 'TEST_MERCHANT_CONFIGURATION_REQUIRED'
          : (message === 'MAINNET_RESOURCE_REGISTRATION_REQUIRED' || message === 'REGISTERED_RESOURCE_REQUIRED') ? 'REGISTERED_RESOURCE_REQUIRED'
            : (message === 'MAINNET_RESOURCE_REGISTRATION_INVALID' || message === 'REGISTERED_RESOURCE_INVALID') ? 'REGISTERED_RESOURCE_INVALID'
              : message === 'MAINNET_WALLET_IDENTITY_MISMATCH' || message.startsWith('Mainnet wallet identity')
                ? 'WALLET_IDENTITY_INVALID' : 'PAYMENT_CONFIGURATION_INVALID';
      return { config: undefined, code };
    }
  }
  setExecution(mode: PurchaseExecutionMode) {
    if (this.sandboxWallet && mode !== 'simulated') throw Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    if ((this.devMainnet || this.devDevnet || this.devSimulated) && mode !== this.environment.mode) throw new ManagementApiError('ENVIRONMENT_RESTART_REQUIRED', 409, 'Change the Dev environment in Settings.');
    if (this.payDevelopment && mode !== 'live_devnet') throw new ManagementApiError('PAY_DEVELOPMENT_ONLY', 409, '此开发版只使用离线测试环境。');
    this.purchaseExecutionMode();
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    if (mode === this.environment.mode) return this.execution();
    this.assertExecutionChangeIdle();
    executionProfile(this.configuredEnvironment, mode);
    writeExecutionSelection(this.directory, mode);
    this.applyExecutionProfile(mode);
    this.wallet = undefined;
    this.walletAddress = undefined;
    this.walletRetryAfter = 0;
    this.walletInventory = undefined;
    this.walletInventoryExpiresAt = 0;
    this.authorityWalletStatus = 'unverified';
    this.authorityWalletBalance = null;
    return this.execution();
  }
  private assertExecutionChangeIdle() {
    // No signing, quotes, wallet initialization or original-payment recovery may straddle a switch.
    if (this.active.size || this.ledger.pendingRecovery().length ||
      PurchaseExecutionModeSchema.options.some(mode => BigInt(this.ledger.managedSummary(
        this.dependencies.now?.() ?? Date.now(), mode).reserved) > 0n)) {
      throw new ManagementApiError('EXECUTION_BUSY', 409, 'Finish pending purchases before changing execution.');
    }
  }
  setProductionExecutionEnabled(enabled: boolean) {
    if (this.sandboxWallet) throw Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    if (this.payDevelopment) throw new ManagementApiError('PAY_PRODUCTION_BLOCKED', 409, '开发版不支持真实资金。');
    this.purchaseExecutionMode();
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    if (this.environment.mode !== 'live_mainnet') {
      throw new ManagementApiError('MAINNET_SELECTION_REQUIRED', 409, 'Select Mainnet before changing production execution.');
    }
    if (this.environment.productionExecutionEnabled === enabled) return this.execution();
    this.assertExecutionChangeIdle();
    const proposed = { ...this.configuredEnvironment, YOSH_ENABLE_MAINNET_EXECUTION: enabled ? '1' : '0',
      ...(this.configuredEnvironment.APP2049_ENABLE_MAINNET_EXECUTION !== undefined
        ? { APP2049_ENABLE_MAINNET_EXECUTION: enabled ? '1' : '0' } : {}) };
    executionProfile(proposed, 'live_mainnet');
    writeProductionExecutionSetting(this.directory, enabled);
    this.configuredEnvironment.YOSH_ENABLE_MAINNET_EXECUTION = enabled ? '1' : '0';
    if (this.configuredEnvironment.APP2049_ENABLE_MAINNET_EXECUTION !== undefined) {
      this.configuredEnvironment.APP2049_ENABLE_MAINNET_EXECUTION = enabled ? '1' : '0';
    }
    this.profileKeys.add('YOSH_ENABLE_MAINNET_EXECUTION');
    if (this.configuredEnvironment.APP2049_ENABLE_MAINNET_EXECUTION !== undefined) this.profileKeys.add('APP2049_ENABLE_MAINNET_EXECUTION');
    this.applyExecutionProfile('live_mainnet');
    return this.execution();
  }
  private restoreExecutionProfile() {
    for (const key of this.profileKeys) {
      if (this.configuredEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = this.configuredEnvironment[key];
    }
  }
  close() {
    if (this.active.size) throw new Error('Cannot close the backend while operations are active');
    this.accepting = false;
    this.dependencies.paymentExecutor?.invalidate?.();
    clearTimeout(this.deliveryRecoveryTimer);
    this.ledger.close();
    this.owner.release();
    this.restoreExecutionProfile();
  }
  healthStatus() {
    return { coreReady: true,
      ...(this.hosting ? { hosting: { kind: this.hosting.kind, apiVersion: 1 as const,
        dataContract: 'existing-mainnet-v1' as const, runtimeDigest: this.hosting.runtimeDigest } } : {}),
      wallet: this.authorityWalletStatus === 'available' ? 'walletAvailable'
        : this.authorityWalletStatus === 'unavailable' ? 'walletUnavailable' : 'walletChecking',
      recovery: this.recoveryStatus === 'running' ? 'recoveryRunning'
        : this.recoveryStatus === 'complete' ? 'recoveryComplete' : 'recoveryPending' };
  }
  async initializeWallet() {
    if (this.sandboxWallet) throw new Error('REMOTE_PURCHASE_SANDBOX_ONLY');
    resolveYoshConfiguration();
    this.purchaseExecutionMode();
    if (this.environment.mode === 'live_mainnet' && !this.wallet && Date.now() < this.walletRetryAfter) throw new Error('WALLET_RETRY_PENDING');
    this.wallet ??= this.track((this.dependencies.initializeWallet ?? (async () => {
      if (this.environment.mode !== 'live_mainnet') {
        const existing = (await this.readWalletInventory()).find(wallet => wallet.id === 'devnet');
        if (existing?.status !== 'available' || !existing.address) throw new Error('WALLET_UNAVAILABLE');
        return { address: existing.address, reused: true };
      }
      // Status retains public identities only. The payment signer independently
      // loads protected material and checks its identity immediately before use.
      const inventory = await this.readWalletInventory();
      const mainnet = inventory.find(wallet => wallet.id === 'mainnet');
      const test = inventory.find(wallet => wallet.id === 'devnet');
      if (mainnet?.status !== 'available' || !mainnet.address || test?.status === 'unavailable'
        || mainnet.address === test?.address) throw new Error('MAINNET_WALLET_UNAVAILABLE');
      return { address: mainnet.address, reused: true };
    }))().then(wallet => {
      this.purchaseExecutionMode();
      this.ledger.walletAccounts.assertIdentity(this.environment.mode === 'live_mainnet' ? 'mainnet' : 'devnet',
        wallet.address, this.environment.mode === 'live_mainnet' ? process.env.YOSH_MAINNET_WALLET_PUBLIC_KEY : undefined);
      this.walletAddress = wallet.address;
      if (this.environment.mode === 'live_mainnet') {
        if (process.env.YOSH_MAINNET_WALLET_PUBLIC_KEY !== undefined && wallet.address !== process.env.YOSH_MAINNET_WALLET_PUBLIC_KEY) throw new Error('Mainnet wallet mismatch');
        if (this.mainnetIdentity !== undefined && wallet.address !== this.mainnetIdentity) throw new Error('Mainnet wallet identity changed');
        this.mainnetIdentity = wallet.address;
        this.authorityWalletStatus = 'available';
        this.walletRetryAfter = 0;
      } else if (!this.devDevnet) process.env.DEMO_BUYER_PUBLIC_KEY = wallet.address;
      this.authorityWalletStatus = 'available';
      process.env.YOSH_USE_PRODUCT_WALLET = '1';
      if (process.env.APP2049_USE_PRODUCT_WALLET !== undefined) process.env.APP2049_USE_PRODUCT_WALLET = '1';
      // Cache only the verified public identity for status reads. Payment signing
      // obtains and revalidates the Keychain secret independently.
      return wallet;
    }).catch(error => { this.wallet = undefined; this.walletAddress = undefined; this.authorityWalletStatus = 'unavailable';
      this.authorityWalletBalance = null; if (this.environment.mode === 'live_mainnet') {
        this.walletRetryAfter = Date.now() + 30_000; this.walletInventoryExpiresAt = this.walletRetryAfter;
      } throw error; }));
    return this.wallet;
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
    return operation;
  }
  /** Backend-only external payment seam. Keep its authorization, in-flight HTTP
   * and original accounting in the same quit barrier as App/MCP purchases. */
  runExternalPaymentOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('SERVICE_STOPPING'));
    return this.track(operation());
  }
  private mppDependencies(): MppChargeDependencies {
    if (this.environment.isProduction) {
      const binary = this.mppRecoveryBinary();
      // Standalone owns the ledger through the shared backend lock. Native App
      // reader compatibility is a separate delivery stage, not spending authority.
      // Production always uses the original Keychain signer, RPC and merchant
      // transport. Isolated prepare/fetch injections cannot cross this boundary.
      return { binary };
    }
    if (!isDevnetDevelopment(this.directory)) throw new Error('MPP_ISOLATED_RUNTIME_REQUIRED');
    const binary = this.dependencies.mpp?.binary ?? process.env.YOSH_MPP_PROTOCOL_ENGINE;
    if (!binary || !isAbsolute(binary)) throw new Error('MPP_PROTOCOL_UNAVAILABLE');
    return this.dependencies.mpp ?? { binary, fetcher: this.dependencies.fetcher };
  }
  private mppRecoveryBinary(): string {
    if (!this.environment.isProduction) return this.mppDependencies().binary;
    const binary = this.hosting?.mppProtocolEnginePath;
    if (this.hosting?.kind !== 'mainnet-standalone' || !binary || !isAbsolute(binary))
      throw new Error('MPP_MAINNET_ACCEPTANCE_REQUIRED');
    // Startup and scheduled recovery use the same verified protocol executable.
    return binary;
  }
  requestMppPurchase(input: unknown, origin: string, principal: SpendPrincipal) {
    const dependencies = this.mppDependencies();
    return this.runExternalPaymentOperation(async () => {
      await this.start(origin);
      const config = this.paymentConfiguration('simulated');
      return requestMppResourcePurchase(input, { config, ledger: this.ledger, principal, dependencies,
        assertAccepting: () => { if (!this.accepting) throw new Error('SERVICE_STOPPING'); } });
    });
  }
  quoteMppResource(resourceId: string, sample: unknown, memberId: string) {
    const dependencies = this.mppDependencies();
    this.ledger.assertCardMemberActive(memberId);
    const resource = this.registeredResource(resourceId);
    if (!resource) throw new Error('MPP_REGISTERED_RESOURCE_REQUIRED');
    const instance = { ...resource, request: authorizedRequestInstance(resource, sample) };
    return this.track(fetchMppResourceQuote(instance, this.paymentConfiguration('simulated'), dependencies.binary, dependencies.fetcher));
  }
  async payMcpRecovery(raw: unknown, principal: SpendPrincipal, origin: string) {
    if (!this.controlledPay || !this.payAuthority) throw new Error('PAY_CONTROLLED_EXECUTION_NOT_ENABLED');
    const { operationId } = z.object({ operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/) }).strict().parse(raw);
    await this.start(origin); await this.initializeWallet();
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    return this.payAuthority.recoverOperation(operationId, principal,
      this.hosting?.payMcpPath ?? resolveRuntimePath(dirname(process.execPath), '../Resources/Runtime/pay-mcp'));
  }
  async payMcpOperation(action: 'authorize' | 'plan' | 'execute', raw: unknown, principal: SpendPrincipal, origin: string) {
    if (!this.controlledPay || !this.payAuthority) throw new Error('PAY_CONTROLLED_EXECUTION_NOT_ENABLED');
    await this.start(origin);
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    await this.initializeWallet();
    if (action === 'authorize') return this.payAuthority.authorizeSpend(raw, principal);
    const input = z.object({ facts: z.unknown(), unsigned: z.unknown().optional() }).strict().parse(raw);
    return action === 'plan' ? this.payAuthority.prepareControlled(input.facts, principal) : this.payAuthority.execute(input.facts, input.unsigned, principal);
  }
  start(origin: string): Promise<void> {
    if (this.sandboxWallet) { this.requirePurchaseSandbox(); return Promise.resolve(); }
    resolveYoshConfiguration();
    this.purchaseExecutionMode();
    if (this.startup) return this.startup;
    if (!this.accepting) return Promise.resolve();
    this.startup = this.track(this.recoverOnStartup(origin));
    return this.startup;
  }
  private async recoverOnStartup(origin: string) {
    this.recoveryStatus = 'running';
    // The Electron single-instance owner starts this once before new purchases.
    this.ledger.recoverUnclaimedExternalAuthorizationsOnStartup();
    this.ledger.recoverUnsubmittedOnStartup();
    this.ledger.recoverDeliveryClaimsOnStartup();
    this.ledger.reconciliation.recoverClaimsOnStartup();
    try {
      const pending = this.ledger.pendingRecovery();
      if (pending.length) {
        const wallet = await this.initializeWallet();
        const config = this.paymentConfiguration('simulated');
        if (config.mode !== this.purchaseExecutionMode() || config.buyer !== wallet.address) throw new Error('Recovery wallet mismatch');
        let paymentChecks = 0;
        for (const item of pending) {
          if (!this.accepting) break;
          try { let record = (item.ownerCardMemberId ? this.ledger.getOwned(item.requestId, item.ownerCardMemberId) : this.ledger.getLegacy(item.requestId));
            // Exclusive startup has no live submitting executor. Preserve every possible send.
            if (record?.status === 'PAYING') {
              this.ledger.unknown(record.approvalId);
              record = (item.ownerCardMemberId ? this.ledger.getOwned(item.requestId, item.ownerCardMemberId) : this.ledger.getLegacy(item.requestId));
            }
            if (record?.status === 'PAYMENT_UNKNOWN' && paymentChecks++ >= 4) continue;
            if (record) await recoverApprovedPayment(this.ledger, item.requestId, config,
              paymentEndpointForIntent(origin, record.intent), () => {}, item.ownerCardMemberId,
              { automatic: true, signal: this.reconciliationAbort.signal,
                ...(record.intent.mpp ? { binary: this.mppRecoveryBinary() } : {}) }); }
          catch { /* Keep mismatched or unavailable original payments frozen. */ }
        }
      }
      this.recoveryStatus = this.ledger.pendingRecovery().length ? 'pending' : 'complete';
    } catch { this.recoveryStatus = 'pending'; }
    this.scheduleDeliveryRecovery(origin);
    // A standalone owner must not replace the original App's Codex launch entry.
    // Renaming an App-owned MCP entry must never delay original payment recovery.
    if (this.accepting && !this.hosting && !IS_CODEX_PLUGIN_DEVELOPMENT && this.codexIntegration.needsMigration) {
      try {
        await this.codexIntegration.migrateLegacy();
        this.agentConnection.setIntegration(this.accepting && this.codexIntegration.configured, this.codexIntegration.serverName);
      } catch {
        // Explicit Connect will surface the ownership conflict; configuration is not liveness.
        this.agentConnection.setIntegration(false, this.codexIntegration.serverName);
      }
    }
  }
  private scheduleDeliveryRecovery(origin: string) {
    if (!this.accepting) return;
    this.deliveryRecoveryTimer = setTimeout(() => {
      this.ledger.releaseExpired(Date.now());
      const operation = this.track(Promise.all([this.retryDueDeliveries(origin), this.reconcileDuePayments()]));
      void operation.finally(() => this.scheduleDeliveryRecovery(origin));
    }, 1000);
    this.deliveryRecoveryTimer.unref();
  }
  private async retryDueDeliveries(origin: string) {
    try {
      const due = this.ledger.dueDeliveryRecovery();
      if (!this.accepting || !due.length) return;
      const wallet = await this.initializeWallet();
      const config = this.paymentConfiguration('simulated');
      if (config.mode !== this.purchaseExecutionMode() || config.buyer !== wallet.address) return;
      for (const item of due) {
        if (!this.accepting) break;
        const record = (item.ownerCardMemberId ? this.ledger.getOwned(item.requestId, item.ownerCardMemberId) : this.ledger.getLegacy(item.requestId));
        if (!record) continue;
        await recoverApprovedPayment(this.ledger, item.requestId, config, paymentEndpointForIntent(origin, record.intent),
          () => {}, item.ownerCardMemberId, { fetcher: this.environment.isProduction ? undefined : this.dependencies.fetcher,
            ...(record.intent.mpp ? { binary: this.mppRecoveryBinary() } : {}) });
      }
      this.recoveryStatus = this.ledger.pendingRecovery().length ? 'pending' : 'complete';
    } catch { this.recoveryStatus = 'pending'; }
  }
  private async reconcileDuePayments() {
    try {
      if (!this.accepting) return;
      const mode = this.purchaseExecutionMode();
      // Disabling test execution must not strand already submitted Devnet payments.
      const scope = this.ledger.scope(mode === 'simulated' ? 'live_devnet' : mode);
      const due = this.ledger.reconciliation.due(monetaryScopeId(scope));
      if (!due.length) return;
      const wallet = await this.initializeWallet();
      const config = this.paymentConfiguration('simulated');
      if (config.mode !== this.purchaseExecutionMode() || config.buyer !== wallet.address) return;
      for (const item of due) {
        if (!this.accepting) break;
        try {
          await reconcileApprovedPayment(this.ledger, item.requestId, config, () => {}, item.ownerCardMemberId,
            { automatic: true, signal: this.reconciliationAbort.signal });
        } catch {
          // Even an unreadable purchase must back off rather than monopolize the due batch.
          const claim = this.ledger.reconciliation.claim(item.purchaseId, true);
          if (claim) this.ledger.reconciliation.finish(claim, 'BINDING_MISMATCH');
        }
      }
      this.recoveryStatus = this.ledger.pendingRecovery().length ? 'pending' : 'complete';
    } catch { this.recoveryStatus = 'pending'; }
  }
  async prepareQuit() {
    this.accepting = false;
    this.dependencies.paymentExecutor?.invalidate?.();
    this.reconciliationAbort.abort();
    clearTimeout(this.deliveryRecoveryTimer);
    this.ledger.stopPayments();
    await Promise.allSettled([...this.active]);
  }
  async prepareEnvironmentSwitch() {
    if (!this.payDevelopment && !this.devMainnet && !this.devDevnet && !this.devSimulated) throw new ManagementApiError('PAY_DEVELOPMENT_ONLY', 409, 'Development environment required.');
    // Check and fence without an intervening await: no purchase can enter after
    // the idle check. Unknown/reservations block switching, not just signing.
    this.assertExecutionChangeIdle();
    await this.prepareQuit();
  }
  private mainnetAddress() { return this.walletAddress ?? ''; }
  authority(memberId = this.ledger.defaultCardMember().id, resourceId?: string) {
    this.purchaseExecutionMode();
    const mainnet = this.environment.mode === 'live_mainnet';
    const address = mainnet ? this.mainnetAddress() : this.walletAddress ?? '';
    const configuration = this.paymentConfigurationSnapshot();
    const facilitator = inspectFacilitatorConfiguration(this.resourceConfiguration(), this.environment);
    return authoritySurface(this.ledger, this.environment, memberId,
      { address, status: !address ? 'unavailable' : mainnet ? this.authorityWalletStatus : 'available', balance: this.authorityWalletBalance },
      configuration.config, this.dependencies.now?.() ?? Date.now(), { facilitator, resourceId, registeredLive: this.registeredLive || Boolean(this.offlineResources && this.registeredResource(resourceId ?? this.spendGrantSummary(memberId)?.resourceId)),
        connectionEnabled: this.connectionFor(memberId).principal('request_purchase') !== undefined,
        serviceAccepting: this.accepting, configurationCode: configuration.code });
  }
  readAuthorityBalance() { return this.track(this.performAuthorityBalanceRead()); }
  private async performAuthorityBalanceRead() {
    this.purchaseExecutionMode();
    const environment = this.environment;
    const unavailable = (display: string) => ({ amount: null, display, available: false as const,
      network: environment.network, assetId: environment.asset.mint, assetDecimals: environment.asset.decimals });
    let address: string;
    try { address = (await this.initializeWallet()).address; }
    catch { return unavailable(environment.mode === 'live_mainnet' ? 'Mainnet wallet unavailable' : 'Wallet unavailable'); }
    const balance = await this.balance(address);
    this.authorityWalletBalance = balance.amount;
    return { ...balance, network: environment.network, assetId: environment.asset.mint, assetDecimals: environment.asset.decimals };
  }
  async balance(address: string, fetcher: typeof fetch = fetch) {
    return readWalletBalance(address, fetcher, this.environment);
  }
  quotePaidResources(origin: string, memberId = this.ledger.defaultCardMember().id) {
    this.ledger.assertCardMemberActive(memberId);
    return this.track(this.readPaidResourceQuotes(origin, memberId));
  }
  prepareRegisteredResource(resourceId: string, sample: unknown) {
    this.purchaseExecutionMode();
    if (!this.registeredLive && !this.offlineResources) throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
    const resource = this.activeResourceDefinitions().find(item => item.resourceId === resourceId);
    if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    return postRequestReview(authorizedRequestInstance(resource, sample), resource);
  }
  async quoteRegisteredResource(resourceId: string, sample: unknown, memberId: string) {
    this.ledger.assertCardMemberActive(memberId);
    this.purchaseExecutionMode();
    if (!this.registeredLive && !this.offlineResources) throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
    if (this.offlineResources) await this.performAuthorityBalanceRead();
    const resource = this.activeResourceDefinitions().find(item => item.resourceId === resourceId);
    if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    const instance = authorizedRequestInstance(resource, sample);
    assertGrantPostScope(resource, this.ledger.activeSpendGrant(this.dependencies.now?.() ?? Date.now(), memberId, this.environment.mode, resourceId));
    const { quote } = await fetchResourceChallenge({ ...resource, request: instance }, this.environment, this.dependencies.fetcher);
    const preflight = await this.inspectQuotedPayment(resourceId, quote, memberId);
    return { resourceId, request: { url: instance.url, method: instance.method }, network: quote.network,
      assetId: quote.asset, assetDecimals: resource.decimals, amount: quote.amount,
      display: this.environment.isProduction ? displayAmount(quote.amount).replace('test USDC', 'USDC') : displayAmount(quote.amount), payTo: quote.payTo,
      maxTimeoutSeconds: quote.maxTimeoutSeconds, preflight, paymentSent: false,
      notice: 'This is an unpaid snapshot. Every purchase obtains and validates a fresh quote.' };
  }
  private async readPaidResourceQuotes(origin: string, memberId: string) {
    this.purchaseExecutionMode();
    if (this.registeredResourceRequired) {
      await this.performAuthorityBalanceRead();
      const registeredResources = this.registeredResources();
      const resources = await Promise.all(this.activeResourceDefinitions().map(async resource => {
        if (resourceInputNames(resource.requestInputs?.query).length || resourceInputNames(resource.requestInputs?.jsonBody).length) {
          return { resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId,
            resourceUrl: resource.request.url, quoteStatus: 'unavailable' as const,
            code: 'RESOURCE_REQUEST_INPUT_REQUIRED', requestInput: { ready: false, code: 'RESOURCE_REQUEST_INPUT_REQUIRED',
              field: resourceInputNames(resource.requestInputs?.query)[0] ?? 'jsonBody' } };
        }
        try {
          assertGrantPostScope(resource, this.ledger.activeSpendGrant(this.dependencies.now?.() ?? Date.now(), memberId, this.environment.mode, resource.resourceId));
          const { quote } = await fetchResourceChallenge(resource, this.environment, this.dependencies.fetcher);
          const preflight = await this.inspectQuotedPayment(resource.resourceId, quote, memberId);
          const requestInput = { ready: true, code: null, field: null };
          return { resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId, resourceUrl: resource.request.url,
            method: resource.request.method, amount: quote.amount, decimals: resource.decimals,
            display: this.environment.isProduction ? displayAmount(quote.amount).replace('test USDC', 'USDC') : displayAmount(quote.amount),
            asset: quote.asset, network: quote.network, payTo: quote.payTo, quoteStatus: 'available' as const, preflight, requestInput };
        } catch {
          return { resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId,
            resourceUrl: resource.request.url, quoteStatus: 'unavailable' as const, code: 'RESOURCE_QUOTE_UNAVAILABLE' };
        }
      }));
      if (this.offlineResources) {
        const legacy = await readPaidResourceQuotes(origin, this.paymentConfiguration(), this.dependencies.fetcher);
        return { registeredResources, resources: [...legacy.resources, ...resources], testEnvironment: true };
      }
      return { registeredResources, resources, testEnvironment: !this.environment.isProduction };
    }
    const wallet = await this.initializeWallet();
    const config = this.paymentConfiguration('simulated');
    if (config.mode !== this.purchaseExecutionMode() || config.buyer !== wallet.address) throw new Error('产品钱包配置不匹配。');
    return readPaidResourceQuotes(origin, config, this.dependencies.fetcher);
  }
  private async inspectQuotedPayment(resourceId: string, quote: PaymentRequirements, memberId: string) {
    const authority = this.authority(memberId, resourceId);
    const local = authority.readiness.transactionExecution;
    if (!local.eligible) return { ready: false, code: local.code };
    const grant = this.ledger.spendGrantSummary(this.dependencies.now?.() ?? Date.now(), this.environment.mode, memberId, resourceId);
    if (!grant || grant.resourceId !== resourceId) return { ready: false, code: 'SPEND_GRANT_SCOPE_MISMATCH' };
    if (grant.payTo !== quote.payTo || grant.network !== quote.network || grant.assetId !== quote.asset
      || grant.paymentScheme !== quote.scheme) return { ready: false, code: 'SPEND_GRANT_SCOPE_MISMATCH' };
    if (BigInt(quote.amount) > BigInt(grant.singleLimit) || BigInt(quote.amount) > BigInt(grant.remaining)) {
      return { ready: false, code: 'SPEND_GRANT_AMOUNT_EXCEEDED' };
    }
    if (authority.available === null || BigInt(quote.amount) > BigInt(authority.available)) {
      return { ready: false, code: 'DAILY_AUTHORITY_INSUFFICIENT' };
    }
    const configuration = this.paymentConfigurationSnapshot();
    if (!configuration.config) return { ready: false, code: configuration.code ?? 'PAYMENT_CONFIGURATION_INVALID' };
    try {
      await runPaymentPreflight({ ...configuration.config, merchant: quote.payTo },
        { fetch: this.dependencies.fetcher, amount: quote.amount,
          feePayer: typeof quote.extra.feePayer === 'string' ? quote.extra.feePayer : undefined });
      return { ready: true, code: null };
    } catch (error) {
      return { ready: false, code: classifyPaymentPreflightError(error) };
    }
  }
  private activeResourceDefinitions() {
    return this.ledger.resources.active().filter(resource => resource.network === this.environment.network && resource.mint === this.environment.asset.mint && resource.decimals === this.environment.asset.decimals);
  }
  private resourceConfiguration() {
    return { ...process.env, YOSH_MAINNET_RESOURCES: JSON.stringify(this.activeResourceDefinitions()) };
  }
  listRegisteredResources() { return this.ledger.resources.list().filter(entry => entry.definition.network === this.environment.network).map(resourceEntrySummary); }
  prepareResourceDiscovery(raw: unknown) { return prepareDiscovery(raw, this.environment).review; }
  discoverResource(raw: unknown, approvedHash?: string) { return this.track(discoverResource(raw, undefined, approvedHash, this.environment)); }
  inspectRegisteredResource(id: string) { return resourceEntrySummary(this.ledger.resources.inspect(id)); }
  async discoverAgentResource(raw: unknown, principal: SpendPrincipal) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    const fixture = this.offlineResources;
    const result = await this.track(discoverResource(fixture ? fixture.discoveryInput(raw) : raw,
      fixture?.readHeaders, undefined, this.environment, fixture));
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    return this.ledger.resources.recordDiscovery(result, principal);
  }
  registerAgentResource(raw: unknown, principal: SpendPrincipal) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    const entry = this.ledger.resources.addDiscovered(raw, principal, this.offlineResources?.assertResource);
    return { ...resourceEntrySummary(entry), registrationStatus: 'REGISTERED', spendingAuthorityCreated: false,
      paymentSent: false, notice: 'Registered by Agent. Review in Yosh and create a Spend Grant before purchasing.' };
  }
  addRegisteredResource(raw: unknown) {
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    const resource = RuntimeResourceSchema.parse(raw);
    if (resource.network !== this.environment.network || resource.mint !== this.environment.asset.mint) throw new Error('RESOURCE_NETWORK_MISMATCH');
    if (resource.paymentProtocol === 'mpp_solana_charge') this.mppDependencies();
    return resourceEntrySummary(this.ledger.resources.add(resource));
  }
  disableRegisteredResource(id: string, state: 'DISABLED' | 'REMOVED') {
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    return resourceEntrySummary(this.ledger.resources.setState(id, state));
  }
  registeredResources() {
    this.purchaseExecutionMode();
    if (!this.registeredLive && !this.offlineResources) return [];
    return this.activeResourceDefinitions().map(resource => {
      const entry = this.ledger.resources.inspect(resource.resourceId);
      return { ...registeredResourceSummary(resource), source: entry.source,
        ...(entry.submission ? { submission: entry.submission } : {}) };
    });
  }
  overview() { return this.track(this.readOverview()); }
  async refreshMainnetWallet() {
    this.purchaseExecutionMode();
    if (!this.registeredLive) return;
    try { await this.initializeWallet(); } catch { /* Identity failure is recorded in the shared snapshot. */ }
  }
  walletLibrary() { return this.ledger.walletLibrary.list(); }
  createDevelopmentPaymentWallet() {
    if (!((this.devMainnet && this.payMainnet) || (this.devDevnet && this.payDevnet))) throw new ManagementApiError('PAY_DEVELOPMENT_ONLY', 409, 'Select a live development environment before creating its payment wallet.');
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    this.walletProvisioning ??= this.track((async () => {
      this.walletInventory = undefined; this.walletInventoryExpiresAt = 0;
      const inventory = await this.readWalletInventory();
      const slotId = this.environment.mode === 'live_mainnet' ? 'mainnet' : 'devnet';
      const slot = inventory.find(wallet => wallet.id === slotId);
      if (!slot || !['absent_fresh', 'existing'].includes(slot.provisioningState))
        throw new ManagementApiError('WALLET_RESTORE_REQUIRED', 409, 'Existing wallet evidence must be restored; no new wallet was created.');
      const wallet = await initializeEnvironmentWallet(this.environment);
      this.ledger.walletAccounts.assertIdentity(slotId, wallet.address, slotId === 'mainnet' ? process.env.YOSH_MAINNET_WALLET_PUBLIC_KEY : undefined);
      this.walletInventory = undefined; this.walletInventoryExpiresAt = 0;
      this.wallet = undefined; this.walletAddress = undefined; this.walletRetryAfter = 0;
      await this.initializeWallet();
      return wallet;
    })()).finally(() => { this.walletProvisioning = undefined; });
    return this.walletProvisioning;
  }
  addLibraryWallet(raw: unknown) {
    if (this.payDevelopment) throw new ManagementApiError('PAY_DEVELOPMENT_ONLY', 409, 'Offline development cannot import or create real wallets.');
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    return this.track((async () => {
      const existing = await this.readWalletInventory();
      // Denied Keychain access cannot prove that an imported identity is distinct.
      if (existing.some(wallet => wallet.status === 'unavailable'))
        throw new ManagementApiError('WALLET_INVENTORY_UNAVAILABLE', 503, 'Unlock the existing wallets before adding another wallet.');
      return this.ledger.walletLibrary.add(raw, existing.flatMap(wallet => wallet.address ? [wallet.address] : []));
    })());
  }
  existingWallets() { return this.track(this.readWallets()); }
  private readWalletInventory() {
    if (this.sandboxWallet) return Promise.resolve<WalletAccountObservation[]>([]);
    if (!this.walletInventory || (this.walletInventoryExpiresAt > 0 && Date.now() >= this.walletInventoryExpiresAt)) {
      this.walletInventoryExpiresAt = 0;
      const readWallets: () => Promise<WalletInventoryEntry[]> = this.dependencies.readWallets ?? (() => readExistingProductWallets());
      this.walletInventory = readWallets().then(wallets => {
        const observed = this.ledger.walletAccounts.observe(wallets, { mainnetAssertion: process.env.YOSH_MAINNET_WALLET_PUBLIC_KEY });
        if (observed.some(wallet => wallet.status !== 'available')) this.walletInventoryExpiresAt = Date.now() + 30_000;
        return observed;
      });
    }
    return this.walletInventory!;
  }
  private async readWallets() {
    const wallets = await this.readWalletInventory();
    if (this.purchaseExecutionMode() !== 'live_mainnet') return wallets;
    await this.refreshMainnetWallet();
    return wallets.map(wallet => wallet.id === 'mainnet' && wallet.status === 'available'
      && this.authorityWalletStatus !== 'available' ? { ...wallet, address: null, status: 'unavailable' as const,
        provisioningState: 'identity_conflict' as const } : wallet);
  }
  private async readOverview() {
    const mode = this.purchaseExecutionMode();
    void this.refreshMainnetWallet();
    // Reading the startup surface must not create a product wallet. Mainnet
    // selection is displayable before provisioning; explicit balance, quote,
    // and purchase operations keep their existing wallet initialization path.
    const wallet = mode === 'live_mainnet'
      ? { address: this.mainnetAddress(), available: this.authorityWalletStatus === 'available', reused: true }
      : await this.readWalletInventory().then(wallets => {
        const existing = wallets.find(item => item.id === 'devnet');
        return { address: existing?.status === 'available' ? existing.address ?? '' : '', reused: existing?.status === 'available' };
      });
    const overview = assembleAuthorityOverview(this.ledger, this.agentConnection, wallet,
      { status: this.accepting ? 'running' : 'stopping', recoveryStatus: this.recoveryStatus },
      this.dependencies.now?.() ?? Date.now(), mode, this.ledger.defaultCardMember().id);
    return { ...overview, purchases: this.visiblePurchases(), authority: this.authority(), service: { ...overview.service, execution: this.execution(), paymentEnabled: mode === 'live_devnet' || (mode === 'live_mainnet' && this.environment.productionExecutionEnabled),
      registeredResources: this.registeredResources(), registeredResourceRequired: this.registeredResourceRequired } };
  }
  private connectionFor(memberId: string) {
    const connection = this.memberConnections.get(memberId);
    if (!connection || !this.ledger.cardMember(memberId)) throw new Error('CARD_MEMBER_NOT_FOUND');
    return connection;
  }
  private requirePurchaseSandbox() {
    if (!this.sandboxWallet || !this.accepting || this.purchaseExecutionMode() !== 'simulated' ||
      sandboxWalletIdentity(this.directory) !== this.sandboxWallet) throw Error('REMOTE_PURCHASE_SIMULATED_ONLY');
    return this.ledger.scope('simulated');
  }
  private async confirmRemotePurchase(facts: RemotePurchaseConsent) {
    const confirm = this.dependencies.confirmRemotePurchaseConsent ?? (await import('../remote/purchase-confirm')).confirmRemotePurchaseConsent;
    if (!await confirm(Object.freeze(facts))) throw new ManagementApiError('REMOTE_PURCHASE_CONSENT_DENIED', 403, '本机未确认。');
    this.requirePurchaseSandbox();
  }
  async issueRemotePurchasePairing(label: string) {
    const { walletIdentity } = this.requirePurchaseSandbox();
    const parsed = purchasePairingRequest.parse({ label, scopes: ['purchase'] });
    await this.confirmRemotePurchase({ action: 'pair', environment: 'simulated', account: walletIdentity, label: parsed.label });
    const result = this.ledger.issueRemotePurchasePairing(parsed.label, this.requirePurchaseSandbox());
    this.memberConnections.set(result.memberId, new AgentConnection(this.directory, result.memberId, () => false, true));
    return result;
  }
  async createRemotePurchaseGrant(pairingId: string, raw: unknown) {
    const request = SpendGrantInputSchema.extend({ resourceId: z.literal('market-snapshot') }).strict().parse(raw);
    const { resourceId, ...input } = request;
    const scope = this.requirePurchaseSandbox(), pairs = this.ledger.remoteReadPairings();
    const pairing = pairs.purchaseForId(z.uuid().parse(pairingId), scope);
    const now = () => this.dependencies.now?.() ?? Date.now();
    const basis = () => {
      const last = this.ledger.spendGrantSummary(now(), 'simulated', pairing.memberId, resourceId);
      return last ? hash([last.id, last.version, last.status]) : null;
    };
    const previous = basis();
    await this.confirmRemotePurchase({ action: 'grant', label: pairing.label, account: scope.walletIdentity,
      environment: 'simulated', pairingId, ...request });
    const principal = pairs.purchasePrincipal(pairingId, this.requirePurchaseSandbox());
    if (basis() !== previous) throw new ManagementApiError('REMOTE_PURCHASE_GRANT_CHANGED', 409, '此授权已变更，请重新确认。');
    const grant = this.ledger.createSpendGrant(input, principal, simulationGrantScope, now(), 'simulated');
    return { grantId: grant.id, resourceId, totalLimit: grant.totalLimit, singleLimit: grant.singleLimit, expiresAt: grant.expiresAt };
  }
  revokeRemotePurchaseGrant(pairingId: string, grantId: string) {
    const principal = this.ledger.remoteReadPairings().purchasePrincipal(z.uuid().parse(pairingId), this.requirePurchaseSandbox());
    return this.ledger.revokeSimulatedPairingGrant(principal, z.uuid().parse(grantId), simulationGrantScope.resourceId, this.dependencies.now?.() ?? Date.now());
  }
  authenticateRemotePurchase(token: string) {
    return this.ledger.remoteReadPairings().authenticatePurchase(token, this.requirePurchaseSandbox());
  }
  requestRemotePurchase(token: string, raw: unknown) {
    const pairing = this.authenticateRemotePurchase(token), scope = this.requirePurchaseSandbox();
    const principal = this.ledger.remoteReadPairings().purchasePrincipal(pairing.id, scope);
    return purchaseInSimulator(this.ledger, principal, raw, scope.walletIdentity, this.dependencies.now?.() ?? Date.now());
  }
  getRemotePurchase(token: string, raw: unknown) {
    const pairing = this.authenticateRemotePurchase(token), scope = this.requirePurchaseSandbox();
    const principal = this.ledger.remoteReadPairings().purchasePrincipal(pairing.id, scope);
    return lookupSimulatedPurchase(this.ledger, principal, raw, scope.walletIdentity);
  }
  async issueRemoteReadPairing(label: string, scopes: readonly ReadScope[]) {
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh 正在退出。');
    const request = pairingRequest.parse({ label, scopes });
    const scope = this.ledger.scope(this.purchaseExecutionMode());
    const confirm = this.dependencies.confirmRemoteReadPairing ?? (await import('../remote/confirm')).confirmRemoteReadPairing;
    // Approval names this installation and wallet; asynchronous confirmation cannot authorize a newly selected environment.
    const account = this.ledger.defaultCardMember().id + ' / ' + scope.walletIdentity;
    let approved: boolean;
    try { approved = await confirm({ label: request.label, scopes: [...request.scopes], account, environment: scope.environment }); }
    catch (error) {
      if (error instanceof Error && error.message === 'LOCAL_CONFIRMATION_DECLINED') approved = false;
      else throw new ManagementApiError('REMOTE_READ_CONFIRMATION_UNAVAILABLE', 503, '无法完成本机确认，未创建配对。');
    }
    if (approved !== true) throw new ManagementApiError('REMOTE_READ_CONSENT_DENIED', 403, '未批准远端读取。');
    if (!this.accepting || monetaryScopeId(scope) !== monetaryScopeId(this.ledger.scope(this.purchaseExecutionMode())))
      throw new ManagementApiError('REMOTE_READ_SCOPE_CHANGED', 409, '钱包环境已变化，请重新确认。');
    const result = this.ledger.issueRemoteReadPairing(request.label, request.scopes, scope);
    this.memberConnections.set(result.memberId, new AgentConnection(this.directory, result.memberId, () => false, true));
    return result;
  }
  listRemoteReadPairings() { return this.ledger.remoteReadPairings().list(); }
  revokeRemoteReadPairing(id: string) {
    const member = this.ledger.remoteReadPairings().memberForId(z.uuid().parse(id));
    if (typeof member !== 'string') throw new ManagementApiError('REMOTE_READ_PAIRING_NOT_FOUND', 404, '未找到该配对。');
    if (this.ledger.isCardMemberActive(member)) this.revokeCardMember(member);
    return { revoked: true };
  }
  authenticateRemoteRead(token: string) {
    if (!this.accepting) throw new Error('REMOTE_READ_UNAUTHORIZED');
    return this.ledger.remoteReadPairings().authenticate(token, this.ledger.scope(this.purchaseExecutionMode()));
  }
  remoteAccountRead(token: string, scope: ReadScope, input: unknown) {
    const principal = this.authenticateRemoteRead(token);
    if (!principal.scopes.includes(scope)) throw new Error('REMOTE_READ_FORBIDDEN');
    const mode = this.purchaseExecutionMode();
    if (scope === 'statement') return this.ledger.readAccountStatement(principal.memberId, mode, StatementInput.parse(input));
    return this.ledger.readAccountResult(principal.memberId, mode, ResultInput.parse(input));
  }
  pairStatementHost(input: { hostId: string; label: string }, origin: string, signal?: AbortSignal) {
    const confirm = this.hosting?.confirmStatementPairing;
    if (!confirm) throw new Error('LOCAL_STATEMENT_PAIRING_UNAVAILABLE');
    return this.track(this.ledger.localStatementPairings().pair(input, confirm, {
      accepting: () => this.accepting,
      enabled: id => !!this.connectionFor(id).principal('read_statement'),
      canAddStatement: id => !!this.connectionFor(id).principal('request_purchase'),
      install: id => {
        const existing = this.memberConnections.get(id);
        if (existing) {
          const principal = existing.principal('request_purchase');
          if (!principal) throw new Error('LOCAL_STATEMENT_CONNECTION_REVOKED');
          existing.enableLocalScope(origin, principal, 'read_statement');
          return;
        }
        const connection = new AgentConnection(this.directory, id, member => this.ledger.isCardMemberActive(member), true);
        connection.setEnabled(true, origin, true);
        this.memberConnections.set(id, connection);
      },
    }, signal));
  }
  private hostPurchaseResource(resourceId: string) {
    const resource = this.registeredResource(resourceId);
    if (!resource || resource.request.method !== 'GET' || resource.request.access !== 'https')
      throw new Error('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
    const headers = resource.request.headers;
    if (resource.paymentProtocol !== 'mpp_solana_charge' && (headers['content-type'] || (headers.accept && headers.accept !== 'application/json')))
      throw new Error('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
    return resource;
  }

  describeHostResource(raw: unknown) {
    const {hostId, label, resourceId} = StatementRegistration.extend(PurchaseResourceLookup.shape).strict().parse(raw);
    const verifyHost = this.hosting?.legacyMemberForRegistration;
    if (!this.accepting || !this.hosting?.purchaseResourceLookup || !verifyHost || !this.hosting.confirmPurchaseGrant || !this.payMainnet || this.localGrantEnvironment() !== 'mainnet')
      throw new Error('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
    verifyHost(hostId, label);
    return describePurchaseResource(this.hostPurchaseResource(resourceId));
  }

  async authorizeHostPurchase(raw: unknown, origin: string, signal?: AbortSignal) {
    const {hostId, label, existingOnly, ...input} = StatementRegistration.extend(LocalHostPurchaseOwnerInput.shape).strict().parse(raw);
    if (existingOnly) return this.track(this.confirmHostPurchase({hostId, label}, input, origin, signal, true));
    const key = hash({hostId, label, input});
    if (this.pendingHostPurchase) {
      if (this.pendingHostPurchase.key === key) return this.pendingHostPurchase.result;
      throw new Error('LOCAL_CONFIRMATION_BUSY');
    }
    const result = this.track(this.confirmHostPurchase({hostId, label}, input, origin, signal));
    this.pendingHostPurchase = {key, result};
    try { return await result; } finally { this.pendingHostPurchase = undefined; }
  }

  private async confirmHostPurchase(registration: z.infer<typeof StatementRegistration>, input: HostPurchase, origin: string, signal?: AbortSignal, existingOnly = false) {
    const confirm = this.hosting?.confirmPurchaseGrant;
    if (!confirm || this.localGrantEnvironment() !== 'mainnet' || !this.payMainnet) throw new Error('LOCAL_PURCHASE_UNAVAILABLE');
    const pairings = this.ledger.localStatementPairings(), account = pairings.registration(registration);
    const principalFor = (id: string) => this.connectionFor(id).principal('request_purchase') ?? this.connectionFor(id).principal('read_statement');
    const legacyBinding = this.hosting?.legacyMemberForRegistration?.(registration.hostId, registration.label);
    const legacy = legacyBinding === 'default' ? this.ledger.defaultCardMember().id : legacyBinding;
    if (legacy && account.memberId && account.memberId !== legacy) throw new Error('LOCAL_AUTHORIZATION_AGENT_CHANGED');
    const memberId = legacy ?? account.memberId;
    const memberLabel = memberId ? this.ledger.cardMember(memberId)?.label : undefined;
    const current = memberId ? principalFor(memberId) : undefined;
    if (memberId && !current) throw new Error('LOCAL_STATEMENT_CONNECTION_REVOKED');
    const approvals = this.ledger.localGrantApprovals(), sessionHash = hash(['local-host-purchase', account.hash, input.requestId]);
    const previous = approvals.findPurchase(sessionHash);
    if (previous && previous.request.purchase?.inputHash !== hash(input)) throw new Error('LOCAL_PURCHASE_BINDING_MISMATCH');
    if (!existingOnly && previous?.state === 'CANCELLED') throw new Error('LOCAL_CONFIRMATION_DECLINED');
    const approvedPlan = (frozen: ReturnType<typeof approvals.read>) => LocalHostPurchasePlan.parse({
      memberId: frozen.request.binding.principal.cardMemberId, resourceId: input.resourceId, requestId: input.requestId,
      protocol: frozen.request.binding.scope.paymentScheme === 'mpp_charge' ? 'mpp' : 'x402', url: frozen.request.purchase!.url });
    if (previous?.state === 'CONSUMED') {
      if (!current || hash(current) !== hash(previous.request.binding.principal)) throw new Error('LOCAL_AUTHORIZATION_AGENT_CHANGED');
      if (!readAgentPurchase(this.ledger, current.cardMemberId, {operationId: input.requestId})) {
        if (existingOnly) throw new Error('LOCAL_PURCHASE_NOT_FOUND');
        const grant = previous.grantId ? this.ledger.spendGrantById(previous.grantId) : undefined;
        if (grant?.status !== 'ACTIVE') throw new Error('LOCAL_PURCHASE_GRANT_INACTIVE');
        if (Date.now() >= Math.min(grant.expiresAt, previous.request.purchase!.quoteExpiresAt)) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
        await this.initializeWallet();
        if (this.localGrantResourceHash(this.registeredResource(input.resourceId) ?? null) !== previous.request.resourceHash)
          throw new Error('LOCAL_AUTHORIZATION_RESOURCE_CHANGED');
      }
      return approvedPlan(previous);
    }
    // The single-writer backend owns the only live prompt. A frozen pending
    // row left by a crashed owner has no consent and may be presented afresh.
    if (!existingOnly && previous) approvals.cancel(previous.request.id, sessionHash);
    if (current) {
      const receipt = readAgentPurchase(this.ledger, current.cardMemberId, {operationId: input.requestId});
      if (receipt) {
        if (receipt.resourceId !== input.resourceId) throw new Error('LOCAL_PURCHASE_BINDING_MISMATCH');
        const original = this.ledger.getOwned(receipt.purchaseId, current.cardMemberId)!;
        return LocalHostPurchasePlan.parse({memberId: current.cardMemberId, resourceId: input.resourceId, requestId: input.requestId,
          protocol: original.intent.mpp ? 'mpp' : 'x402', url: original.intent.httpRequest?.url});
      }
    }
    if (existingOnly) throw new Error('LOCAL_PURCHASE_NOT_FOUND');
    if (!this.accepting || signal?.aborted) throw new Error('LOCAL_PURCHASE_CANCELLED');
    const resource = this.hostPurchaseResource(input.resourceId);
    const mpp = resource.paymentProtocol === 'mpp_solana_charge';
    if (mpp && !input.maximumNetworkFeeLamports) throw new Error('MPP_NETWORK_FEE_CONSENT_REQUIRED');
    if (!mpp && input.maximumNetworkFeeLamports) throw new Error('LOCAL_PURCHASE_FEE_CAP_UNEXPECTED');
    if (Object.keys(input.request?.query ?? {}).length && !resourceInputNames(resource.requestInputs?.query).length)
      throw new Error('LOCAL_PURCHASE_QUERY_NOT_ALLOWED');
    const request = authorizedRequestInstance(resource, input.request ?? {});
    if (!mpp) request.headers = {...request.headers, accept: 'application/json'};
    await this.initializeWallet();
    const wallet = this.walletAddress, resourceHash = this.localGrantResourceHash(resource);
    if (!wallet || this.authorityWalletStatus !== 'available') throw new Error('LOCAL_AUTHORIZATION_WALLET_UNAVAILABLE');
    const mppDependencies = mpp ? this.mppDependencies() : undefined;
    const quotedAt = Date.now();
    const mppQuote = mppDependencies ? await fetchMppResourceQuote({...resource, request}, this.paymentConfiguration('simulated'),
      mppDependencies.binary, mppDependencies.fetcher) : undefined;
    // The Pay controller retains the merchant's offer metadata. Bind consent
    // to those same bytes so a legitimate SDK round trip retains its identity.
    const quote = mppQuote ?? (await fetchResourceChallenge({...resource, request}, this.environment,
      this.dependencies.fetcher, undefined, {hostPurchase: true})).quote;
    // An existing Grant can allow more than the user authorized for this request.
    if (input.maximumAmountAtomic !== undefined && atomicAmount(quote.amount) > atomicAmount(input.maximumAmountAtomic))
      throw new Error('LOCAL_PURCHASE_PRICE_LIMIT_EXCEEDED');
    const quoteExpiresAt = 'expiresAt' in quote ? quote.expiresAt : quotedAt + quote.maxTimeoutSeconds * 1000;
    if (quote.payTo === wallet) throw new Error('LOCAL_AUTHORIZATION_RECIPIENT_INVALID');
    const principal = current ?? {cardMemberId: randomUUID(), connectionId: randomUUID(), connectionGeneration: 1};
    const validate = () => {
      if (signal?.aborted || !this.accepting) throw new Error('LOCAL_PURCHASE_CANCELLED');
      if (legacyBinding !== this.hosting?.legacyMemberForRegistration?.(registration.hostId, registration.label)
        || wallet !== this.walletAddress || this.localGrantResourceHash(this.registeredResource(input.resourceId) ?? null) !== resourceHash
        || pairings.registration(registration).memberId !== account.memberId
        || (current && (hash(principalFor(current.cardMemberId) ?? null) !== hash(current)
          || this.ledger.cardMember(current.cardMemberId)?.label !== memberLabel)))
        throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
      if (Date.now() >= quoteExpiresAt) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
    };
    validate();
    const now = Date.now();
    const binding = {input: {totalLimit: quote.amount, singleLimit: quote.amount, expiresAt: now + 10 * 60_000},
      principal, mode: 'live_mainnet' as const, scope: {resourceId: resource.resourceId, providerId: resource.providerId,
        operation: PAID_RESOURCE_PURCHASE_OPERATION, network: resource.network, assetId: resource.mint, assetDecimals: resource.decimals,
        payTo: quote.payTo, paymentScheme: mpp ? 'mpp_charge' : 'exact',
        ...(mpp ? {maximumNetworkFeeLamports: input.maximumNetworkFeeLamports} : {}) }};
    const delegatedGrantId = current ? this.ledger.reusableLocalGrant(principal, binding.scope, quote.amount, now) : undefined;
    const frozen = approvals.freeze({environment: 'mainnet', sessionHash, payerWallet: wallet, agentLabel: registration.label,
      apiLabel: resource.resourceId, resourceHash, binding, purchase: {requestId: input.requestId, reason: input.reason,
        url: request.url, requestHash: hash(request), quoteHash: hash(quote), inputHash: hash(input), quoteExpiresAt, mppQuote, delegatedGrantId}}, now);
    try {
      if (delegatedGrantId) {
        validate();
        approvals.useDelegation(frozen.request.id);
        return approvedPlan(frozen);
      }
      await confirm(frozen.request, signal);
      validate();
      const publish = () => pairings.publish(registration, principal.cardMemberId, 'request_purchase', id => {
        const connection = this.memberConnections.get(id) ?? new AgentConnection(this.directory, id, member => this.ledger.isCardMemberActive(member), true);
        connection.enableLocalScope(origin, principal, 'request_purchase');
        this.memberConnections.set(id, connection);
      }, true);
      this.ledger.createSpendGrant(binding.input, principal, binding.scope, Date.now(), binding.mode,
        {requestId: frozen.request.id, digest: frozen.digest}, legacy ? undefined : publish);
      return approvedPlan(frozen);
    } catch (error) { approvals.cancel(frozen.request.id, sessionHash); throw error; }
  }

  readAccountStatement(principal: SpendPrincipal, input: import('../mcp/account-read-contract').StatementQuery) {
    return this.ledger.readAccountStatement(principal.cardMemberId, this.purchaseExecutionMode(), input);
  }
  readAccountResult(principal: SpendPrincipal, input: import('../mcp/account-read-contract').ResultQuery) {
    return this.ledger.readAccountResult(principal.cardMemberId, this.purchaseExecutionMode(), input);
  }
  authenticateAgent(request: Request, capability: 'read' | 'request_purchase' | 'read_statement' = 'read') {
    for (const connection of this.memberConnections.values()) {
      try { return connection.authenticate(request, capability); } catch { /* Try another member capability. */ }
    }
    throw new Error('AGENT_UNAUTHORIZED');
  }
  memberOverview(memberId: string) {
    const member = this.ledger.cardMember(memberId);
    if (!member) throw new Error('CARD_MEMBER_NOT_FOUND');
    const now = this.dependencies.now?.() ?? Date.now();
    return { member, authority: this.authority(memberId), connection: this.connectionFor(memberId).status(),
      grant: this.spendGrantSummary(memberId), grants: this.ledger.spendGrantSummaries(now, this.purchaseExecutionMode(), memberId),
      purchases: this.visiblePurchases(memberId),
      budget: this.ledger.managedSummary(now, this.purchaseExecutionMode()) };
  }
  membersOverview() { return this.ledger.cardMembers().map(member => ({ member, connection: this.connectionFor(member.id).status(),
    grant: this.spendGrantSummary(member.id) })); }
  private visiblePurchases(memberId?: string) {
    const purchases = memberId ? this.ledger.listForOwner(memberId, 50) : this.ledger.listForAdministration(50);
    return purchases.map(purchase => {
      const record = purchase.ownerCardMemberId ? this.ledger.getOwned(purchase.purchaseId, purchase.ownerCardMemberId) : undefined;
      const provenance = record ? this.ledger.executionSafety.provenance(record.intent.id) : undefined;
      const external = provenance?.origin === 'external_pay';
      const evidence = external ? readPayTrace(this.directory, { callerId: String(provenance.caller_id),
        operationId: String(provenance.operation_id), attemptId: String(provenance.attempt_id) }) : undefined;
      return { ...purchase, ...(this.payDevelopment ? { offline: true } : {}),
        ...(external ? { executionTrace: { source: 'pay_mcp', traceId: String(provenance.attempt_id),
          operationId: String(provenance.operation_id), complete: evidence?.complete === true,
          events: evidence?.events ?? [], binarySha256: evidence?.binarySha256 ?? null,
          requestHash: String(provenance.request_hash), quoteHash: String(provenance.quote_hash),
          yoshExecutionPhase: String(provenance.phase),
          originalPaymentState: record ? this.ledger.savedOriginalPayment(record.approvalId)?.state ?? null : null } } : {}) };
    });
  }
  createCardMember(label: string) {
    const member = this.ledger.createCardMember(label);
    this.memberConnections.set(member.id, new AgentConnection(this.directory, member.id, id => this.ledger.isCardMemberActive(id), true));
    return this.memberOverview(member.id);
  }
  renameCardMember(memberId: string, label: string) {
    this.ledger.renameCardMember(memberId, label);
    return this.memberOverview(memberId);
  }
  revokeCardMember(memberId: string) {
    if (memberId === this.ledger.defaultCardMember().id) throw new Error('DEFAULT_CARD_MEMBER_REQUIRED');
    const connection = this.connectionFor(memberId);
    if (!this.ledger.revokeCardMember(memberId)) throw new Error('CARD_MEMBER_NOT_ACTIVE');
    connection.setEnabled(false, '');
    return this.memberOverview(memberId);
  }
  setDailyLimit(value: string | null, confirmation?: LocalControlReceipt) { return this.ledger.setDailyLimit(value, this.purchaseExecutionMode(), undefined, confirmation); }
  spendGrantSummary(memberId = this.ledger.defaultCardMember().id) {
    return this.ledger.spendGrantSummary(this.dependencies.now?.() ?? Date.now(), this.purchaseExecutionMode(), memberId);
  }
  setPaused(value: boolean, confirmation?: LocalControlReceipt) {
    const controls = this.ledger.setPaused(value, this.purchaseExecutionMode(), undefined, confirmation);
    if (value) this.dependencies.paymentExecutor?.invalidate?.();
    return controls;
  }
  setAgentConnection(enabled: boolean, origin: string, memberId = this.ledger.defaultCardMember().id) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    this.ledger.assertCardMemberActive(memberId);
    if (enabled && this.ledger.remoteReadPairings().belongsToMember(memberId)) throw new ManagementApiError('REMOTE_MEMBER_READ_ONLY', 403, '此成员仅用于远端读取。');
    this.ledger.revokeActiveSpendGrant(this.dependencies.now?.() ?? Date.now(), 'grant.REVOKED_CONNECTION_CHANGED', memberId);
    const connection = this.connectionFor(memberId);
    if (enabled && this.ledger.hasStatementOnlyMember(memberId) && !this.ledger.localStatementPairings().mayRead(memberId)) {
      connection.enableLocalScope(origin, connection.principal('request_purchase') ?? {cardMemberId: memberId, connectionId: randomUUID(), connectionGeneration: 1}, 'request_purchase');
    } else connection.setEnabled(enabled, origin, enabled && this.ledger.hasStatementOnlyMember(memberId));
    return connection.status();
  }
  /** Default member is the existing Codex identity; labels never select providers. */
  setMemberConnection(enabled: boolean, origin: string, memberId: string) {
    if (this.hosting || this.payDevelopment || this.devMainnet || this.devDevnet || this.devSimulated) {
      // Enable only the existing member capability. The user explicitly starts
      // a separate Codex configuration; this App never edits their host config.
      const connection = this.connectionFor(memberId);
      if (!enabled || !connection.status().enabled) this.setAgentConnection(enabled, origin, memberId);
      connection.setIntegration(enabled, 'yosh-pay-dev');
      return Promise.resolve(connection.status());
    }
    if (memberId !== this.ledger.defaultCardMember().id) return Promise.resolve(this.setAgentConnection(enabled, origin, memberId));
    const operation = this.providerWrite.catch(() => {}).then(async () => {
      if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh 正在退出。');
      this.ledger.assertCardMemberActive(memberId);
      if (enabled) {
        await this.codexIntegration.connect();
        this.agentConnection.setIntegration(true, this.codexIntegration.serverName);
        // Quit may begin while Codex writes its configuration. Never re-enable after that boundary.
        if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh 正在退出。');
        if (!this.agentConnection.status().enabled) this.setAgentConnection(true, origin, memberId);
      } else {
        // Revoke first even if configuration removal subsequently fails or conflicts.
        this.setAgentConnection(false, origin, memberId);
        await this.codexIntegration.disconnect();
        this.agentConnection.setIntegration(false, this.codexIntegration.serverName);
      }
      return this.agentConnection.status();
    });
    this.providerWrite = operation;
    return this.track(operation);
  }
  observeMcpSession(request: Request, event: McpSessionEvent) {
    const principal = this.authenticateAgent(request);
    this.connectionFor(principal.cardMemberId).observeSession(event);
  }
  localAuthorizationEnvironment(): 'offline' | 'devnet' {
    if (!this.accepting) throw new Error('LOCAL_AUTHORIZATION_OFFLINE_ONLY');
    if (this.offlineResources) return 'offline';
    if (IS_LOCAL_AUTH_DEVELOPMENT && this.devDevnet && this.payDevnet) return 'devnet';
    throw new Error('LOCAL_AUTHORIZATION_OFFLINE_ONLY');
  }
  localWalletSetup() {
    return { available: this.localAuthorizationEnvironment() === 'devnet', slot: 'devnet' as const,
      network: this.environment.network, assetId: this.environment.asset.mint, assetDecimals: this.environment.asset.decimals };
  }
  async reconcileLocalControlSetup(memberId: string) {
    const environment = this.localAuthorizationEnvironment();
    const store = this.ledger.localControlApprovals(), claimed = store.claimedRequests(memberId);
    for (const value of claimed) {
      const action = value.request.action;
      if (action.type === 'connection') {
        if (this.connectionFor(memberId).status().enabled === action.enabled)
          store.consume({ requestId: value.request.id, digest: value.digest }, this.dependencies.now?.() ?? Date.now());
      } else if (action.type === 'create_wallet' && environment === 'devnet') {
        // The live creator owns completion. A concurrent status read must not
        // consume its receipt between Keychain write and metadata commit.
        if (this.walletProvisioning) continue;
        // Read and check the originally approved fixed slot; never create on restart.
        this.walletInventory = undefined; this.walletInventoryExpiresAt = 0;
        const wallet = (await this.existingWallets()).find(entry => entry.id === 'devnet');
        if (wallet?.provisioningState === 'existing' && wallet.address)
          store.consume({ requestId: value.request.id, digest: value.digest }, this.dependencies.now?.() ?? Date.now());
      }
    }
  }

  private localControlBasis(memberId: string) {
    this.localAuthorizationEnvironment();
    this.ledger.assertCardMemberActive(memberId);
    const state = this.memberOverview(memberId);
    return hash({ member: state.member, enabled: state.connection.enabled,
      controls: this.ledger.controls(this.purchaseExecutionMode()), grants: state.grants });
  }
  freezeLocalControl(raw: unknown, memberId: string, sessionHash: string) {
    const action = LocalControlAction.parse(raw), basis = this.localControlBasis(memberId);
    if (this.ledger.localControlApprovals().claimedRequests(memberId).length) throw new Error('LOCAL_WALLET_RECONCILIATION_REQUIRED');
    if (action.type === 'revoke_grant' && !this.memberOverview(memberId).grants.some(grant =>
      grant.id === action.grantId && grant.resourceId === action.resourceId && grant.status === 'ACTIVE'))
      throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    if (action.type === 'create_wallet' && this.localAuthorizationEnvironment() !== 'devnet') throw new Error('LOCAL_WALLET_DEVNET_REQUIRED');
    return this.ledger.localControlApprovals().freeze({ environment: this.localAuthorizationEnvironment(), mode: 'live_devnet',
      memberId, agentLabel: this.ledger.cardMember(memberId)!.label, sessionHash, basis, action }, this.dependencies.now?.() ?? Date.now());
  }
  async commitLocalControl(receipt: LocalControlReceipt, sessionHash: string) {
    const frozen = this.ledger.localControlApprovals().read(receipt.requestId), request = frozen.request;
    if (request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
    if (request.basis !== this.localControlBasis(request.memberId)) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    const action = request.action;
    if (action.type === 'create_wallet') {
      if (this.localAuthorizationEnvironment() !== 'devnet') throw new Error('LOCAL_WALLET_DEVNET_REQUIRED');
      this.ledger.localControlApprovals().claimExternal(receipt, this.dependencies.now?.() ?? Date.now());
      await this.createDevelopmentPaymentWallet();
      this.ledger.localControlApprovals().consume(receipt, this.dependencies.now?.() ?? Date.now());
    } else if (action.type === 'connection') {
      this.ledger.localControlApprovals().claimExternal(receipt, this.dependencies.now?.() ?? Date.now());
      await this.setMemberConnection(action.enabled, `http://127.0.0.1:${resolveYoshConfiguration().port}`, request.memberId);
      this.ledger.localControlApprovals().consume(receipt, this.dependencies.now?.() ?? Date.now());
    } else if (action.type === 'pause') this.setPaused(action.paused, receipt);
    else if (action.type === 'daily_limit') this.setDailyLimit(action.amount, receipt);
    else this.ledger.revokeConfirmedLocalGrant(action.grantId, action.resourceId, request.memberId, receipt);
    return this.ledger.localControlApprovals().read(receipt.requestId);
  }
  localGrantEnvironment(): 'offline' | 'devnet' | 'mainnet' {
    if (this.accepting && this.registeredLive && this.purchaseExecutionMode() === 'live_mainnet') return 'mainnet';
    return this.localAuthorizationEnvironment();
  }
  private localGrantResourceHash(resource: unknown) {
    // Mainnet approval also binds the wallet's monetary identity. Legacy test
    // requests retain their existing bytes and remain readable after upgrade.
    return this.localGrantEnvironment() === 'mainnet'
      ? hash({ resource, monetary: this.ledger.scope('live_mainnet'), wallet: this.walletAddress }) : hash(resource);
  }
  async freezeLocalGrant(raw: unknown, memberId: string, sessionHash: string) {
    const environment = this.localGrantEnvironment();
    const payerWallet = this.walletAddress;
    if (environment === 'mainnet' && !payerWallet) throw new Error('LOCAL_AUTHORIZATION_WALLET_UNAVAILABLE');
    const { resourceId, maximumNetworkFeeLamports, ...input } = SpendGrantInputSchema.extend({ resourceId: z.string().min(1).max(200),
      maximumNetworkFeeLamports: z.string().regex(/^[1-9]\d*$/).max(20).optional() }).strict().parse(raw);
    const resource = this.registeredResource(resourceId);
    if (!resource || resource.request.method !== 'GET')
      throw new Error('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
    const principal = this.connectionFor(memberId).principal('read');
    const member = this.ledger.cardMember(memberId);
    if (!principal || !member || !this.ledger.isCardMemberActive(memberId)) throw new Error('LOCAL_AUTHORIZATION_AGENT_UNAVAILABLE');
    const now = this.dependencies.now?.() ?? Date.now();
    if (atomicAmount(input.singleLimit) <= 0n || atomicAmount(input.totalLimit) < atomicAmount(input.singleLimit)
      || input.expiresAt <= now + 60_000 || input.expiresAt > now + 7 * 86_400_000) throw new Error('LOCAL_AUTHORIZATION_LIMIT_INVALID');
    const mpp = resource.paymentProtocol === 'mpp_solana_charge';
    if (mpp !== (maximumNetworkFeeLamports !== undefined)) throw new Error('MPP_NETWORK_FEE_CONSENT_REQUIRED');
    const resourceHash = this.localGrantResourceHash(resource);
    const quote = mpp ? await this.quoteMppResource(resourceId, {}, memberId) : environment === 'mainnet'
      ? (await fetchResourceChallenge({ ...resource, request: authorizedRequestInstance(resource, {}) }, this.environment, this.dependencies.fetcher)).quote
      : await this.quoteRegisteredResource(resourceId, {}, memberId);
    if (atomicAmount(quote.amount) > atomicAmount(input.singleLimit)) throw new Error('LOCAL_AUTHORIZATION_LIMIT_INVALID');
    if (!this.accepting || this.localGrantResourceHash(this.registeredResource(resourceId) ?? null) !== resourceHash
      || hash(this.connectionFor(memberId).principal('read') ?? null) !== hash(principal)) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    return this.ledger.localGrantApprovals().freeze({ environment, sessionHash, ...(payerWallet ? { payerWallet } : {}),
      agentLabel: member.label, apiLabel: resource.resourceId, resourceHash,
      binding: { input, principal, mode: environment === 'mainnet' ? 'live_mainnet' : 'live_devnet', scope: { resourceId, providerId: resource.providerId,
        operation: PAID_RESOURCE_PURCHASE_OPERATION, network: resource.network, assetId: resource.mint,
        assetDecimals: resource.decimals, payTo: quote.payTo, paymentScheme: mpp ? 'mpp_charge' : 'exact',
        ...(mpp ? { maximumNetworkFeeLamports } : {}) } } }, now);
  }
  commitLocalGrant(confirmation: LocalGrantConfirmation, sessionHash: string) {
    const environment = this.localGrantEnvironment();
    const frozen = this.ledger.localGrantApprovals().read(confirmation.requestId);
    if (frozen.request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
    if (environment === 'mainnet' && (!frozen.request.payerWallet || frozen.request.payerWallet !== this.walletAddress)) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    if (frozen.request.environment !== environment) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
    if (this.ledger.cardMember(frozen.request.binding.principal.cardMemberId)?.label !== frozen.request.agentLabel)
      throw new Error('LOCAL_AUTHORIZATION_AGENT_CHANGED');
    const resource = this.registeredResource(frozen.request.binding.scope.resourceId);
    if (!resource || this.localGrantResourceHash(resource) !== frozen.request.resourceHash) throw new Error('LOCAL_AUTHORIZATION_RESOURCE_CHANGED');
    return this.createSpendGrant({ ...frozen.request.binding.input, resourceId: resource.resourceId,
      ...(frozen.request.binding.scope.maximumNetworkFeeLamports ? { maximumNetworkFeeLamports: frozen.request.binding.scope.maximumNetworkFeeLamports } : {}) },
      frozen.request.binding.principal.cardMemberId, confirmation);
  }
  createSpendGrant(raw: unknown, memberId = this.ledger.defaultCardMember().id, confirmation?: LocalGrantConfirmation) {
    // Reject an environment switch before rotating credentials or reading test defaults.
    const mode = this.purchaseExecutionMode();
    const request = SpendGrantInputSchema.extend({ resourceId: z.string().min(1).max(200).optional(), sample: ResourceRequestInputSchema.optional(), postApprovalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      maximumNetworkFeeLamports: z.string().regex(/^[1-9]\d*$/).max(20).optional() }).strict().parse(raw);
    const { resourceId, sample, postApprovalHash, maximumNetworkFeeLamports, ...input } = request;
    const resource = this.registeredLive || this.offlineResources ? this.registeredResource(resourceId) : undefined;
    if (this.registeredLive && !resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    if (this.offlineResources && resourceId !== undefined && !resource) throw new Error('REGISTERED_RESOURCE_REQUIRED');
    const mpp = resource?.paymentProtocol === 'mpp_solana_charge';
    if (mpp !== (maximumNetworkFeeLamports !== undefined)) throw new Error('MPP_NETWORK_FEE_CONSENT_REQUIRED');
    if (mpp) this.mppDependencies();
    const instance = resource ? authorizedRequestInstance(resource, sample ?? {}) : undefined;
    if (resource && instance) assertPostRequestApproval(instance, postApprovalHash, resource);
    const now = this.dependencies.now?.() ?? Date.now();
    const total = atomicAmount(input.totalLimit); const single = atomicAmount(input.singleLimit);
    if (total <= 0n || single <= 0n || single > total) throw new Error('授权金额必须为正数，且单笔上限不能大于授权总额。');
    if (input.expiresAt <= now + 60_000 || input.expiresAt > now + 7 * 24 * 60 * 60 * 1000) throw new Error('授权有效期必须在 1 分钟到 7 天之间。');
    const commit = (livePayTo?: string) => {
      if (!this.accepting || this.purchaseExecutionMode() !== mode) throw new Error('EXECUTION_CHANGED');
      if (resource && hash(this.activeResourceDefinitions().find(item => item.resourceId === resourceId) ?? null) !== hash(resource)) {
        throw new Error('RESOURCE_REGISTRATION_CHANGED');
      }
      if (this.registeredLive && (this.authorityWalletStatus !== 'available' || !(livePayTo ?? resource?.recipient))) throw new Error('Mainnet wallet or recipient unavailable');
      if (this.registeredLive && (livePayTo ?? resource?.recipient) === this.walletAddress) throw new Error('MAINNET_RESOURCE_REGISTRATION_INVALID');
      const connection = this.connectionFor(memberId);
      // A Grant changes spending authority, not Agent identity. Keep the
      // installed MCP credential/session stable; purchases bind to this
      // connection generation plus the new immutable Grant version.
      const principal = connection.principal('read');
      if (!principal) throw new Error('请先启用 Agent 连接。');
      const payTo = livePayTo ?? resource?.recipient ?? (process.env.DEMO_MERCHANT_PUBLIC_KEY || '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs');
      if (confirmation) {
        const frozen = this.ledger.localGrantApprovals().read(confirmation.requestId);
        if ((mode === 'live_mainnet' && (!frozen.request.payerWallet || frozen.request.payerWallet !== this.walletAddress))
          || this.localGrantResourceHash(resource) !== frozen.request.resourceHash)
          throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
      }
      return this.ledger.createSpendGrant(input, principal, {
        resourceId: resource?.resourceId ?? PAID_RESOURCE_SCOPE_ID,
        providerId: resource?.providerId ?? DEMO_MARKET_DATA_PROVIDER_ID,
        operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: resource?.network ?? DEVNET_NETWORK,
        assetId: resource?.mint ?? DEVNET_USDC_MINT,
        assetDecimals: 6,
        payTo,
        paymentScheme: mpp ? 'mpp_charge' : 'exact',
        ...(mpp ? { maximumNetworkFeeLamports } : {}),
        ...(resource?.request.method === 'POST' ? { postPolicyHash: postRequestPolicyHash(resource) } : {}),
      }, confirmation ? (this.dependencies.now?.() ?? Date.now()) : now, mode, confirmation);
    };
    if (resource?.recipientSource === 'live_challenge') {
      const initialPrincipal = this.connectionFor(memberId).principal('read');
      if (!initialPrincipal) throw new Error('请先启用 Agent 连接。');
      return this.track((async () => {
        // Only explicit authenticated Create Grant reaches here. No signature,
        // reservation or purchase: bind this API delegation to a fresh payee.
        await this.refreshMainnetWallet();
        if (this.authorityWalletStatus !== 'available') throw new Error('Mainnet wallet unavailable');
        if (!instance) throw new Error('RESOURCE_REQUEST_INPUT_REQUIRED');
        const quote = mpp ? await this.quoteMppResource(resource.resourceId, sample ?? {}, memberId)
          : (await fetchResourceChallenge({ ...resource, request: instance }, this.environment, this.dependencies.fetcher)).quote;
        if (BigInt(quote.amount) > single) throw new Error('SPEND_GRANT_SAMPLE_PRICE_EXCEEDS_SINGLE_LIMIT');
        if (hash(this.connectionFor(memberId).principal('read') ?? null) !== hash(initialPrincipal)) throw new Error('GRANT_CONNECTION_CHANGED');
        return commit(quote.payTo);
      })());
    }
    return commit();
  }

  revokeSpendGrant(memberId = this.ledger.defaultCardMember().id, resourceId?: string) {
    return this.ledger.revokeActiveSpendGrant(this.dependencies.now?.() ?? Date.now(), 'grant.REVOKED', memberId, resourceId);
  }
  private purchaseAuthority(principal?: SpendPrincipal) {
    const current = principal ?? this.agentConnection.principal('request_purchase');
    if (!current) throw new Error('当前 Agent 连接没有消费权限。');
    return this.ledger.spendAuthority(current, PAID_RESOURCE_PURCHASE_OPERATION, this.dependencies.now?.() ?? Date.now(), this.purchaseExecutionMode());
  }
  requestPurchase(input: unknown, origin: string, principal: SpendPrincipal): Promise<PurchaseRequestResult> {
    if (this.payDevelopment || this.controlledPay || this.devSimulated) return Promise.reject(new ManagementApiError('PAY_MCP_REQUIRED', 409, '请通过 Pay MCP 购买。'));
    if (!this.accepting) return Promise.reject(new Error('服务正在退出，不能创建购买请求。'));
    return this.track(this.performPurchaseRequest(input, origin, principal));
  }
  private async performPurchaseRequest(input: unknown, origin: string, principal: SpendPrincipal) {
    if (!this.accepting) throw new Error('服务正在退出，不能创建购买请求。');
    // A SpendGrant can only be created from the initialized App session. Keep
    // denied path away from Keychain and all signer construction.
    if (this.purchaseExecutionMode() !== 'live_mainnet' && !this.walletAddress) throw new Error('产品钱包尚未初始化。');
    const config = this.paymentConfiguration('simulated');
    const buyer = config.mode === 'live_mainnet' ? config.buyer : this.walletAddress;
    if (!buyer) throw new Error('产品钱包尚未初始化。');
    if (config.mode !== this.purchaseExecutionMode() || config.buyer !== buyer) throw new Error('产品钱包配置不匹配。');
    await this.start(origin);
    if (!this.accepting) throw new Error('服务正在退出，不能创建购买请求。');
    const executor = this.dependencies.paymentExecutor;
    return requestPaidResourcePurchase(input, { config, ledger: this.ledger, origin, principal, execute: this.purchaseExecutionMode() !== 'simulated', fetcher: this.dependencies.fetcher, now: this.dependencies.now,
      ...(executor ? { pay: (target, approvalId, paymentConfig, endpoint, trace) => executeApprovedPayment(target, approvalId, paymentConfig, endpoint, trace, executor) } : {}) });
  }
  createTestPurchase(id: string, origin: string): Promise<TestPurchaseResult> {
    if (this.payDevelopment || this.controlledPay || this.devSimulated) return Promise.reject(new ManagementApiError('PAY_MCP_REQUIRED', 409, '请通过 Pay MCP 购买。'));
    if (!this.accepting) return Promise.reject(new Error('服务正在退出，不能开始新付款。'));
    return this.track(this.performTestPurchase(id, origin));
  }
  private async performTestPurchase(id: string, origin: string): Promise<TestPurchaseResult> {
    if (this.purchaseExecutionMode() === 'live_mainnet') throw new Error('TEST_PURCHASE_UNAVAILABLE');
    if (!this.accepting) throw new Error('服务正在退出，不能开始新付款。');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('无效的购买编号。');
    await this.start(origin);
    const wallet = await this.initializeWallet();
    if (!this.accepting) throw new Error('服务正在退出，不能开始新付款。');
    const merchant = process.env.DEMO_MERCHANT_PUBLIC_KEY || '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs';
    const mode = this.purchaseExecutionMode();
    const config = mode === 'live_devnet'
      ? loadPaymentConfig(this.resourceConfiguration(), undefined, this.walletAddress)
      : loadPaymentConfig({ ...process.env, DEMO_BUYER_PUBLIC_KEY: wallet.address, DEMO_MERCHANT_PUBLIC_KEY: merchant }, 'simulated');
    if (config.mode !== this.purchaseExecutionMode() || config.buyer !== wallet.address) throw new Error('产品钱包配置不匹配。');
    const ownerCardMemberId = this.ledger.defaultCardMember().id;
    const authority = this.ledger.getOwned(id, ownerCardMemberId) ? undefined : this.purchaseAuthority();
    // This legacy intent is a persisted request-hash input; branding must not break replay.
    const result = await purchaseMarketSnapshot({ purchaseId: id, intent: '2049 App test purchase' }, {
      config, ledger: this.ledger, origin, mode,
      authority, ownerCardMemberId,
      legacyBindings: mode === 'simulated' ? [hash(['simulated-devnet', wallet.address, merchant])] : undefined,
    });
    const saved = result.record;
    return { purchaseId: id, status: saved.status, deliveryStatus: saved.deliveryStatus, policy: saved.decision, transaction: saved.transaction ?? null,
      simulated: result.simulated, ...(result.simulated ? { warning: '本次只验证本地策略、状态和账本，没有签名或链上付款。' } : {}) };
  }
}

export function appRuntime() {
  resolveYoshConfiguration();
  globals.__yosh ??= {};
  globals.__yosh.runtime ??= new AppRuntime();
  return globals.__yosh.runtime;
}

/** Shutdown must not initialize a core that has never accepted operations. */
export function existingAppRuntime() { return globals.__yosh?.runtime; }
