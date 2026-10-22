import { z } from 'zod';
import { existingAppRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';
import { smallJson } from '@/modules/http/local-request';

const Input = z.object({ action: z.enum(['prepareQuit', 'shutdown', 'prepareEnvironmentSwitch']) }).strict();
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return managementRoute(request, true, async request => {
    const { action } = Input.parse(await smallJson(request));
    if (action === 'prepareEnvironmentSwitch') await existingAppRuntime()?.prepareEnvironmentSwitch();
    else await existingAppRuntime()?.prepareQuit();
    if (action === 'shutdown') {
      // The signer has drained before the backend asks Next to exit. Give the HTTP response time to flush.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref();
    }
    return Response.json({ ready: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
