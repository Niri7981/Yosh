import { buildSync } from 'esbuild';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const requireDependency = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const code = buildSync({ entryPoints: [resolve('scripts/pay-dev-mcp.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_PLUGIN_DEV__: 'true' }, minifySyntax: true }).outputFiles[0].text;

function fixture(policyCode: string, missing = false, mppError?: string, capabilities = ['read', 'request_purchase'], internalPurchase = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-purchase-read-'))); directories.push(parent);
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const memberId = randomUUID(); const token = 'a'.repeat(43); const origin = 'http://127.0.0.1:14449';
  writeFileSync(join(directory, 'pay-dev-runtime.json'), JSON.stringify({ version: 1, profile: 'isolated-pay-dev', origin, memberId }), { mode: 0o600 });
  writeFileSync(join(directory, 'mcp-connection.json'), JSON.stringify({ origin, token, cardMemberId: memberId,
    connectionId: randomUUID(), generation: 1, capabilities }), { mode: 0o600 });
  const wrapper = join(parent, 'mcp.cjs'); writeFileSync(wrapper, 'fixture-wrapper'); writeFileSync(join(parent, 'pay-mcp'), 'fixture-controlled-worker');
  const host = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const responses: unknown[] = [], forwarded: string[] = [];
  output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) responses.push(JSON.parse(line)); });
  child.stdin.on('data', chunk => forwarded.push(String(chunk)));
  const summary = { purchaseId: 'pay_original', operationId: 'original-op', status: 'DENIED', paymentStatus: 'NOT_STARTED',
    deliveryStatus: 'NOT_PAID', policyCode, resourceId: 'market-snapshot', amount: '200000', network: 'fixture-network',
    assetId: 'fixture-asset', assetDecimals: 6, transaction: null };
  const fetcher = vi.fn(async (input: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ authorization: `Bearer ${token}` });
    if (input.endsWith('/api/agent/session')) return capabilities.includes('read') ? Response.json({ ok: true }) : new Response(null, { status: 401 });
    if (input.endsWith('/api/agent/purchase?operationId=original-op'))
      return missing ? Response.json({ code: 'PURCHASE_NOT_FOUND' }, { status: 404 }) : Response.json(summary);
    if (input.includes('/api/agent/purchases/pay_original/delivery?offset=0'))
      return Response.json({ purchaseId: 'pay_original', offset: 0, nextOffset: null, chunk: 'e30=', totalBytes: 2 });
    if (input.endsWith('/api/agent/mpp/purchases')) return mppError
      ? Response.json({ code: mppError }, { status: 409 }) : Response.json(summary);
    if (input.endsWith('/api/agent/mpp/recover-delivery'))
      return Response.json({ code: 'MPP_PAID_DELIVERY_REQUIRED' }, { status: 409 });
    if (input.endsWith('/api/agent/discovery')) return Response.json({ code: 'OFFLINE_RESOURCE_LIFECYCLE_UNAVAILABLE' }, { status: 409 });
    throw new Error('UNEXPECTED_AGENT_READ');
  });
  runInNewContext(code, { module: { exports: {} }, require: (name: string): unknown =>
    name === 'node:child_process' ? { spawn: () => child } : requireDependency(name),
    process: { argv: [process.execPath, wrapper, '--data-dir', directory], env: internalPurchase ? { YOSH_INTERNAL_PURCHASE: '1' } : {}, getuid: process.getuid,
      stdin: host, stdout: output, stderr: errors, once: vi.fn(), exitCode: 0 },
    Buffer, URL, URLSearchParams, Request, Response, AbortSignal, TextEncoder, TextDecoder, Error, setTimeout, clearTimeout, fetch: fetcher });
  const send = (id: number, name: string, args: unknown) => host.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const listTools = () => {
    host.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })}\n`);
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, result: { tools: ['create_skill', 'curl', 'get_balance',
      'get_catalog_entry', 'list_catalog', 'search_catalog', 'sell_inference', 'topup'].map(name => ({ name, inputSchema: { type: 'object' } })) } })}\n`);
    const value = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }) })
      .parse(responses.find(response => z.object({ id: z.literal(99) }).safeParse(response).success));
    return value.result.tools.map(tool => tool.name);
  };
  const result = (id: number) => z.object({ result: z.object({ isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }) }).parse(responses.find(response => z.object({ id: z.literal(id) }).safeParse(response).success)).result;
  return { host, child, responses, forwarded, fetcher, send, result, listTools, summary, close() { host.end(); child.emit('close', 0); } };
}

it.each([
  { capabilities: ['request_purchase'], internal: false, tracksCodex: false },
  { capabilities: ['read_statement', 'request_purchase'], internal: false, tracksCodex: false },
  { capabilities: ['read', 'request_purchase'], internal: true, tracksCodex: false },
  { capabilities: ['read', 'request_purchase'], internal: false, tracksCodex: true },
])('uses host liveness only for the existing host session ($capabilities, internal=$internal)', async ({ capabilities, internal, tracksCodex }) => {
  const f = fixture('APPROVED', false, undefined, capabilities, internal);
  try {
    f.host.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const ping = f.responses.map(value => z.object({ id: z.string(), method: z.literal('ping') }).safeParse(value)).find(result => result.success);
    if (ping?.success) f.host.write(JSON.stringify({ jsonrpc: '2.0', id: ping.data.id, result: {} }) + '\n');
    expect(Boolean(ping?.success)).toBe(tracksCodex);
    f.send(53, 'get_purchase', { operationId: 'original-op' });
    await vi.waitFor(() => expect(f.result(53).isError).not.toBe(true));
    expect(f.fetcher.mock.calls.some(([path]) => path.endsWith('/api/agent/session'))).toBe(tracksCodex);
    expect(f.result(53).content[0].text).toContain('original-op');
    expect(f.child.stdin.writableEnded).toBe(false);
  } finally { f.close(); }
});

it('the plugin lists only upstream curl and blocks guessed upstream tools before forwarding', () => {
  const f = fixture('PAYMENTS_PAUSED');
  try {
    expect(f.listTools()).toEqual(['curl', 'get_spending_status', 'get_purchase', 'get_purchase_delivery', 'list_account_purchases', 'read_account_result',
      'request_mpp_purchase', 'recover_purchase_delivery', 'quote_mpp_resource', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource']);
    const before = f.forwarded.length;
    const forbidden = ['create_skill', 'get_balance', 'get_catalog_entry', 'list_catalog', 'search_catalog',
      'sell_inference', 'topup', 'recover_payment', 'future_upstream_tool'];
    for (const [index, name] of forbidden.entries()) {
      f.send(index + 1, name, {});
      expect(f.result(index + 1)).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('YOSH_PLUGIN_TOOL_UNAVAILABLE') }] });
    }
    expect(f.forwarded).toHaveLength(before); expect(f.fetcher).not.toHaveBeenCalled();
    f.send(20, 'curl', { operation_id: 'original-op', url: 'http://127.0.0.1:14449/api/paid/fixture' });
    expect(f.forwarded).toHaveLength(before + 1);
  } finally { f.close(); }
});

it.each(['PAYMENTS_PAUSED', 'SPEND_GRANT_REQUIRED', 'DAILY_BUDGET_EXCEEDED'])('reports the original %s decision without guessing from current global readiness', async reason => {
  const f = fixture(reason);
  try {
    f.send(1, 'curl', { operation_id: 'original-op', url: 'http://127.0.0.1:14449/api/paid/fixture' });
    f.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true,
      content: [{ type: 'text', text: 'External spending authority: REJECTED_BEFORE_EXECUTION' }] } })}\n`);
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1).content[0].text).toContain(reason);
    expect(JSON.parse(f.result(1).content[1].text)).toEqual({ yoshPurchase: f.summary });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][0]).toContain('/api/agent/purchase?operationId=original-op');
  } finally { f.close(); }
});

it('points to the saved result when Pay still reports unresolved settlement', async () => {
  const f = fixture('SPEND_GRANT_ALLOWED');
  try {
    Object.assign(f.summary, { status: 'PAYMENT_UNKNOWN', paymentStatus: 'PAYMENT_UNKNOWN', deliveryStatus: 'COMPLETE' });
    f.send(1, 'curl', { operation_id: 'original-op', url: 'http://127.0.0.1:14449/api/paid/fixture' });
    f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true,
      content: [{ type: 'text', text: 'PAY_ORIGINAL_OUTCOME_UNRESOLVED' }] } }) + '\n');
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1).isError).toBe(true);
    expect(JSON.parse(f.result(1).content[1].text)).toEqual({
      yoshPurchase: f.summary, next: { tool: 'get_purchase_delivery', purchaseId: f.summary.purchaseId },
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
  } finally { f.close(); }
});

it('preserves an unclassified Pay refusal when no original purchase facts exist', async () => {
  const f = fixture('SPEND_GRANT_REQUIRED', true);
  try {
    f.send(1, 'curl', { operation_id: 'original-op', url: 'http://127.0.0.1:14449/api/paid/fixture' });
    const content = [{ type: 'text', text: 'External spending authority: REJECTED_BEFORE_EXECUTION' }];
    f.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content } })}\n`);
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1).content).toEqual(content);
    expect(JSON.stringify(f.responses)).not.toContain('SPEND_GRANT_REQUIRED');
  } finally { f.close(); }
});

it('handles bounded purchase/delivery reads locally and rejects injected endpoints or approval fields before I/O', async () => {
  const f = fixture('PAYMENTS_PAUSED');
  try {
    f.send(1, 'get_purchase', { operationId: 'original-op' });
    f.send(2, 'get_purchase_delivery', { purchaseId: 'pay_original', offset: 0 });
    await vi.waitFor(() => expect(f.responses).toHaveLength(2));
    expect(JSON.parse(f.result(1).content[0].text)).toEqual(f.summary);
    expect(JSON.parse(f.result(2).content[0].text)).toMatchObject({ chunk: 'e30=', nextOffset: null });
    for (const [id, name, args] of [[3, 'get_purchase', { operationId: 'original-op', approved: true }],
      [4, 'get_purchase_delivery', { purchaseId: '../secret', offset: 0 }],
      [5, 'get_purchase', { purchaseId: 'pay_original', operationId: 'original-op' }]] as const) {
      f.send(id, name, args); await vi.waitFor(() => expect(f.result(id).isError).toBe(true));
    }
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});

it('reports the explicit offline discovery boundary without forwarding to Pay or creating authority', async () => {
  const f = fixture('PAYMENTS_PAUSED');
  try {
    f.send(1, 'discover_x402_resource', { url: 'https://public.example/data' });
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1).isError).toBe(true);
    expect(f.result(1).content[0].text).toContain('OFFLINE_RESOURCE_LIFECYCLE_UNAVAILABLE');
    expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});

it('dispatches MPP purchases only to the authenticated local backend and preserves the stable request ID', async () => {
  const f = fixture('SPEND_GRANT_REQUIRED');
  const input = { requestId: 'mpp_original', resourceId: 'registered-mpp-resource', reason: 'Retrieve the registered fixture' };
  try {
    f.send(1, 'request_mpp_purchase', input);
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1).isError).toBeUndefined();
    expect(JSON.parse(f.result(1).content[0].text)).toEqual(f.summary);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:14449/api/agent/mpp/purchases');
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1].body))).toEqual(input);
    expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});

it('routes delivery recovery to the dedicated backend with only the original purchase ID', async () => {
  const f = fixture('APPROVED');
  try {
    f.send(1, 'recover_purchase_delivery', { purchaseId: 'pay_original', credential: 'injected' });
    await vi.waitFor(() => expect(f.result(1).isError).toBe(true));
    expect(f.fetcher).not.toHaveBeenCalled();
    f.send(2, 'recover_purchase_delivery', { purchaseId: 'pay_original' });
    await vi.waitFor(() => expect(f.result(2).content[0].text).toContain('MPP_PAID_DELIVERY_REQUIRED'));
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [[url, options]] = f.fetcher.mock.calls;
    expect(url).toBe('http://127.0.0.1:14449/api/agent/mpp/recover-delivery');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(options.body))).toEqual({ purchaseId: 'pay_original' });
    expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});

it('rejects MPP injected payment/approval fields before any local request or Pay forwarding', async () => {
  const f = fixture('SPEND_GRANT_REQUIRED');
  const input = { requestId: 'mpp_original', resourceId: 'registered-mpp-resource', reason: 'Read fixture' };
  try {
    for (const [index, injected] of [{ approved: true }, { url: 'https://attacker.invalid/pay' },
      { amount: '1', payTo: 'untrusted-recipient' }, { transaction: 'unsigned-wire' },
      { credential: 'Payment supplied-by-agent' }, { requestId: '../replacement' }].entries()) {
      f.send(index + 1, 'request_mpp_purchase', { ...input, ...injected });
      await vi.waitFor(() => expect(f.responses).toHaveLength(index + 1));
      expect(f.result(index + 1)).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('RESOURCE_TOOL_INPUT_INVALID') }] });
    }
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});

it('preserves the MPP activation refusal and original-purchase recovery guidance', async () => {
  const f = fixture('SPEND_GRANT_REQUIRED', false, 'MPP_MAINNET_ACCEPTANCE_REQUIRED');
  try {
    f.send(1, 'request_mpp_purchase', { requestId: 'mpp_original', resourceId: 'registered-mpp-resource', reason: 'Read fixture' });
    await vi.waitFor(() => expect(f.responses).toHaveLength(1));
    expect(f.result(1)).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('MPP_MAINNET_ACCEPTANCE_REQUIRED') }] });
    expect(f.result(1).content[0].text).toContain('Read the original purchase ID');
    expect(f.result(1).content[0].text).not.toContain('No spending permission or payment was created');
    expect(f.forwarded).toHaveLength(0);
  } finally { f.close(); }
});
