import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SqlFile {
    id: string;
    name: string;
    sql: string;
    createdAt: number;
    updatedAt: number;
}

export interface SqlTemplate {
    id: string;
    name: string;
    description: string;
    sql: string;
    category: string;
    isBuiltIn?: boolean;
}

const BUILT_IN_TEMPLATES: SqlTemplate[] = [
    {
        id: "builtin-select-all",
        name: "Select All",
        description: "Fetch all rows from a table",
        sql: "SELECT *\nFROM your_table\nLIMIT 100;",
        category: "Query",
        isBuiltIn: true,
    },
    {
        id: "builtin-select-cols",
        name: "Select Columns",
        description: "Fetch specific columns with a WHERE clause",
        sql: "SELECT id, name, created_at\nFROM your_table\nWHERE condition = true\nORDER BY created_at DESC\nLIMIT 50;",
        category: "Query",
        isBuiltIn: true,
    },
    {
        id: "builtin-count",
        name: "Count Rows",
        description: "Count total rows in a table",
        sql: "SELECT COUNT(*) AS total\nFROM your_table;",
        category: "Query",
        isBuiltIn: true,
    },
    {
        id: "builtin-insert",
        name: "Insert Row",
        description: "Insert a new row into a table",
        sql: "INSERT INTO your_table (column1, column2)\nVALUES ('value1', 'value2')\nRETURNING *;",
        category: "DML",
        isBuiltIn: true,
    },
    {
        id: "builtin-update",
        name: "Update Rows",
        description: "Update rows matching a condition",
        sql: "UPDATE your_table\nSET column1 = 'new_value'\nWHERE id = 1\nRETURNING *;",
        category: "DML",
        isBuiltIn: true,
    },
    {
        id: "builtin-delete",
        name: "Delete Rows",
        description: "Delete rows matching a condition",
        sql: "DELETE FROM your_table\nWHERE id = 1\nRETURNING *;",
        category: "DML",
        isBuiltIn: true,
    },
    {
        id: "builtin-create-table",
        name: "Create Table",
        description: "Create a new table with common columns",
        sql: "CREATE TABLE your_table (\n    id BIGSERIAL PRIMARY KEY,\n    name TEXT NOT NULL,\n    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);",
        category: "DDL",
        isBuiltIn: true,
    },
    {
        id: "builtin-create-index",
        name: "Create Index",
        description: "Create an index on a column",
        sql: "CREATE INDEX CONCURRENTLY idx_your_table_column\n    ON your_table (column_name);",
        category: "DDL",
        isBuiltIn: true,
    },
    {
        id: "builtin-explain",
        name: "Explain Analyze",
        description: "Analyze query performance",
        sql: "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)\nSELECT *\nFROM your_table\nWHERE id = 1;",
        category: "Performance",
        isBuiltIn: true,
    },
    {
        id: "builtin-table-size",
        name: "Table Sizes",
        description: "List tables sorted by size",
        sql: "SELECT\n    schemaname,\n    tablename,\n    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,\n    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size\nFROM pg_tables\nWHERE schemaname NOT IN ('pg_catalog', 'information_schema')\nORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;",
        category: "Performance",
        isBuiltIn: true,
    },
    {
        id: "builtin-running-queries",
        name: "Running Queries",
        description: "Show currently running queries",
        sql: "SELECT\n    pid,\n    now() - query_start AS duration,\n    state,\n    left(query, 120) AS query\nFROM pg_stat_activity\nWHERE state != 'idle'\n  AND query_start IS NOT NULL\nORDER BY duration DESC;",
        category: "Performance",
        isBuiltIn: true,
    },
    {
        id: "builtin-locks",
        name: "Table Locks",
        description: "Show current table locks",
        sql: "SELECT\n    l.relation::regclass AS table_name,\n    l.mode,\n    l.granted,\n    a.pid,\n    a.query\nFROM pg_locks l\nJOIN pg_stat_activity a ON l.pid = a.pid\nWHERE l.relation IS NOT NULL\nORDER BY l.relation;",
        category: "Performance",
        isBuiltIn: true,
    },
];

interface QueryFilesState {
    files: SqlFile[];
    templates: SqlTemplate[];
    activeFileId: string | null;

    createFile: (name?: string, sql?: string) => SqlFile;
    updateFile: (id: string, patch: Partial<Pick<SqlFile, "name" | "sql">>) => void;
    deleteFile: (id: string) => void;
    setActiveFile: (id: string | null) => void;

    createTemplate: (name: string, description: string, sql: string, category: string) => void;
    deleteTemplate: (id: string) => void;

    getAllTemplates: () => SqlTemplate[];
}

export const useQueryFilesStore = create<QueryFilesState>()(
    persist(
        (set, get) => ({
            files: [],
            templates: [],
            activeFileId: null,

            createFile: (name?, sql?) => {
                const file: SqlFile = {
                    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                    name: name ?? `query-${get().files.length + 1}.sql`,
                    sql: sql ?? "",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                set((s) => ({ files: [file, ...s.files], activeFileId: file.id }));
                return file;
            },

            updateFile: (id, patch) => {
                set((s) => ({
                    files: s.files.map((f) =>
                        f.id === id ? { ...f, ...patch, updatedAt: Date.now() } : f
                    ),
                }));
            },

            deleteFile: (id) => {
                set((s) => {
                    const files = s.files.filter((f) => f.id !== id);
                    const activeFileId = s.activeFileId === id
                        ? (files[0]?.id ?? null)
                        : s.activeFileId;
                    return { files, activeFileId };
                });
            },

            setActiveFile: (id) => set({ activeFileId: id }),

            createTemplate: (name, description, sql, category) => {
                const template: SqlTemplate = {
                    id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                    name,
                    description,
                    sql,
                    category,
                    isBuiltIn: false,
                };
                set((s) => ({ templates: [template, ...s.templates] }));
            },

            deleteTemplate: (id) => {
                set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
            },

            getAllTemplates: () => {
                return [...BUILT_IN_TEMPLATES, ...get().templates];
            },
        }),
        {
            name: "helix-sql-files",
            partialize: (state) => ({
                files: state.files,
                templates: state.templates,
                activeFileId: state.activeFileId,
            }),
        }
    )
);
