#!/usr/bin/env bash
# One script: build → sign app → create .pkg → upload to TestFlight.
# Set env once (or use apple/.env with source), then run: ./apple/build-and-upload-testflight.sh
#
# Required env:
#   SIGNING_IDENTITY      "Apple Distribution: Name (TEAM_ID)" or its SHA-1 fingerprint (if ambiguous)
#   INSTALLER_IDENTITY    "3rd Party Mac Developer Installer: Name (TEAM_ID)" or SHA-1 fingerprint
#   APPLE_API_KEY_ID      from App Store Connect → Integrations → Keys
#   APPLE_API_ISSUER      Issuer ID from same page
#   APPLE_API_KEY_PATH    /path/to/AuthKey_XXXXXXXX.p8
# Get identities: security find-identity -v -p codesigning (use fingerprint hex to avoid duplicate-cert ambiguity)

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"
ENTITLEMENTS_SRC="$REPO_ROOT/src-tauri/Entitlements.plist"

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
[[ -z "$SIGN_ID" ]]           && { echo "Missing: SIGNING_IDENTITY (Apple Distribution: ...)"; err=1; }
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
if [[ "$INSTALL_ID" == *"Apple Distribution"* ]]; then
  echo "Error: INSTALLER_IDENTITY must be '3rd Party Mac Developer Installer: ...', not 'Apple Distribution'."
  echo "The .pkg needs an installer cert; the app uses Apple Distribution. Run: security find-identity -v -p codesigning"
  echo "Set INSTALLER_IDENTITY to the line that says '3rd Party Mac Developer Installer'. See apple/INSTALLER-CERT-SETUP.md to create it."
  exit 1
fi

cd "$REPO_ROOT"

# Resolve TEAM_ID for entitlements (must match provisioning profile)
TEAM_ID="${APPLE_TEAM_ID:-}"
[[ -z "$TEAM_ID" ]] && TEAM_ID=$(echo "$SIGN_ID" | sed -n 's/.*(\([^)]*\)).*/\1/p')
if [[ -z "$TEAM_ID" ]]; then
  echo "Could not get Team ID. Set APPLE_TEAM_ID in apple/.env (e.g. V9G53UFKD3) or use SIGNING_IDENTITY that contains (TEAM_ID)."
  exit 1
fi
ENTITLEMENTS=$(mktemp)
sed "s/TEAM_ID/$TEAM_ID/g" "$ENTITLEMENTS_SRC" > "$ENTITLEMENTS"
grep -q 'TEAM_ID' "$ENTITLEMENTS" && { echo "ERROR: entitlements still contain literal TEAM_ID (sed failed or plist changed)"; exit 1; }
trap "rm -f '$ENTITLEMENTS'" EXIT
echo "Using Team ID: $TEAM_ID"

echo "=== 1. Build (universal macOS for App Store) ==="
unset CI
cargo tauri build --target universal-apple-darwin

APP_PATH="$REPO_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
  [[ ! -d "$APP_PATH" ]] && { echo "Build failed: no $APP_NAME.app found"; exit 1; }
fi

echo "=== 2. Check profile matches signing cert (avoid 409) ==="
PROFILE="$REPO_ROOT/apple/pgstudio.provisionprofile"
if [[ -f "$PROFILE" ]] && [[ -f "$REPO_ROOT/apple/check-profile-cert.sh" ]]; then
  SIGN_ID="$SIGN_ID" PROFILE="$PROFILE" bash "$REPO_ROOT/apple/check-profile-cert.sh" || exit 1
fi

echo "=== 3. Sign app ==="
# Sign main binary first so entitlements (with real Team ID) are on the executable; then the bundle
BINARY="$APP_PATH/Contents/MacOS/pgstudio"
if [[ -f "$BINARY" ]]; then
  codesign --force --sign "$SIGN_ID" --entitlements "$ENTITLEMENTS" "$BINARY"
fi
codesign --deep --force --verify --verbose \
  --sign "$SIGN_ID" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"
echo "Verify: $(codesign -dv --verbose=4 "$APP_PATH" 2>&1 | head -3)"

echo "=== 4. Create signed .pkg ==="
PKG_PATH="$REPO_ROOT/$PKG_NAME"
xcrun productbuild --sign "$INSTALL_ID" \
  --component "$APP_PATH" /Applications \
  "$PKG_PATH"

echo "=== 5. Upload to TestFlight ==="
# altool looks for the key by filename in repo/private_keys, ~/private_keys, etc. Copy there so it finds it.
KEY_NAME=$(basename "$KEY_PATH")
ALTOOL_KEY_DIR="$REPO_ROOT/private_keys"
mkdir -p "$ALTOOL_KEY_DIR"
ALTOOL_KEY_PATH="$ALTOOL_KEY_DIR/$KEY_NAME"
cp -f "$KEY_PATH" "$ALTOOL_KEY_PATH"
xcrun altool --upload-app --type macos --file "$PKG_PATH" \
  --apiKey "$KEY_ID" \
  --apiIssuer "$ISSUER" \
  --apiKeyPath "$ALTOOL_KEY_PATH"

echo ""
echo "Done. Build will appear in App Store Connect → pgStudio → TestFlight (5–15 min)."
echo "Optional: rm $PKG_PATH"
