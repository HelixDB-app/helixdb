import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SubscriptionStatus {
    id: string;
    planName: string;
    planSlug: string;
    status: "active" | "expired" | "cancelled" | "pending";
    discordAccess: string;
    startDate: string;
    endDate: string;
    paymentAmount: number;
    paymentCurrency: string;
    cancelledAt?: string;
}

interface SubscriptionState {
    subscription: SubscriptionStatus | null;
    isLoading: boolean;
    lastSynced: Date | null;
    pollingInterval: ReturnType<typeof setInterval> | null;

    setSubscription: (s: SubscriptionStatus | null) => void;
    setLoading: (v: boolean) => void;
    fetchStatus: () => Promise<void>;
    startPolling: () => void;
    stopPolling: () => void;
    reset: () => void;
}

const POLL_INTERVAL_MS = 60_000;

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
    subscription: null,
    isLoading: false,
    lastSynced: null,
    pollingInterval: null,

    setSubscription: (subscription) => set({ subscription }),
    setLoading: (isLoading) => set({ isLoading }),

    fetchStatus: async () => {
        set({ isLoading: true });
        try {
            const result = await invoke<SubscriptionStatus | null>("subscription_fetch_status");
            set({ subscription: result ?? null, lastSynced: new Date() });
        } catch {
            // Silently ignore errors (network issues, app offline)
        } finally {
            set({ isLoading: false });
        }
    },

    startPolling: () => {
        const existing = get().pollingInterval;
        if (existing) return;

        get().fetchStatus();

        const interval = setInterval(() => {
            get().fetchStatus();
        }, POLL_INTERVAL_MS);

        set({ pollingInterval: interval });
    },

    stopPolling: () => {
        const interval = get().pollingInterval;
        if (interval) {
            clearInterval(interval);
            set({ pollingInterval: null });
        }
    },

    reset: () => {
        get().stopPolling();
        set({ subscription: null, isLoading: false, lastSynced: null });
    },
}));
