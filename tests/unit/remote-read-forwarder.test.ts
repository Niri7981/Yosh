import { lstat } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { startMacReadForwarder, startRemoteReadRelay } from '../../src/modules/remote/forwarder';

const authorization = 'Bearer yrr1_' + '0'.repeat(43);
async function listen(server: Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('TEST_PORT_MISSING');
  return addr.port;
}
function close(server: Server) { return new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }); }

it('serves only the exact MCP path and bearer format, with bounded messages and no credential-bearing response headers', async () => {
  let hits = 0, forwardedAdmin = false, mode: 'ok' | 'redirect' | 'big' = 'ok';
  const backend = createServer((req, res) => {
    hits++;
    forwardedAdmin ||= Boolean(req.headers['x-management-secret']);
    if (mode === 'redirect') { res.writeHead(302, {location: '/api/app/settings'}).end(); return; }
    res.writeHead(200, {'content-type': 'application/json', 'set-cookie': 'fixture=not-for-cloud'});
    res.end(mode === 'ok' ? JSON.stringify({ path: req.url, method: req.method }) : 'x'.repeat(140_000));
  });
  const tunnel = await listen(backend), relay = await startRemoteReadRelay({listenPort: 0, tunnelPort: tunnel});
  const url = 'http://127.0.0.1:' + relay.port;
  const call = (path: string, headers: Record<string,string> = {}, method = 'POST', body = '{}') => fetch(url + path, {
    method, redirect: 'manual', headers: {authorization, 'content-type': 'application/json', ...headers}, ...(method === 'POST' ? {body} : {})});
  try {
    expect((await call('/api/app/overview')).status).toBe(404);
    expect((await call('/mcp?target=other')).status).toBe(404);
    expect((await call('/mcp', {}, 'GET')).status).toBe(405);
    expect((await call('/mcp', {authorization: 'Bearer not-a-remote-reader'})).status).toBe(401);
    expect((await call('/mcp', {origin: 'https://example.test'})).status).toBe(403);
    expect((await call('/mcp', {'sec-fetch-site': 'same-site'})).status).toBe(403);
    expect((await call('/mcp', {cookie: 'management=fixture'})).status).toBe(403);
    expect((await call('/mcp', {}, 'POST', 'x'.repeat(17_000))).status).toBe(413);
    expect(hits).toBe(0);
    const read = await call('/mcp', {'x-management-secret': 'fixture'});
    expect(await read.json()).toEqual({path:'/mcp',method:'POST'});
    expect(read.headers.get('cache-control')).toBe('no-store'); expect(read.headers.has('set-cookie')).toBe(false);
    mode = 'redirect'; expect((await call('/mcp')).status).toBe(502);
    mode = 'big'; expect((await call('/mcp')).status).toBe(502);
    expect(hits).toBe(3); expect(forwardedAdmin).toBe(false);
    await close(backend);
    const offline = await call('/mcp');
    expect(offline.status).toBe(503); expect(await offline.json()).toEqual({code:'MAC_OFFLINE'});
  } finally { await relay.close(); if (backend.listening) await close(backend); }
});

it('exposes a user-private Mac socket routed only to the fixed remote-read backend', async () => {
  let path: string | undefined;
  const backend = createServer((req, res) => { path = req.url; res.writeHead(202, {'set-cookie':'fixture'}).end(); });
  const port = await listen(backend), mac = await startMacReadForwarder({backendPort: port});
  try {
    expect((await lstat(mac.socketPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(mac.socketPath))).mode & 0o777).toBe(0o700);
    await new Promise<void>((resolve, reject) => {
      const out = request({socketPath:mac.socketPath, method:'POST', path:'/mcp', headers:{authorization, 'content-type':'application/json'}}, res => {
        try { expect(res.statusCode).toBe(202); expect(res.headers['set-cookie']).toBeUndefined(); res.resume(); resolve(); }
        catch (error) { reject(error); }
      });
      out.on('error', reject); out.end('{}');
    });
    expect(path).toBe('/api/agent/remote-mcp');
  } finally { await mac.close(); await close(backend); }
  await expect(lstat(mac.socketPath)).rejects.toMatchObject({code:'ENOENT'});
});
