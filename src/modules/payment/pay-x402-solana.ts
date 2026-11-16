import { executeApprovedPayment } from '../purchases/approved-payment';

// Adapted from the preserved payment-router worktree; retain the original promise and custody gates.
export const executePayX402Solana = executeApprovedPayment;
