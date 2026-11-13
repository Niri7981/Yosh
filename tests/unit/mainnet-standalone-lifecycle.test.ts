import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signedManagementRequest } from '../helpers/management-request';
import { POST } from '../../src/app/api/app/mainnet-standalone-lifecycle/route';

type Runtime = { prepareQuit: () => Promise<void>; healthStatus: () => {
  hosting?: { kind: 'mainnet-standalone'; runtimeDigest: string };
} };
const state = vi.hoisted((): { backend?: Runtime } => ({}));
vi.mock('../../src/modules/app/app-runtime', () => ({ existingAppRuntime: () => state.backend }));
const digest = 'a'.repeat(64), secret = 'fixture-mainnet-stop-secret-'.repeat(2);
const url = 'http://127.0.0.1:3049/api/app/mainnet-standalone-lifecycle';
const input = () => ({ action: 'shutdown', pid: process.pid, runtimeDigest: digest });
function request(body: unknown = input()) {
  return signedManagementRequest(url, secret, { method: 'POST', headers: {
    origin: new URL(url).origin, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
function backend() {
  const prepareQuit = vi.fn(async () => {});
  const value = { prepareQuit, healthStatus: () => ({ hosting: { kind: 'mainnet-standalone' as const, runtimeDigest: digest } }) };
  state.backend = value; return value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret); vi.stubEnv('APP2049_MANAGEMENT_TOKEN', undefined);
  vi.stubEnv('YOSH_PORT', '3049'); vi.stubEnv('APP2049_PORT', undefined);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  state.backend = undefined;
  const globals = globalThis as typeof globalThis & { __yoshManagementNonces?: Map<string, number> };
  globals.__yoshManagementNonces?.clear();
});

it('rejects an unauthenticated or malformed shutdown without draining or signaling', async () => {
  const app = backend();
  expect((await POST(new Request(url, { method: 'POST', headers: { origin: new URL(url).origin,
    host: new URL(url).host, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
  expect((await POST(request({ ...input(), approved: true }))).status).toBe(400);
  expect((await POST(request({ ...input(), pid: 0 }))).status).toBe(400);
  await vi.advanceTimersByTimeAsync(1000);
  expect(app.prepareQuit).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
});

it('refuses a missing or replaced owner and the original App even with valid management authentication', async () => {
  const missing = await POST(request());
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ code: 'MAINNET_STANDALONE_OWNER_MISMATCH' });
  const app = backend();
  for (const body of [{ ...input(), pid: process.pid + 1 }, { ...input(), runtimeDigest: 'b'.repeat(64) }]) {
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MAINNET_STANDALONE_OWNER_MISMATCH' });
  }
  state.backend = { prepareQuit: app.prepareQuit, healthStatus: () => ({}) };
  const original = await POST(request());
  expect(original.status).toBe(403);
  expect(await original.json()).toMatchObject({ code: 'MAINNET_STANDALONE_LIFECYCLE_FORBIDDEN' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(app.prepareQuit).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
});

it('drains the matching owner before acknowledging and schedules its signal only after the response flush delay', async () => {
  const app = backend();
  let release!: () => void, entered!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.prepareQuit.mockImplementation(async () => { entered(); await draining; });
  const response = POST(request()); await started;
  await vi.advanceTimersByTimeAsync(1000); expect(process.kill).not.toHaveBeenCalled();
  release();
  const acknowledged = await response;
  expect(acknowledged.status).toBe(200); expect(await acknowledged.json()).toEqual({ ready: true });
  expect(acknowledged.headers.get('x-2049-response-proof')).toMatch(/^[a-f0-9]{64}$/);
  await vi.advanceTimersByTimeAsync(249); expect(process.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGTERM');
});

it('never signals an owner whose payment drain fails', async () => {
  const app = backend(); app.prepareQuit.mockRejectedValue(new Error('fixture drain unavailable'));
  expect((await POST(request())).status).toBe(500);
  await vi.advanceTimersByTimeAsync(1000); expect(process.kill).not.toHaveBeenCalled();
});
