import { PAY_DEVELOPMENT_PROFILE } from '../src/modules/pay-dev/profile';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { startPayDevelopmentBackend } from '../src/modules/pay-dev/runtime';
import { startMainnetDevelopmentBackend } from '../src/modules/pay-dev/mainnet-runtime';
import { assertLoopbackPortsAvailable } from '../src/modules/pay-dev/port-availability';
import { startLiveDevnetDevelopmentBackend } from '../src/modules/pay-dev/live-devnet-runtime';

async function main() {
  if (!process.env.YOSH_DATA_DIR || !process.env.YOSH_PACKAGED_RUNTIME_DIR) throw new Error('PAY_DEVELOPMENT_LAUNCH_REQUIRED');
  if (!['offline', 'simulated', 'devnet', 'mainnet'].includes(process.env.YOSH_PAY_DEV_ENV ?? 'offline'))
    throw new Error('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  const fixturePort = process.env.YOSH_PAY_NATIVE_FIXTURE_PORT;
  const port = fixturePort === undefined ? PAY_DEVELOPMENT_PROFILE.backendPort : Number(fixturePort);
  if (fixturePort !== undefined && (!['devnet', 'simulated'].includes(process.env.YOSH_PAY_DEV_ENV ?? '')
    || !Number.isInteger(port) || port < 1024 || port > 65535 || String(port) !== fixturePort
    || resolve(process.env.YOSH_DATA_DIR).startsWith(join(userInfo().homedir, 'Library', 'Application Support'))))
    throw new Error('PAY_NATIVE_FIXTURE_REJECTED');
  if (fixturePort === undefined && PAY_DEVELOPMENT_PROFILE.bundleIdentifier === 'com.yosh.pay-development.v011rc5') {
    await assertLoopbackPortsAvailable([PAY_DEVELOPMENT_PROFILE.backendPort,
      PAY_DEVELOPMENT_PROFILE.merchantPort, PAY_DEVELOPMENT_PROFILE.rpcPort]);
  }
  const backend = process.env.YOSH_PAY_DEV_ENV === 'mainnet'
    ? await startMainnetDevelopmentBackend({ directory: resolve(process.env.YOSH_DATA_DIR), port })
    : ['devnet', 'simulated'].includes(process.env.YOSH_PAY_DEV_ENV ?? '')
    ? await startLiveDevnetDevelopmentBackend({ directory: resolve(process.env.YOSH_DATA_DIR), port })
    : await startPayDevelopmentBackend({ directory: resolve(process.env.YOSH_DATA_DIR),
      runtimeDirectory: resolve(process.env.YOSH_PACKAGED_RUNTIME_DIR), port });
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
