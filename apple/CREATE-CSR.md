# Create a Certificate Signing Request (CSR) on Mac

You need a CSR to create **Apple Distribution** or **Mac Installer Distribution** certificates in the [Apple Developer portal](https://developer.apple.com/account/resources/certificates/list).

---

## Step 1: Open Certificate Assistant

1. Open **Keychain Access** (Spotlight → “Keychain Access”, or **Applications → Utilities → Keychain Access**).
2. In the menu bar: **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority...**

---

## Step 2: Fill in the request

1. **User Email Address:** Your Apple ID email (e.g. the one you use for the developer account).
2. **Common Name:** Your name or your app/company name (e.g. **Pooja Kumari** or **pgStudio**). This will appear in the certificate name.
3. **CA Email Address:** Leave blank.
4. **Request is:** Select **Saved to disk** (so you get a `.certSigningRequest` file).
5. Optional: Check **Let me specify key pair information** if you want to choose key size (default is fine).
6. Click **Continue**.

---

## Step 3: Save the CSR file

1. Choose where to save (e.g. Desktop or `apple/` in your project).
2. Name it e.g. **CertificateSigningRequest.certSigningRequest**.
3. Click **Save**.

You’ll get a `.certSigningRequest` file. **Keep the private key:** it stays in your Keychain. Don’t delete the “private key” entry that was created in Keychain Access, or the certificate you get from Apple won’t work.

---

## Step 4: Create the certificate in Apple Developer

1. Go to [developer.apple.com/account → Certificates](https://developer.apple.com/account/resources/certificates/list).
2. Click **+**.
3. Choose the certificate type:
   - **Apple Distribution** – for signing the app for App Store / TestFlight.
   - **Mac Installer Distribution** – for signing the `.pkg` installer.
4. Click **Continue** → **Choose File** → select your `.certSigningRequest`.
5. Click **Continue** → **Download** the `.cer` file (you can only download once).

---

## Step 5: Install the certificate on your Mac

1. Double‑click the downloaded `.cer` file.
2. When Keychain Access opens, choose **login** (or **System**) and click **Add**.
3. The certificate appears under **My Certificates** and is linked to the private key you created with the CSR.

---

## Verify

In Terminal:

```bash
security find-identity -v -p codesigning
```

You should see the new certificate (e.g. **Apple Distribution: Pooja Kumari (V9G53UFKD3)**). Use that identity (or its SHA-1 fingerprint) in `apple/.env` as `SIGNING_IDENTITY`.

---

**Apple’s guide:** [Create a certificate signing request](https://developer.apple.com/help/account/create-certificates/create-a-certificate-signing-request)
