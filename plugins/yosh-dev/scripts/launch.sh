#!/bin/bash
set -euo pipefail

# Bootstrap with macOS tools; the plugin never depends on a global Node/Python.
fail() { printf '%s\n' "$1" >&2; exit 1; }
user_name=$(/usr/bin/id -un) || fail YOSH_PLUGIN_USER_UNAVAILABLE
home_record=$(/usr/bin/dscl . -read "/Users/$user_name" NFSHomeDirectory 2>/dev/null) || fail YOSH_PLUGIN_USER_UNAVAILABLE
user_home=${home_record#NFSHomeDirectory: }
[[ "$user_home" == /* ]] || fail YOSH_PLUGIN_USER_UNAVAILABLE
app=${YOSH_CODEX_PLUGIN_APP:-"$user_home/Applications/Yosh Codex Plugin Dev.app"}
[[ "$app" == /* && "$app" == */Yosh\ Codex\ Plugin\ Dev.app ]] || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
[[ -d "$app" ]] || fail YOSH_PLUGIN_APP_NOT_INSTALLED
canonical_app=$(cd -P "$app" && /bin/pwd -P) || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
[[ "$canonical_app" == "$app" && ! -L "$app" ]] || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
plist="$app/Contents/Info.plist"
bundle_id=$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist" 2>/dev/null) || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
plugin_flag=$(/usr/bin/plutil -extract YoshCodexPluginDevelopment raw -o - "$plist" 2>/dev/null) || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
dev_flag=$(/usr/bin/plutil -extract YoshPayDevelopment raw -o - "$plist" 2>/dev/null) || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
[[ "$bundle_id" == com.yosh.codex-plugin-dev && "$plugin_flag" == true && "$dev_flag" == true ]] || fail YOSH_PLUGIN_APP_IDENTITY_MISMATCH
/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail YOSH_PLUGIN_APP_SIGNATURE_INVALID
node="$app/Contents/MacOS/YoshBackendNode"
[[ -x "$node" && ! -L "$node" ]] || fail YOSH_PLUGIN_RUNTIME_UNAVAILABLE
node_directory=$(cd -P "$app/Contents/MacOS" && /bin/pwd -P) || fail YOSH_PLUGIN_RUNTIME_UNAVAILABLE
[[ "$node_directory" == "$app/Contents/MacOS" ]] || fail YOSH_PLUGIN_RUNTIME_UNAVAILABLE
plugin_root=$(cd -P "$(/usr/bin/dirname "$0")/.." && /bin/pwd -P)
exec /usr/bin/env -i HOME="$user_home" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  YOSH_CODEX_PLUGIN_APP="$app" "$node" "$plugin_root/scripts/launch.mjs" "$@"
