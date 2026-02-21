# TestFlight for pgStudio (macOS)

Use this guide to build and distribute pgStudio via TestFlight so testers can install it on their Macs.

## Prerequisites

- **Apple Developer account** (paid, $99/year) — [developer.apple.com](https://developer.apple.com)
- **Mac** with Xcode (or Xcode command line tools)
- App runs correctly in **App Sandbox** (network, file access work within sandbox)

---

## 1. Apple Developer setup

1. **Create an App ID**  
   [Identifiers](https://developer.apple.com/account/resources/identifiers/list) → **+** → App IDs → **App** → Bundle ID: **`com.pgstudio.helixdb`** (must match `identifier` in `tauri.conf.json`). Note your **Team ID** (App ID Prefix).

2. **Create certificates**  
   [Certificates](https://developer.apple.com/account/resources/certificates/list) → **+**:
   - **Apple Distribution** (for App Store / TestFlight)
   - **Mac Installer Distribution** (for the .pkg)

   Create a CSR in Keychain Access (Certificate Assistant → Request a Certificate From a Certificate Authority), upload it, download the `.cer` and double‑click to add to Keychain.

3. **Create provisioning profile**  
   [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+** → **Mac** → **Mac App Store** → select App ID `com.pgstudio.helixdb` and your **Apple Distribution** certificate → name it (e.g. `pgStudio Mac App Store`) → Download.  
   Save as `src-tauri/provisioning/pgStudio.provisionprofile`.

4. **App Store Connect**  
   [App Store Connect](https://appstoreconnect.apple.com/apps) → **My Apps** → **+** → **New App** (macOS) → Bundle ID: `com.pgstudio.helixdb`. You’ll upload builds to this app for TestFlight.

5. **API key (for upload)**  
   App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **+** (key name, e.g. “Tauri upload”, access **Developer**).  
   Note **Key ID** and **Issuer ID**. Download the `.p8` private key **once** and store it safely (e.g. `AuthKey_XXXXXXXX.p8`).

---

## 2. Project configuration

1. **Replace Team ID in entitlements**  
   Edit `src-tauri/Entitlements.plist`: replace both `TEAM_ID` with your 10‑character Team ID (e.g. `AB12CD34EF`).

2. **Provisioning profile path**  
   In `tauri.conf.json`, set the path to your downloaded `.provisionprofile` (see `bundle.macOS.files.embedded.provisionprofile`). Use a path relative to `src-tauri` or absolute.

3. **Code signing identity**  
   On your Mac, run:
   ```bash
   security find-identity -v -p codesigning
   ```
   Use the **Apple Distribution** identity (e.g. `"Apple Distribution: Your Name (TEAM_ID)"`). Set it in `tauri.conf.json` as `bundle.macOS.signingIdentity` or via env:
   ```bash
   export APPLE_SIGNING_IDENTITY="Apple Distribution: Your Name (TEAM_ID)"
   ```

4. **Encryption**  
   `src-tauri/Info.plist` has `ITSAppUsesNonExemptEncryption` = `false`. If your app uses custom encryption (beyond HTTPS/TLS), set it to `true` and follow Apple’s export compliance steps.

---

## 3. Build

From the repo root (with `tauri.conf.json` and provisioning/entitlements set as above):

```bash
# 1. Build universal macOS .app
pnpm tauri build --bundles app --target universal-apple-darwin
```

The `.app` will be under:
`src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app`.

```bash
# 2. Create signed .pkg (replace identity and app name if different)
xcrun productbuild --sign "Developer ID Application: YOUR_NAME (TEAM_ID)" \
  --component "src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app" /Applications \
  pgStudio.pkg
```

For **App Store / TestFlight** you must sign the **installer** with **Mac Installer Distribution**. Example:

```bash
xcrun productbuild --sign "3rd Party Mac Developer Installer: YOUR_NAME (TEAM_ID)" \
  --component "src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app" /Applications \
  pgStudio.pkg
```

(Use the exact name from `security find-identity -v -p codesigning` for the installer certificate.)

---

## 4. Upload to App Store Connect (TestFlight)

Using the App Store Connect API key (Key ID, Issuer ID, and `.p8` file):

```bash
xcrun altool --upload-app --type macos --file pgStudio.pkg \
  --apiKey YOUR_KEY_ID \
  --apiIssuer YOUR_ISSUER_ID \
  --apiKeyPath /path/to/AuthKey_XXXXXXXX.p8
```

Or with key and issuer in env:

```bash
export APPLE_API_KEY_ID=YOUR_KEY_ID
export APPLE_API_ISSUER=YOUR_ISSUER_ID
export APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8

xcrun altool --upload-app --type macos --file pgStudio.pkg \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER" \
  --apiKeyPath "$APPLE_API_KEY_PATH"
```

After processing (often 5–15 minutes), the build appears in App Store Connect under the app → **TestFlight** tab.

---

## 5. TestFlight testing

1. **Internal testers** (up to 100): App Store Connect → your app → **TestFlight** → **Internal Testing** → add users from your team. They get the build without App Review.

2. **External testers** (up to 10,000): **External Testing** → create a group → add the build → submit for **Beta App Review** (first time). After approval, add testers by email; they install via the TestFlight app on macOS.

3. Testers open **TestFlight** on their Mac, accept the invite, and install **pgStudio**. Builds are available for **90 days**.

---

## 6. Checklist

- [ ] App ID `com.pgstudio.helixdb` created
- [ ] Apple Distribution + Mac Installer Distribution certificates created and installed
- [ ] Mac App Store provisioning profile created and path set in `tauri.conf.json`
- [ ] `Entitlements.plist` updated with your Team ID
- [ ] App Store Connect app created for this bundle ID
- [ ] API key created and .p8 saved
- [ ] Build: `tauri build --bundles app --target universal-apple-darwin`
- [ ] Signed .pkg with Mac Installer Distribution identity
- [ ] Upload with `altool`; build appears in TestFlight
- [ ] Sandbox tested (network, DB, file access) on your Mac

For more: [Tauri App Store](https://v2.tauri.app/distribute/app-store), [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos).
