"use client";

import { useEffect, useRef } from "react";
import { useUpdateStore } from "@/stores/update-store";
import { isTauriRuntime } from "@/lib/runtime";
import { AppUpdateModal } from "@/components/app-update-modal";

const AUTO_CHECK_DELAY_MS = 1500;

export function AppUpdateManager() {
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    const timer = setTimeout(() => {
      void checkForUpdates({ source: "auto" });
    }, AUTO_CHECK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  return <AppUpdateModal />;
}
