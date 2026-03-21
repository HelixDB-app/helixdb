#!/bin/sh
# Build phase helper for Tauri iOS: runs `cargo tauri ios xcode-script` with a valid arch.
#
# Xcode 15+ may set ARCHS=undefined_arch during script phases. Tauri only accepts arm64 | x86_64.
# Xcode GUI builds also omit login-shell PATH, so ~/.cargo/bin is often missing.
# Do not use `set -u`: Xcode sometimes exports PLATFORM_DISPLAY_NAME="" (empty) or omits vars,
# and empty-but-set vs unset breaks nounset across /bin/sh versions.
set -e

# Rustup installs this; it prepends ~/.cargo/bin without needing an interactive shell.
if [ -f "${HOME}/.cargo/env" ]; then
  # shellcheck disable=SC1090
  . "${HOME}/.cargo/env"
fi

# Homebrew (Apple Silicon vs Intel) — cheap idempotent prepend.
for _root in /opt/homebrew /usr/local; do
  if [ -d "${_root}/bin" ]; then
    case ":${PATH}:" in
      *":${_root}/bin:"*) ;;
      *) PATH="${_root}/bin:${PATH}" ;;
    esac
  fi
done
export PATH

# Optional PATH overrides (Xcode SRCROOT = src-tauri/gen/apple).
_SRCROOT="${SRCROOT:-.}"
if [ -f "${_SRCROOT}/.xcode.env" ]; then
  # shellcheck disable=SC1090
  . "${_SRCROOT}/.xcode.env"
fi
if [ -f "${_SRCROOT}/.xcode.env.local" ]; then
  # shellcheck disable=SC1090
  . "${_SRCROOT}/.xcode.env.local"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not in PATH for Xcode. Install rustup or add ~/.cargo/bin." >&2
  echo "hint: run \`rustup show\` in Terminal, then create ${_SRCROOT}/.xcode.env with:" >&2
  echo "  export PATH=\"\$HOME/.cargo/bin:\$PATH\"" >&2
  exit 127
fi

# Map Xcode settings → Tauri --platform (must never be empty; clap + set -u-safe).
# Xcode 16+ may leave PLATFORM_DISPLAY_NAME empty while PLATFORM_NAME is set (or neither in odd phases).
_tauri_platform=""
if [ -n "${PLATFORM_DISPLAY_NAME:-}" ]; then
  _tauri_platform=${PLATFORM_DISPLAY_NAME}
else
  case "${PLATFORM_NAME:-}" in
    iphonesimulator) _tauri_platform="iOS Simulator" ;;
    iphoneos) _tauri_platform="iOS" ;;
    macosx) _tauri_platform="macOS" ;;
    *)
      _tauri_platform="iOS"
      if [ -z "${SDKROOT:-}" ]; then
        echo "error: tauri-ios-xcode.sh needs Xcode build settings (at least SDKROOT)." >&2
        echo "  Run from Xcode (Build Rust Code) or export SDKROOT, PLATFORM_NAME, CONFIGURATION." >&2
        exit 2
      fi
      echo "warning: [tauri-ios-xcode] PLATFORM_NAME/PLATFORM_DISPLAY_NAME missing; assuming iOS device." >&2
      ;;
  esac
fi
PLATFORM_DISPLAY_NAME=${_tauri_platform}
export PLATFORM_DISPLAY_NAME

if [ -z "${SDKROOT:-}" ]; then
  echo "error: SDKROOT is not set. Open the iOS project in Xcode and build the pgstudio_iOS target." >&2
  exit 2
fi
if [ ! -d "$SDKROOT" ]; then
  echo "error: SDKROOT is not a directory: $SDKROOT" >&2
  exit 2
fi

: "${CONFIGURATION:=Debug}"
# Tauri only treats the literal "release" as Release; Xcode uses "Release".
CONFIGURATION_TAURI=$(printf '%s' "$CONFIGURATION" | tr '[:upper:]' '[:lower:]')
case "$CONFIGURATION_TAURI" in
  release) ;;
  *) CONFIGURATION_TAURI=debug ;;
esac

# Collect valid arch tokens from ARCHS (space-separated).
_tauri_archs=""
for _a in ${ARCHS-}; do
  case "$_a" in
    '' | undefined_arch | undefined) ;;
    arm64 | x86_64) _tauri_archs="${_tauri_archs} ${_a}" ;;
    *) ;;
  esac
done
_tauri_archs=$(printf '%s' "$_tauri_archs" | awk '{$1=$1}1')

# Xcode often exposes the active slice here when ARCHS is useless.
if [ -z "$_tauri_archs" ]; then
  case "${CURRENT_ARCH-}" in
    arm64 | x86_64) _tauri_archs=${CURRENT_ARCH} ;;
  esac
fi

if [ -z "$_tauri_archs" ]; then
  case "${NATIVE_ARCH-}" in
    arm64 | x86_64) _host=${NATIVE_ARCH} ;;
    *) _host=$(uname -m) ;;
  esac
  case "${PLATFORM_NAME-}" in
    iphonesimulator)
      case "$_host" in
        arm64) _tauri_archs=arm64 ;;
        *) _tauri_archs=x86_64 ;;
      esac
      ;;
    iphoneos | *)
      _tauri_archs=arm64
      ;;
  esac
fi

case "$_tauri_archs" in
  *arm64* | *x86_64*) ;;
  *)
    echo "error: could not resolve Rust arch for Tauri (ARCHS='${ARCHS-}' CURRENT_ARCH='${CURRENT_ARCH-}' PLATFORM_NAME='${PLATFORM_NAME-}')." >&2
    exit 1
    ;;
esac

echo "note: [tauri-ios-xcode] platform=${PLATFORM_DISPLAY_NAME} arch(s)=${_tauri_archs} configuration=${CONFIGURATION_TAURI} (Xcode=${CONFIGURATION}) PLATFORM_NAME=${PLATFORM_NAME-} ARCHS=${ARCHS-} CURRENT_ARCH=${CURRENT_ARCH-} SRCROOT=${SRCROOT:-}" >&2

# Xcode does not guarantee the script's cwd; Tauri expects to start from gen/apple when adjusting paths.
cd "$SRCROOT" || {
  echo "error: could not cd to SRCROOT: $SRCROOT" >&2
  exit 1
}

# Dev host for Local Network warmup in main.mm (must exist before Compile Sources; this phase runs first).
# Physical iPad/iPhone: never default to 192.0.0.2 — iPadOS often routes it via lo0, so NW/URLSession
# never reach the Mac (POSIX 61 / NSURLError -1004). Use the Mac's real Wi‑Fi/LAN IPv4 instead.
_HELIX_ROOT="$(cd "$SRCROOT/../../.." && pwd)"
if [ ! -f "$_HELIX_ROOT/scripts/lib/resolve-ios-dev-host.sh" ]; then
  echo "error: [tauri-ios-xcode] expected $_HELIX_ROOT/scripts/lib/resolve-ios-dev-host.sh" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$_HELIX_ROOT/scripts/lib/resolve-ios-dev-host.sh"

if [ "${PLATFORM_NAME:-}" = "iphonesimulator" ]; then
  _raw="${TAURI_DEV_HOST:-127.0.0.1}"
  case "$_raw" in
    http://*) _raw="${_raw#http://}" ;;
    https://*) _raw="${_raw#https://}" ;;
  esac
  _raw="${_raw%%/*}"
  _raw="${_raw%%:*}"
  _DEV_IP="${_raw:-127.0.0.1}"
  if [ "$_DEV_IP" = "192.0.0.2" ]; then
    _DEV_IP=127.0.0.1
  fi
else
  if ! _DEV_IP="$(pgstudio_resolve_mac_lan_ipv4)"; then
    # Re-source in case the file was added/updated after the first load at script start.
    if [ -f "$SRCROOT/.xcode.env.local" ]; then
      # shellcheck disable=SC1090
      . "$SRCROOT/.xcode.env.local" || true
    fi
    if ! _DEV_IP="$(pgstudio_resolve_mac_lan_ipv4)"; then
      if [ "$CONFIGURATION_TAURI" = "release" ]; then
        _DEV_IP="127.0.0.1"
      else
        echo "warning: [tauri-ios-xcode] No usable Mac LAN IPv4 — using 192.0.0.2 for DevHostConfig so this build can finish." >&2
        echo "  iPad often cannot reach 192.0.0.2 (NW uses lo0). For a working dev server: Wi‑Fi on Mac + iPad, then \`pnpm ios:dev:open\` from helixDB/." >&2
        echo "  Or create gen/apple/.xcode.env.local with: export TAURI_DEV_HOST=\"192.168.x.x\" (your Mac on LAN), then rebuild." >&2
        _DEV_IP="192.0.0.2"
      fi
    fi
  fi
fi

export TAURI_DEV_HOST="$_DEV_IP"

_GEN_HEADER="$SRCROOT/Sources/pgstudio/DevHostConfig.generated.h"
mkdir -p "$(dirname "$_GEN_HEADER")"
{
  printf '%s\n' '/* Generated by apple-scripts/tauri-ios-xcode.sh — do not edit. */'
  printf '#define PGSTUDIO_DEV_HOST_IP "%s"\n' "$_DEV_IP"
} >"$_GEN_HEADER"
echo "note: [tauri-ios-xcode] PGSTUDIO_DEV_HOST_IP=${_DEV_IP} (exported TAURI_DEV_HOST for this build)" >&2

# When Xcode is launched from `pnpm ios:dev:open`, PNPM_* / npm lifecycle vars leak into the build.
# Tauri CLI then skips its gen/apple -> src-tauri chdir and resolve_dirs() only walks *down* from cwd,
# so it never finds tauri.conf.json (panic in app_paths.rs).
TAURI_APP_PATH=$(cd "$SRCROOT/../.." && pwd)
export TAURI_APP_PATH
if [ ! -f "$TAURI_APP_PATH/tauri.conf.json" ] && [ ! -f "$TAURI_APP_PATH/tauri.conf.json5" ] && [ ! -f "$TAURI_APP_PATH/Tauri.toml" ]; then
  echo "error: no Tauri config under TAURI_APP_PATH=$TAURI_APP_PATH (expected SRCROOT=.../src-tauri/gen/apple)." >&2
  exit 1
fi
unset PNPM_PACKAGE_NAME npm_lifecycle_event 2>/dev/null || true

# Do not pass --framework-search-paths "" etc. Empty values break clap parsing so the arch positional
# is mis-read and you get "Arch specified by Xcode was invalid".
set -- cargo tauri ios xcode-script -v \
  --platform "$PLATFORM_DISPLAY_NAME" \
  --sdk-root "$SDKROOT"

if [ -n "${FRAMEWORK_SEARCH_PATHS:-}" ]; then
  set -- "$@" --framework-search-paths "$FRAMEWORK_SEARCH_PATHS"
fi
if [ -n "${HEADER_SEARCH_PATHS:-}" ]; then
  set -- "$@" --header-search-paths "$HEADER_SEARCH_PATHS"
fi
if [ -n "${GCC_PREPROCESSOR_DEFINITIONS:-}" ]; then
  set -- "$@" --gcc-preprocessor-definitions "$GCC_PREPROCESSOR_DEFINITIONS"
fi

set -- "$@" --configuration "$CONFIGURATION_TAURI"

case "${FORCE_COLOR:-}" in
  1 | true | TRUE | yes | YES | --force-color)
    set -- "$@" --force-color
    ;;
esac

for _arch in ${_tauri_archs}; do
  set -- "$@" "$_arch"
done

exec "$@"
