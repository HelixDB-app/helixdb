#!/usr/bin/env bash
# Check that the provisioning profile contains the certificate we use for signing.
# If not, TestFlight upload will fail with 409 "must be signed with the certificate in the provisioning profile".
# Usage: ./apple/check-profile-cert.sh
# Or:    PROFILE=... SIGN_ID=... ./apple/check-profile-cert.sh
# When run without SIGN_ID, loads apple/.env and uses APPLE_SIGNING_IDENTITY or SIGNING_IDENTITY.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-$REPO_ROOT/apple/pgstudio.provisionprofile}"

if [[ -z "$SIGN_ID" ]] && [[ -f "$REPO_ROOT/apple/.env" ]]; then
  set -a; source "$REPO_ROOT/apple/.env"; set +a
  SIGN_ID="${APPLE_SIGNING_IDENTITY:-$SIGNING_IDENTITY}"
fi
[[ -z "$SIGN_ID" ]] && { echo "Set SIGNING_IDENTITY in apple/.env or pass SIGN_ID=..."; exit 1; }

# Normalize fingerprint: 40 hex chars, uppercase (no colons)
normalize_fp() { echo "$1" | tr -d ':' | tr 'a-f' 'A-F' | head -c 40; }

# Get SHA-1 of first DeveloperCertificate in the profile (output: 40 hex chars, no colons)
get_profile_cert_fp() {
  local profile="$1"
  python3 -c "
import plistlib, subprocess, tempfile, os, sys
profile = sys.argv[1]
data = subprocess.check_output(['security', 'cms', '-D', '-i', profile])
plist = plistlib.loads(data)
certs = plist.get('DeveloperCertificates', [])
if not certs:
    exit(1)
with tempfile.NamedTemporaryFile(suffix='.der', delete=False) as f:
    f.write(certs[0])
    f.flush()
out = subprocess.check_output(['openssl', 'x509', '-in', f.name, '-inform', 'DER', '-noout', '-fingerprint', '-sha1'])
os.unlink(f.name)
# Fingerprint is like SHA1 Fingerprint=61:72:EB:...
fp = out.decode().split('=', 1)[1].strip().replace(':', '')
print(fp.upper())
" "$profile"
}

# If SIGN_ID looks like a 40-char hex fingerprint, use it; else resolve from keychain
if [[ "$SIGN_ID" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  SIGN_FP=$(normalize_fp "$SIGN_ID")
else
  # Get fingerprint for the given identity name from keychain
  SIGN_FP=$(security find-identity -v -p codesigning 2>/dev/null | awk -v id="$SIGN_ID" '$0 ~ id { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }')
  [[ -z "$SIGN_FP" ]] && { echo "Identity not found in keychain: $SIGN_ID"; exit 1; }
  SIGN_FP=$(normalize_fp "$SIGN_FP")
fi

PROFILE_FP=$(get_profile_cert_fp "$PROFILE" 2>/dev/null) || { echo "Could not read certificate from profile: $PROFILE"; exit 1; }
PROFILE_FP=$(normalize_fp "$PROFILE_FP")

if [[ "$SIGN_FP" != "$PROFILE_FP" ]]; then
  echo "ERROR: Provisioning profile certificate does not match signing identity."
  echo "  Profile cert (in $PROFILE): $PROFILE_FP"
  echo "  Signing identity:           $SIGN_FP"
  echo ""
  echo "TestFlight will reject with 409 until these match. Fix:"
  echo "  1. Go to https://developer.apple.com/account/resources/profiles/list"
  echo "  2. Click + → Mac App Store Connect → App ID com.pgstudio.helixdb"
  echo "  3. Select the Apple Distribution certificate that matches this Mac (fingerprint $SIGN_FP)"
  echo "  4. Generate, download the profile, then: cp ~/Downloads/pgstudio.provisionprofile $REPO_ROOT/apple/pgstudio.provisionprofile"
  echo "  5. Re-run this script or ./apple/build-and-upload-testflight.sh"
  echo ""
  echo "Full guide: apple/FIX-TESTFLIGHT-409-STEPS.md"
  exit 1
fi
echo "OK: Provisioning profile contains the signing certificate ($SIGN_FP)."
