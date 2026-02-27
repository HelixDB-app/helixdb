# Fix: "Certificate Revoked" for 3rd Party Mac Developer Installer

**Error (Transporter / TestFlight):**  
`Certificate Revoked. The signing certificate "3rd Party Mac Developer Installer: ..." used to sign pgStudio.pkg has been revoked.`

**Cause:** The **Mac Installer Distribution** certificate you used to sign the .pkg has been revoked by Apple (e.g. after creating a new one or for security). You must sign the .pkg with a **non‑revoked** Installer cert.

---

## Step 1: Check current identities

```bash
security find-identity -v -p macappstore
```

- **Ignore** any line with `(CSSMERR_TP_CERT_REVOKED)` — that cert is revoked.
- **Ignore** lines with `(Missing required extension)` — those are not valid for signing.
- You need a **"3rd Party Mac Developer Installer: Name (TEAM_ID)"** line with **no** error in parentheses.

If you have such a valid line, copy its **40‑char hex** (first column) and go to **Step 4**. Otherwise continue to Step 2.

---

## Step 2: Create a CSR on this Mac

1. Open **Keychain Access** (Spotlight → "Keychain Access").
2. Menu: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
3. Fill in:
   - **User Email:** your Apple ID email (or team admin).
   - **Common Name:** e.g. "Mac Installer Pooja Kumari" (any label).
   - **CA Email:** leave empty.
   - **Request is:** **Saved to disk**.
4. Click **Continue** and save the file (e.g. `InstallerSigningRequest.certSigningRequest`) to Desktop or `apple/`.

---

## Step 3: Create the certificate in Apple Developer

1. Go to [developer.apple.com/account → Certificates](https://developer.apple.com/account/resources/certificates/list).
2. Click **+** (Add).
3. Under **Software**, select **Mac Installer Distribution** → **Continue**.
4. **Upload** the `.certSigningRequest` you saved.
5. Click **Continue** → **Download** the `.cer` file.

**Install the certificate:**

6. Double‑click the downloaded `.cer` file.
7. It will open Keychain Access and add the cert to your **login** keychain. Confirm.

---

## Step 4: Get the new Installer identity and set it in .env

```bash
security find-identity -v -p macappstore
```

Find the **new** line: **"3rd Party Mac Developer Installer: Pooja Kumari (V9G53UFKD3)"** that does **not** show `(CSSMERR_TP_CERT_REVOKED)` or `(Missing required extension)`. Copy its **40‑character hex** (e.g. `A1B2C3D4...`).

Edit `apple/.env` and set:

```bash
export INSTALLER_IDENTITY="<paste the 40-char hex here>"
```

Save the file.

---

## Step 5: Rebuild and upload

```bash
./apple/build-and-upload-testflight.sh
```

Or to only build the .pkg and upload later via Transporter:

```bash
./apple/build-pkg-for-transporter.sh
```

Then upload `pgStudio.pkg` via the Transporter app or `xcrun altool`.

---

## Optional: Remove old/revoked certs from Keychain

To avoid the system picking the wrong cert:

1. Open **Keychain Access**.
2. Select **login** keychain → **Certificates**.
3. Find "3rd Party Mac Developer Installer: Pooja Kumari" entries.
4. Delete the one(s) that are **revoked** (right‑click → Delete). Only remove certs you are sure are revoked; keep the new one you just installed.

---

**Summary:** Use only a **non‑revoked** "3rd Party Mac Developer Installer" cert. If none are valid, create a new **Mac Installer Distribution** cert (CSR → Apple Developer → download .cer → install → set `INSTALLER_IDENTITY` in `apple/.env`), then run `./apple/build-and-upload-testflight.sh` again.
