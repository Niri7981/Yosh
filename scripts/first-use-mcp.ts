import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFirstUseStatementServer, readMemberStatement } from '../src/modules/mcp/first-use-statement';
import { parseHostRegistration } from '../src/modules/mcp/local-host-registration';
import { createLocalHostClient } from '../src/modules/mcp/local-host-client';
import { resolveInstalledHost } from '../src/modules/mcp/installed-host';

async function main() {
  parseHostRegistration(process.argv.slice(2)); // An imported entry may carry another host’s hints.
  const runtime = dirname(resolve(process.argv[1]));
  const host = resolveInstalledHost(runtime);
  const client = createLocalHostClient(runtime, host);
  const directory = join(userInfo().homedir, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5/Mainnet');
  const server = createFirstUseStatementServer(async (query, signal) => {
    const { memberId } = await client.statementMember(signal);
    return readMemberStatement(directory, memberId, query, signal);
  }, client.purchase, client.describeResource);
  // SDK stdio listens for data but doesn't close the server on EOF. Closing
  // explicitly also aborts each pending owner command when the host exits.
  const close = () => { void server.close(); };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await server.connect(new StdioServerTransport());
}
void main().catch(() => { process.stderr.write('LOCAL_HOST_REGISTRATION_INVALID\n'); process.exitCode = 1; });
