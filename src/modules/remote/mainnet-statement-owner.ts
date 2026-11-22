import { parseArgs } from 'node:util';
import { z } from 'zod';
import { pairingRequest, remoteReadToken } from './pairings';
import { saveNewPairingCredential } from './private-pairing-file';

const metadata = pairingRequest.extend({ id: z.uuid(), memberId: z.uuid(), scopes: z.tuple([z.literal('statement')]),
  environment: z.literal('live_mainnet'), createdAt: z.number().int(), revokedAt: z.number().int().nullable() });
const historicalPairing = z.object({ environment: z.string(), scopes: z.array(z.string()) }).passthrough();
const listResponse = z.object({
  pairings: z.array(historicalPairing).transform(pairings => pairings.filter(
    pairing => pairing.environment === 'live_mainnet' && pairing.scopes.length === 1 && pairing.scopes[0] === 'statement',
  )).pipe(z.array(metadata)),
});
const revoked = z.object({ revoked: z.literal(true) });
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('pair'), label: pairingRequest.shape.label, 'header-out': z.string().min(1) }).strict(),
  z.object({ action: z.literal('revoke'), id: z.uuid() }).strict(),
]);

/** This entry is part of the local verified owner binary; only the read credential goes to the tunnel runtime. */
export async function mainnetRemoteStatementCommand(args: string[], call: (body?: object) => Promise<unknown>) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    label: { type: 'string' }, 'header-out': { type: 'string' }, id: { type: 'string' },
  } });
  const [action] = z.tuple([z.string()]).parse(positionals);
  const input = command.parse({ action, ...values });
  async function request<T>(response: z.ZodType<T>, body?: object) {
    try { return response.parse(await (body ? call(body) : call())); }
    catch (error) {
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new Error('REMOTE_READ_OWNER_TIMED_OUT');
      if (error instanceof TypeError) throw new Error('REMOTE_READ_OWNER_CONNECTION_FAILED');
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new Error('REMOTE_READ_OWNER_RESPONSE_INVALID');
      throw error;
    }
  }
  if (input.action === 'list') return request(listResponse);
  if (input.action === 'revoke') return request(revoked, input);
  return saveNewPairingCredential(input['header-out'], async () => {
    const schema = metadata.extend({ token: z.string().regex(remoteReadToken), label: z.literal(input.label), revokedAt: z.null() });
    const { token, ...paired } = await request(schema, { action, label: input.label, scopes: ['statement'] });
    return { credential: 'Bearer ' + token, metadata: paired };
  }, async paired => { await request(revoked, { action: 'revoke', id: paired.id }); });
}
