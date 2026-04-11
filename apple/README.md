# Share pgStudio with testers (TestFlight or direct DMG)

## Ways to share a build

| Method | Time | Tester experience | Best for |
|--------|------|-------------------|----------|
| **Quick share** (signed DMG) | ~2–3 min | One-time: right-click → Open | Fast handoff, internal testers |
| **Notarized DMG** | ~5–15 min | Opens normally | Sharing link to anyone |
| **TestFlight** | ~15–30 min | Install via TestFlight app | Many testers, version history |

---

## Option A: Quick share (fastest – no notarization wait)

**Prereq:** Developer ID Application cert. In `apple/.env` set:
`DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"`  
Get it: `security find-identity -v -p codesigning`

```bash
./apple/build-quick-share-dmg.sh
```

Then **share the DMG**: upload `src-tauri/target/release/bundle/dmg/pgStudio_quick_share.dmg` to Google Drive, Dropbox, WeTransfer, or any file host and send the link.

**What you tell testers:**  
“Download the DMG, open it, drag pgStudio to Applications. First time: **right-click pgStudio → Open** (do not double-click). If already blocked: System Settings → Privacy & Security → **Open Anyway** next to pgStudio.”

---

## Option B: Notarized DMG (opens on any Mac, no “Open Anyway”)

**Prereq:** Same Developer ID cert + in `apple/.env`: `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (for notarization).

```bash
./apple/build-shareable-dmg.sh
```

Share `pgStudio_shareable.dmg` (e.g. upload and send link). Testers open it normally.

**If notarization times out:** Run later:
```bash
./apple/check-and-staple.sh <submission-id>
```

---

## Option C: TestFlight

**Easier testing first:** For quick internal testing, prefer [Option A (Quick share)](.#option-a-quick-share-fastest--no-notarization-wait) or [Option B (Notarized DMG)](.#option-b-notarized-dmg-opens-on-any-mac-no-open-anyway). Use TestFlight when you need many testers or version history. **Full certificate creation + 409 fix:** [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md).

**One-time setup (Apple Developer + App Store Connect):**

1. **Certificates**: **Apple Distribution** + **3rd Party Mac Developer Installer**. [Installer cert steps](INSTALLER-CERT-SETUP.md).
2. **Bundle ID** (if needed): [Developer portal](https://developer.apple.com/account/resources/identifiers/list) → Identifiers → + → **App IDs** → App → Description e.g. "pgStudio", Bundle ID **`com.pgstudio.helixdb`** → Register.
3. **App** in [App Store Connect](https://appstoreconnect.apple.com) → **My Apps** → **+** → **New App** → choose **macOS** (not iOS), name e.g. "pgStudio", Bundle ID **`com.pgstudio.helixdb`**, SKU e.g. "pgstudio" → Create.
4. **API key**: App Store Connect → Users and Access → Integrations → Keys → Create; download `.p8`, note Key ID and Issuer ID. The key’s team must match the app.

Copy `apple/env.example` to `apple/.env`, fill in identities and API key, then:

**Option 1 – Script uploads (CLI):**
```bash
./apple/build-and-upload-testflight.sh
```

**Option 2 – Upload via Xcode Transporter (GUI):**  
Build and sign the .pkg only (no API key needed), then upload with Transporter:

```bash
./apple/build-pkg-for-testflight.sh
```

Then open **Transporter** (install from [Mac App Store](https://apps.apple.com/app/transporter/id1450874784) or Xcode → Open Developer Tool → Transporter) → sign in with your Apple ID → drag **pgStudio.pkg** into the window → **Deliver**. Build appears under the app in TestFlight (5–15 min).

Add testers in App Store Connect → pgStudio → TestFlight; they install via the TestFlight app.

**"Cannot determine the Apple ID from Bundle ID" (12):** The app is missing or wrong in App Store Connect. Create it: My Apps → + → New App → **macOS** (not iOS), Bundle ID **`com.pgstudio.helixdb`**. Ensure the API key’s team is the same as the app.

**"Invalid Code Signing... must be signed with the certificate that is contained in the provisioning profile" (409):** The provisioning profile was created for a **different** Distribution certificate. **Step-by-step fix:** [TESTFLIGHT-409-FIX-PLAN.md](TESTFLIGHT-409-FIX-PLAN.md). Summary: [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md).

**"Invalid Provisioning Profile" / "Missing code-signing certificate" (409):** Same as above: profile must match the signing cert. See [CERT-AND-TESTFLIGHT-GUIDE.md](CERT-AND-TESTFLIGHT-GUIDE.md).

**"Invalid Code Signing Entitlements" / literal "TEAM_ID" in bundle (409):** The script substitutes your real Team ID into entitlements from `SIGNING_IDENTITY` (e.g. `(V9G53UFKD3)` → `V9G53UFKD3`). If that fails, set **`APPLE_TEAM_ID`** in `apple/.env` (e.g. `APPLE_TEAM_ID=V9G53UFKD3`). Do not put literal `TEAM_ID` in `Entitlements.plist`; the script replaces it at build time.

**"arm64 but not Intel" / architecture (409):** The app is built for Apple Silicon only; TestFlight allows that if the macOS minimum version is 12.0+. This project sets `minimumSystemVersion: "12.0"` in `tauri.conf.json`. Rebuild after pulling that change.

**Manual steps (TestFlight):**

```bash
pnpm install && pnpm tauri build
export SIGNING_IDENTITY="3rd Party Mac Developer Application: Your Name (TEAM_ID)"
./apple/codesign-app.sh
export INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
export APPLE_API_KEY_ID=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=/path/to/AuthKey_XXX.p8
./apple/upload-testflight.sh
```

After processing (5–15 min), the build appears under your app → **TestFlight**. Full details: [docs/TESTFLIGHT-MACOS.md](../docs/TESTFLIGHT-MACOS.md)
