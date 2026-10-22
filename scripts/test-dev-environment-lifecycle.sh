#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
app="$root/build.noindex/pay-dev-delivery/Yosh Pay Dev.app"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/yosh-dev-native-XXXXXX")"
cleanup() {
  result=$?
  if [[ "$result" != 0 && -d "$test_home/Logs" ]]; then
    /usr/bin/ditto "$test_home/Logs" "$root/integration/dev-environments/native-lifecycle-diagnostics"
  fi
  rm -rf "$test_home"
}
trap cleanup EXIT
cd "$root"
# Same production lifecycle, actual packaged backend, temporary data. Use one
# stricter child sandbox; macOS rejects layering these differing sandbox profiles.
cp integration/mainnet-execution/live-no-sign.sb "$test_home/no-funds.sb"
cat >> "$test_home/no-funds.sb" <<'SB'
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
SB
swiftc -swift-version 6 -parse-as-library \
  apps/macos/Yosh/YoshApp/Services/{BackendChildProcess,BackendLaunchConfiguration,ManagementTransport,NativeServiceRuntime}.swift \
  apps/macos/Yosh/YoshApp/Models/{AppOverview,AuthoritySurface,ExecutionEnvironment,RegisteredAPI,WalletLibraryPresentation,CardSettingsPresentation,PurchasePresentation}.swift \
  tests/native/PayDevelopmentEnvironmentLifecycle.swift -o "$test_home/lifecycle"
"$test_home/lifecycle" "$app" "$test_home"
