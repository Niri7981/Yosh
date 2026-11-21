import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { PaymentRequirements } from '@x402/core/types';
import { hash } from '../authority/authority-policy';
import { PAID_RESOURCE_PURCHASE_OPERATION, type SpendPrincipal } from '../authority/spend-grant';
import { DEVNET_NETWORK, DEVNET_USDC_MINT } from '../payment/payment-environment';
import { demoSnapshot } from '../paid-market-api/paid-market-api';
import { paidResource, parsePaidResourceDelivery } from '../resources/paid-resources';
import { remotePurchaseInput, remotePurchaseLookup } from '../remote/purchase-contract';
import type { PurchaseLedger, SpendReservation } from './purchase-ledger';
import { paymentStatusFor } from './purchase-state';

export type RemotePurchaseConsent = { action: 'pair' | 'grant'; account: string; label: string; environment: 'simulated';
  pairingId?: string; resourceId?: string; totalLimit?: string; singleLimit?: string; expiresAt?: number };

const markerName = 'remote-purchase-sandbox-v1';
function sandboxRoot(directory: string) {
  const st = lstatSync(directory), path = realpathSync(directory);
  if (!st.isDirectory() || !/^yosh-p2-[\w-]+$/.test(basename(path)) || st.uid !== process.getuid?.()
      || (st.mode & 0o777) !== 0o700 || dirname(path) !== realpathSync(tmpdir())) throw Error('REMOTE_PURCHASE_SANDBOX_REQUIRED');
  return path;
}
export function initializeRemotePurchaseSandbox(directory: string) {
  const root = sandboxRoot(directory);
  if (readdirSync(root).length) throw Error('REMOTE_PURCHASE_SANDBOX_MUST_BE_EMPTY');
  writeFileSync(join(root, markerName), randomUUID(), { flag: 'wx', mode: 0o600 });
}
export function checkSandboxDatabases(directory: string) {
  const root = sandboxRoot(directory);
  // A user may restart a sandbox, but even a valid marker must not turn a link to another wallet into a database handle.
  for (const name of readdirSync(root).filter(name => /\.sqlite(?:$|[.-])/.test(name))) {
    const st = lstatSync(join(root, name));
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw Error('REMOTE_PURCHASE_UNSAFE_DATABASE');
  }
}
export function sandboxWalletIdentity(directory: string) {
  const path = join(sandboxRoot(directory), markerName), st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.size !== 36)
    throw Error('REMOTE_PURCHASE_SANDBOX_REQUIRED');
  return 'sandbox:' + z.uuid().parse(readFileSync(path, 'utf8'));
}

const resourceId = 'market-snapshot';
const descriptor = paidResource(resourceId);
export const simulationGrantScope = Object.freeze({ resourceId, providerId: descriptor.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
  network: DEVNET_NETWORK, assetId: DEVNET_USDC_MINT, assetDecimals: 6, payTo: 'yosh-isolated-simulator', paymentScheme: 'simulated' });
// Synthetic price, not a quote from a live merchant. There is no network or signer in this execution path.
const quote: PaymentRequirements = Object.freeze({ scheme: 'simulated', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT,
  amount: '3000000', payTo: simulationGrantScope.payTo, maxTimeoutSeconds: 300, extra: {} });
const output = parsePaidResourceDelivery(resourceId, { resource_id: 'sol-market-snapshot', asset: 'SOL', as_of: demoSnapshot.as_of,
  spot_price_usd: demoSnapshot.spot_price_usd, source_label: demoSnapshot.source_label, is_demo_snapshot: true });
const binding = (wallet: string) => hash(['yosh-remote-simulated-purchase-v1', wallet, resourceId, quote]);
function summary(record: SpendReservation, reused: boolean) {
  return { requestId: record.intent.idempotencyKey, purchaseId: record.intent.id, resourceId, simulated: true, reused,
    status: record.status, paymentStatus: paymentStatusFor(record.status), deliveryStatus: record.deliveryStatus,
    reason: record.decision.reason, amountAtomic: record.intent.amount, asset: { id: record.intent.assetId, decimals: 6, network: DEVNET_NETWORK },
    grantId: record.intent.authority?.grantId ?? null,
    ...(record.status === 'PAID' && record.deliveryStatus === 'COMPLETE' ? { resource: parsePaidResourceDelivery(resourceId, record.data) } : {}) };
}
function checkRecord(record: SpendReservation, principal: SpendPrincipal, wallet: string) {
  if (record.ownerCardMemberId !== principal.cardMemberId || record.executionMode !== 'simulated' ||
      record.monetaryScope.walletIdentity !== wallet || record.intent.executionBinding !== binding(wallet) ||
      record.intent.resourceId !== resourceId || record.intent.authority && (record.intent.authority.connectionId !== principal.connectionId ||
      record.intent.authority.connectionGeneration !== principal.connectionGeneration)) throw Error('REQUEST_ID_CONFLICT');
}

export function lookupSimulatedPurchase(ledger: PurchaseLedger, principal: SpendPrincipal, raw: unknown, wallet: string) {
  const { requestId } = remotePurchaseLookup.parse(raw);
  const record = ledger.getOwned(requestId, principal.cardMemberId);
  if (!record) throw Error('REMOTE_PURCHASE_NOT_FOUND');
  checkRecord(record, principal, wallet);
  return summary(record, true);
}
export function purchaseInSimulator(ledger: PurchaseLedger, principal: SpendPrincipal, raw: unknown, wallet: string, now: number) {
  const input = remotePurchaseInput.parse(raw);
  let existing = ledger.getOwned(input.requestId, principal.cardMemberId);
  if (existing?.status === 'APPROVED' && existing.intent.expiresAt <= now) {
    ledger.releaseExpired(now, ledger.scope('simulated'));
    existing = ledger.getOwned(input.requestId, principal.cardMemberId);
  }
  const authority = existing ? undefined : ledger.spendAuthorityForDecision(principal, PAID_RESOURCE_PURCHASE_OPERATION, now, 'simulated', resourceId);
  const record = existing ?? ledger.reserve({ id: randomUUID(), idempotencyKey: input.requestId, requestHash: hash(input),
    resourceId, providerId: descriptor.providerId, resultAudience: 'account', amount: quote.amount, currency: 'USDC',
    assetDecimals: 6, assetId: quote.asset, network: quote.network, payTo: quote.payTo, paymentScheme: quote.scheme,
    quoteFingerprint: hash(quote), executionBinding: binding(wallet), createdAt: now, expiresAt: now + 300_000, authority,
  }, quote, now, 'simulated', principal.cardMemberId);
  checkRecord(record, principal, wallet);
  if (record.intent.requestHash !== hash(input)) throw Error('REQUEST_ID_CONFLICT');
  if (record.status === 'APPROVED') {
    // Only resume an unclaimed original approval. An uncertain or previously claimed record is never charged again.
    const settled = ledger.settleSimulatedApproval(record.approvalId, now, output);
    return summary(settled, Boolean(existing));
  }
  return summary(record, Boolean(existing));
}
