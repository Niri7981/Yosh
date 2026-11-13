import { appRuntime } from '@/modules/app/app-runtime';
import { readAgentPurchase } from '@/modules/purchases/agent-purchase-read';
import { AgentPurchaseReadInput } from '@/modules/mcp/purchase-read-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  const query = new URL(request.url).searchParams;
  const input = AgentPurchaseReadInput.safeParse(Object.fromEntries(query));
  if (!input.success || [...query.keys()].length !== 1)
    return Response.json({ code: 'PURCHASE_READ_INPUT_INVALID' }, { status: 400 });
  try {
    const result = readAgentPurchase(app.ledger, principal.cardMemberId, input.data);
    return result ? Response.json(result, { headers: { 'cache-control': 'no-store' } })
      : Response.json({ code: 'PURCHASE_NOT_FOUND' }, { status: 404 });
  } catch { return Response.json({ code: 'PURCHASE_READ_UNAVAILABLE' }, { status: 503 }); }
}
