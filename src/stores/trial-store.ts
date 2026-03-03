import { create } from "zustand";
import { trialInit, trialGetStatus, type TrialCheckResult, type TrialStatus } from "@/lib/tauri";

/** How often to silently revalidate trial status in the background (ms) */
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type TrialLoadState = "idle" | "loading" | "ready" | "error";

interface TrialState {
    result: TrialCheckResult | null;
    loadState: TrialLoadState;
    error: string | null;
    lastSynced: Date | null;
    pollingInterval: ReturnType<typeof setInterval> | null;

    // Derived helpers
    isTrialActive: () => boolean;
    isTrialExpired: () => boolean;
    daysRemaining: () => number;
    trialStatus: () => TrialStatus | null;

    // Actions
    initTrial: (associatedUserId?: string) => Promise<void>;
    refreshStatus: () => Promise<void>;
    startPolling: () => void;
    stopPolling: () => void;
    reset: () => void;
}

export const useTrialStore = create<TrialState>((set, get) => ({
    result: null,
    loadState: "idle",
    error: null,
    lastSynced: null,
    pollingInterval: null,

    // ── Derived helpers ─────────────────────────────────────────────────────────

    isTrialActive: () => {
        const r = get().result;
        return r?.allowed === true && r?.trial?.state === "active";
    },

    isTrialExpired: () => {
        const r = get().result;
        return r?.trial?.state === "expired" || r?.trial?.state === "blocked";
    },

    daysRemaining: () => get().result?.trial?.daysRemaining ?? 0,

    trialStatus: () => get().result?.trial ?? null,

    // ── Actions ─────────────────────────────────────────────────────────────────

    initTrial: async (associatedUserId?: string) => {
        set({ loadState: "loading", error: null });
        try {
            const result = await trialInit(associatedUserId);
            set({ result, loadState: "ready", lastSynced: new Date() });
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            set({ loadState: "error", error });
        }
    },

    refreshStatus: async () => {
        try {
            const result = await trialGetStatus();
            set({ result, lastSynced: new Date() });
        } catch {
            // Silently ignore background refresh errors
        }
    },

    startPolling: () => {
        const existing = get().pollingInterval;
        if (existing) return;

        const interval = setInterval(() => {
            get().refreshStatus();
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
        set({ result: null, loadState: "idle", error: null, lastSynced: null });
    },
}));
