import { z } from 'zod';
import { MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES } from '../resources/http-resource';

const timestamp = z.number().int().nonnegative();
export const StatementInput = z.object({ agentId: z.uuid().optional(), from: timestamp.optional(), until: timestamp.optional(),
  before: z.uuid().optional(), limit: z.number().int().min(1).max(12).optional() }).strict();
export const ResultInput = z.object({ purchaseId: z.uuid(), offset: z.number().int().min(0).max(MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES).optional() }).strict();
export type StatementQuery = z.infer<typeof StatementInput>;
export type ResultQuery = z.infer<typeof ResultInput>;
export const accountTools = [
  { name: 'list_account_purchases', schema: StatementInput, description: 'Read the local account statement in the current wallet environment. Filter by agentId and UTC milliseconds [from, until). Pages are newest recorded first; pass nextBefore as before. Paid and reserved totals cover the entire filter. No spending permission required.' },
  { name: 'read_account_result', schema: ResultInput, description: 'Read a previously saved shareable result from this local account by its statement purchaseId. Decode base64 chunks in order using nextOffset. Reading does not refresh the data, call the merchant or pay.' },
] as const;
export function accountReadPath(name: string, args: unknown) {
  const statement = name === 'list_account_purchases';
  if (!statement && name !== 'read_account_result') throw new Error('ACCOUNT_READ_INPUT_INVALID');
  const values = statement ? StatementInput.parse(args) : ResultInput.parse(args);
  const query = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));
  return `/api/agent/account/${statement ? 'statement' : 'result'}?${query}`;
}
