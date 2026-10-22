import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

function discover(config?: string) {
  const output = execFileSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'list',
    'tests/integration/pay-protocol-production.test.ts', '--filesOnly', ...(config ? ['--config', config] : [])], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.trim().split(/\r?\n/);
}

it('default test discovery excludes the opt-in Rust helper suite', () => {
  expect(discover()).not.toContain('tests/integration/pay-protocol-production.test.ts');
});

it('the explicit pay configuration still discovers the real helper suite', () => {
  expect(discover('vitest.pay.config.ts')).toContain('tests/integration/pay-protocol-production.test.ts');
});
