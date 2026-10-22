import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';

function discovered(config: string) {
  // File-only discovery exercises the actual CLI without importing tests that
  // require a sibling Pay checkout, historical sources or compiled Rust tools.
  const output = execFileSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'),
    'list', '--config', config, '--filesOnly', '--json'], { encoding: 'utf8', timeout: 10_000 });
  return z.array(z.object({ file: z.string() })).parse(JSON.parse(output))
    .map(({ file }) => relative(process.cwd(), file)).sort();
}

it('keeps external Pay fixtures out of npm test and preserves every suite in an explicit entry point', () => {
  const ordinary = discovered('vitest.config.ts');
  const pay = discovered('vitest.pay.config.ts');
  const external = [
    'tests/integration/execution-persistence.test.ts',
    'tests/integration/pay-dev-environments.test.ts',
    'tests/integration/pay-dev-runtime.test.ts',
    'tests/integration/pay-mainnet-live-preflight.test.ts',
    'tests/integration/pay-mcp-first.test.ts',
    'tests/integration/pay-protocol-production.test.ts',
    'tests/unit/pay-unsigned-preflight.test.ts',
  ];
  for (const file of external) {
    expect(ordinary, `${file} requires the explicit isolated Pay runner`).not.toContain(file);
    expect(pay, `${file} must remain runnable`).toContain(file);
  }
  expect(ordinary.every(file => pay.includes(file))).toBe(true);
  expect(pay).toEqual(globSync('tests/**/*.test.{ts,mjs}').sort());
}, 30_000);
