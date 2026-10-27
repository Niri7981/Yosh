import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppRuntime } from '../app/app-runtime';
import { resolveYoshConfiguration } from '../app/yosh-configuration';
import { admitDevnetDevelopment, admitSimulatedDevelopment, isDevnetDevelopment, isSimulatedDevelopment } from './environment';
import { serveDevelopmentRuntime } from './management-server';
import { PAY_DEVELOPMENT_PROFILE } from './profile';

/** Real product runtime in a distinct test store. This path does not install a
 * simulator, replace fetch, copy a signer, provision a wallet or enable Mainnet. */
export async function startLiveDevnetDevelopmentBackend(options: { directory: string; port?: number }) {
  const devnet = isDevnetDevelopment(options.directory);
  const simulated = isSimulatedDevelopment(options.directory);
  if (!devnet && !simulated) throw new Error('PAY_DEVELOPMENT_ENVIRONMENT_REJECTED');
  if (devnet ? process.env.YOSH_PAY_MCP_DEVNET !== '1' : process.env.YOSH_PAY_MCP_DEVNET === '1')
    throw new Error('PAY_DEVNET_CONFIGURATION_REQUIRED');
  if (devnet) admitDevnetDevelopment(options.directory);
  else admitSimulatedDevelopment(options.directory);
  const port = options.port ?? PAY_DEVELOPMENT_PROFILE.backendPort;
  const configuredPort = resolveYoshConfiguration().port;
  if (configuredPort !== undefined && configuredPort !== String(port)) throw new Error('PAY_DEVELOPMENT_PORT_MISMATCH');
  process.env.YOSH_PORT = String(port);
  const origin = `http://127.0.0.1:${port}`;
  const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  const previous = globals.__yosh;
  const app = new AppRuntime(options.directory);
  globals.__yosh = { runtime: app };
  const descriptor = { version: 1, profile: devnet ? 'pay-mcp-devnet' : 'pay-mcp-simulated', origin,
    memberId: app.ledger.defaultCardMember().id };
  try {
    const temporary = join(options.directory, `.runtime-${randomUUID()}.json`);
    writeFileSync(temporary, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, join(options.directory, devnet ? 'pay-devnet-runtime.json' : 'pay-simulated-runtime.json'));
    const folder = openSync(options.directory, 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
    return await serveDevelopmentRuntime({ app, origin, port, descriptor, async cleanup() { globals.__yosh = previous; } });
  } catch (error) {
    await app.prepareQuit(); app.close(); globals.__yosh = previous; throw error;
  }
}
