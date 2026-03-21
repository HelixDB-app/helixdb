"use client";

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "@/lib/runtime";
import { consumePendingWebAuthReturn } from "@/lib/web-auth-login";
import { runtimeAuthFetchProfile } from "@/lib/auth-runtime";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";

/**
 * After the user signs in on pgstudio-web and is redirected back to this app (e.g. localhost:3000),
 * session cookies may need a tick to apply. Re-fetch profile and hydrate auth + trial.
 */
export function WebAuthReturnSync() {
    const ran = useRef(false);

    useEffect(() => {
        if (isTauriRuntime()) return;
        if (ran.current) return;
        ran.current = true;

        if (!consumePendingWebAuthReturn()) return;

        let cancelled = false;

        async function sync() {
            const { setUser, setLoading } = useAuthStore.getState();
            const { associateUser } = useTrialStore.getState();
            setLoading(true);
            try {
                let profile = await runtimeAuthFetchProfile();
                for (let i = 0; !profile && i < 4 && !cancelled; i++) {
                    await new Promise((r) => setTimeout(r, 350 + i * 150));
                    profile = await runtimeAuthFetchProfile();
                }
                if (!cancelled && profile) {
                    setUser(profile);
                    void associateUser(profile.id);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void sync();
        return () => {
            cancelled = true;
        };
    }, []);

    return null;
}
