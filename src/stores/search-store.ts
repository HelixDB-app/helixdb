import { create } from "zustand";

const RECENT_SEARCHES_KEY = "helixdb_recent_searches";
const MAX_RECENT = 20;

export interface RecentSearch {
    query: string;
    sql: string;
    timestamp: number;
}

interface SearchState {
    isOpen: boolean;
    recentSearches: RecentSearch[];
    openPalette: () => void;
    closePalette: () => void;
    addRecentSearch: (query: string, sql: string) => void;
    clearRecentSearches: () => void;
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

function saveRecentSearches(searches: RecentSearch[]): void {
    try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    } catch {
        // ignore storage errors
    }
}

export const useSearchStore = create<SearchState>((set, get) => ({
    isOpen: false,
    recentSearches: loadRecentSearches(),

    openPalette: () => set({ isOpen: true }),
    closePalette: () => set({ isOpen: false }),

    addRecentSearch: (query, sql) => {
        const deduplicated = get().recentSearches.filter((r) => r.query !== query);
        const updated = [{ query, sql, timestamp: Date.now() }, ...deduplicated].slice(0, MAX_RECENT);
        saveRecentSearches(updated);
        set({ recentSearches: updated });
    },

    clearRecentSearches: () => {
        saveRecentSearches([]);
        set({ recentSearches: [] });
    },
}));
