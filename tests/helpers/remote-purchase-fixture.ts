import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { handleRemoteReadMcp } from '../../src/modules/remote/mcp';
import { handleRemoteReadPairings } from '../../src/modules/remote/management';
import { initializeRemotePurchaseSandbox } from '../../src/modules/purchases/remote-simulated-purchase';
import { signedManagementRequest } from './management-request';
import { vi } from 'vitest';

/** Bind only the actual Mac pairing and MCP routes. Nothing in this fixture can sign,
 * operate a wallet, contact a merchant or submit a transaction. Deliberately discard
 * one HTTP reply AFTER the handler completes, without changing any ledger state. */
export async function remotePurchaseFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-p2-acceptance-')));
  const secret = randomBytes(32).toString('hex'), nativeFetch = globalThis.fetch;
  vi.stubEnv('YOSH_EXECUTION_MODE', 'simulated'); vi.stubEnv('APP2049_EXECUTION_MODE', undefined);
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret); vi.stubEnv('APP2049_MANAGEMENT_TOKEN', undefined);
  vi.stubEnv('YOSH_DATA_DIR', directory); vi.stubEnv('APP2049_DATA_DIR', undefined);
  let allow = false, drop = false, origin = '', refusedNetwork = 0, clockOffset = 0;
  const noNetwork = async () => { refusedNetwork++; throw new Error('EXTERNAL_IO_FORBIDDEN_IN_SIMULATION'); };
  vi.stubGlobal('fetch', noNetwork);
  const options = { remotePurchaseSandbox: true, now: () => Date.now() + clockOffset, confirmRemotePurchaseConsent: async () => allow, confirmRemoteReadPairing: async () => allow,
    fetcher: noNetwork, initializeWallet: noNetwork, readWallets: noNetwork };
  initializeRemotePurchaseSandbox(directory);
  writeFileSync(join(directory,'standalone-control.json'),JSON.stringify({profile:'yosh-remote-purchase-sandbox', environment:'simulated', managementSecret:secret}),{mode:0o600});
  let app = new AppRuntime(directory, options);
  const route = '/api/app/remote-read-pairings';
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key,value);
      const request = new Request(origin + incoming.url, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? {body: Buffer.concat(chunks)} : {}) });
      const mcp = incoming.url === '/api/agent/remote-mcp';
      const response = mcp ? await handleRemoteReadMcp(app, request) : incoming.url === route
        ? await handleRemoteReadPairings(app, request) : new Response(null, {status: 404});
      if (mcp && drop) { drop = false; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500).end(); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('LOOPBACK_PORT_REQUIRED');
  origin = 'http://127.0.0.1:' + addr.port;
  return { directory, nativeFetch, origin, get app() { return app; }, get refusedNetwork() { return refusedNetwork; },
    advance(ms: number) { clockOffset += ms; },
    consent(allowed: boolean) { allow = allowed; }, loseNextReply() { drop = true; },
    manage(body?: object) { return nativeFetch(signedManagementRequest(origin + route, secret,
      body ? { method: 'POST', headers: { origin, 'content-type':'application/json' }, body: JSON.stringify(body) } : {})); },
    async owner(action: string, ...args: string[]) {
      const {stdout} = await promisify(execFile)(process.execPath, ['--import',resolve('node_modules/tsx/dist/loader.mjs'),
        resolve('scripts/remote-read-owner.ts'),action,'--data-dir',directory,'--backend-port',String(addr.port),...args],
        {cwd:directory,env:{HOME:directory,NODE_ENV:'test',PATH:'/usr/bin:/bin'}});
      return stdout;
    },
    reopen() { app.close(); app = new AppRuntime(directory, options); },
    async close() {
      await new Promise<void>(done => server.close(() => done())); app.close(); rmSync(directory,{recursive:true,force:true});
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
    } };
}
