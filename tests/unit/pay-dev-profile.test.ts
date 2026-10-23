import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

const requireDependency = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const ProfileSchema = z.object({ bundleIdentifier: z.string(), directoryName: z.string(),
  backendPort: z.number(), merchantPort: z.number(), rpcPort: z.number(), keychainNamespace: z.string() });

function compiled(entry: string, rc3?: boolean) {
  return buildSync({ entryPoints: [resolve(entry)], bundle: true, write: false, platform: 'node', format: 'cjs',
    packages: 'external', minifySyntax: true, ...(rc3 === undefined ? {} : { define: { __YOSH_RC5__: String(rc3) } }) }).outputFiles[0].text;
}
function load(entry: string, rc3?: boolean): unknown {
  return runInNewContext(`${compiled(entry, rc3)}\nmodule.exports`, { module: { exports: {} }, require: requireDependency, URL, Error,
    process: { getuid: process.getuid, env: { YOSH_RC3: '1', YOSH_KEYCHAIN_NAMESPACE: 'untrusted.namespace' } } });
}
function profile(rc3?: boolean) {
  return z.object({ PAY_DEVELOPMENT_PROFILE: ProfileSchema }).parse(load('src/modules/pay-dev/profile.ts', rc3)).PAY_DEVELOPMENT_PROFILE;
}
function parent() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-candidate-profile-')));
  directories.push(directory); return directory;
}

it('retains the existing Dev identity unless the compiler explicitly selects rc.4', () => {
  const legacy = { bundleIdentifier: 'com.yosh.pay-development', directoryName: 'Yosh Pay Dev',
    backendPort: 13049, merchantPort: 13050, rpcPort: 13051, keychainNamespace: 'com.yosh.pay-development' };
  expect(profile()).toEqual(legacy);
  expect(profile(false)).toEqual(legacy);
  expect(profile(true)).toEqual({ bundleIdentifier: 'com.yosh.pay-development.v011rc5', directoryName: 'Yosh Pay Dev v0.1.1-rc.5',
    backendPort: 13449, merchantPort: 13450, rpcPort: 13451, keychainNamespace: 'com.yosh.pay-development.v011rc5' });
  const candidateSource = compiled('src/modules/pay-dev/profile.ts', true);
  expect(candidateSource).not.toMatch(/\b13049\b|\b13050\b|\b13051\b|["']Yosh Pay Dev["']|["']com\.yosh\.pay-development["']/);
});

it('rc.4 environment configuration rejects the old directory, aliases and old service origin', () => {
  const environment = z.object({
    readDevelopmentEnvironment: z.custom<(directory: string) => unknown>(value => typeof value === 'function'),
    assertDevelopmentOrigin: z.custom<(origin: string) => void>(value => typeof value === 'function'),
  }).parse(load('src/modules/pay-dev/environment.ts', true));
  const root = parent();
  const oldDirectory = join(root, 'Yosh Pay Dev'); mkdirSync(oldDirectory, { mode: 0o700 });
  writeFileSync(join(oldDirectory, 'development-environment.json'), 'old-state-must-not-be-read', { mode: 0o600 });
  expect(() => environment.readDevelopmentEnvironment(oldDirectory)).toThrow('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  const candidate = join(root, profile(true).directoryName); mkdirSync(candidate, { mode: 0o700 });
  expect(environment.readDevelopmentEnvironment(candidate)).toMatchObject({ environment: 'offline', mainnetRiskAccepted: false });
  const aliasParent = parent(); const alias = join(aliasParent, profile(true).directoryName); symlinkSync(candidate, alias);
  expect(() => environment.readDevelopmentEnvironment(alias)).toThrow('PAY_DEVELOPMENT_DIRECTORY_REQUIRED');
  expect(() => environment.assertDevelopmentOrigin('http://127.0.0.1:13049')).toThrow('PAY_PROFILE_MISMATCH');
  expect(() => environment.assertDevelopmentOrigin('http://127.0.0.1:13449')).not.toThrow();
  expect(() => environment.assertDevelopmentOrigin('http://localhost:13449')).toThrow('PAY_PROFILE_MISMATCH');
});
