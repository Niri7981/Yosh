/** Mac owner CLI. The cloud host never installs this or receives a management credential. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { signedLocalManagement } from '../src/modules/app/signed-local-management';

const path = '/api/app/remote-read-pairings';
const usage = 'remote-read-owner <pair|list|revoke|grant|revoke-grant> --data-dir <standalone control directory> [--backend-port 17449]\n  pair --label <agent> --scope <statement|result|statement,result|purchase> --token-out <new private file>\n  revoke --id <pairing UUID>\n  grant --id <purchase pairing UUID> --resource market-snapshot --total <atomic> --single <atomic> --expires-at <epoch ms>\n  revoke-grant --id <purchase pairing UUID> --grant-id <grant UUID>';
function privateDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || !stat.isDirectory() ||
    stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('REMOTE_READ_PRIVATE_DIRECTORY_REQUIRED');
}
function ownerSecret(directory: string) {
  privateDirectory(directory);
  const fd = openSync(join(directory, 'standalone-control.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384)
      throw new Error('REMOTE_READ_CONTROL_REJECTED');
    return z.intersection(z.object({ managementSecret: z.string().regex(/^[a-f0-9]{64}$/) }), z.union([
      z.object({ profile: z.literal('com.yosh.local-authorization-dev'), environment: z.literal('devnet') }),
      z.object({ profile: z.literal('yosh-remote-purchase-sandbox'), environment: z.literal('simulated') }),
    ])).parse(JSON.parse(readFileSync(fd, 'utf8'))).managementSecret;
  } finally { closeSync(fd); }
}
const id = z.uuid(), scopes = z.union([z.tuple([z.literal('purchase')]), z.array(z.enum(['statement', 'result'])).min(1).max(2).refine(v => new Set(v).size === v.length)]);
const meta = z.object({ id, memberId: id, label: z.string(), scopes, environment: z.string(), createdAt: z.number(), revokedAt: z.number().nullable() });
async function main() {
  if (process.argv.includes('--help')) { console.log(usage); return; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, 'backend-port': { type: 'string', default: '17449' }, label: { type: 'string' },
    scope: { type: 'string' }, resource: { type: 'string' }, total: { type: 'string' }, single: { type: 'string' },
    'expires-at': { type: 'string' }, 'grant-id': { type: 'string' }, 'token-out': { type: 'string' }, id: { type: 'string' },
  } });
  const [action] = z.tuple([z.enum(['pair', 'list', 'revoke', 'grant', 'revoke-grant'])]).parse(positionals);
  const port = z.coerce.number().int().min(1).max(65535).parse(values['backend-port']);
  const secret = ownerSecret(z.string().min(1).parse(values['data-dir']));
  const call = (body?: object) => signedLocalManagement('http://127.0.0.1:' + port, secret, body ? 'POST' : 'GET', path,
    body ? JSON.stringify(body) : '', { timeoutMs: body && (action === 'pair' || action === 'grant') ? 130_000 : 10_000, maximumBytes: 256 * 1024, remoteReadErrors: true });
  if (action === 'list') { console.log(JSON.stringify(z.object({ pairings: z.array(meta) }).parse(await call()))); return; }
  if (action === 'revoke') {
    console.log(JSON.stringify(z.object({ revoked: z.literal(true) }).parse(await call({ action, id: id.parse(values.id) })))); return;
  }
  if (action === 'grant') {
    const amount = z.string().regex(/^[1-9][0-9]{0,17}$/), resourceId = z.literal('market-snapshot').parse(values.resource);
    const response = await call({ action, id: id.parse(values.id), resourceId, totalLimit: amount.parse(values.total),
      singleLimit: amount.parse(values.single), expiresAt: z.coerce.number().int().positive().safe().parse(values['expires-at']) });
    console.log(JSON.stringify(z.object({ grantId: id, totalLimit: amount, singleLimit: amount, expiresAt: z.number(), resourceId: z.literal('market-snapshot') }).parse(response)));
    return;
  }
  if (action === 'revoke-grant') {
    console.log(JSON.stringify(z.object({ revoked: z.literal(true) }).parse(await call({ action: 'revoke_grant', id: id.parse(values.id), grantId: id.parse(values['grant-id']) }))));
    return;
  }
  const selected = scopes.parse(values.scope?.split(','));
  const label = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u).parse(values.label);
  const file = z.string().min(1).parse(values['token-out']); privateDirectory(dirname(file));
  // Reserve a new 0600 file before requesting consent. Never write a bearer to stdout or into shell history.
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let saved = false;
  try {
    const paired = meta.extend({ token: z.string().regex(selected[0] === 'purchase' ? /^yrp1_[A-Za-z0-9_-]{43}$/ : /^yrr1_[A-Za-z0-9_-]{43}$/) }).parse(await call({ action, label, scopes: selected }));
    writeFileSync(fd, paired.token, 'utf8'); fsyncSync(fd); saved = true;
    console.log(JSON.stringify(meta.parse(paired)));
  } finally { closeSync(fd); if (!saved) unlinkSync(file); }
}
main().catch(error => {
  const code = error instanceof Error && /^(REMOTE_READ_|REMOTE_PURCHASE_|STANDALONE_)[A-Z_]+$/.test(error.message) ? error.message : 'REMOTE_READ_OWNER_COMMAND_FAILED';
  console.error(code + '\nIf pairing was interrupted, list pairings and revoke the unused one before retrying. Use --help for usage.');
  process.exitCode = 1;
});
