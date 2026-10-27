import { PAY_DEVELOPMENT_PROFILE } from '../src/modules/pay-dev/profile';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ConnectionSchema, connectionFile } from '../src/modules/mcp/connection';
import { ControllerDiagnostic, recordControllerDiagnostic } from '../src/modules/payment/pay-controller-diagnostics';
import { recordPayTrace } from '../src/modules/payment/pay-execution-trace';
import { assertDevelopmentOrigin, readDevelopmentEnvironment } from '../src/modules/pay-dev/environment';
import { DiscoveryInput } from '../src/modules/resources/mainnet-resource-discovery';
import { AgentResourceRegistrationInput } from '../src/modules/resources/agent-resource-registration';
import { ResourceRequestInputSchema } from '../src/modules/resources/http-resource';
import { AgentRegistrationErrorCodes } from '../src/modules/mcp/server';

const ManifestSchema = z.object({
  version: z.literal(1), profile: z.enum(['isolated-pay-dev','pay-mcp-simulated','pay-mcp-devnet','pay-mcp-mainnet']),
  origin: ConnectionSchema.shape.origin, memberId: z.string().uuid(),
  merchantUrl: z.url().optional(),
}).strict();

function privateJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384)
    throw new Error('PAY_DEV_PRIVATE_CONFIG_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--data-dir')) throw new Error('PAY_DEV_ARGUMENTS_INVALID');
  let directory = args[1] ?? process.env.YOSH_DATA_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('PAY_DEV_DIRECTORY_REQUIRED');
  const candidate = PAY_DEVELOPMENT_PROFILE.bundleIdentifier === 'com.yosh.pay-development.v011rc5';
  if (candidate && basename(directory) !== PAY_DEVELOPMENT_PROFILE.directoryName)
    throw new Error('PAY_DEV_DIRECTORY_REQUIRED');
  const development = basename(directory) === PAY_DEVELOPMENT_PROFILE.directoryName ? readDevelopmentEnvironment(directory) : undefined;
  const mainnet = development ? development.environment === 'mainnet' : process.env.YOSH_PAY_MCP_MAINNET === '1';
  const devnet = development?.environment === 'devnet';
  const simulated = development?.environment === 'simulated';
  const live = mainnet || devnet;
  if (development?.environment === 'mainnet') directory = join(directory, 'Mainnet');
  else if (devnet) directory = join(directory, 'Devnet');
  else if (simulated) directory = join(directory, 'Simulated');
  const manifest = ManifestSchema.parse(privateJson(join(directory, mainnet ? 'pay-mainnet-runtime.json'
    : devnet ? 'pay-devnet-runtime.json' : simulated ? 'pay-simulated-runtime.json' : 'pay-dev-runtime.json')));
  assertDevelopmentOrigin(manifest.origin);
  if (manifest.profile !== (mainnet ? 'pay-mcp-mainnet' : devnet ? 'pay-mcp-devnet' : simulated ? 'pay-mcp-simulated' : 'isolated-pay-dev'))
    throw new Error('PAY_PROFILE_MISMATCH');
  if (live && process.env.YOSH_CARD_MEMBER_ID && process.env.APP2049_CARD_MEMBER_ID
    && process.env.YOSH_CARD_MEMBER_ID !== process.env.APP2049_CARD_MEMBER_ID) throw new Error('PAY_CALLER_CONFIGURATION_CONFLICT');
  const callerId = live ? z.string().uuid().parse(process.env.YOSH_CARD_MEMBER_ID ?? process.env.APP2049_CARD_MEMBER_ID ?? manifest.memberId) : manifest.memberId;
  let descriptor: unknown;
  try { descriptor = privateJson(connectionFile(directory, callerId)); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    descriptor = privateJson(connectionFile(directory));
  }
  const connection = ConnectionSchema.parse(descriptor);
  assertDevelopmentOrigin(connection.origin);
  if (connection.cardMemberId !== callerId || connection.origin !== manifest.origin
    || !connection.capabilities.includes('request_purchase')) throw new Error('PAY_DEV_CONNECTION_MISMATCH');
  const binary = join(dirname(resolve(process.argv[1])), 'pay-mcp');
  const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const hostFile = join(directory, `.pay-host-${randomUUID()}.json`);
  writeFileSync(hostFile, JSON.stringify({ origin: connection.origin, token: connection.token,
    caller: connection.cardMemberId, timeout_ms: 5_000 }), { mode: 0o600, flag: 'wx' });
  const child = spawn(binary, [hostFile], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'production', ...(mainnet ? { YOSH_PAY_MCP_MAINNET: '1' }
      : devnet ? { YOSH_PAY_MCP_DEVNET: '1' } : { YOSH_PAY_DEV: '1' }) },
  });
  let sessionId = randomUUID();
  let sequence = 0;
  let initialized = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let pingDeadline: ReturnType<typeof setTimeout> | undefined;
  let pendingPing: string | undefined;
  const hostLines = createInterface({ input: process.stdin });
  const payLines = createInterface({ input: child.stdout });
  const traceLines = createInterface({ input: child.stderr });
  let traceWarning = false;
  traceLines.on('line', (line: string) => {
    try {
      const diagnostic = ControllerDiagnostic.safeParse(JSON.parse(line));
      if (diagnostic.success) recordControllerDiagnostic(directory, diagnostic.data, connection.cardMemberId);
      else recordPayTrace(directory, connection.cardMemberId, binarySha256, line);
    }
    catch {
      if (!traceWarning) process.stderr.write('Pay execution trace unavailable; payment state remains in Yosh.\n');
      traceWarning = true;
    }
  });
  const listRequests = new Set<string | number>();
  const statusTool = {
    name: 'get_spending_status',
    description: mainnet ? 'Read Yosh Mainnet wallet, budget, Grant, Pause and original purchase state. Read only; no payment permission.'
      : devnet ? 'Read Yosh Solana Devnet test wallet, budget, Grant, Pause and original purchase state. Read only; no payment permission.'
        : simulated ? 'Read Yosh Simulation state. Simulation cannot sign or submit payments.'
          : 'Read the active Yosh Pay Dev Offline wallet balance, shared daily budget, reserved/paid amounts, Agent Spend Grant and Pause readiness. No payment or management action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
  // Yosh-only resource lifecycle. Payment calls continue byte-for-byte to Pay;
  // these tools hold only the captured Agent capability, never management access.
  const resourceTools = live ? [
    { name: 'discover_x402_resource', path: '/api/agent/discovery', schema: DiscoveryInput,
      description: 'Inspect a candidate public HTTPS x402 API without payment using Yosh discovery. Returns an Agent-bound discoveryId and immutable registration proposal. Unknown POST requires separate approval in Yosh. Does not register, authorize spending or pay.' },
    { name: 'register_x402_resource', path: '/api/agent/resources', schema: AgentResourceRegistrationInput,
      description: 'Register the discoveryId returned by discover_x402_resource in the shared Yosh API list. Only identity labels are accepted; request and economic facts come from the backend-held discovery. Registration creates no Spend Grant. The user must review it in Yosh and explicitly create a Grant before any Pay curl purchase.' },
    { name: 'quote_x402_resource', path: '/api/agent/quote',
      schema: z.object({ resourceId: z.string().min(1).max(200), sample: ResourceRequestInputSchema.optional() }).strict(),
      description: 'Read a fresh unpaid quote for a registered Yosh API and validated sample. Does not reserve budget, sign or pay. Purchases use the Pay curl tool and require a user-created Yosh Spend Grant.' },
  ] : [];
  const recoveryTool = { name: 'recover_payment',
    description: 'Resume an existing Yosh operation after a lost controller plan, only if durable evidence proves payment never started. Reuses its original Purchase and reservation. Never creates a new purchase or replaces an unknown payment. Can execute the original payment; use only with user authorization.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } };
  const recoverPayment = async (id: string | number, params: unknown) => {
    let result;
    try {
      const input = z.object({ name: z.literal('recover_payment'), arguments: z.object({ operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/) }).strict(), _meta: z.unknown().optional() }).strict().parse(params);
      const response = await fetch(`${connection.origin}/pay/recover`, { method: 'POST',
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input.arguments), redirect: 'error', signal: AbortSignal.timeout(60_000) });
      const reader = response.body?.getReader(); if (!reader) throw new Error('PAY_RECOVERY_REQUIRED');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 4 * 64 * 1024 * 1024 + 1024 * 1024) throw new Error('PAY_RECOVERY_REQUIRED'); chunks.push(value);
      } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const error = z.object({ error: z.enum(['PAY_ORIGINAL_PAYMENT_RECOVERY_REQUIRED', 'PAY_PREPAYMENT_RECOVERY_UNAVAILABLE',
          'PAY_RECOVERY_IN_PROGRESS', 'PAY_RECOVERY_FACTS_MISMATCH', 'PAY_DURABLE_RECOVERY_REQUIRED']) }).safeParse(value);
        throw new Error(error.success ? error.data.error : 'PAY_RECOVERY_REQUIRED');
      }
      const valueResponse = z.object({ status: z.number().int(), headers: z.array(z.tuple([z.string(), z.string()])),
        body: z.array(z.number().int().min(0).max(255)).max(64 * 1024 * 1024) }).strict().parse(value);
      result = { content: [{ type: 'text', text: Buffer.from(valueResponse.body).toString('utf8') }] };
    } catch (error) {
      const allowed = ['PAY_ORIGINAL_PAYMENT_RECOVERY_REQUIRED', 'PAY_PREPAYMENT_RECOVERY_UNAVAILABLE', 'PAY_RECOVERY_IN_PROGRESS',
        'PAY_RECOVERY_FACTS_MISMATCH', 'PAY_DURABLE_RECOVERY_REQUIRED'];
      result = { isError: true, content: [{ type: 'text', text: error instanceof Error && allowed.includes(error.message)
        ? error.message : 'PAY_RECOVERY_REQUIRED: outcome unresolved; do not create a replacement payment.' }] };
    }
    if (!closed) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const callResource = async (id: string | number, params: unknown) => {
    let result;
    try {
      const input = z.object({ name: z.string(), arguments: z.unknown().optional(), _meta: z.unknown().optional() }).strict().parse(params);
      const tool = resourceTools.find(tool => tool.name === input.name);
      if (!tool) throw new Error('RESOURCE_REGISTRATION_UNAVAILABLE');
      const args = tool.schema.parse(input.arguments ?? {});
      const response = await fetch(`${connection.origin}${tool.path}`, { method: 'POST',
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args), redirect: 'error', signal: AbortSignal.timeout(20_000) });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('RESOURCE_REGISTRATION_UNAVAILABLE');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 65_536) throw new Error('RESOURCE_REGISTRATION_UNAVAILABLE'); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const code = z.object({ code: z.string() }).safeParse(value);
        const allowed = [...AgentRegistrationErrorCodes, 'RESOURCE_DISCOVERY_UNAVAILABLE', 'RESOURCE_QUOTE_UNAVAILABLE', 'RESOURCE_POST_APPROVAL_REQUIRED'];
        throw new Error(response.status === 401 ? 'AGENT_UNAUTHORIZED'
          : code.success && allowed.includes(code.data.code) ? code.data.code : 'RESOURCE_REGISTRATION_UNAVAILABLE');
      }
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      const allowed = [...AgentRegistrationErrorCodes, 'RESOURCE_DISCOVERY_UNAVAILABLE', 'RESOURCE_QUOTE_UNAVAILABLE', 'RESOURCE_POST_APPROVAL_REQUIRED'];
      const code = error instanceof z.ZodError ? 'RESOURCE_TOOL_INPUT_INVALID'
        : error instanceof Error && allowed.includes(error.message) ? error.message : 'RESOURCE_REGISTRATION_UNAVAILABLE';
      result = { isError: true, content: [{ type: 'text', text: `${code}: No spending permission or payment was created. Review POST requests in Yosh before discovery.` }] };
    }
    if (!closed) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const readStatus = async (id: string | number, params: unknown) => {
    let result;
    try {
      z.object({ name: z.literal('get_spending_status'), arguments: z.object({}).strict().optional(), _meta: z.unknown().optional() }).strict().parse(params);
      const response = await fetch(`${connection.origin}/api/agent?operation=status`, {
        headers: { authorization: `Bearer ${connection.token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? 'PAY_DEV_REVOKED' : 'PAY_DEV_STATUS_UNAVAILABLE'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('PAY_DEV_STATUS_UNAVAILABLE');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 65_536) throw new Error('PAY_DEV_STATUS_UNAVAILABLE'); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const status: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      result = { content: [{ type: 'text', text: JSON.stringify({ profile: manifest.profile, realFunds: mainnet, status }) }] };
    } catch (error) {
      const code = error instanceof z.ZodError ? 'PAY_DEV_STATUS_INPUT_INVALID'
        : error instanceof Error && error.message === 'PAY_DEV_REVOKED' ? 'PAY_DEV_REVOKED' : 'PAY_DEV_STATUS_UNAVAILABLE';
      result = { isError: true, content: [{ type: 'text', text: mainnet
        ? 'PAY_MAINNET_STATUS_UNAVAILABLE: Open the approved Yosh Mainnet version and enable this Agent connection. No payment requested.'
        : `${code}: Only Yosh Pay Dev is queried. Open Yosh Pay Dev and enable its connection; no payment requested.` }] };
    }
    if (!closed) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const report = async (phase: 'initialized' | 'heartbeat' | 'closed') => {
    const response = await fetch(`${connection.origin}/api/agent/session`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000),
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', sessionId, phase, sequence: sequence++ }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(response.status === 401 ? 'PAY_DEV_REVOKED' : 'PAY_DEV_SESSION_UNAVAILABLE');
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(heartbeat); clearTimeout(pingDeadline);
    if (initialized) void report('closed').catch(() => {});
    hostLines.close();
    // Ending stdio leaves original-payment completion/recovery with AppRuntime.
    // Do not kill the backend or submit a replacement when a host disappears.
    child.stdin.end();
  };
  const ping = () => {
    if (closed || pendingPing) return;
    pendingPing = `yosh-pay-host-${sessionId}-${sequence}`;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: pendingPing, method: 'ping' })}\n`);
    pingDeadline = setTimeout(close, 5_000);
  };
  hostLines.on('line', (line: string) => {
    let message: unknown;
    try { message = JSON.parse(line) as unknown; } catch { close(); return; }
    if (typeof message !== 'object' || message === null) { close(); return; }
    if (pendingPing && 'id' in message && message.id === pendingPing) {
      pendingPing = undefined; clearTimeout(pingDeadline);
      if (!('result' in message) || 'error' in message) { close(); return; }
      void report(initialized ? 'heartbeat' : 'initialized').then(() => {
        initialized = true;
        if (closed) void report('closed').catch(() => {});
        else heartbeat = setTimeout(ping, 10_000);
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'PAY_DEV_REVOKED') { close(); return; }
        // Runtime restart loses only the volatile lease. Keep the captured
        // member capability and prove the real host again; never reload a token.
        initialized = false; sessionId = randomUUID(); sequence = 0;
        if (!closed) heartbeat = setTimeout(ping, 2_000);
      });
      return;
    }
    const request = z.object({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() }).passthrough().safeParse(message);
    if (request.success && !closed) {
      if (request.data.method === 'tools/list') listRequests.add(request.data.id);
      if (request.data.method === 'tools/call'
        && z.object({ name: z.literal('get_spending_status') }).passthrough().safeParse(request.data.params).success) {
        void readStatus(request.data.id, request.data.params); return;
      }
      if (request.data.method === 'tools/call') {
        const call = z.object({ name: z.string() }).passthrough().safeParse(request.data.params);
        if (simulated) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.data.id, result: { isError: true,
            content: [{ type: 'text', text: 'SIMULATED_EXECUTION_DISABLED: Simulation cannot sign, submit or recover payments.' }] } })}\n`);
          return;
        }
        if (live && call.success && call.data.name === 'recover_payment') { void recoverPayment(request.data.id, request.data.params); return; }
        if (call.success && resourceTools.some(tool => tool.name === call.data.name)) {
          void callResource(request.data.id, request.data.params); return;
        }
      }
    }
    if (!closed) child.stdin.write(`${line}\n`);
    if ('method' in message && message.method === 'notifications/initialized') ping();
  });
  payLines.on('line', (line: string) => {
    if (closed) return;
    const response = z.object({ id: z.union([z.string(), z.number()]), result: z.object({ tools: z.array(z.unknown()) }).passthrough() }).passthrough().safeParse(JSON.parse(line));
    if (response.success && listRequests.delete(response.data.id)) {
      if (simulated) response.data.result.tools = [];
      response.data.result.tools.push(statusTool);
      if (live) response.data.result.tools.push(recoveryTool);
      for (const tool of resourceTools) response.data.result.tools.push({ name: tool.name, description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema), annotations: { readOnlyHint: tool.name === 'quote_x402_resource',
          destructiveHint: tool.name === 'discover_x402_resource', openWorldHint: tool.name !== 'register_x402_resource' } });
      process.stdout.write(`${JSON.stringify(response.data)}\n`);
    } else {
      const rejection = z.object({ result: z.object({ isError: z.literal(true), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).passthrough() }).passthrough().safeParse(JSON.parse(line));
      if (rejection.success && rejection.data.result.content.some(item => item.text.includes('External spending authority: REJECTED_BEFORE_EXECUTION'))) {
        rejection.data.result.content = [{ type: 'text', text: 'REJECTED_BEFORE_EXECUTION: Yosh 当前缺少完成该付款所需的确认/授权' }];
        process.stdout.write(`${JSON.stringify(rejection.data)}\n`);
      } else process.stdout.write(`${line}\n`);
    }
  });
  child.stdin.on('error', close);
  process.stdout.on('error', close);
  child.on('error', () => { process.stderr.write(mainnet ? 'Pay Mainnet MCP could not start.\n' : 'Pay development MCP could not start.\n'); close(); process.exitCode = 1; });
  child.on('close', (code) => {
    close(); payLines.close(); traceLines.close();
    try { unlinkSync(hostFile); } catch { /* Private capability file may already be removed. */ }
    process.exitCode = code ?? 1;
  });
  hostLines.on('close', close);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, close);
}

void main().catch(() => { process.stderr.write(process.env.YOSH_PAY_MCP_MAINNET === '1'
  ? 'Pay Mainnet connection is unavailable; open the approved Yosh version and enable its Codex connection. No payment requested.\n'
  : 'Pay development connection is unavailable; open Yosh Pay Dev and enable its Codex connection.\n'); process.exitCode = 1; });
