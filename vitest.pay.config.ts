import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Explicit opt-in suite; the sandbox runner requires the real helper first. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/integration/execution-persistence.test.ts', 'tests/integration/pay-protocol-production.test.ts', 'tests/integration/pay-mcp-first.test.ts', 'tests/unit/pay-execution-boundary.test.ts'],
    exclude: base.test?.exclude?.filter(pattern => pattern !== 'tests/integration/pay-protocol-production.test.ts'),
  },
});
