import { YOSH_VERSION } from '../../src/modules/app/product-version';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentConnection, connectionFile, readConnection } from '../../src/modules/mcp/connection';
import { createAgentServer } from '../../src/modules/mcp/server';
import { PurchaseRequestInputSchema } from '../../src/modules/purchases/request-paid-resource-purchase';
import { requireManagementRequest } from '../../src/modules/app/management-auth';

const dirs: string[] = [];
const cardMemberId = '11111111-1111-4111-8111-111111111111';
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-mcp-')); dirs.push(dir);
  const connection = new AgentConnection(dir, cardMemberId, () => true);
  return { dir, connection };
}
const origin = 'http://127.0.0.1:3049';
const request = (token: string, headers: Record<string, string> = {}) => new Request(`${origin}/api/agent?operation=status`, {
  headers: { authorization: `Bearer ${token}`, ...headers },
});

it('separates Agent and management access, rejects browsers and publishes no token in status', () => {
  const { dir, connection } = fixture();
  vi.stubEnv('APP2049_MANAGEMENT_TOKEN', 'm'.repeat(43));
  expect(() => connection.authenticate(request('m'.repeat(43)))).toThrow();
  connection.setEnabled(true, origin);
  const { token } = readConnection(dir);
  expect(statSync(connectionFile(dir)).mode & 0o777).toBe(0o600);
  expect(() => requireManagementRequest(request(token))).toThrow('UNAUTHORIZED');
  expect(() => connection.authenticate(request('m'.repeat(43)))).toThrow();
  expect(() => connection.authenticate(request(token, { origin }))).toThrow();
  expect(() => connection.authenticate(request(token, { 'sec-fetch-site': 'cross-site' }))).toThrow();
  connection.authenticate(request(token));
  expect(connection.status()).toMatchObject({ enabled: true, lastSeen: expect.any(Number), access: 'purchase_intent' });
  expect(JSON.stringify(connection.status())).not.toContain(token);
});

it('revokes old credentials on disable/re-enable and preserves the current installation capability across restart', () => {
  const { dir, connection } = fixture();
  connection.setEnabled(true, origin);
  const first = readConnection(dir).token;
  connection.setEnabled(false, origin);
  expect(existsSync(connectionFile(dir))).toBe(false);
  expect(() => connection.authenticate(request(first))).toThrow();
  connection.setEnabled(true, origin);
  const second = readConnection(dir).token;
  expect(second).not.toBe(first);
  expect(() => connection.authenticate(request(first))).toThrow();
  connection.authenticate(request(second));
  const restarted = new AgentConnection(dir, cardMemberId, () => true);
  expect(() => restarted.authenticate(request(second))).not.toThrow();
  expect(existsSync(connectionFile(dir))).toBe(true);
});

it('keeps purchase intent access across credential rotation without granting payment authority', () => {
  const { dir, connection } = fixture();
  connection.setEnabled(true, origin);
  const first = readConnection(dir);
  expect(first.capabilities).toEqual(['read', 'request_purchase']);
  connection.authenticate(request(first.token), 'request_purchase');
  const principal = connection.rotateCredential();
  const second = readConnection(dir);
  expect(second.token).not.toBe(first.token);
  expect(second.capabilities).toEqual(['read', 'request_purchase']);
  expect(principal).toEqual({ cardMemberId, connectionId: second.connectionId, connectionGeneration: second.generation });
  expect(() => connection.authenticate(request(first.token))).toThrow();
  connection.authenticate(request(second.token), 'request_purchase');
  connection.rotateCredential();
  const third = readConnection(dir);
  expect(third.capabilities).toEqual(['read', 'request_purchase']);
  expect(() => connection.authenticate(request(second.token), 'request_purchase')).toThrow();
  connection.authenticate(request(third.token), 'request_purchase');
});

it('rejects every credential after its CardMember is revoked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yosh-mcp-member-')); dirs.push(dir);
  let active = true;
  const connection = new AgentConnection(dir, cardMemberId, () => active);
  connection.setEnabled(true, origin);
  const token = readConnection(dir).token;
  connection.authenticate(request(token));
  active = false;
  expect(() => connection.authenticate(request(token))).toThrow('AGENT_UNAUTHORIZED');
  expect(() => connection.rotateCredential()).toThrow('CARD_MEMBER_REVOKED');
});

it('uses the official MCP handshake and exposes a request-only purchase tool with sanitized failures', async () => {
  const read = vi.fn().mockResolvedValue({ amount: '10000', paymentEnabled: false });
  const requestPurchase = vi.fn(async (input: unknown) => {
    const parsed = PurchaseRequestInputSchema.parse(input);
    if (parsed.resourceId === 'unknown-resource') throw new Error('UNKNOWN_PAID_RESOURCE');
    return { status: 'APPROVED', paymentStatus: 'NOT_STARTED' };
  });
  const server = createAgentServer(read, requestPurchase);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect(client.getServerVersion()).toEqual({ name: 'Yosh', version: YOSH_VERSION });
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(['get_spending_status', 'get_market_quote',
      'discover_x402_resource', 'register_x402_resource', 'get_purchase_delivery', 'quote_x402_resource', 'request_purchase']);
    expect(tools.tools.find(tool => tool.name === 'discover_x402_resource')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find(tool => tool.name === 'get_purchase_delivery')?.annotations?.readOnlyHint).toBe(true);
    const purchaseResourceSchema = tools.tools.find(tool => tool.name === 'request_purchase')?.inputSchema.properties?.resourceId;
    expect(purchaseResourceSchema).toMatchObject({ type: 'string' });
    expect(purchaseResourceSchema).not.toHaveProperty('enum');
    const results = await Promise.all(Array.from({ length: 3 }, () => client.callTool({ name: 'get_market_quote', arguments: {} })));
    expect(results.every(result => !result.isError)).toBe(true);
    expect(read.mock.calls).toEqual([['quote'], ['quote'], ['quote']]);
    const unknown = await client.callTool({ name: 'pay', arguments: { approved: true } });
    expect(unknown.isError).toBe(true); expect(read).toHaveBeenCalledTimes(3);
    const requested = await client.callTool({ name: 'request_purchase', arguments: { requestId: 'request-1', resourceId: 'market-snapshot', reason: 'Need SOL data' } });
    expect(requested.isError).not.toBe(true);
    expect(requestPurchase).toHaveBeenCalledWith({ requestId: 'request-1', resourceId: 'market-snapshot', reason: 'Need SOL data' });
    const analysis = await client.callTool({ name: 'request_purchase', arguments: { requestId: 'request-2', resourceId: 'market-analysis', reason: 'Need SOL analysis' } });
    expect(analysis.isError).not.toBe(true);
    const risk = await client.callTool({ name: 'request_purchase', arguments: { requestId: 'request-risk', resourceId: 'token-risk-report', reason: 'Need SOL risk report' } });
    expect(risk.isError).not.toBe(true);
    expect(requestPurchase).toHaveBeenCalledWith({ requestId: 'request-risk', resourceId: 'token-risk-report', reason: 'Need SOL risk report' });
    const rejected = await client.callTool({ name: 'request_purchase', arguments: { requestId: 'request-3', resourceId: 'unknown-resource', reason: 'Need data' } });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain('UNKNOWN_PAID_RESOURCE');
    expect(requestPurchase).toHaveBeenLastCalledWith({ requestId: 'request-3', resourceId: 'unknown-resource', reason: 'Need data' });
    read.mockRejectedValueOnce(new Error('secret-token-and-rpc-url'));
    const failed = await client.callTool({ name: 'get_spending_status', arguments: {} });
    expect(failed.isError).toBe(true); expect(JSON.stringify(failed)).not.toContain('secret-token');
  } finally { await client.close(); await server.close(); }
});

it('MCP delivery accepts continuation beyond one MiB and rejects offsets above the serialized policy bound', async () => {
  const delivery = vi.fn(async (purchaseId: string, offset: number) => ({ purchaseId, offset, nextOffset: null }));
  const server = createAgentServer(async () => ({}), undefined, undefined, delivery);
  const client = new Client({ name: 'delivery-cursor-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (const offset of [1_048_577, 1_572_866]) {
      const result = await client.callTool({ name: 'get_purchase_delivery', arguments: { purchaseId: 'large-text', offset } });
      expect(result.isError).not.toBe(true);
      expect(delivery).toHaveBeenLastCalledWith('large-text', offset);
    }
    for (const offset of [-1, 1_572_867]) {
      expect((await client.callTool({ name: 'get_purchase_delivery', arguments: { purchaseId: 'large-text', offset } })).isError).toBe(true);
    }
    expect(delivery).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});
