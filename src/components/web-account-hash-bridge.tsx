"use client";

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "@/lib/runtime";
import {
    WEB_ACCOUNT_JWT_HASH_PARAM,
    setWebAccountJwt,
} from "@/lib/web-account-jwt";
import { runtimeAuthFetchProfile } from "@/lib/auth-runtime";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";

/**
 * Reads `#{WEB_ACCOUNT_JWT_HASH_PARAM}=<jwt>` from the URL after redirect from pgstudio-web,
 * stores it for Bearer auth, strips the hash, then hydrates the auth store.
 */
export function WebAccountHashBridge() {
    const ran = useRef(false);

    useEffect(() => {
        if (isTauriRuntime()) return;
        if (typeof window === "undefined") return;
        if (ran.current) return;

        const rawHash = window.location.hash;
        if (!rawHash || rawHash.length < WEB_ACCOUNT_JWT_HASH_PARAM.length + 2) return;

        const params = new URLSearchParams(
            rawHash.startsWith("#") ? rawHash.slice(1) : rawHash
        );
        const token = params.get(WEB_ACCOUNT_JWT_HASH_PARAM)?.trim();
        if (!token) return;

        ran.current = true;
        setWebAccountJwt(token);

        const url = new URL(window.location.href);
        url.hash = "";
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);

        let cancelled = false;
        (async () => {
            const { setUser, setLoading } = useAuthStore.getState();
            const { associateUser } = useTrialStore.getState();
            setLoading(true);
            try {
                const profile = await runtimeAuthFetchProfile();
                if (!cancelled && profile) {
                    setUser(profile);
                    void associateUser(profile.id);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return null;
}
