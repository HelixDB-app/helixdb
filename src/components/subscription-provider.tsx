"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useSubscriptionStore } from "@/stores/subscription-store";
import { isTauriRuntime } from "@/lib/runtime";

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuthStore();
    const { startPolling, stopPolling, reset } = useSubscriptionStore();

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (user) {
            startPolling();
        } else {
            stopPolling();
            reset();
        }
        return () => {
            stopPolling();
        };
    }, [user, startPolling, stopPolling, reset]);

    return <>{children}</>;
}
