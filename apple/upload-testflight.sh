#!/usr/bin/env bash
# Build a signed .pkg and upload to App Store Connect (TestFlight).
# Prereqs: app already built and signed (./apple/codesign-app.sh).
#
# 1. Create API key: App Store Connect → Users and Access → Integrations → Keys
#    Download the .p8 once; note Key ID and Issuer ID.
# 2. Get installer identity: security find-identity -v -p codesigning
#    Use "3rd Party Mac Developer Installer: Your Name (TEAM_ID)".
# 3. Set env and run:
#    export INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
#    export APPLE_API_KEY_ID=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=/path/to/AuthKey_XXX.p8
#    ./apple/upload-testflight.sh

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"

# Find .app (same paths as codesign-app.sh)
APP_PATH=""
if [[ -d "$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app" ]]; then
  APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
else
  for TARGET in universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin; do
    if [[ -d "$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app" ]]; then
      APP_PATH="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
      break
    fi
  done
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "No built app found. Run: pnpm tauri build  then  ./apple/codesign-app.sh"
  exit 1
fi

INSTALLER_IDENTITY="${APPLE_INSTALLER_IDENTITY:-$INSTALLER_IDENTITY}"
if [[ -z "$INSTALLER_IDENTITY" ]]; then
  echo "Set installer identity (for .pkg signing):"
  echo '  export INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"'
  echo "Get it from: security find-identity -v -p codesigning"
  exit 1
fi

KEY_ID="${APPLE_API_KEY_ID:-$APPLE_API_KEY}"
ISSUER="${APPLE_API_ISSUER}"
KEY_PATH="${APPLE_API_KEY_PATH}"
if [[ -z "$KEY_ID" || -z "$ISSUER" || -z "$KEY_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Set App Store Connect API key:"
  echo "  export APPLE_API_KEY_ID=your_key_id"
  echo "  export APPLE_API_ISSUER=your_issuer_id"
  echo "  export APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8"
  exit 1
fi

PKG_PATH="$REPO_ROOT/$PKG_NAME"
echo "Building signed .pkg..."
xcrun productbuild --sign "$INSTALLER_IDENTITY" \
  --component "$APP_PATH" /Applications \
  "$PKG_PATH"

echo "Uploading to App Store Connect..."
ALTOOL_KEY_DIR="$REPO_ROOT/private_keys"
mkdir -p "$ALTOOL_KEY_DIR"
NORMALIZED_KEY="$ALTOOL_KEY_DIR/AuthKey_${KEY_ID}.p8"
cp -f "$KEY_PATH" "$NORMALIZED_KEY"
chmod 600 "$NORMALIZED_KEY"
export API_PRIVATE_KEYS_DIR="$ALTOOL_KEY_DIR"

ALT_EX=()
[[ -n "${APPLE_PROVIDER_PUBLIC_ID:-}" ]] && ALT_EX+=(--provider-public-id "$APPLE_PROVIDER_PUBLIC_ID")
[[ -n "${APPLE_ASC_PUBLIC_ID:-}" ]] && ALT_EX+=(--asc-public-id "$APPLE_ASC_PUBLIC_ID")
[[ -n "${APPLE_ALTTOOL_TEAM_ID:-}" ]] && ALT_EX+=(--team-id "$APPLE_ALTTOOL_TEAM_ID")

export TAURI_CONF_PATH="$REPO_ROOT/src-tauri/tauri.conf.json"
BUNDLE_ID=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log(c.identifier);')
MARKETING=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log(c.version);')
BUILD_NOW=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log((c.bundle&&c.bundle.macOS&&c.bundle.macOS.bundleVersion)||"1");')

AUTH=(--api-key "$KEY_ID" --api-issuer "$ISSUER" --p8-file-path "$NORMALIZED_KEY")

ALTLOG=$(mktemp)
run_altool_upload() {
  set +e
  "$@" 2>&1 | tee "$ALTLOG"
  local ec=${PIPESTATUS[0]}
  set -e
  local fail=0
  [[ $ec -ne 0 ]] && fail=1
  grep -q 'UPLOAD FAILED' "$ALTLOG" && fail=1
  grep -qi '^Upload failed' "$ALTLOG" && fail=1
  rm -f "$ALTLOG"
  if [[ $fail -ne 0 ]]; then
    echo ""
    echo "TestFlight upload failed (altool exit $ec). See errors above."
    exit 1
  fi
}

if [[ -n "${APP_STORE_CONNECT_APP_ID:-}" ]]; then
  run_altool_upload xcrun altool --upload-package "$PKG_PATH" -t macos \
    --apple-id "$APP_STORE_CONNECT_APP_ID" \
    --bundle-version "$BUILD_NOW" \
    --bundle-short-version-string "$MARKETING" \
    --bundle-id "$BUNDLE_ID" \
    "${ALT_EX[@]}" \
    "${AUTH[@]}" \
    --show-progress
else
  run_altool_upload xcrun altool --upload-app -f "$PKG_PATH" \
    "${ALT_EX[@]}" \
    "${AUTH[@]}" \
    --show-progress
fi

echo "Done. Build will appear in App Store Connect → your app → TestFlight (may take 5–15 min)."
echo "Optional: rm $PKG_PATH"
