/**
 * OS integrations only available inside Tauri. Safe no-ops / dynamic imports on web.
 */
import { isTauri } from "@/lib/tauri-runtime";

export async function openNewAppWindow(): Promise<void> {
    if (!isTauri()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_new_window");
}

export async function listenCollabJoin(
    handler: (url: string) => void
): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>("pgstudio-collab-join", (event) => {
        handler(event.payload);
    });
}
