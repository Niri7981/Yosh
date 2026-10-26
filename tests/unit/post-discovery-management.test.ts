import { afterEach, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { signedManagementRequest } from '../helpers/management-request';
import { POST as prepare } from '../../src/app/api/app/resources/prepare/route';
import { POST as discover } from '../../src/app/api/app/resources/discover/route';
import { POST as agentDiscover } from '../../src/app/api/agent/discovery/route';
import { discoverResource, prepareDiscovery } from '../../src/modules/resources/mainnet-resource-discovery';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from '../../src/modules/payment/payment-environment';

const state = vi.hoisted(() => ({ fetch: vi.fn(), discover: vi.fn() }));
vi.mock('../../src/modules/resources/safe-resource-fetch', () => ({ safeResourceFetch: state.fetch }));
vi.mock('../../src/modules/app/app-runtime', () => ({ appRuntime: () => ({ authenticateAgent: () => ({ cardMemberId: 'fixture' }), discoverAgentResource: state.discover,
  prepareResourceDiscovery: (raw: unknown) => prepareDiscovery(raw).review,
  discoverResource: (raw: unknown, approval?: string) => discoverResource(raw, undefined, approval) }) }));
const origin = 'http://127.0.0.1:3049', secret = 'fixture-post-discovery-management-secret';
const input = { url: 'https://unknown.example/compute', method: 'POST',
  body: '{"mode":"fixed"}', requestInputs: { jsonBody: { prompt: { type: 'string', required: true, maxLength: 20 } } },
  sample: { jsonBody: { prompt: 'sample' } } };
const request = (path: string, body: unknown) => signedManagementRequest(`${origin}/api/app/resources/${path}`, secret,
  { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('only signed management approval can send the exact prepared POST; discovery does not grant spend authority', async () => {
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', secret);
  state.discover.mockImplementation(raw => discoverResource(raw));
  state.fetch.mockImplementation(async () => new Response(null, { status: 402, headers: {
    'payment-required': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: input.url }, accepts: [{
      scheme: 'exact', network: MAINNET_NETWORK, asset: MAINNET_USDC_MINT, amount: '1000',
      payTo: '11111111111111111111111111111111', maxTimeoutSeconds: 300,
      extra: { feePayer: 'ComputeBudget111111111111111111111111111111' },
    }] }),
  } }));
  const preview = await prepare(request('prepare', { kind: 'discovery', discovery: input }));
  expect(preview.status).toBe(200);
  const review = await preview.json();
  expect(review.request.body).toBe('{"mode":"fixed","prompt":"sample"}');
  expect(state.fetch).not.toHaveBeenCalled();
  expect((await discover(request('discover', input))).status).toBe(409);
  expect((await discover(request('discover', { ...input, sample: { jsonBody: { prompt: 'changed' } }, postApprovalHash: review.requestHash }))).status).toBe(409);
  const agent = (body: unknown) => new Request(`${origin}/api/agent/discovery`, { method: 'POST',
    headers: { authorization: 'Bearer fixture', host: '127.0.0.1:3049', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await agentDiscover(agent(input))).status).toBe(409);
  expect((await agentDiscover(agent({ ...input, postApprovalHash: review.requestHash }))).status).toBe(422);
  expect((await discover(agent({ ...input, postApprovalHash: review.requestHash }))).status).toBe(403);
  expect(state.fetch).not.toHaveBeenCalled();
  const approvedRequest = request('discover', { ...input, postApprovalHash: review.requestHash });
  const result = await discover(approvedRequest.clone());
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ paymentSent: false, authoritativeAtPurchase: false });
  expect(state.fetch).toHaveBeenCalledOnce();
  expect(state.fetch.mock.calls[0]).toMatchObject([input.url, { method: 'POST', body: review.request.body, redirect: 'error' }]);
  expect((await discover(approvedRequest)).status).toBe(401);
  expect(state.fetch).toHaveBeenCalledOnce();
});
