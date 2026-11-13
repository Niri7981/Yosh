import { z } from 'zod';
import { existingAppRuntime } from '@/modules/app/app-runtime';
import { ManagementApiError, managementRoute } from '@/modules/app/management-auth';
import { smallJson } from '@/modules/http/local-request';

const Input = z.object({ action: z.literal('shutdown'), pid: z.number().int().safe().positive(),
  runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const runtime = 'nodejs';

/** Bind shutdown to the authenticated owner that was actually inspected. A
 * replacement process can share management credentials without owning this stop. */
export async function POST(request: Request) {
  return managementRoute(request, true, async verified => {
    const input = Input.parse(await smallJson(verified));
    const backend = existingAppRuntime();
    if (!backend || process.pid !== input.pid)
      throw new ManagementApiError('MAINNET_STANDALONE_OWNER_MISMATCH', 409, '主网后台身份已变化，请重新检查运行状态。');
    const hosting = backend.healthStatus().hosting;
    if (hosting?.kind !== 'mainnet-standalone')
      throw new ManagementApiError('MAINNET_STANDALONE_LIFECYCLE_FORBIDDEN', 403, '此入口不能停止原 App 后台。');
    if (hosting.runtimeDigest !== input.runtimeDigest)
      throw new ManagementApiError('MAINNET_STANDALONE_OWNER_MISMATCH', 409, '主网后台版本已变化，请重新检查运行状态。');
    await backend.prepareQuit();
    // Preserve the existing signer drain and allow the authenticated reply to flush.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref();
    return Response.json({ ready: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
