import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The simulator ships without Pay, RPC programs, a signer, or a private key. Only the
// system consent helper is a separate executable; pin its final bytes in the backend.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'build.noindex/remote-purchase-sandbox');
mkdirSync(out, { recursive: true });
const helper = join(out, 'yosh-confirm');
execFileSync('/usr/bin/swiftc', ['-parse-as-library', join(root, 'scripts/native/LocalGrantConfirmation.swift'), '-o', helper]);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'com.yosh.remote-sandbox.confirm', helper]);
await build({ absWorkingDir: root, entryPoints: ['scripts/remote-purchase-sandbox.ts'], outfile: join(out, 'sandbox.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  define: { __YOSH_P2_CONFIRM_DIGEST__: JSON.stringify(createHash('sha256').update(readFileSync(helper)).digest('hex')) } });
console.log('Built isolated Mac purchase simulator in build.noindex/remote-purchase-sandbox');
