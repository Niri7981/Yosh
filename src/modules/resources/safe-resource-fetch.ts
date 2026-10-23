import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isPublicResourceAddress } from './public-resource-address';
import { MAX_RESOURCE_DELIVERY_BYTES } from './http-resource';
const builtinFetch = globalThis.fetch;

/** Resolve before a payment submission marker, then start the pinned socket synchronously with that marker. */
export async function prepareSafeResourceFetch(url: string, init: RequestInit, fetcher?: typeof fetch): Promise<() => Promise<Response>> {
  // Injected transports are fixture-only. A production runtime cannot bypass
  // destination pinning by replacing global fetch or supplying a custom client.
  if (fetcher !== undefined || (process.env.NODE_ENV === 'test' && globalThis.fetch !== builtinFetch)) {
    if (process.env.NODE_ENV !== 'test') throw new Error('RESOURCE_DESTINATION_UNSAFE');
    return () => (fetcher ?? globalThis.fetch)(url, init);
  }
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.href !== url)
    throw new Error('RESOURCE_DESTINATION_UNSAFE');
  const signal = init.signal ?? AbortSignal.timeout(55_000);
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(new Error('RESOURCE_DESTINATION_UNAVAILABLE'));
    signal.addEventListener('abort', abort, { once: true });
    void lookup(target.hostname, { all: true, verbatim: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (signal.aborted || !addresses.length || addresses.some(item => !isPublicResourceAddress(item.address)))
    throw new Error('RESOURCE_DESTINATION_UNSAFE');
  const pinned = addresses[0];
  return () => new Promise<Response>((resolve, reject) => {
    const outbound = request(target, { method: init.method ?? 'GET', headers: init.headers as Record<string, string>, signal,
      maxHeaderSize: 16_384, lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
      } }, incoming => {
      const parts: Buffer[] = []; let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESOURCE_DELIVERY_BYTES) { incoming.destroy(new Error('RESOURCE_RESPONSE_TOO_LARGE')); return; }
        parts.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
        resolve(new Response(Buffer.concat(parts), { status: incoming.statusCode ?? 502, headers }));
      });
    });
    outbound.on('error', reject);
    if (typeof init.body === 'string') outbound.end(init.body); else outbound.end();
  });
}

/** One bounded, DNS-pinned HTTPS exchange. Redirects and mixed public/private DNS answers fail closed. */
export async function safeResourceFetch(url: string, init: RequestInit, fetcher?: typeof fetch): Promise<Response> {
  const submit = await prepareSafeResourceFetch(url, init, fetcher);
  return submit();
}
