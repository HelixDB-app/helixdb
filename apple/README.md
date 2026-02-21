# Upload pgStudio to TestFlight

## One-time setup (Apple Developer + App Store Connect)

1. **Certificates** (Developer portal): **Apple Distribution** + **3rd Party Mac Developer Installer**. Install both in Keychain. **Step-by-step for the installer cert:** [apple/INSTALLER-CERT-SETUP.md](INSTALLER-CERT-SETUP.md) (uses built-in Keychain Access; no extra app).
2. **App** in [App Store Connect](https://appstoreconnect.apple.com) → My Apps → New App (macOS), Bundle ID `com.pgstudio.helixdb`.
3. **API key**: App Store Connect → Users and Access → Integrations → Keys → Create. Download the `.p8` file once; note **Key ID** and **Issuer ID**.

## One command: build + sign + upload (TestFlight)

Copy `apple/env.example` to `apple/.env`, fill in your values (identities from `security find-identity -v -p codesigning`), then:

```bash
./apple/build-and-upload-testflight.sh
```

This builds the app, signs it, creates the .pkg, and uploads to TestFlight.

## Alternative: share a .dmg that works on other Macs (no TestFlight)

If you want to send the app as a file (link/USB) so it opens on any Mac without TestFlight: sign with **Developer ID Application** and notarize.

**Create the cert:** Apple Developer → Certificates → **+** → under **Developer ID** choose **Developer ID Application** → upload a CSR (Keychain Access → Certificate Assistant → Request…) → download .cer and double‑click to install. Then `security find-identity -v -p codesigning` will show **"Developer ID Application: Your Name (TEAM_ID)"**. Set that in `apple/.env` as `DEVELOPER_ID_SIGNING_IDENTITY`. Then:

```bash
# In apple/.env set DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
./apple/build-shareable-dmg.sh
```

Share the produced `pgStudio_shareable.dmg`; Gatekeeper will allow it on other Macs.

**If notarization times out:** Later, check and staple with:
```bash
./apple/check-and-staple.sh <submission-id>
# e.g. ./apple/check-and-staple.sh 098eccf8-60d5-4048-828f-bfb3fb3ebab0
```

**Share without notarization:** You can still share the signed DMG. Recipients may see "cannot be verified". They should **right‑click the app → Open** (first time), or in **System Settings → Privacy & Security** click **Open Anyway**. The app will then run.

## Or run steps manually

```bash
cargo tauri build
export SIGNING_IDENTITY="3rd Party Mac Developer Application: Your Name (TEAM_ID)"
./apple/codesign-app.sh
export INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
export APPLE_API_KEY_ID=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=/path/to/AuthKey_XXX.p8
./apple/upload-testflight.sh
```

After processing (5–15 min), the build appears under your app → **TestFlight**. Full details: [docs/TESTFLIGHT-MACOS.md](../docs/TESTFLIGHT-MACOS.md)
