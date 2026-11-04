#!/bin/bash
set -euo pipefail
repository_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
fixture_directory="${YOSH_UI_REGRESSION_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/yosh-daily-limit.XXXXXX")}"
mkdir -p "$fixture_directory"
cd "$repository_root"
app_sources=()
while IFS= read -r source; do
  app_sources+=("$source")
done < <(rg --files apps/macos/Yosh/YoshApp -g '*.swift' -g '!YoshApp.swift')
xcrun swiftc -parse-as-library -swift-version 6 "${app_sources[@]}" \
  apps/macos/Yosh/tests/DailyLimitInlineEditingTest.swift -o "$fixture_directory/InlineEditingTest"
"$fixture_directory/InlineEditingTest" "$fixture_directory/inline"
