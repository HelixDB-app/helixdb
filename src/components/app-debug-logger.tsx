"use client";

import { useEffect, useRef } from "react";
import { appLogWrite } from "@/lib/tauri";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/** Registers global error handlers and writes to app debug log (for TestFlight / support). */
export function AppDebugLogger() {
  const registered = useRef(false);

  useEffect(() => {
    if (!isTauri() || registered.current) return;
    registered.current = true;

    const log = (kind: string, payload: unknown) => {
      const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
      appLogWrite(`[${kind}] ${msg}`).catch(() => {});
    };

    const onError = (e: ErrorEvent) => {
      log("error", `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
    };

    const onUnhandled = (e: PromiseRejectionEvent) => {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      log("unhandledrejection", reason);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  return null;
}
