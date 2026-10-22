import { createServer } from 'node:http';
import { z } from 'zod';
import type { AppRuntime } from '../app/app-runtime';
import type { createPayAuthorityAdapter } from '../payment/pay-authority-adapter';
import { McpSessionEventSchema } from '../mcp/session';
import * as overview from '../../app/api/app/overview/route';
import * as health from '../../app/api/app/health/route';
import * as settings from '../../app/api/app/settings/route';
import * as grant from '../../app/api/app/grant/route';
import * as members from '../../app/api/app/members/route';
import * as member from '../../app/api/app/members/[memberId]/route';
import * as memberGrant from '../../app/api/app/members/[memberId]/grant/route';
import * as memberConnection from '../../app/api/app/members/[memberId]/connection/route';
import * as lifecycle from '../../app/api/app/lifecycle/route';
import * as executionMode from '../../app/api/app/execution/route';
import * as balance from '../../app/api/app/balance/route';
import * as wallets from '../../app/api/app/wallets/route';
import * as resources from '../../app/api/app/resources/route';
import * as resourceDiscovery from '../../app/api/app/resources/discover/route';
import * as resourcePreparation from '../../app/api/app/resources/prepare/route';
import * as resource from '../../app/api/app/resources/[resourceId]/route';
import * as agentDiscovery from '../../app/api/agent/discovery/route';
import * as agentResources from '../../app/api/agent/resources/route';
import * as agentQuote from '../../app/api/agent/quote/route';
import * as agent from '../../app/api/agent/route';
import { managementRoute } from '../app/management-auth';
import { smallJson } from '../http/local-request';


/** Shared authenticated management server. The payment path stays in AppRuntime
 * and Pay; only Offline supplies a simulator and isolated authority executor. */
export async function serveDevelopmentRuntime<T extends { memberId: string }>(options: {
  app: AppRuntime; origin: string; port: number; descriptor: T;
  authority?: ReturnType<typeof createPayAuthorityAdapter>;
  simulator?: { merchantOrigin: string };
  cleanup(): Promise<void>;
}) {
  const { app, origin, port, descriptor, authority, simulator } = options;
  type Handler = (request: Request) => Promise<Response>;
  const routes = new Map<string, Handler>([
    // Reuse the product's member-authenticated read. Payment entry stays Pay MCP.
    ['GET /api/agent', request => new URL(request.url).searchParams.get('operation') === 'status'
      ? agent.GET(request) : Promise.resolve(Response.json({ code: 'INVALID_OPERATION' }, { status: 400 }))],
    ['GET /api/app/overview', overview.GET], ['GET /api/app/health', health.GET],
    ['PUT /api/app/settings', settings.PUT], ['PUT /api/app/grant', grant.PUT],
    ['GET /api/app/members', members.GET], ['POST /api/app/members', members.POST],
    ['POST /api/app/lifecycle', lifecycle.POST], ['GET /api/app/execution', executionMode.GET],
    ['PUT /api/app/execution', executionMode.PUT], ['GET /api/app/balance', balance.GET],
    ['GET /api/app/wallets', wallets.GET], ['POST /api/app/wallets', wallets.POST],
    ['GET /api/app/resources', resources.GET], ['POST /api/app/resources', resources.POST],
    ['POST /api/app/resources/discover', resourceDiscovery.POST], ['POST /api/app/resources/prepare', resourcePreparation.POST],
    ['POST /api/agent/discovery', agentDiscovery.POST], ['POST /api/agent/resources', agentResources.POST], ['POST /api/agent/quote', agentQuote.POST],
    ['PUT /api/app/connection', request => managementRoute(request, true, async verified => {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await smallJson(verified));
      return Response.json({ connection: await app.setMemberConnection(enabled, origin, descriptor.memberId) });
    })],
  ]);
  let stopping = false;
  let ready = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== `127.0.0.1:${port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress ?? ''))
        throw new Error('PAY_DEVELOPMENT_LOOPBACK_REQUIRED');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length; if (size > 131072) throw new Error('PAY_REQUEST_TOO_LARGE'); chunks.push(Buffer.from(chunk));
      }
      const method = incoming.method ?? 'GET';
      const url = new URL(incoming.url ?? '/', origin);
      if (url.origin !== origin) throw new Error('PAY_DEVELOPMENT_LOOPBACK_REQUIRED');
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(url, { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      let response: Response;
      if (simulator && url.pathname.startsWith('/api/paid/')) {
        response = await fetch(`${simulator.merchantOrigin}${url.pathname}${url.search}`, {
          method, headers: { ...Object.fromEntries(headers), host: new URL(simulator.merchantOrigin).host },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
      } else if (url.pathname === '/api/agent/session' && method === 'POST') {
        app.observeMcpSession(request, McpSessionEventSchema.parse(await smallJson(request)));
        response = Response.json({ ok: true });
      } else if (url.pathname.startsWith('/pay/') && method === 'POST') {
        if (!ready) { outgoing.writeHead(503); outgoing.end(); return; }
        const principal = app.authenticateAgent(request, 'request_purchase');
        const raw: unknown = await smallJson(request);
        const action = z.enum(['authorize', 'plan', 'execute']).parse(url.pathname.slice('/pay/'.length));
        if (!authority) response = Response.json(await app.payMcpOperation(action, raw, principal, origin));
        else if (action === 'authorize') response = Response.json(await authority.authorize(raw, principal));
        else {
          const input = z.object({ facts: z.unknown(), unsigned: z.unknown().optional() }).strict().parse(raw);
          response = Response.json(await (action === 'plan' ? authority.plan(input.facts, principal) : authority.execute(input.facts, input.unsigned, principal)));
        }
      } else {
        const handler = routes.get(`${method} ${url.pathname}`);
        const dynamic = /^\/api\/app\/members\/([a-f0-9-]{36})(?:\/(grant|connection))?$/.exec(url.pathname);
        const resourcePath = /^\/api\/app\/resources\/([a-z0-9][a-z0-9._-]{0,119})$/.exec(url.pathname);
        if (handler) response = await handler(request);
        else if (resourcePath && ['GET', 'PUT'].includes(method)) {
          const context = { params: Promise.resolve({ resourceId: resourcePath[1] }) };
          response = await (method === 'GET' ? resource.GET(request, context) : resource.PUT(request, context));
        }
        else if (dynamic) {
          const context = { params: Promise.resolve({ memberId: dynamic[1] }) };
          const suffix = dynamic[2];
          if (suffix === 'grant' && method === 'PUT') response = await memberGrant.PUT(request, context);
          else if (suffix === 'connection' && method === 'PUT') response = await memberConnection.PUT(request, context);
          else if (!suffix && method === 'GET') response = await member.GET(request, context);
          else if (!suffix && method === 'PUT') response = await member.PUT(request, context);
          else if (!suffix && method === 'DELETE') response = await member.DELETE(request, context);
          else response = Response.json({ error: 'NOT_FOUND' }, { status: 404 });
        } else response = Response.json({ error: 'PAY_MCP_REQUIRED' }, { status: 404 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      // Fixed, bounded diagnostic codes only. Never echo credentials/requests.
      const message = error instanceof Error ? error.message : '';
      const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'PAY_DEVELOPMENT_REQUEST_REJECTED';
      outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: code }));
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  try { await app.start(origin); ready = true; }
  catch (error) { await new Promise<void>(done => server.close(() => done())); throw error; }
  return { app, origin, descriptor, async close() {
    if (stopping) return; stopping = true;
    await app.prepareQuit();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    app.close(); await options.cleanup();
  } };
}
