"use client";

import { useCallback, useEffect, useRef } from "react";
import { WifiOff } from "lucide-react";
import { toast } from "sonner";
import {
  APP_OFFLINE_EVENT,
  isBrowserOffline,
} from "@/lib/network-errors";

const OFFLINE_TOAST_ID = "helix-offline-toast";

function OfflineConnectionToast() {
  return (
    <div className="flex min-w-[300px] max-w-[380px] items-start gap-3 rounded-lg border border-amber-500/40 bg-card/95 p-3 shadow-lg backdrop-blur-sm">
      <div className="mt-0.5 rounded-md bg-amber-500/15 p-1.5 text-amber-400">
        <WifiOff className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">
          No internet connection
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          You are offline. This popup will close automatically once your
          connection is restored.
        </p>
      </div>
    </div>
  );
}

export function NetworkStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const isOfflineRef = useRef(false);

  const showOfflineToast = useCallback(() => {
    toast.custom(() => <OfflineConnectionToast />, {
      id: OFFLINE_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
    });
  }, []);

  const hideOfflineToast = useCallback(() => {
    toast.dismiss(OFFLINE_TOAST_ID);
  }, []);

  const setOfflineState = useCallback(
    (offline: boolean) => {
      if (isOfflineRef.current === offline) return;
      isOfflineRef.current = offline;
      if (offline) {
        showOfflineToast();
        return;
      }
      hideOfflineToast();
    },
    [hideOfflineToast, showOfflineToast]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    setOfflineState(isBrowserOffline());

    const handleOffline = () => setOfflineState(true);
    const handleOnline = () => setOfflineState(false);
    const handleOfflineDetected = () => setOfflineState(true);

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    window.addEventListener(
      APP_OFFLINE_EVENT,
      handleOfflineDetected as EventListener
    );

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener(
        APP_OFFLINE_EVENT,
        handleOfflineDetected as EventListener
      );
      hideOfflineToast();
    };
  }, [hideOfflineToast, setOfflineState]);

  return <>{children}</>;
}
