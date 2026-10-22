import { z } from 'zod';
import { appRuntime } from '@/modules/app/app-runtime';
import { localRequestOrigin, smallJson } from '@/modules/http/local-request';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const origin = localRequestOrigin(request);
    const app = appRuntime();
    const principal = app.authenticateAgent(request, 'request_purchase');
    const { action } = z.object({ action: z.enum(['authorize', 'plan', 'execute']) }).parse(await context.params);
    const result = await app.payMcpOperation(action, await smallJson(request, 131_072), principal, origin);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ code: 'PAY_CONTROLLED_REQUEST_REJECTED' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
}
