/** A provider guarantee, created only by a synchronous consent check BEFORE
 * calling any purchase/reserve/execution entry point. Never wrap an awaited
 * authorization or infer safety from a later absence of payment evidence. */
export function payMainnetConsentDecision(check: () => void): { decision: 'RejectBeforeExecution' } | undefined {
  try { check(); }
  catch (error) {
    // Missing receipt and a valid but non-matching/expired receipt are known
    // preconditions. IO, malformed state and all other errors remain unknown.
    if (error instanceof Error && (error.message === 'PAY_MAINNET_ACCEPTANCE_REQUIRED'
      || ('code' in error && error.code === 'ENOENT'))) return { decision: 'RejectBeforeExecution' };
    throw error;
  }
}
