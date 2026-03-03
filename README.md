This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


## Building the Mac app

```bash
cd /Users/gokul/Documents/personal/HelixDB/helixDB && unset CI && cargo tauri build
```

Output:
- **App:** `src-tauri/target/release/bundle/macos/pgStudio.app`
- **DMG:** `src-tauri/target/release/bundle/dmg/pgStudio_0.1.0_aarch64.dmg`

## Sharing the DMG and fixing "can't be opened" on other Macs

**How to share:** Upload the DMG to Google Drive, Dropbox, iCloud, or [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github), then send the link.

**Why others see an error:** The app is not code-signed. macOS Gatekeeper blocks apps from "unidentified developers," so they may see:
- *"pgStudio can't be opened because it is from an unidentified developer"*
- Or *"App is damaged and can't be opened"* (often the same cause)

**What recipients can do (bypass once per Mac):**

1. **Right-click open (recommended):** Right-click (or Control+click) **pgStudio.app** → **Open** → click **Open** in the dialog. Gatekeeper will allow it this time and remember.
2. **System Settings:** If a message appears in **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to pgStudio.
3. **Remove quarantine (Terminal):** After installing the app (e.g. into Applications), run:
   ```bash
   xattr -cr /Applications/pgStudio.app
   ```
   Then open pgStudio normally.

**Proper long-term fix (no bypass needed):** Sign and notarize the app with an [Apple Developer account](https://developer.apple.com) ($99/year). Then Gatekeeper will trust it. See [Tauri: Code signing macOS](https://tauri.app/v1/guides/distribution/sign-macos/) and set `bundle.macOS.signingIdentity` and related options in `src-tauri/tauri.conf.json`.



to start a app in dev
cd /Users/gokul/Documents/personal/HelixDB/helixDB                                 
cargo tauri dev





run apple check
./apple/check-and-staple.sh 098eccf8-60d5-4048-828f-bfb3fb3ebab0






stripe listen --forward-to localhost:3001/api/stripe/webhook