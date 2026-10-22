/** Explicit, unpaid installed Dev acceptance. Never calls curl or creates a Grant. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const root = '/Users/irin/Library/Application Support/Yosh Pay Dev';
  const app = '/Users/irin/Desktop/Yosh Pay Dev/Yosh Pay Dev.app';
  if (JSON.parse(readFileSync(join(root, 'development-environment.json'), 'utf8')).environment !== 'mainnet') throw new Error('MAINNET_DEV_REQUIRED');
  const token = readFileSync(join(root, 'Mainnet/management-token'), 'utf8').trim();
  const path = '/api/app/resources', nonce = randomBytes(32).toString('hex'), timestamp = String(Date.now());
  const bodyHash = createHash('sha256').update('').digest('hex');
  const proof = createHmac('sha256', token).update(['2049-management-v1', 'GET', path, timestamp, nonce, bodyHash].join('\n')).digest('hex');
  const response = await fetch('http://127.0.0.1:13049' + path, { headers: {
    'x-2049-timestamp': timestamp, 'x-2049-nonce': nonce, 'x-2049-body-sha256': bodyHash, 'x-2049-proof': proof },
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const raw = new Uint8Array(await response.arrayBuffer());
  const expected = createHmac('sha256', token).update(['2049-management-response-v1', nonce, String(response.status), createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  if (raw.length > 131072 || response.status !== 200 || response.headers.get('x-2049-response-proof') !== expected) throw new Error('SIGNED_REGISTRY_REQUIRED');
  const registry = z.object({ resources: z.array(z.object({ resourceId: z.string(), state: z.string(), url: z.string() })) }).parse(JSON.parse(Buffer.from(raw).toString('utf8')));
  const resourceId = 'agent402-crypto-price';
  const existing = registry.resources.find(resource => resource.resourceId === resourceId);
  if (existing && (existing.state !== 'ACTIVE' || existing.url !== 'https://agent402.tools/api/crypto-price')) throw new Error('RESOURCE_ID_CONFLICT');
  const temporary = mkdtempSync(join(tmpdir(), 'yosh-resource-client-'));
  const client = new Client({ name: 'installed-dev-resource-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: app + '/Contents/MacOS/YoshBackendNode',
    args: [app + '/Contents/Resources/Runtime/mcp.cjs', '--data-dir', root],
    env: { PATH: '/usr/bin:/bin', HOME: temporary, NODE_ENV: 'production' }, stderr: 'pipe' });
  async function call(name: string, args: Record<string, unknown>) {
    if (!['discover_x402_resource', 'register_x402_resource', 'quote_x402_resource'].includes(name)) throw new Error('UNPAID_TOOLS_ONLY');
    const result = await client.callTool({ name, arguments: args });
    if (result.isError || !Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('UNPAID_TOOL_REJECTED:' + name);
    return JSON.parse(String(result.content[0].text)) as unknown;
  }
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['curl', 'get_spending_status', 'discover_x402_resource', 'register_x402_resource', 'quote_x402_resource']) if (!names.includes(name)) throw new Error('TOOL_NOT_EXPOSED:' + name);
    if (names.includes('request_purchase') || names.includes('create_spend_grant')) throw new Error('LEGACY_OR_MANAGEMENT_TOOL_EXPOSED');
    const sample = { query: { coins: 'BTC,ETH,SOL', currency: 'usd' } };
    const discovery = z.object({ discoveryId: z.uuid(), paymentSent: z.literal(false), baseAmount: z.string(), network: z.string(), assetId: z.string() }).parse(await call('discover_x402_resource', {
      url: 'https://agent402.tools/api/crypto-price', method: 'GET',
      requestInputs: { query: { coins: { type: 'string', required: true }, currency: { type: 'string', required: false } } }, sample,
      deliveryPolicy: { format: 'json', mimeTypes: ['application/json'], maxBytes: 262144 },
      documentation: { urls: ['https://agent402.tools/api/crypto-price'], uncertainties: ['Unpaid quote only; delivery and recovery have not been verified.'] } }));
    let registered: unknown = { resourceId, registrationStatus: 'EXISTING' };
    if (!existing) registered = await call('register_x402_resource', { discoveryId: discovery.discoveryId, resourceId, providerId: 'agent402.tools', displayName: 'Agent402 Crypto Price' });
    const quote = z.object({ paymentSent: z.literal(false), amount: z.string(), preflight: z.unknown() }).parse(await call('quote_x402_resource', { resourceId, sample }));
    const result = { date: new Date().toISOString(), installedRealPayStdio: true, toolsPresent: names, public402Discovery: discovery,
      registration: z.object({ resourceId: z.string(), registrationStatus: z.string(), spendingAuthorityCreated: z.boolean().optional() }).parse(registered),
      unpaidQuote: quote, curlCalled: false, grantCreated: false, signed: false, paymentSent: false,
      limitation: 'SDK stdio acceptance against installed Dev; the existing Codex session must reconnect to refresh its tool list.' };
    writeFileSync('integration/resource-lifecycle-restoration/installed-live-resources.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await client.close(); rmSync(temporary, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'UNPAID_ACCEPTANCE_FAILED'); process.exitCode = 1; });
