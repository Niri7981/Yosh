import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { payEnvironmentTests } from './tests/helpers/pay-environment-suites';

/** Full opt-in coverage; the sandbox runner checks prepared dependencies first. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    exclude: base.test?.exclude?.filter(pattern => !payEnvironmentTests.includes(pattern)),
  },
});
