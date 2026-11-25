import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFirstUseStatementServer, readMemberStatement } from '../../src/modules/mcp/first-use-statement';
import { connectionFile } from '../../src/modules/mcp/connection';
import { parseHostRegistration } from '../../src/modules/mcp/local-host-registration';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('lists the generic tools without prompting and requests scoped consent only on valid calls', async () => {
  const statement = { environment: 'live_mainnet', totals: { paidAtomic: '1500', reservedAtomic: '0' } };
  const read = vi.fn().mockRejectedValueOnce(new Error('LOCAL_CONFIRMATION_DENIED')).mockResolvedValueOnce(statement);
  const receipt = { paymentStatus: 'PAID', deliveryStatus: 'COMPLETE' };
  const purchase = vi.fn().mockRejectedValueOnce(new Error('LOCAL_CONFIRMATION_DENIED')).mockResolvedValueOnce(receipt);
  const describe = vi.fn().mockRejectedValueOnce(new Error('LOCAL_RESOURCE_OWNER_OFFLINE')).mockRejectedValueOnce(new Error('MAINNET_BACKEND_STARTING'));
  const recoverDelivery = vi.fn();
  const server = createFirstUseStatementServer(read, purchase, describe, recoverDelivery);
  const client = new Client({ name: 'new-host', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'list_account_purchases', arguments: args });
  try {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['list_account_purchases', 'describe_purchase_resource', 'request_purchase', 'recover_purchase_delivery']);
    expect(tools[0].description).toContain('native confirmation window on this Mac');
    const lookup = () => client.callTool({ name: 'describe_purchase_resource', arguments: { resourceId: 'api' } });
    expect(await lookup()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('start the installed Yosh backend') }] });
    expect(await lookup()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Wait for startup') }] });
    expect((await call({ memberId: randomUUID(), approved: true })).isError).toBe(true);
    expect((await call({ environment: 'devnet' })).isError).toBe(true);
    expect((await call({ from: 30, until: 5 })).isError).toBe(true);
    expect((await client.callTool({ name: 'request_purchase' })).isError).toBe(true);
    for (const extra of [{ environment: 'devnet' }, { approved: true }, { memberId: randomUUID() }])
      expect((await client.callTool({ name: 'recover_purchase_delivery', arguments: { purchaseId: 'one', environment: 'mainnet', ...extra } })).isError).toBe(true);
    expect(recoverDelivery).not.toHaveBeenCalled();
    const intent = { requestId: 'one', resourceId: 'api', reason: 'One research call' };
    const buy = (args: Record<string, unknown>) => client.callTool({ name: 'request_purchase', arguments: args });
    expect((await buy({ ...intent, approved: true })).isError).toBe(true);
    expect((await buy({ ...intent, amount: '100' })).isError).toBe(true);
    expect(purchase).not.toHaveBeenCalled();
    expect((await buy(intent)).content).toEqual([{ type: 'text', text: expect.stringContaining('LOCAL_CONFIRMATION_DENIED') }]);
    expect(await buy(intent)).toMatchObject({ content: [{ text: JSON.stringify(receipt) }] });
    expect(purchase).toHaveBeenCalledTimes(2);
    expect(purchase.mock.calls[1][0]).toEqual(intent);
    expect(read).not.toHaveBeenCalled();
    expect(await call({})).toMatchObject({ isError: true, content: [{ text: JSON.stringify({ code: 'LOCAL_CONFIRMATION_DENIED' }) }] });
    expect(await call({ environment: 'mainnet', limit: 3 })).toMatchObject({ content: [{ text: JSON.stringify(statement) }] });
    expect(read.mock.calls[1][0]).toEqual({ limit: 3 });
  } finally { await client.close(); await server.close(); }
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-first-use-'))); roots.push(directory);
  const member = randomUUID(), file = connectionFile(directory, member);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = { cardMemberId: member, origin: 'http://127.0.0.1:13449', generation: 1, connectionId: randomUUID(),
    token: 'a'.repeat(43), capabilities: ['read_statement'] };
  const request = vi.fn<typeof fetch>();
  const read = () => readMemberStatement(directory, member, { limit: 2 }, AbortSignal.timeout(2_000), request);
  return { file, read, request, descriptor, directory };
}

it('uses only the selected member’s read-only credential and checks the returned environment', async () => {
  const { file, read, request, descriptor } = fixture();
  writeFileSync(file, JSON.stringify(descriptor), { mode: 0o600 });
  const statement = { environment: 'live_mainnet', entries: [] };
  request.mockResolvedValueOnce(Response.json(statement));
  await expect(read()).resolves.toEqual(statement);
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:13449/api/agent/account/statement?limit=2',
    expect.objectContaining({ headers: { authorization: 'Bearer ' + descriptor.token }, redirect: 'error' }));
  writeFileSync(file, JSON.stringify({ ...descriptor, capabilities: ['read_statement', 'request_purchase'] }));
  request.mockResolvedValueOnce(Response.json(statement));
  await expect(read()).resolves.toEqual(statement);
  request.mockResolvedValueOnce(Response.json({ environment: 'simulated' }));
  await expect(read()).rejects.toThrow('LOCAL_STATEMENT_ENVIRONMENT_MISMATCH');
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(read()).rejects.toThrow('LOCAL_STATEMENT_CONNECTION_REVOKED');
});

it('rejects default, linked, different member, unscoped and purchase-only credentials', async () => {
  const { directory, file, descriptor, read, request } = fixture();
  const defaultFile = connectionFile(directory);
  writeFileSync(defaultFile, JSON.stringify(descriptor), { mode: 0o600 });
  await expect(read()).rejects.toThrow('LOCAL_STATEMENT_CONNECTION_UNAVAILABLE');
  symlinkSync(defaultFile, file); await expect(read()).rejects.toThrow('LOCAL_STATEMENT_CONNECTION_UNAVAILABLE'); rmSync(file);
  for (const patch of [{ capabilities: ['read', 'request_purchase'] }, { capabilities: ['request_purchase'] }, { cardMemberId: randomUUID() }, { origin: 'http://127.0.0.1:3000' }]) {
    writeFileSync(file, JSON.stringify({ ...descriptor, ...patch }), { mode: 0o600 });
    await expect(read()).rejects.toThrow('LOCAL_STATEMENT_CONNECTION_INVALID');
  }
  expect(request).not.toHaveBeenCalled();
});

it('requires a stable registration and printable label from the launcher', () => {
  const id = randomUUID();
  expect(parseHostRegistration(['--registration', id, '--label', '研究 Agent'])).toEqual({ registration: id, label: '研究 Agent' });
  for (const args of [[], ['--registration', id, '--label', 'a\nother'], ['--registration', 'default', '--label', 'A']])
    expect(() => parseHostRegistration(args)).toThrow('LOCAL_HOST_REGISTRATION_INVALID');
});
