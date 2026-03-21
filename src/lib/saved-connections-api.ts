/**
 * Saved-connection persistence: Tauri (desktop) vs localStorage (web).
 * Avoids importing `@/lib/tauri` in the browser bundle when not running in Tauri.
 */
import { isTauri } from "@/lib/tauri-runtime";
import type { SavedConnection } from "@/lib/types";
import * as web from "@/lib/saved-connections-web";

export async function getSavedConnections(): Promise<SavedConnection[]> {
    if (isTauri()) {
        const t = await import("@/lib/tauri");
        return t.getSavedConnections();
    }
    return web.webGetSavedConnections();
}

export async function saveConnection(conn: SavedConnection): Promise<SavedConnection[]> {
    if (isTauri()) {
        const t = await import("@/lib/tauri");
        return t.saveConnection(conn);
    }
    return web.webSaveConnection(conn);
}

export async function deleteSavedConnection(id: string): Promise<SavedConnection[]> {
    if (isTauri()) {
        const t = await import("@/lib/tauri");
        return t.deleteSavedConnection(id);
    }
    return web.webDeleteSavedConnection(id);
}

export async function updateSavedConnectionDatabaseName(
    id: string,
    databaseName: string
): Promise<SavedConnection[]> {
    if (isTauri()) {
        const t = await import("@/lib/tauri");
        return t.updateSavedConnectionDatabaseName(id, databaseName);
    }
    return web.webUpdateSavedConnectionDatabaseName(id, databaseName);
}
