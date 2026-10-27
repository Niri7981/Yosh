import type { PurchaseExecutionMode } from './payment-environment';

const reads = new Set(['getGenesisHash', 'getLatestBlockhash', 'getAccountInfo', 'getMultipleAccounts',
  'getBalance', 'getBlockHeight', 'getSignatureStatuses', 'getTransaction', 'isBlockhashValid', 'simulateTransaction']);

/** A rate-limited read cannot change financial state. Never retry submission,
 * transport failures or uncertain responses, and retain the caller's deadline. */
export async function fetchRpcRead(mode: PurchaseExecutionMode | undefined, method: string,
  fetcher: typeof fetch, url: string, init: RequestInit) {
  const retries = mode === 'live_devnet' && process.env.YOSH_PAY_MCP_DEVNET === '1' && reads.has(method) ? 2 : 0;
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    const response = await fetcher(url, init);
    if (response.status !== 429 || attempt === retries) return response;
    const seconds = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3000) : (attempt + 1) * 1000;
    await response.body?.cancel();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(init.signal?.reason ?? new Error('RPC_READ_ABORTED')); };
      const timer = setTimeout(() => { init.signal?.removeEventListener('abort', abort); resolve(); }, delay);
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) abort();
    });
  }
}
