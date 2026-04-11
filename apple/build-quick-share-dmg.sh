#!/usr/bin/env bash
# Build + sign with Developer ID and create a DMG. No notarization (no API key or wait).
# Share this DMG; testers open it once via right-click → Open (or System Settings → Open Anyway).
#
# Prereq: Developer ID Application cert in Keychain. In apple/.env set:
#   DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
# Get it: security find-identity -v -p codesigning

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements-devid.plist"

[[ -f "$REPO_ROOT/apple/.env" ]] && set -a && source "$REPO_ROOT/apple/.env" && set +a

SIGN_ID="${DEVELOPER_ID_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
if [[ -z "$SIGN_ID" ]]; then
  echo "Set DEVELOPER_ID_SIGNING_IDENTITY in apple/.env"
  echo "Get it: security find-identity -v -p codesigning"
  exit 1
fi
if [[ "$SIGN_ID" != *"Developer ID Application"* ]]; then
  echo "DEVELOPER_ID_SIGNING_IDENTITY must be 'Developer ID Application: ...'"
  exit 1
fi

cd "$REPO_ROOT"
source "$REPO_ROOT/apple/tauri-cli.sh"

echo "=== 1. Build ==="
unset CI
"$TAURI_CLI" build

APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
[[ ! -d "$APP_PATH" ]] && APP_PATH="$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "No .app found"; exit 1
fi

echo "=== 2. Sign with Developer ID ==="
BINARY="$APP_PATH/Contents/MacOS/pgstudio"
[[ -f "$BINARY" ]] && codesign --force --options runtime --timestamp --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$BINARY"
codesign --deep --force --options runtime --timestamp --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$APP_PATH"

DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
SHAREABLE_DMG="$DMG_DIR/pgStudio_quick_share.dmg"
mkdir -p "$DMG_DIR"
rm -f "$SHAREABLE_DMG"

echo "=== 3. Create and sign DMG ==="
TMP_DMG="$REPO_ROOT/src-tauri/target/release/bundle/dmg/tmp_pgStudio.dmg"
hdiutil create -volname "pgStudio" -srcfolder "$APP_PATH" -ov -format UDZO "$TMP_DMG"
mv "$TMP_DMG" "$SHAREABLE_DMG"
codesign --force --timestamp --sign "$SIGN_ID" "$SHAREABLE_DMG"

echo ""
echo "Done. Share this file (e.g. upload to Google Drive / Dropbox / WeTransfer and send the link):"
echo "  $SHAREABLE_DMG"
echo ""
echo "Tester (first open): Right-click pgStudio → choose 'Open' (not double-click). Or if already blocked: System Settings → Privacy & Security → Open Anyway."
