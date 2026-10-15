import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtomicAmountSchema, PositiveAtomicAmountSchema, atomicAmount, addAtomic, remainingAtomic } from './atomic-money';

/** Economic decision input only; the purchase boundary validates execution evidence. */
export const SpendAuthorityFactsSchema = z.object({
  amount: PositiveAtomicAmountSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type SpendAuthorityFacts = z.infer<typeof SpendAuthorityFactsSchema>;

export const AuthorityDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'DENIED', 'REQUIRES_APPROVAL']),
  reason: z.string().min(1),
  committedBefore: AtomicAmountSchema,
  remainingAfter: AtomicAmountSchema,
}).strict();

export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;

export function parseStoredAuthorityDecision(raw: unknown): AuthorityDecision {
  if (raw !== null && typeof raw === 'object' && 'decision' in raw) {
    const decision = (raw as { decision?: unknown }).decision;
    if (decision === 'REJECTED') return AuthorityDecisionSchema.parse({ ...raw, decision: 'DENIED' });
    if (decision === 'NEEDS_CONFIRMATION') return AuthorityDecisionSchema.parse({ ...raw, decision: 'REQUIRES_APPROVAL' });
  }
  return AuthorityDecisionSchema.parse(raw);
}

export const DEFAULT_SPENDING_POLICY = Object.freeze({ singleLimit: '100000', dailyBudget: '1000000' });

export type SpendingControls = {
  dailyBudget: string | null;
  paused: boolean;
  singleLimit: string;
};

export type AuthorityLedgerState = { committed: bigint | string | number; hasUnknownPayment: boolean };

export function hash(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function evaluateSpendAuthority(
  raw: unknown,
  ledger: AuthorityLedgerState,
  now = Date.now(),
  controls: SpendingControls = {
    dailyBudget: DEFAULT_SPENDING_POLICY.dailyBudget,
    paused: false,
    singleLimit: DEFAULT_SPENDING_POLICY.singleLimit,
  },
): AuthorityDecision {
  const committed = atomicAmount(ledger.committed);
  const remaining = () => controls.dailyBudget === null ? '0' : remainingAtomic(controls.dailyBudget, committed).toString();
  const deny = (reason: string): AuthorityDecision => ({
    decision: 'DENIED', reason, committedBefore: committed.toString(), remainingAfter: remaining(),
  });
  const parsed = SpendAuthorityFactsSchema.safeParse(raw);
  if (!parsed.success) return deny('INVALID_SPEND_INTENT');
  const facts = parsed.data;
  if (facts.createdAt > now || facts.expiresAt <= now || facts.expiresAt <= facts.createdAt) return deny('SPEND_INTENT_EXPIRED_OR_INVALID');
  if (ledger.hasUnknownPayment) return deny('LEDGER_UNRESOLVED');
  if (controls.paused) return deny('PAYMENTS_PAUSED');
  if (controls.dailyBudget === null) return deny('DAILY_LIMIT_NOT_SET');
  const budget = atomicAmount(controls.dailyBudget); const single = atomicAmount(controls.singleLimit);
  const total = addAtomic(committed, atomicAmount(facts.amount));
  if (total > budget) return deny(budget === 0n ? 'DAILY_LIMIT_ZERO' : 'DAILY_BUDGET_EXCEEDED');
  const decision = atomicAmount(facts.amount) > single ? 'REQUIRES_APPROVAL' : 'APPROVED';
  return {
    decision,
    reason: decision === 'APPROVED' ? 'AUTHORITY_AND_BUDGET_PASSED' : 'SINGLE_LIMIT_EXCEEDED',
    committedBefore: committed.toString(),
    remainingAfter: (budget - total).toString(),
  };
}
