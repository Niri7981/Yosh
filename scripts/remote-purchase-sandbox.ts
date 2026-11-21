import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

declare const __YOSH_P2_CONFIRM_DIGEST__: string;
const usage = 'sandbox init --daily-limit <simulated USDC atomic units> | serve --data-dir <sandbox> [--port 17549]';
const control = z.object({ profile: z.literal('yosh-remote-purchase-sandbox'), environment: z.literal('simulated'),
  managementSecret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function loadControl(directory: string) {
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || dirname(directory) !== realpathSync(tmpdir()) || !/^yosh-p2-[A-Za-z0-9]+$/.test(basename(directory))
    || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('REMOTE_PURCHASE_SANDBOX_DIRECTORY_INVALID');
  const fd = openSync(join(directory, 'standalone-control.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const f = fstatSync(fd);
    if (!f.isFile() || f.uid !== process.getuid?.() || (f.mode & 0o077) || f.size > 4096) throw new Error('REMOTE_PURCHASE_SANDBOX_CONTROL_INVALID');
    return control.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}
async function main() {
  if (process.argv.includes('--help')) { console.log(usage); return; }
  const {positionals, values} = parseArgs({ allowPositionals: true, options: {
    'daily-limit': {type:'string'}, 'data-dir': {type:'string'}, port: {type:'string'},
  }});
  const [action] = z.tuple([z.enum(['init','serve'])]).parse(positionals);
  // This is a dedicated process. Don't import any product module with an inherited
  // wallet, execution profile, signer, resource catalog, dotenv or Codex configuration.
  for (const name of Object.keys(process.env)) {
    if (!['HOME','TMPDIR','LANG','PATH','USER','LOGNAME','__CF_USER_TEXT_ENCODING'].includes(name)) delete process.env[name];
  }
  Object.assign(process.env, { NODE_ENV: 'test', YOSH_EXECUTION_MODE: 'simulated', YOSH_ENABLE_DEVNET_PURCHASES: '0', YOSH_ENABLE_MAINNET_EXECUTION: '0' });
  const port = z.coerce.number().int().min(0).max(65535).parse(values.port ?? '17549');
  const limit = action === 'init' ? z.string().regex(/^[1-9][0-9]{0,14}$/).parse(values['daily-limit']) : undefined;
  if ((action === 'init' && values['data-dir']) || (action !== 'init' && values['daily-limit']))
    throw new Error('REMOTE_PURCHASE_SANDBOX_INVALID_ARGUMENTS');
  const directory = action === 'init' ? mkdtempSync(join(realpathSync(tmpdir()), 'yosh-p2-')) : z.string().min(1).parse(values['data-dir']);
  const {initializeRemotePurchaseSandbox} = await import('../src/modules/purchases/remote-simulated-purchase');
  if (action === 'init') {
    initializeRemotePurchaseSandbox(directory);
    writeFileSync(join(directory, 'standalone-control.json'), JSON.stringify({profile:'yosh-remote-purchase-sandbox',environment:'simulated',
      managementSecret: randomBytes(32).toString('hex')}), {flag:'wx',mode:0o600,flush:true});
  }
  process.env.YOSH_DATA_DIR = directory;
  process.env.YOSH_MANAGEMENT_TOKEN = loadControl(directory).managementSecret;
  const {configureRemoteReadConfirmation} = await import('../src/modules/remote/confirm');
  configureRemoteReadConfirmation(join(dirname(realpathSync(process.argv[1])), 'yosh-confirm'), __YOSH_P2_CONFIRM_DIGEST__);
  const {AppRuntime} = await import('../src/modules/app/app-runtime');
  const app = new AppRuntime(directory, { remotePurchaseSandbox: true });
  if (limit) {
    try { app.setDailyLimit(limit); app.setPaused(false); console.log(JSON.stringify({directory,dailyLimit:limit,environment:'simulated'})); }
    finally { app.close(); } return;
  }
  const {handleRemoteReadMcp} = await import('../src/modules/remote/mcp');
  const {handleRemoteReadPairings} = await import('../src/modules/remote/management');
  let origin = '';
  // No generic App routing: this isolated entry cannot change mode, connect a
  // local signer or submit a buyer-supplied URL. The remote tunnel exposes only MCP.
  const server = httpServer({maxHeaderSize:12_288,requestTimeout:15_000,headersTimeout:10_000}, async (req, res) => {
    const send = (status: number) => { res.writeHead(status, {'cache-control':'no-store','connection':'close'}); res.end(); };
    const endpoint = req.url;
    if (!origin || req.headers.host !== new URL(origin).host) return send(403);
    if (!['/api/agent/remote-mcp', '/api/app/remote-read-pairings'].includes(endpoint ?? '')) return send(404);
    if (req.method !== 'POST' && !(endpoint === '/api/app/remote-read-pairings' && req.method === 'GET')) return send(405);
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        size += chunk.length; if (size > 8192) return send(413); chunks.push(chunk);
      }
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      const request = new Request(origin + endpoint, {method:req.method, headers, ...(req.method === 'POST' ? {body:Buffer.concat(chunks)} : {})});
      const reply = endpoint === '/api/agent/remote-mcp' ? await handleRemoteReadMcp(app, request) : await handleRemoteReadPairings(app, request);
      res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(Buffer.from(await reply.arrayBuffer()));
    } catch { send(400); }
  });
  server.maxConnections = 48;
  try {
    await new Promise<void>((ok, fail) => { server.once('error',fail); server.listen(port,'127.0.0.1',ok); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('REMOTE_PURCHASE_SANDBOX_LISTEN_FAILED');
    origin = 'http://127.0.0.1:' + address.port;
    await app.start(origin); console.log(JSON.stringify({origin,environment:'simulated'}));
    await new Promise<void>(done => { process.once('SIGTERM',done); process.once('SIGINT',done); });
  } finally {
    const stopped = new Promise<void>(done => server.close(() => done())); server.closeAllConnections();
    await stopped; await app.prepareQuit(); app.close();
  }
}
void main().catch(error => {
  const code = error instanceof Error && /^REMOTE_PURCHASE_[A-Z_]+$/.test(error.message) ? error.message : 'REMOTE_PURCHASE_SANDBOX_FAILED';
  console.error(code + '\n' + usage); process.exitCode = 1;
});
