import { appRuntime } from '@/modules/app/app-runtime';
import { smallJson } from '@/modules/http/local-request';
import { AgentDeliveryRecoveryInput, AgentPurchaseSummary, DeliveryRecoveryErrors } from '@/modules/mcp/purchase-read-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request, 'request_purchase'); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  const input = AgentDeliveryRecoveryInput.safeParse(await smallJson(request).catch(() => null));
  if (!input.success || new URL(request.url).search)
    return Response.json({ code: 'MPP_DELIVERY_RECOVERY_INPUT_INVALID' }, { status: 400 });
  try {
    const summary = await app.recoverPurchaseDelivery(input.data.purchaseId, principal);
    return Response.json(AgentPurchaseSummary.parse(summary), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    for (const [code, status] of Object.entries(DeliveryRecoveryErrors)) {
      if (code === message) return Response.json({ code }, { status });
    }
    return Response.json({ code: 'MPP_DELIVERY_RECOVERY_UNAVAILABLE' }, { status: 503 });
  }
}
