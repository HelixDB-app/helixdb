import { create } from "zustand";
import type { QueryResult } from "@/lib/types";
import { dbExecuteQuery } from "@/lib/tauri";

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

    addTab: (title?: string, sql?: string) => void;
    removeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    updateSql: (tabId: string, sql: string) => void;
    executeQuery: (connectionId: string, tabId: string, databaseName?: string) => Promise<void>;
    updateTabTitle: (tabId: string, title: string) => void;
    clearHistory: () => void;
    deleteHistoryEntry: (id: string) => void;
    loadHistoryFromStorage: () => void;
}

let tabCounter = 0;

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

    executeQuery: async (connectionId, tabId, databaseName?) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || !tab.sql.trim()) return;

        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId ? { ...t, isExecuting: true, result: null } : t
            ),
        }));

        try {
            const result = await dbExecuteQuery(connectionId, tab.sql);

            // Record history entry
            const entry: QueryHistoryEntry = {
                id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                sql: tab.sql.trim(),
                executedAt: Date.now(),
                executionTimeMs: result.execution_time_ms,
                rowCount: result.row_count,
                isError: result.is_error,
                databaseName,
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
