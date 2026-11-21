import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { authorizeLocalHostPurchase, callMainnetAuthorization, describeLocalHostResource } from '../../src/modules/authority/mainnet-authorization-client';
import { handleLocalHostPurchase, handleLocalHostResource } from '../../src/modules/pay-dev/management-server';
import { requestLocalPurchase } from '../../src/modules/mcp/local-host-purchase';
const home = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), userInfo: () => ({ homedir: home.value }) }));
const secret = 'a'.repeat(43), sessionHash = 'b'.repeat(64);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (home.value) rmSync(home.value, { force: true, recursive: true }); });
function fixture() {
  home.value = realpathSync(mkdtempSync(join(tmpdir(), 'mainnet-web-client-')));
  const root = join(home.value, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5');
  const directory = join(root, 'Mainnet');
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  const memberId = randomUUID();
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'mainnet' }), { mode: 0o600 });
  writeFileSync(join(directory, 'pay-mainnet-runtime.json'), JSON.stringify({ version: 1, profile: 'pay-mcp-mainnet', origin: 'http://127.0.0.1:13449', memberId }), { mode: 0o600 });
  writeFileSync(join(directory, 'management-token'), secret, { mode: 0o600 });
  return { root, directory, memberId };
}
it('authenticates exact requests and responses to the fixed original backend', async () => {
  const { memberId } = fixture();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('http://127.0.0.1:13449/api/app/local-grants');
    expect(init.redirect).toBe('error');
    const headers = new Headers(init.headers), body = String(init.body);
    expect(JSON.parse(body)).toEqual({ action: 'state', memberId, sessionHash });
    expect(headers.get('x-2049-proof')).toBe(createHmac('sha256', secret).update(['2049-management-v1', 'POST', '/api/app/local-grants', headers.get('x-2049-timestamp'), headers.get('x-2049-nonce'), digest(body)].join('\n')).digest('hex'));
    const response = JSON.stringify({ environment: 'mainnet', realFunds: true });
    return new Response(response, { headers: { 'x-2049-response-proof': createHmac('sha256', secret)
      .update(['2049-management-response-v1', headers.get('x-2049-nonce'), '200', digest(response)].join('\n')).digest('hex') } });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await callMainnetAuthorization(sessionHash, { action: 'state', memberId: randomUUID() })).toEqual({ environment: 'mainnet', realFunds: true });
});
it('rejects unverified responses and never retries a grant mutation', async () => {
  fixture(); const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
  await expect(callMainnetAuthorization(sessionHash, { action: 'commit', id: randomUUID() })).rejects.toThrow('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps payment status unknown when a purchase failure lacks the owner response proof', async () => {
  const { memberId } = fixture();
  const fetcher = vi.fn(async () => Response.json({ code: 'LOCAL_PURCHASE_QUERY_NOT_ALLOWED' }, { status: 422 }));
  vi.stubGlobal('fetch', fetcher);
  const input = {requestId: 'price-01', resourceId: 'price', reason: 'Read prices'};
  const result = await requestLocalPurchase(args => authorizeLocalHostPurchase(memberId, 'Test reader', args), input, new AbortController().signal);
  const error = JSON.parse(result.content[0].text);
  expect(error.code).toBe('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
  expect(error).not.toHaveProperty('paymentAttempted');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects a different selected environment before sending any management request', async () => {
  const { root } = fixture(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet' }));
  await expect(callMainnetAuthorization(sessionHash, { action: 'state' })).rejects.toThrow('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ['RESOURCE_REQUEST_INPUT_REQUIRED', 'LOCAL_PURCHASE_INPUT_REQUIRED'],
  ['RESOURCE_REQUEST_INPUT_UNSUPPORTED', 'LOCAL_PURCHASE_INPUT_UNSUPPORTED'],
  ['RESOURCE_REQUEST_INPUT_INVALID', 'LOCAL_PURCHASE_INPUT_INVALID'],
  ['LOCAL_PURCHASE_QUERY_NOT_ALLOWED', 'LOCAL_PURCHASE_QUERY_NOT_ALLOWED'],
  ['LOCAL_PURCHASE_PRICE_LIMIT_EXCEEDED', 'LOCAL_PURCHASE_PRICE_LIMIT_EXCEEDED'],
  ['LOCAL_PURCHASE_QUOTE_UNAVAILABLE', 'LOCAL_PURCHASE_QUOTE_UNAVAILABLE'],
  ['LOCAL_PURCHASE_QUOTE_INVALID', 'LOCAL_PURCHASE_QUOTE_INVALID'],
  ['LOCAL_PURCHASE_DESTINATION_REJECTED', 'LOCAL_PURCHASE_DESTINATION_REJECTED'],
  ['private diagnostic', 'LOCAL_PURCHASE_OWNER_REJECTED'],
])('keeps authenticated owner failures distinct from an unreachable server: %s', async (ownerError, code) => {
  const { memberId } = fixture();
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  const app = { authorizeHostPurchase: vi.fn().mockRejectedValue(new Error(ownerError)) };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => handleLocalHostPurchase(new Request(url, init), app, new URL(url).origin));
  const input = {requestId: 'price-01', resourceId: 'price', reason: 'Read prices'};
  const result = await requestLocalPurchase(args => authorizeLocalHostPurchase(memberId, 'Test reader', args), input, new AbortController().signal);
  expect(app.authorizeHostPurchase).toHaveBeenCalledOnce();
  expect(result.isError).toBe(true);
  const error = JSON.parse(result.content[0].text);
  expect(error).toMatchObject({code, requestId: 'price-01'});
  if (code === 'LOCAL_PURCHASE_OWNER_REJECTED') expect(error).not.toHaveProperty('paymentAttempted');
  else expect(error).toMatchObject({stage: 'purchase_preparation', paymentAttempted: false});
  expect(error.next).not.toContain('after an interrupted response');
  if (code === 'LOCAL_PURCHASE_QUERY_NOT_ALLOWED') expect(error.next).toContain('omit request');
  expect(result.content[0].text).not.toContain('private diagnostic');
});

it('binds a read-only contract to the signed host and requested resource, with no default member or authority', async () => {
  fixture();
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  const hostId = randomUUID(), label = 'Registered host', lookup = {resourceId: 'price-api'};
  const contract = {...lookup, name: 'Price API', method: 'GET', protocol: 'x402', networkFeeCap: 'omit',
    query: {mode: 'fixed', fields: [], requiresAtLeastOne: false}};
  const app = {describeHostResource: vi.fn().mockReturnValue(contract)};
  const url = 'http://127.0.0.1:13449/api/app/local-host-resource';
  const unauthenticated = await handleLocalHostResource(new Request(url, {method: 'POST',
    headers: {origin: new URL(url).origin, 'content-type': 'application/json'}, body: JSON.stringify({hostId, label, ...lookup})}), app);
  expect(unauthenticated.status).toBe(401);
  expect(app.describeHostResource).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', (address: string, init: RequestInit) => {
    expect(address).toBe(url);
    return handleLocalHostResource(new Request(address, init), app);
  });
  expect(await describeLocalHostResource(hostId, label, lookup)).toEqual(contract);
  expect(app.describeHostResource).toHaveBeenCalledWith({hostId, label, ...lookup});
  app.describeHostResource.mockReturnValueOnce({...contract, resourceId: 'another-api'});
  await expect(describeLocalHostResource(hostId, label, lookup)).rejects.toThrow('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
  app.describeHostResource.mockImplementationOnce(() => { throw new Error('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED'); });
  await expect(describeLocalHostResource(hostId, label, lookup)).rejects.toThrow('LOCAL_AUTHORIZATION_RESOURCE_UNSUPPORTED');
});
