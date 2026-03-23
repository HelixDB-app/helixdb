import { APP_CHANNEL, APP_VERSION } from "@/lib/app-config";

export type CrashReportPayload = {
    message: string;
    stackTrace?: string;
    cause?: string;
    possibleFixes?: string[];
    logs?: string[];
    diagnostics?: Record<string, unknown>;
    platform?: string;
    osVersion?: string;
    deviceModel?: string;
    userId?: string;
    userEmail?: string;
    sessionId?: string;
    appVersion?: string;
    appChannel?: string;
};

function apiBase(): string {
    if (typeof window !== "undefined" && window.location.origin) {
        return window.location.origin;
    }
    return process.env.NEXT_PUBLIC_WEB_APP_URL || "";
}

export async function sendCrashReport(payload: CrashReportPayload) {
    const body = {
        ...payload,
        appVersion: payload.appVersion || APP_VERSION,
        appChannel: payload.appChannel || APP_CHANNEL,
    };
    const endpoint = `${apiBase()}/api/crash-reports`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`Crash report failed: ${response.status}`);
    }
    return response.json() as Promise<{ id: string; signature: string }>;
}
