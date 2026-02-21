#!/usr/bin/env bash
# Build + sign with Developer ID + notarize → .dmg that works on other Macs when shared.
# Use this to share the app directly (link/USB); no TestFlight needed.
#
# Prereqs:
# 1. Apple Developer: create "Developer ID Application" certificate. Install in Keychain.
# 2. Get identity: security find-identity -v -p codesigning
#    Use the line "Developer ID Application: Your Name (TEAM_ID)".
# 3. Set in apple/.env (or export):
#    DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
#    APPLE_API_KEY_ID=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=path/to/AuthKey_XXX.p8

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
# Developer ID: no com.apple.application-identifier (App Store only); add network for DB app
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements-devid.plist"

[[ -f "$REPO_ROOT/apple/.env" ]] && set -a && source "$REPO_ROOT/apple/.env" && set +a

SIGN_ID="${DEVELOPER_ID_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
KEY_ID="${APPLE_API_KEY_ID:-$APPLE_API_KEY}"
ISSUER="${APPLE_API_ISSUER}"
KEY_PATH="${APPLE_API_KEY_PATH}"
[[ -n "$KEY_PATH" && "$KEY_PATH" != /* ]] && KEY_PATH="$REPO_ROOT/$KEY_PATH"

if [[ -z "$SIGN_ID" ]]; then
  echo "Set DEVELOPER_ID_SIGNING_IDENTITY (Developer ID Application: ...) in apple/.env"
  echo "Get it: security find-identity -v -p codesigning"
  exit 1
fi
if [[ "$SIGN_ID" != *"Developer ID Application"* ]]; then
  echo "DEVELOPER_ID_SIGNING_IDENTITY must be 'Developer ID Application: ...', not Apple Development/Distribution."
  echo "Create it: Apple Developer → Certificates → + → Developer ID Application. Install, then set in apple/.env"
  exit 1
fi
if [[ -z "$KEY_ID" || -z "$ISSUER" || -z "$KEY_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Set APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH in apple/.env (for notarization)"
  exit 1
fi

cd "$REPO_ROOT"

echo "=== 1. Build ==="
unset CI
cargo tauri build

APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
[[ ! -d "$APP_PATH" ]] && APP_PATH="$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "No .app found"; exit 1
fi

echo "=== 2. Sign with Developer ID (with secure timestamp) ==="
# Sign main binary first so it's definitely Developer ID + timestamp; then the bundle
BINARY="$APP_PATH/Contents/MacOS/pgstudio"
if [[ -f "$BINARY" ]]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" \
    --entitlements "$ENTITLEMENTS" \
    "$BINARY"
fi
codesign --deep --force --options runtime --timestamp --sign "$SIGN_ID" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"

# Create a new DMG containing the signed .app (Tauri's DMG has the pre-sign app)
DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
SHAREABLE_DMG="$DMG_DIR/pgStudio_shareable.dmg"
mkdir -p "$DMG_DIR"
rm -f "$SHAREABLE_DMG"

echo "=== 3. Create DMG ==="
TMP_DMG="$REPO_ROOT/src-tauri/target/release/bundle/dmg/tmp_pgStudio.dmg"
hdiutil create -volname "pgStudio" -srcfolder "$APP_PATH" -ov -format UDZO "$TMP_DMG"
mv "$TMP_DMG" "$SHAREABLE_DMG"

echo "=== 4. Sign DMG (with secure timestamp) ==="
codesign --force --timestamp --sign "$SIGN_ID" "$SHAREABLE_DMG"

echo "=== 5. Notarize (submit, then poll to avoid timeout) ==="
SUBMIT_OUT=$(mktemp)
if ! xcrun notarytool submit "$SHAREABLE_DMG" \
  --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>&1 | tee "$SUBMIT_OUT"; then
  echo "Notarization submit failed."
  rm -f "$SUBMIT_OUT"
  exit 1
fi
SUB_ID=$(sed -n 's/^  id: //p' "$SUBMIT_OUT" | head -1)
rm -f "$SUBMIT_OUT"
if [[ -z "$SUB_ID" ]]; then
  echo "Could not get submission ID."
  exit 1
fi
echo "Submission ID: $SUB_ID"
echo "Polling for result (every 30s, max 15 min)..."
MAX_ATTEMPTS=30
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  sleep 30
  LOG=$(xcrun notarytool log "$SUB_ID" --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>/dev/null || true)
  if echo "$LOG" | grep -q '"status": "Accepted"'; then
    echo "Notarization Accepted."
    break
  fi
  if echo "$LOG" | grep -q '"status": "Invalid"'; then
    echo ""
    echo "Notarization Invalid:"
    echo "$LOG"
    echo "Fix the issues above, then re-run this script."
    exit 1
  fi
  echo "  attempt $i/$MAX_ATTEMPTS: still in progress..."
  if [[ $i -eq $MAX_ATTEMPTS ]]; then
    echo "Timed out. Check later: xcrun notarytool log $SUB_ID --key \"$KEY_PATH\" --key-id $KEY_ID --issuer $ISSUER"
    echo "If Accepted, run: xcrun stapler staple \"$SHAREABLE_DMG\""
    exit 1
  fi
done

echo "=== 6. Staple ticket to DMG ==="
xcrun stapler staple "$SHAREABLE_DMG"

echo ""
echo "Done. Share this file; it will open on other Macs:"
echo "  $SHAREABLE_DMG"
