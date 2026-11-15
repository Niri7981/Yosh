/* Synthetic review only. Never forwards Grant, wallet or payment mutations. */
const originalFetch = window.fetch.bind(window);
window.fetch = async (path, options) => {
  if (path === '/requests') {
    const values = JSON.parse(options.body);
    const atomic = value => {
      const [whole, fraction = ''] = value.split('.');
      return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))).toString();
    };
    const mainnet = options.headers['x-yosh-environment'] !== 'devnet';
    return new Response(JSON.stringify({ digest: 'DESIGN-PREVIEW', request: {
      id: 'preview-only', agentLabel: 'Codex · 示例',
      apiLabel: ({ 'demo-prices': 'Market snapshot · 示例 API', 'demo-search': 'Web research · 示例 API' }[values.resourceId] || '示例 API'),
      binding: {
        input: { totalLimit: atomic(values.total), singleLimit: atomic(values.single), expiresAt: Date.now() + values.hours * 3600000 },
        scope: { network: (mainnet ? 'Solana Mainnet' : 'Solana Devnet') + ' · 示例', assetId: (mainnet ? 'USDC' : 'Test USDC') + ' · 示例', payTo: '示例收款方，不可付款' },
      },
    } }), { headers: { 'content-type': 'application/json' } });
  }
  if (path === '/cancel') return new Response(JSON.stringify({ state: 'CANCELLED' }));
  if (path === '/session' || path === '/state') return originalFetch(path, options);
  throw new Error('DESIGN_PREVIEW_ONLY_NO_CHANGES');
};
