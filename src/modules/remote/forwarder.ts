import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INPUT_LIMIT = 8 * 1024, OUTPUT_LIMIT = 128 * 1024;
const bearer = /^Bearer yr[rp]1_[A-Za-z0-9_-]{43}$/;
type Target = { port: number; path: '/mcp' | '/api/agent/remote-mcp' };

function checkPort(port: number, allowZero = false) {
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) throw new Error('INVALID_REMOTE_READ_PORT');
  return port;
}
function reject(res: ServerResponse, status: number, code: string) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
    ...(status === 401 ? { 'www-authenticate': 'Bearer realm="Yosh"' } : {}) });
  res.end(JSON.stringify({ code }));
}
function occurrences(req: IncomingMessage, name: string) {
  return req.rawHeaders.filter((value, i) => !(i % 2) && value.toLowerCase() === name).length;
}

class TooLarge extends Error {}
async function boundedBody(input: IncomingMessage, limit: number) {
  const parts: Buffer[] = []; let size = 0;
  if (Number(input.headers['content-length']) > limit) throw new TooLarge();
  for await (const chunk of input.iterator({ destroyOnReturn: false })) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new TooLarge();
    parts.push(bytes);
  }
  return Buffer.concat(parts, size);
}

function forward(target: Target, headers: Record<string, string>, body: Buffer, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, fail) => {
    const out = request({ hostname: '127.0.0.1', port: target.port, path: target.path, method: 'POST',
      headers: { ...headers, 'content-length': body.length }, signal, agent: false }, resolve);
    out.on('error', fail);
    out.end(body);
  });
}

/** Both trust boundaries have one fixed destination and a header allowlist. No
 * inbound URL or client header selects the backend, the member, or the account. */
function proxy(target: Target) {
  checkPort(target.port);
  let active = 0;
  const server = createServer({ maxHeaderSize: 12 * 1024, requestTimeout: 10_000, headersTimeout: 8_000 }, async (req, res) => {
    if (req.url !== '/mcp') return reject(res, 404, 'NOT_FOUND');
    if (req.method !== 'POST') return reject(res, 405, 'METHOD_NOT_ALLOWED');
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers.cookie !== undefined || req.headers['proxy-authorization'] !== undefined)
      return reject(res, 403, 'REMOTE_CONTEXT_DENIED');
    const auth = req.headers.authorization;
    if (occurrences(req, 'authorization') !== 1 || !auth || !bearer.test(auth)) return reject(res, 401, 'REMOTE_READ_UNAUTHORIZED');
    if (occurrences(req, 'content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'])
      return reject(res, 415, 'JSON_REQUIRED');
    if (active >= 16) return reject(res, 429, 'REMOTE_BUSY');
    active++;
    const stop = new AbortController();
    const deadline = setTimeout(() => { reject(res, 504, 'REMOTE_READ_TIMEOUT'); stop.abort(); req.destroy(); }, 12_000);
    res.once('close', () => stop.abort());
    let upstream: IncomingMessage | undefined;
    try {
      const body = await boundedBody(req, INPUT_LIMIT);
      const headers: Record<string,string> = { authorization: auth, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
      const version = req.headers['mcp-protocol-version'];
      if (version !== undefined) {
        if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) return reject(res, 400, 'INVALID_MCP_VERSION');
        headers['mcp-protocol-version'] = version;
      }
      upstream = await forward(target, headers, body, stop.signal);
      const status = upstream.statusCode ?? 502;
      if (status === 202 || status === 204) { res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); return; }
      if ((status !== 200 && !(status >= 400 && status <= 499) && status !== 503 && status !== 504)
        || !/^application\/json\b/i.test(upstream.headers['content-type'] ?? '')) return reject(res, 502, 'REMOTE_UPSTREAM_ERROR');
      const result = await boundedBody(upstream, OUTPUT_LIMIT);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': result.length,
        ...(status === 401 ? { 'www-authenticate': 'Bearer realm="Yosh"' } : {}) }); res.end(result);
    } catch (error) {
      if (error instanceof TooLarge) reject(res, upstream ? 502 : 413, upstream ? 'REMOTE_RESPONSE_TOO_LARGE' : 'REMOTE_REQUEST_TOO_LARGE');
      else if (error instanceof Error && 'code' in error && ['ECONNREFUSED','ECONNRESET','EPIPE'].includes(String(error.code)))
        reject(res, 503, 'MAC_OFFLINE');
      else reject(res, 502, 'REMOTE_UPSTREAM_ERROR');
    } finally { active--; clearTimeout(deadline); upstream?.destroy(); }
  });
  server.maxConnections = 48;
  server.setTimeout(12_000);
  return server;
}
function listen(server: Server, address: {host: string; port: number} | {path: string}) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.off('error', reject); resolve(); });
  });
}
function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function startRemoteReadRelay(options: { listenPort: number; tunnelPort: number }) {
  if (options.listenPort === options.tunnelPort) throw new Error('REMOTE_READ_PORT_CONFLICT');
  const server = proxy({ port: options.tunnelPort, path: '/mcp' });
  await listen(server, { host: '127.0.0.1', port: checkPort(options.listenPort, true) });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('REMOTE_RELAY_NOT_LISTENING');
  return { port: address.port, close: () => close(server) };
}

export async function startMacReadForwarder(options: { backendPort: number }) {
  const server = proxy({ port: options.backendPort, path: '/api/agent/remote-mcp' });
  const directory = await mkdtemp(join(tmpdir(), 'yrr-'));
  const socketPath = join(directory, 'read.sock');
  try {
    await chmod(directory, 0o700);
    await listen(server, { path: socketPath });
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true }); throw error;
  }
  return { socketPath, close: async () => {
    try { await close(server); } finally { await rm(directory, { recursive: true, force: true }); }
  } };
}
