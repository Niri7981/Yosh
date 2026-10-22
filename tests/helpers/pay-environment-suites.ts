// Requires prepared Rust binaries, sibling Pay fixtures and/or historical
// source trees. These remain mandatory in the explicit isolated Pay runner.
export const payEnvironmentTests = [
  'tests/integration/execution-persistence.test.ts',
  'tests/integration/pay-dev-environments.test.ts',
  'tests/integration/pay-dev-runtime.test.ts',
  'tests/integration/pay-mainnet-live-preflight.test.ts',
  'tests/integration/pay-mcp-first.test.ts',
  'tests/integration/pay-protocol-production.test.ts',
  'tests/unit/pay-unsigned-preflight.test.ts',
];
