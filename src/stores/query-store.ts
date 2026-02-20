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

interface QueryState {
    tabs: QueryTab[];
    activeTabId: string | null;

    // Actions
    addTab: (title?: string) => void;
    removeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    updateSql: (tabId: string, sql: string) => void;
    executeQuery: (connectionId: string, tabId: string) => Promise<void>;
    updateTabTitle: (tabId: string, title: string) => void;
}

let tabCounter = 0;

export const useQueryStore = create<QueryState>((set, get) => ({
    tabs: [],
    activeTabId: null,

    addTab: (title?: string) => {
        tabCounter++;
        const id = `query-${tabCounter}-${Date.now()}`;
        const newTab: QueryTab = {
            id,
            title: title || `Query ${tabCounter}`,
            sql: "",
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

    executeQuery: async (connectionId, tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || !tab.sql.trim()) return;

        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId ? { ...t, isExecuting: true, result: null } : t
            ),
        }));

        try {
            const result = await dbExecuteQuery(connectionId, tab.sql);
            set((state) => ({
                tabs: state.tabs.map((t) =>
                    t.id === tabId
                        ? {
                            ...t,
                            isExecuting: false,
                            result,
                            executionTime: result.execution_time_ms,
                        }
                        : t
                ),
            }));
        } catch (error) {
            set((state) => ({
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
                                error_message: String(error),
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
}));
