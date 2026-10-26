#!/bin/bash
set -euo pipefail

# Build an independently identified application. This never installs or updates
# Yosh.app, reads its product configuration, or writes any Codex configuration.
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'The development bundle currently supports macOS arm64.'
repository_root="$(cd "$(dirname "$0")/.." && pwd -P)"
output="$repository_root/build.noindex/pay-dev-delivery"
app="$output/Yosh Pay Dev.app"
derived="$repository_root/build.noindex/pay-dev-native"
mkdir -p "$output"
[[ ! -L "$output" && ! -L "$app" ]] || fail 'Refusing a symlink delivery directory.'
if /usr/bin/pgrep -f "$app/Contents/MacOS/Yosh" >/dev/null; then
  fail 'Quit Yosh Pay Dev normally before rebuilding its bundle.'
fi
for entry in pay-dev-backend.ts pay-dev-mcp.ts; do
  [[ -f "$repository_root/scripts/$entry" ]] || fail "Missing development entry: $entry"
done
for binary in "$repository_root/build.noindex/live-devnet-feature/rust-target/debug/yosh-controlled-mcp" "$repository_root/build.noindex/pay-protocol-engine/yosh-execution-protocol"; do
  [[ -x "$binary" ]] || fail "Build the existing Pay integration binaries first: $binary"
done
[[ -x "$repository_root/node_modules/.bin/esbuild" ]] || fail 'Install the existing locked build dependencies first.'

# The official standalone Node runtime has no Homebrew or developer PATH dependency.
# Reuse a verified cached archive when present; cache provenance never becomes a runtime path.
runtime_version=24.21.0
archive="node-v${runtime_version}-darwin-arm64.tar.xz"
expected_hash=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
cache="$repository_root/build.noindex/node-runtime"
mkdir -p "$cache"
if [[ ! -f "$cache/$archive" ]]; then
  if [[ -n "${YOSH_PAY_NODE_ARCHIVE-}" ]]; then
    /usr/bin/ditto "$YOSH_PAY_NODE_ARCHIVE" "$cache/$archive"
  else
    /usr/bin/curl --fail --location --silent --show-error "https://nodejs.org/download/release/v${runtime_version}/$archive" -o "$cache/$archive"
  fi
fi
actual_hash="$(/usr/bin/shasum -a 256 "$cache/$archive" | /usr/bin/awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || fail 'Official Node archive checksum mismatch.'
if [[ ! -x "$cache/node-v${runtime_version}-darwin-arm64/bin/node" ]]; then
  /usr/bin/tar -xJf "$cache/$archive" -C "$cache"
fi
xcodebuild -project "$repository_root/apps/macos/Yosh/Yosh.xcodeproj" -scheme Yosh \
  -configuration Release -destination 'platform=macOS,arch=arm64' -derivedDataPath "$derived" \
  ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build > "$output/native-build.log" 2>&1
built="$derived/Build/Products/Release/Yosh.app"
[[ -x "$built/Contents/MacOS/Yosh" ]] || fail 'Native development build was not produced.'
if [[ -e "$app" ]]; then rm -rf "$app"; fi
/usr/bin/ditto "$built" "$app"
plist="$app/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleIdentifier -string com.yosh.pay-development.v011rc5 "$plist"
/usr/bin/plutil -replace CFBundleDisplayName -string 'Yosh Pay Dev' "$plist"
/usr/bin/plutil -replace CFBundleName -string 'Yosh Pay Dev' "$plist"
/usr/bin/plutil -insert YoshPayDevelopment -bool true "$plist"
runtime="$app/Contents/Resources/Runtime"
mkdir -p "$runtime/backend/.next" "$runtime/licenses"
printf 'yosh-pay-dev-live-networks\n' > "$runtime/backend/.next/BUILD_ID"
"$repository_root/node_modules/.bin/esbuild" "$repository_root/scripts/pay-dev-backend.ts" --bundle --platform=node --target=node24 --format=cjs --define:__YOSH_RC5__=true --outfile="$runtime/backend/server.js"
"$repository_root/node_modules/.bin/esbuild" "$repository_root/scripts/pay-dev-mcp.ts" --bundle --platform=node --target=node24 --format=cjs --define:__YOSH_RC5__=true --outfile="$runtime/mcp.cjs"
"$repository_root/node_modules/.bin/esbuild" "$repository_root/scripts/confirm-pay-mainnet.ts" --bundle --platform=node --target=node24 --format=cjs --define:__YOSH_RC5__=true --outfile="$runtime/confirm-pay-mainnet.cjs"
/usr/bin/ditto "$cache/node-v${runtime_version}-darwin-arm64/bin/node" "$app/Contents/MacOS/YoshBackendNode"
ln -s ../../MacOS/YoshBackendNode "$runtime/node"
/usr/bin/ditto "$repository_root/scripts/run-pay-dev-codex.py" "$runtime/run-pay-dev-codex.py"
/usr/bin/ditto "$cache/node-v${runtime_version}-darwin-arm64/LICENSE" "$runtime/licenses/Node-LICENSE"
/usr/bin/ditto "$repository_root/build.noindex/live-devnet-feature/rust-target/debug/yosh-controlled-mcp" "$runtime/pay-mcp"
/usr/bin/ditto "$repository_root/build.noindex/pay-protocol-engine/yosh-execution-protocol" "$runtime/pay-protocol-engine"
cat > "$runtime/pay-dev.sb" <<'SB'
(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.securityd"))
(deny file-read* file-write*
 (subpath (string-append (param "REAL_HOME") "/Library/Keychains"))
 (subpath "/Library/Keychains")
 (subpath (string-append (param "REAL_HOME") "/.config/pay"))
 (subpath (string-append (param "REAL_HOME") "/.config/solana"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/2049")))
SB
cat > "$runtime/pay-dev-mainnet.sb" <<'SB'
(version 1)
(allow default)
(deny network-inbound)
(allow network-inbound (local ip "localhost:*"))
(deny file-read* file-write*
 (subpath (string-append (param "REAL_HOME") "/.config/pay"))
 (subpath (string-append (param "REAL_HOME") "/.config/solana"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/2049"))
 (literal (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev/offline-buyer.json"))
 (literal (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev/app-ledger.sqlite")))
SB
# Live Devnet uses public HTTPS and the isolated Keychain namespace enforced by
# the backend. It cannot read the Mainnet/Offline stores. Simulation cannot sign
# or access the public network at all.
cp "$runtime/pay-dev-mainnet.sb" "$runtime/pay-dev-devnet.sb"
cat >> "$runtime/pay-dev-devnet.sb" <<'SB'
(deny file-read* file-write*
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev/Mainnet"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev v0.1.1-rc.5")))
SB
cp "$runtime/pay-dev.sb" "$runtime/pay-dev-simulated.sb"
cat >> "$runtime/pay-dev-simulated.sb" <<'SB'
(deny file-read* file-write*
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev/Mainnet"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev/Devnet"))
 (subpath (string-append (param "REAL_HOME") "/Library/Application Support/Yosh Pay Dev v0.1.1-rc.5")))
SB
for binary in "$app/Contents/MacOS/YoshBackendNode" "$runtime/pay-mcp" "$runtime/pay-protocol-engine"; do
  /usr/bin/codesign --force --sign - "$binary"
done
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --strict "$app"
# Desktop MCP is registered separately with explicit user authorization.
# Do not deliver a second Codex launcher or a separate user login flow.
python3 - "$repository_root" <<'PY_BUILD'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
output = root / 'build.noindex/pay-dev-delivery'
app = output / 'Yosh Pay Dev.app'
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {'profile': 'pay-dev-environments', 'environments': ['offline', 'simulated', 'devnet', 'mainnet'], 'bundleIdentifier': 'com.yosh.pay-development.v011rc5',
    'nodeVersion': '24.21.0', 'nodeArchiveSha256': '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
    'sourceOverlaySha256': digest(root / 'integration/release-candidate/pay-overlay/yosh-controlled-mcp.rs'),
    'feature': 'live-devnet-preview-not-stable-release',
    'sourcePaySha256': digest(root / 'build.noindex/live-devnet-feature/rust-target/debug/yosh-controlled-mcp'),
    'packagedPaySha256': digest(app / 'Contents/Resources/Runtime/pay-mcp'),
    'packagedBackendSha256': digest(app / 'Contents/Resources/Runtime/backend/server.js'),
    'packagedMcpWrapperSha256': digest(app / 'Contents/Resources/Runtime/mcp.cjs'),
    'signatureNote': 'Packaged executables are ad-hoc re-signed after copy; source and packaged hashes differ.',
    'productionEnabled': False}
(output / 'build-provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY_BUILD
printf '\nDevelopment app ready: %s\nNo installed application or Codex configuration was changed.\n' "$app"
