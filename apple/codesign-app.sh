#!/usr/bin/env bash
# Sign pgStudio.app for Mac App Store / TestFlight.
# 1. Build first: cargo tauri build  (or pnpm tauri build)
# 2. Get your identity: security find-identity -v -p codesigning
# 3. Set it: export SIGNING_IDENTITY="3rd Party Mac Developer Application: Your Name (TEAMID)"
# 4. Run: ./apple/codesign-app.sh

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="pgStudio"
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements.plist"

# Default cargo tauri build (no --target) → target/release/; with --target → target/$TARGET/release/
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
  echo "No built app found. Run: cargo tauri build  (or pnpm tauri build)"
  exit 1
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
if [[ -z "$IDENTITY" ]]; then
  echo "Set your signing identity. Run: security find-identity -v -p codesigning"
  echo "Then export the exact identity, e.g.:"
  echo '  export SIGNING_IDENTITY="3rd Party Mac Developer Application: Your Name (TEAM_ID)"'
  echo "For TestFlight/App Store use '3rd Party Mac Developer Application', not 'Apple Development'."
  exit 1
fi

if [[ "$IDENTITY" == *"Your Name"* ]] || [[ "$IDENTITY" == *"TEAMID"* ]] || [[ "$IDENTITY" == *"TEAM_ID"* ]]; then
  echo "Replace the placeholder with your real identity from: security find-identity -v -p codesigning"
  exit 1
fi

if [[ "$IDENTITY" == *"Apple Development"* ]]; then
  echo "Warning: 'Apple Development' is for local dev only."
  echo "For TestFlight/App Store you need: 3rd Party Mac Developer Application: ... (create in Apple Developer > Certificates)."
  echo ""
fi

echo "Signing: $APP_PATH"
echo "Identity: $IDENTITY"

codesign --deep --force --verify --verbose \
  --sign "$IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"

echo "Done. Verify with: codesign -dv --verbose=4 $APP_PATH"
