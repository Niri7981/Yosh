import { appRuntime } from '@/modules/app/app-runtime';
import { localRequestOrigin, smallJson } from '@/modules/http/local-request';
import { PurchaseRequestInputSchema } from '@/modules/purchases/purchase-request-input';
import { MAX_RESOURCE_ENTRY_BYTES } from '@/modules/http/request-size-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request, 'request_purchase'); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  try {
    const input = PurchaseRequestInputSchema.parse(await smallJson(request, MAX_RESOURCE_ENTRY_BYTES));
    return Response.json(await app.requestMppPurchase(input, localRequestOrigin(request), principal), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : '';
    const code = ['REQUEST_ID_CONFLICT', 'MPP_MAINNET_ACCEPTANCE_REQUIRED', 'MPP_ISOLATED_RUNTIME_REQUIRED',
      'MPP_PROTOCOL_UNAVAILABLE', 'MPP_REGISTERED_RESOURCE_REQUIRED', 'MPP_RESOURCE_UNSUPPORTED', 'MPP_QUOTE_BINDING_INVALID',
      'MPP_CHALLENGE_REQUIRED', 'MPP_CHALLENGE_ALREADY_USED', 'SERVICE_STOPPING'].includes(candidate) ? candidate : 'MPP_PURCHASE_REQUEST_FAILED';
    return Response.json({ code, error: 'Read the original purchase ID before retrying; an interrupted response does not prove no payment.' }, { status: 400 });
  }
}
