import { LocalHostPurchaseOwnerInput, LocalHostPurchasePlan } from '../mcp/local-host-purchase';
import { PurchaseResourceContract, PurchaseResourceLookup } from '../mcp/purchase-resource-contract';
import { StatementRegistration } from './local-statement-pairing';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { z } from 'zod';

export type MainnetAuthorizationCall = (sessionHash: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
const authorizationError = /^(?:LOCAL_[A-Z0-9_]+|MPP_NETWORK_FEE_CONSENT_REQUIRED)$/;
const origin = 'http://127.0.0.1:13449';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function privateText(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384)
      throw new Error('LOCAL_MAINNET_IDENTITY_UNAVAILABLE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** Attach to the original backend. Never start it, switch environments, copy
 * wallet data or pass its management credential to the browser/MCP. */
async function callOwner(path: '/api/app/local-grants' | '/api/app/local-statement-pairing' | '/api/app/local-host-purchase' | '/api/app/local-host-resource', bodyFor: (memberId: string) => string, timeout: number) {
  try {
    const root = join(userInfo().homedir, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5');
    const directory = join(root, 'Mainnet');
    for (const dir of [root, directory]) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || realpathSync(dir) !== dir || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw new Error('LOCAL_MAINNET_IDENTITY_UNAVAILABLE');
    }
    z.object({ version: z.literal(1), environment: z.literal('mainnet') }).parse(JSON.parse(privateText(join(root, 'development-environment.json'))));
    const manifest = z.object({ version: z.literal(1), profile: z.literal('pay-mcp-mainnet'), origin: z.literal(origin), memberId: z.uuid() })
      .parse(JSON.parse(privateText(join(directory, 'pay-mainnet-runtime.json'))));
    const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(privateText(join(directory, 'management-token')).trim());
    const body = bodyFor(manifest.memberId);
    const nonce = randomBytes(32).toString('hex'), timestamp = String(Date.now());
    const proof = createHmac('sha256', secret).update(['2049-management-v1', 'POST', path, timestamp, nonce, hash(body)].join('\n')).digest('hex');
    const response = await fetch(origin + path, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { origin, 'content-type': 'application/json', 'x-2049-nonce': nonce, 'x-2049-timestamp': timestamp,
        'x-2049-body-sha256': hash(body), 'x-2049-proof': proof } });
    const chunks: Uint8Array[] = []; let size = 0;
    const maxBytes = path === '/api/app/local-host-resource' ? 1_048_576 : 262144;
    const reader = response.body?.getReader();
    try {
      if (reader) for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > maxBytes) throw new Error('LOCAL_MAINNET_RESPONSE_INVALID');
        chunks.push(part.value);
      }
    } finally { await reader?.cancel(); reader?.releaseLock(); }
    const bytes = Buffer.concat(chunks), signature = response.headers.get('x-2049-response-proof') ?? '';
    const expected = createHmac('sha256', secret).update(['2049-management-response-v1', nonce, String(response.status), hash(bytes)].join('\n')).digest();
    if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), expected))
      throw new Error('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
    const result: unknown = JSON.parse(bytes.toString('utf8'));
    if (!response.ok) {
      const error = z.object({ code: z.string().regex(authorizationError) }).safeParse(result);
      if (error.success) throw new Error(error.data.code);
      if (path === '/api/app/local-host-resource') throw new Error('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
      if (path === '/api/app/local-host-purchase') throw new Error('LOCAL_PURCHASE_OWNER_REJECTED');
      throw new Error('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
    }
    return result;
  } catch (error) {
    if (error instanceof Error && authorizationError.test(error.message)) throw error;
    throw new Error('LOCAL_MAINNET_BACKEND_UNAVAILABLE');
  }
}

export const callMainnetAuthorization: MainnetAuthorizationCall = (sessionHash, input) =>
  callOwner('/api/app/local-grants', memberId => JSON.stringify({ ...input, memberId, sessionHash }), 30_000);

/** Called only in the trusted launcher process after checking the installed backend. */
export async function pairLocalStatementHost(hostId: string, label: string) {
  const registration = StatementRegistration.parse({ hostId, label });
  const result = await callOwner('/api/app/local-statement-pairing', () => JSON.stringify(registration), 130_000);
  return z.object({ memberId: z.uuid() }).strict().parse(result);
}

export async function authorizeLocalHostPurchase(hostId: string, label: string, input: z.infer<typeof LocalHostPurchaseOwnerInput>) {
  const registration = StatementRegistration.parse({ hostId, label });
  const purchase = LocalHostPurchaseOwnerInput.parse(input);
  const result = await callOwner('/api/app/local-host-purchase', () => JSON.stringify({ ...registration, ...purchase }), 300_000);
  return LocalHostPurchasePlan.parse(result);
}

export async function describeLocalHostResource(hostId: string, label: string, input: z.infer<typeof PurchaseResourceLookup>) {
  const registration = StatementRegistration.parse({ hostId, label });
  const lookup = PurchaseResourceLookup.parse(input);
  const result = await callOwner('/api/app/local-host-resource', () => JSON.stringify({...registration, ...lookup}), 30_000);
  const contract = PurchaseResourceContract.safeParse(result);
  if (!contract.success || contract.data.resourceId !== lookup.resourceId) throw new Error('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
  return contract.data;
}
