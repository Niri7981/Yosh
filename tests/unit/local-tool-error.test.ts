import { expect, it } from 'vitest';
import { localToolErrorCode } from '../../src/modules/mcp/local-tool-error';

it('surfaces stale runtime errors without exposing execFile arguments, credentials or other stderr', () => {
  expect(localToolErrorCode(Object.assign(new Error('command /private secret'), {
    stderr: 'STANDALONE_VERSION_INCOMPATIBLE\n' }))).toBe('STANDALONE_VERSION_INCOMPATIBLE');
  expect(localToolErrorCode(new Error('MAINNET_RUNTIME_VERSION_MISMATCH'))).toBe('MAINNET_RUNTIME_VERSION_MISMATCH');
  for (const stderr of ['MAINNET_BACKEND_UNAVAILABLE\nsecret', 'password=secret', 'UNREVIEWED_CODE']) {
    expect(localToolErrorCode(Object.assign(new Error('command secret'), { stderr }))).toBe('LOCAL_TOOL_UNAVAILABLE');
  }
});
