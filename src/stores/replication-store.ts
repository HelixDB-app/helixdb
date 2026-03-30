import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
    ReplicationSnapshot,
    ReplicationSlotRow,
    PatroniCluster,
} from "@/lib/types";
import { replicationSnapshot, replicationPatroni } from "@/lib/tauri";

const MAX_SNAPSHOTS = 60;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_WAL_THRESHOLD_BYTES = 1_073_741_824;

interface ReplicationStoreState {
    snapshots: ReplicationSnapshot[];
    latest: ReplicationSnapshot | null;
    patroni: PatroniCluster | null;
    patroniError: string | null;
    snapshotWarning: string | null;
    isLoading: boolean;
    isPolling: boolean;
    pollingIntervalMs: number;
    walAlertThresholdBytes: number;
    patroniUrl: string;
    error: string | null;
    _intervalHandle: ReturnType<typeof setInterval> | null;
    _pollingConnectionId: string | null;

    fetchOnce: (connectionId: string) => Promise<void>;
    startPolling: (connectionId: string) => void;
    stopPolling: () => void;
    fetchPatroni: () => Promise<void>;
    setPollingInterval: (ms: number) => void;
    setWalAlertThreshold: (bytes: number) => void;
    setPatroniUrl: (url: string) => void;
    reset: () => void;
}

const volatileDefaults = {
    snapshots: [] as ReplicationSnapshot[],
    latest: null as ReplicationSnapshot | null,
    patroni: null as PatroniCluster | null,
    patroniError: null as string | null,
    snapshotWarning: null as string | null,
    isLoading: false,
    isPolling: false,
    error: null as string | null,
    _intervalHandle: null as ReturnType<typeof setInterval> | null,
    _pollingConnectionId: null as string | null,
};

export const useReplicationStore = create<ReplicationStoreState>()(
    persist(
        (set, get) => ({
            ...volatileDefaults,
            pollingIntervalMs: DEFAULT_POLL_MS,
            walAlertThresholdBytes: DEFAULT_WAL_THRESHOLD_BYTES,
            patroniUrl: "",

            fetchOnce: async (connectionId: string) => {
                if (!connectionId) return;
                set({ isLoading: true, error: null });
                try {
                    const snap = await replicationSnapshot(connectionId);
                    set((s) => {
                        const next = [...s.snapshots, snap];
                        while (next.length > MAX_SNAPSHOTS) next.shift();
                        return {
                            snapshots: next,
                            latest: snap,
                            snapshotWarning: snap.fetchWarning ?? null,
                            isLoading: false,
                            error: null,
                        };
                    });
                } catch (e) {
                    set({
                        isLoading: false,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            },

            startPolling: (connectionId: string) => {
                if (!connectionId) return;
                const s = get();
                if (s.isPolling && s._intervalHandle != null) return;

                set({
                    _pollingConnectionId: connectionId,
                    isPolling: true,
                });
                void get().fetchOnce(connectionId);

                const tick = () => {
                    const st = get();
                    const id = st._pollingConnectionId;
                    if (id) void st.fetchOnce(id);
                };
                const h = setInterval(tick, get().pollingIntervalMs);
                set({ _intervalHandle: h });
            },

            stopPolling: () => {
                const h = get()._intervalHandle;
                if (h != null) clearInterval(h);
                set({
                    _intervalHandle: null,
                    isPolling: false,
                    _pollingConnectionId: null,
                });
            },

            fetchPatroni: async () => {
                const url = get().patroniUrl.trim();
                if (!url) return;
                set({ patroniError: null });
                try {
                    const cluster = await replicationPatroni(url);
                    set({ patroni: cluster, patroniError: null });
                } catch (e) {
                    set({
                        patroniError: e instanceof Error ? e.message : String(e),
                    });
                }
            },

            setPollingInterval: (ms: number) => {
                const clamped = Math.max(1000, Math.min(ms, 120_000));
                const wasPolling = get().isPolling;
                const connId = get()._pollingConnectionId;
                if (wasPolling) get().stopPolling();
                set({ pollingIntervalMs: clamped });
                if (wasPolling && connId) get().startPolling(connId);
            },

            setWalAlertThreshold: (bytes: number) =>
                set({ walAlertThresholdBytes: Math.max(0, bytes) }),

            setPatroniUrl: (url: string) => set({ patroniUrl: url }),

            reset: () => {
                get().stopPolling();
                set({
                    ...volatileDefaults,
                    pollingIntervalMs: get().pollingIntervalMs,
                    walAlertThresholdBytes: get().walAlertThresholdBytes,
                    patroniUrl: get().patroniUrl,
                });
            },
        }),
        {
            name: "helix-replication-monitor",
            partialize: (s) => ({
                pollingIntervalMs: s.pollingIntervalMs,
                walAlertThresholdBytes: s.walAlertThresholdBytes,
                patroniUrl: s.patroniUrl,
            }),
        }
    )
);

/** Chart points for replay lag sparkline for one replica by application name. */
export function getLagChartData(
    snapshots: ReplicationSnapshot[],
    applicationName: string
): { time: string; lag_ms: number }[] {
    const out: { time: string; lag_ms: number }[] = [];
    for (const s of snapshots) {
        const r = s.replicas.find((x) => x.applicationName === applicationName);
        if (!r) continue;
        out.push({
            time: new Date(s.capturedAtMs).toLocaleTimeString(),
            lag_ms: r.replayLagMs ?? 0,
        });
    }
    return out;
}

export function getSlotAlerts(
    slots: ReplicationSlotRow[],
    thresholdBytes: number
): ReplicationSlotRow[] {
    return slots.filter(
        (sl) =>
            sl.walRetainedBytes != null && sl.walRetainedBytes > thresholdBytes
    );
}

export type FailoverReadiness = "ready" | "lagging" | "no_replicas";

export function getFailoverReadiness(
    snapshot: ReplicationSnapshot | null
): FailoverReadiness {
    if (!snapshot || snapshot.replicas.length === 0) return "no_replicas";
    const ok = snapshot.replicas.some(
        (r) =>
            r.state.toLowerCase() === "streaming" &&
            (r.replayLagMs ?? Number.POSITIVE_INFINITY) < 10_000
    );
    return ok ? "ready" : "lagging";
}

export function formatBytes(bytes: number): string {
    const n = Math.abs(bytes);
    if (n < 1024) return `${bytes} B`;
    if (n < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
    if (n < 1_073_741_824)
        return `${(bytes / 1_048_576).toFixed(n < 10_485_760 ? 1 : 0)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
