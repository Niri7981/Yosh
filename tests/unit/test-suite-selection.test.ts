import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { classifyPayEnvironmentSuites, findPayEnvironmentSuites } from '../helpers/pay-environment-discovery';

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
  const external = findPayEnvironmentSuites(process.cwd());
  expect(external).toContain('tests/integration/pay-five-fixes-joint.test.ts');
  for (const file of external) {
    expect(ordinary, `${file} requires the explicit isolated Pay runner`).not.toContain(file);
    expect(pay, `${file} must remain runnable`).toContain(file);
  }
  expect(ordinary).toEqual(pay.filter(file => !external.includes(file)));
  expect(pay).toEqual(globSync('tests/**/*.test.{ts,mjs}').sort());
}, 30_000);

it('automatically classifies new suites with direct or transitive prepared dependencies without executing them', () => {
  const sources = new Map([
    ['tests/new.test.ts', `import './helpers/indirect'; throw new Error('must not execute');`],
    ['tests/helpers/indirect.ts', `export * from './artifact';`],
    ['tests/helpers/artifact.ts', `export const binary = 'build.noindex/pay-mcp-target/debug/new-tool';`],
    ['tests/direct.test.ts', `const fixture = '../pay/rust/crates/mcp/tests/fixtures/quote.json';`],
    ['tests/history.test.ts', `const source = '../round2-baseline/head/src/module.ts';`],
    ['tests/template.test.ts', 'const source = `../round2-baseline/${version}/src/module.ts`;'],
    ['tests/dynamic.test.ts', `await import('./helpers/indirect');`],
    ['tests/ordinary.test.ts', `// build.noindex/pay-mcp-target is only documentation\nexport const value = 1;`],
  ]);
  expect(classifyPayEnvironmentSuites([...sources.keys()].filter(file => file.endsWith('.test.ts')), file => sources.get(file)))
    .toEqual(['tests/direct.test.ts', 'tests/dynamic.test.ts', 'tests/history.test.ts', 'tests/new.test.ts', 'tests/template.test.ts']);
});
