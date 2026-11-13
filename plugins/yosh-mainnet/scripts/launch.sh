#!/bin/bash
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
user_name=$(/usr/bin/id -un)
record=$(/usr/bin/dscl . -read "/Users/$user_name" NFSHomeDirectory)
user_home=${record#NFSHomeDirectory: }
[[ "$user_home" == /* ]] || fail YOSH_MAINNET_HOME_INVALID
app=${YOSH_MAINNET_APP:-"$user_home/Applications/Yosh.app"}
[[ "$app" == /* && -d "$app" && ! -L "$app" ]] || fail YOSH_MAINNET_APP_REQUIRED
[[ "$(cd -P "$app" && pwd -P)" == "$app" ]] || fail YOSH_MAINNET_APP_INVALID
plist="$app/Contents/Info.plist"
identity=$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist")
[[ "$identity" == com.yosh.pay-development.v011rc5 ]] || fail YOSH_MAINNET_APP_INVALID
/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail YOSH_MAINNET_SIGNATURE_INVALID
node="$app/Contents/MacOS/YoshBackendNode"
[[ -x "$node" && ! -L "$node" ]] || fail YOSH_MAINNET_RUNTIME_INVALID
plugin_root=$(cd -P "$(/usr/bin/dirname "$0")/.." && pwd -P)
exec /usr/bin/env -i HOME="$user_home" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  YOSH_MAINNET_APP="$app" "$node" "$plugin_root/scripts/launch.mjs" "$@"
