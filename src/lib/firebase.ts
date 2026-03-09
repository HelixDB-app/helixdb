/**
 * Firebase Analytics + lightweight crash reporting (exception events).
 * Lazy-loaded via dynamic import; no Firebase code in main bundle.
 */

import { APP_NAME, APP_VERSION, APP_CHANNEL } from "@/lib/app-config";

const MAX_DESCRIPTION_LENGTH = 500;

export function getFirebaseConfig() {
  if (typeof window === "undefined") return null;
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || undefined,
    projectId,
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || undefined,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || undefined,
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || undefined,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || undefined,
    measurementId:
      process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || undefined,
  };
}

function getConfig() {
  return getFirebaseConfig();
}

export function isFirebaseConfigured(): boolean {
  return getConfig() !== null;
}

let analyticsInstance: import("firebase/analytics").Analytics | null = null;

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

/**
 * Call after init. Logs an exception event to Firebase Analytics (lightweight Crashlytics alternative).
 */
export async function logException(
  description: string,
  fatal: boolean = false
): Promise<void> {
  if (!analyticsInstance) return;
  try {
    const { logEvent } = await import("firebase/analytics");
    logEvent(analyticsInstance, "exception", {
      description: truncate(description, MAX_DESCRIPTION_LENGTH),
      fatal,
      app_version: APP_VERSION,
      channel: APP_CHANNEL,
    });
  } catch {
    // Avoid breaking app if Analytics fails
  }
}

/**
 * Returns the Analytics instance if initialized; null otherwise.
 */
export function getAnalyticsInstance(): import("firebase/analytics").Analytics | null {
  return analyticsInstance;
}

function registerGlobalErrorHandlers(): void {
  const report = (message: string, fatal: boolean) => {
    logException(message, fatal);
  };

  window.addEventListener("error", (event) => {
    const msg =
      event.message ||
      (event.error && event.error.stack) ||
      String(event.error) ||
      "Unknown error";
    report(msg, true);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const msg =
      (event.reason && (event.reason?.message || String(event.reason))) ||
      "Unhandled rejection";
    report(msg, false);
  });
}

/**
 * Lazy init: dynamically loads Firebase SDK, initializes app and Analytics,
 * sets user properties (app_version, app_name), and registers global error handlers.
 * No-op if config is missing or in dev (optional).
 */
export async function initFirebase(): Promise<void> {
  const config = getConfig();
  if (!config) return;

  if (process.env.NODE_ENV !== "production") {
    // Optional: disable in dev to avoid polluting analytics
    return;
  }

  try {
    const { initializeApp } = await import("firebase/app");
    const {
      getAnalytics,
      setUserProperties,
      logEvent,
    } = await import("firebase/analytics");

    const app = initializeApp(config);
    const analytics = getAnalytics(app);
    analyticsInstance = analytics;

    setUserProperties(analytics, {
      app_version: APP_VERSION,
      app_name: APP_NAME,
      channel: APP_CHANNEL,
    });

    logEvent(analytics, "session_start", { app_version: APP_VERSION, channel: APP_CHANNEL });
    registerGlobalErrorHandlers();
  } catch {
    analyticsInstance = null;
  }
}
