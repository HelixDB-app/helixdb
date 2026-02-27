# pgStudio — App Store Build & Upload Guide

Step-by-step guide to build a signed macOS app and upload it to App Store Connect (TestFlight → App Store). Assumes you have **Apple Developer Program** access.

---

## Part 1: One-time setup

### 1.1 App Store Connect

1. Go to [App Store Connect](https://appstoreconnect.apple.com) → **My Apps** → **+** → **New App**.
2. Platform: **macOS**. Name: **pgStudio**. Bundle ID: **com.pgstudio.helixdb** (must match `tauri.conf.json` → `identifier`).
3. Create the app. You’ll use it for TestFlight and App Store submission.

### 1.2 Certificates (Keychain)

You need **two** code-signing identities. Get them from:

```bash
security find-identity -v -p codesigning
```

**Required:**

| Purpose | Identity (exact string) |
|--------|--------------------------|
| Sign the **.app** | `Apple Distribution: Your Name (TEAM_ID)` |
| Sign the **.pkg** installer | `3rd Party Mac Developer Installer: Your Name (TEAM_ID)` |

- If **Apple Distribution** is missing or shows “Missing Private Key”: [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md) → “Create Apple Distribution certificate”.
- If **3rd Party Mac Developer Installer** is missing: [INSTALLER-CERT-SETUP.md](INSTALLER-CERT-SETUP.md).

### 1.3 Provisioning profile (Mac App Store)

1. [Identifiers](https://developer.apple.com/account/resources/identifiers/list): ensure **com.pgstudio.helixdb** exists (type: App).
2. [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+** → **Distribution** → **Mac App Store Connect**.
3. App ID: **com.pgstudio.helixdb**. Certificate: select the **Apple Distribution** cert you use to sign (the one with private key on this Mac).
4. Name (e.g. `pgstudio`) → Generate → **Download**.
5. Replace the project profile:

   ```bash
   cp ~/Downloads/pgstudio.provisionprofile /path/to/helixDB/apple/pgstudio.provisionprofile
   ```

### 1.4 App Store Connect API key (for `altool` upload)

1. [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** → **Keys**.
2. **+** → Name (e.g. “HelixDB Upload”) → **Developer** access → Generate.
3. Note **Key ID** and **Issuer ID**. Download the **.p8** key **once** (it won’t be shown again).
4. Store the key as:  
   `AuthKey_<KEY_ID>.p8`  
   in one of: `./private_keys`, `~/private_keys`, `~/.private_keys`, or `~/.appstoreconnect/private_keys`.  
   Or keep it in the repo (e.g. `apple/AuthKey_XXXXXXXX.p8`) and reference it in `.env`.

### 1.5 Project `.env`

Copy and edit:

```bash
cp apple/env.example apple/.env
```

Fill in (use exact strings from `security find-identity -v -p codesigning`):

```bash
# Sign the .app (for App Store / TestFlight)
export SIGNING_IDENTITY="Apple Distribution: Your Name (TEAM_ID)"
# Sign the .pkg installer
export INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
# Optional if not parsed from SIGNING_IDENTITY
export APPLE_TEAM_ID=XXXXXXXX

# App Store Connect API key (for upload)
export APPLE_API_KEY_ID=your_key_id
export APPLE_API_ISSUER=your_issuer_id
export APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8
```

Scripts also accept `APPLE_SIGNING_IDENTITY`, `APPLE_INSTALLER_IDENTITY`, and `APPLE_TEAM_ID` if you prefer those names.

---

## Part 2: Build and upload (every release)

### Option A: One command (recommended)

From repo root:

```bash
./apple/build-and-upload-testflight.sh
```

This will:

1. Build the app (Next.js + Tauri, universal binary for App Store).
2. Substitute your Team ID into `Entitlements.plist` and sign the app with **Apple Distribution**.
3. Create a signed **.pkg** with **3rd Party Mac Developer Installer**.
4. Upload the **.pkg** to App Store Connect via `altool` (API key from `.env`).

When it finishes, the build will appear under **App Store Connect → pgStudio → TestFlight** in about 5–15 minutes.

### Option B: Build .pkg only, upload manually

1. Build and create signed .pkg:

   ```bash
   ./apple/build-pkg-for-testflight.sh
   ```

2. Upload with **Xcode Transporter**: open Transporter, sign in, drag `pgStudio.pkg` in, click **Deliver**.

---

## Part 3: Verify

### 3.1 After build (before upload)

- **App bundle:**  
  `src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app` (or `target/release/...` on native arch).

- **Code signing:**

  ```bash
  codesign -dv --verbose=4 src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app
  ```

  You should see your **Apple Distribution** identity and no errors.

- **Entitlements:**

  ```bash
  codesign -d --entitlements - src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app
  ```

  Should show `com.apple.security.app-sandbox` and your `application-identifier` / `team-identifier`.

### 3.2 After upload

- **App Store Connect** → **pgStudio** → **TestFlight** → **macOS** tab: new build appears with “Processing” then “Ready to test”.
- If you get **409 “Invalid Code Signing”**: the provisioning profile does not match the certificate. Fix: [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md) (create a new Mac App Store profile that includes your current **Apple Distribution** cert, then replace `apple/pgstudio.provisionprofile` and re-run the build script).

### 3.3 Submit to the App Store (after TestFlight)

When the build is “Ready to test” in TestFlight:

1. App Store Connect → **pgStudio** → **App Store** tab.
2. Create a **new version** (e.g. 0.1.0) if needed.
3. In the version, under **Build**, select the TestFlight build you uploaded.
4. Fill in **What’s New**, screenshots, description, etc.
5. Submit for **Review**.

---

## Checklist (quick reference)

- [ ] App **com.pgstudio.helixdb** in App Store Connect and in `tauri.conf.json`
- [ ] **Apple Distribution** and **3rd Party Mac Developer Installer** in Keychain; seen in `security find-identity -v -p codesigning`
- [ ] **Mac App Store Connect** provisioning profile for **com.pgstudio.helixdb** using that Distribution cert → file at `apple/pgstudio.provisionprofile`
- [ ] **Entitlements.plist** uses placeholder `TEAM_ID` (script substitutes it)
- [ ] **Info.plist** has `ITSAppUsesNonExemptEncryption` = false (already in `src-tauri/Info.plist`)
- [ ] **apple/.env** has `SIGNING_IDENTITY`, `INSTALLER_IDENTITY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`
- [ ] Run: `./apple/build-and-upload-testflight.sh` → build appears in TestFlight

---

## References

- [Tauri — App Store](https://v2.tauri.app/distribute/app-store/)
- [Tauri — macOS Application Bundle](https://v2.tauri.app/distribute/macos/)
- Project: [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md), [INSTALLER-CERT-SETUP.md](INSTALLER-CERT-SETUP.md)
