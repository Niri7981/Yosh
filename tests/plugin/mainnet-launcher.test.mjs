import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScope, permittedCall, filterTools, assertMainnetStatus } from '../../plugins/yosh-mainnet/scripts/launch.mjs';

test('a successful HTTP response is insufficient without the original Mainnet asset scope', () => {
  const scope = { environment: 'live_mainnet', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', assetDecimals: 6 };
  assert.doesNotThrow(() => assertMainnetStatus({ budget: { monetaryScope: scope } }));
  for (const patch of [{ environment: 'live_devnet' }, { network: 'devnet' }, { assetId: 'USDC' }, { assetDecimals: 9 }])
    assert.throws(() => assertMainnetStatus({ budget: { monetaryScope: { ...scope, ...patch } } }), /BACKEND_SCOPE_INVALID/);
});

test('hidden tools are also rejected at dispatch, while recovery preserves its original call', () => {
  for (const name of ['topup', 'create_skill', 'sell_inference', 'unknown']) {
    assert.equal(permittedCall({ method: 'tools/call', params: { name } }), false);
  }
  assert.deepEqual(filterTools([{ name: 'curl' }, { name: 'topup' }, { name: 'get_spending_status' }]),
    [{ name: 'curl' }, { name: 'get_spending_status' }]);
  assert.equal(permittedCall({ method: 'tools/call', params: { name: 'recover_payment' } }), true);
});

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yosh-mainnet-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5');
  const dir = path.join(root, 'Mainnet');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const memberId = '12345678-1234-4234-8234-123456789abc';
  const connection = { origin: 'http://127.0.0.1:13449', cardMemberId: memberId, connectionId: memberId,
    generation: 1, token: 'a'.repeat(43), capabilities: ['read', 'request_purchase'] };
  write(path.join(root, 'development-environment.json'), { version: 1, environment: 'mainnet' });
  write(path.join(dir, 'pay-mainnet-runtime.json'), { version: 1, profile: 'pay-mcp-mainnet', origin: connection.origin, memberId });
  write(path.join(dir, 'mcp-connection.json'), connection);
  return { home, root, dir, write, connection };
}
test('attaches to the original principal without modifying saved state', t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.dir, 'mcp-connection.json'));
  assert.equal(readScope(f.home).connection.cardMemberId, f.connection.cardMemberId);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'mcp-connection.json')), before);
});
test('rejects Devnet selection instead of changing it', t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'development-environment.json'), { version: 1, environment: 'devnet' });
  assert.throws(() => readScope(f.home), /YOSH_MAINNET_NOT_SELECTED/);
});
test('rejects wrong Agent, port, generation or private-file permissions', t => {
  const f = fixture(t), file = path.join(f.dir, 'mcp-connection.json');
  for (const patch of [{ cardMemberId: '87654321-1234-4234-8234-123456789abc' },
    { origin: 'http://127.0.0.1:17449' }, { generation: 0 }]) {
    f.write(file, { ...f.connection, ...patch });
    assert.throws(() => readScope(f.home), /YOSH_MAINNET_CONNECTION_INVALID/);
  }
  f.write(file, f.connection); fs.chmodSync(file, 0o644);
  assert.throws(() => readScope(f.home), /YOSH_MAINNET_PRIVATE_CONFIG_INVALID/);
});
test('invalid member descriptor cannot fall back to the original default credential', t => {
  const f = fixture(t), member = path.join(f.dir, 'members', f.connection.cardMemberId);
  fs.mkdirSync(member, { recursive: true, mode: 0o700 });
  f.write(path.join(member, 'mcp-connection.json'), { ...f.connection, token: 'invalid' });
  assert.throws(() => readScope(f.home), /YOSH_MAINNET_CONNECTION_INVALID/);
});
