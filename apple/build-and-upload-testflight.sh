#!/usr/bin/env bash
# One script: build → sign app → create .pkg → upload to TestFlight.
# Set env once (or use apple/.env with source), then run: ./apple/build-and-upload-testflight.sh
#
# Required env:
#   SIGNING_IDENTITY      "3rd Party Mac Developer Application: Your Name (TEAM_ID)"
#   INSTALLER_IDENTITY    "3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
#   APPLE_API_KEY_ID      from App Store Connect → Integrations → Keys
#   APPLE_API_ISSUER      Issuer ID from same page
#   APPLE_API_KEY_PATH    /path/to/AuthKey_XXXXXXXX.p8
# Get identities: security find-identity -v -p codesigning

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements.plist"

# Optional: load apple/.env if present
if [[ -f "$REPO_ROOT/apple/.env" ]]; then
  set -a
  source "$REPO_ROOT/apple/.env"
  set +a
fi

SIGN_ID="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
INSTALL_ID="${APPLE_INSTALLER_IDENTITY:-$INSTALLER_IDENTITY}"
KEY_ID="${APPLE_API_KEY_ID:-$APPLE_API_KEY}"
ISSUER="${APPLE_API_ISSUER}"
KEY_PATH="${APPLE_API_KEY_PATH}"
# Resolve relative path (e.g. apple/AuthKey_XXX.p8) against repo root
[[ -n "$KEY_PATH" && "$KEY_PATH" != /* ]] && KEY_PATH="$REPO_ROOT/$KEY_PATH"

# Validate env
err=0
[[ -z "$SIGN_ID" ]]           && { echo "Missing: SIGNING_IDENTITY (3rd Party Mac Developer Application: ...)"; err=1; }
[[ -z "$INSTALL_ID" ]]        && { echo "Missing: INSTALLER_IDENTITY (3rd Party Mac Developer Installer: ...)"; err=1; }
[[ -z "$KEY_ID" ]]            && { echo "Missing: APPLE_API_KEY_ID"; err=1; }
[[ -z "$ISSUER" ]]            && { echo "Missing: APPLE_API_ISSUER"; err=1; }
[[ -z "$KEY_PATH" ]]          && { echo "Missing: APPLE_API_KEY_PATH"; err=1; }
[[ -n "$KEY_PATH" && ! -f "$KEY_PATH" ]] && { echo "File not found: APPLE_API_KEY_PATH ($KEY_PATH)"; err=1; }
if [[ $err -eq 1 ]]; then
  echo ""; echo "Get identities: security find-identity -v -p codesigning"
  echo "Create API key: App Store Connect → Users and Access → Integrations → Keys"
  exit 1
fi
if [[ "$INSTALL_ID" == *"Apple Development"* ]]; then
  echo "Error: INSTALLER_IDENTITY must be '3rd Party Mac Developer Installer: ...', not 'Apple Development'."
  echo "Create it: Apple Developer → Certificates → + → Mac Installer Distribution. Install the cert, then:"
  echo "  security find-identity -v -p codesigning"
  echo "Set INSTALLER_IDENTITY in apple/.env to the '3rd Party Mac Developer Installer' line."
  exit 1
fi

cd "$REPO_ROOT"

echo "=== 1. Build ==="
unset CI
cargo tauri build

APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
for TARGET in universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin; do
  P="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
  if [[ -d "$P" ]]; then APP_PATH="$P"; break; fi
done
if [[ ! -d "$APP_PATH" ]]; then
  echo "Build failed: no $APP_NAME.app found"; exit 1
fi

echo "=== 2. Sign app ==="
codesign --deep --force --verify --verbose \
  --sign "$SIGN_ID" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"

echo "=== 3. Create signed .pkg ==="
PKG_PATH="$REPO_ROOT/$PKG_NAME"
xcrun productbuild --sign "$INSTALL_ID" \
  --component "$APP_PATH" /Applications \
  "$PKG_PATH"

echo "=== 4. Upload to TestFlight ==="
xcrun altool --upload-app --type macos --file "$PKG_PATH" \
  --apiKey "$KEY_ID" \
  --apiIssuer "$ISSUER" \
  --apiKeyPath "$KEY_PATH"

echo ""
echo "Done. Build will appear in App Store Connect → pgStudio → TestFlight (5–15 min)."
echo "Optional: rm $PKG_PATH"
