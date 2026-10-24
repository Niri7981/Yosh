#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail "This installer requires macOS."
repository_root="$(cd "$(dirname "$0")/.." && pwd -P)"
if [[ "${1-}" == --stable-app ]]; then
  [[ $# == 2 && "$2" == */Yosh.app ]] || fail 'Usage: install-macos-app.sh --stable-app /absolute/staging/Yosh.app'
  exec python3 -B "$repository_root/scripts/build-stable-release.py" install --output "$(dirname "$2")"
fi
[[ $# == 0 ]] || fail 'Unknown installer arguments.'
# The no-argument path below is retained for the historical v0 Beta workflow.
# Current Pay v1 releases use --stable-app after staging acceptance.
applications_directory="$HOME/Applications"
installed_app="$applications_directory/Yosh.app"
legacy_app="$applications_directory/2049.app"
bundle_identifier="com.twentyfortynine.macos"

# Bootstrap the canonical Node override before loading the shared validator.
if [[ ${YOSH_NODE_PATH+x} && ${APP2049_NODE_PATH+x} && "$YOSH_NODE_PATH" != "$APP2049_NODE_PATH" ]]; then
  fail "Conflicting Yosh configuration for YOSH_NODE_PATH."
fi
node_candidate="${YOSH_NODE_PATH-${APP2049_NODE_PATH-$(command -v node || true)}}"
[[ -n "$node_candidate" && -x "$node_candidate" ]] || fail "Install Node.js >=24.5, or set YOSH_NODE_PATH to its executable."
node_executable="$("$node_candidate" -p 'process.execPath')"
"$node_executable" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 5)) { console.error("Node.js >=24.5 is required."); process.exit(1); }'
service_port=3049

# Never interrupt the native runtime's shutdown or replace a running backend build.
if /usr/bin/pgrep -x 2049 >/dev/null || /usr/bin/pgrep -x Yosh >/dev/null; then
  fail "Quit Yosh normally before rebuilding/installing it."
fi
if /usr/sbin/lsof -nP -iTCP:"$service_port" -sTCP:LISTEN >/dev/null; then
  fail "Wait for the local backend to stop safely before rebuilding/installing Yosh."
fi
for candidate_app in "$installed_app" "$legacy_app"; do
  [[ ! -L "$candidate_app" ]] || fail "Refusing to replace a symlink at $candidate_app."
  if [[ -e "$candidate_app" ]]; then
    existing_identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate_app/Contents/Info.plist")"
    [[ "$existing_identifier" == "$bundle_identifier" ]] || fail "Another app already exists at $candidate_app."
  fi
done

# Build tools are used only while packaging; the installed app uses its own runtime.
export PATH="$(dirname "$node_executable"):$PATH"
command -v npm >/dev/null || fail "npm is required to build the backend."
command -v xcodebuild >/dev/null || fail "Xcode command-line build tools are required for rebuilding."
[[ -f "$repository_root/node_modules/next/dist/bin/next" ]] || fail "Run npm ci in $repository_root first."
cd "$repository_root"

printf 'Building backend with %s\n' "$node_executable"
npm run build
# Spotlight excludes .noindex directories, so only the installed copy appears in app searches.
derived_data="$repository_root/build.noindex/macos"
built_app="$derived_data/Build/Products/Release/Yosh.app"
printf 'Building native Yosh.app (Release)\n'
xcodebuild \
  -project "$repository_root/apps/macos/Yosh/Yosh.xcodeproj" \
  -scheme Yosh -configuration Release -destination "platform=macOS,arch=$(uname -m)" \
  -derivedDataPath "$derived_data" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
[[ -x "$built_app/Contents/MacOS/Yosh" ]] || fail "The native build did not produce $built_app."

# Package only the standalone server and its traced dependencies. Never copy
# .env.local, source files, build.noindex, tests, or the developer checkout.
runtime="$built_app/Contents/Resources/Runtime"
backend="$runtime/backend"
rm -rf "$runtime"
mkdir -p "$backend/.next" "$runtime"
for artifact in server.js package.json; do
  [[ -f "$repository_root/.next/standalone/$artifact" ]] || fail "Missing standalone $artifact."
  /usr/bin/ditto "$repository_root/.next/standalone/$artifact" "$backend/$artifact"
done
/usr/bin/ditto "$repository_root/.next/standalone/node_modules" "$backend/node_modules"
/usr/bin/ditto "$repository_root/.next/standalone/.next" "$backend/.next"
/usr/bin/ditto "$repository_root/.next/static" "$backend/.next/static"
if [[ -d "$repository_root/public" ]]; then /usr/bin/ditto "$repository_root/public" "$backend/public"; fi

"$repository_root/node_modules/.bin/esbuild" "$repository_root/scripts/mcp.ts" \
  --bundle --platform=node --target=node24 --format=cjs --outfile="$runtime/mcp.cjs"

# The official Node runtime has only macOS system-library dependencies. The
# binary is a separate signed executable in Contents/MacOS, not a PATH lookup.
runtime_version=24.21.0
runtime_arch="$(uname -m)"
[[ "$runtime_arch" == arm64 || "$runtime_arch" == x86_64 ]] || fail "Unsupported macOS architecture: $runtime_arch"
if [[ "$runtime_arch" == x86_64 ]]; then runtime_arch=x64; fi
node_archive="node-v${runtime_version}-darwin-${runtime_arch}.tar.xz"
node_cache="$repository_root/build.noindex/node-runtime"
mkdir -p "$node_cache"
if [[ ! -f "$node_cache/$node_archive" ]]; then
  /usr/bin/curl --fail --location --silent --show-error \
    "https://nodejs.org/download/release/v${runtime_version}/$node_archive" -o "$node_cache/$node_archive"
fi
if [[ "$runtime_arch" == arm64 ]]; then
  expected_hash=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
else
  /usr/bin/curl --fail --location --silent --show-error \
    "https://nodejs.org/download/release/v${runtime_version}/SHASUMS256.txt" -o "$node_cache/SHASUMS256.txt"
  expected_hash="$(/usr/bin/awk -v name="$node_archive" '$2 == name { print $1 }' "$node_cache/SHASUMS256.txt")"
fi
[[ -n "$expected_hash" ]] || fail "Missing official Node checksum."
actual_hash="$(/usr/bin/shasum -a 256 "$node_cache/$node_archive" | /usr/bin/awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || fail "Bundled Node checksum mismatch."
node_unpack="$node_cache/node-v${runtime_version}-darwin-${runtime_arch}"
if [[ ! -x "$node_unpack/bin/node" ]]; then
  /usr/bin/tar -xJf "$node_cache/$node_archive" -C "$node_cache"
fi
/usr/bin/ditto "$node_unpack/bin/node" "$built_app/Contents/MacOS/YoshBackendNode"
mkdir -p "$runtime/licenses"
/usr/bin/ditto "$node_unpack/LICENSE" "$runtime/licenses/Node-LICENSE"

# Current installations keep their ledger and Keychain identity at the legacy
# data path. The installed product owns its private configuration independently
# of the source checkout and any developer dotenv files.
legacy_data="$HOME/Library/Application Support/2049"
product_data="$HOME/Library/Application Support/Yosh"
if [[ -f "$legacy_data/app-ledger.sqlite" ]]; then product_data="$legacy_data"; fi
mkdir -p "$product_data"
chmod 700 "$product_data"
"$node_executable" "$repository_root/scripts/ensure-product-configuration.mjs" "$product_data"

signing_identity="${YOSH_CODESIGN_IDENTITY--}"
signing_options=(--force --sign "$signing_identity")
if [[ "$signing_identity" != - ]]; then signing_options+=(--options runtime --timestamp); fi
info_plist="$built_app/Contents/Info.plist"
for key in YoshRepositoryRoot APP2049RepositoryRoot YoshNodeExecutable APP2049NodeExecutable; do
  /usr/bin/plutil -remove "$key" "$info_plist" 2>/dev/null || true
done
/usr/bin/codesign "${signing_options[@]}" \
  --entitlements "$repository_root/apps/macos/Yosh/BackendNode.entitlements" "$built_app/Contents/MacOS/YoshBackendNode"
while IFS= read -r -d '' binary; do /usr/bin/codesign "${signing_options[@]}" "$binary"; done \
  < <(/usr/bin/find "$backend" -name '*.node' -type f -print0)
/usr/bin/codesign "${signing_options[@]}" "$built_app"
/usr/bin/codesign --verify --strict "$built_app"

mkdir -p "$applications_directory"
staging="$(mktemp -d "$applications_directory/.yosh-install.XXXXXX")"
install_complete=0
replacement_moved=0
cleanup() {
  if [[ "$install_complete" == 0 ]]; then
    # A failed final verification/registration restores the previous installed bundle.
    if [[ "$replacement_moved" == 1 && -e "$installed_app" ]]; then
      mv "$installed_app" "$staging/failed.app" || { trap - EXIT; return; }
    fi
    if [[ -e "$staging/previous.app" ]]; then
      mv "$staging/previous.app" "$installed_app" || { trap - EXIT; return; }
    fi
    if [[ -e "$staging/legacy.app" && ! -e "$legacy_app" ]]; then
      mv "$staging/legacy.app" "$legacy_app" || { trap - EXIT; return; }
    fi
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
/usr/bin/ditto "$built_app" "$staging/Yosh.app"
/usr/bin/codesign --verify --strict "$staging/Yosh.app"
if [[ -e "$installed_app" ]]; then
  mv "$installed_app" "$staging/previous.app"
fi
if ! mv "$staging/Yosh.app" "$installed_app"; then
  if [[ -e "$staging/previous.app" ]]; then
    if ! mv "$staging/previous.app" "$installed_app"; then
      trap - EXIT
      fail "Could not restore the previous app; it is preserved at $staging/previous.app."
    fi
  fi
  fail "Could not install $installed_app."
fi
replacement_moved=1
/usr/bin/codesign --verify --strict "$installed_app"
# Retire the previous product name only after the replacement is verified.
# Bundle, Keychain and data identities stay unchanged across this rename.
if [[ -e "$legacy_app" ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$legacy_app"
  mv "$legacy_app" "$staging/legacy.app"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$installed_app"
/usr/bin/mdimport "$installed_app"
install_complete=1
printf '\nInstalled: %s\nBuild output: %s\n' "$installed_app" "$built_app"
printf 'Double-click Yosh in Finder, or search for Yosh in Spotlight.\n'
printf 'Runtime bundled inside Yosh.app; product data: %s\n' "$product_data"
