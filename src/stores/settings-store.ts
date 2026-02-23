import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTheme = "dark" | "light" | "system";
export type UIDensity = "compact" | "comfortable";
export type EditorTabSize = 2 | 4;
export type DefaultPageSize = 50 | 100 | 200 | 500;
export type NullDisplay = "NULL" | "–" | "";
export type EditorFontFamily = "jetbrains" | "fira" | "mono";

export type GeminiModelId = "gemini-2.5-pro" | "gemini-2.5-flash" | "gemma3-4b" | "gemma3-12b" | "gemma3-27b" | "gemini-2.5-flash-lite" | "gemini-2.5-pro-lite";

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

    // Notifications
    notificationsEnabled: boolean;

    // AI
    geminiApiKey: string;
    defaultAiModel: GeminiModelId;
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
    notificationsEnabled: true,
    geminiApiKey: "AIzaSyCtgJ0ORZ-Bd7tnFoqYK4IHUIHpMExqgKM",
    defaultAiModel: "gemini-2.5-flash",
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
            version: 3,
        }
    )
);
