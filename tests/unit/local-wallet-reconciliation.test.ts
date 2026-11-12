import { expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
it('does not race the live wallet creator; after restart only reads the fixed original wallet before completing its receipt', async () => {
  const consume = vi.fn(), existingWallets = vi.fn(async () => [{ id: 'devnet', provisioningState: 'existing', address: 'original-public-key' }]);
  const context = {
    walletProvisioning: Promise.resolve({ address: 'original-public-key', reused: false }) as Promise<{ address: string; reused: boolean }> | undefined,
    localAuthorizationEnvironment: () => 'devnet', dependencies: {}, existingWallets,
    ledger: { localControlApprovals: () => ({ consume, claimedRequests: () => [{ request: { id: 'original-request', action: { type: 'create_wallet' } }, digest: 'original-digest' }] }) },
  };
  await Reflect.apply(AppRuntime.prototype.reconcileLocalControlSetup, context, ['member']);
  expect(existingWallets).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  context.walletProvisioning = undefined;
  await Reflect.apply(AppRuntime.prototype.reconcileLocalControlSetup, context, ['member']);
  expect(existingWallets).toHaveBeenCalledTimes(1);
  expect(consume).toHaveBeenCalledWith({ requestId: 'original-request', digest: 'original-digest' }, expect.any(Number));
});
