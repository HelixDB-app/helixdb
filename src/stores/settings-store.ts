import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTheme = "dark" | "light" | "system";
export type UIDensity = "compact" | "comfortable";
export type EditorTabSize = 2 | 4;
export type DefaultPageSize = 50 | 100 | 200 | 500;
export type NullDisplay = "NULL" | "–" | "";
export type EditorFontFamily = "jetbrains" | "fira" | "mono";

export interface AppSettings {
    // Appearance
    theme: AppTheme;
    uiDensity: UIDensity;
    reducedMotion: boolean;

    // Editor
    editorFontSize: number;
    editorTabSize: EditorTabSize;
    editorWordWrap: boolean;
    editorMinimap: boolean;
    editorLineNumbers: boolean;
    editorFontLigatures: boolean;

    // Data
    defaultPageSize: DefaultPageSize;
    nullDisplay: NullDisplay;
    showRowNumbers: boolean;
    wrapCellContent: boolean;

    // Query
    autoFormatOnExecute: boolean;
    confirmDangerousQueries: boolean;
    queryTimeoutSeconds: number;
}

const DEFAULT_SETTINGS: AppSettings = {
    theme: "dark",
    uiDensity: "comfortable",
    reducedMotion: false,
    editorFontSize: 13,
    editorTabSize: 4,
    editorWordWrap: true,
    editorMinimap: false,
    editorLineNumbers: true,
    editorFontLigatures: true,
    defaultPageSize: 100,
    nullDisplay: "NULL",
    showRowNumbers: true,
    wrapCellContent: false,
    autoFormatOnExecute: false,
    confirmDangerousQueries: true,
    queryTimeoutSeconds: 30,
};

interface SettingsStore extends AppSettings {
    updateSettings: (patch: Partial<AppSettings>) => void;
    resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
    persist(
        (set) => ({
            ...DEFAULT_SETTINGS,
            updateSettings: (patch) => set((s) => ({ ...s, ...patch })),
            resetSettings: () => set(() => ({ ...DEFAULT_SETTINGS })),
        }),
        {
            name: "helix-settings",
            version: 1,
        }
    )
);
