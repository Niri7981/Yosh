# Integration records

Start with the [2026-10-21 source archive](archive-20261021/README.md) for the
funded Mainnet source mapping and current archive boundary.

The remaining subdirectories preserve dated investigation, isolated validation
and Dev acceptance stages. Their historical BLOCKED status, installation claims,
local commands and raw evidence references describe those stages. They are not
new payment, deployment or Git authorization. Private referenced captures are
intentionally excluded from Git.

## Test entry points

`npm ci` followed by `npm test`, `npm run typecheck`, `npm run lint` and
`npm run build` works from a clean Yosh checkout with Node >=24.5.0. The
default tests do not require a sibling Pay checkout, Rust binaries or historical
source trees. Generated `build.noindex` dependency sources are not TypeScript
inputs.

`npm run test:pay` runs the ordinary unit/integration suites **and** every
environment-dependent Pay suite, plus the native Node installer tests, under
the existing macOS loopback-only sandbox. It fails if prepared dependencies are
missing; it does not silently skip Pay coverage. Prepare these first:

- `build.noindex/pay-mcp-target/debug/yosh-controlled-mcp`, from the reviewed
  Pay fork ([archive build guidance](archive-20261021/README.md)).
- `build.noindex/pay-protocol-engine/yosh-execution-protocol`
  ([preserved protocol helper](pay-protocol-engine/README.md)).
- The matching sibling `../pay` source, including its public
  `rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json` fixture, and the
  Git history referenced by `pay-persistence/compat-sources.json`. The runner
  materializes and verifies the historical source fixtures before testing.

The live read-only Mainnet preflight remains separately opt-in. No test-entry
change authorizes real payment, installation or Mainnet enablement.
