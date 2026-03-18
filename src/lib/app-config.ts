/** Single source of truth for app branding. */
export const APP_NAME = "pgStudio";
/** Version string shown in UI and sent with bug reports/analytics. Keep in sync with tauri.conf.json and package.json. */
export const APP_VERSION = "1.4.5";
/** "beta" for beta builds (TestFlight); "stable" for production. Used to filter bug reports and analytics. */
export const APP_CHANNEL: "beta" | "stable" = "stable";
export const APP_TAGLINE = "Performance-first Postgres Studio";
