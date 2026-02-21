# Install “3rd Party Mac Developer Installer” certificate (step-by-step)

The error **“Could not find appropriate signing identity for 3rd Party Mac Developer Installer”** means that certificate is not on your Mac. You need to create it in your Apple Developer account and install it in **Keychain Access** (built into macOS).

---

## Step 1: Open Keychain Access on your Mac

- **Spotlight**: Press `Cmd + Space`, type **Keychain Access**, press Enter.  
- Or: **Finder** → **Applications** → **Utilities** → **Keychain Access**.

You do **not** need to install anything; Keychain Access is part of macOS.

---

## Step 2: Create a Certificate Signing Request (CSR)

1. In Keychain Access menu bar: **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority...**
2. Fill in:
   - **User Email Address**: your Apple ID email (e.g. the one used for the developer account).
   - **Common Name**: e.g. **Pooja Kumari** (or your name; can be anything).
   - **CA Email Address**: leave empty.
   - **Request is**: select **Saved to disk**.
3. Click **Continue**. Save the file (e.g. **CertificateSigningRequest.certSigningRequest** on Desktop). You’ll upload this in the next step.

---

## Step 3: Create “Mac Installer Distribution” in Apple Developer

1. Go to [developer.apple.com/account](https://developer.apple.com/account) and sign in.
2. Open **Certificates, Identifiers & Profiles** → **Certificates**.
3. Click the **+** button to add a new certificate.
4. Under **Software** → **Distribution**, select **Mac Installer Distribution** → **Continue**.
5. If asked to select an App ID, you can skip or choose your app if listed.
6. Click **Continue**.
7. Under **Create a new signing request or use an existing one**, click **Choose File** and select the **.certSigningRequest** file you saved in Step 2.
8. Click **Continue**.
9. Download the certificate (e.g. **mac_installer_distribution.cer**). Do not close the page before downloading; you can only download once.

---

## Step 4: Install the certificate on your Mac

1. Double‑click the downloaded **.cer** file (e.g. `mac_installer_distribution.cer`).
2. When Keychain Access opens, choose **login** (or “System”) as the keychain and click **Add**.
3. The certificate will appear in Keychain Access under **login** → **My Certificates** with a name like **“3rd Party Mac Developer Installer: Pooja Kumari (WT4F3N42NX)”**.

---

## Step 5: Confirm the identity in Terminal

Run:

```bash
security find-identity -v -p codesigning
```

You should see a line containing **“3rd Party Mac Developer Installer”** with your name and team ID. Copy that **entire** line (including the text in quotes).

---

## Step 6: Put the identity in `apple/.env`

Open **apple/.env** and set **INSTALLER_IDENTITY** to the exact string from Step 5, in quotes. Example:

```bash
INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Pooja Kumari (WT4F3N42NX)"
```

Save the file.

---

## Step 7: Run the build/upload script again

From the project root:

```bash
./apple/build-and-upload-testflight.sh
```

Step 3 (Create signed .pkg) should succeed if the certificate is installed and the identity in `.env` matches exactly.

---

## If you use a different Mac later

The certificate lives in **this Mac’s keychain**. On another Mac you must either:

- Repeat Steps 1–4 on that Mac (create a new CSR there, add a new “Mac Installer Distribution” cert in the Apple Developer account if needed, download and install the .cer on that Mac), or  
- On this Mac: in Keychain Access, export the “3rd Party Mac Developer Installer” certificate (and its private key) as a **.p12** file, copy it to the other Mac, and import the .p12 there (double‑click and enter the export password).

---

## Summary checklist

- [ ] Keychain Access opened (built-in app).
- [ ] CSR created and saved (.certSigningRequest).
- [ ] Apple Developer → Certificates → + → **Mac Installer Distribution** → upload CSR → download .cer.
- [ ] .cer double‑clicked and added to keychain (login).
- [ ] `security find-identity -v -p codesigning` shows “3rd Party Mac Developer Installer”.
- [ ] `INSTALLER_IDENTITY` in **apple/.env** set to that exact string.
- [ ] `./apple/build-and-upload-testflight.sh` run again.
