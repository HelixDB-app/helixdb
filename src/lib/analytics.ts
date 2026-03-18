import { getAnalyticsInstance, isFirebaseConfigured } from "@/lib/firebase";
import { APP_CHANNEL, APP_VERSION } from "@/lib/app-config";

export type AnalyticsEventName =
  | "db_connect_attempt"
  | "db_connect_success"
  | "db_connect_error"
  | "query_execute"
  | "query_execute_error"
  | "upgrade_click"
  | "feature_gate_shown";

export type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;

function sanitizeParams(params: AnalyticsParams | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Lightweight event logging.
 * - No-op unless Firebase is configured and initialized in production builds.
 * - Never log raw SQL, connection strings, emails, or credentials.
 */
export async function track(event: AnalyticsEventName, params?: AnalyticsParams): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const analytics = getAnalyticsInstance();
  if (!analytics) return;

  try {
    const { logEvent } = await import("firebase/analytics");
    logEvent(analytics, event, {
      ...sanitizeParams(params),
      app_version: APP_VERSION,
      channel: APP_CHANNEL,
    });
  } catch {
    // ignore
  }
}

