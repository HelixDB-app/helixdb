#!/usr/bin/env bash
# Build → sign app → create signed .pkg for upload via Transporter (no altool upload).
# Requires: SIGNING_IDENTITY (Apple Distribution), INSTALLER_IDENTITY (3rd Party Mac Developer **Installer**).
# Get installer fingerprint: security find-identity -v -p macappstore

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"
ENTITLEMENTS_SRC="$REPO_ROOT/src-tauri/Entitlements.plist"

if [[ -f "$REPO_ROOT/apple/.env" ]]; then
  set -a; source "$REPO_ROOT/apple/.env"; set +a
fi

SIGN_ID="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
INSTALL_ID="${APPLE_INSTALLER_IDENTITY:-$INSTALLER_IDENTITY}"

[[ -z "$SIGN_ID" ]] && { echo "Missing: SIGNING_IDENTITY in apple/.env"; exit 1; }
[[ -z "$INSTALL_ID" ]] && { echo "Missing: INSTALLER_IDENTITY in apple/.env"; exit 1; }
if [[ "$INSTALL_ID" == *"3rd Party Mac Developer Application"* ]]; then
  echo "Error: INSTALLER_IDENTITY must be '3rd Party Mac Developer Installer', not 'Application'."
  echo "Run: security find-identity -v -p macappstore"
  echo "Set INSTALLER_IDENTITY in apple/.env to the 40-char hex of '3rd Party Mac Developer Installer'."
  exit 1
fi

TEAM_ID="${APPLE_TEAM_ID:-}"
[[ -z "$TEAM_ID" ]] && TEAM_ID=$(echo "$SIGN_ID" | sed -n 's/.*(\([^)]*\)).*/\1/p')
[[ -z "$TEAM_ID" ]] && { echo "Set APPLE_TEAM_ID in apple/.env"; exit 1; }

ENTITLEMENTS=$(mktemp)
sed "s/TEAM_ID/$TEAM_ID/g" "$ENTITLEMENTS_SRC" > "$ENTITLEMENTS"
grep -q 'TEAM_ID' "$ENTITLEMENTS" && { echo "ERROR: entitlements still contain TEAM_ID"; exit 1; }
trap "rm -f '$ENTITLEMENTS'" EXIT

cd "$REPO_ROOT"

echo "=== 1. Build (universal macOS) ==="
unset CI
cargo tauri build --target universal-apple-darwin

APP_PATH="$REPO_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/$APP_NAME.app"
[[ ! -d "$APP_PATH" ]] && APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
[[ ! -d "$APP_PATH" ]] && { echo "Build failed: no $APP_NAME.app"; exit 1; }

echo "=== 2. Check profile matches cert ==="
if [[ -f "$REPO_ROOT/apple/check-profile-cert.sh" ]]; then
  SIGN_ID="$SIGN_ID" PROFILE="$REPO_ROOT/apple/pgstudio.provisionprofile" bash "$REPO_ROOT/apple/check-profile-cert.sh" || exit 1
fi

echo "=== 3. Sign app ==="
BINARY="$APP_PATH/Contents/MacOS/pgstudio"
[[ -f "$BINARY" ]] && codesign --force --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$BINARY"
codesign --deep --force --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$APP_PATH"

echo "=== 4. Create signed .pkg ==="
PKG_PATH="$REPO_ROOT/$PKG_NAME"
xcrun productbuild --sign "$INSTALL_ID" --component "$APP_PATH" /Applications "$PKG_PATH"

echo ""
echo "Done. pkg: $PKG_PATH"
echo "Upload: open -a Transporter, sign in, then drag pgStudio.pkg into the window and click Deliver."
exit 0
