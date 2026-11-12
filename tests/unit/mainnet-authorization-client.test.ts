import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { callMainnetAuthorization } from '../../src/modules/authority/mainnet-authorization-client';
const home = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), userInfo: () => ({ homedir: home.value }) }));
const secret = 'a'.repeat(43), sessionHash = 'b'.repeat(64);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { vi.unstubAllGlobals(); if (home.value) rmSync(home.value, { force: true, recursive: true }); });
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
it('rejects a different selected environment before sending any management request', async () => {
  const { root } = fixture(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet' }));
  await expect(callMainnetAuthorization(sessionHash, { action: 'state' })).rejects.toThrow('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
  expect(fetcher).not.toHaveBeenCalled();
});
