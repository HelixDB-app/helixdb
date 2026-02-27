#!/usr/bin/env bash
# One command to sync App Store signing: run Match (cert + profile) then copy the profile
# that matches SIGNING_IDENTITY from apple/.env into apple/pgstudio.provisionprofile.
# Use when you get "profile certificate does not match signing identity" (409).

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== 1. Sync certs and profile (fastlane match appstore --platform macos) ==="
fastlane match appstore --platform macos

echo ""
echo "=== 2. Copy profile that matches SIGNING_IDENTITY into project ==="
"$REPO_ROOT/apple/copy-provision-profile.sh"

echo ""
echo "=== 3. Verify profile matches cert ==="
"$REPO_ROOT/apple/check-profile-cert.sh"

echo ""
echo "Done. You can run: ./apple/build-and-upload-testflight.sh"
