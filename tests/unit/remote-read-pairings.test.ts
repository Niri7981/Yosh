import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { connectionFile, readConnection } from '../../src/modules/mcp/connection';

it('retains only remote verifier and member scope across restart; neither credential works on the other channel', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-remote-read-binding-'));
  const origin = 'http://127.0.0.1:3049';
  let app = new AppRuntime(directory, { confirmRemoteReadPairing: async () => true });
  try {
    app.setAgentConnection(true, origin);
    const local = readConnection(directory);
    const a = await app.issueRemoteReadPairing('Cloud research', ['statement']);
    const b = await app.issueRemoteReadPairing('Cloud assistant', ['result']);
    expect(a.token).not.toBe(b.token); expect(a.memberId).not.toBe(b.memberId);
    expect(existsSync(connectionFile(directory, a.memberId))).toBe(false);
    const files = ['app-ledger.sqlite', 'app-ledger.sqlite-wal'].map(name => join(directory, name)).filter(existsSync);
    for (const file of files) expect(readFileSync(file).includes(a.token)).toBe(false);
    expect(app.ledger.spendGrantSummary(Date.now(), 'simulated', a.memberId)).toBeNull();
    expect(() => app.setAgentConnection(true, origin, a.memberId)).toThrow('REMOTE_MEMBER_READ_ONLY');
    expect(() => app.authenticateRemoteRead(local.token)).toThrow('REMOTE_READ_UNAUTHORIZED');
    expect(() => app.authenticateAgent(new Request(origin, { headers: { authorization: 'Bearer ' + a.token } }))).toThrow();
    app.close(); app = new AppRuntime(directory);
    expect(app.authenticateRemoteRead(a.token)).toMatchObject({ memberId: a.memberId, scopes: ['statement'] });
    expect(() => app.remoteAccountRead(a.token, 'result', {})).toThrow('REMOTE_READ_FORBIDDEN');
    expect(app.listRemoteReadPairings().every(pair => !('token' in pair) && !('token_hash' in pair))).toBe(true);
    app.revokeRemoteReadPairing(a.id);
    app.close(); app = new AppRuntime(directory);
    expect(() => app.authenticateRemoteRead(a.token)).toThrow('REMOTE_READ_UNAUTHORIZED');
    expect(app.authenticateRemoteRead(b.token).id).toBe(b.id);
    expect(app.listRemoteReadPairings().find(pair => pair.id === a.id)?.revokedAt).toEqual(expect.any(Number));
    expect(readConnection(directory).token).toBe(local.token);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('creates no member when consent is refused, unavailable, or the environment changes during confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yosh-remote-read-consent-'));
  const app = new AppRuntime(directory, { confirmRemoteReadPairing: async ({ label }) => {
    if (label === 'System error') throw Error('test-only-unavailable');
    if (label === 'Wrong environment') { app.setExecution('live_devnet'); return true; }
    return false;
  } });
  try {
    expect(app.ledger.cardMembers()).toHaveLength(1);
    await expect(app.issueRemoteReadPairing('Declined', ['statement'])).rejects.toThrow('REMOTE_READ_CONSENT_DENIED');
    await expect(app.issueRemoteReadPairing('System error', ['statement'])).rejects.toThrow();
    await expect(app.issueRemoteReadPairing('Wrong environment', ['statement'])).rejects.toThrow('REMOTE_READ_SCOPE_CHANGED');
    expect(app.ledger.cardMembers()).toHaveLength(1);
    expect(app.listRemoteReadPairings()).toEqual([]);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});
