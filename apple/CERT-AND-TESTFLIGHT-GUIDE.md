# Fix TestFlight 409 + Full Certificate & Testing Guide

**→ Step-by-step plan to fix the 409:** [TESTFLIGHT-409-FIX-PLAN.md](TESTFLIGHT-409-FIX-PLAN.md).

## Why you get "Invalid Code Signing... must be signed with the certificate that is contained in the provisioning profile"

- The **provisioning profile** (e.g. `apple/pgstudio.provisionprofile`) lists which **Apple Distribution** certificate is allowed to sign the app.
- If that profile was created for a **different** certificate (e.g. one that shows "Missing Private Key" or "Revoked" in Xcode/Developer portal), but you sign the app with **another** Distribution cert that has the private key on your Mac, Apple rejects the upload.
- **Fix:** Create a **new** Mac App Store provisioning profile that includes **the exact certificate you use to sign** on this Mac (the one from `security find-identity -v -p codesigning`).

---

## Quick fix for the 409 error (about 5 minutes)

1. **See which identity you use to sign**
   ```bash
   security find-identity -v -p codesigning
   ```
   Note the **Apple Distribution: Pooja Kumari (V9G53UFKD3)** line (or your name/team). You must use this **exact** cert in the profile.

2. **Create a new Mac App Store provisioning profile**
   - Go to [Certificates, Identifiers & Profiles → Profiles](https://developer.apple.com/account/resources/profiles/list).
   - Click **+**. Do **not** choose the first option (iOS App Development). Under **Distribution**, select **Mac App Store Connect** (for submitting your Mac app to TestFlight/App Store Connect).
   - Select App ID: **com.pgstudio.helixdb** (create it under Identifiers if missing).
   - On the **certificate** step, select **only** the **Apple Distribution** certificate that matches the identity from step 1 (same team, same person). If your Distribution cert shows "Missing Private Key" or "Revoked" in the portal, **do not** select it; create a new Distribution cert on this Mac first (see “Create Apple Distribution certificate” below), then create the profile and select that new cert.
   - Name the profile (e.g. `pgstudio`), generate, then **Download**.

3. **Replace the profile in the repo**
   ```bash
   cp ~/Downloads/pgstudio.provisionprofile /path/to/helixDB/apple/pgstudio.provisionprofile
   ```
   (Use the actual downloaded filename.)

4. **Ensure `apple/.env` uses the same identity**
   Use the **exact** string from step 1, e.g.:
   ```bash
   SIGNING_IDENTITY="Apple Distribution: Pooja Kumari (V9G53UFKD3)"
   ```
   (Script also accepts `3rd Party Mac Developer Application: ...` if that’s what you have.)

5. **Rebuild and upload**
   ```bash
   ./apple/build-and-upload-testflight.sh
   ```

---

## End-to-end: Create certificates and profile (from zero)

### 1. Create Apple Distribution certificate (for signing the app)

You need **one** Distribution certificate that has its **private key on this Mac**. If the one in the portal has "Missing Private Key" or "Revoked", create a new one.

1. **Create a Certificate Signing Request (CSR) on this Mac**
   - Open **Keychain Access** → menu **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority...**
   - Email: your Apple ID email. Common Name: e.g. **Pooja Kumari**. Request: **Saved to disk** → Continue. Save (e.g. `CertificateSigningRequest.certSigningRequest`).

2. **Create the certificate in Apple Developer**
   - [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Certificates** → **+**.
   - Under **Software** → **Distribution** choose **Apple Distribution** (or **Mac App Store** if you see that) → Continue.
   - Upload the CSR → Continue → **Download** the `.cer`. (Download only once.)

3. **Install on this Mac**
   - Double‑click the `.cer` → add to **login** keychain. It will appear under **My Certificates** as **Apple Distribution: Your Name (TEAM_ID)**.

4. **Confirm**
   ```bash
   security find-identity -v -p codesigning
   ```
   You should see **Apple Distribution: … (V9G53UFKD3)** (or your team ID). Copy that full string for `SIGNING_IDENTITY` in `apple/.env`.

### 2. Create Mac Installer Distribution certificate (for signing the .pkg)

Same idea: one Installer cert with private key on this Mac.

1. **New CSR** (Keychain Access → Certificate Assistant → Request… → Saved to disk). You can reuse the same CSR file if it’s from the same Mac and keychain.

2. **In Apple Developer:** Certificates → **+** → **Mac Installer Distribution** → upload CSR → Download `.cer`.

3. **Install:** Double‑click the `.cer` → login keychain.

4. **Confirm**
   ```bash
   security find-identity -v -p codesigning
   ```
   You should see **3rd Party Mac Developer Installer: … (V9G53UFKD3)**. Use that **exact** string for `INSTALLER_IDENTITY` in `apple/.env`.

Detailed steps for the Installer cert only: [INSTALLER-CERT-SETUP.md](INSTALLER-CERT-SETUP.md).

### 3. Create App ID and Mac App Store provisioning profile

1. **App ID**
   - [Identifiers](https://developer.apple.com/account/resources/identifiers/list) → **+** → **App IDs** → **App** → Description: e.g. pgStudio, Bundle ID: **com.pgstudio.helixdb** → Register.

2. **Provisioning profile**
   - [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+** → under **Distribution** choose **Mac App Store Connect** (not iOS/tvOS) → select App ID **com.pgstudio.helixdb** → select the **Apple Distribution** certificate you created in step 1 (the one that has the private key on this Mac) → Name (e.g. pgstudio) → Generate → **Download**.

3. **Put profile in the project**
   ```bash
   cp ~/Downloads/pgstudio.provisionprofile /path/to/helixDB/apple/pgstudio.provisionprofile
   ```

4. **`apple/.env`** — use **two different** identities (app vs installer):
   ```bash
   SIGNING_IDENTITY="Apple Distribution: Pooja Kumari (V9G53UFKD3)"
   INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Pooja Kumari (V9G53UFKD3)"
   APPLE_TEAM_ID=V9G53UFKD3
   APPLE_API_KEY_ID=...
   APPLE_API_ISSUER=...
   APPLE_API_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8
   ```
   If you get "Could not find appropriate signing identity" for the .pkg, `INSTALLER_IDENTITY` must be the **3rd Party Mac Developer Installer** line from `security find-identity -v -p codesigning`, not Apple Distribution. Create that cert: [INSTALLER-CERT-SETUP.md](INSTALLER-CERT-SETUP.md).

Then run:

```bash
./apple/build-and-upload-testflight.sh
```

---

## Better way to get builds to testers (without fighting TestFlight)

| Method | Time | Best for |
|--------|------|----------|
| **Quick share (signed DMG)** | ~2–3 min | Internal testers, fast iteration. No notarization. |
| **Notarized DMG** | ~5–15 min | Sending a link; testers open DMG normally. |
| **TestFlight** | ~15–30 min | Many testers, version history, App Store–style install. |

For **fast testing**, use the **Quick share** DMG so you don’t depend on Distribution cert + profile matching:

1. In `apple/.env` set only:
   ```bash
   DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Pooja Kumari (V9G53UFKD3)"
   ```
   (Get the exact string from `security find-identity -v -p codesigning`.)

2. Build and share:
   ```bash
   ./apple/build-quick-share-dmg.sh
   ```
   Share `src-tauri/target/release/bundle/dmg/pgStudio_quick_share.dmg` (e.g. Google Drive, WeTransfer). Tell testers: **Right‑click the app → Open** the first time (or System Settings → Privacy & Security → Open Anyway).

For **notarized** DMG (no “Open Anyway”), use `./apple/build-shareable-dmg.sh` (same Developer ID cert + API key in `.env`).

Use **TestFlight** when you need many testers or version history; once the profile matches the Distribution cert (steps above), `./apple/build-and-upload-testflight.sh` should succeed.
