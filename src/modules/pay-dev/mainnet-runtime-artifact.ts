import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Manifest = z.object({ kind: z.literal('yosh-mainnet-standalone'), apiVersion: z.literal(1),
  dataContract: z.literal('existing-mainnet-v1'), profile: z.literal('com.yosh.pay-development.v011rc5'),
  productionEnabled: z.literal(false), files: z.object({ node: Digest, 'mainnet.cjs': Digest,
    'mainnet-mcp.cjs': Digest, 'pay-mcp': Digest, 'pay-protocol-engine': Digest, 'mainnet.sb': Digest }).strict(),
  licenses: z.object({ 'Node-LICENSE': Digest, 'Pay-LICENSE': Digest, 'pay-kit-LICENSE': Digest }).strict() }).passthrough();
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function programFile(path: string, limit = 256 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > limit)
    throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
  return readFileSync(path);
}
function directory(path: string, privateMode = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)
    || stat.uid !== process.getuid?.() || (stat.mode & (privateMode ? 0o077 : 0o022)))
    throw new Error('MAINNET_RUNTIME_DIRECTORY_INVALID');
}

/** Verify the complete Mainnet subset; the Dev bundle is never an execution dependency. */
export function verifyMainnetRuntime(runtime: string) {
  try {
    directory(runtime);
    const bytes = programFile(join(runtime, 'mainnet-manifest.json'), 65_536);
    const manifest = Manifest.parse(JSON.parse(bytes.toString('utf8')));
    for (const [name, expected] of Object.entries(manifest.files))
      if (hash(programFile(join(runtime, name))) !== expected) throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
    directory(join(runtime, 'licenses'));
    for (const [name, expected] of Object.entries(manifest.licenses))
      if (hash(programFile(join(runtime, 'licenses', name), 1_048_576)) !== expected) throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
    return { manifest, digest: hash(bytes) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MAINNET_RUNTIME_')) throw error;
    throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
  }
}

/** Install immutable program bytes away from disposable plugin caches and the ledger. */
export function installMainnetRuntime(source: string, originalDataRoot: string) {
  const { manifest, digest } = verifyMainnetRuntime(source);
  const root = join(dirname(originalDataRoot), 'Yosh Mainnet Runtime');
  mkdirSync(root, { recursive: true, mode: 0o700 }); directory(root, true);
  const installed = join(root, digest);
  const verify = () => {
    directory(installed, true);
    if (verifyMainnetRuntime(installed).digest !== digest) throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
  };
  if (existsSync(installed)) { verify(); return installed; }
  const staged = join(root, '.install-' + randomBytes(16).toString('hex'));
  mkdirSync(staged, { mode: 0o700 });
  try {
    for (const name of [...Object.keys(manifest.files), 'mainnet-manifest.json'])
      copyFileSync(join(source, name), join(staged, name), constants.COPYFILE_EXCL);
    mkdirSync(join(staged, 'licenses'), { mode: 0o700 });
    for (const name of Object.keys(manifest.licenses))
      copyFileSync(join(source, 'licenses', name), join(staged, 'licenses', name), constants.COPYFILE_EXCL);
    if (verifyMainnetRuntime(staged).digest !== digest) throw new Error('MAINNET_RUNTIME_INTEGRITY_FAILED');
    try { renameSync(staged, installed); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code)))) throw error;
      verify();
    }
    return installed;
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true }); }
}
