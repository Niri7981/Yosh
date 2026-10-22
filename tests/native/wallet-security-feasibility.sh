#!/bin/bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/yosh-wallet-security.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT

# A temporary capability harness with no trusted distribution identity;
# not a production helper or wallet.
swiftc -swift-version 6 -parse-as-library \
  "$repository_root/tests/native/WalletSecurityFeasibility.swift" \
  -o "$temporary/wallet-security-feasibility"
"$temporary/wallet-security-feasibility"
