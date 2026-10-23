import { z } from 'zod';
import { appRuntime } from '@/modules/app/app-runtime';
import { MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES } from '@/modules/resources/http-resource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ purchaseId: string }> };
export async function GET(request: Request, context: Context) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).safeParse((await context.params).purchaseId);
  const query = new URL(request.url).searchParams;
  const offset = z.coerce.number().int().min(0).max(MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES).safeParse(query.get('offset') ?? '0');
  if (!id.success || !offset.success || [...query.keys()].some(key => key !== 'offset'))
    return Response.json({ code: 'INVALID_DELIVERY_CURSOR' }, { status: 400 });
  const record = app.ledger.getOwned(id.data, principal.cardMemberId);
  if (!record || record.status !== 'PAID' || record.deliveryStatus !== 'COMPLETE' || record.data === undefined)
    return Response.json({ code: 'DELIVERY_NOT_AVAILABLE' }, { status: 404 });
  const data = Buffer.from(JSON.stringify(record.data));
  if (data.length > MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES || offset.data > data.length) return Response.json({ code: 'DELIVERY_NOT_AVAILABLE' }, { status: 404 });
  const end = Math.min(offset.data + 16_384, data.length);
  return Response.json({ purchaseId: id.data, encoding: 'base64', contentType: 'application/json', totalBytes: data.length,
    offset: offset.data, chunk: data.subarray(offset.data, end).toString('base64'), nextOffset: end < data.length ? end : null },
  { headers: { 'cache-control': 'no-store' } });
}
