import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mainnetRemoteStatementCommand } from '../../src/modules/remote/mainnet-statement-owner';

let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'remote-statement-owner-'))); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const metadata = { id: '11111111-1111-4111-8111-111111111111', memberId: '22222222-2222-4222-8222-222222222222',
  label: 'bunny', scopes: ['statement'], environment: 'live_mainnet', createdAt: 123, revokedAt: null };
const token = 'yrr1_' + 'x'.repeat(43);
const pair = (path: string) => ['pair', '--label', 'bunny', '--header-out', path];

it('saves the tunnel header privately after approval, returning only statement metadata', async () => {
  const path = join(directory, 'authorization');
  const call = vi.fn(async () => {
    expect(existsSync(path)).toBe(false);
    return { ...metadata, token };
  });
  expect(await mainnetRemoteStatementCommand(pair(path), call)).toEqual(metadata);
  expect(call).toHaveBeenCalledWith({ action: 'pair', label: 'bunny', scopes: ['statement'] });
  expect(readFileSync(path, 'utf8')).toBe('Bearer ' + token);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});

it('rejects a shared directory and a symlink destination before requesting consent', async () => {
  const call = vi.fn();
  const path = join(directory, 'header');
  chmodSync(directory, 0o755);
  await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow();
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'existing'), 'old', { mode: 0o600 });
  symlinkSync(join(directory, 'existing'), path);
  await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow();
  expect(readFileSync(join(directory, 'existing'), 'utf8')).toBe('old');
  expect(call).not.toHaveBeenCalled();
});

it('discards an incomplete, denied, cross-environment, mismatched, or broader pairing', async () => {
  const path = join(directory, 'header');
  for (const response of [null, { ...metadata, environment: 'live_devnet' }, { ...metadata, label: 'Claude' },
    { ...metadata, revokedAt: 17 }, { ...metadata, scopes: ['statement', 'result'] }, { ...metadata, scopes: ['purchase'] }]) {
    const call = async () => { if (!response) throw new Error('REMOTE_READ_APPROVAL_DECLINED'); return { ...response, token }; };
    await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow(response ? 'REMOTE_READ_OWNER_RESPONSE_INVALID' : 'REMOTE_READ_APPROVAL_DECLINED');
    expect(existsSync(path)).toBe(false);
  }
});

it('reports the failed connection stage without leaking raw errors or issuing another request', async () => {
  const path = join(directory, 'header');
  for (const [error, code] of [
    [new DOMException('sensitive', 'TimeoutError'), 'REMOTE_READ_OWNER_TIMED_OUT'],
    [new TypeError('sensitive'), 'REMOTE_READ_OWNER_CONNECTION_FAILED'],
    [new SyntaxError('sensitive'), 'REMOTE_READ_OWNER_RESPONSE_INVALID'],
  ] as const) {
    const call = vi.fn().mockRejectedValue(error);
    await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow(code);
    expect(call).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  }
});

it('lists metadata, revokes only the requested ID, and rejects purchase actions and environment overrides', async () => {
  const call = vi.fn().mockResolvedValueOnce({ pairings: [metadata] }).mockResolvedValueOnce({ revoked: true });
  expect(await mainnetRemoteStatementCommand(['list'], call)).toEqual({ pairings: [metadata] });
  expect(await mainnetRemoteStatementCommand(['revoke', '--id', metadata.id], call)).toEqual({ revoked: true });
  expect(call.mock.calls).toEqual([[], [{ action: 'revoke', id: metadata.id }]]);
  for (const args of [['grant'], ['list', '--data-dir', directory], ['revoke', '--id', 'not-uuid'],
    [...pair(join(directory, 'header')), '--scope', 'purchase']])
    await expect(mainnetRemoteStatementCommand(args, call)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(2);
});

it('lists Mainnet statement pairings alongside unrelated historical pairings without opening their metadata', async () => {
  const call = vi.fn(async () => ({ pairings: [
    { ...metadata, scopes: ['result'] },
    { ...metadata, scopes: ['statement', 'result'] },
    { ...metadata, environment: 'simulated', scopes: ['purchase'] },
    { ...metadata, environment: 'live_devnet' },
    metadata,
  ] }));
  expect(await mainnetRemoteStatementCommand(['list'], call)).toEqual({ pairings: [metadata] });
});

it.each([true, false])('revokes the new pairing if the destination appears while consent is pending (revoke succeeds: %s)', async succeeds => {
  const path = join(directory, 'authorization');
  const call = vi.fn().mockImplementationOnce(async () => {
    writeFileSync(path, 'existing credential', { mode: 0o600 });
    return { ...metadata, token };
  });
  if (succeeds) call.mockResolvedValueOnce({ revoked: true });
  else call.mockRejectedValueOnce(new Error('management connection closed'));

  await expect(mainnetRemoteStatementCommand(pair(path), call)).rejects.toThrow(
    succeeds ? 'REMOTE_READ_CREDENTIAL_FILE_EXISTS' : 'REMOTE_READ_CREDENTIAL_REVOKE_REQUIRED',
  );
  expect(call.mock.calls).toEqual([
    [{ action: 'pair', label: 'bunny', scopes: ['statement'] }],
    [{ action: 'revoke', id: metadata.id }],
  ]);
  expect(readFileSync(path, 'utf8')).toBe('existing credential');
  expect(readdirSync(directory)).toEqual(['authorization']);
});
