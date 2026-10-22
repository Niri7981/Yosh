import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { payEnvironmentTests } from './tests/helpers/pay-environment-suites';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { setupFiles: ['./tests/helpers/keychain-isolation.mjs'], exclude: [...configDefaults.exclude, 'build.noindex/**', '.next/**',
    ...payEnvironmentTests] },
});
