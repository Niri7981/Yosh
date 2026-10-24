# Integration records

For the current stable release, start with [Yosh v0.1.1](../docs/releases/v0.1.1.md)
and `scripts/build-stable-release.py`. Yosh Pay v1 is complete; final rc.5 is
promoted as App v0.1.1 build 7 without payment-core or persisted-identity changes.

The historical [Yosh Pay v1 / v0.1.1-rc.5 final source](../docs/releases/v0.1.1-rc.5-final-source.md)
and RC build entry `scripts/build-release-candidate.py` remain unchanged. Its source
final file inventory identifies the reproducible source independently of Git
staging and the archival commit. Build Provenance Manifests identify produced
artifacts. Yosh Pay v0 is the first integration merged in PR #2; Yosh Pay v1
is the final Mainnet hardening archived here. App/package version remains 0.1.1.
Historical build scripts are not final RC provenance.

Start with the [2026-10-21 source archive](archive-20261021/README.md) for the
historical funded Mainnet source mapping and that stage's archive boundary.

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
