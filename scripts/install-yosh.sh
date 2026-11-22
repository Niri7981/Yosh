#!/bin/sh
# Download and install the pinned Yosh standalone preview for Apple Silicon.
set -eu
umask 077

version=0.2.20
release="v${version}-preview"
asset=yosh-local-dev.zip
marketplace_name=yosh-standalone-marketplace
archive=
checksum=
install_only=false

usage() {
  printf '%s\n' 'Usage: sh install-yosh.sh [--install-only] [--archive ZIP --sha256-file FILE]' \
    'Downloads the pinned Yosh preview, verifies its SHA-256, and opens the host selection menu.' \
    'Use --install-only to keep the verified package for manual setup.'
}

fail() {
  printf 'Yosh installer: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [ -z "$archive" ] || fail 'Provide one local ZIP path.'
      archive=$2
      shift
      ;;
    --sha256-file)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [ -z "$checksum" ] || fail 'Provide one SHA-256 file path.'
      checksum=$2
      shift
      ;;
    --install-only) install_only=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
  shift
done

if [ -n "$archive" ] || [ -n "$checksum" ]; then
  [ -n "$archive" ] && [ -f "$archive" ] && [ -n "$checksum" ] && [ -f "$checksum" ] ||
    fail 'Offline installation requires a local ZIP and its SHA-256 file.'
fi

[ "$(/usr/bin/uname -s)" = Darwin ] && [ "$(/usr/bin/uname -m)" = arm64 ] ||
  fail 'This preview requires an Apple Silicon Mac.'
home="$(CDPATH= cd -- "${HOME:?HOME is required}" && pwd -P)"
support="$home/Library/Application Support"
root="$support/Yosh Preview"
destination="$root/$release"
marketplace="$destination/$marketplace_name"
[ ! -L "$home/Library" ] && [ ! -L "$support" ] || fail 'Application Support must be a local directory.'
/bin/mkdir -p "$support"
if [ ! -d "$root" ]; then
  /bin/mkdir -m 700 "$root" 2>/dev/null || [ -d "$root" ] || fail 'Cannot create the preview directory.'
fi

private_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] &&
    [ "$(/usr/bin/stat -f '%u %Lp' "$1")" = "$(/usr/bin/id -u) 700" ]
}

private_directory "$root" || fail 'The preview directory must be owned by you and private (mode 700).'
lock="$root/.install.lock"
[ ! -L "$lock" ] && { [ ! -e "$lock" ] || [ -f "$lock" ]; } || fail 'Invalid preview installation lock.'
exec 9>>"$lock"
/usr/bin/lockf -s -t 30 9 || fail 'Another Yosh installation is running. Try again when it finishes.'

stage="$(/usr/bin/mktemp -d "$root/.stage.XXXXXXXX")"
cleanup() { /bin/rm -rf -- "$stage"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [ -n "$archive" ]; then
  /bin/cat < "$archive" > "$stage/$asset"
  /bin/cat < "$checksum" > "$stage/$asset.sha256"
else
  source="https://github.com/Niri7981/Yosh/releases/download/$release"
  for file in "$asset.sha256" "$asset"; do
    /usr/bin/curl -q --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 --retry 2 -fsSL \
      "$source/$file" -o "$stage/$file" ||
      fail "Cannot download $release. If the preview is still private, use its ZIP and checksum with --archive and --sha256-file."
  done
fi

expected="$(LC_ALL=C /usr/bin/awk 'NR == 1 && length($1) == 64 && $1 ~ /^[a-fA-F0-9]+$/ {print tolower($1)}' "$stage/$asset.sha256")"
[ -n "$expected" ] || fail 'The SHA-256 file has no valid digest.'
actual="$(/usr/bin/shasum -a 256 < "$stage/$asset" | /usr/bin/awk '{print $1}')"
[ "$actual" = "$expected" ] || fail 'The ZIP checksum does not match.'

contains_expected_package() {
  catalog="$1/.agents/plugins/marketplace.json"
  plugin="$1/plugins/yosh-local-dev"
  [ -x "$1/Install.command" ] && [ -x "$1/Connect-Dot.command" ] &&
    [ -f "$catalog" ] && [ -x "$plugin/yosh-dev" ] && [ -x "$plugin/runtime/node" ] &&
    [ -f "$plugin/runtime/manifest.json" ] &&
    [ "$(/usr/bin/plutil -extract version raw -o - "$plugin/.codex-plugin/plugin.json" 2>/dev/null)" = "$version" ]
}

if [ -e "$destination" ] || [ -L "$destination" ]; then
  private_directory "$destination" && [ ! -L "$marketplace" ] &&
    [ -f "$destination/.archive.sha256" ] && [ ! -L "$destination/.archive.sha256" ] &&
    [ "$(/bin/cat < "$destination/.archive.sha256")" = "$expected" ] &&
    contains_expected_package "$marketplace" ||
    fail "The existing preview at $destination differs from this ZIP. Move it aside before reinstalling."
else
  # The packager emits only regular files beneath one known archive root.
  # Reject unsafe paths, duplicate names, links, and special modes before extracting.
  LC_ALL=C /usr/bin/unzip -Z -l "$stage/$asset" > "$stage/entries" ||
    fail 'Cannot inspect the installed ZIP format.'
  LC_ALL=C /usr/bin/awk '
    /^Zip file size: .*number of entries: [0-9]+$/ {entries = $NF + 0; next}
    NR > 2 && $1 ~ /^[^0-9]/ {
      name = $NF
      if (NF != 10 || $1 !~ /^-[-r][-w][-x][-r][-w][-x][-r][-w][-x]$/ ||
          $3 != "unx" || name !~ /^yosh-standalone-marketplace\/[a-zA-Z0-9._\/-]+$/ ||
          name ~ /(^|\/)\.{1,2}(\/|$)|\/\/|\/$/ || seen[name]++) exit 1
      ++count
    }
    END {if (count < 1 || count != entries) exit 1}
  ' "$stage/entries" || fail 'The preview ZIP has unsafe or unexpected archive entries.'
  /bin/mkdir -m 700 "$stage/verified"
  /usr/bin/unzip -q "$stage/$asset" -d "$stage/verified" || fail 'Cannot extract the preview ZIP.'
  contains_expected_package "$stage/verified/$marketplace_name" || fail "The ZIP does not contain Yosh $version."
  printf '%s\n' "$expected" > "$stage/verified/.archive.sha256"
  /bin/mv -- "$stage/verified" "$destination"
fi

printf 'Verified Yosh %s at\n%s\n' "$version" "$marketplace"
cleanup
trap - EXIT
exec 9>&-
if [ "$install_only" = false ]; then
  exec "$marketplace/Install.command" --interactive
fi
