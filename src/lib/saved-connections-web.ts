/**
 * Browser persistence for saved connections (replaces Tauri file storage on web).
 * Desktop continues to use Rust-backed storage via dynamic import in the store.
 */
import type { SavedConnection } from "@/lib/types";

const STORAGE_KEY = "helix-saved-connections-v1";

function readRaw(): SavedConnection[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as SavedConnection[]) : [];
    } catch {
        return [];
    }
}

function writeRaw(list: SavedConnection[]) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // quota / private mode
    }
}

export async function webGetSavedConnections(): Promise<SavedConnection[]> {
    return readRaw();
}

export async function webSaveConnection(conn: SavedConnection): Promise<SavedConnection[]> {
    const list = readRaw();
    const idx = list.findIndex((c) => c.id === conn.id);
    if (idx >= 0) {
        list[idx] = conn;
    } else {
        list.push(conn);
    }
    writeRaw(list);
    return list;
}

export async function webDeleteSavedConnection(id: string): Promise<SavedConnection[]> {
    const list = readRaw().filter((c) => c.id !== id);
    writeRaw(list);
    return list;
}

export async function webUpdateSavedConnectionDatabaseName(
    id: string,
    databaseName: string
): Promise<SavedConnection[]> {
    const list = readRaw();
    const idx = list.findIndex((c) => c.id === id);
    if (idx >= 0) {
        list[idx] = { ...list[idx], database_name: databaseName };
        writeRaw(list);
    }
    return list;
}
