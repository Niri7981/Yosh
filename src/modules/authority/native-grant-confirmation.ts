import { localControlBytes, localControlDigest, type FrozenLocalControl } from './local-control-approval';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { localGrantBytes, localGrantDigest, type FrozenLocalGrant } from './local-grant-approval';

export type ConfirmLocalGrant = (request: FrozenLocalGrant) => Promise<void>;
export function confirmationMessage(digest: string, challenge: string) {
  return ['yosh-local-grant-confirmation-v1', digest, challenge].join('\n');
}

/** A per-invocation secret lives only in backend/native process memory and
 * inherited pipes. No approval secret in URL, browser, argv, env or disk.
 * Executing another copy of the helper cannot mint proof for this invocation.
 * This assumes trusted program bytes/OS, not a compromised system account. */
export function nativeGrantConfirmation(binary: string, expectedHash: string): ConfirmLocalGrant {
  return request => confirmNative(binary, expectedHash, localGrantBytes(request), localGrantDigest(request), request);
}
export type ConfirmLocalControl = (request: FrozenLocalControl) => Promise<void>;
export function nativeControlConfirmation(binary: string, expectedHash: string): ConfirmLocalControl {
  return request => confirmNative(binary, expectedHash, localControlBytes(request), localControlDigest(request), request);
}
async function confirmNative(binary: string, expectedHash: string, bytes: string, digest: string,
  request: { challenge: string; expiresAt: number }) {
    const file = lstatSync(binary);
    if (!file.isFile() || file.isSymbolicLink() || realpathSync(binary) !== binary
      || createHash('sha256').update(readFileSync(binary)).digest('hex') !== expectedHash)
      throw new Error('LOCAL_CONFIRMATION_COMPONENT_CHANGED');
    const secret = randomBytes(32);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NODE_ENV: 'production' } });
        let result = '', failed = false;
        const fail = (code: string) => { failed = true; child.kill('SIGTERM'); reject(new Error(code)); };
        const timer = setTimeout(() => fail('LOCAL_CONFIRMATION_TIMED_OUT'), 120_000);
        child.stdout.on('data', chunk => {
          result += String(chunk);
          if (Buffer.byteLength(result) > 1024) fail('LOCAL_CONFIRMATION_RESPONSE_INVALID');
        });
        child.stderr.resume(); // Never expose native/OS diagnostic objects.
        child.once('error', () => { clearTimeout(timer); fail('LOCAL_CONFIRMATION_UNAVAILABLE'); });
        child.stdin.on('error', () => {});
        child.once('close', code => {
          clearTimeout(timer);
          if (!failed) {
            if (code === 0) resolve(result);
            else reject(new Error('LOCAL_CONFIRMATION_DECLINED'));
          }
        });
        child.stdin.end(JSON.stringify({ body: bytes, digest, key: secret.toString('hex') }));
      });
      const proof = z.object({ digest: z.literal(digest), proof: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict().parse(JSON.parse(output));
      const expected = createHmac('sha256', secret).update(confirmationMessage(digest, request.challenge)).digest();
      if (!timingSafeEqual(expected, Buffer.from(proof.proof, 'hex'))) throw new Error('LOCAL_CONFIRMATION_PROOF_INVALID');
      if (Date.now() >= request.expiresAt) throw new Error('LOCAL_AUTHORIZATION_EXPIRED');
    } finally { secret.fill(0); }
}
