# Step-by-Step Plan: Fix TestFlight 409 (Certificate ↔ Profile Mismatch)

**Error:** `Invalid Code Signing. The executable ... must be signed with the certificate that is contained in the provisioning profile.`

**Cause:** The app is signed with **Apple Distribution: Pooja Kumari (V9G53UFKD3)** on this Mac, but `apple/pgstudio.provisionprofile` was created for a **different** Apple Distribution certificate (e.g. one with "Missing Private Key" or "Revoked"). Apple requires the signing certificate to be **inside** the profile.

**Fix:** Create a **new** Mac App Store provisioning profile that includes **only** the certificate that is on this Mac, then replace the profile and rebuild.

---

## Plan Overview

| Step | What you do | Why |
|------|-------------|-----|
| 1 | Confirm the signing identity on this Mac | So we know which cert the profile must include |
| 2 | Create a **new** Apple Distribution certificate on this Mac (optional but recommended if you have multiple/revoked certs) | Guarantees one cert that matches this Mac |
| 3 | Create a **new** Mac App Store Connect provisioning profile using that cert | Profile will then match the app signature |
| 4 | Download the profile and replace `apple/pgstudio.provisionprofile` | Build will embed the correct profile |
| 5 | Full rebuild and upload | Signed app + matching profile = success |

---

## Step 1: Confirm signing identity on this Mac

1. Open Terminal and run:
   ```bash
   security find-identity -v -p codesigning
   ```
2. Find the line that says **Apple Distribution: Pooja Kumari (V9G53UFKD3)** (or your name/team).
3. Copy that **entire** quoted string. You’ll use it in `apple/.env` and you’ll need to use the **same** certificate when creating the profile in Step 3.

Example output:
```
7) 76AB1EC325A472030322249B793F430E44ED922A "Apple Distribution: Pooja Kumari (V9G53UFKD3)"
```

4. Ensure **apple/.env** has:
   ```bash
   SIGNING_IDENTITY="Apple Distribution: Pooja Kumari (V9G53UFKD3)"
   INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Pooja Kumari (V9G53UFKD3)"
   ```
   (Use the exact strings from `security find-identity` for your machine.)

---

## Step 2: (Recommended) Create a new Apple Distribution certificate on this Mac

Do this if you have multiple Apple Distribution certs or any show "Missing Private Key" / "Revoked". It ensures the profile will match this Mac.

1. **Create a CSR on this Mac**
   - Open **Keychain Access** (Applications → Utilities).
   - Menu: **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority...**
   - **User Email:** your Apple ID email.  
   - **Common Name:** e.g. **Pooja Kumari**.  
   - **Request is:** **Saved to disk**.  
   - Click **Continue** and save the file (e.g. `CertificateSigningRequest.certSigningRequest`).

2. **Create the certificate in Apple Developer**
   - Go to [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Certificates**.
   - Click **+**.
   - Under **Software** → **Distribution**, select **Apple Distribution** → **Continue**.
   - Click **Choose File** and select the `.certSigningRequest` you saved.
   - **Continue** → **Download** the `.cer` file. (Download only once.)

3. **Install the certificate on this Mac**
   - Double‑click the downloaded `.cer` file.
   - When Keychain Access opens, choose **login** (or **System**) and click **Add**.
   - The certificate appears under **My Certificates** as **Apple Distribution: Pooja Kumari (V9G53UFKD3)** (or your name/team).

4. **Confirm**
   ```bash
   security find-identity -v -p codesigning
   ```
   You should see **Apple Distribution: Pooja Kumari (V9G53UFKD3)**. Update **SIGNING_IDENTITY** in `apple/.env` to this **exact** string if it changed.

---

## Step 3: Create a new Mac App Store Connect provisioning profile

1. **Open Profiles**
   - [developer.apple.com/account → Profiles](https://developer.apple.com/account/resources/profiles/list).

2. **Add a new profile**
   - Click **+**.
   - Under **Distribution**, select **Mac App Store Connect** (do **not** choose iOS App Development or others).

3. **Select App ID**
   - Choose **com.pgstudio.helixdb**.
   - If it’s missing: go to **Identifiers** → **+** → **App IDs** → **App** → Bundle ID **com.pgstudio.helixdb** → Register, then return to Profiles and try again.

4. **Select certificate (critical)**
   - On the screen where you choose a certificate, select **only** the **Apple Distribution** certificate that you use on this Mac:
     - If you did **Step 2**, select the **new** one you just created (usually the most recent).
     - If you skipped Step 2, select the one that is **not** revoked and does **not** show "Missing Private Key" (in Xcode/portal). It must be the same person/team as in `SIGNING_IDENTITY`.
   - Do **not** select multiple Distribution certs; pick the one that matches this Mac.

5. **Name and generate**
   - Profile name: e.g. **pgstudio** (or pgstudio-mac).
   - Click **Generate** (or **Continue** until you can generate).
   - **Download** the profile (e.g. `pgstudio.provisionprofile`).

---

## Step 4: Replace the profile in the project

1. Copy the downloaded profile over the existing one (use the actual filename from the portal if different):
   ```bash
   cp ~/Downloads/pgstudio.provisionprofile /Users/gokul/Documents/personal/HelixDB/helixDB/apple/pgstudio.provisionprofile
   ```
2. Optional: confirm the path Tauri uses:
   ```bash
   grep provisionprofile /Users/gokul/Documents/personal/HelixDB/helixDB/src-tauri/tauri.conf.json
   ```
   It should point to `../apple/pgstudio.provisionprofile`. If you use a different filename (e.g. `pgstudio1.provisionprofile`), either rename to `pgstudio.provisionprofile` or update `tauri.conf.json` to that path.

---

## Step 5: Full rebuild and upload

1. From the project root:
   ```bash
   cd /Users/gokul/Documents/personal/HelixDB/helixDB
   ./apple/build-and-upload-testflight.sh
   ```
   This will: build the app (embedding the new profile), sign the app with **SIGNING_IDENTITY**, create the .pkg with **INSTALLER_IDENTITY**, and upload to TestFlight.

2. If you still get a 409:
   - The profile still doesn’t contain the cert you’re signing with. Do **Step 2** (create a new Apple Distribution cert on this Mac), then **Step 3** again and select **only** that new cert, replace the profile (**Step 4**), and run the script again.

---

## Checklist (quick reference)

- [ ] **Step 1:** `security find-identity -v -p codesigning` shows **Apple Distribution: Pooja Kumari (V9G53UFKD3)** and `apple/.env` has that exact `SIGNING_IDENTITY` and **3rd Party Mac Developer Installer** for `INSTALLER_IDENTITY`.
- [ ] **Step 2 (recommended):** New Apple Distribution cert created on this Mac (CSR → Developer portal → Download .cer → install) and confirmed in `security find-identity`.
- [ ] **Step 3:** New profile created: **Mac App Store Connect** → App ID **com.pgstudio.helixdb** → select the **correct** Apple Distribution cert → Generate → Download.
- [ ] **Step 4:** Downloaded profile copied to `apple/pgstudio.provisionprofile` (and `tauri.conf.json` points to it).
- [ ] **Step 5:** `./apple/build-and-upload-testflight.sh` run from repo root; if 409 persists, repeat Step 2 + 3 + 4.

---

## Alternative: Test without TestFlight (no profile/cert mismatch)

To get builds to testers **without** fixing the profile:

- **Quick share (signed DMG):** Use **Developer ID** only. In `apple/.env` set `DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Pooja Kumari (V9G53UFKD3)"` and run `./apple/build-quick-share-dmg.sh`. Share the DMG; testers **right‑click app → Open** the first time.
- **Notarized DMG:** Same identity + API key; run `./apple/build-shareable-dmg.sh`. Share the DMG; it opens normally on other Macs.

Use TestFlight when you need many testers or version history; the steps above make the profile match the certificate so the 409 goes away.

---

## If you see "ambiguous (matches ... and ... in keychain)"

You have **two** certificates with the same name (e.g. two "Apple Distribution: Pooja Kumari (V9G53UFKD3)"). Codesign then doesn’t know which to use.

**Option A – Use the identity by SHA-1 (no keychain change):**  
Run `security find-identity -v -p codesigning` and copy the **hash** (the long hex string before the quoted name) of the identity you want. In `apple/.env` set:
```bash
SIGNING_IDENTITY="76AB1EC325A472030322249B793F430E44ED922A"
```
(Replace with the hash for your desired cert.) Then re-run the TestFlight script.

**Option B – Remove the duplicate in Keychain Access:**  
Open Keychain Access → **My Certificates** → find the two "Apple Distribution: Pooja Kumari" entries. Delete the one you don’t need (e.g. the one that shows a different expiry or that you don’t use). Keep one. Then use the name again in `SIGNING_IDENTITY`.
