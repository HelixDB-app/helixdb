import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const devHost = process.env.TAURI_DEV_HOST ?? "localhost";

// Dev-only: allow HMR / _next requests when the app loads the UI via a LAN or USB IP (Tauri iOS).
// If this array is set, Next uses strict cross-origin checks for /_next — include every host you use.
const allowedDevOrigins = !isProd
  ? Array.from(
      new Set(
        [
          "127.0.0.1",
          "192.0.0.2",
          devHost !== "localhost" && devHost !== "0.0.0.0" ? devHost : null,
        ].filter((h): h is string => Boolean(h)),
      ),
    )
  : undefined;

const nextConfig: NextConfig = {
  ...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
  // Native / optional deps in the driver; do not bundle into the server graph.
  serverExternalPackages: ["mongodb"],
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
  trailingSlash: true,
  assetPrefix: isProd ? undefined : `http://${devHost}:3000`,
  // API routes are not available with output: "export". Bug report form checks this.
  env: {
    NEXT_PUBLIC_HAS_BUG_REPORT_API: "false",
  },
};

export default nextConfig;
