/**
 * Cross-platform push notifications: Firebase Cloud Messaging (foreground) +
 * system notifications via Tauri plugin or Web Notification API.
 * Lazy-loads FCM; respects notificationsEnabled from settings.
 */

import { getFirebaseConfig } from "@/lib/firebase";
import { APP_NAME } from "@/lib/app-config";

const DEFAULT_TITLE = APP_NAME;

export interface NotificationPayload {
  title?: string | null;
  body?: string | null;
  image?: string | null;
  data?: Record<string, unknown>;
}

let fcmUnsubscribe: (() => void) | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/**
 * Show a system notification (native OS toast). Uses Tauri plugin when available.
 */
export async function showSystemNotification(
  title: string,
  body: string,
  _imageUrl?: string | null
): Promise<void> {
  if (typeof window === "undefined") return;
  const finalTitle = title || DEFAULT_TITLE;
  try {
    if (isTauri()) {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title: finalTitle, body: body ?? "" });
    } else {
      if (window.Notification.permission === "granted") {
        new window.Notification(finalTitle, { body: body ?? "" });
      }
    }
  } catch {
    if (window.Notification?.permission === "granted") {
      new window.Notification(finalTitle, { body: body ?? "" });
    }
  }
}

/**
 * Request OS notification permission. In Tauri, uses plugin; otherwise Web API.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    if (isTauri()) {
      const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      return granted;
    }
    if (window.Notification.permission === "granted") return true;
    if (window.Notification.permission === "denied") return false;
    const result = await window.Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

/**
 * Whether FCM can be used (config present and in supported environment).
 */
export function isFCMAvailable(): boolean {
  const config = getFirebaseConfig();
  if (!config?.messagingSenderId || !config?.appId) return false;
  const vapid = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  return Boolean(vapid && typeof window !== "undefined");
}

/**
 * Get FCM token for this device (for optional backend registration).
 */
export async function getFCMToken(): Promise<string | null> {
  if (!isFCMAvailable()) return null;
  try {
    const firebaseApp = await import("firebase/app");
    const { getMessaging, getToken } = await import("firebase/messaging");
    const config = getFirebaseConfig();
    if (!config) return null;
    let app: import("firebase/app").FirebaseApp;
    try {
      app = firebaseApp.getApp();
    } catch {
      app = firebaseApp.initializeApp(config);
    }
    const messaging = getMessaging(app);
    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY!;
    const token = await getToken(messaging, { vapidKey });
    return token ?? null;
  } catch {
    return null;
  }
}

function normalizePayload(payload: {
  notification?: { title?: string; body?: string; image?: string };
  data?: Record<string, string>;
}): { title: string; body: string; image?: string | null } {
  const notif = payload.notification;
  const data = payload.data ?? {};
  return {
    title: notif?.title ?? data.title ?? DEFAULT_TITLE,
    body: notif?.body ?? data.body ?? "",
    image: notif?.image ?? data.image ?? null,
  };
}

/**
 * Subscribe to FCM foreground messages. When a message is received and
 * notificationsEnabled is true, shows a system notification.
 * getNotificationsEnabled and onShowInApp are provided by the caller to avoid
 * importing the store inside this module (so it stays tree-shakeable).
 */
export function onFCMMessage(
  getNotificationsEnabled: () => boolean,
  onShowInApp?: (payload: NotificationPayload) => void
): () => void {
  if (fcmUnsubscribe) {
    fcmUnsubscribe();
    fcmUnsubscribe = null;
  }
  if (!isFCMAvailable()) return () => {};

  let cancelled = false;
  (async () => {
    try {
      const firebaseApp = await import("firebase/app");
      const { getMessaging, onMessage } = await import("firebase/messaging");
      const config = getFirebaseConfig();
      if (!config || cancelled) return;
      let app: import("firebase/app").FirebaseApp;
      try {
        app = firebaseApp.getApp();
      } catch {
        app = firebaseApp.initializeApp(config);
      }
      const messaging = getMessaging(app);
      const unsub = onMessage(messaging, (payload) => {
        if (cancelled || !getNotificationsEnabled()) return;
        const { title, body, image } = normalizePayload(payload as Parameters<typeof normalizePayload>[0]);
        const payloadNorm: NotificationPayload = { title, body, image, data: payload.data as Record<string, unknown> };
        showSystemNotification(title, body, image);
        onShowInApp?.(payloadNorm);
      });
      if (!cancelled) fcmUnsubscribe = unsub;
    } catch {
      // FCM not available or already initialized elsewhere
    }
  })();

  return () => {
    cancelled = true;
    if (fcmUnsubscribe) {
      fcmUnsubscribe();
      fcmUnsubscribe = null;
    }
  };
}
