import { z } from 'zod';
import { appRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';
import { resourceManagement } from '@/modules/app/resource-management';
import { smallJson } from '@/modules/http/local-request';
import { MAX_RESOURCE_ENTRY_BYTES } from '@/modules/http/request-size-limits';
import { DiscoveryInput } from '@/modules/resources/mainnet-resource-discovery';
import { ResourceRequestInputSchema } from '@/modules/resources/http-resource';

export const runtime = 'nodejs';
const Input = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discovery'), discovery: DiscoveryInput }).strict(),
  z.object({ kind: z.literal('grant'), resourceId: z.string().min(1).max(200), sample: ResourceRequestInputSchema.optional() }).strict(),
]);

/** Local preview only. Even preparing a POST never contacts the merchant. */
export async function POST(request: Request) {
  return managementRoute(request, true, async verified => resourceManagement(() => (async () => {
    const input = Input.parse(await smallJson(verified, MAX_RESOURCE_ENTRY_BYTES));
    const review = input.kind === 'discovery' ? appRuntime().prepareResourceDiscovery(input.discovery)
      : appRuntime().prepareRegisteredResource(input.resourceId, input.sample ?? {});
    return Response.json(review, { headers: { 'cache-control': 'no-store' } });
  })()), MAX_RESOURCE_ENTRY_BYTES);
}
