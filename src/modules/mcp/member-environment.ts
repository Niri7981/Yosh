import { z } from 'zod';

/** Carry only the selected member across a subprocess boundary. Bearer tokens
 * stay in the backend's existing per-member descriptor. Never substitute the default for an invalid explicit ID. */
export function mcpMemberEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const current = env.YOSH_CARD_MEMBER_ID, legacy = env.APP2049_CARD_MEMBER_ID;
  if (current !== undefined && legacy !== undefined && current !== legacy) throw new Error('PAY_CALLER_CONFIGURATION_CONFLICT');
  const id = current ?? legacy;
  return id === undefined ? {} : { YOSH_CARD_MEMBER_ID: z.uuid().parse(id) };
}
