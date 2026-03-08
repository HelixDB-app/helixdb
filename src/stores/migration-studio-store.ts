import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MigrationDiff, SchemaSnapshot } from "@/lib/migration-diff";

// ─── Config Types ─────────────────────────────────────────────────────────────

export type MigrationMode = "schema_only" | "schema_and_data";

export interface MigrationIncludeOptions {
    functions: boolean;
    triggers: boolean;
    indexes: boolean;
    sequences: boolean;
    views: boolean;
}

export const DEFAULT_INCLUDE_OPTIONS: MigrationIncludeOptions = {
    functions: true,
    triggers: true,
    indexes: true,
    sequences: true,
    views: true,
};

/**
 * Large DB mode — skips expensive per-table metadata for huge databases.
 * Row count threshold: tables with estimated > N rows skip full index detail fetch.
 */
export interface LargeDbOptions {
    /** Enable large-DB optimizations */
    enabled: boolean;
    /** Skip detailed index metadata for tables exceeding this estimated row count (0 = no skip) */
    skipIndexesAboveRows: number;
    /** Concurrency limit for table detail fetches (lower = less server load) */
    concurrency: number;
}

// ─── History Entry ───────────────────────────────────────────────────────────

export interface MigrationHistoryEntry {
    id: string;
    timestamp: number;
    sourceDb: string;
    targetDb: string;
    sourceConnectionId: string;
    targetConnectionId: string;
    forwardSQL: string;
    rollbackSQL: string;
    status: "success" | "failed" | "reverted" | "dry-run";
    errorMessage?: string;
    appliedAt?: number;
    schemasIncluded: string[];
    tablesIncluded: string[];
    migrationMode: MigrationMode;
    totalChanges: number;
    criticalCount: number;
}

// ─── Dry Run Result ──────────────────────────────────────────────────────────

export interface DryRunResult {
    success: boolean;
    statementCount: number;
    elapsedMs: number;
    errorMessage?: string;
}

// ─── Store State & Actions ───────────────────────────────────────────────────

interface MigrationStudioState {
    // Setup
    sourceConnectionId: string | null;
    targetConnectionId: string | null;
    selectedSchemas: string[];
    /** "schema.table" keys — empty means all tables */
    selectedTables: string[];
    migrationMode: MigrationMode;
    includeOptions: MigrationIncludeOptions;
    largeDbOptions: LargeDbOptions;

    // Analysis
    sourceSnapshot: SchemaSnapshot | null;
    targetSnapshot: SchemaSnapshot | null;
    diffResult: MigrationDiff | null;
    forwardSQL: string;
    rollbackSQL: string;
    isAnalyzing: boolean;
    analyzeProgress: { stage: string; current: number; total: number } | null;

    // Active SQL view
    activeSqlView: "forward" | "rollback";

    // Execution
    isDryRunning: boolean;
    dryRunResult: DryRunResult | null;
    isApplying: boolean;
    isBackingUp: boolean;

    // Errors
    analyzeError: string | null;
    applyError: string | null;

    // History (persisted)
    migrationHistory: MigrationHistoryEntry[];

    // UI state
    historyPanelOpen: boolean;
    currentStep: 1 | 2 | 3;

    // Actions
    setSourceConnection: (id: string | null) => void;
    setTargetConnection: (id: string | null) => void;
    swapConnections: () => void;
    setSelectedSchemas: (schemas: string[]) => void;
    setSelectedTables: (tables: string[]) => void;
    toggleTable: (key: string) => void;
    setMigrationMode: (mode: MigrationMode) => void;
    setIncludeOption: (key: keyof MigrationIncludeOptions, value: boolean) => void;
    setLargeDbOptions: (opts: Partial<LargeDbOptions>) => void;
    setDiffResult: (diff: MigrationDiff, fwd: string, roll: string, src: SchemaSnapshot, tgt: SchemaSnapshot) => void;
    setAnalyzing: (v: boolean) => void;
    setAnalyzeProgress: (p: { stage: string; current: number; total: number } | null) => void;
    setAnalyzeError: (e: string | null) => void;
    setApplyError: (e: string | null) => void;
    setDryRunning: (v: boolean) => void;
    setDryRunResult: (r: DryRunResult | null) => void;
    setApplying: (v: boolean) => void;
    setBackingUp: (v: boolean) => void;
    setActiveSqlView: (v: "forward" | "rollback") => void;
    setHistoryPanelOpen: (v: boolean) => void;
    setCurrentStep: (s: 1 | 2 | 3) => void;
    addHistoryEntry: (entry: MigrationHistoryEntry) => void;
    updateHistoryEntry: (id: string, patch: Partial<MigrationHistoryEntry>) => void;
    removeHistoryEntry: (id: string) => void;
    clearHistory: () => void;
    reset: () => void;
}

const DEFAULT_LARGE_DB_OPTIONS: LargeDbOptions = {
    enabled: false,
    skipIndexesAboveRows: 1_000_000,
    concurrency: 4,
};

const DEFAULT_STATE = {
    sourceConnectionId: null,
    targetConnectionId: null,
    selectedSchemas: [],
    selectedTables: [],
    migrationMode: "schema_only" as MigrationMode,
    includeOptions: DEFAULT_INCLUDE_OPTIONS,
    largeDbOptions: DEFAULT_LARGE_DB_OPTIONS,
    sourceSnapshot: null,
    targetSnapshot: null,
    diffResult: null,
    forwardSQL: "",
    rollbackSQL: "",
    isAnalyzing: false,
    analyzeProgress: null,
    activeSqlView: "forward" as const,
    isDryRunning: false,
    dryRunResult: null,
    isApplying: false,
    isBackingUp: false,
    analyzeError: null,
    applyError: null,
    historyPanelOpen: false,
    currentStep: 1 as const,
};

export const useMigrationStudioStore = create<MigrationStudioState>()(
    persist(
        (set) => ({
            ...DEFAULT_STATE,
            migrationHistory: [],

            setSourceConnection: (id) => set({ sourceConnectionId: id }),
            setTargetConnection: (id) => set({ targetConnectionId: id }),
            swapConnections: () =>
                set((s) => ({
                    sourceConnectionId: s.targetConnectionId,
                    targetConnectionId: s.sourceConnectionId,
                    selectedSchemas: [],
                    selectedTables: [],
                })),
            setSelectedSchemas: (schemas) => set({ selectedSchemas: schemas, selectedTables: [] }),
            setSelectedTables: (tables) => set({ selectedTables: tables }),
            toggleTable: (key) =>
                set((s) => ({
                    selectedTables: s.selectedTables.includes(key)
                        ? s.selectedTables.filter(t => t !== key)
                        : [...s.selectedTables, key],
                })),
            setMigrationMode: (mode) => set({ migrationMode: mode }),
            setIncludeOption: (key, value) =>
                set((s) => ({
                    includeOptions: { ...s.includeOptions, [key]: value },
                })),
            setLargeDbOptions: (opts) =>
                set((s) => ({
                    largeDbOptions: { ...s.largeDbOptions, ...opts },
                })),

            setDiffResult: (diff, fwd, roll, src, tgt) =>
                set({
                    diffResult: diff,
                    forwardSQL: fwd,
                    rollbackSQL: roll,
                    sourceSnapshot: src,
                    targetSnapshot: tgt,
                    analyzeError: null,
                }),

            setAnalyzing: (v) => set({ isAnalyzing: v }),
            setAnalyzeProgress: (p) => set({ analyzeProgress: p }),
            setAnalyzeError: (e) => set({ analyzeError: e }),
            setApplyError: (e) => set({ applyError: e }),
            setDryRunning: (v) => set({ isDryRunning: v }),
            setDryRunResult: (r) => set({ dryRunResult: r }),
            setApplying: (v) => set({ isApplying: v }),
            setBackingUp: (v) => set({ isBackingUp: v }),
            setActiveSqlView: (v) => set({ activeSqlView: v }),
            setHistoryPanelOpen: (v) => set({ historyPanelOpen: v }),
            setCurrentStep: (s) => set({ currentStep: s }),

            addHistoryEntry: (entry) =>
                set((s) => ({
                    migrationHistory: [entry, ...s.migrationHistory].slice(0, 50),
                })),

            updateHistoryEntry: (id, patch) =>
                set((s) => ({
                    migrationHistory: s.migrationHistory.map((e) =>
                        e.id === id ? { ...e, ...patch } : e
                    ),
                })),

            removeHistoryEntry: (id) =>
                set((s) => ({
                    migrationHistory: s.migrationHistory.filter((e) => e.id !== id),
                })),

            clearHistory: () => set({ migrationHistory: [] }),

            reset: () =>
                set({
                    ...DEFAULT_STATE,
                }),
        }),
        {
            name: "helix-migration-history",
            partialize: (s) => ({
                migrationHistory: s.migrationHistory,
                historyPanelOpen: s.historyPanelOpen,
            }),
        }
    )
);
