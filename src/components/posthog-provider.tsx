"use client";

import { useEffect } from "react";
import { PostHogProvider } from "posthog-js/react";

import { initPosthog, posthog } from "@/lib/posthog-client";

/**
 * Initializes PostHog after mount (parity with FirebaseProvider lazy init).
 * Session recording disabled in init; pageviews not auto-captured.
 */
export function PosthogAppProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    useEffect(() => {
        initPosthog();
    }, []);

    return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
