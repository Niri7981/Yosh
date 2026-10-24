import { PAY_DEVELOPMENT_PROFILE } from '../src/modules/pay-dev/profile';
import { resolve } from 'node:path';
import { startPayDevelopmentBackend } from '../src/modules/pay-dev/runtime';
import { startMainnetDevelopmentBackend } from '../src/modules/pay-dev/mainnet-runtime';
import { assertLoopbackPortsAvailable } from '../src/modules/pay-dev/port-availability';

async function main() {
  if (!process.env.YOSH_DATA_DIR || !process.env.YOSH_PACKAGED_RUNTIME_DIR) throw new Error('PAY_DEVELOPMENT_LAUNCH_REQUIRED');
  if (PAY_DEVELOPMENT_PROFILE.bundleIdentifier === 'com.yosh.pay-development.v011rc5') {
    await assertLoopbackPortsAvailable([PAY_DEVELOPMENT_PROFILE.backendPort,
      PAY_DEVELOPMENT_PROFILE.merchantPort, PAY_DEVELOPMENT_PROFILE.rpcPort]);
  }
  const backend = process.env.YOSH_PAY_DEV_ENV === 'mainnet'
    ? await startMainnetDevelopmentBackend({ directory: resolve(process.env.YOSH_DATA_DIR), port: PAY_DEVELOPMENT_PROFILE.backendPort })
    : await startPayDevelopmentBackend({ directory: resolve(process.env.YOSH_DATA_DIR),
      runtimeDirectory: resolve(process.env.YOSH_PACKAGED_RUNTIME_DIR), port: PAY_DEVELOPMENT_PROFILE.backendPort });
  let quitting = false;
  const quit = async () => {
    if (quitting) return; quitting = true;
    try { await backend.close(); process.exitCode = 0; }
    catch { console.error('PAY_DEVELOPMENT_SHUTDOWN_INCOMPLETE'); process.exitCode = 1; }
  };
  process.once('SIGTERM', () => { void quit(); }); process.once('SIGINT', () => { void quit(); });
  console.error('YOSH_PAY_DEV_READY');
}
void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message
    : error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code) ? error.code : 'UNCLASSIFIED';
  console.error(`YOSH_PAY_DEV_STARTUP_FAILED:${code}`); process.exitCode = 1;
});
