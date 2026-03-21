import { create } from "zustand";
import type { ConnectionEnvironment, QueryResult } from "@/lib/types";
import { dbExecuteQuery, dbGetTableData } from "@/lib/db-platform";
import { track } from "@/lib/analytics";

export interface QueryTab {
    id: string;
    title: string;
    sql: string;
    result: QueryResult | null;
    isExecuting: boolean;
    executionTime: number | null;
}

export interface QueryHistoryEntry {
    id: string;
    sql: string;
    executedAt: number; // timestamp ms
    executionTimeMs: number;
    rowCount: number;
    isError: boolean;
    databaseName?: string;
    aiReview?: {
        mode: "manual" | "auto";
        overridden: boolean;
        aiModel: string | null;
        issueCounts: {
            block: number;
            warn: number;
            info: number;
        };
    };
    environment?: ConnectionEnvironment;
    productionGuardReason?: string | null;
}

const HISTORY_KEY = "helix-query-history";
const MAX_HISTORY = 100;

function loadHistory(): QueryHistoryEntry[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as QueryHistoryEntry[];
    } catch {
        return [];
    }
}

function saveHistory(history: QueryHistoryEntry[]) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
    } catch {
        // ignore storage errors
    }
}

interface QueryState {
    tabs: QueryTab[];
    activeTabId: string | null;
    history: QueryHistoryEntry[];

    addTab: (title?: string, sql?: string) => string;
    removeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    updateSql: (tabId: string, sql: string) => void;
    setTabResult: (tabId: string, result: QueryResult | null, executionTimeMs?: number | null) => void;
    executeQuery: (
        connectionId: string,
        tabId: string,
        databaseName?: string,
        options?: QueryExecuteOptions
    ) => Promise<void>;
    updateTabTitle: (tabId: string, title: string) => void;
    clearHistory: () => void;
    deleteHistoryEntry: (id: string) => void;
    loadHistoryFromStorage: () => void;
}

export interface QueryExecuteOptions {
    aiReview?: QueryHistoryEntry["aiReview"];
    environment?: ConnectionEnvironment;
    productionGuardReason?: string;
}

let tabCounter = 0;

function parseSimpleSelectStar(sql: string): { schema: string; table: string } | null {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    // Only handle the simplest “browse table” shape:
    // SELECT * FROM schema.table
    // SELECT * FROM "schema"."table"
    const m = trimmed.match(
        /^\s*select\s+\*\s+from\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1\.\s*("?)([a-zA-Z_][a-zA-Z0-9_]*)\3\s*$/i
    );
    if (!m) return null;
    const schema = m[2]!;
    const table = m[4]!;
    return { schema, table };
}

export const useQueryStore = create<QueryState>((set, get) => ({
    tabs: [],
    activeTabId: null,
    history: [],

    loadHistoryFromStorage: () => {
        set({ history: loadHistory() });
    },

    addTab: (title?: string, sql?: string) => {
        tabCounter++;
        const id = `query-${tabCounter}-${Date.now()}`;
        const newTab: QueryTab = {
            id,
            title: title || `Query ${tabCounter}`,
            sql: sql ?? "",
            result: null,
            isExecuting: false,
            executionTime: null,
        };
        set((state) => ({
            tabs: [...state.tabs, newTab],
            activeTabId: id,
        }));
        return id;
    },

    removeTab: (tabId) => {
        set((state) => {
            const tabs = state.tabs.filter((t) => t.id !== tabId);
            let activeTabId = state.activeTabId;
            if (activeTabId === tabId) {
                activeTabId = tabs[tabs.length - 1]?.id ?? null;
            }
            return { tabs, activeTabId };
        });
    },

    setActiveTab: (tabId) => set({ activeTabId: tabId }),

    updateSql: (tabId, sql) => {
        set((state) => ({
            tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, sql } : t)),
        }));
    },

    setTabResult: (tabId, result, executionTimeMs) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId
                    ? {
                        ...t,
                        result,
                        isExecuting: false,
                        executionTime:
                            executionTimeMs ?? result?.execution_time_ms ?? null,
                    }
                    : t
            ),
        }));
    },

    executeQuery: async (connectionId, tabId, databaseName?, options?) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || !tab.sql.trim()) return;

        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId ? { ...t, isExecuting: true, result: null } : t
            ),
        }));

        try {
            void track("query_execute", {
                has_db_name: !!databaseName,
                has_env: !!options?.environment,
            });
            const simple = parseSimpleSelectStar(tab.sql);
            const result = simple
                ? await dbGetTableData(connectionId, simple.schema, simple.table, 1, 2000)
                : await dbExecuteQuery(connectionId, tab.sql, {
                    environment: options?.environment,
                    guardReason: options?.productionGuardReason,
                });

            // Record history entry
            const entry: QueryHistoryEntry = {
                id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                sql: tab.sql.trim(),
                executedAt: Date.now(),
                executionTimeMs: result.execution_time_ms,
                rowCount: result.row_count,
                isError: result.is_error,
                databaseName,
                aiReview: options?.aiReview,
                environment: options?.environment,
                productionGuardReason: options?.productionGuardReason ?? null,
            };
            const newHistory = [entry, ...get().history].slice(0, MAX_HISTORY);
            saveHistory(newHistory);

            set((state) => ({
                history: newHistory,
                tabs: state.tabs.map((t) =>
                    t.id === tabId
                        ? { ...t, isExecuting: false, result, executionTime: result.execution_time_ms }
                        : t
                ),
            }));
        } catch (error) {
            void track("query_execute_error", {
                has_db_name: !!databaseName,
                has_env: !!options?.environment,
            });
            const message =
                error instanceof Error
                    ? error.message + (error.cause ? `\nCause: ${String(error.cause)}` : "")
                    : String(error);

            const entry: QueryHistoryEntry = {
                id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                sql: tab.sql.trim(),
                executedAt: Date.now(),
                executionTimeMs: 0,
                rowCount: 0,
                isError: true,
                databaseName,
                aiReview: options?.aiReview,
                environment: options?.environment,
                productionGuardReason: options?.productionGuardReason ?? null,
            };
            const newHistory = [entry, ...get().history].slice(0, MAX_HISTORY);
            saveHistory(newHistory);

            set((state) => ({
                history: newHistory,
                tabs: state.tabs.map((t) =>
                    t.id === tabId
                        ? {
                            ...t,
                            isExecuting: false,
                            result: {
                                columns: [],
                                rows: [],
                                row_count: 0,
                                total_rows: null,
                                execution_time_ms: 0,
                                page: null,
                                page_size: null,
                                query: tab.sql,
                                is_error: true,
                                error_message: message,
                            },
                        }
                        : t
                ),
            }));
        }
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        }));
    },

    clearHistory: () => {
        saveHistory([]);
        set({ history: [] });
    },

    deleteHistoryEntry: (id) => {
        set((state) => {
            const newHistory = state.history.filter((e) => e.id !== id);
            saveHistory(newHistory);
            return { history: newHistory };
        });
    },
}));
