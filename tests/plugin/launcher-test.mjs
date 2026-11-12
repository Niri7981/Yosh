import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as launcher from '../../plugins/yosh-dev/scripts/launch.mjs';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yosh-plugin-launch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'Library/Application Support', launcher.NAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const memberId = '11111111-1111-4111-8111-111111111111';
  const manifest = { version: 1, profile: 'isolated-pay-dev', origin: launcher.ORIGIN, memberId };
  const connection = { origin: launcher.ORIGIN, cardMemberId: memberId, connectionId: '22222222-2222-4222-8222-222222222222',
    generation: 1, token: 'x'.repeat(43), capabilities: ['read', 'request_purchase'] };
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  write('pay-dev-runtime.json', manifest);
  write('mcp-connection.json', connection);
  return { home, root, manifest, connection, write };
}

test('only the fixed private Dev directory and Agent connection are used', t => {
  const f = fixture(t);
  const scope = launcher.readScope(f.home);
  assert.equal(scope.root, f.root);
  assert.equal(scope.environment, 'offline');
  assert.equal(launcher.readConnection(scope).cardMemberId, f.manifest.memberId);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['mcp-connection.json', 'pay-dev-runtime.json']);
});

test('cross-environment origin, profile and live environment selection are rejected', t => {
  const f = fixture(t);
  for (const update of [{ origin: 'http://127.0.0.1:13449' }, { profile: 'pay-mcp-mainnet' }]) {
    f.write('pay-dev-runtime.json', { ...f.manifest, ...update });
    assert.throws(() => launcher.readScope(f.home), { code: 'YOSH_PLUGIN_RUNTIME_SCOPE_MISMATCH' });
  }
  f.write('pay-dev-runtime.json', f.manifest);
  for (const environment of ['devnet', 'mainnet']) {
    f.write('development-environment.json', { version: 1, environment });
    assert.throws(() => launcher.readScope(f.home), { code: 'YOSH_PLUGIN_ENVIRONMENT_DISABLED' });
  }
});

test('a directory alias cannot redirect the plugin to another store', t => {
  const f = fixture(t);
  const original = f.root + '-original';
  fs.renameSync(f.root, original);
  fs.symlinkSync(original, f.root, 'dir');
  assert.throws(() => launcher.readScope(f.home), { code: 'YOSH_PLUGIN_DATA_DIRECTORY_INVALID' });
});

test('capability symlinks, public permissions and another member are rejected', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'mcp-connection.json');
  fs.chmodSync(file, 0o644);
  assert.throws(() => launcher.readConnection(launcher.readScope(f.home)), { code: 'YOSH_PLUGIN_CONNECTION_INVALID' });
  fs.chmodSync(file, 0o600);
  f.write('mcp-connection.json', { ...f.connection, cardMemberId: f.connection.connectionId });
  assert.throws(() => launcher.readConnection(launcher.readScope(f.home)), { code: 'YOSH_PLUGIN_CONNECTION_INVALID' });
  fs.renameSync(file, file + '.original');
  fs.symlinkSync(file + '.original', file);
  assert.throws(() => launcher.readConnection(launcher.readScope(f.home)), { code: 'YOSH_PLUGIN_CONNECTION_INVALID' });
});

test('missing connection is distinct from a revoked captured capability', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'mcp-connection.json'));
  await assert.rejects(launcher.ready('/unused.app', f.home, { portReady: async () => true }), { code: 'YOSH_PLUGIN_CONNECTION_REQUIRED' });
  f.write('mcp-connection.json', f.connection);
  let calls = 0;
  await assert.rejects(launcher.ready('/unused.app', f.home, { portReady: async () => true, authenticate: async () => {
    calls++;
    f.write('mcp-connection.json', { ...f.connection, token: 'y'.repeat(43) });
    throw new launcher.LauncherError('YOSH_PLUGIN_CONNECTION_REVOKED');
  } }), { code: 'YOSH_PLUGIN_CONNECTION_REVOKED' });
  assert.equal(calls, 1, 'a failed capability must not be silently reacquired');
});

test('startup opens only the supplied Dev app and has a bounded wait', async t => {
  const f = fixture(t);
  let opens = 0;
  await assert.rejects(launcher.ready('/approved/Dev.app', f.home, { timeoutMs: 0, portReady: async () => false,
    openApp: app => { assert.equal(app, '/approved/Dev.app'); opens++; return { status: 0 }; } }),
  { code: 'YOSH_PLUGIN_BACKEND_NOT_READY' });
  assert.equal(opens, 1);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['mcp-connection.json', 'pay-dev-runtime.json']);
});

test('readiness authenticates once without changing local authorization', async t => {
  const f = fixture(t);
  const bytes = fs.readFileSync(path.join(f.root, 'mcp-connection.json'));
  let calls = 0;
  const scope = await launcher.ready('/unused.app', f.home, { portReady: async () => true, authenticate: async connection => {
    assert.equal(connection.token, f.connection.token); calls++;
  }, openApp: () => assert.fail('ready backend should not open another app') });
  assert.equal(scope.environment, 'offline');
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'mcp-connection.json')), bytes);
});

test('formal identity is rejected before the bootstrap can execute its Node', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t);
  const app = path.join(f.home, launcher.NAME + '.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.twentyfortynine.macos</string><key>YoshPayDevelopment</key><true/><key>YoshCodexPluginDevelopment</key><true/></dict></plist>');
  const result = spawnSync('/bin/bash', [path.resolve('plugins/yosh-dev/scripts/launch.sh')], {
    env: { PATH: '/usr/bin:/bin', YOSH_CODEX_PLUGIN_APP: app }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'YOSH_PLUGIN_APP_IDENTITY_MISMATCH');
});

test('valid-looking flags cannot bypass signature validation', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t);
  const app = path.join(f.home, launcher.NAME + '.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yosh.codex-plugin-dev</string><key>YoshPayDevelopment</key><true/><key>YoshCodexPluginDevelopment</key><true/></dict></plist>');
  const result = spawnSync('/bin/bash', [path.resolve('plugins/yosh-dev/scripts/launch.sh')], {
    env: { PATH: '/usr/bin:/bin', YOSH_CODEX_PLUGIN_APP: app }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'YOSH_PLUGIN_APP_SIGNATURE_INVALID');
});
