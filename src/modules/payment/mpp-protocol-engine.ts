import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { SolanaPublicKeySchema } from '../resources/http-resource';
import { MppChallengeEchoSchema, MppChargeRequestSchema } from './mpp-contract';
import { MAINNET_USDC_MINT, DEVNET_USDC_MINT } from './payment-config';

const atomic = z.string().regex(/^[1-9]\d*$/).max(20).refine(value => BigInt(value) <= 18_446_744_073_709_551_615n);
export type MppChallengeEcho = z.infer<typeof MppChallengeEchoSchema>;
const parsedSchema = z.object({ ok: z.literal(true), header: z.string().max(24_576),
  challenge: MppChallengeEchoSchema, request: MppChargeRequestSchema }).strict();
export type MppChargeChallenge = Omit<z.infer<typeof parsedSchema>, 'ok'> & { expiresAt: number };
export type MppHostValidatedLifetime = Readonly<{ recentBlockhash: string; lastValidBlockHeight: string }>;
const preparedSchema = z.object({ ok: z.literal(true), transaction: z.string().max(1644),
  recentBlockhash: SolanaPublicKeySchema, lastValidBlockHeight: atomic }).strict();
const errorSchema = z.object({ ok: z.literal(false), error: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) }).strict();

/** Only the trusted backend calls this helper. It inherits no wallet, proxy,
 * configuration or environment credentials. Signed bytes use stdin, never argv. */
function invoke(binary: string, input: object): Promise<unknown> {
  if (!isAbsolute(binary)) throw new Error('MPP_PROTOCOL_ABSOLUTE_BINARY_REQUIRED');
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 65_536) throw new Error('MPP_PROTOCOL_INPUT_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { cwd: '/', env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('MPP_PROTOCOL_TIMEOUT')), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) finish(new Error('MPP_PROTOCOL_RESPONSE_TOO_LARGE'));
      else chunks.push(chunk);
    });
    child.on('error', () => finish(new Error('MPP_PROTOCOL_UNAVAILABLE')));
    child.on('close', code => {
      if (code !== 0) { finish(new Error('MPP_PROTOCOL_REJECTED')); return; }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const failure = errorSchema.safeParse(value);
        if (failure.success) finish(new Error(failure.data.error));
        else finish(undefined, value);
      } catch { finish(new Error('MPP_PROTOCOL_INVALID_RESPONSE')); }
    });
    child.stdin.on('error', () => finish(new Error('MPP_PROTOCOL_UNAVAILABLE')));
    child.stdin.end(serialized);
  });
}

export async function parseMppChallenge(binary: string, header: string): Promise<MppChargeChallenge> {
  const result = parsedSchema.parse(await invoke(binary, { operation: 'mpp_parse', header }));
  const parsed = { header: result.header, challenge: result.challenge, request: result.request };
  const expiresAt = Date.parse(parsed.challenge.expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 600_000) throw new Error('MPP_INVALID_EXPIRY');
  if (parsed.request.currency !== (parsed.request.methodDetails.network === 'mainnet' ? MAINNET_USDC_MINT : DEVNET_USDC_MINT)) {
    throw new Error('MPP_UNSUPPORTED_PAYMENT_TERMS');
  }
  return { ...parsed, expiresAt };
}

/** The host must verify genesis/network and lifetime through bounded RPC before
 * calling. The Rust SDK receives a transport that attests only this exact hash. */
export async function prepareMppCharge(binary: string, input: {
  challenge: MppChargeChallenge; payer: string; hostValidatedLifetime: MppHostValidatedLifetime;
}) {
  SolanaPublicKeySchema.parse(input.payer);
  const result = preparedSchema.parse(await invoke(binary, { operation: 'mpp_prepare', header: input.challenge.header,
    payer: input.payer, hostValidatedLifetime: input.hostValidatedLifetime }));
  if (result.recentBlockhash !== input.hostValidatedLifetime.recentBlockhash
    || result.lastValidBlockHeight !== input.hostValidatedLifetime.lastValidBlockHeight) throw new Error('MPP_INVALID_LIFETIME');
  return result;
}

/** Formatting only: the helper never signs, broadcasts or sends this credential. */
export async function encodeMppCredential(binary: string, input: { challenge: MppChargeChallenge; transaction: string }) {
  const result = z.object({ ok: z.literal(true), authorization: z.string().regex(/^Payment [A-Za-z0-9_-]+$/).max(24_576) }).strict()
    .parse(await invoke(binary, { operation: 'mpp_encode', header: input.challenge.header, transaction: input.transaction }));
  return result.authorization;
}

/** A merchant observation only; callers must reconcile their original transaction. */
export async function parseMppReceipt(binary: string, header: string) {
  return z.object({ ok: z.literal(true), receipt: z.object({ method: z.literal('solana'), status: z.literal('success'),
    timestamp: z.string().max(64), reference: z.string().min(1).max(128) }).strict() }).strict()
    .parse(await invoke(binary, { operation: 'mpp_receipt', header })).receipt;
}
