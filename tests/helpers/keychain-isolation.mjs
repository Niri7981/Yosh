import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, expect } from 'vitest';

// Unit tests must inject a memory store or a mocked child. Never let an omitted
// fixture dependency read, prompt for, or mutate the user's system Keychain.
const blocked = [];
function check(command, name) {
  if (typeof command === 'string' && /(^|[\s/])security(?:\s|$)/.test(command)) {
    blocked.push(name);
    throw new Error('SYSTEM_KEYCHAIN_FORBIDDEN_IN_UNIT_TESTS');
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function (command, ...args) {
    check(command, name);
    return Reflect.apply(original, this, [command, ...args]);
  };
  const custom = original[promisify.custom];
  if (custom) childProcess[name][promisify.custom] = function (command, ...args) {
    check(command, name);
    return Reflect.apply(custom, this, [command, ...args]);
  };
}
syncBuiltinESMExports();
afterEach(() => {
  const attempts = blocked.splice(0).length;
  expect(attempts, 'Inject a test wallet store; real system Keychain access is forbidden.').toBe(0);
});
