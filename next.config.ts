import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",        // ← Static HTML/CSS/JS export
  distDir: "out",          // ← Output folder Tauri reads from
  images: {
    unoptimized: true,     // ← Required: no Next.js image server
  },
  trailingSlash: true,     // ← Required: proper routing for static files
};

export default nextConfig;
