/**
 * Cross-platform push notifications: Firebase Cloud Messaging (foreground) +
 * system notifications via Tauri plugin or Web Notification API.
 * Lazy-loads FCM; respects notificationsEnabled from settings.
 * Guards against unsupported browsers to avoid Firebase messaging/unsupported-browser errors.
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
let messagingSupportPromise: Promise<boolean> | null = null;

/** FCM requires secure context and Service Worker support; avoid loading SDK in unsupported envs. */
function isMessagingSupportedByBrowser(): boolean {
  if (typeof window === "undefined") return false;
  if (isTauri()) return false;
  if (!window.isSecureContext) return false;
  if (!("Notification" in window)) return false;
  if (!("PushManager" in window)) return false;
  if (!("indexedDB" in window)) return false;
  if (!("serviceWorker" in navigator)) return false;
  return true;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function isMessagingRuntimeSupported(): Promise<boolean> {
  if (!isMessagingSupportedByBrowser()) return false;
  if (messagingSupportPromise) return messagingSupportPromise;

  messagingSupportPromise = (async () => {
    try {
      const { isSupported } = await import("firebase/messaging");
      return await isSupported();
    } catch {
      return false;
    }
  })();

  return messagingSupportPromise;
}

/**
 * Show a system notification (native OS toast). Uses Tauri plugin when available.
 * On macOS, when the app is in the foreground the OS may route the notification
 * to Notification Center instead of showing a banner — the in-app toast handles
 * that case so the user always sees it.
 */
export async function showSystemNotification(
  title: string,
  body: string,
  imageUrl?: string | null
): Promise<void> {
  if (typeof window === "undefined") return;
  void imageUrl;
  const finalTitle = title || DEFAULT_TITLE;

  if (isTauri()) {
    try {
      const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
      const granted = await isPermissionGranted();
      if (!granted) {
        console.warn("[notifications] Tauri notification permission not granted — cannot show OS notification");
        return;
      }
      // "Glass" is a pleasant macOS system notification sound.
      // Falls back gracefully on Windows/Linux (sound field ignored).
      sendNotification({
        title: finalTitle,
        body: body ?? "",
        sound: "Glass",
      });
      console.log(`[notifications] Tauri OS notification sent: "${finalTitle}"`);
    } catch (err) {
      console.error("[notifications] Tauri sendNotification failed:", err);
      // Fallback to Web Notification API if Tauri plugin unavailable
      if (window.Notification?.permission === "granted") {
        new window.Notification(finalTitle, { body: body ?? "" });
      }
    }
  } else {
    if (window.Notification?.permission === "granted") {
      new window.Notification(finalTitle, { body: body ?? "" });
    } else {
      console.warn("[notifications] Web Notification permission not granted");
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
 * Whether FCM can be used (config present and browser supports required APIs).
 */
export function isFCMAvailable(): boolean {
  if (!isMessagingSupportedByBrowser()) return false;
  const config = getFirebaseConfig();
  if (!config?.messagingSenderId || !config?.appId) return false;
  const vapid = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  return Boolean(vapid);
}

/**
 * Get FCM token for this device (for optional backend registration).
 * Returns null if FCM is unavailable or browser is unsupported; never throws.
 */
export async function getFCMToken(): Promise<string | null> {
  if (!isFCMAvailable()) return null;
  try {
    if (!(await isMessagingRuntimeSupported())) return null;
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
  if (!isFCMAvailable() || !isMessagingSupportedByBrowser()) return () => {};

  let cancelled = false;
  void (async () => {
    try {
      if (cancelled || !(await isMessagingRuntimeSupported())) return;
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
      if (cancelled) return;
      const unsub = onMessage(messaging, (payload) => {
        if (cancelled || !getNotificationsEnabled()) return;
        const { title, body, image } = normalizePayload(payload as Parameters<typeof normalizePayload>[0]);
        const payloadNorm: NotificationPayload = { title, body, image, data: payload.data as Record<string, unknown> };
        showSystemNotification(title, body, image);
        onShowInApp?.(payloadNorm);
      });
      if (!cancelled) fcmUnsubscribe = unsub;
    } catch {
      // messaging/unsupported-browser or other FCM init failure; no-op
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
