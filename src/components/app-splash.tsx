"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Fingerprint } from "lucide-react";
import { APP_NAME } from "@/lib/app-config";
import { isTauriRuntime } from "@/lib/runtime";
import {
    biometricAuthenticate,
    securityGetBiometricLock,
} from "@/lib/security-biometric";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "@/components/ui/button";

const SPLASH_MIN_MS = 500;

export function AppSplash() {
    const pathname = usePathname();
    const reducedMotionSetting = useSettingsStore((s) => s.reducedMotion);
    const [reduceMotion, setReduceMotion] = useState(false);

    useEffect(() => {
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        const sync = () => setReduceMotion(mq.matches || reducedMotionSetting);
        sync();
        mq.addEventListener("change", sync);
        return () => mq.removeEventListener("change", sync);
    }, [reducedMotionSetting]);

    const shouldRender = useMemo(
        () =>
            isTauriRuntime() &&
            pathname !== "/desktop-search",
        [pathname]
    );

    const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
    const [biometricDone, setBiometricDone] = useState(false);
    const [splashVisible, setSplashVisible] = useState(true);
    const [gateError, setGateError] = useState<string | null>(null);
    const [unlockBusy, setUnlockBusy] = useState(false);

    const showBiometricGate = lockEnabled === true && !biometricDone;
    const showSplashChrome =
        lockEnabled !== null && !showBiometricGate;

    const revealWindow = useCallback(() => {
        import("@tauri-apps/api/webviewWindow")
            .then(({ getCurrentWebviewWindow }) => {
                getCurrentWebviewWindow().show();
            })
            .catch(() => {
                (window as unknown as { __TAURI__?: { window?: { appWindow?: { show?: () => void } } } })
                    .__TAURI__?.window?.appWindow?.show?.();
            });
    }, []);

    useEffect(() => {
        if (!shouldRender) return;
        let cancelled = false;
        (async () => {
            try {
                const on = await securityGetBiometricLock();
                if (cancelled) return;
                setLockEnabled(on);
                revealWindow();
                if (!on) {
                    setBiometricDone(true);
                }
            } catch {
                if (cancelled) return;
                setLockEnabled(false);
                setBiometricDone(true);
                revealWindow();
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [shouldRender, revealWindow]);

    useEffect(() => {
        if (!shouldRender || !showSplashChrome || !biometricDone) return;
        const id = setTimeout(() => setSplashVisible(false), SPLASH_MIN_MS);
        return () => clearTimeout(id);
    }, [shouldRender, showSplashChrome, biometricDone]);

    const onUnlock = useCallback(async () => {
        setGateError(null);
        setUnlockBusy(true);
        try {
            await biometricAuthenticate(`Unlock ${APP_NAME}`);
            setBiometricDone(true);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setGateError(msg || "Authentication failed.");
        } finally {
            setUnlockBusy(false);
        }
    }, []);

    /** One automatic biometric prompt when the gate appears; manual button remains for retry. */
    useEffect(() => {
        if (!showBiometricGate) return;
        let cancelled = false;
        const frame = requestAnimationFrame(() => {
            if (!cancelled) void onUnlock();
        });
        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
        };
    }, [showBiometricGate, onUnlock]);

    if (!shouldRender) return null;

    const overlayActive =
        lockEnabled === null ||
        splashVisible ||
        showBiometricGate;

    return (
        <div
            aria-hidden={!overlayActive}
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-background transition-opacity duration-200 ease-out"
            style={{
                opacity: overlayActive ? 1 : 0,
                pointerEvents: overlayActive ? "auto" : "none",
            }}
        >
            {lockEnabled === null ? (
                <div
                    className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
                    role="presentation"
                />
            ) : showBiometricGate ? (
                <div className="flex max-w-sm flex-col items-center gap-6 px-6 text-center">
                    <div
                        className={
                            reduceMotion
                                ? "rounded-full border-2 border-emerald-500/40 p-6"
                                : "rounded-full border-2 border-emerald-500/40 p-6 shadow-[0_0_48px_-12px_rgba(16,185,129,0.45)] animate-pulse"
                        }
                    >
                        <Fingerprint
                            className={
                                reduceMotion
                                    ? "h-16 w-16 text-emerald-400"
                                    : "h-16 w-16 text-emerald-400 motion-safe:animate-[pulse_2.4s_ease-in-out_infinite]"
                            }
                            aria-hidden
                        />
                    </div>
                    <div className="space-y-1">
                        <p className="text-lg font-semibold text-foreground">Unlock {APP_NAME}</p>
                        <p className="text-xs text-muted-foreground/80">
                            Use your device biometrics to continue (Touch ID, Windows Hello, …).
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 pt-1">
                            Adds an unlock step on this device. It does not encrypt your saved connections.
                        </p>
                    </div>
                    <Button
                        type="button"
                        size="lg"
                        className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
                        disabled={unlockBusy}
                        onClick={() => void onUnlock()}
                    >
                        {unlockBusy ? (
                            <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        ) : (
                            <Fingerprint className="h-5 w-5" aria-hidden />
                        )}
                        {unlockBusy ? "Verifying…" : "Unlock"}
                    </Button>
                    <div role="status" aria-live="polite" className="min-h-[1.25rem] text-xs text-destructive/90">
                        {gateError ?? ""}
                    </div>
                </div>
            ) : (
                <>
                    <Image
                        src="/logo.png"
                        alt=""
                        width={64}
                        height={64}
                        className="h-16 w-16 rounded-xl object-contain"
                    />
                    <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-xl font-semibold text-transparent">
                        {APP_NAME}
                    </span>
                    <div
                        className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                        role="presentation"
                    />
                </>
            )}
        </div>
    );
}
