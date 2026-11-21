import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AppRuntime } from '../app/app-runtime';
import { requireLocalRequest, smallJson } from '../http/local-request';
import { accountTools } from '../mcp/account-read-contract';
import { remotePurchaseToken, remoteReadToken } from './pairings';
import { remotePurchaseInput, remotePurchaseLookup } from './purchase-contract';

const deny = (status: number, code: string) => Response.json({ code }, { status, headers: {
  'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Bearer realm="Yosh"' } : {}),
} });
export async function handleRemoteReadMcp(runtime: AppRuntime | (() => AppRuntime), request: Request) {
  if (request.method !== 'POST') return deny(405, 'REMOTE_READ_METHOD_UNSUPPORTED');
  try { requireLocalRequest(request); } catch { return deny(403, 'REMOTE_READ_LOCAL_FORWARDER_REQUIRED'); }
  if (request.headers.has('origin') || request.headers.has('sec-fetch-site') || new URL(request.url).search)
    return deny(403, 'REMOTE_READ_REQUEST_REJECTED');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const purchase = remotePurchaseToken.test(token);
  if (!purchase && !remoteReadToken.test(token)) return deny(401, 'REMOTE_READ_UNAUTHORIZED');
  const app = typeof runtime === 'function' ? runtime() : runtime;
  const authenticate = () => purchase ? app.authenticateRemotePurchase(token) : app.authenticateRemoteRead(token);
  const unauthorized = () => deny(401, purchase ? 'REMOTE_PURCHASE_UNAUTHORIZED' : 'REMOTE_READ_UNAUTHORIZED');
  try { authenticate(); } catch { return unauthorized(); }
  let body: unknown;
  try { body = await smallJson(request, 8192); }
  catch { return deny(400, 'REMOTE_READ_INPUT_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return deny(400, 'REMOTE_READ_INPUT_INVALID');
  let scopes: readonly string[];
  try { scopes = authenticate().scopes; } catch { return unauthorized(); }
  const server = new McpServer({ name: purchase ? 'Yosh simulated purchases' : 'Yosh account reads', version: '1.0.0' });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    if (purchase) registerPurchaseTools(server, app, token);
    for (const { name, description, schema } of accountTools) {
      const scope = name === 'list_account_purchases' ? 'statement' : 'result';
      if (!scopes.includes(scope)) continue;
      server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async (input: unknown) => {
        try {
          // The SDK may schedule execution after tool registration. Always recheck the live binding at the ledger read.
          const value = app.remoteAccountRead(token, scope, input);
          if (value === null) throw new Error('ACCOUNT_RESULT_NOT_AVAILABLE');
          return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
        } catch (err) {
          const code = err instanceof Error && ['REMOTE_READ_UNAUTHORIZED', 'REMOTE_READ_FORBIDDEN', 'ACCOUNT_RESULT_NOT_AVAILABLE',
            'ACCOUNT_READ_INPUT_INVALID'].includes(err.message) ? err.message : 'ACCOUNT_READ_UNAVAILABLE';
          return { isError: true, content: [{ type: 'text' as const, text: code }] };
        }
      });
    }
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody: body });
    response.headers.set('cache-control', 'no-store');
    return response;
  } finally { await server.close(); }
}

/** A fresh, purchase-only credential can access just its own simulated operations.
 * Never expose a provider response/error, delegate local credentials, or retry an unknown purchase for the caller. */
function registerPurchaseTools(server: McpServer, app: AppRuntime, token: string) {
  const run = async (request: () => unknown) => {
    try {
      const value = await request();
      if (value == null) throw new Error('PURCHASE_NOT_FOUND');
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    } catch (err) {
      const code = err instanceof Error && [
        'REMOTE_PURCHASE_UNAUTHORIZED', 'REMOTE_PURCHASE_SIMULATED_ONLY', 'PURCHASE_NOT_FOUND', 'REQUEST_ID_CONFLICT',
        'SPEND_GRANT_REQUIRED', 'SPEND_GRANT_INACTIVE', 'REMOTE_PURCHASE_NOT_FOUND',
      ].includes(err.message) ? err.message : 'REMOTE_PURCHASE_UNAVAILABLE';
      return { isError: true, content: [{ type: 'text' as const, text: code }] };
    }
  };
  server.registerTool('request_purchase', {
    description: 'Buy the fixed simulated market snapshot using this Agent’s own Spend Grant and the shared simulated wallet. Choose one stable requestId per purchase; after an interruption call get_purchase with that same ID. No real funds.',
    inputSchema: remotePurchaseInput, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, input => run(() => app.requestRemotePurchase(token, input)));
  server.registerTool('get_purchase', {
    description: 'Look up this Agent’s original simulated purchase by requestId. Never starts, retries or pays for a purchase.',
    inputSchema: remotePurchaseLookup, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, input => run(() => app.getRemotePurchase(token, input)));
}
