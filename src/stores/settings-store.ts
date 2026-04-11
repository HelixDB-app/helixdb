import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Optional build-time key from `.env.local` (`NEXT_PUBLIC_GEMINI_API_KEY`). Prefer server secrets only if you add a proxy API route — client AI calls need a user key in Settings or this public env for local/dev builds. */
export function readGeminiApiKeyFromEnv(): string {
    if (typeof process === "undefined" || !process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
        return "";
    }
    return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
}

export function readOpenRouterApiKeyFromEnv(): string {
    if (typeof process === "undefined" || !process.env.NEXT_PUBLIC_OPENROUTER_API_KEY) {
        return "";
    }
    return process.env.NEXT_PUBLIC_OPENROUTER_API_KEY.trim();
}

/** User setting overrides env when non-empty. */
export function resolveGeminiApiKey(userOverride: string | undefined | null): string {
    const fromUser = (userOverride ?? "").trim();
    if (fromUser) return fromUser;
    return readGeminiApiKeyFromEnv();
}

export type AppTheme = "dark" | "light" | "system";
export type UIDensity = "compact" | "comfortable";
export type EditorTabSize = 2 | 4;
export type DefaultPageSize = 50 | 100 | 200 | 500;
export type NullDisplay = "NULL" | "–" | "";
export type EditorFontFamily = "jetbrains" | "fira" | "mono";

export type GeminiModelId = "gemini-2.5-pro" | "gemini-2.5-flash" | "gemma3-4b" | "gemma3-12b" | "gemma3-27b" | "gemini-2.5-flash-lite" | "gemini-2.5-pro-lite";
export type GitAiProvider = "cloudflare" | "gemini";

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
    strictProductionGuard: boolean;
    queryTimeoutSeconds: number;
    aiReviewEnabled: boolean;
    aiReviewAutoOnDml: boolean;
    aiReviewUseGemini: boolean;
    aiReviewModel: GeminiModelId;
    aiReviewComplexLineThreshold: number;

    // Notifications
    notificationsEnabled: boolean;

    // Release notes
    lastSeenVersion: string;

    // AI
    geminiApiKey: string;
    defaultAiModel: GeminiModelId;
    aiAutocompleteEnabled: boolean;
    aiInlineSuggestions: boolean;
    aiDropdownSuggestions: boolean;
    aiNextActionSuggestions: boolean;
    aiSuggestionMinChars: number;
    aiSuggestionThrottleMs: number;
    aiSuggestionContextWindowChars: number;
    aiShowSuggestionLatency: boolean;
    aiCompletionUrl: string;
    aiWorkerUrl: string;
    openRouterApiKey: string;
    aiSchemaDefaultModel: string;

    /** When true, opening Query History on pg_stat tab ingests a snapshot (local SQLite). */
    queryHistoryAutoSnapshotPgStat: boolean;

    // Git AI
    gitAiProvider: GitAiProvider;
    cloudflareApiToken: string;
    cloudflareAccountId: string;
    cloudflareModel: string;
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
    strictProductionGuard: true,
    queryTimeoutSeconds: 30,
    aiReviewEnabled: true,
    aiReviewAutoOnDml: true,
    aiReviewUseGemini: true,
    aiReviewModel: "gemini-2.5-flash-lite",
    aiReviewComplexLineThreshold: 10,
    notificationsEnabled: true,
    lastSeenVersion: "",
    geminiApiKey: "AIzaSyCxmZL-XutmW9S1yTNYjW98YH9ht4waIto",
    defaultAiModel: "gemini-2.5-flash",
    aiAutocompleteEnabled: true,
    aiInlineSuggestions: true,
    aiDropdownSuggestions: true,
    aiNextActionSuggestions: true,
    aiSuggestionMinChars: 8,
    aiSuggestionThrottleMs: 220,
    aiSuggestionContextWindowChars: 1200,
    aiShowSuggestionLatency: true,
    aiCompletionUrl: "",
    aiWorkerUrl: "",
    openRouterApiKey: "",
    aiSchemaDefaultModel: "arcee-ai/trinity-mini:free",
    queryHistoryAutoSnapshotPgStat: false,
    gitAiProvider: "cloudflare",
    cloudflareApiToken: "",
    cloudflareAccountId: "",
    cloudflareModel: "@cf/meta/llama-3.1-8b-instruct",
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
            version: 5,
            migrate: (persisted, version) => {
                const p = persisted as Partial<AppSettings>;
                if (version < 4) {
                    return {
                        ...DEFAULT_SETTINGS,
                        ...p,
                        queryHistoryAutoSnapshotPgStat: p.queryHistoryAutoSnapshotPgStat ?? false,
                    } as AppSettings;
                }
                if (version < 5) {
                    return {
                        ...DEFAULT_SETTINGS,
                        ...p,
                        openRouterApiKey: p.openRouterApiKey ?? "",
                        aiSchemaDefaultModel: p.aiSchemaDefaultModel ?? "arcee-ai/trinity-mini:free",
                    } as AppSettings;
                }
                return persisted as AppSettings;
            },
        }
    )
);

export function getResolvedGeminiApiKey(): string {
    return resolveGeminiApiKey(useSettingsStore.getState().geminiApiKey);
}

/** Effective key for AI calls (Settings override, else `NEXT_PUBLIC_GEMINI_API_KEY`). */
export function useResolvedGeminiApiKey(): string {
    const override = useSettingsStore((s) => s.geminiApiKey);
    return resolveGeminiApiKey(override);
}
