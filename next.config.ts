import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const devHost = process.env.TAURI_DEV_HOST ?? "localhost";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
  trailingSlash: true,
  assetPrefix: isProd ? undefined : `http://${devHost}:3000`,
};

export default nextConfig;
