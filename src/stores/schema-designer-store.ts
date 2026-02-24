/**
 * Schema Designer Zustand Store
 *
 * Manages projects, schema editing, AI state, undo/redo, and auto-save
 * to the Rust backend via Tauri commands.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
    schemaDesignerLoadAll,
    schemaDesignerSaveProject,
    schemaDesignerDeleteProject,
} from "@/lib/tauri";
import { sqlToSchemaDesignerTables } from "@/lib/sql-to-schema";
import type {
    SchemaProject,
    SchemaDesignerTable,
    SchemaDesignerColumn,
    SchemaSnapshot,
    AISchemaReport,
} from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function genId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
    return new Date().toISOString();
}

// ── Types ────────────────────────────────────────────────────────────────────

interface UndoEntry {
    tables: SchemaDesignerTable[];
    label: string;
}

interface SchemaDesignerState {
    // Project management
    projects: SchemaProject[];
    activeProjectId: string | null;
    isLoading: boolean;
    error: string | null;

    // AI state
    aiEnabled: boolean;
    isAiStreaming: boolean;
    aiStreamText: string;
    currentReport: AISchemaReport | null;
    isReportLoading: boolean;

    // Undo/redo
    undoStack: UndoEntry[];
    redoStack: UndoEntry[];

    // Auto-save debounce
    _saveTimer: ReturnType<typeof setTimeout> | null;

    // Actions — project management
    loadProjects: () => Promise<void>;
    createProject: (name: string, appType: string, description: string) => Promise<string>;
    createProjectFromSql: (name: string, sql: string) => Promise<string>;
    importSqlToCurrent: (sql: string) => boolean;
    deleteProject: (id: string) => Promise<void>;
    setActiveProject: (id: string | null) => void;
    getActiveProject: () => SchemaProject | null;

    // Actions — table editing
    addTable: (name: string) => void;
    updateTable: (tableId: string, updates: Partial<SchemaDesignerTable>) => void;
    deleteTable: (tableId: string) => void;
    addColumn: (tableId: string, column: Omit<SchemaDesignerColumn, "id">) => void;
    updateColumn: (tableId: string, columnId: string, updates: Partial<SchemaDesignerColumn>) => void;
    deleteColumn: (tableId: string, columnId: string) => void;
    setTables: (tables: SchemaDesignerTable[]) => void;
    updateTablePosition: (tableId: string, x: number, y: number) => void;
    updateTablePositions: (positions: { tableId: string; x: number; y: number }[]) => void;

    // Actions — undo/redo
    undo: () => void;
    redo: () => void;
    pushUndo: (label: string) => void;

    // Actions — versioning
    saveSnapshot: (label: string) => void;
    restoreSnapshot: (snapshotId: string) => void;

    // Actions — AI mode
    setAiEnabled: (enabled: boolean) => void;
    setAiStreaming: (streaming: boolean) => void;
    setAiStreamText: (text: string) => void;
    setCurrentReport: (report: AISchemaReport | null) => void;
    setReportLoading: (loading: boolean) => void;

    // Actions — error
    setError: (error: string | null) => void;

    // Internal — auto-save
    _autoSave: () => void;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useSchemaDesignerStore = create<SchemaDesignerState>()(
    persist(
        (set, get) => ({
            projects: [],
            activeProjectId: null,
            isLoading: false,
            error: null,
            aiEnabled: true,
            isAiStreaming: false,
            aiStreamText: "",
            currentReport: null,
            isReportLoading: false,
            undoStack: [],
            redoStack: [],
            _saveTimer: null,

            // ── Project Management ───────────────────────────────────

            loadProjects: async () => {
                set({ isLoading: true, error: null });
                try {
                    const projects = await schemaDesignerLoadAll();
                    set({ projects, isLoading: false });
                } catch (e) {
                    set({ error: String(e), isLoading: false });
                }
            },

            createProject: async (name, appType, description) => {
                const id = genId();
                const project: SchemaProject = {
                    id,
                    name,
                    app_type: appType,
                    description,
                    tables: [],
                    version_history: [],
                    created_at: now(),
                    updated_at: now(),
                };
                try {
                    const projects = await schemaDesignerSaveProject(project);
                    set({ projects, activeProjectId: id, undoStack: [], redoStack: [] });
                    return id;
                } catch (e) {
                    set({ error: String(e) });
                    return id;
                }
            },

            createProjectFromSql: async (name, sql) => {
                const tables = sqlToSchemaDesignerTables(sql);
                const id = genId();
                const project: SchemaProject = {
                    id,
                    name: name.trim() || "Imported from SQL",
                    app_type: "custom",
                    description: "Imported from SQL script",
                    tables,
                    version_history: [],
                    created_at: now(),
                    updated_at: now(),
                };
                try {
                    const projects = await schemaDesignerSaveProject(project);
                    set({ projects, activeProjectId: id, undoStack: [], redoStack: [] });
                    return id;
                } catch (e) {
                    set({ error: String(e) });
                    return id;
                }
            },

            importSqlToCurrent: (sql) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return false;
                try {
                    const tables = sqlToSchemaDesignerTables(sql);
                    state.pushUndo("Import SQL");
                    set({
                        projects: state.projects.map(p =>
                            p.id === project.id ? { ...p, tables, updated_at: now() } : p
                        ),
                    });
                    state._autoSave();
                    return true;
                } catch {
                    return false;
                }
            },

            deleteProject: async (id) => {
                try {
                    const projects = await schemaDesignerDeleteProject(id);
                    const state = get();
                    set({
                        projects,
                        activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
                    });
                } catch (e) {
                    set({ error: String(e) });
                }
            },

            setActiveProject: (id) => {
                set({ activeProjectId: id, undoStack: [], redoStack: [], currentReport: null, aiStreamText: "" });
            },

            getActiveProject: () => {
                const state = get();
                if (!state.activeProjectId) return null;
                return state.projects.find(p => p.id === state.activeProjectId) ?? null;
            },

            // ── Table Editing ────────────────────────────────────────

            addTable: (name) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                state.pushUndo("Add table");
                const newTable: SchemaDesignerTable = {
                    id: genId(),
                    name,
                    columns: [
                        {
                            id: genId(),
                            name: "id",
                            data_type: "UUID",
                            nullable: false,
                            default_value: "gen_random_uuid()",
                            is_primary_key: true,
                            foreign_key: null,
                        },
                        {
                            id: genId(),
                            name: "created_at",
                            data_type: "TIMESTAMPTZ",
                            nullable: false,
                            default_value: "NOW()",
                            is_primary_key: false,
                            foreign_key: null,
                        },
                        {
                            id: genId(),
                            name: "updated_at",
                            data_type: "TIMESTAMPTZ",
                            nullable: false,
                            default_value: "NOW()",
                            is_primary_key: false,
                            foreign_key: null,
                        },
                    ],
                    indexes: [],
                    position: (() => {
                                const n = project.tables.length;
                                const cols = 4;
                                const stepX = 268;
                                const stepY = 120;
                                return { x: 50 + (n % cols) * stepX, y: 50 + Math.floor(n / cols) * stepY };
                            })(),
                };
                const updatedTables = [...project.tables, newTable];
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id ? { ...p, tables: updatedTables, updated_at: now() } : p
                    ),
                });
                state._autoSave();
            },

            updateTable: (tableId, updates) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t =>
                                    t.id === tableId ? { ...t, ...updates } : t
                                ),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            deleteTable: (tableId) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                state.pushUndo("Delete table");
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.filter(t => t.id !== tableId),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            addColumn: (tableId, column) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                state.pushUndo("Add column");
                const newCol: SchemaDesignerColumn = { id: genId(), ...column };
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t =>
                                    t.id === tableId ? { ...t, columns: [...t.columns, newCol] } : t
                                ),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            updateColumn: (tableId, columnId, updates) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t =>
                                    t.id === tableId
                                        ? {
                                            ...t,
                                            columns: t.columns.map(c =>
                                                c.id === columnId ? { ...c, ...updates } : c
                                            ),
                                        }
                                        : t
                                ),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            deleteColumn: (tableId, columnId) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                state.pushUndo("Delete column");
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t =>
                                    t.id === tableId
                                        ? { ...t, columns: t.columns.filter(c => c.id !== columnId) }
                                        : t
                                ),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            setTables: (tables) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                state.pushUndo("Set tables");
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id ? { ...p, tables, updated_at: now() } : p
                    ),
                });
                state._autoSave();
            },

            updateTablePosition: (tableId, x, y) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t =>
                                    t.id === tableId ? { ...t, position: { x, y } } : t
                                ),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            updateTablePositions: (positions) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project || positions.length === 0) return;
                const byId = new Map(positions.map(p => [p.tableId, p]));
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: p.tables.map(t => {
                                    const pos = byId.get(t.id);
                                    return pos ? { ...t, position: { x: pos.x, y: pos.y } } : t;
                                }),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            // ── Undo/Redo ────────────────────────────────────────────

            pushUndo: (label) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                const entry: UndoEntry = {
                    tables: JSON.parse(JSON.stringify(project.tables)),
                    label,
                };
                set({
                    undoStack: [...state.undoStack.slice(-29), entry],
                    redoStack: [],
                });
            },

            undo: () => {
                const state = get();
                const project = state.getActiveProject();
                if (!project || state.undoStack.length === 0) return;
                const last = state.undoStack[state.undoStack.length - 1];
                const redoEntry: UndoEntry = {
                    tables: JSON.parse(JSON.stringify(project.tables)),
                    label: last.label,
                };
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id ? { ...p, tables: last.tables, updated_at: now() } : p
                    ),
                    undoStack: state.undoStack.slice(0, -1),
                    redoStack: [...state.redoStack, redoEntry],
                });
                state._autoSave();
            },

            redo: () => {
                const state = get();
                const project = state.getActiveProject();
                if (!project || state.redoStack.length === 0) return;
                const last = state.redoStack[state.redoStack.length - 1];
                const undoEntry: UndoEntry = {
                    tables: JSON.parse(JSON.stringify(project.tables)),
                    label: last.label,
                };
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id ? { ...p, tables: last.tables, updated_at: now() } : p
                    ),
                    undoStack: [...state.undoStack, undoEntry],
                    redoStack: state.redoStack.slice(0, -1),
                });
                state._autoSave();
            },

            // ── Versioning ───────────────────────────────────────────

            saveSnapshot: (label) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                const snapshot: SchemaSnapshot = {
                    id: genId(),
                    label,
                    timestamp: now(),
                    tables: JSON.parse(JSON.stringify(project.tables)),
                };
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                version_history: [...p.version_history, snapshot],
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            restoreSnapshot: (snapshotId) => {
                const state = get();
                const project = state.getActiveProject();
                if (!project) return;
                const snapshot = project.version_history.find(s => s.id === snapshotId);
                if (!snapshot) return;
                state.pushUndo("Restore snapshot");
                set({
                    projects: state.projects.map(p =>
                        p.id === project.id
                            ? {
                                ...p,
                                tables: JSON.parse(JSON.stringify(snapshot.tables)),
                                updated_at: now(),
                            }
                            : p
                    ),
                });
                state._autoSave();
            },

            // ── AI Mode ──────────────────────────────────────────────

            setAiEnabled: (enabled) => set({ aiEnabled: enabled }),
            setAiStreaming: (streaming) => set({ isAiStreaming: streaming }),
            setAiStreamText: (text) => set({ aiStreamText: text }),
            setCurrentReport: (report) => set({ currentReport: report }),
            setReportLoading: (loading) => set({ isReportLoading: loading }),

            // ── Error ────────────────────────────────────────────────

            setError: (error) => set({ error }),

            // ── Internal — auto-save ─────────────────────────────────

            _autoSave: () => {
                const state = get();
                if (state._saveTimer) clearTimeout(state._saveTimer);
                const timer = setTimeout(async () => {
                    const project = get().getActiveProject();
                    if (project) {
                        try {
                            await schemaDesignerSaveProject(project);
                        } catch (e) {
                            console.error("Auto-save failed:", e);
                        }
                    }
                }, 500); // 500ms debounce
                set({ _saveTimer: timer });
            },
        }),
        {
            name: "helix-schema-designer",
            version: 1,
            partialize: (state) => ({
                activeProjectId: state.activeProjectId,
                aiEnabled: state.aiEnabled,
            }),
        }
    )
);
