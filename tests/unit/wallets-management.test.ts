import { afterEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../../src/app/api/app/wallets/route';
import { appRuntime } from '../../src/modules/app/app-runtime';
import { signedManagementRequest } from '../helpers/management-request';

const { existingWallets, walletLibrary, addLibraryWallet, execution } = vi.hoisted(() => ({ existingWallets: vi.fn(), walletLibrary: vi.fn(() => []), addLibraryWallet: vi.fn(), execution: vi.fn(() => ({ mode: 'simulated' })) }));
vi.mock('../../src/modules/app/app-runtime', () => ({ appRuntime: vi.fn(() => ({ existingWallets, walletLibrary, addLibraryWallet, execution })) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const url = 'http://127.0.0.1:3049/api/app/wallets';
const token = 'wallets-management-fixture-'.repeat(2);

it('rejects unauthenticated inventory requests before accessing wallets', async () => {
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  expect((await GET(new Request(url, { headers: { host: '127.0.0.1:3049' } }))).status).toBe(401);
  expect(appRuntime).not.toHaveBeenCalled();
});

it('returns only public inventory through the authenticated read-only management endpoint', async () => {
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  const wallets = [{ id: 'mainnet', label: 'Mainnet', address: null, status: 'missing' }];
  existingWallets.mockResolvedValue(wallets);
  const request = signedManagementRequest(url, token);
  const response = await GET(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('x-2049-response-proof')).toBe(true);
  expect(await response.json()).toEqual({ wallets, library: [], executionMode: 'simulated' });
  expect(existingWallets).toHaveBeenCalledTimes(1);
  expect((await GET(signedManagementRequest(url, token, {}, Number(request.headers.get('x-2049-timestamp')),
    request.headers.get('x-2049-nonce')!))).status).toBe(401);
  expect(existingWallets).toHaveBeenCalledTimes(1);
});

it('requires management authentication, exact-body integrity and fresh proof for wallet writes', async () => {
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  const input = { requestId: '77777777-7777-4777-8777-777777777777', label: 'Observer', kind: 'watch', address: '11111111111111111111111111111111' };
  const init = { method: 'POST', headers: { origin: 'http://127.0.0.1:3049', 'content-type': 'application/json' }, body: JSON.stringify(input) };
  expect((await POST(new Request(url, { ...init, headers: { ...init.headers, host: '127.0.0.1:3049' } }))).status).toBe(401);
  expect(addLibraryWallet).not.toHaveBeenCalled();
  addLibraryWallet.mockResolvedValue({ id: input.requestId, address: input.address, kind: 'watch', status: 'saved' });
  const request = signedManagementRequest(url, token, init);
  expect((await POST(request)).status).toBe(201);
  expect(addLibraryWallet).toHaveBeenCalledExactlyOnceWith(input);
  expect((await POST(signedManagementRequest(url, token, init, Number(request.headers.get('x-2049-timestamp')), request.headers.get('x-2049-nonce')!))).status).toBe(401);
  expect(addLibraryWallet).toHaveBeenCalledTimes(1);
  const altered = signedManagementRequest(url, token, { ...init, body: JSON.stringify({ ...input, approved: true }) });
  expect((await POST(altered)).status).toBe(400);
  expect(addLibraryWallet).toHaveBeenCalledTimes(1);
});
