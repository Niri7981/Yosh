import { AppRuntime } from '../app/app-runtime';
import { isMainnetDevelopment } from './environment';
import { serveDevelopmentRuntime } from './management-server';
import { resolveYoshConfiguration } from '../app/yosh-configuration';

/** Same Dev App, real product runtime, separate environment storage. Startup
 * never provisions a wallet, signs, enables payments or loads an Offline key. */
export async function startMainnetDevelopmentBackend(options: { directory: string; port?: number }) {
  if (!isMainnetDevelopment(options.directory) || process.env.YOSH_PAY_MCP_MAINNET !== '1') throw new Error('PAY_MAINNET_CONFIGURATION_REQUIRED');
  const port = options.port ?? 13049;
  const configuredPort = resolveYoshConfiguration().port;
  if (configuredPort !== undefined && configuredPort !== String(port)) throw new Error('PAY_DEVELOPMENT_PORT_MISMATCH');
  // The native launcher supplies PORT for the server, while the authority
  // descriptor reads YOSH_PORT. Bind both to this same validated listener.
  process.env.YOSH_PORT = String(port);
  const origin = `http://127.0.0.1:${port}`;
  const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  const previous = globals.__yosh;
  const app = new AppRuntime(options.directory);
  globals.__yosh = { runtime: app };
  const descriptor = { version: 1, profile: 'pay-mcp-mainnet', origin, memberId: app.ledger.defaultCardMember().id };
  try {
    return await serveDevelopmentRuntime({ app, origin, port, descriptor, async cleanup() { globals.__yosh = previous; } });
  } catch (error) {
    await app.prepareQuit(); app.close(); globals.__yosh = previous; throw error;
  }
}
