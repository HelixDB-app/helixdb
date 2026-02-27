# Remove Certificates From This Mac (Start Fresh)

Removing certs here only affects **this Mac**. They still exist in the [Apple Developer portal](https://developer.apple.com/account/resources/certificates/list) until you revoke them (optional, see Step 2).

---

## Step 1: Delete certificates in Keychain Access

1. Open **Keychain Access** (Applications → Utilities).
2. In the left sidebar, select **login** (or **System** if your certs are there).
3. Click **My Certificates** in the category list (or **Certificates** and scroll).
4. Find and delete the identities you want to remove. For a clean slate, remove only **your** developer certs, for example:
   - Apple Development: Pooja Kumari (WT4F3N42NX)
   - Apple Development: Kavitha Mandidi, iamaoiot, gokulakrishnanr812, Gokula Krishnan R
   - Apple Distribution: Pooja Kumari (V9G53UFKD3) — you have two; delete both if starting over
   - Developer ID Application: Pooja Kumari (V9G53UFKD3)
   - 3rd Party Mac Developer Application: Pooja Kumari (V9G53UFKD3)

5. For each cert: **right‑click** → **Delete "Apple Distribution: ..."** (or the cert name). When asked, choose **Delete** for the private key as well (so that identity is fully removed).
6. Repeat for every certificate you want to remove.

**Do not delete:** “Apple Root CA”, “Apple Worldwide Developer Relations”, or other **system** certificates. Only remove certificates that show **your** name or your team (e.g. Pooja Kumari, Gokula Krishnan R, etc.).

---

## Step 2 (optional): Revoke certificates in Apple Developer

So you can create new ones with the same type (e.g. Apple Distribution):

1. Go to [developer.apple.com/account → Certificates](https://developer.apple.com/account/resources/certificates/list).
2. For each old certificate you no longer use: open it → **Revoke**.
3. After revoking, you can create a new certificate of that type (e.g. **Apple Distribution**) using a new CSR from this Mac (see **apple/CREATE-CSR.md**).

---

## Step 3: Create new certificates from scratch

1. Create a new CSR on this Mac: **apple/CREATE-CSR.md**.
2. In the [Certificates](https://developer.apple.com/account/resources/certificates/list) page, click **+** and create:
   - **Apple Distribution** (for App Store / TestFlight signing).
   - **Mac Installer Distribution** (for signing the .pkg) — create a separate CSR if the portal asks for one.
3. Download each `.cer` and double‑click to install.
4. Run:
   ```bash
   security find-identity -v -p codesigning
   ```
   You should see one Apple Distribution and (if you created it) one 3rd Party Mac Developer Installer.
5. Put the **SHA-1 fingerprint** (the 40‑char hex) of the **Apple Distribution** cert in `apple/.env` as `SIGNING_IDENTITY`, and the **3rd Party Mac Developer Installer** fingerprint as `INSTALLER_IDENTITY`. Then create a new provisioning profile that includes your new Apple Distribution cert (see **apple/FIX-TESTFLIGHT-409-STEPS.md**).

---

## Quick reference

| Action                    | Where |
|---------------------------|--------|
| Delete cert on this Mac   | Keychain Access → login → My Certificates → right‑click cert → Delete |
| Revoke cert (portal)      | [Certificates](https://developer.apple.com/account/resources/certificates/list) → select cert → Revoke |
| Create new cert           | New CSR (CREATE-CSR.md) → Certificates → + → upload CSR → Download .cer → double‑click to install |
