# Automatic Certificate & Provisioning Profile Management

Instead of manually creating CSRs, downloading certs, and creating provisioning profiles, you can use **Fastlane Match**. It creates and stores certificates and profiles in a **private git repo** (or Google Cloud / S3), and any machine (or CI) can run `match` to install the same certs and profiles — no manual portal steps.

---

## Option 1: Fastlane Match (recommended)

**What it does:**
- Creates **Apple Distribution** and **Mac Installer Distribution** certificates (and provisioning profiles) for you.
- Stores them **encrypted** in a private repo; you run `match` to install them on this Mac or CI.
- Same command on every machine: same certs and profiles → no 409 mismatch.
- Can repair or regenerate when something expires or is revoked.

**Trade-off:** Match expects to **own** code signing. On first setup it will **revoke** existing certs of the types it manages (Apple Distribution, etc.) and create new ones. So do this when you’re okay starting fresh (or on a new Apple Developer account).

### Minimal setup (one-time)

1. **Install Fastlane**
   ```bash
   # macOS: Ruby is built-in; install fastlane
   sudo gem install fastlane
   # Or with Homebrew: brew install fastlane
   ```

2. **Create a private Git repo** (GitHub / GitLab / Bitbucket) **only for match**. It will store encrypted certs and profiles. Example: `my-company-apple-certs` (private).

3. **Go to your project**
   ```bash
   cd /Users/gokul/Documents/personal/HelixDB/helixDB
   ```

4. **Run match init** (creates `fastlane/Matchfile`)
   ```bash
   fastlane match init
   ```
   When asked for the git URL, use your private repo, e.g. `https://github.com/yourorg/apple-certs.git`.

5. **Edit `fastlane/Matchfile`** so it matches your app and team:
   - `app_identifier "com.pgstudio.helixdb"`
   - `team_id "V9G53UFKD3"`
   - `storage_mode "git"`
   - `git_url "https://github.com/yourorg/apple-certs.git"`

6. **Generate certs and profiles (first time only)**  
   This will **revoke** existing Apple Distribution–type certs and create new ones, then store them in the repo.
   ```bash
   fastlane match appstore
   ```
   Use `match mac_appstore` if your Fastlane version uses that for Mac. If in doubt, run:
   ```bash
   fastlane match appstore --platform macos
   ```
   You’ll be asked for a **passphrase** to encrypt the repo; remember it (and store it in CI secrets as `MATCH_PASSWORD`).

7. **Install on this Mac**
   After the first run, certs and profiles are in the repo. On this Mac (or another), run again to install into Keychain:
   ```bash
   fastlane match appstore --platform macos
   ```

8. **Use the certs with your build**
   After `match`, run:
   ```bash
   security find-identity -v -p codesigning
   ```
   Use the **Apple Distribution** fingerprint in `apple/.env` as `SIGNING_IDENTITY`, and the **3rd Party Mac Developer Installer** as `INSTALLER_IDENTITY`. Copy the new **provisioning profile** from the match repo (or the path match prints) to `apple/pgstudio.provisionprofile`. Then run your existing build script; the profile will match the cert.

**CI (e.g. GitHub Actions):** Store in secrets: `MATCH_PASSWORD`, `MATCH_GIT_BASIC_AUTHORIZATION` (base64 of `user:token`), and optionally the repo URL. In the job, run `fastlane match appstore --platform macos --readonly` (readonly so CI doesn’t create new certs), then build and sign with the script.

**Docs:** [Fastlane Match](https://docs.fastlane.tools/actions/match/), [codesigning getting started](https://docs.fastlane.tools/codesigning/getting-started/).

---

## Option 2: Xcode “Automatically manage signing”

Only works for **Xcode projects**. Your app is Tauri (no `.xcodeproj`), so this option doesn’t apply. You’d need to use Match (or manual certs) for Tauri.

---

## Option 3: Apple Developer API (advanced)

Apple has APIs to create certificates and provisioning profiles programmatically. Tools like Match use these under the hood. Building your own automation on top is possible but more work; Match is the standard approach.

---

## Summary

| Method | Automatic? | Best for |
|--------|------------|----------|
| **Manual** (CSR → portal → .cer → profile) | No | One machine, full control |
| **Fastlane Match** | Yes (after one-time setup) | Team, CI, same certs everywhere |
| **Xcode automatic signing** | Yes | Xcode projects only (not Tauri) |

For automatic certificate management with a Tauri Mac app, **Fastlane Match** is the practical option: one-time setup, then `fastlane match appstore --platform macos` (and copy the profile into `apple/`) before building with your existing script.
