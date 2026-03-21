/** Default matches `src-tauri/build.rs` when env vars are unset. */
export const DEFAULT_WEB_APP_URL = "https://pgstudio-web.vercel.app";

/** Control plane (pgstudio-web) origin, no trailing slash. */
export function getWebAppBaseUrl(): string {
    const u = process.env.NEXT_PUBLIC_WEB_APP_URL?.trim();
    return (u || DEFAULT_WEB_APP_URL).replace(/\/+$/, "");
}
