import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { AgentRegistrationError, AgentRegistrationErrorCodes, AgentPostApprovalError, AgentPurchaseInputError, AgentReadError, createAgentServer } from '../src/modules/mcp/server';
import { readConnection } from '../src/modules/mcp/connection';
import { appRequestTimeout } from '../src/modules/mcp/request-timeout';
import { resolveYoshConfiguration } from '../src/modules/app/yosh-configuration';

const configuration = resolveYoshConfiguration();
// Legacy hosts and Yosh share the original member ledger until an explicit data migration.
const directory = configuration.dataDirectory || join(homedir(), 'Library', 'Application Support', '2049');
const memberId = configuration.cardMemberId;
// Capture one connection capability. Revocation/re-enable requires a new MCP session.
let connection: ReturnType<typeof readConnection> | undefined;
async function callApp(path: string, init?: RequestInit) {
  connection ??= readConnection(directory, memberId);
  const response = await fetch(`${connection.origin}${path}`, {
    headers: { authorization: `Bearer ${connection.token}` },
    redirect: 'error', signal: AbortSignal.timeout(appRequestTimeout(path)), ...init,
    ...(init?.body ? { headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' } } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) throw new AgentReadError('AGENT_UNAUTHORIZED');
    if (path.startsWith('/api/agent/account/')) throw new Error(response.status === 404 ? 'ACCOUNT_RESULT_NOT_AVAILABLE' : response.status === 400 ? 'ACCOUNT_READ_INPUT_INVALID' : 'ACCOUNT_READ_UNAVAILABLE');
    if (path.startsWith('/api/agent?')) throw new AgentReadError('AGENT_READ_FAILED');
    if (['/api/agent/discovery', '/api/agent/quote'].includes(path) && response.status === 409) throw new AgentPostApprovalError();
    if (path === '/api/agent/resources') {
      const result: unknown = await response.json().catch(() => null);
      const code = typeof result === 'object' && result !== null && 'code' in result ? result.code : undefined;
      throw new AgentRegistrationError(AgentRegistrationErrorCodes.find(value => value === code) ?? 'RESOURCE_REGISTRATION_UNAVAILABLE');
    }
    if (path === '/api/agent/purchases' && response.status === 400) {
      const body = await response.json().catch(() => null) as { code?: unknown } | null;
      if (body?.code === 'RESOURCE_REQUEST_INPUT_REQUIRED' || body?.code === 'RESOURCE_REQUEST_INPUT_UNSUPPORTED' || body?.code === 'RESOURCE_REQUEST_INPUT_INVALID' || body?.code === 'RESOURCE_POST_APPROVAL_REQUIRED') {
        throw new AgentPurchaseInputError(body.code);
      }
    }
    throw new Error('APP_UNAVAILABLE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('APP_UNAVAILABLE');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 65_536) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const server = createAgentServer(
  operation => callApp(`/api/agent?operation=${operation}`),
  input => callApp('/api/agent/purchases', { method: 'POST', body: JSON.stringify(input) }),
  input => callApp('/api/agent/discovery', { method: 'POST', body: JSON.stringify(input) }),
  (purchaseId, offset) => callApp(`/api/agent/purchases/${encodeURIComponent(purchaseId)}/delivery?offset=${offset}`),
  (resourceId, sample) => callApp('/api/agent/quote', { method: 'POST', body: JSON.stringify({ resourceId, sample }) }),
  input => callApp('/api/agent/resources', { method: 'POST', body: JSON.stringify(input) }),
  path => callApp(path),
);
if (configuration.mcpProvider === 'codex') {
  let sessionId = randomUUID();
  let sequence = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const report = (phase: 'initialized' | 'heartbeat' | 'closed') => callApp('/api/agent/session', {
    method: 'POST', body: JSON.stringify({ provider: 'codex', sessionId, phase, sequence: sequence++ }),
  });
  const stop = () => { closed = true; clearTimeout(timer); };
  const pulse = async (initial = false) => {
    try {
      // A running bridge alone is not host liveness: require a fresh MCP host response.
      await server.server.request({ method: 'ping' }, EmptyResultSchema, { timeout: 5_000 });
    } catch {
      stop();
      await server.close().catch(() => {});
      return;
    }
    if (closed) return;
    try {
      await report(initial ? 'initialized' : 'heartbeat');
      failures = 0;
      if (!closed) timer = setTimeout(() => { void pulse(); }, 10_000);
    } catch (error) {
      if (error instanceof AgentReadError && error.code === 'AGENT_UNAUTHORIZED') {
        stop();
        await server.close().catch(() => {});
        return;
      }
      // Backend loss or a lost volatile lease is retryable. Re-prove host liveness
      // and create a fresh session, retaining only the originally captured capability.
      // Never reload a rotated/revoked token or retry a purchase here.
      sessionId = randomUUID();
      sequence = 0;
      failures++;
      if (!closed) timer = setTimeout(() => { void pulse(true); }, Math.min(10_000, 1000 * 2 ** Math.min(failures, 4)));
    }
  };
  server.server.oninitialized = () => { void pulse(true); };
  server.server.onclose = () => { stop(); void report('closed').catch(() => {}); };
  process.stdin.on('end', () => { stop(); void server.close(); });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stop(); void server.close(); });
}
server.connect(new StdioServerTransport()).catch(() => { console.error('Yosh MCP could not start'); process.exitCode = 1; });
