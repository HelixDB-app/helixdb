import { create } from "zustand";
import {
    dbSandboxBegin,
    dbSandboxCommit,
    dbSandboxElapsed,
    dbSandboxExecute,
    dbSandboxRollback,
    type SandboxExecuteResult,
} from "@/lib/tauri";

// ── History ────────────────────────────────────────────────────────────────

export interface SandboxHistoryEntry {
    id: string;
    sql: string;
    timestamp: number;
    outcome: "committed" | "rolled_back";
    rows_affected: number;
    query_type: string;
    result: SandboxExecuteResult;
}

const SANDBOX_HISTORY_KEY = "helix-sandbox-history";
const MAX_SANDBOX_HISTORY = 100;

function loadSandboxHistory(): SandboxHistoryEntry[] {
    try {
        const raw = localStorage.getItem(SANDBOX_HISTORY_KEY);
        return raw ? (JSON.parse(raw) as SandboxHistoryEntry[]) : [];
    } catch {
        return [];
    }
}

function saveSandboxHistory(h: SandboxHistoryEntry[]) {
    try {
        localStorage.setItem(
            SANDBOX_HISTORY_KEY,
            JSON.stringify(h.slice(0, MAX_SANDBOX_HISTORY))
        );
    } catch {}
}

// ── Query anomaly tracking ─────────────────────────────────────────────────

const ANOMALY_KEY = "helix-sandbox-anomaly";
const MAX_ANOMALY_ENTRIES = 30;

interface AnomalyEntry {
    sql_prefix: string; // first ~40 chars of normalised SQL
    rows_affected: number;
}

function loadAnomalyData(): AnomalyEntry[] {
    try {
        const raw = localStorage.getItem(ANOMALY_KEY);
        return raw ? (JSON.parse(raw) as AnomalyEntry[]) : [];
    } catch {
        return [];
    }
}

function saveAnomalyData(data: AnomalyEntry[]) {
    try {
        localStorage.setItem(
            ANOMALY_KEY,
            JSON.stringify(data.slice(0, MAX_ANOMALY_ENTRIES))
        );
    } catch {}
}

function sqlPrefix(sql: string): string {
    return sql
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40)
        .toUpperCase();
}

/** Returns an anomaly warning string if rows_affected is suspiciously large. */
export function checkAnomalyWarning(sql: string, rowsAffected: number): string | null {
    if (rowsAffected <= 0) return null;
    const prefix = sqlPrefix(sql);
    const data = loadAnomalyData();
    const matching = data.filter((e) => e.sql_prefix === prefix);
    if (matching.length < 3) return null; // not enough history
    const avg = matching.reduce((s, e) => s + e.rows_affected, 0) / matching.length;
    if (avg > 0 && rowsAffected > avg * 10) {
        return `This query affected ${rowsAffected.toLocaleString()} rows — ~${Math.round(rowsAffected / avg)}× more than your last ${matching.length} similar queries (avg ${Math.round(avg).toLocaleString()} rows). Double-check before committing.`;
    }
    return null;
}

function recordAnomalyEntry(sql: string, rowsAffected: number) {
    const data = loadAnomalyData();
    data.unshift({ sql_prefix: sqlPrefix(sql), rows_affected: rowsAffected });
    saveAnomalyData(data);
}

// ── Store ──────────────────────────────────────────────────────────────────

export type SandboxStatus =
    | "off"           // sandbox mode disabled
    | "ready"         // sandbox mode on, no active transaction
    | "executing"     // DML is being sent to the server
    | "reviewing"     // DML done, showing diff, awaiting commit/rollback
    | "committing"
    | "rolling_back";

interface SandboxState {
    status: SandboxStatus;
    sandboxId: string | null;
    pendingSql: string | null;
    result: SandboxExecuteResult | null;
    error: string | null;
    anomalyWarning: string | null;
    elapsedSecs: number;
    history: SandboxHistoryEntry[];

    // Actions
    enableSandbox: () => void;
    disableSandbox: () => void;
    runInSandbox: (connectionId: string, sql: string) => Promise<void>;
    commitSandbox: () => Promise<void>;
    rollbackSandbox: () => Promise<void>;
    clearError: () => void;
    loadHistory: () => void;
    clearHistory: () => void;
    tickElapsed: () => void;
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
    status: "off",
    sandboxId: null,
    pendingSql: null,
    result: null,
    error: null,
    anomalyWarning: null,
    elapsedSecs: 0,
    history: [],

    enableSandbox: () => set({ status: "ready", error: null }),
    disableSandbox: () => {
        const { sandboxId, status } = get();
        // If there's an open transaction, roll it back silently
        if (sandboxId && (status === "reviewing" || status === "executing")) {
            dbSandboxRollback(sandboxId).catch(() => {});
        }
        set({
            status: "off",
            sandboxId: null,
            pendingSql: null,
            result: null,
            error: null,
            anomalyWarning: null,
            elapsedSecs: 0,
        });
    },

    runInSandbox: async (connectionId, sql) => {
        set({ status: "executing", error: null, result: null, anomalyWarning: null });
        let sandboxId: string | null = null;
        try {
            sandboxId = await dbSandboxBegin(connectionId);
            set({ sandboxId, pendingSql: sql, elapsedSecs: 0 });

            const result = await dbSandboxExecute(sandboxId, sql);

            // Anomaly detection
            const anomalyWarning = checkAnomalyWarning(sql, result.rows_affected);

            set({ status: "reviewing", result, anomalyWarning });
        } catch (err) {
            // Always rollback the open transaction to avoid leaking it
            if (sandboxId) {
                dbSandboxRollback(sandboxId).catch(() => {});
            }
            // Format a clean error: tokio_postgres prefixes errors with "db error: "
            const raw = String(err);
            const clean = raw.startsWith("db error: ") ? raw.slice(10) : raw;
            set({ status: "ready", error: clean, sandboxId: null });
        }
    },

    commitSandbox: async () => {
        const { sandboxId, pendingSql, result } = get();
        if (!sandboxId) return;
        set({ status: "committing" });
        try {
            await dbSandboxCommit(sandboxId);
            // Record into anomaly tracking and history
            if (pendingSql && result) {
                recordAnomalyEntry(pendingSql, result.rows_affected);
                const entry: SandboxHistoryEntry = {
                    id: `sbx-${Date.now()}`,
                    sql: pendingSql,
                    timestamp: Date.now(),
                    outcome: "committed",
                    rows_affected: result.rows_affected,
                    query_type: result.query_type,
                    result,
                };
                const newHistory = [entry, ...get().history].slice(0, MAX_SANDBOX_HISTORY);
                saveSandboxHistory(newHistory);
                set({ history: newHistory });
            }
            set({
                status: "ready",
                sandboxId: null,
                pendingSql: null,
                result: null,
                anomalyWarning: null,
                elapsedSecs: 0,
            });
        } catch (err) {
            set({ status: "reviewing", error: String(err) });
        }
    },

    rollbackSandbox: async () => {
        const { sandboxId, pendingSql, result } = get();
        if (!sandboxId) return;
        set({ status: "rolling_back" });
        try {
            await dbSandboxRollback(sandboxId);
            if (pendingSql && result) {
                const entry: SandboxHistoryEntry = {
                    id: `sbx-${Date.now()}`,
                    sql: pendingSql,
                    timestamp: Date.now(),
                    outcome: "rolled_back",
                    rows_affected: result.rows_affected,
                    query_type: result.query_type,
                    result,
                };
                const newHistory = [entry, ...get().history].slice(0, MAX_SANDBOX_HISTORY);
                saveSandboxHistory(newHistory);
                set({ history: newHistory });
            }
            set({
                status: "ready",
                sandboxId: null,
                pendingSql: null,
                result: null,
                anomalyWarning: null,
                elapsedSecs: 0,
            });
        } catch (err) {
            set({ status: "reviewing", error: String(err) });
        }
    },

    clearError: () => set({ error: null }),

    loadHistory: () => set({ history: loadSandboxHistory() }),

    clearHistory: () => {
        saveSandboxHistory([]);
        set({ history: [] });
    },

    tickElapsed: () => {
        const { sandboxId, status } = get();
        if (!sandboxId || status === "off") return;
        dbSandboxElapsed(sandboxId)
            .then((secs) => set({ elapsedSecs: secs }))
            .catch(() => {});
    },
}));
