import { createHash, randomBytes } from 'node:crypto';
import { ManagementApiError } from '../app/management-auth';
import { confirmNative } from '../authority/native-grant-confirmation';

let helper: { path: string; hash: string } | undefined;
let showing = false;

/** Called at startup only by a backend which has verified its packaged manifest. */
export function configureRemoteReadConfirmation(path: string, hash: string) {
  helper = { path, hash };
}
export async function confirmRemoteReadPairing(input: { label: string; scopes: readonly string[]; account: string; environment: string }): Promise<boolean> {
  return confirmRemoteAction('remote-read', input);
}
export async function confirmRemoteAction(kind: 'remote-read'|'remote-simulated-purchase', facts: object): Promise<boolean> {
  if (!helper) throw new ManagementApiError('REMOTE_READ_CONFIRMATION_UNAVAILABLE', 503, '当前运行版本没有可核验的本机确认组件。');
  if (showing) throw new ManagementApiError('REMOTE_READ_CONFIRMATION_BUSY', 409, '已有待确认的远程授权请求。');
  showing = true;
  try {
    const createdAt = Date.now();
    const request = { ...facts, version: 1, kind, challenge: randomBytes(32).toString('hex'), createdAt, expiresAt: createdAt + 120_000 };
    const bytes = JSON.stringify(request);
    await confirmNative(helper.path, helper.hash, bytes, createHash('sha256').update(bytes).digest('hex'), request);
    return true;
  } catch (error) {
    if (error instanceof Error && ['LOCAL_CONFIRMATION_DECLINED', 'LOCAL_CONFIRMATION_TIMED_OUT'].includes(error.message)) return false;
    throw new ManagementApiError('REMOTE_READ_CONFIRMATION_UNAVAILABLE', 503, '无法验证本机确认。');
  } finally { showing = false; }
}
