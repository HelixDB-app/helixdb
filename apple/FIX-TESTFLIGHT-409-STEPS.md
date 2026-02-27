# Fix TestFlight 409: Certificate Must Be in Provisioning Profile

**Error:** `Invalid Code Signing. The executable ... must be signed with the certificate that is contained in the provisioning profile. (409)`

**Cause:** The app is signed with an **Apple Distribution** certificate on this Mac, but `apple/pgstudio.provisionprofile` was created for a **different** certificate (e.g. revoked, or from another machine). Apple requires the signing certificate to be **inside** the profile.

---

## Step-by-step fix

### Step 1: See which certificate you’re using

From the project root:

```bash
./apple/check-profile-cert.sh
```

(Or run the full script; it will run this check first.) You’ll see something like:

- **Profile cert:** `6172EBA2...` (the cert that’s *in* the profile)
- **Signing identity:** `76AB1EC3...` (the cert you’re *actually* signing with)

They must be the same. If they differ, continue below.

---

### Step 2: Create a new Mac App Store provisioning profile

1. Open **[developer.apple.com/account → Profiles](https://developer.apple.com/account/resources/profiles/list)**.
2. Click **+** (Add).
3. Under **Distribution**, choose **Mac App Store Connect** → **Continue**.
4. **App ID:** select **com.pgstudio.helixdb** (create it under Identifiers if it’s missing).
5. **Certificate (critical):** select **only** the **Apple Distribution** certificate that you use on this Mac.
   - In the list you may see several “Apple Distribution: Pooja Kumari (V9G53UFKD3)”.
   - Pick the one that is **not** revoked and that you use for signing (the fingerprint from the check script, e.g. `76AB1EC3...`). In the portal you can’t see the fingerprint directly; if you have only one non-revoked “Apple Distribution” for your team, use that. If you created a new cert in Step 3 below, choose that new one.
6. Name the profile (e.g. **pgstudio**) → **Generate** → **Download** (e.g. `pgstudio.provisionprofile`).

---

### Step 3 (optional but recommended): One cert = no confusion

If you have multiple “Apple Distribution” certs or revoked ones:

1. **Create a CSR on this Mac**
   - Keychain Access → **Certificate Assistant** → **Request a Certificate From a Certificate Authority...**
   - Email: your Apple ID. Common Name: e.g. **Pooja Kumari**. **Saved to disk** → save the `.certSigningRequest`.

2. **Create the cert in Apple Developer**
   - [Certificates](https://developer.apple.com/account/resources/certificates/list) → **+** → **Apple Distribution** → upload the CSR → **Download** the `.cer`.

3. **Install on this Mac**
   - Double‑click the `.cer` → add to **login** keychain. It appears under **My Certificates**.

4. **Use this cert everywhere**
   - Run: `security find-identity -v -p codesigning`
   - Copy the **SHA-1 fingerprint** (the long hex) for **Apple Distribution: Pooja Kumari (V9G53UFKD3)**.
   - In `apple/.env` set:  
     `SIGNING_IDENTITY="<paste that 40-char hex here>"`
   - In **Step 2** above, when creating the new profile, select **only** this new certificate.

---

### Step 4: Replace the profile in the project

```bash
cp ~/Downloads/pgstudio.provisionprofile /Users/gokul/Documents/personal/HelixDB/helixDB/apple/pgstudio.provisionprofile
```

(Use the actual download path/filename if different.)

---

### Step 5: Re-run the check and upload

```bash
./apple/check-profile-cert.sh
```

You should see: `OK: Provisioning profile contains the signing certificate (...).`

Then build and upload:

```bash
./apple/build-and-upload-testflight.sh
```

---

## Quick checklist

- [ ] New **Mac App Store Connect** profile created with App ID **com.pgstudio.helixdb**.
- [ ] Profile uses **only** the **Apple Distribution** cert you use on this Mac (or the new cert from Step 3).
- [ ] Downloaded profile copied to `apple/pgstudio.provisionprofile`.
- [ ] `./apple/check-profile-cert.sh` prints **OK**.
- [ ] `./apple/build-and-upload-testflight.sh` runs and upload succeeds.

---

## If you still get 409

- The profile still doesn’t contain the cert you’re signing with. Do **Step 3** (new Apple Distribution cert on this Mac), then **Step 2** again and select **only** that new cert, **Step 4**, then run the script again.
