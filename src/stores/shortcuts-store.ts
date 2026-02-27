import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeCombo } from "@/lib/shortcut-keys";

export type ShortcutActionId =
    | "search"
    | "settings"
    | "refresh"
    | "view_data"
    | "view_query"
    | "view_sessions"
    | "view_indexes"
    | "view_topology"
    | "view_ai"
    | "disconnect"
    | "query_history"
    | "extensions"
    | "bug_report"
    | "connect";

export interface ShortcutDefinition {
    id: ShortcutActionId;
    label: string;
    description: string;
    defaultCombo: string;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
    { id: "search", label: "Search", description: "Open command palette / search", defaultCombo: "Mod+K" },
    { id: "settings", label: "Settings", description: "Open settings", defaultCombo: "Mod+," },
    { id: "refresh", label: "Refresh", description: "Refresh schemas and current table", defaultCombo: "Mod+Shift+R" },
    { id: "view_data", label: "Data view", description: "Switch to Data tab", defaultCombo: "Mod+1" },
    { id: "view_query", label: "Query view", description: "Switch to Query tab", defaultCombo: "Mod+2" },
    { id: "view_sessions", label: "Sessions view", description: "Switch to Sessions tab", defaultCombo: "Mod+3" },
    { id: "view_indexes", label: "Indexes view", description: "Switch to Indexes tab", defaultCombo: "Mod+4" },
    { id: "view_topology", label: "Topology view", description: "Switch to Topology tab", defaultCombo: "Mod+5" },
    { id: "view_ai", label: "AI chat", description: "Switch to AI chat tab", defaultCombo: "Mod+J" },
    { id: "disconnect", label: "Disconnect", description: "Disconnect from database", defaultCombo: "Mod+Shift+D" },
    { id: "query_history", label: "Query History", description: "Open Query History & Performance", defaultCombo: "Mod+Shift+H" },
    { id: "extensions", label: "Extensions", description: "Open Extensions & User Management", defaultCombo: "Mod+Shift+E" },
    { id: "bug_report", label: "Bug Report", description: "Submit feedback and bug reports", defaultCombo: "Mod+Shift+B" },
    { id: "connect", label: "Connect", description: "Connect to database (when disconnected)", defaultCombo: "Mod+K" },
];

const DEFAULT_COMBOS: Record<ShortcutActionId, string> = Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((d) => [d.id, normalizeCombo(d.defaultCombo)])
) as Record<ShortcutActionId, string>;

interface ShortcutsState {
    /** User overrides: actionId -> combo */
    overrides: Partial<Record<ShortcutActionId, string>>;
    getCombo: (id: ShortcutActionId) => string;
    setShortcut: (id: ShortcutActionId, combo: string) => void;
    resetShortcut: (id: ShortcutActionId) => void;
    resetAllShortcuts: () => void;
    /** Resolve action id from a combo (for conflict check). Returns first match. */
    getActionByCombo: (combo: string) => ShortcutActionId | null;
}

export const useShortcutsStore = create<ShortcutsState>()(
    persist(
        (set, get) => ({
            overrides: {},
            getCombo: (id) => {
                const overrides = get().overrides;
                const combo = overrides[id] ?? DEFAULT_COMBOS[id];
                return combo ? normalizeCombo(combo) : "";
            },
            setShortcut: (id, combo) => {
                const trimmed = combo.trim();
                if (!trimmed) return;
                set((s) => ({
                    overrides: { ...s.overrides, [id]: normalizeCombo(trimmed) },
                }));
            },
            resetShortcut: (id) => {
                set((s) => {
                    const next = { ...s.overrides };
                    delete next[id];
                    return { overrides: next };
                });
            },
            resetAllShortcuts: () => set({ overrides: {} }),
            getActionByCombo: (combo) => {
                const normalized = normalizeCombo(combo);
                const state = get();
                for (const def of SHORTCUT_DEFINITIONS) {
                    if (state.getCombo(def.id) === normalized) return def.id;
                }
                return null;
            },
        }),
        { name: "helix-shortcuts", version: 1 }
    )
);
