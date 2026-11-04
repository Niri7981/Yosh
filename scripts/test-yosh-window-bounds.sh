#!/bin/bash
set -euo pipefail
repository_root="$(cd "$(dirname "$0")/.." && pwd -P)"
fixture_directory="$(mktemp -d "${TMPDIR:-/tmp}/yosh-window-bounds.XXXXXX")"
trap 'rm -rf "$fixture_directory"' EXIT
cd "$repository_root"
app_sources=()
while IFS= read -r source; do app_sources+=("$source"); done < <(rg --files apps/macos/Yosh/YoshApp -g '*.swift' -g '!YoshApp.swift')
xcrun swiftc -parse-as-library -swift-version 6 "${app_sources[@]}" \
  apps/macos/Yosh/tests/CardWindowBoundsTest.swift -o "$fixture_directory/CardWindowBoundsTest"
"$fixture_directory/CardWindowBoundsTest"
