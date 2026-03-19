"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";
import { authOpenLogin, authStoreToken, authFetchProfile } from "@/lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogIn, Loader2, X, RefreshCw, AlertCircle, Wifi } from "lucide-react";

// How long to wait for the desktop deep-link callback before showing a timeout UI
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

type LoginPhase =
    | "idle"        // Not logging in
    | "opening"     // Opening the browser
    | "waiting"     // Waiting for the deep-link callback
    | "processing"  // Got callback, storing token + fetching profile
    | "timedout"    // No callback within timeout
    | "error";      // Something went wrong

interface LoginPromptProps {
    /** Called after successful login */
    onLoginSuccess?: () => void;
    /** Called when user dismisses the prompt */
    onDismiss?: () => void;
    compact?: boolean;
}

export function LoginPrompt({ onLoginSuccess, onDismiss, compact = false }: LoginPromptProps) {
    const { setUser, setPendingState, isLoading: authLoading } = useAuthStore();
    const { associateUser } = useTrialStore();
    const [phase, setPhase] = useState<LoginPhase>("idle");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Tracks the active Tauri event unlisten function + timeout handle so we can
    // clean up if the component unmounts or the user retries.
    const unlistenRef = useRef<UnlistenFn | null>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Always clean up listeners and timers on unmount
    useEffect(() => {
        return () => {
            unlistenRef.current?.();
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    const cleanupListeners = useCallback(() => {
        unlistenRef.current?.();
        unlistenRef.current = null;
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    const handleLogin = useCallback(async () => {
        // Prevent concurrent login attempts
        if (phase !== "idle" && phase !== "timedout" && phase !== "error") return;

        cleanupListeners();
        setErrorMsg(null);
        setPhase("opening");

        const state = crypto.randomUUID();
        setPendingState(state);

        try {
            // Register the deep-link listener BEFORE opening the browser so we never
            // miss the callback even if the user authenticates very quickly.
            const unlisten = await listen<string>("pgstudio-auth-callback", async (event) => {
                cleanupListeners();
                setPhase("processing");

                try {
                    let url: URL;
                    try {
                        url = new URL(event.payload);
                    } catch {
                        // Fallback: manually parse query string if URL constructor fails
                        const qIndex = event.payload.indexOf("?");
                        const params = new URLSearchParams(qIndex >= 0 ? event.payload.slice(qIndex + 1) : "");
                        url = { searchParams: params } as URL;
                    }

                    const receivedState = url.searchParams.get("state");
                    const token = url.searchParams.get("token");

                    if (!token) {
                        setErrorMsg("No token received from the browser. Please try again.");
                        setPhase("error");
                        setPendingState(null);
                        return;
                    }

                    // CSRF state validation — only enforce when we have a state param
                    if (receivedState && receivedState !== state) {
                        setErrorMsg("Security check failed (state mismatch). Please try again.");
                        setPhase("error");
                        setPendingState(null);
                        return;
                    }

                    // Store JWT in OS keychain
                    await authStoreToken(token);

                    // Fetch profile from web API using the newly stored token
                    const profile = await authFetchProfile();
                    if (profile) {
                        setUser(profile);
                        void associateUser(profile.id);
                        setPendingState(null);
                        setPhase("idle");
                        onLoginSuccess?.();
                    } else {
                        setErrorMsg("Signed in but could not load your profile. Please try again.");
                        setPhase("error");
                        setPendingState(null);
                    }
                } catch (err) {
                    setErrorMsg(err instanceof Error ? err.message : "Login failed. Please try again.");
                    setPhase("error");
                    setPendingState(null);
                }
            });

            unlistenRef.current = unlisten;

            // Open browser at login page
            await authOpenLogin(state);
            setPhase("waiting");

            // Timeout guard: if the deep-link callback never arrives, inform the user
            timeoutRef.current = setTimeout(() => {
                cleanupListeners();
                setPendingState(null);
                setPhase("timedout");
            }, LOGIN_TIMEOUT_MS);
        } catch (err) {
            cleanupListeners();
            setPendingState(null);
            setErrorMsg(err instanceof Error ? err.message : "Failed to open the browser");
            setPhase("error");
        }
    }, [phase, cleanupListeners, setUser, setPendingState, onLoginSuccess]);

    const handleCancel = useCallback(() => {
        cleanupListeners();
        setPendingState(null);
        setPhase("idle");
        setErrorMsg(null);
    }, [cleanupListeners, setPendingState]);

    const isActive = phase === "opening" || phase === "waiting" || phase === "processing";

    // ── Compact (header button) mode ─────────────────────────────────────────
    if (compact) {
        // While startup session restore is in progress, show a skeleton
        if (authLoading) {
            return <Skeleton className="h-7 w-16 rounded-md" />;
        }

        if (phase === "timedout") {
            return (
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground/70">Timed out</span>
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs h-7"
                        onClick={handleLogin}
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </Button>
                </div>
            );
        }

        if (phase === "error" && errorMsg) {
            return (
                <div className="flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs h-7"
                        onClick={handleLogin}
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </Button>
                </div>
            );
        }

        if (isActive) {
            return (
                <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs h-7"
                    onClick={handleCancel}
                >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {phase === "processing" ? "Signing in…" : "Waiting…"}
                    <X className="h-3 w-3 ml-0.5 opacity-50" />
                </Button>
            );
        }

        return (
            <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs"
                onClick={handleLogin}
            >
                <LogIn className="h-3.5 w-3.5" />
                Sign In
            </Button>
        );
    }

    // ── Full (card) mode ─────────────────────────────────────────────────────
    return (
        <div className="rounded-xl border border-border/50 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start justify-between mb-3">
                <div>
                    <h3 className="text-sm font-semibold leading-tight">Sign in to pgStudio</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        Sync your profile and preferences across devices
                    </p>
                </div>
                {onDismiss && (
                    <button
                        className="ml-2 mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
                        onClick={onDismiss}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* Status / error banner */}
            {phase === "timedout" && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 text-xs text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                        No response received from the browser.
                        Complete sign-in in the browser tab that opened, then click <strong>Retry</strong>.
                    </span>
                </div>
            )}
            {phase === "error" && errorMsg && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-2.5 py-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {errorMsg}
                </div>
            )}
            {phase === "waiting" && (
                <div className="mb-3 flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
                    <Wifi className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                    Browser opened — complete sign-in there, then return here.
                </div>
            )}

            {/* Primary action button */}
            {isActive ? (
                <div className="flex gap-2">
                    <Button
                        size="sm"
                        className="flex-1 gap-2"
                        disabled
                    >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {phase === "processing" ? "Signing in…" : "Waiting for browser…"}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 px-3"
                        onClick={handleCancel}
                    >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                    </Button>
                </div>
            ) : (
                <Button
                    size="sm"
                    className="w-full gap-2"
                    onClick={handleLogin}
                >
                    {phase === "timedout" || phase === "error" ? (
                        <RefreshCw className="h-3.5 w-3.5" />
                    ) : (
                        <LogIn className="h-3.5 w-3.5" />
                    )}
                    {phase === "timedout" ? "Retry Sign In" : phase === "error" ? "Try Again" : "Sign In with Browser"}
                </Button>
            )}
        </div>
    );
}
