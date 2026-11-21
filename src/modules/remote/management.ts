import { z } from 'zod';
import type { AppRuntime } from '../app/app-runtime';
import { ManagementApiError, managementRoute } from '../app/management-auth';
import { smallJson } from '../http/local-request';
import { SpendGrantInputSchema } from '../authority/spend-grant';
import { pairingRequest, purchasePairingRequest } from './pairings';

const change = z.union([
  purchasePairingRequest.extend({ action: z.literal('pair') }),
  SpendGrantInputSchema.extend({ action: z.literal('grant'), id: z.uuid(), resourceId: z.literal('market-snapshot') }).strict(),
  z.object({ action: z.literal('revoke_grant'), id: z.uuid(), grantId: z.uuid() }).strict(),
  pairingRequest.extend({ action: z.literal('pair') }),
  z.object({ action: z.literal('revoke'), id: z.uuid() }).strict(),
]);

export function handleRemoteReadPairings(runtime: AppRuntime | (() => AppRuntime), request: Request) {
  return managementRoute(request, request.method !== 'GET', async verified => {
    if (new URL(verified.url).search) throw new ManagementApiError('INVALID_REQUEST', 400, '配对请求无效。');
    const app = typeof runtime === 'function' ? runtime() : runtime;
    if (verified.method === 'GET') return Response.json({ pairings: app.listRemoteReadPairings() });
    if (verified.method !== 'POST') throw new ManagementApiError('METHOD_NOT_ALLOWED', 405, '不支持此操作。');
    const input = change.parse(await smallJson(verified, 2048));
    if (input.action === 'revoke') return Response.json(app.revokeRemoteReadPairing(input.id));
    if (input.action === 'grant') {
      const { id, resourceId, totalLimit, singleLimit, expiresAt } = input;
      return Response.json(await app.createRemotePurchaseGrant(id, { resourceId, totalLimit, singleLimit, expiresAt }), { status: 201 });
    }
    if (input.action === 'revoke_grant') return Response.json(app.revokeRemotePurchaseGrant(input.id, input.grantId));
    if (input.scopes[0] === 'purchase') return Response.json(await app.issueRemotePurchasePairing(input.label), { status: 201 });
    return Response.json(await app.issueRemoteReadPairing(input.label, pairingRequest.parse({ label: input.label, scopes: input.scopes }).scopes), { status: 201 });
  }, 2048);
}
