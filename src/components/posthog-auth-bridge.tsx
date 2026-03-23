"use client";

import { useEffect, useRef } from "react";

import {
    initPosthog,
    isPosthogConfigured,
    isPosthogReady,
    posthog,
} from "@/lib/posthog-client";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Keeps PostHog person identity in sync with app auth (control-plane profile).
 */
export function PosthogAuthBridge() {
    const user = useAuthStore((s) => s.user);
    const prevId = useRef<string | null>(null);

    useEffect(() => {
        if (typeof window === "undefined" || !isPosthogConfigured()) return;
        initPosthog();
        if (!isPosthogReady()) return;

        if (!user) {
            if (prevId.current) {
                posthog.reset();
                prevId.current = null;
            }
            return;
        }

        if (prevId.current === user.id) return;
        prevId.current = user.id;

        posthog.identify(user.id, {
            email: user.email,
            name: user.name,
            auth_provider: user.provider,
        });
    }, [user]);

    return null;
}
