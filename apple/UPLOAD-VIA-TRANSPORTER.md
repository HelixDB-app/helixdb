# Upload to TestFlight via Transporter (Instead of Command Line)

Your app is built with **Tauri**, not Xcode, so there is no Xcode project to “Archive” from. You have two ways to get the build to App Store Connect:

1. **Script (current):** `./apple/build-and-upload-testflight.sh` — builds, signs, creates .pkg, and uploads with `altool`.
2. **Transporter app:** Build and sign with the script (or manually), then **upload the .pkg** using Apple’s **Transporter** app (GUI). No Xcode needed.

---

## Option A: Build + sign with script, upload with Transporter

1. **Build and sign only** (no upload). From the project root:
   ```bash
   # Run the script; when it reaches "Upload to TestFlight", cancel (Ctrl+C) if you want to upload manually.
   # Or run build + sign steps yourself (see Option B below).
   ```
   Easier: run the full script once so you have a signed `pgStudio.pkg` in the repo root. The script uploads it automatically. If you prefer to upload yourself, after the script finishes you can **re-upload** the same .pkg via Transporter (usually you’d only do this if the first upload failed or you want to use the GUI next time).

2. **Upload with Transporter**
   - Install **Transporter** from the [Mac App Store](https://apps.apple.com/us/app/transporter/id1450874784?mt=12) (by Apple).
   - Open Transporter and sign in with your **Apple ID** (the one used for App Store Connect).
   - Drag your signed **pgStudio.pkg** onto the window (or click **Deliver Your App** and choose the file).
   - Click **Deliver**. Transporter uploads to App Store Connect; the build will show up under TestFlight (same as with the script).

**When to use:** You want a GUI, or the script’s `altool` upload fails and you want to try Transporter instead.

---

## Option B: Build and sign manually, then Transporter

If you don’t want to run the full script:

1. **Build** (universal macOS):
   ```bash
   unset CI && cargo tauri build --target universal-apple-darwin
   ```
   App path: `src-tauri/target/universal-apple-darwin/release/bundle/macos/pgStudio.app`

2. **Sign the app** (use your Apple Distribution identity and entitlements; see `build-and-upload-testflight.sh` steps 2–3 for exact commands).

3. **Create signed .pkg** (use your 3rd Party Mac Developer Installer identity; see script step 4).

4. **Upload:** Open **Transporter** → sign in → drag **pgStudio.pkg** → **Deliver**.

---

## Why not “Archive” in Xcode?

- **Archive** and **Distribute App** in Xcode work with **Xcode projects** (.xcodeproj) or workspaces. Your app is built with **Tauri** (Rust + web frontend); there is no Xcode project in this repo.
- So you **cannot** use **Product → Archive** in Xcode for this app. You build with `cargo tauri build`, then either:
  - upload the resulting signed **.pkg** via the script (`altool`), or  
  - upload the same signed **.pkg** via **Transporter**.

Both end up in the same place: App Store Connect → your app → TestFlight.
