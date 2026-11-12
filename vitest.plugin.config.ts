import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Opt-in integration with verified, locally built plugin Dev Rust artifacts. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/integration/codex-plugin-*.test.ts'],
    exclude: [...configDefaults.exclude, 'build.noindex/**', '.next/**'],
    fileParallelism: false,
  },
});
