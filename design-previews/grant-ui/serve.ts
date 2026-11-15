/** Static design preview. Deliberately imports no backend, wallet or runtime service. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authorizationPage, authorizationScript, authorizationStyle } from '../../src/modules/authority/local-authorization-view';

const port = Number(process.argv[2] ?? '18763');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged port between 1024 and 65535.');
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));
const overlays = ['wallet-assets', 'liquid-melt', 'shared-budget', 'grant-review'];
const banner = '<div style="text-align:center;font:11px -apple-system,sans-serif;color:#d89a68;margin:0 12px 20px;line-height:1.8">设计预览 / 示例数据 · 不会创建真实授权或付款</div>';
const page = authorizationPage.replace('<body>', '<body>' + banner)
  .replace('id="total" inputmode="decimal" value=""', 'id="total" inputmode="decimal" value="10"')
  .replace('id="single" inputmode="decimal" value=""', 'id="single" inputmode="decimal" value="0.50"')
  .replace('<button id="confirm">系统确认</button>', '<button id="confirm" disabled>系统确认（仅预览）</button>');
const script = read('./preview-fixture.js').toString() + '\n' +
  authorizationScript.replace('const token=location.hash.slice(1)', "const token='a'.repeat(64)") + '\n' +
  overlays.map(name => read('./' + name + '.js').toString()).join('\n');
const style = authorizationStyle + '\n' + overlays.map(name => read('./' + name + '.css').toString()).join('\n');
const assets = new Map<string, { body: string | Buffer; type: string }>([
  ['/', { body: page, type: 'text/html; charset=utf-8' }],
  ['/app.js', { body: script, type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { body: style, type: 'text/css; charset=utf-8' }],
  ['/spirit-design-sheet.png', { body: read('../../src/modules/authority/web-assets/spirit-design-sheet.png'), type: 'image/png' }],
  ['/instrument-serif.woff2', { body: read('../../src/modules/authority/web-assets/instrument-serif.woff2'), type: 'font/woff2' }],
]);
for (const path of ['token-icons/solana.svg', 'token-icons/usdc.svg', 'token-icons/usdt.svg', 'agent-icons/claude.svg', 'agent-icons/gemini.svg']) {
  assets.set('/' + path, { body: read('./' + path), type: 'image/svg+xml' });
}
const state = {
  member: { id: 'preview', label: 'Codex' }, budget: { paused: true, remaining: '9000000' },
  connection: { enabled: true, state: 'reconnect_required' }, controlsAvailable: false,
  walletSetup: null, grants: [], wallets: [{ id: 'mainnet', status: 'unavailable', address: null }],
  resources: [{ resourceId: 'demo-prices', displayName: 'Market snapshot · 市场价格 API' }, { resourceId: 'demo-search', displayName: 'Web research · 搜索 API' }],
  purchases: [
    { purchaseId: 'demo-delivered', resourceId: 'demo-prices', amount: '1000', paymentStatus: 'PAID', deliveryStatus: 'COMPLETE' },
    { purchaseId: 'demo-pending', resourceId: 'demo-search', amount: '10000', paymentStatus: 'PAID', deliveryStatus: 'PENDING' },
    { purchaseId: 'demo-denied', resourceId: 'demo-prices', amount: '1000', status: 'DENIED', paymentStatus: 'NOT_PAID', deliveryStatus: 'NOT_STARTED' },
  ],
};
createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const send = (status: number, body: string | Buffer, type = 'application/json') => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host ?? '')) return send(403, '{"code":"PREVIEW_HOST_ONLY"}');
  if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) return send(403, '{"code":"PREVIEW_ORIGIN_ONLY"}');
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET') {
    const asset = assets.get(path);
    if (asset) return send(200, asset.body, asset.type);
    if (path === '/state') {
      const environment = request.headers['x-yosh-environment'] === 'devnet' ? 'devnet' : 'mainnet';
      return send(200, JSON.stringify({ ...state, environment }));
    }
    return send(404, '{"code":"PREVIEW_NOT_FOUND"}');
  }
  request.resume();
  if (request.method === 'POST' && path === '/session') return send(200, '{"token":"preview-only"}');
  return send(403, '{"code":"DESIGN_PREVIEW_ONLY_NO_CHANGES"}');
}).listen(port, '127.0.0.1', () => process.stdout.write(`Design preview: http://127.0.0.1:${port}/?environment=mainnet\n`));
