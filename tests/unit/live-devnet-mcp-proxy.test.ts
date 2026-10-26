import { buildSync } from 'esbuild';
import { ChildProcess, type SpawnOptions } from 'node:child_process';
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
  platform: 'node', format: 'cjs', packages: 'external', define: { __YOSH_RC5__: 'true' }, minifySyntax: true }).outputFiles[0].text;
const ToolList = z.object({ id: z.number(), result: z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }) });

function fixture(profile: 'devnet' | 'simulated', mismatched = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mcp-profile-'))); directories.push(parent);
  const root = join(parent, 'Yosh Pay Dev v0.1.1-rc.5'); mkdirSync(root, { mode: 0o700 });
  const directory = join(root, profile === 'devnet' ? 'Devnet' : 'Simulated'); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: profile,
    mainnetRiskAccepted: false, rpcUrl: 'https://solana-rpc.publicnode.com' }), { mode: 0o600 });
  const memberId = randomUUID(); const token = 'a'.repeat(43); const origin = 'http://127.0.0.1:13449';
  writeFileSync(join(directory, profile === 'devnet' ? 'pay-devnet-runtime.json' : 'pay-simulated-runtime.json'),
    JSON.stringify({ version: 1, profile: mismatched ? 'pay-mcp-mainnet' : `pay-mcp-${profile}`, origin, memberId }), { mode: 0o600 });
  writeFileSync(join(directory, 'mcp-connection.json'), JSON.stringify({ origin, token, cardMemberId: memberId,
    connectionId: randomUUID(), generation: 1, capabilities: ['read', 'request_purchase'] }), { mode: 0o600 });
  const wrapper = join(parent, 'mcp.cjs'); writeFileSync(wrapper, 'fixture-wrapper');
  writeFileSync(join(parent, 'pay-mcp'), 'fixture-controlled-worker');
  const host = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const responses: unknown[] = [], forwarded: string[] = [];
  output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) responses.push(JSON.parse(line)); });
  child.stdin.on('data', chunk => { forwarded.push(String(chunk)); });
  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    expect(command).toBe(join(parent, 'pay-mcp'));
    expect(args).toHaveLength(1); expect(options.cwd).toBe(directory);
    return child;
  });
  const fetcher = vi.fn(async (input: string, options: RequestInit) => {
    expect(input).toBe(`${origin}/api/agent?operation=status`);
    expect(options.headers).toMatchObject({ authorization: `Bearer ${token}` });
    return Response.json({ service: 'running', mode: profile === 'devnet' ? 'live_devnet' : 'simulated' });
  });
  const mockProcess = { argv: [process.execPath, wrapper, '--data-dir', root], env: {}, getuid: process.getuid,
    stdin: host, stdout: output, stderr: errors, once: vi.fn(), exitCode: 0 };
  runInNewContext(code, { module: { exports: {} }, require: (name: string): unknown =>
    name === 'node:child_process' ? { spawn } : requireDependency(name), process: mockProcess,
    Buffer, URL, Request, Response, AbortSignal, TextEncoder, TextDecoder, Error, setTimeout, clearTimeout, fetch: fetcher });
  const send = (id: number, method: string, params?: unknown) => host.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  const tools = () => {
    send(1, 'tools/list');
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1,
      result: { tools: [{ name: 'curl', inputSchema: { type: 'object' } }] } })}\n`);
    return ToolList.parse(responses.find(response => z.object({ id: z.literal(1) }).safeParse(response).success)).result.tools;
  };
  const close = () => { host.end(); child.emit('close', 0); };
  return { spawn, mockProcess, directory, child, responses, forwarded, fetcher, send, tools, close };
}

it('Devnet chooses its descriptor and forwards only its live-network flag while preserving Pay and Yosh tools', () => {
  const f = fixture('devnet');
  try {
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: f.directory,
      env: { HOME: f.directory, YOSH_PAY_MCP_DEVNET: '1' } });
    expect(f.spawn.mock.calls[0]?.[2]).not.toMatchObject({ env: { YOSH_PAY_MCP_MAINNET: '1' } });
    expect(f.tools().map(tool => tool.name)).toEqual(expect.arrayContaining(['curl', 'get_spending_status',
      'recover_payment', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource']));
    const count = f.forwarded.length;
    f.send(2, 'tools/call', { name: 'curl', arguments: { operation_id: 'fixture-op', url: 'https://fixture.example/data' } });
    expect(f.forwarded).toHaveLength(count + 1);
    expect(f.forwarded.at(-1)).toContain('fixture-op');
  } finally { f.close(); }
});

it('Simulation lists status only and refuses curl/recovery before forwarding anything to Pay', async () => {
  const f = fixture('simulated');
  try {
    expect(f.tools().map(tool => tool.name)).toEqual(['get_spending_status']);
    const count = f.forwarded.length;
    for (const [id, name] of [[2, 'curl'], [3, 'recover_payment']] as const) {
      f.send(id, 'tools/call', { name, arguments: {} });
      expect(f.responses).toContainEqual(expect.objectContaining({ id, result: expect.objectContaining({ isError: true }) }));
    }
    expect(f.forwarded).toHaveLength(count);
    f.send(4, 'tools/call', { name: 'get_spending_status', arguments: {} });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.responses).toContainEqual(expect.objectContaining({ id: 4, result: expect.objectContaining({ content: expect.any(Array) }) })));
  } finally { f.close(); }
});

it('a descriptor from another environment fails before the Pay process is spawned', async () => {
  const f = fixture('devnet', true);
  await vi.waitFor(() => expect(f.mockProcess.exitCode).toBe(1));
  expect(f.spawn).not.toHaveBeenCalled();
  f.close();
});
