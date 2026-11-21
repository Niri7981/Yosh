import type { RemotePurchaseConsent } from '../purchases/remote-simulated-purchase';
import { confirmRemoteAction } from './confirm';

export function confirmRemotePurchaseConsent(facts: RemotePurchaseConsent) {
  const { expiresAt: grantExpiresAt, ...rest } = facts;
  return confirmRemoteAction('remote-simulated-purchase', { ...rest, grantExpiresAt });
}
