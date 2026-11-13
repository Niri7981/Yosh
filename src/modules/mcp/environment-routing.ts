import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export type YoshToolEnvironment = 'mainnet' | 'devnet';
export type EnvironmentTools = Partial<Record<YoshToolEnvironment, Tool[]>>;

/** Each call names its environment; UI selection cannot redirect another
 * concurrent agent request, and an unavailable network never falls back. */
export function combinedTools(inventory: EnvironmentTools): Tool[] {
  const names = new Set(Object.values(inventory).flatMap(tools => tools.map(tool => tool.name)));
  return [...names].map(name => {
    const environments = (['devnet', 'mainnet'] as const).filter(env => inventory[env]?.some(tool => tool.name === name));
    const tool = inventory.mainnet?.find(tool => tool.name === name) ?? inventory.devnet!.find(tool => tool.name === name)!;
    return { ...tool, description: `${tool.description ?? ''}\nSelect environment explicitly: mainnet uses the original real-funds wallet; devnet uses isolated test funds. Never retry on the other network.`,
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        environment: { type: 'string', enum: environments, description: 'Required wallet/network for this call. mainnet is real funds; devnet is test funds.' } },
        required: [...new Set([...(tool.inputSchema.required ?? []), 'environment'])] } };
  });
}
export function routeTool(name: string, raw: unknown, inventory: EnvironmentTools) {
  const { environment, ...args } = z.object({ environment: z.enum(['mainnet', 'devnet']) }).passthrough().parse(raw);
  if (!inventory[environment]?.some(tool => tool.name === name)) throw new Error('LOCAL_ENVIRONMENT_TOOL_UNAVAILABLE');
  return { environment, arguments: args };
}
