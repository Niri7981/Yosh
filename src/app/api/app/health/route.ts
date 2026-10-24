import { YOSH_PRODUCT_RELEASE } from '@/modules/app/product-version';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { managementRoute } from '@/modules/app/management-auth';
import { appRuntime, runtimeDataDirectory } from '@/modules/app/app-runtime';
import { DataDirectoryInUseError } from '@/modules/app/data-directory-owner';
import { YoshConfigurationError } from '@/modules/app/yosh-configuration';
import { PaymentEnvironmentError } from '@/modules/payment/payment-environment';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return managementRoute(request, false, async () => {
    let directory = runtimeDataDirectory();
    try { directory = realpathSync(directory); } catch { directory = resolve(directory); }
    let backend;
    try { backend = appRuntime(); }
    catch (error) {
      const code = error instanceof DataDirectoryInUseError ? 'DATA_DIRECTORY_IN_USE'
        : error instanceof YoshConfigurationError || error instanceof PaymentEnvironmentError ? 'CORE_CONFIGURATION_INVALID'
        : error instanceof Error && ['EXECUTION_SELECTION_INVALID', 'MAINNET_RESOURCE_REGISTRATION_INVALID'].includes(error.message)
          ? 'CORE_CONFIGURATION_INVALID' : 'CORE_INITIALIZATION_FAILED';
      // Whitelisted operational labels only: never the original exception or config.
      console.error(`YOSH_STARTUP_${code}`);
      return Response.json({ ready: false, coreReady: false, service: 'Yosh', product: YOSH_PRODUCT_RELEASE, pid: process.pid,
        dataDirectory: directory, wallet: 'walletChecking', recovery: 'recoveryPending', code }, { status: 503 });
    }
    void backend.start(new URL(request.url).origin).catch(() => undefined);
    return Response.json({ ready: true, service: 'Yosh', product: YOSH_PRODUCT_RELEASE, pid: process.pid,
      dataDirectory: realpathSync(backend.directory), ...backend.healthStatus() },
      { headers: { 'cache-control': 'no-store' } });
  });
}
