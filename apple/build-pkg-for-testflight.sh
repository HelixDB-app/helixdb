#!/usr/bin/env bash
# Build + sign app + create .pkg only. Upload to TestFlight yourself via Xcode Transporter.
# No API key needed. Set in apple/.env: SIGNING_IDENTITY, INSTALLER_IDENTITY.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"
ENTITLEMENTS_SRC="$REPO_ROOT/src-tauri/Entitlements.plist"

[[ -f "$REPO_ROOT/apple/.env" ]] && set -a && source "$REPO_ROOT/apple/.env" && set +a

SIGN_ID="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
INSTALL_ID="${APPLE_INSTALLER_IDENTITY:-$INSTALLER_IDENTITY}"
[[ -z "$SIGN_ID" ]] && { echo "Set SIGNING_IDENTITY in apple/.env"; exit 1; }
[[ -z "$INSTALL_ID" ]] && { echo "Set INSTALLER_IDENTITY in apple/.env"; exit 1; }

TEAM_ID="${APPLE_TEAM_ID:-}"
[[ -z "$TEAM_ID" ]] && TEAM_ID=$(echo "$SIGN_ID" | sed -n 's/.*(\([^)]*\)).*/\1/p')
[[ -z "$TEAM_ID" ]] && { echo "Set APPLE_TEAM_ID in apple/.env (e.g. V9G53UFKD3) or use SIGNING_IDENTITY with (TEAM_ID)"; exit 1; }
ENTITLEMENTS=$(mktemp)
sed "s/TEAM_ID/$TEAM_ID/g" "$ENTITLEMENTS_SRC" > "$ENTITLEMENTS"
grep -q 'TEAM_ID' "$ENTITLEMENTS" && { echo "ERROR: entitlements still contain literal TEAM_ID"; exit 1; }
trap "rm -f '$ENTITLEMENTS'" EXIT
echo "Using Team ID: $TEAM_ID"

cd "$REPO_ROOT"
source "$REPO_ROOT/apple/tauri-cli.sh"

echo "=== 1. Build ==="
unset CI
"$TAURI_CLI" build

APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
for TARGET in universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin; do
  P="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
  if [[ -d "$P" ]]; then APP_PATH="$P"; break; fi
done
[[ ! -d "$APP_PATH" ]] && { echo "No .app found"; exit 1; }

echo "=== 2. Sign app ==="
BINARY="$APP_PATH/Contents/MacOS/pgstudio"
if [[ -f "$BINARY" ]]; then
  codesign --force --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$BINARY"
fi
codesign --deep --force --verify --verbose --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$APP_PATH"

echo "=== 3. Create signed .pkg ==="
PKG_PATH="$REPO_ROOT/$PKG_NAME"
xcrun productbuild --sign "$INSTALL_ID" --component "$APP_PATH" /Applications "$PKG_PATH"

echo ""
echo "Done. Upload this file with Xcode Transporter:"
echo "  $PKG_PATH"
echo ""
echo "Open Transporter (Mac App Store or Xcode → Open Developer Tool → Transporter), sign in, drag the .pkg in, click Deliver."
