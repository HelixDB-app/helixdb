# Generate a Build After Fastlane Match (Next Steps)

Match installed a certificate. To produce a **Mac App Store / TestFlight** build you need: **Mac** App Store certs + **Mac** provisioning profile, then run your build script.

---

## 1. Use Mac App Store (not iOS)

Your app is **macOS**. If Match ran for iOS only, run it again for **Mac** so you get a Mac provisioning profile:

```bash
cd /Users/gokul/Documents/personal/HelixDB/helixDB
fastlane match appstore --platform macos
```

(Enter your Match repo passphrase and Apple ID if asked.)  
This creates/uses **Apple Distribution** (and optionally **Mac Installer Distribution**) and a **Mac** App Store provisioning profile for `com.pgstudio.helixdb`.

---

## 2. Sync profile with your signing cert (automatic)

If **check-profile-cert.sh** says "profile certificate does not match", run **one command** to sync certs + profile and copy the right profile:

```bash
./apple/sync-app-store-signing.sh
```

This runs `fastlane match appstore --platform macos`, then copies the profile that matches **SIGNING_IDENTITY** in `apple/.env` to `apple/pgstudio.provisionprofile`, and verifies.

**Manual option:** Run `./apple/copy-provision-profile.sh` after Match. It only copies a profile whose embedded cert matches `SIGNING_IDENTITY` in `.env` (so you don’t get the wrong/old profile).

---

## 3. Set signing identities in apple/.env

Get the SHA-1 fingerprints of the certs Match installed:

```bash
security find-identity -v -p codesigning
```

You need:

- **Apple Distribution: … (V9G53UFKD3)** → use its **40-char hex** (e.g. `76AB1EC3...`) as `SIGNING_IDENTITY`
- **3rd Party Mac Developer Installer: … (V9G53UFKD3)** → use its **40-char hex** as `INSTALLER_IDENTITY`

Edit `apple/.env`:

```bash
export SIGNING_IDENTITY="<Apple Distribution fingerprint>"
export INSTALLER_IDENTITY="<3rd Party Mac Developer Installer fingerprint>"
export APPLE_TEAM_ID=V9G53UFKD3
# keep existing APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH
```

If you don’t see **3rd Party Mac Developer Installer**, create that certificate in the [Apple Developer portal](https://developer.apple.com/account/resources/certificates/list) (Mac Installer Distribution), install the .cer, then run `security find-identity -v -p codesigning` again and set `INSTALLER_IDENTITY`.

---

## 4. Verify profile matches cert (avoid 409)

```bash
./apple/check-profile-cert.sh
```

You should see: `OK: Provisioning profile contains the signing certificate (...).`  
If not, the profile in `apple/pgstudio.provisionprofile` must be the one that contains the **Apple Distribution** cert you use for `SIGNING_IDENTITY` (see `apple/FIX-TESTFLIGHT-409-STEPS.md`).

---

## 5. Build and upload to TestFlight

```bash
./apple/build-and-upload-testflight.sh
```

This will:

1. Build the app (universal macOS)
2. Check profile vs cert
3. Sign the app with `SIGNING_IDENTITY`
4. Create a signed .pkg with `INSTALLER_IDENTITY`
5. Upload the .pkg to App Store Connect (TestFlight)

The build will appear in **App Store Connect → pgStudio → TestFlight** after a few minutes.

---

## Quick checklist

- [ ] Match run for **Mac**: `fastlane match appstore --platform macos`
- [ ] Mac provisioning profile copied to `apple/pgstudio.provisionprofile`
- [ ] `apple/.env` has `SIGNING_IDENTITY` and `INSTALLER_IDENTITY` (SHA-1 fingerprints)
- [ ] `./apple/check-profile-cert.sh` prints OK
- [ ] `./apple/build-and-upload-testflight.sh` runs successfully
