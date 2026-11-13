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

function fixture(policyCode: string, missing = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-purchase-read-'))); directories.push(parent);
  const directory = join(parent, 'Yosh Codex Plugin Dev'); mkdirSync(directory, { mode: 0o700 });
  const memberId = randomUUID(); const token = 'a'.repeat(43); const origin = 'http://127.0.0.1:14449';
  writeFileSync(join(directory, 'pay-dev-runtime.json'), JSON.stringify({ version: 1, profile: 'isolated-pay-dev', origin, memberId }), { mode: 0o600 });
  writeFileSync(join(directory, 'mcp-connection.json'), JSON.stringify({ origin, token, cardMemberId: memberId,
    connectionId: randomUUID(), generation: 1, capabilities: ['read', 'request_purchase'] }), { mode: 0o600 });
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
    if (input.endsWith('/api/agent/purchase?operationId=original-op'))
      return missing ? Response.json({ code: 'PURCHASE_NOT_FOUND' }, { status: 404 }) : Response.json(summary);
    if (input.includes('/api/agent/purchases/pay_original/delivery?offset=0'))
      return Response.json({ purchaseId: 'pay_original', offset: 0, nextOffset: null, chunk: 'e30=', totalBytes: 2 });
    if (input.endsWith('/api/agent/discovery')) return Response.json({ code: 'OFFLINE_RESOURCE_LIFECYCLE_UNAVAILABLE' }, { status: 409 });
    throw new Error('UNEXPECTED_AGENT_READ');
  });
  runInNewContext(code, { module: { exports: {} }, require: (name: string): unknown =>
    name === 'node:child_process' ? { spawn: () => child } : requireDependency(name),
    process: { argv: [process.execPath, wrapper, '--data-dir', directory], env: {}, getuid: process.getuid,
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
  return { child, responses, forwarded, fetcher, send, result, listTools, summary, close() { host.end(); child.emit('close', 0); } };
}

it('the plugin lists only upstream curl and blocks guessed upstream tools before forwarding', () => {
  const f = fixture('PAYMENTS_PAUSED');
  try {
    expect(f.listTools()).toEqual(['curl', 'get_spending_status', 'get_purchase', 'get_purchase_delivery',
      'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource']);
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
