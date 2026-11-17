import { IncomingMessage, type RequestOptions } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { mppFixture } from '../helpers/mpp-fixture';
import type { X402Resource } from '../../src/modules/resources/http-resource';
const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ request: transport.request }));
import { fetchMppResourceQuote } from '../../src/modules/payment/mpp-resource-charge';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('uses the guarded production HTTPS transport when no fixture fetcher is supplied', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const f = mppFixture();
  const resource: X402Resource = { paymentProtocol: 'mpp_solana_charge', resourceId: 'mpp-api', providerId: 'fixture',
    request: { method: 'GET', url: 'https://merchant.example/data', headers: {}, access: 'https' },
    network: f.config.network, mint: f.config.mint, decimals: 6, recipientSource: 'live_challenge', maximumAmount: f.quote.amount };
  transport.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  transport.request.mockImplementation((_url: URL, _options: RequestOptions, respond: (response: IncomingMessage) => void) => {
    const request = new PassThrough();
    request.on('finish', () => {
      const response = new IncomingMessage(new Socket()); response.statusCode = 503; response.headers = {};
      respond(response); response.push(null);
    });
    return request;
  });
  // A real unsuccessful merchant response must be reached, not mistaken for
  // an injected test transport before DNS/socket setup. No signer is involved.
  await expect(fetchMppResourceQuote(resource, f.config, '/unused/protocol')).rejects.toThrow('MPP_CHALLENGE_REQUIRED');
  expect(transport.lookup).toHaveBeenCalledOnce(); expect(transport.request).toHaveBeenCalledOnce();
});
