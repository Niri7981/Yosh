import { join } from 'node:path';
import { authoritySurface, type AuthorityWalletState } from './authority-surface';
import { homedir } from 'node:os';
import { readExistingProductWallets } from '../app-wallet/product-wallet';
import type { WalletAccountObservation, WalletInventoryEntry } from '../app-wallet/wallet-accounts';
import { atomicAmount } from '../authority/atomic-money';
import { DEVNET_USDC_MINT, inspectFacilitatorConfiguration, loadPaymentConfig, PaymentConfigurationError } from '../payment/payment-config';
import { PurchaseLedger } from '../purchases/purchase-ledger';
import { paymentEndpointForIntent, recoverApprovedPayment, reconcileApprovedPayment } from '../purchases/approved-payment';
import { monetaryScopeId } from '../purchases/monetary-scope';
import { purchaseMarketSnapshot } from '../purchases/purchase-market-snapshot';
import { hash } from '../purchases/spending-policy';
import { AgentConnection } from '../mcp/connection';
import { CodexIntegration, type CodexIntegrationOptions } from '../mcp/codex-integration';
import { type McpSessionEvent } from '../mcp/session';
import { ManagementApiError } from './management-auth';
import { PAID_RESOURCE_PURCHASE_OPERATION, SpendGrantInputSchema, type SpendPrincipal } from '../authority/spend-grant';
import { DEMO_MARKET_DATA_PROVIDER_ID } from '../resources/static-resource-registry';
import { PAID_RESOURCE_SCOPE_ID } from '../resources/paid-resources';
import { DEVNET_NETWORK } from '../payment/payment-config';
import { requestPaidResourcePurchase, type PurchaseRequestResult } from '../purchases/request-paid-resource-purchase';
import { loadRegisteredResources, registeredResourceSummary } from '../resources/registered-resources';
import { discoverResource } from '../resources/mainnet-resource-discovery';
import { resourceEntrySummary } from '../resources/runtime-resource-registry';
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

export class AppRuntime {
  readonly ledger: PurchaseLedger;
  readonly agentConnection: AgentConnection;
  private readonly memberConnections = new Map<string, AgentConnection>();
  private readonly codexIntegration: CodexIntegration;
  private providerWrite: Promise<unknown> = Promise.resolve();
  private readonly owner: ReturnType<typeof acquireDataDirectoryOwnership>;
  private accepting = true;
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
  private purchaseExecutionMode() {
    const current = resolvePaymentEnvironment();
    if (current.mode !== 'live_mainnet' && current.cluster !== 'devnet') throw new PaymentEnvironmentError('INVALID_PAYMENT_ENVIRONMENT', 'App requires Devnet or explicit Mainnet environment');
    if ((current.mode === 'live_mainnet' || this.environment.mode === 'live_mainnet') && hash(current) !== hash(this.environment)) throw new PaymentEnvironmentError('INVALID_PAYMENT_ENVIRONMENT', 'Restart Yosh before changing the payment environment');
    this.environment = current;
    return current.mode;
  }
  constructor(readonly directory = runtimeDataDirectory(), private dependencies: { initializeWallet?: () => Promise<{ address: string; reused: boolean }>; readWallets?: () => Promise<WalletInventoryEntry[]>; timeZone?: () => string; now?: () => number; fetcher?: typeof fetch; codex?: CodexIntegrationOptions } = {}) {
    resolveYoshConfiguration();
    this.owner = acquireDataDirectoryOwnership(directory);
    let ledger: PurchaseLedger | undefined;
    try {
      // Product configuration holds operator policy; the persisted selection is
      // the active profile. Resolve it before validating the active environment.
      const selection = readExecutionSelection(directory);
      if (selection) this.applyExecutionProfile(selection);
      this.environment = resolvePaymentEnvironment();
      this.purchaseExecutionMode();
      ledger = new PurchaseLedger(join(directory, 'app-ledger.sqlite'), { managed: true, requireRegisteredResource: true, requireSpendGrant: true, mode: this.purchaseExecutionMode(), timeZone: dependencies.timeZone ?? localTimeZone, now: dependencies.now });
      this.ledger = ledger;
      // Import installation configuration once; subsequent reads use durable product data.
      if (!ledger.resources.list().length) ledger.resources.initialize(loadRegisteredResources(process.env, resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet' })));
      else ledger.resources.initialize([]);
      const defaultMemberId = this.ledger.defaultCardMember().id;
      for (const member of this.ledger.cardMembers()) {
        this.memberConnections.set(member.id, new AgentConnection(directory, member.id, id => this.ledger.isCardMemberActive(id), member.id !== defaultMemberId, dependencies.now));
      }
      this.agentConnection = this.memberConnections.get(defaultMemberId)!;
      this.codexIntegration = new CodexIntegration(directory, defaultMemberId, dependencies.codex);
      this.agentConnection.setIntegration(this.codexIntegration.configured, this.codexIntegration.serverName);
      // A verified persisted connection survives a service restart. Host-session
      // liveness is still reset by AgentConnection, and purchase checks remain server-side.
    } catch (error) {
      ledger?.close();
      this.owner.release();
      this.restoreExecutionProfile();
      throw error;
    }
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
    const resources = this.environment.isProduction ? this.activeResourceDefinitions().map(resource => resource.resourceId) : [undefined];
    const anyEligibleMember = this.ledger.cardMembers().some(member => resources.some(resourceId =>
      this.authority(member.id, resourceId).readiness.transactionExecution.eligible));
    return { mode: this.environment.mode, cluster: this.environment.cluster, network: this.environment.network,
      asset: this.environment.asset, productionExecutionEnabled: this.environment.productionExecutionEnabled,
      spendingAuthorized: anyEligibleMember,
      configurationReady: this.environment.mode === 'simulated' || readiness.paymentConfiguration.ready,
      transactionExecutionEligible: anyEligibleMember, quotePreflightRequired: this.environment.mode === 'live_mainnet',
      readinessCardMemberId: defaultMemberId, readiness };
  }
  private paymentConfiguration(defaultMode: PurchaseExecutionMode = 'live_devnet') {
    if (this.environment.mode === 'live_mainnet' && this.authorityWalletStatus !== 'available') throw new Error('Mainnet wallet unavailable');
    return loadPaymentConfig(this.resourceConfiguration(), defaultMode, this.walletAddress);
  }
  private paymentConfigurationSnapshot() {
    if (this.environment.mode === 'simulated') return { config: undefined, code: null };
    try { return { config: this.paymentConfiguration(), code: null }; }
    catch (error) {
      if (error instanceof PaymentConfigurationError || error instanceof PaymentEnvironmentError) return { config: undefined, code: error.code };
      const message = error instanceof Error ? error.message : '';
      const code = message === 'Mainnet wallet unavailable' || message === 'DEMO_BUYER_PUBLIC_KEY is required'
        ? 'WALLET_UNAVAILABLE'
        : message === 'DEMO_MERCHANT_PUBLIC_KEY is required' ? 'TEST_MERCHANT_CONFIGURATION_REQUIRED'
          : message === 'MAINNET_RESOURCE_REGISTRATION_REQUIRED' ? 'REGISTERED_RESOURCE_REQUIRED'
            : message === 'MAINNET_RESOURCE_REGISTRATION_INVALID' ? 'REGISTERED_RESOURCE_INVALID'
              : message === 'MAINNET_WALLET_IDENTITY_MISMATCH' || message.startsWith('Mainnet wallet identity')
                ? 'WALLET_IDENTITY_INVALID' : 'PAYMENT_CONFIGURATION_INVALID';
      return { config: undefined, code };
    }
  }
  setExecution(mode: PurchaseExecutionMode) {
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
    clearTimeout(this.deliveryRecoveryTimer);
    this.ledger.close();
    this.owner.release();
    this.restoreExecutionProfile();
  }
  healthStatus() {
    return { coreReady: true,
      wallet: this.authorityWalletStatus === 'available' ? 'walletAvailable'
        : this.authorityWalletStatus === 'unavailable' ? 'walletUnavailable' : 'walletChecking',
      recovery: this.recoveryStatus === 'running' ? 'recoveryRunning'
        : this.recoveryStatus === 'complete' ? 'recoveryComplete' : 'recoveryPending' };
  }
  async initializeWallet() {
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
      } else process.env.DEMO_BUYER_PUBLIC_KEY = wallet.address;
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
  start(origin: string): Promise<void> {
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
              { automatic: true, signal: this.reconciliationAbort.signal }); }
          catch { /* Keep mismatched or unavailable original payments frozen. */ }
        }
      }
      this.recoveryStatus = this.ledger.pendingRecovery().length ? 'pending' : 'complete';
    } catch { this.recoveryStatus = 'pending'; }
    this.scheduleDeliveryRecovery(origin);
    // Renaming an owned MCP entry must never delay or replace original payment recovery.
    if (this.accepting && this.codexIntegration.needsMigration) {
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
          () => {}, item.ownerCardMemberId, { fetcher: this.dependencies.fetcher });
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
    this.reconciliationAbort.abort();
    clearTimeout(this.deliveryRecoveryTimer);
    this.ledger.stopPayments();
    await Promise.allSettled([...this.active]);
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
      configuration.config, this.dependencies.now?.() ?? Date.now(), { facilitator, resourceId,
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
    if (this.purchaseExecutionMode() !== 'live_mainnet') throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
    const resource = this.activeResourceDefinitions().find(item => item.resourceId === resourceId);
    if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    return postRequestReview(authorizedRequestInstance(resource, sample), resource);
  }
  async quoteRegisteredResource(resourceId: string, sample: unknown, memberId: string) {
    this.ledger.assertCardMemberActive(memberId);
    if (this.purchaseExecutionMode() !== 'live_mainnet') throw new Error('UNSUPPORTED_PURCHASE_NETWORK');
    const resource = this.activeResourceDefinitions().find(item => item.resourceId === resourceId);
    if (!resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
    const instance = authorizedRequestInstance(resource, sample);
    assertGrantPostScope(resource, this.ledger.activeSpendGrant(this.dependencies.now?.() ?? Date.now(), memberId, 'live_mainnet', resourceId));
    const { quote } = await fetchResourceChallenge({ ...resource, request: instance }, this.environment, this.dependencies.fetcher);
    const preflight = await this.inspectQuotedPayment(resourceId, quote, memberId);
    return { resourceId, request: { url: instance.url, method: instance.method }, network: quote.network,
      assetId: quote.asset, assetDecimals: resource.decimals, amount: quote.amount,
      display: displayAmount(quote.amount).replace('test USDC', 'USDC'), payTo: quote.payTo,
      maxTimeoutSeconds: quote.maxTimeoutSeconds, preflight, paymentSent: false,
      notice: 'This is an unpaid snapshot. Every purchase obtains and validates a fresh quote.' };
  }
  private async readPaidResourceQuotes(origin: string, memberId: string) {
    if (this.purchaseExecutionMode() === 'live_mainnet') {
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
          assertGrantPostScope(resource, this.ledger.activeSpendGrant(this.dependencies.now?.() ?? Date.now(), memberId, 'live_mainnet', resource.resourceId));
          const { quote } = await fetchResourceChallenge(resource, this.environment, this.dependencies.fetcher);
          const preflight = await this.inspectQuotedPayment(resource.resourceId, quote, memberId);
          const requestInput = { ready: true, code: null, field: null };
          return { resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId, resourceUrl: resource.request.url,
            method: resource.request.method, amount: quote.amount, decimals: resource.decimals,
            display: displayAmount(quote.amount).replace('test USDC', 'USDC'),
            asset: quote.asset, network: quote.network, payTo: quote.payTo, quoteStatus: 'available' as const, preflight, requestInput };
        } catch {
          return { resourceId: resource.resourceId, name: resource.displayName ?? resource.resourceId,
            resourceUrl: resource.request.url, quoteStatus: 'unavailable' as const, code: 'RESOURCE_QUOTE_UNAVAILABLE' };
        }
      }));
      return { registeredResources, resources, testEnvironment: false };
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
    const grant = this.ledger.spendGrantSummary(this.dependencies.now?.() ?? Date.now(), 'live_mainnet', memberId, resourceId);
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
  listRegisteredResources() { return this.ledger.resources.list().map(resourceEntrySummary); }
  inspectRegisteredResource(id: string) { return resourceEntrySummary(this.ledger.resources.inspect(id)); }
  async discoverAgentResource(raw: unknown, principal: SpendPrincipal) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    const result = await this.track(discoverResource(raw));
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    return this.ledger.resources.recordDiscovery(result, principal);
  }
  registerAgentResource(raw: unknown, principal: SpendPrincipal) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    const entry = this.ledger.resources.addDiscovered(raw, principal);
    return { ...resourceEntrySummary(entry), registrationStatus: 'REGISTERED', spendingAuthorityCreated: false,
      paymentSent: false, notice: 'Registered by Agent. Review in Yosh and create a Spend Grant before purchasing.' };
  }
  addRegisteredResource(raw: unknown) {
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    return resourceEntrySummary(this.ledger.resources.add(raw));
  }
  disableRegisteredResource(id: string, state: 'DISABLED' | 'REMOVED') {
    if (!this.accepting) throw new ManagementApiError('SERVICE_STOPPING', 503, 'Yosh is stopping.');
    return resourceEntrySummary(this.ledger.resources.setState(id, state));
  }
  registeredResources() {
    if (this.purchaseExecutionMode() !== 'live_mainnet') return [];
    return this.activeResourceDefinitions().map(resource => {
      const entry = this.ledger.resources.inspect(resource.resourceId);
      return { ...registeredResourceSummary(resource), source: entry.source,
        ...(entry.submission ? { submission: entry.submission } : {}) };
    });
  }
  overview() { return this.track(this.readOverview()); }
  async refreshMainnetWallet() {
    if (this.purchaseExecutionMode() !== 'live_mainnet') return;
    try { await this.initializeWallet(); } catch { /* Identity failure is recorded in the shared snapshot. */ }
  }
  walletLibrary() { return this.ledger.walletLibrary.list(); }
  addLibraryWallet(raw: unknown) {
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
    return { ...overview, authority: this.authority(), service: { ...overview.service, execution: this.execution(), paymentEnabled: mode === 'live_devnet' || (mode === 'live_mainnet' && this.environment.productionExecutionEnabled),
      registeredResources: this.registeredResources() } };
  }
  private connectionFor(memberId: string) {
    const connection = this.memberConnections.get(memberId);
    if (!connection || !this.ledger.cardMember(memberId)) throw new Error('CARD_MEMBER_NOT_FOUND');
    return connection;
  }
  authenticateAgent(request: Request, capability: 'read' | 'request_purchase' = 'read') {
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
      purchases: this.ledger.listForOwner(memberId, 50),
      budget: this.ledger.managedSummary(now, this.purchaseExecutionMode()) };
  }
  membersOverview() { return this.ledger.cardMembers().map(member => ({ member, connection: this.connectionFor(member.id).status(),
    grant: this.spendGrantSummary(member.id) })); }
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
  setDailyLimit(value: string | null) { return this.ledger.setDailyLimit(value, this.purchaseExecutionMode()); }
  spendGrantSummary(memberId = this.ledger.defaultCardMember().id) {
    return this.ledger.spendGrantSummary(this.dependencies.now?.() ?? Date.now(), this.purchaseExecutionMode(), memberId);
  }
  setPaused(value: boolean) { return this.ledger.setPaused(value, this.purchaseExecutionMode()); }
  setAgentConnection(enabled: boolean, origin: string, memberId = this.ledger.defaultCardMember().id) {
    if (!this.accepting) throw new Error('SERVICE_STOPPING');
    this.ledger.assertCardMemberActive(memberId);
    this.ledger.revokeActiveSpendGrant(this.dependencies.now?.() ?? Date.now(), 'grant.REVOKED_CONNECTION_CHANGED', memberId);
    const connection = this.connectionFor(memberId);
    connection.setEnabled(enabled, origin);
    return connection.status();
  }
  /** Default member is the existing Codex identity; labels never select providers. */
  setMemberConnection(enabled: boolean, origin: string, memberId: string) {
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
  createSpendGrant(raw: unknown, memberId = this.ledger.defaultCardMember().id) {
    // Reject an environment switch before rotating credentials or reading test defaults.
    const mode = this.purchaseExecutionMode();
    const request = SpendGrantInputSchema.extend({ resourceId: z.string().min(1).max(200).optional(), sample: ResourceRequestInputSchema.optional(), postApprovalHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(raw);
    const { resourceId, sample, postApprovalHash, ...input } = request;
    const resource = mode === 'live_mainnet' ? this.activeResourceDefinitions().find(resource => resource.resourceId === resourceId) : undefined;
    if (mode === 'live_mainnet' && !resource) throw new Error('MAINNET_REGISTERED_RESOURCE_REQUIRED');
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
      if (mode === 'live_mainnet' && (this.authorityWalletStatus !== 'available' || !(livePayTo ?? resource?.recipient))) throw new Error('Mainnet wallet or recipient unavailable');
      if (mode === 'live_mainnet' && (livePayTo ?? resource?.recipient) === this.walletAddress) throw new Error('MAINNET_RESOURCE_REGISTRATION_INVALID');
      const connection = this.connectionFor(memberId);
      // A Grant changes spending authority, not Agent identity. Keep the
      // installed MCP credential/session stable; purchases bind to this
      // connection generation plus the new immutable Grant version.
      const principal = connection.principal('read');
      if (!principal) throw new Error('请先启用 Agent 连接。');
      const payTo = livePayTo ?? resource?.recipient ?? (process.env.DEMO_MERCHANT_PUBLIC_KEY || '4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs');
      return this.ledger.createSpendGrant(input, principal, {
        resourceId: resource?.resourceId ?? PAID_RESOURCE_SCOPE_ID,
        providerId: resource?.providerId ?? DEMO_MARKET_DATA_PROVIDER_ID,
        operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: resource?.network ?? DEVNET_NETWORK,
        assetId: resource?.mint ?? DEVNET_USDC_MINT,
        assetDecimals: 6,
        payTo,
        paymentScheme: 'exact',
        ...(resource?.request.method === 'POST' ? { postPolicyHash: postRequestPolicyHash(resource) } : {}),
      }, now, mode);
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
        const { quote } = await fetchResourceChallenge({ ...resource, request: instance }, this.environment, this.dependencies.fetcher);
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
    return requestPaidResourcePurchase(input, { config, ledger: this.ledger, origin, principal, execute: this.purchaseExecutionMode() !== 'simulated', fetcher: this.dependencies.fetcher, now: this.dependencies.now });
  }
  createTestPurchase(id: string, origin: string): Promise<TestPurchaseResult> {
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
