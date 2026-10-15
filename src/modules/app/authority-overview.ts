import type { PurchaseLedger, PurchaseExecutionMode } from '../purchases/purchase-ledger';
import type { AgentConnection } from '../mcp/connection';

export function assembleAuthorityOverview(ledger: PurchaseLedger, agentConnection: AgentConnection,
  wallet: { address: string; reused: boolean }, service: { status: 'running' | 'stopping'; recoveryStatus: 'idle' | 'running' | 'complete' | 'pending' },
  now: number, mode: PurchaseExecutionMode, memberId: string) {
  const budget = ledger.managedSummary(now, mode);
  const unit = mode === 'live_mainnet' ? 'USDC' : 'test USDC';
  const display = (value: string | null) => value === null ? '未设置' : `${BigInt(value) / 1_000_000n}.${String(BigInt(value) % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')} ${unit}`;
  return { service: { ...service, network: mode === 'live_mainnet' ? 'Solana Mainnet' : 'Solana Devnet', testEnvironment: mode !== 'live_mainnet', purchaseMode: mode },
    wallet, budget: { ...budget, dailyLimitDisplay: display(budget.dailyLimit), paidDisplay: display(budget.paid),
      reservedDisplay: display(budget.reserved), remainingDisplay: display(budget.remaining) },
    grant: ledger.spendGrantSummary(now, mode, memberId), purchases: ledger.listForOwner(memberId, 50), connection: agentConnection.status() };
}
