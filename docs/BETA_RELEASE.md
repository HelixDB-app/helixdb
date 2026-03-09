# Beta release guide

How to ship a beta build, collect bug reports from users, and fix issues in a professional way.

---

## 1. Beta versioning

- **Stable**: `1.4.5` (semver, no suffix).
- **Beta**: `1.4.5-beta.1`, `1.4.5-beta.2`, … (same major.minor.patch, increment beta number each new beta build).

Keep one source of truth and sync everywhere before each build:

| File | What to set |
|------|-------------|
| `src-tauri/tauri.conf.json` | `"version": "1.4.5"` or `"1.4.5-beta.1"` |
| `src-tauri/Cargo.toml` | `version = "1.4.5"` (no `-beta` needed for Cargo) |
| `package.json` | `"version": "1.4.5"` or `"1.4.5-beta.1"` |
| `src/lib/app-config.ts` | `APP_VERSION`, `APP_CHANNEL` (see below) |

For a **beta** build set in `app-config.ts`:

- `APP_VERSION = "1.4.5-beta.1"`
- `APP_CHANNEL = "beta"`

For a **stable** build:

- `APP_VERSION = "1.4.5"`
- `APP_CHANNEL = "stable"`

---

## 2. Building a beta

1. **Bump version** (e.g. to `1.4.5-beta.1`) in:
   - `src-tauri/tauri.conf.json`
   - `package.json`
   - `src/lib/app-config.ts` (and set `APP_CHANNEL = "beta"`)

2. **Build** (macOS example):
   ```bash
   pnpm build:mac
   ```
   Or for universal + TestFlight:
   ```bash
   pnpm tauri build --bundles app --target universal-apple-darwin
   ```

3. **Distribute** using your existing flow (e.g. TestFlight): see [TESTFLIGHT-MACOS.md](./TESTFLIGHT-MACOS.md).

---

## 3. How users report bugs

- **In-app**: **Help → Submit feedback & bug reports** (or shortcut) opens `/bug-report`.
- Reports go to **Firebase** (Realtime Database + optional screenshots in Storage).
- Each report includes:
  - `appVersion` (e.g. `1.4.5-beta.1`)
  - `channel` (`beta` or `stable`)
  - Title, description, connection/env info, optional screenshots.

**You already have**: Error boundary → Firebase Analytics `exception` events; global error handler; and the bug report form. For beta, all of this is tagged with `app_version` and (after the change) `channel`, so you can filter to beta-only.

---

## 4. Triage: finding and prioritizing bugs

1. **Firebase Realtime Database**  
   Path: `bugReports/<reportId>`.  
   - Filter by `channel == "beta"` (or `appVersion` contains `-beta`) to see only beta feedback.
   - Use Firebase Console or export to a sheet; sort by `createdAtMs` or `createdAtServer`.

2. **Firebase Analytics**  
   - In Analytics, segment by custom dimension/event params: `app_version` (and `channel` once added).  
   - Check **Events → exception** for stack traces and non-fatal errors; filter to beta versions.

3. **Prioritize**  
   - Crashes / data loss / security → P0, fix before next beta or stable.  
   - Broken flows / wrong results → P1.  
   - UI/UX and small bugs → P2.

---

## 5. Fix workflow (repro → fix → release)

1. **Repro**  
   - Read report (title, description, screenshots, env).  
   - If needed, ask the user for steps or a DB schema (anonymized).  
   - Reproduce locally on a build with same version/channel if possible.

2. **Fix**  
   - Fix in a branch (e.g. `fix/beta-123-description`).  
   - Add a test or manual test step so the bug doesn’t regress.

3. **Release**  
   - Merge to main (or release branch).  
   - Bump to next beta: e.g. `1.4.5-beta.2` and set `APP_CHANNEL = "beta"` again.  
   - Build and ship via TestFlight (or your beta channel).  
   - Optionally post in release notes: “Beta 2: fixes …”.

4. **Stable**  
   - When beta is solid, set version to `1.4.5`, `APP_CHANNEL = "stable"`, and ship stable; then start next cycle (e.g. `1.4.6-beta.1`) if you keep a beta channel.

---

## 6. Checklist for each beta build

- [ ] Version bumped in `tauri.conf.json`, `package.json`, `src/lib/app-config.ts`
- [ ] `APP_CHANNEL = "beta"` in `app-config.ts` for beta builds
- [ ] Build succeeds (`pnpm build:mac` or universal target)
- [ ] Test: submit one bug report from the app and confirm it appears in Firebase with correct `appVersion` and `channel`
- [ ] Distribute via TestFlight (or your beta channel)
- [ ] Tell testers how to report bugs (Help → Submit feedback & bug reports)

---

## 7. Optional: in-app “Beta” label

The app shows a **Beta** badge on the bug report page when `APP_CHANNEL === "beta"`, so testers see they’re on a beta build. You can reuse `APP_CHANNEL` elsewhere (e.g. in About or the footer) if you want.
