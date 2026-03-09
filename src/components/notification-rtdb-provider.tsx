"use client";

/**
 * Subscribes to Firebase RTDB notifications/{userId} for the logged-in user.
 * When a new notification arrives:
 *  1. Plays a notification chime (Web Audio API)
 *  2. Shows a native OS notification (Tauri plugin — macOS / Windows / Linux)
 *  3. Shows an in-app macOS-style banner toast
 *
 * Completely independent from FCM — works on all desktop platforms.
 */

import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showSystemNotification, requestNotificationPermission } from "@/lib/notifications";
import { playNotificationSound } from "@/lib/notification-sound";
import { getFirebaseConfig } from "@/lib/firebase";
import { InAppNotificationToast } from "@/components/in-app-notification-toast";
import type { NotificationPayload } from "@/lib/notifications";

const LOG = "[NotificationRTDB]";
const TOAST_DURATION_MS = 7000;

/** Web app base URL — used to resolve relative image URLs from the server */
const WEB_BASE_URL =
    process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";

/** Detect Tauri 2.x runtime (checks both v1 and v2 globals) */
function isTauri(): boolean {
    if (typeof window === "undefined") return false;
    const w = window as unknown as {
        __TAURI__?: unknown;
        __TAURI_INTERNALS__?: unknown;
    };
    return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

function detectOS(): "mac" | "windows" | "linux" | "other" {
    if (typeof navigator === "undefined") return "other";
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
    if (ua.includes("windows")) return "windows";
    if (ua.includes("linux")) return "linux";
    return "other";
}

/**
 * Make a potentially-relative image URL absolute so it loads
 * correctly inside the Tauri webview (which uses asset:// protocol).
 */
function resolveImageUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    // Already absolute
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    // Tauri asset protocol — keep as-is
    if (raw.startsWith("asset://")) return raw;
    // Relative path — prefix with web server base URL
    const base = WEB_BASE_URL.replace(/\/$/, "");
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    return `${base}${path}`;
}

async function registerDevice(userId: string, token: string): Promise<void> {
    try {
        const storedToken = typeof window !== "undefined"
            ? localStorage.getItem("pgstudio_jwt")
            : null;

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (storedToken) headers["Authorization"] = `Bearer ${storedToken}`;

        const res = await fetch(`${WEB_BASE_URL}/api/notifications/register-device`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                token,
                platform: "desktop",
                os: detectOS(),
            }),
        });
        if (res.ok) {
            console.log(`${LOG} Device registered: token=${token.slice(0, 20)}...`);
        } else {
            console.warn(`${LOG} Device registration failed: ${res.status}`);
        }
    } catch (err) {
        console.warn(`${LOG} Device registration error:`, err);
    }
}

async function trackNotificationOpen(notifId: string): Promise<void> {
    try {
        const storedToken = typeof window !== "undefined"
            ? localStorage.getItem("pgstudio_jwt")
            : null;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (storedToken) headers["Authorization"] = `Bearer ${storedToken}`;
        await fetch(`${WEB_BASE_URL}/api/notifications/open`, {
            method: "POST",
            headers,
            body: JSON.stringify({ notificationId: notifId }),
        });
    } catch {
        // Best-effort tracking, never block UI
    }
}

export function NotificationRTDBProvider({ children }: { children: React.ReactNode }) {
    const user = useAuthStore((s) => s.user);
    const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
    const unsubRef = useRef<(() => void) | null>(null);
    const deviceRegisteredRef = useRef<string | null>(null);

    const showInApp = useCallback((payload: NotificationPayload) => {
        toast.custom(
            (t) => (
                <InAppNotificationToast
                    payload={payload}
                    duration={TOAST_DURATION_MS}
                    onDismiss={() => toast.dismiss(t)}
                />
            ),
            {
                duration: TOAST_DURATION_MS,
                position: "top-right",   // macOS notification position
                unstyled: true,          // Don't apply Sonner's default toast styles
            }
        );
    }, []);

    useEffect(() => {
        const inTauri = isTauri();
        console.log(`${LOG} Effect: isTauri=${inTauri}, userId=${user?.id ?? "none"}, notificationsEnabled=${notificationsEnabled}`);

        if (!inTauri) return;
        if (!user?.id) return;
        if (!notificationsEnabled) {
            if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
            return;
        }

        const config = getFirebaseConfig();
        if (!config?.databaseURL) {
            console.error(`${LOG} Firebase databaseURL is not configured! Check NEXT_PUBLIC_FIREBASE_DATABASE_URL env var.`);
            return;
        }

        console.log(`${LOG} Starting RTDB subscription for userId=${user.id}, databaseURL=${config.databaseURL}`);
        let cancelled = false;

        void (async () => {
            // Request OS notification permission (required for macOS system notifications)
            const permGranted = await requestNotificationPermission();
            console.log(`${LOG} Notification permission granted: ${permGranted}`);
            if (cancelled) return;

            // Register device with backend (best effort — allows per-device targeting)
            if (deviceRegisteredRef.current !== user.id) {
                await registerDevice(user.id, `desktop-${user.id}`);
                deviceRegisteredRef.current = user.id;
            }

            try {
                const { initializeApp, getApps, getApp } = await import("firebase/app");
                const { getDatabase, ref, onChildAdded, off } = await import("firebase/database");

                if (cancelled) return;

                const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(config);
                const db = getDatabase(firebaseApp);
                const notifPath = `notifications/${user.id}`;
                const notifRef = ref(db, notifPath);

                console.log(`${LOG} Listening on RTDB path: ${notifPath}`);

                const handleNewNotification = async (snapshot: unknown) => {
                    if (cancelled) return;
                    if (!useSettingsStore.getState().notificationsEnabled) {
                        console.log(`${LOG} Notifications disabled, skipping`);
                        return;
                    }

                    const snap = snapshot as { val: () => Record<string, unknown> | null; key: string };
                    const data = snap.val();
                    if (!data) return;

                    const notifId = snap.key;
                    const title = String(data.title ?? "pgStudio");
                    const body = String(data.body ?? "");
                    const notifType = String(data.type ?? "push");

                    // ── Fix image URL: convert relative paths to absolute ──
                    // Tauri's webview uses asset:// protocol, so relative URLs
                    // like /posters/image.jpg won't resolve without the full origin.
                    const rawImageUrl = data.imageUrl ? String(data.imageUrl) : null;
                    const imageUrl = resolveImageUrl(rawImageUrl);

                    const extraData = (data.data ?? {}) as Record<string, unknown>;

                    // Resolve actionUrl as well (might be relative)
                    const rawActionUrl = extraData.actionUrl as string | undefined;
                    const actionUrl = rawActionUrl
                        ? resolveImageUrl(rawActionUrl) ?? rawActionUrl
                        : undefined;

                    console.log(`${LOG} New notification: id=${notifId}, title="${title}", type=${notifType}, image=${imageUrl ?? "none"}`);

                    const payload: NotificationPayload = {
                        title,
                        body,
                        image: imageUrl,
                        data: { ...extraData, actionUrl },
                    };

                    // ── 1. Play notification sound (Web Audio API chime) ──
                    playNotificationSound();

                    // ── 2. Show native OS notification ──
                    // macOS: when app is in foreground, the OS may suppress the banner
                    // and only show it in Notification Center. The in-app toast
                    // (step 3) ensures the user always sees it while the app is open.
                    try {
                        await showSystemNotification(title, body, imageUrl);
                        console.log(`${LOG} OS notification fired: "${title}"`);
                    } catch (err) {
                        console.error(`${LOG} showSystemNotification failed:`, err);
                    }

                    // ── 3. Show macOS-style in-app banner toast ──
                    showInApp(payload);

                    // ── 4. Track open event ──
                    if (notifId) {
                        void trackNotificationOpen(notifId);
                    }
                };

                // onChildAdded fires for all existing children on subscribe + new ones.
                // Gate: skip notifications older than 10 seconds before subscription time.
                const joinTime = Date.now();
                console.log(`${LOG} Subscribe joinTime=${new Date(joinTime).toISOString()}`);

                const wrappedHandler = async (snapshot: unknown) => {
                    const snap = snapshot as { val: () => Record<string, unknown> | null; key: string };
                    const data = snap.val();
                    if (!data) return;

                    const createdAtRaw = data.createdAt;
                    const createdAt = createdAtRaw
                        ? new Date(createdAtRaw as string).getTime()
                        : 0;

                    const ageMs = joinTime - createdAt;
                    if (createdAt > 0 && ageMs > 10_000) {
                        // Old history — skip
                        return;
                    }

                    console.log(`${LOG} Received child: key=${snap.key}, ageMs=${ageMs}`);
                    await handleNewNotification(snapshot);
                };

                onChildAdded(notifRef, wrappedHandler);
                console.log(`${LOG} RTDB onChildAdded listener registered`);

                unsubRef.current = () => {
                    console.log(`${LOG} Unsubscribing RTDB listener`);
                    off(notifRef, "child_added", wrappedHandler);
                };
            } catch (err) {
                console.error(`${LOG} Firebase RTDB setup failed:`, err);
            }
        })();

        return () => {
            cancelled = true;
            if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
        };
    }, [user?.id, notificationsEnabled, showInApp]);

    return <>{children}</>;
}
