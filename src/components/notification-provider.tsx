"use client";

import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings-store";
import {
  requestNotificationPermission,
  onFCMMessage,
  isFCMAvailable,
  type NotificationPayload,
} from "@/lib/notifications";
import { InAppNotificationToast } from "@/components/in-app-notification-toast";

/**
 * Subscribes to FCM when notifications are enabled, requests permission on first enable,
 * shows system notifications, and an in-app toast with app logo and optional image.
 */
export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const unsubRef = useRef<(() => void) | null>(null);
  const getEnabled = useCallback(
    () => useSettingsStore.getState().notificationsEnabled,
    []
  );

  const onShowInApp = useCallback((payload: NotificationPayload) => {
    toast.custom(
      (t) => (
        <InAppNotificationToast
          payload={payload}
          onDismiss={() => toast.dismiss(t)}
        />
      ),
      { duration: 5000 }
    );
  }, []);

  useEffect(() => {
    if (!notificationsEnabled) {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      return;
    }
    if (!isFCMAvailable()) return;

    let mounted = true;
    (async () => {
      const granted = await requestNotificationPermission();
      if (!mounted || !granted) return;
      unsubRef.current = onFCMMessage(getEnabled, onShowInApp);
    })();
    return () => {
      mounted = false;
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [notificationsEnabled, getEnabled, onShowInApp]);

  return <>{children}</>;
}
