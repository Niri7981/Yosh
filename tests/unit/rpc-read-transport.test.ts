import { afterEach, expect, it, vi } from 'vitest';
import { fetchRpcRead } from '../../src/modules/payment/rpc-read-transport';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it('honors bounded 429 backoff for a live Devnet read', async () => {
  vi.useFakeTimers(); vi.stubEnv('YOSH_PAY_MCP_DEVNET', '1');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 429,
    headers: { 'retry-after': '1' } })).mockResolvedValueOnce(Response.json({ result: 'blockhash' }));
  const pending = fetchRpcRead('live_devnet', 'getLatestBlockhash', fetcher, 'https://rpc.example/', {});
  await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect((await pending).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['live_mainnet', 'simulated'] as const)('preserves the existing single request for %s', async mode => {
  vi.stubEnv('YOSH_PAY_MCP_DEVNET', '1');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  expect((await fetchRpcRead(mode, 'getGenesisHash', fetcher, 'https://rpc.example/', {})).status).toBe(429);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('never retries transaction submission, including on Devnet', async () => {
  vi.stubEnv('YOSH_PAY_MCP_DEVNET', '1');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  expect((await fetchRpcRead('live_devnet', 'sendTransaction', fetcher, 'https://rpc.example/', {})).status).toBe(429);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('caps repeated rate limits and observes cancellation during backoff', async () => {
  vi.useFakeTimers(); vi.stubEnv('YOSH_PAY_MCP_DEVNET', '1');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429 }));
  const pending = fetchRpcRead('live_devnet', 'getGenesisHash', fetcher, 'https://rpc.example/', {});
  await vi.runAllTimersAsync(); expect((await pending).status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(3);
  const abort = new AbortController();
  const cancelled = fetchRpcRead('live_devnet', 'getGenesisHash', fetcher, 'https://rpc.example/', { signal: abort.signal });
  const rejected = expect(cancelled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1); abort.abort(); await rejected;
  expect(fetcher).toHaveBeenCalledTimes(4);
});
