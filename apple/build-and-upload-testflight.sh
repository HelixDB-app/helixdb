#!/usr/bin/env bash
# One script: bump build number → build → sign app → create .pkg → upload to TestFlight.
# Set env once (or use apple/.env with source), then run: ./apple/build-and-upload-testflight.sh
#
# Options:
#   --no-bump    Skip bumping the build number (use current bundle.macOS.bundleVersion).
#
# Required env:
#   SIGNING_IDENTITY      "Apple Distribution: Name (TEAM_ID)" or its SHA-1 fingerprint (if ambiguous)
#   INSTALLER_IDENTITY    "3rd Party Mac Developer Installer: Name (TEAM_ID)" or SHA-1 fingerprint
#   APPLE_API_KEY_ID      from App Store Connect → Integrations → Keys
#   APPLE_API_ISSUER      Issuer ID from same page
#   APPLE_API_KEY_PATH    /path/to/AuthKey_XXXXXXXX.p8
# Optional (fixes altool ERROR 12 "Cannot determine the Apple ID from Bundle ID … MAC_OS"):
#   APP_STORE_CONNECT_APP_ID   Numeric App ID from App Store Connect → your app → App Information → General
#   APPLE_PROVIDER_PUBLIC_ID   From: xcrun altool --list-providers --api-key … --api-issuer … --p8-file-path …
#   APPLE_ASC_PUBLIC_ID        Alternative provider id if your account requires --asc-public-id
# Get identities: security find-identity -v -p codesigning (use fingerprint hex to avoid duplicate-cert ambiguity)
#
# Bundle ID in tauri.conf.json → identifier must match the macOS app in App Store Connect (e.g. com.pgstudio.helixdb).

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
PKG_NAME="pgStudio.pkg"
ENTITLEMENTS_SRC="$REPO_ROOT/src-tauri/Entitlements.plist"
TAURI_CONF="$REPO_ROOT/src-tauri/tauri.conf.json"
BUMP_BUILD=1
for arg in "$@"; do
  [[ "$arg" == "--no-bump" ]] && BUMP_BUILD=0
done

# Optional: load apple/.env if present
if [[ -f "$REPO_ROOT/apple/.env" ]]; then
  set -a
  source "$REPO_ROOT/apple/.env"
  set +a
fi
# Load repo root .env for GITHUB_CLIENT_ID/SECRET (embedded at build time for TestFlight)
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
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
  echo "The .pkg needs an installer cert. Run: security find-identity -v -p macappstore"
  echo "Set INSTALLER_IDENTITY in apple/.env to the fingerprint of '3rd Party Mac Developer Installer'."
  exit 1
fi
if [[ "$INSTALL_ID" == *"3rd Party Mac Developer Application"* ]]; then
  echo "Error: INSTALLER_IDENTITY must be '3rd Party Mac Developer Installer', not 'Application'."
  echo "Run: security find-identity -v -p macappstore"
  echo "Set INSTALLER_IDENTITY in apple/.env to the 40-char hex of the line that says '3rd Party Mac Developer Installer'."
  exit 1
fi

cd "$REPO_ROOT"
source "$REPO_ROOT/apple/tauri-cli.sh"

# ── Bump build number (CFBundleVersion) for TestFlight ─────────────────────
export TAURI_CONF_PATH="$TAURI_CONF"
if [[ $BUMP_BUILD -eq 1 ]]; then
  if [[ ! -f "$TAURI_CONF" ]]; then
    echo "Error: $TAURI_CONF not found"
    exit 1
  fi
  BUILD_NOW=$(node -e '
    const fs = require("fs");
    const p = process.env.TAURI_CONF_PATH;
    const conf = JSON.parse(fs.readFileSync(p, "utf8"));
    const mac = conf.bundle && conf.bundle.macOS ? conf.bundle.macOS : {};
    let n = parseInt(mac.bundleVersion || "0", 10) || 0;
    n++;
    conf.bundle = conf.bundle || {};
    conf.bundle.macOS = { ...mac, bundleVersion: String(n) };
    fs.writeFileSync(p, JSON.stringify(conf, null, 2));
    console.log(n);
  ')
  MARKETING=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log(c.version);')
  echo "=== Build number set to $BUILD_NOW (version $MARKETING) ==="
else
  BUILD_NOW=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log((c.bundle&&c.bundle.macOS&&c.bundle.macOS.bundleVersion)||"1");')
  MARKETING=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log(c.version);')
  echo "=== Using existing build number: $BUILD_NOW (--no-bump) ==="
fi

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

echo "=== 1. Build (macOS for App Store) ==="
# Build for host arch only to avoid OpenSSL cross-compilation (universal would need x86_64 OpenSSL).
# GITHUB_CLIENT_ID/SECRET from .env are embedded at compile time so TestFlight build has GitHub integration.
ARCH=$(uname -m)
[[ "$ARCH" == "arm64" ]] && TARGET="aarch64-apple-darwin" || TARGET="x86_64-apple-darwin"
echo "Target: $TARGET"
unset CI
export GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-}"
export GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-}"
"$TAURI_CLI" build --target "$TARGET"

APP_PATH="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
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
# Xcode 15+ altool expects JWT via --api-key / --api-issuer / --p8-file-path (not --apiKeyPath to a file).
# It also searches ./private_keys for AuthKey_<KEY_ID>.p8 when only --api-key is set.
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

BUNDLE_ID=$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.TAURI_CONF_PATH,"utf8")); console.log(c.identifier);')

AUTH=(--api-key "$KEY_ID" --api-issuer "$ISSUER" --p8-file-path "$NORMALIZED_KEY")

ALTLOG=$(mktemp)
trap "rm -f '$ENTITLEMENTS' '$ALTLOG'" EXIT

run_altool_upload() {
  set +e
  "$@" 2>&1 | tee "$ALTLOG"
  local ec=${PIPESTATUS[0]}
  set -e
  if [[ $ec -ne 0 ]] || grep -q 'UPLOAD FAILED' "$ALTLOG" || grep -qi '^Upload failed' "$ALTLOG"; then
    echo ""
    echo "TestFlight upload failed (altool exit $ec). Fix validation errors above — this run is not successful."
    exit 1
  fi
}

if [[ -n "${APP_STORE_CONNECT_APP_ID:-}" ]]; then
  echo "Using upload-package with explicit App Store Connect app id (avoids bundle-id → Apple ID lookup)."
  run_altool_upload xcrun altool --upload-package "$PKG_PATH" -t macos \
    --apple-id "$APP_STORE_CONNECT_APP_ID" \
    --bundle-version "$BUILD_NOW" \
    --bundle-short-version-string "$MARKETING" \
    --bundle-id "$BUNDLE_ID" \
    "${ALT_EX[@]}" \
    "${AUTH[@]}" \
    --show-progress
else
  echo "Using upload-app. If altool logs ERROR (12) about Bundle ID / Apple ID but exits 0, the upload still succeeded."
  echo "To silence it, set APP_STORE_CONNECT_APP_ID in apple/.env (numeric id from App Store Connect → App Information)."
  run_altool_upload xcrun altool --upload-app -f "$PKG_PATH" \
    "${ALT_EX[@]}" \
    "${AUTH[@]}" \
    --show-progress
fi

rm -f "$ALTLOG"
trap "rm -f '$ENTITLEMENTS'" EXIT

echo ""
echo "Done. Version $MARKETING (build $BUILD_NOW) uploaded."
echo "Build will appear in App Store Connect → pgStudio → TestFlight (5–15 min)."
echo "Optional: rm $PKG_PATH"
