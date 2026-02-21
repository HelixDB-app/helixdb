#!/usr/bin/env bash
# Check a notarization submission and staple the DMG when Accepted.
# Usage: ./apple/check-and-staple.sh <submission-id> [path/to/file.dmg]
# Example: ./apple/check-and-staple.sh 098eccf8-60d5-4048-828f-bfb3fb3ebab0

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$REPO_ROOT/apple/.env" ]] && set -a && source "$REPO_ROOT/apple/.env" && set +a

SUB_ID="$1"
DMG_PATH="${2:-$REPO_ROOT/src-tauri/target/release/bundle/dmg/pgStudio_shareable.dmg}"
KEY_ID="${APPLE_API_KEY_ID:-$APPLE_API_KEY}"
ISSUER="${APPLE_API_ISSUER}"
KEY_PATH="${APPLE_API_KEY_PATH}"
[[ -n "$KEY_PATH" && "$KEY_PATH" != /* ]] && KEY_PATH="$REPO_ROOT/$KEY_PATH"

if [[ -z "$SUB_ID" ]]; then
  echo "Usage: $0 <submission-id> [dmg-path]"
  echo "Example: $0 098eccf8-60d5-4048-828f-bfb3fb3ebab0"
  exit 1
fi
if [[ -z "$KEY_ID" || -z "$ISSUER" || -z "$KEY_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Set APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH in apple/.env"
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH"
  exit 1
fi

echo "Polling for submission $SUB_ID (every 30s, max 60 min)..."
for i in $(seq 1 120); do
  LOG=$(xcrun notarytool log "$SUB_ID" --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>/dev/null || true)
  if echo "$LOG" | grep -q '"status": "Accepted"'; then
    echo "Notarization Accepted. Stapling..."
    xcrun stapler staple "$DMG_PATH"
    echo "Done. Share: $DMG_PATH"
    exit 0
  fi
  if echo "$LOG" | grep -q '"status": "Invalid"'; then
    echo "Notarization Invalid:"
    echo "$LOG"
    exit 1
  fi
  echo "  $i: in progress..."
  sleep 30
done
echo "Timed out. Try again later with the same command."
