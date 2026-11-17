import { z } from 'zod';
import { appRuntime } from '@/modules/app/app-runtime';
import { ResourceRequestInputSchema } from '@/modules/resources/http-resource';
import { MAX_RESOURCE_ENTRY_BYTES } from '@/modules/http/request-size-limits';
import { smallJson } from '@/modules/http/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Input = z.object({ resourceId: z.string().min(1).max(200), sample: ResourceRequestInputSchema.optional() }).strict();
export async function POST(request: Request) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  try {
    const input = Input.parse(await smallJson(request, MAX_RESOURCE_ENTRY_BYTES));
    return Response.json(await app.quoteMppResource(input.resourceId, input.sample ?? {}, principal.cardMemberId),
      { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const code = error instanceof Error && ['MPP_MAINNET_ACCEPTANCE_REQUIRED'].includes(error.message)
      ? error.message : 'RESOURCE_QUOTE_UNAVAILABLE';
    return Response.json({ code }, { status: 422 });
  }
}
