"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";
import {
    authOpenLogin,
    authStoreToken,
    authFetchProfile,
    authExchangeDesktopCode,
} from "@/lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const LOGIN_TIMEOUT_MS = 120_000;

export type DesktopAuthPhase =
    | "idle"
    | "opening"
    | "waiting"
    | "processing"
    | "timedout"
    | "error";

export interface UseDesktopAuthLoginOptions {
    /** Runs after token is stored and profile is loaded (e.g. open Stripe checkout). */
    onLoginSuccess?: () => void | Promise<void>;
}

/**
 * Desktop OAuth: open browser with `source=desktop&state=…`, listen for `pgstudio-auth-callback`,
 * store JWT (or exchange `code` for a token), load profile, optionally run a follow-up action.
 *
 * When pgstudio-web migrates to authorization codes, callbacks use `?code=…&state=…` instead of `?token=…`.
 */
export function useDesktopAuthLogin(options: UseDesktopAuthLoginOptions = {}) {
    const { onLoginSuccess } = options;
    const onLoginSuccessRef = useRef(onLoginSuccess);
    onLoginSuccessRef.current = onLoginSuccess;

    const { setUser, setPendingState } = useAuthStore();
    const { associateUser } = useTrialStore();
    const [phase, setPhase] = useState<DesktopAuthPhase>("idle");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const unlistenRef = useRef<UnlistenFn | null>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const startLogin = useCallback(async () => {
        if (phase !== "idle" && phase !== "timedout" && phase !== "error") return;

        cleanupListeners();
        setErrorMsg(null);
        setPhase("opening");

        const state = crypto.randomUUID();
        setPendingState(state);

        try {
            const unlisten = await listen<string>("pgstudio-auth-callback", async (event) => {
                cleanupListeners();
                setPhase("processing");

                try {
                    let url: URL;
                    try {
                        url = new URL(event.payload);
                    } catch {
                        const qIndex = event.payload.indexOf("?");
                        const params = new URLSearchParams(
                            qIndex >= 0 ? event.payload.slice(qIndex + 1) : ""
                        );
                        url = { searchParams: params } as URL;
                    }

                    const receivedState = url.searchParams.get("state");
                    const token = url.searchParams.get("token");
                    const code = url.searchParams.get("code");

                    if (!receivedState || receivedState !== state) {
                        setErrorMsg(
                            "Security check failed (state missing or mismatch). Please try again."
                        );
                        setPhase("error");
                        setPendingState(null);
                        return;
                    }

                    let accessToken: string | null = token;

                    if (!accessToken && code?.trim()) {
                        try {
                            accessToken = await authExchangeDesktopCode(code.trim());
                        } catch (e) {
                            const msg =
                                e instanceof Error
                                    ? e.message
                                    : "Could not exchange sign-in code. Please try again.";
                            setErrorMsg(msg);
                            setPhase("error");
                            setPendingState(null);
                            return;
                        }
                    }

                    if (!accessToken?.trim()) {
                        setErrorMsg(
                            "No token or code received from the browser. Please try again."
                        );
                        setPhase("error");
                        setPendingState(null);
                        return;
                    }

                    await authStoreToken(accessToken.trim());

                    const profile = await authFetchProfile();
                    if (profile) {
                        setUser(profile);
                        void associateUser(profile.id);
                        setPendingState(null);
                        setPhase("idle");
                        try {
                            await onLoginSuccessRef.current?.();
                        } catch {
                            // Follow-up (e.g. checkout) failed — user is still signed in
                        }
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

            await authOpenLogin(state);
            setPhase("waiting");

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
    }, [phase, cleanupListeners, setUser, setPendingState, associateUser]);

    const cancel = useCallback(() => {
        cleanupListeners();
        setPendingState(null);
        setPhase("idle");
        setErrorMsg(null);
    }, [cleanupListeners, setPendingState]);

    const isActive = phase === "opening" || phase === "waiting" || phase === "processing";

    return { phase, errorMsg, startLogin, cancel, isActive };
}
