import type { MainnetAuthorizationCall } from './mainnet-authorization-client';
import { LocalGrantRequest } from './local-grant-approval';
import { readAgentPurchase } from '../purchases/agent-purchase-read';
import { LocalControlAction } from './local-control-approval';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { AppRuntime } from '../app/app-runtime';
import type { ConfirmLocalControl, ConfirmLocalGrant } from './native-grant-confirmation';
import { authorizationPage, authorizationScript, authorizationStyle } from './local-authorization-view';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const Amount = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/);
function atomic(value: string) {
  const [whole, fraction = ''] = Amount.parse(value).split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}
const Draft = z.object({ resourceId: z.string().min(1).max(200), total: Amount, single: Amount,
  hours: z.number().int().min(1).max(168) }).strict();
const RequestId = z.object({ id: z.uuid() }).strict();

/** This first C probe is Offline-only. It never sends a browser the existing
 * management secret, exposes confirmation proofs, or changes payment controls. */
export async function startLocalAuthorization(options: {
  mainnet?: MainnetAuthorizationCall;
  app: AppRuntime; memberId: string; confirm: ConfirmLocalGrant; confirmControl?: ConfirmLocalControl; port?: number;
  assets?: ReadonlyMap<string, { bytes: Buffer; contentType: string }>;
}) {
  const { app, memberId, confirm } = options;
  const sessions = new Map<string, { expires: number; revision: number; pending?: string; pendingControl?: string; pendingMainnet?: string }>();
  const links = new Map<string, number>();
  let confirming = false, origin = '';
  let closing: Promise<void> | undefined;
  const server = createServer(async (incoming, outgoing) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (status: number, body: string | Buffer, type = 'application/json') => {
      outgoing.writeHead(status, { ...headers, 'content-type': type }); outgoing.end(body);
    };
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress ?? '')
        || incoming.headers.host !== new URL(origin).host) throw new Error('LOCAL_WEB_ORIGIN_REJECTED');
      const url = new URL(incoming.url ?? '/', origin), method = incoming.method ?? '';
      if (url.origin !== origin || (incoming.headers.origin && incoming.headers.origin !== origin)) throw new Error('LOCAL_WEB_ORIGIN_REJECTED');
      const asset = options.assets?.get(url.pathname);
      if (method === 'GET' && asset) return send(200, asset.bytes, asset.contentType);
      if (method === 'GET' && url.pathname === '/') return send(200, authorizationPage, 'text/html; charset=utf-8');
      if (method === 'GET' && url.pathname === '/app.js') return send(200, authorizationScript, 'text/javascript; charset=utf-8');
      if (method === 'GET' && url.pathname === '/app.css') return send(200, authorizationStyle, 'text/css; charset=utf-8');
      if (!['GET', 'POST'].includes(method)) throw new Error('LOCAL_WEB_METHOD_REJECTED');
      let input: unknown;
      if (method === 'POST') {
        if (incoming.headers.origin !== origin || incoming.headers['content-type'] !== 'application/json') throw new Error('LOCAL_WEB_ORIGIN_REJECTED');
        const chunks: Buffer[] = []; let size = 0;
        for await (const part of incoming) {
          size += part.length; if (size > 4096) throw new Error('LOCAL_WEB_REQUEST_TOO_LARGE'); chunks.push(Buffer.from(part));
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      const now = Date.now();
      for (const [key, expiry] of links) if (expiry <= now) links.delete(key);
      for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
      if (method === 'POST' && url.pathname === '/session') {
        const { token } = z.object({ token: hex }).strict().parse(input);
        if (!links.delete(hash(token))) throw new Error('LOCAL_WEB_LINK_EXPIRED');
        if (sessions.size >= 16) throw new Error('LOCAL_WEB_BUSY');
        const credential = randomBytes(32).toString('hex');
        sessions.set(hash(credential), { expires: now + 15 * 60_000, revision: 0 });
        return send(200, JSON.stringify({ token: credential }));
      }
      if (!incoming.headers.authorization?.startsWith('Bearer ')) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
      const credential = hex.parse(incoming.headers.authorization.slice(7));
      const sessionHash = hash(credential), session = sessions.get(sessionHash);
      if (!session) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
      // A UI network selection is never permission to reinterpret this runtime's
      // wallet, grants or ledger. Reject mismatches before any read or mutation.
      const requestedEnvironment = incoming.headers['x-yosh-environment'];
      if (requestedEnvironment === 'mainnet' && options.mainnet) {
        const call = (input: Record<string, unknown>) => options.mainnet!(sessionHash, input);
        if (method === 'GET' && url.pathname === '/state') {
          const state = z.object({ environment: z.literal('mainnet'), realFunds: z.literal(true) }).passthrough().parse(await call({ action: 'state' }));
          return send(200, JSON.stringify(state));
        }
        if (method !== 'POST' || !['/requests', '/confirm', '/cancel', '/result'].includes(url.pathname))
          throw new Error('LOCAL_WEB_METHOD_REJECTED');
        if (url.pathname === '/requests') {
          if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
          if (session.expires < now + 300_000) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
          const draft = Draft.parse(input), revision = ++session.revision;
          if (session.pendingMainnet) await call({ action: 'cancel', id: session.pendingMainnet });
          const frozen = z.object({ request: LocalGrantRequest, digest: hex, state: z.literal('PENDING') }).passthrough().parse(await call({ action: 'freeze',
            draft: { resourceId: draft.resourceId, totalLimit: atomic(draft.total), singleLimit: atomic(draft.single), expiresAt: now + draft.hours * 3_600_000 } }));
          if (session.revision !== revision) {
            await call({ action: 'cancel', id: frozen.request.id });
            throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
          }
          session.pendingMainnet = frozen.request.id;
          return send(201, JSON.stringify(frozen));
        }
        const { id } = RequestId.parse(input);
        const frozen = z.object({ request: LocalGrantRequest, digest: hex, state: z.enum(['PENDING', 'CANCELLED', 'CONSUMED']) }).passthrough()
          .parse(await call({ action: 'read', id }));
        if (frozen.request.sessionHash !== sessionHash || frozen.request.environment !== 'mainnet') throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
        if (url.pathname === '/cancel') return send(200, JSON.stringify(await call({ action: 'cancel', id })));
        if (url.pathname === '/result' || frozen.state === 'CONSUMED') return send(200, JSON.stringify(frozen));
        if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
        if (frozen.state !== 'PENDING' || frozen.request.expiresAt <= now) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
        confirming = true;
        try {
          await confirm(frozen.request);
          if (session.expires <= Date.now()) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
          return send(200, JSON.stringify(await call({ action: 'commit', id, digest: frozen.digest })));
        } finally { confirming = false; }
      }
      if (requestedEnvironment !== undefined && requestedEnvironment !== app.localAuthorizationEnvironment())
        throw new Error('LOCAL_WEB_ENVIRONMENT_UNAVAILABLE');
      if (method === 'GET' && url.pathname === '/state') {
        await app.reconcileLocalControlSetup(memberId);
        const state = app.memberOverview(memberId);
        return send(200, JSON.stringify({ environment: app.localAuthorizationEnvironment(), realFunds: false,
          walletSetup: app.localWalletSetup(), member: { id: state.member.id, label: state.member.label }, budget: state.budget,
          connection: { enabled: state.connection.enabled, state: state.connection.integration?.state ?? 'disconnected' },
          wallets: (await app.existingWallets()).map(wallet => ({ id: wallet.id, address: wallet.address,
            status: wallet.status, provisioningState: wallet.provisioningState })),
          resources: app.registeredResources().map(resource => ({ resourceId: resource.resourceId, displayName: resource.name })),
          grants: state.grants, purchases: state.purchases.map(purchase => readAgentPurchase(app.ledger, memberId, { purchaseId: purchase.purchaseId })).filter(Boolean) }));
      }
      if (url.pathname.startsWith('/controls/')) {
        if (!options.confirmControl) throw new Error('LOCAL_CONFIRMATION_UNAVAILABLE');
        const controls = app.ledger.localControlApprovals();
        if (method === 'POST' && url.pathname === '/controls/requests') {
          if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
          if (session.expires < now + 300_000) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
          if (session.pendingControl) controls.cancel(session.pendingControl, sessionHash);
          const value = app.freezeLocalControl(LocalControlAction.parse(input), memberId, sessionHash);
          session.pendingControl = value.request.id;
          return send(201, JSON.stringify(value));
        }
        if (method === 'POST' && ['/controls/confirm', '/controls/cancel', '/controls/result'].includes(url.pathname)) {
          const { id } = RequestId.parse(input), frozen = controls.read(id);
          if (frozen.request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
          if (url.pathname === '/controls/cancel') return send(200, JSON.stringify(controls.cancel(id, sessionHash)));
          if (url.pathname === '/controls/result' || frozen.state === 'CONSUMED') return send(200, JSON.stringify(frozen));
          if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
          if (frozen.state !== 'PENDING' || frozen.request.expiresAt <= now) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
          confirming = true;
          try {
            await options.confirmControl(frozen.request);
            if (session.expires <= Date.now()) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
            return send(200, JSON.stringify(await app.commitLocalControl({ requestId: id, digest: frozen.digest }, sessionHash)));
          } finally { confirming = false; }
        }
        throw new Error('LOCAL_WEB_NOT_FOUND');
      }
      const approvals = app.ledger.localGrantApprovals();
      if (method === 'POST' && url.pathname === '/requests') {
        if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
        if (session.expires < now + 300_000) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
        const draft = Draft.parse(input);
        const revision = ++session.revision;
        if (session.pending) approvals.cancel(session.pending, sessionHash);
        const frozen = await app.freezeLocalGrant({ resourceId: draft.resourceId, totalLimit: atomic(draft.total),
          singleLimit: atomic(draft.single), expiresAt: now + draft.hours * 3_600_000 }, memberId, sessionHash);
        if (session.revision !== revision) {
          approvals.cancel(frozen.request.id, sessionHash);
          throw new Error('LOCAL_AUTHORIZATION_CONTENT_CHANGED');
        }
        session.pending = frozen.request.id;
        return send(201, JSON.stringify(frozen));
      }
      if (method === 'POST' && ['/confirm', '/cancel', '/result'].includes(url.pathname)) {
        const { id } = RequestId.parse(input), frozen = approvals.read(id);
        if (frozen.request.sessionHash !== sessionHash) throw new Error('LOCAL_AUTHORIZATION_SESSION_MISMATCH');
        if (url.pathname === '/cancel') return send(200, JSON.stringify(approvals.cancel(id, sessionHash)));
        if (url.pathname === '/result' || frozen.state === 'CONSUMED') return send(200, JSON.stringify(frozen));
        if (confirming) throw new Error('LOCAL_CONFIRMATION_BUSY');
        if (frozen.state !== 'PENDING' || frozen.request.expiresAt <= now) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
        confirming = true;
        try {
          await confirm(frozen.request);
          if (session.expires <= Date.now()) throw new Error('LOCAL_WEB_SESSION_EXPIRED');
          await app.commitLocalGrant({ requestId: id, digest: frozen.digest }, sessionHash);
          return send(200, JSON.stringify(approvals.read(id)));
        } finally { confirming = false; }
      }
      send(404, JSON.stringify({ code: 'LOCAL_WEB_NOT_FOUND' }));
    } catch (error) {
      const code = error instanceof Error && /^LOCAL_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_WEB_REQUEST_REJECTED';
      send(400, JSON.stringify({ code }));
    }
  });
  server.requestTimeout = 150_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL_WEB_BIND_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin,
    createLink() {
      for (const [key, expiry] of links) if (expiry <= Date.now()) links.delete(key);
      if (links.size >= 16) throw new Error('LOCAL_WEB_BUSY');
      const token = randomBytes(32).toString('hex'); links.set(hash(token), Date.now() + 300_000);
      return `${origin}/#${token}`; // A browser setup link is never proof of approval.
    },
    close() { return closing ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
