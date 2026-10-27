import { appRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';
import { resourceManagement } from '@/modules/app/resource-management';
import { DiscoveryInput } from '@/modules/resources/mainnet-resource-discovery';
import { smallJson } from '@/modules/http/local-request';
import { z } from 'zod';
import { MAX_RESOURCE_ENTRY_BYTES } from '@/modules/http/request-size-limits';
const Input = DiscoveryInput.extend({ postApprovalHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return managementRoute(request, true, async verified => resourceManagement(async () => {
    const { postApprovalHash, ...input } = Input.parse(await smallJson(verified, MAX_RESOURCE_ENTRY_BYTES));
    return Response.json(await appRuntime().discoverResource(input, postApprovalHash));
  }), MAX_RESOURCE_ENTRY_BYTES);
}
