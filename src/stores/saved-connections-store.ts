import { create } from "zustand";
import type { SavedConnection } from "@/lib/types";
import {
    getSavedConnections,
    saveConnection as saveConnectionApi,
    deleteSavedConnection as deleteSavedConnectionApi,
    updateSavedConnectionDatabaseName as updateDatabaseNameApi,
} from "@/lib/tauri";

interface SavedConnectionsState {
    connections: SavedConnection[];
    isLoading: boolean;
    error: string | null;

    load: () => Promise<void>;
    add: (conn: Omit<SavedConnection, "id">) => Promise<SavedConnection>;
    update: (conn: SavedConnection) => Promise<SavedConnection[]>;
    remove: (id: string) => Promise<SavedConnection[]>;
    updateDatabaseName: (id: string, databaseName: string) => Promise<SavedConnection[]>;
    clearError: () => void;
}

function generateId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export const useSavedConnectionsStore = create<SavedConnectionsState>((set, get) => ({
    connections: [],
    isLoading: false,
    error: null,

    load: async () => {
        set({ isLoading: true, error: null });
        try {
            const list = await getSavedConnections();
            set({ connections: list, isLoading: false });
        } catch (err) {
            set({
                connections: [],
                isLoading: false,
                error: String(err),
            });
        }
    },

    add: async (conn) => {
        const full: SavedConnection = {
            ...conn,
            id: generateId(),
            database_name: conn.database_name ?? null,
        };
        set({ error: null });
        try {
            const list = await saveConnectionApi(full);
            set({ connections: list });
            return list.find((c) => c.id === full.id) ?? full;
        } catch (err) {
            set({ error: String(err) });
            throw err;
        }
    },

    update: async (conn) => {
        set({ error: null });
        try {
            const list = await saveConnectionApi(conn);
            set({ connections: list });
            return list;
        } catch (err) {
            set({ error: String(err) });
            throw err;
        }
    },

    remove: async (id) => {
        set({ error: null });
        try {
            const list = await deleteSavedConnectionApi(id);
            set({ connections: list });
            return list;
        } catch (err) {
            set({ error: String(err) });
            throw err;
        }
    },

    updateDatabaseName: async (id, databaseName) => {
        try {
            const list = await updateDatabaseNameApi(id, databaseName);
            set({ connections: list });
            return list;
        } catch {
            return get().connections;
        }
    },

    clearError: () => set({ error: null }),
}));
