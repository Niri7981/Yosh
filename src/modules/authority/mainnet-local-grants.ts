import { z } from 'zod';
import type { AppRuntime } from '../app/app-runtime';
import { managementRoute } from '../app/management-auth';
import { smallJson } from '../http/local-request';
import { SpendGrantInputSchema } from './spend-grant';

const Identity = z.object({ memberId: z.uuid(), sessionHash: z.string().regex(/^[a-f0-9]{64}$/) });
const Input = z.discriminatedUnion('action', [
  Identity.extend({ action: z.literal('state') }).strict(),
  Identity.extend({ action: z.literal('freeze'), draft: SpendGrantInputSchema.extend({ resourceId: z.string().min(1).max(200) }).strict() }).strict(),
  Identity.extend({ action: z.enum(['read', 'cancel', 'commit']), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
]);

/** Additive management entry. Agent authentication cannot call it; browser
 * credentials and approval booleans are never accepted as management proofs.
 * The trusted web controller performs native confirmation before commit. */
export function mainnetLocalGrants(request: Request, app: AppRuntime) {
  return managementRoute(request, true, async verified => {
    try {
      if (app.localGrantEnvironment() !== 'mainnet') throw new Error('LOCAL_WEB_ENVIRONMENT_UNAVAILABLE');
      const input = Input.parse(await smallJson(verified));
      app.ledger.assertCardMemberActive(input.memberId);
      if (input.action === 'state') {
        const state = app.memberOverview(input.memberId);
        return Response.json({ environment: 'mainnet', realFunds: true, controlsAvailable: false,
          walletSetup: { available: false }, member: { id: state.member.id, label: state.member.label },
          connection: { enabled: state.connection.enabled, state: state.connection.integration?.state ?? 'disconnected' },
          budget: state.budget, resources: app.registeredResources().map(r => ({ resourceId: r.resourceId, displayName: r.name })),
          wallets: (await app.existingWallets()).filter(w => w.id === 'mainnet').map(w => ({ id: w.id, address: w.address, status: w.status })),
          grants: state.grants, purchases: state.purchases.map(p => ({ purchaseId: p.purchaseId, resourceId: p.resourceId, amount: p.amount, paymentStatus: p.status, deliveryStatus: p.deliveryStatus })),
        });
      }
      if (input.action === 'freeze') return Response.json(await app.freezeLocalGrant(input.draft, input.memberId, input.sessionHash));
      const approvals = app.ledger.localGrantApprovals(), frozen = approvals.read(input.id);
      if (frozen.request.sessionHash !== input.sessionHash || frozen.request.binding.principal.cardMemberId !== input.memberId
        || frozen.request.environment !== 'mainnet') throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
      if (input.action === 'cancel') return Response.json(approvals.cancel(input.id, input.sessionHash));
      if (input.action === 'commit' && frozen.state !== 'CONSUMED') {
        if (input.digest !== frozen.digest) throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
        await app.commitLocalGrant({ requestId: input.id, digest: input.digest }, input.sessionHash);
      }
      return Response.json(approvals.read(input.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return Response.json({ code: /^LOCAL_[A-Z_]+$/.test(message) ? message : 'LOCAL_WEB_REQUEST_REJECTED' }, { status: 400 });
    }
  });
}
