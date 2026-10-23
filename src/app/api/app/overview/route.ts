import { YOSH_PRODUCT_RELEASE } from '@/modules/app/product-version';
import { appRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return managementRoute(request, false, async () => { return Response.json({ ...await appRuntime().overview(), product: YOSH_PRODUCT_RELEASE }, { headers: { 'cache-control': 'no-store' } }); });
}
