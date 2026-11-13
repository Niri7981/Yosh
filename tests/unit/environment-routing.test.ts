import { expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { combinedTools, routeTool } from '../../src/modules/mcp/environment-routing';
const tool: Tool = { name: 'curl', description: 'Purchase', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
it('exposes one tool per capability with an explicit environment', () => {
  const tools = combinedTools({ mainnet: [tool], devnet: [tool] });
  expect(tools).toHaveLength(1);
  expect(tools[0].inputSchema.required).toEqual(['url', 'environment']);
  expect(tools[0].inputSchema.properties?.environment).toMatchObject({ enum: ['devnet', 'mainnet'] });
});
it('routes only to the selected backend and strips the routing field', () => {
  expect(routeTool('curl', { environment: 'mainnet', url: 'https://merchant.example' }, { mainnet: [tool], devnet: [tool] }))
    .toEqual({ environment: 'mainnet', arguments: { url: 'https://merchant.example' } });
});
it('rejects absent, invalid, unavailable and unsupported routes without fallback', () => {
  for (const args of [{}, { environment: 'auto' }, { environment: 'mainnet' }])
    expect(() => routeTool('curl', args, { devnet: [tool] })).toThrow();
  expect(() => routeTool('arbitrary_sign', { environment: 'devnet' }, { devnet: [tool] })).toThrow();
  expect(combinedTools({ devnet: [tool] })[0].inputSchema.properties?.environment).toMatchObject({ enum: ['devnet'] });
});
