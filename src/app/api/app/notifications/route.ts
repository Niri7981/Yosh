import { z } from 'zod';
import { appRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';
import { hash } from '@/modules/purchases/spending-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return managementRoute(request, false, async () => {
    const input = z.object({ after: z.string().regex(/^(0|[1-9]\d{0,15})$/)
      .transform(Number).refine(Number.isSafeInteger).optional() }).strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const app = appRuntime();
    const member = app.ledger.defaultCardMember();
    const storeId = hash([app.directory, member.id, member.createdAt]);
    return Response.json({ storeId, ...app.ledger.notificationEvents(input.after) });
  });
}
