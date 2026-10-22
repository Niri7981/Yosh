import { MAX_LOCAL_REQUEST_BYTES } from '../http/request-size-limits';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { LocalRequestError, RequestBodyError, requireLocalRequest } from '../http/local-request';
import { DataDirectoryInUseError } from './data-directory-owner';
import { resolveYoshConfiguration, YoshConfigurationError } from './yosh-configuration';
import { PaymentEnvironmentError } from '../payment/payment-environment';
import { WalletKeychainError } from '../payment/keychain';

export class ManagementApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly safeMessage: string) { super(code); }
}

const clockWindowMs = 30_000;
const nonceLimit = 4096;
// Next may bundle this module into several routes. Share one process-local replay cache.
const globals = globalThis as typeof globalThis & { __yoshManagementNonces?: Map<string, number> };
const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const proof = (secret: string, message: string) => createHmac('sha256', secret).update(message).digest();

export function requireManagementRequest(request: Request, mutation = false) {
  requireLocalRequest(request, mutation);
  const secret = resolveYoshConfiguration().managementToken;
  // Existing native clients and stale-backend takeover use these v1 wire bytes.
  const timestamp = request.headers.get('x-2049-timestamp') ?? '';
  const nonce = request.headers.get('x-2049-nonce') ?? '';
  const bodyHash = request.headers.get('x-2049-body-sha256') ?? '';
  const signature = request.headers.get('x-2049-proof') ?? '';
  const now = Date.now();
  if (!secret || secret.length < 32 || !/^[0-9]{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > clockWindowMs
    || !/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodyHash) || !/^[a-f0-9]{64}$/.test(signature))
    throw new ManagementApiError('UNAUTHORIZED', 401, '未授权的管理请求。');
  const url = new URL(request.url);
  const message = ['2049-management-v1', request.method, url.pathname + url.search, timestamp, nonce, bodyHash].join('\n');
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), proof(secret, message)))
    throw new ManagementApiError('UNAUTHORIZED', 401, '未授权的管理请求。');
  const nonces = globals.__yoshManagementNonces ??= new Map();
  for (const [value, expires] of nonces) if (expires < now) nonces.delete(value);
  if (nonces.has(nonce)) throw new ManagementApiError('MANAGEMENT_REPLAY', 401, '管理请求已使用。');
  // Never evict a still-valid nonce to make room: that would permit replay.
  if (nonces.size >= nonceLimit) throw new ManagementApiError('MANAGEMENT_BUSY', 503, '管理请求过于频繁。');
  nonces.set(nonce, Number(timestamp) + clockWindowMs);
  return { nonce, bodyHash, secret };
}

/** Authenticate exact body bytes before handlers run; sign success and authenticated errors. */
export async function managementRoute(request: Request, mutation: boolean, handle: (request: Request) => Promise<Response>, maximumBytes = MAX_LOCAL_REQUEST_BYTES) {
  let identity: ReturnType<typeof requireManagementRequest> | undefined;
  let response: Response;
  try {
    identity = requireManagementRequest(request, mutation);
    const chunks: Uint8Array[] = [];
    const reader = request.body?.getReader();
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maximumBytes) throw new RequestBodyError('管理请求过长。');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const body = Buffer.concat(chunks);
    if (sha256(body) !== identity.bodyHash) throw new ManagementApiError('UNAUTHORIZED', 401, '管理请求内容不匹配。');
    const verified = new Request(request.url, { method: request.method, headers: request.headers,
      ...(request.body === null ? {} : { body }) });
    response = await handle(verified);
  } catch (error) { response = managementError(error); }
  if (!identity) return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  const message = ['2049-management-response-v1', identity.nonce, String(response.status), sha256(body)].join('\n');
  headers.set('x-2049-response-proof', proof(identity.secret, message).toString('hex'));
  headers.set('cache-control', 'no-store');
  return new Response(body, { status: response.status, headers });
}

export function managementError(error: unknown) {
  let failure: ManagementApiError;
  if (error instanceof ManagementApiError) failure = error;
  else if (error instanceof WalletKeychainError) failure = new ManagementApiError(error.code, 503,
    error.code === 'WALLET_KEYCHAIN_CORRUPT' ? '钱包钥匙串项异常，未创建或替换钱包，请先恢复原钱包。'
      : '无法访问钱包钥匙串，请在 macOS 提示中允许访问或解锁后重试。');
  else if (error instanceof LocalRequestError) failure = new ManagementApiError('LOCAL_REQUEST_FORBIDDEN', 403, '请求来源不被允许。');
  else if (error instanceof RequestBodyError || error instanceof ZodError)
    failure = new ManagementApiError('INVALID_REQUEST', 400, '请求内容无效。');
  else if (error instanceof DataDirectoryInUseError)
    failure = new ManagementApiError('DATA_DIRECTORY_IN_USE', 503, 'Yosh 数据已由另一服务使用。');
  else if (error instanceof YoshConfigurationError)
    failure = new ManagementApiError(error.code, 503, error.message);
  else if (error instanceof PaymentEnvironmentError)
    failure = new ManagementApiError(error.code, 503, error.message);
  else failure = new ManagementApiError('INTERNAL_ERROR', 500, '本地服务暂时无法完成请求。');
  return Response.json({ code: failure.code, error: failure.safeMessage }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
}
