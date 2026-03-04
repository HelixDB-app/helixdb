import { create } from "zustand";

const RECENT_SEARCHES_KEY = "helixdb_recent_searches";
const SAVED_SEARCHES_KEY = "helixdb_saved_searches";
const MAX_RECENT = 30;
const MAX_SAVED = 80;

export interface RecentSearch {
    query: string;
    sql: string;
    timestamp: number;
}

export interface SavedSearch {
    id: string;
    label: string;
    query: string;
    sql: string;
    createdAt: number;
    updatedAt: number;
    runCount: number;
}

interface SearchState {
    isOpen: boolean;
    recentSearches: RecentSearch[];
    savedSearches: SavedSearch[];
    openPalette: () => void;
    closePalette: () => void;
    addRecentSearch: (query: string, sql: string) => void;
    clearRecentSearches: () => void;
    saveSearch: (label: string, query: string, sql: string) => void;
    unsaveSearch: (id: string) => void;
    touchSavedSearch: (id: string) => void;
    clearSavedSearches: () => void;
}

function loadRecentSearches(): RecentSearch[] {
    if (typeof window === "undefined") return [];
    try {
        const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function loadSavedSearches(): SavedSearch[] {
    if (typeof window === "undefined") return [];
    try {
        const stored = localStorage.getItem(SAVED_SEARCHES_KEY);
        if (!stored) return [];
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((entry) => ({
                id: typeof entry?.id === "string" ? entry.id : "",
                label: typeof entry?.label === "string" ? entry.label : "Saved search",
                query: typeof entry?.query === "string" ? entry.query : "",
                sql: typeof entry?.sql === "string" ? entry.sql : "",
                createdAt: typeof entry?.createdAt === "number" ? entry.createdAt : Date.now(),
                updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : Date.now(),
                runCount: typeof entry?.runCount === "number" ? entry.runCount : 0,
            }))
            .filter((entry) => entry.id && entry.query && entry.sql)
            .slice(0, MAX_SAVED);
    } catch {
        return [];
    }
}

function saveRecentSearches(searches: RecentSearch[]): void {
    try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    } catch {
        // ignore storage errors
    }
}

function saveSavedSearches(searches: SavedSearch[]): void {
    try {
        localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches));
    } catch {
        // ignore storage errors
    }
}

function signature(query: string, sql: string): string {
    return `${query.trim().toLowerCase()}::${sql.trim().toLowerCase()}`;
}

function createSavedSearchId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `saved_${Date.now()}_${Math.floor(Math.random() * 10_000_000)}`;
}

export const useSearchStore = create<SearchState>((set, get) => ({
    isOpen: false,
    recentSearches: loadRecentSearches(),
    savedSearches: loadSavedSearches(),

    openPalette: () => set({ isOpen: true }),
    closePalette: () => set({ isOpen: false }),

    addRecentSearch: (query, sql) => {
        const key = signature(query, sql);
        const deduplicated = get().recentSearches.filter(
            (r) => signature(r.query, r.sql) !== key
        );
        const updated = [{ query, sql, timestamp: Date.now() }, ...deduplicated].slice(0, MAX_RECENT);
        saveRecentSearches(updated);
        set({ recentSearches: updated });
    },

    clearRecentSearches: () => {
        saveRecentSearches([]);
        set({ recentSearches: [] });
    },

    saveSearch: (label, query, sql) => {
        const now = Date.now();
        const key = signature(query, sql);
        const existing = get().savedSearches;
        const existingEntry = existing.find((entry) => signature(entry.query, entry.sql) === key);
        const updated = existingEntry
            ? existing.map((entry) =>
                entry.id === existingEntry.id
                    ? {
                        ...entry,
                        label: label || entry.label,
                        query,
                        sql,
                        updatedAt: now,
                    }
                    : entry
            )
            : [
                {
                    id: createSavedSearchId(),
                    label: label || query,
                    query,
                    sql,
                    createdAt: now,
                    updatedAt: now,
                    runCount: 0,
                },
                ...existing,
            ];
        const limited = updated.slice(0, MAX_SAVED);
        saveSavedSearches(limited);
        set({ savedSearches: limited });
    },

    unsaveSearch: (id) => {
        const updated = get().savedSearches.filter((entry) => entry.id !== id);
        saveSavedSearches(updated);
        set({ savedSearches: updated });
    },

    touchSavedSearch: (id) => {
        const now = Date.now();
        const updated = get().savedSearches.map((entry) =>
            entry.id === id
                ? { ...entry, runCount: entry.runCount + 1, updatedAt: now }
                : entry
        );
        saveSavedSearches(updated);
        set({ savedSearches: updated });
    },

    clearSavedSearches: () => {
        saveSavedSearches([]);
        set({ savedSearches: [] });
    },
}));
