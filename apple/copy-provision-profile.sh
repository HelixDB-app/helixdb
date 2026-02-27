#!/usr/bin/env bash
# Find a Mac App Store provisioning profile for com.pgstudio.helixdb that contains the
# certificate in apple/.env (SIGNING_IDENTITY). Copy it to apple/pgstudio.provisionprofile.
# Run after: fastlane match appstore --platform macos

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/apple/pgstudio.provisionprofile"
APP_ID="com.pgstudio.helixdb"

# Load signing identity from .env so we only copy a profile that matches our cert
if [[ -f "$REPO_ROOT/apple/.env" ]]; then
  set -a; source "$REPO_ROOT/apple/.env"; set +a
  SIGN_FP="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
  SIGN_FP=$(echo "$SIGN_FP" | tr -d ':' | tr 'a-f' 'A-F' | head -c 40)
fi

get_profile_cert_fp() {
  python3 -c "
import plistlib, subprocess, tempfile, os, sys
data = subprocess.check_output(['security', 'cms', '-D', '-i', sys.argv[1]])
plist = plistlib.loads(data)
certs = plist.get('DeveloperCertificates', [])
if not certs:
    sys.exit(1)
with tempfile.NamedTemporaryFile(suffix='.der', delete=False) as f:
    f.write(certs[0]); f.flush()
out = subprocess.check_output(['openssl', 'x509', '-in', f.name, '-inform', 'DER', '-noout', '-fingerprint', '-sha1'])
os.unlink(f.name)
fp = out.decode().split('=', 1)[1].strip().replace(':', '').upper()
print(fp)
" "$1" 2>/dev/null
}

# Xcode 16+ and legacy locations
DIRS=(
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  "$HOME/Library/MobileDevice/Provisioning Profiles"
)

fallback=""
for dir in "${DIRS[@]}"; do
  [[ ! -d "$dir" ]] && continue
  for f in "$dir"/*.provisionprofile "$dir"/*.mobileprovision; do
    [[ -f "$f" ]] || continue
    security cms -D -i "$f" 2>/dev/null | grep -q "$APP_ID" || continue
    profile_fp=$(get_profile_cert_fp "$f")
    if [[ -n "$SIGN_FP" && -n "$profile_fp" && "$profile_fp" == "$SIGN_FP" ]]; then
      cp "$f" "$DEST"
      echo "Copied (cert matches SIGNING_IDENTITY): $f -> $DEST"
      exit 0
    fi
    [[ -z "$fallback" ]] && fallback="$f"
  done
done

if [[ -n "$fallback" && -z "$SIGN_FP" ]]; then
  cp "$fallback" "$DEST"
  echo "Copied (first for $APP_ID): $fallback -> $DEST"
  exit 0
fi

echo "No provisioning profile found that contains the certificate in apple/.env (SIGNING_IDENTITY)."
echo "  Your signing cert fingerprint: ${SIGN_FP:-<set SIGNING_IDENTITY in apple/.env>}"
echo ""
echo "To fix automatically, run:"
echo "  ./apple/sync-app-store-signing.sh"
echo ""
echo "Or manually: fastlane match appstore --platform macos (then run this script again)."
exit 1
