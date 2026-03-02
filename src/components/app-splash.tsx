"use client";

import { useEffect, useState } from "react";
import { APP_NAME } from "@/lib/app-config";

const SPLASH_MIN_MS = 500;

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/**
 * Full-screen splash shown in Tauri builds while the app loads.
 * Hides after a minimum display time to avoid black screen; does not block window from opening.
 */
export function AppSplash() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!isTauri()) return;
    const id = setTimeout(() => setVisible(false), SPLASH_MIN_MS);
    return () => clearTimeout(id);
  }, []);

  if (!isTauri()) return null;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-background transition-opacity duration-200 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <img
        src="/logo.png"
        alt=""
        width={64}
        height={64}
        className="h-16 w-16 rounded-xl object-contain"
      />
      <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-xl font-semibold text-transparent">
        {APP_NAME}
      </span>
      <div
        className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
        role="presentation"
      />
    </div>
  );
}
