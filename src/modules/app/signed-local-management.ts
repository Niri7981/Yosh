import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Both callers use the original standalone signed wire format. Authenticate the
 * reply before reading any metadata or accepting a newly issued credential. */
export async function signedLocalManagement(origin: string, secret: string, method: 'GET' | 'POST', path: string,
  body = '', options: { timeoutMs?: number; maximumBytes?: number; remoteReadErrors?: boolean } = {}): Promise<unknown> {
  const nonce = randomBytes(32).toString('hex'), timestamp = String(Date.now()), bodyHash = hash(body);
  const message = ['2049-management-v1', method, path, timestamp, nonce, bodyHash].join('\n');
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    headers: { 'content-type': 'application/json', origin,
      'x-2049-nonce': nonce, 'x-2049-timestamp': timestamp, 'x-2049-body-sha256': bodyHash,
      'x-2049-proof': createHmac('sha256', secret).update(message).digest('hex') }, ...(body ? { body } : {}) });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > (options.maximumBytes ?? 16384)) throw new Error('STANDALONE_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally { await reader?.cancel(); reader?.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const proof = response.headers.get('x-2049-response-proof') ?? '';
  const expected = createHmac('sha256', secret).update(['2049-management-response-v1', nonce, String(response.status), hash(bytes)].join('\n')).digest();
  if (!/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), expected)) throw new Error('STANDALONE_BACKEND_AUTH_FAILED');
  if (!response.ok) {
    if (options.remoteReadErrors) {
      const error = z.object({ code: z.string().regex(/^REMOTE_(?:READ|PURCHASE)_[A-Z_]+$/) }).safeParse(JSON.parse(bytes.toString('utf8')));
      if (error.success) throw new Error(error.data.code);
    }
    throw new Error('STANDALONE_BACKEND_NOT_READY');
  }
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
