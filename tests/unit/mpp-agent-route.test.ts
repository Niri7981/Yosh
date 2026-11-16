import { buildSync } from 'esbuild';
import { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requireLocalRequest } from '../../src/modules/http/local-request';
import { MAX_RESOURCE_ENTRY_BYTES } from '../../src/modules/http/request-size-limits';

const state = vi.hoisted(() => ({ authenticate: vi.fn(), purchase: vi.fn() }));
vi.mock('@/modules/app/app-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/modules/app/app-runtime')>(),
  appRuntime: () => ({ authenticateAgent: state.authenticate, requestMppPurchase: state.purchase }),
}));
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { POST } from '../../src/app/api/agent/mpp/purchases/route';

const principal = { cardMemberId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222', connectionGeneration: 1 };
const input = { requestId: 'original_mpp_01', resourceId: 'registered-mpp', reason: 'Read the fixture response' };
const origin = 'http://127.0.0.1:13449';
const token = 'a'.repeat(43);
const directories: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  state.authenticate.mockImplementation((request: Request, capability: string) => {
    requireLocalRequest(request);
    if (capability !== 'request_purchase' || request.headers.get('authorization') !== `Bearer ${token}`) throw new Error('AGENT_UNAUTHORIZED');
    return principal;
  });
});
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/agent/mpp/purchases`,
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

const rejectedHeaders: Record<string, string>[] = [{ authorization: '' }, { authorization: 'Bearer wrong' },
  { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example:13449' }];
it.each(rejectedHeaders)(
  'rejects unauthenticated/nonlocal MPP HTTP before the purchase service: %s', async headers => {
    const response = await POST(request(input, headers));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ code: 'AGENT_UNAUTHORIZED' });
    expect(state.purchase).not.toHaveBeenCalled();
  });
it('passes only resource/request identity and authenticated principal to the shared service', async () => {
  const result = { purchaseId: input.requestId, status: 'PAYMENT_UNKNOWN', paymentStatus: 'UNKNOWN', amount: '10000' };
  state.purchase.mockResolvedValue(result);
  const response = await POST(request(input));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(result);
  expect(state.purchase).toHaveBeenCalledExactlyOnceWith(input, origin, principal);
});
it.each([{ amount: '1' }, { network: 'solana:other' }, { credential: 'Payment untrusted' }, { executor: 'other' },
  { approved: true }, { recipient: 'attacker' }, { maximumNetworkFeeLamports: '999999999' }])(
  'rejects Agent-supplied payment authority/economics before action: %s', async extra => {
    const response = await POST(request({ ...input, ...extra }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'MPP_PURCHASE_REQUEST_FAILED' });
    expect(state.purchase).not.toHaveBeenCalled();
  });
it('rejects oversized input before the purchase service and sanitizes interrupted service failures', async () => {
  expect((await POST(request({ ...input, reason: 'x'.repeat(MAX_RESOURCE_ENTRY_BYTES + 1) }))).status).toBe(400);
  expect(state.purchase).not.toHaveBeenCalled();
  state.purchase.mockRejectedValue(new Error('internal secret signed transaction bytes'));
  const response = await POST(request(input));
  const body: unknown = await response.json();
  expect(response.status).toBe(400); expect(body).toMatchObject({ code: 'MPP_PURCHASE_REQUEST_FAILED',
    error: expect.stringContaining('original purchase ID') });
  expect(JSON.stringify(body)).not.toContain('secret');
  expect(JSON.stringify(body)).not.toContain('paymentSent');
  expect(JSON.stringify(body)).not.toContain('No payment');
});
it('exercises the real runtime Mainnet and isolation gates without constructing a runtime or opening its database', () => {
  const start = vi.fn(), paymentConfiguration = vi.fn(), runExternalPaymentOperation = vi.fn();
  const runtime = { environment: { isProduction: true }, directory: '/not-a-runtime', dependencies: {},
    start, paymentConfiguration, runExternalPaymentOperation };
  Object.setPrototypeOf(runtime, AppRuntime.prototype);
  expect(() => Reflect.apply(AppRuntime.prototype.requestMppPurchase, runtime, [input, origin, principal]))
    .toThrow('MPP_MAINNET_ACCEPTANCE_REQUIRED');
  runtime.environment.isProduction = false;
  vi.stubEnv('YOSH_PAY_DEV', '0');
  expect(() => Reflect.apply(AppRuntime.prototype.requestMppPurchase, runtime, [input, origin, principal]))
    .toThrow('MPP_ISOLATED_RUNTIME_REQUIRED');
  expect(start).not.toHaveBeenCalled(); expect(paymentConfiguration).not.toHaveBeenCalled();
  expect(runExternalPaymentOperation).not.toHaveBeenCalled();
});

const requireDependency = createRequire(import.meta.url);
const wrapperCode = buildSync({ entryPoints: [resolve('scripts/pay-dev-mcp.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_RC5__: 'true' }, minifySyntax: true }).outputFiles[0].text;
const RpcResult = z.object({ id: z.number(), result: z.object({ isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }) });
function wrapperFixture(mode: 'success' | 'timeout' | 'mainnet-blocked' = 'success') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mpp-mcp-'))); directories.push(parent);
  const root = join(parent, 'Yosh Pay Dev v0.1.1-rc.5'); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, 'Devnet'); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet',
    mainnetRiskAccepted: false, rpcUrl: 'https://solana-rpc.publicnode.com' }), { mode: 0o600 });
  writeFileSync(join(directory, 'pay-devnet-runtime.json'), JSON.stringify({ version: 1, profile: 'pay-mcp-devnet',
    origin, memberId: principal.cardMemberId }), { mode: 0o600 });
  writeFileSync(join(directory, 'mcp-connection.json'), JSON.stringify({ origin, token, cardMemberId: principal.cardMemberId,
    connectionId: principal.connectionId, generation: 1, capabilities: ['read', 'request_purchase'] }), { mode: 0o600 });
  const wrapper = join(parent, 'mcp.cjs'); writeFileSync(wrapper, 'offline fixture'); writeFileSync(join(parent, 'pay-mcp'), 'offline worker');
  const host = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const responses: unknown[] = [], forwarded: string[] = [], timeouts: number[] = [];
  output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) responses.push(JSON.parse(line)); });
  child.stdin.on('data', chunk => forwarded.push(String(chunk)));
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe(`${origin}/api/agent/mpp/purchases`);
    expect(options.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(options.redirect).toBe('error'); expect(JSON.parse(String(options.body))).toEqual(input);
    if (mode === 'timeout') throw new Error('private signed credential network timeout');
    if (mode === 'mainnet-blocked') return Response.json({ code: 'MPP_MAINNET_ACCEPTANCE_REQUIRED' }, { status: 400 });
    return Response.json({ purchaseId: input.requestId, status: 'PAYMENT_UNKNOWN', paymentStatus: 'UNKNOWN' });
  });
  runInNewContext(wrapperCode, { module: { exports: {} }, require: (name: string): unknown =>
    name === 'node:child_process' ? { spawn: () => child } : requireDependency(name),
    process: { argv: [process.execPath, wrapper, '--data-dir', root], env: {}, getuid: process.getuid,
      stdin: host, stdout: output, stderr: errors, once: vi.fn(), exitCode: 0 },
    Buffer, URL, URLSearchParams, Request, Response, AbortSignal: { timeout: (milliseconds: number) => {
      timeouts.push(milliseconds); return AbortSignal.timeout(milliseconds);
    } }, TextEncoder, TextDecoder, Error, setTimeout, clearTimeout, fetch: fetcher });
  const send = (id: number, args: unknown) => host.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'request_mpp_purchase', arguments: args } })}\n`);
  const result = (id: number) => RpcResult.parse(responses.find(item => z.object({ id: z.literal(id) }).safeParse(item).success)).result;
  return { child, host, responses, forwarded, fetcher, timeouts, send, result, close() { host.end(); child.emit('close', 0); } };
}
it('runs the actual wrapper source through framed MCP input, authenticating one bounded MPP request without forwarding it to Pay', async () => {
  const f = wrapperFixture();
  try {
    f.send(1, input); await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.timeouts).toEqual([120_000]); expect(f.forwarded).toHaveLength(0);
    expect(JSON.parse(f.result(1).content[0].text)).toMatchObject({ purchaseId: input.requestId, status: 'PAYMENT_UNKNOWN' });
  } finally { f.close(); }
});
it('advertises MPP as a spending action rather than a read-only resource operation', () => {
  const f = wrapperFixture();
  try {
    f.host.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })}\n`);
    f.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, result: { tools: [{ name: 'curl', inputSchema: { type: 'object' } }] } })}\n`);
    const listed = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string(),
      annotations: z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean(), openWorldHint: z.boolean() }).optional() }).passthrough()) }) })
      .parse(f.responses.find(item => z.object({ id: z.literal(99) }).safeParse(item).success));
    expect(listed.result.tools.find(tool => tool.name === 'request_mpp_purchase')?.annotations)
      .toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it('rejects MCP-injected amount/network/credential/executor locally without HTTP or child payment calls', async () => {
  const f = wrapperFixture();
  try {
    const injected = [{ amount: '1' }, { network: 'mainnet' }, { credential: 'Payment injected' }, { executor: 'x402' }];
    for (const [index, extra] of injected.entries()) f.send(index + 1, { ...input, ...extra });
    await vi.waitFor(() => expect(f.responses).toHaveLength(injected.length));
    for (const index of injected.keys()) expect(f.result(index + 1)).toMatchObject({ isError: true,
      content: [{ text: expect.stringContaining('RESOURCE_TOOL_INPUT_INVALID') }] });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});
it.each(['timeout', 'mainnet-blocked'] as const)('keeps the original ID recovery instruction after %s without claiming no payment', async mode => {
  const f = wrapperFixture(mode);
  try {
    f.send(1, input); await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    const result = f.result(1); expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('original purchase ID');
    expect(result.content[0].text).toContain('do not create a replacement');
    expect(result.content[0].text).not.toContain('No spending permission or payment was created');
    expect(result.content[0].text).not.toContain('private signed');
    if (mode === 'mainnet-blocked') expect(result.content[0].text).toContain('MPP_MAINNET_ACCEPTANCE_REQUIRED');
    expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});
