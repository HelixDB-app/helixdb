"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { generateSQL } from "@/lib/schema-designer-engine";
import { sqlToSchemaDesignerTables, scriptMatchesSchema } from "@/lib/sql-to-schema";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle, Copy, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import type { SchemaDesignerTable } from "@/lib/types";

const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), { ssr: false });

const DDL_KEYWORDS = [
    "CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "DROP INDEX", "ALTER TABLE", "DROP TABLE",
    "ADD COLUMN", "DROP COLUMN", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "NOT NULL", "DEFAULT", "UNIQUE",
    "UUID", "TEXT", "VARCHAR", "INTEGER", "BIGINT", "SMALLINT", "BOOLEAN",
    "TIMESTAMPTZ", "TIMESTAMP", "DATE", "TIME", "JSONB", "JSON", "NUMERIC",
    "REAL", "SERIAL", "BIGSERIAL", "CONSTRAINT", "ON DELETE", "ON UPDATE",
];

const COLUMN_CONTEXT_RE = /(\w+)\.\w*$/;

function buildSchemaContext(tables: SchemaDesignerTable[]): { tables: string[]; columns: Record<string, string[]> } {
    const tableNames = tables.map((t) => t.name);
    const columns: Record<string, string[]> = {};
    for (const t of tables) {
        columns[t.name] = t.columns.map((c) => c.name);
        columns[t.name.toLowerCase()] = t.columns.map((c) => c.name);
    }
    return { tables: tableNames, columns };
}

interface SchemaScriptPanelProps {
    isActive: boolean;
}

const AUTO_APPLY_MS = 700;

export function SchemaScriptPanel({ isActive }: SchemaScriptPanelProps) {
    const { getActiveProject, setTables } = useSchemaDesignerStore();
    const project = getActiveProject();
    const { resolvedTheme } = useTheme();
    const { editorFontSize, editorTabSize } = useSettingsStore();

    const [script, setScript] = useState("");
    const [applyError, setApplyError] = useState<string | null>(null);
    const [lastSaved, setLastSaved] = useState<boolean | null>(null);
    const prevActiveRef = useRef(false);
    const schemaContextRef = useRef(buildSchemaContext(project?.tables ?? []));
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Skip next auto-apply when script was set by sync/refresh (only apply on user edits). */
    const skipNextApplyRef = useRef(false);

    const tables = project?.tables ?? [];
    schemaContextRef.current = buildSchemaContext(tables);

    // Sync script from schema when user switches to this tab. Preserve user's script if it matches the diagram.
    // When replacing, re-sync from the current script (parse → store → generate) so FOREIGN KEY / REFERENCES are not lost.
    useEffect(() => {
        if (!isActive || !project) {
            prevActiveRef.current = isActive;
            return;
        }
        if (!prevActiveRef.current) {
            const current = script.trim();
            const matchesDiagram = current && scriptMatchesSchema(current, project.tables);
            skipNextApplyRef.current = true;
            if (!matchesDiagram) {
                if (current) {
                    try {
                        const parsed = sqlToSchemaDesignerTables(current);
                        if (parsed.length > 0) {
                            setTables(parsed);
                            setScript(generateSQL(parsed));
                        } else {
                            setScript(generateSQL(project.tables));
                        }
                    } catch {
                        setScript(generateSQL(project.tables));
                    }
                } else {
                    setScript(generateSQL(project.tables));
                }
            }
            setApplyError(null);
            setLastSaved(null);
        }
        prevActiveRef.current = true;
    }, [isActive, project, setTables]);

    const tryApply = useCallback(() => {
        if (!project) return;
        const trimmed = script.trim();
        if (!trimmed) {
            setApplyError(null);
            setLastSaved(null);
            return;
        }
        try {
            const parsed = sqlToSchemaDesignerTables(trimmed);
            if (parsed.length === 0) {
                setApplyError("No CREATE TABLE statements found.");
                return;
            }
            // Preserve diagram positions (and ids) by table name so apply only updates schema, no reorder
            const merged = parsed.map((t) => {
                const existing = project.tables.find((e) => e.name === t.name);
                return {
                    ...t,
                    id: existing?.id ?? t.id,
                    position: existing?.position ?? t.position,
                };
            });
            // Remap FK target_table_id to merged table ids so diagram lines point to correct tables
            const parsedIdToMergedId = new Map(parsed.map((t, i) => [t.id, merged[i].id]));
            for (const table of merged) {
                for (const col of table.columns) {
                    if (col.foreign_key) {
                        const newTargetId = parsedIdToMergedId.get(col.foreign_key.target_table_id);
                        if (newTargetId) {
                            col.foreign_key = {
                                ...col.foreign_key,
                                target_table_id: newTargetId,
                            };
                        }
                    }
                }
            }
            setTables(merged);
            setApplyError(null);
            setLastSaved(true);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setApplyError(msg);
            setLastSaved(false);
        }
    }, [project, script, setTables]);

    // Auto-apply only when user edits script (not when script was set by sync/refresh)
    useEffect(() => {
        if (!isActive) return;
        if (skipNextApplyRef.current) {
            skipNextApplyRef.current = false;
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            tryApply();
        }, AUTO_APPLY_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [script, isActive, tryApply]);

    const handleChange = useCallback((value: string | undefined) => {
        setScript(value ?? "");
    }, []);

    const handleRefreshFromDiagram = useCallback(() => {
        if (project) {
            skipNextApplyRef.current = true;
            setScript(generateSQL(project.tables));
            setApplyError(null);
            setLastSaved(null);
            toast.success("Script refreshed from diagram");
        }
    }, [project]);

    const handleCopy = useCallback(() => {
        if (!script) return;
        navigator.clipboard.writeText(script);
        toast.success("Copied to clipboard");
    }, [script]);

    const handleBeforeMount = useCallback((monaco: typeof import("monaco-editor")) => {
        const ctx = () => schemaContextRef.current;
        monaco.languages.registerCompletionItemProvider("sql", {
            triggerCharacters: [" ", ".", "\n", "("],
            provideCompletionItems: (model, position) => {
                const wordInfo = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: wordInfo.startColumn,
                    endColumn: position.column,
                };
                const textUntil = model.getValueInRange({
                    startLineNumber: 1,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                });
                const c = ctx();
                const keywordSuggestions = DDL_KEYWORDS.map((kw) => ({
                    label: kw,
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: kw,
                    range,
                    sortText: "0_" + kw,
                }));
                const tableSuggestions = c.tables.map((t) => ({
                    label: t,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: `"${t}"`,
                    range,
                    detail: "Table",
                    sortText: "1_" + t,
                }));
                const dotMatch = textUntil.match(COLUMN_CONTEXT_RE);
                if (dotMatch) {
                    const tableName = dotMatch[1];
                    const cols = c.columns[tableName] ?? c.columns[tableName.toLowerCase()] ?? [];
                    if (cols.length > 0) {
                        return {
                            suggestions: cols.map((col) => ({
                                label: col,
                                kind: monaco.languages.CompletionItemKind.Field,
                                insertText: col,
                                range,
                                detail: "Column",
                                sortText: "0_" + col,
                            })),
                        };
                    }
                }
                return { suggestions: [...tableSuggestions, ...keywordSuggestions] };
            },
        });
    }, []);

    if (!project) return null;

    const hasTables = project.tables.length > 0;
    const isEmpty = !script.trim();
    const monacoTheme = resolvedTheme === "light" ? "vs" : "vs-dark";

    return (
        <div className="h-full flex flex-col border-l border-border/10">
            <div className="flex items-center justify-between border-b border-border/20 px-3 py-2 shrink-0">
                <span className="text-xs font-semibold text-foreground">Schema script</span>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px] gap-1"
                        onClick={handleRefreshFromDiagram}
                        disabled={!hasTables}
                    >
                        <RefreshCw className="h-3 w-3" />
                        Refresh
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px] gap-1"
                        onClick={handleCopy}
                        disabled={isEmpty}
                    >
                        <Copy className="h-3 w-3" />
                        Copy
                    </Button>
                </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="flex-1 h-[75vh] border border-border/30 rounded-md overflow-hidden">
                    <Editor
                        height="100%"
                        defaultLanguage="sql"
                        language="sql"
                        value={script}
                        onChange={handleChange}
                        beforeMount={handleBeforeMount}
                        theme={monacoTheme}
                        loading={null}
                        options={{
                            minimap: { enabled: false },
                            lineNumbers: "on",
                            lineNumbersMinChars: 3,
                            scrollBeyondLastLine: false,
                            fontSize: editorFontSize,
                            fontFamily: "var(--font-mono), ui-monospace, monospace",
                            wordWrap: "off",
                            padding: { top: 10, bottom: 10 },
                            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                            smoothScrolling: true,
                            tabSize: editorTabSize,
                            insertSpaces: true,
                            automaticLayout: true,
                            quickSuggestions: { other: true, comments: false, strings: false },
                            suggestOnTriggerCharacters: true,
                        }}
                    />
                </div>
                {applyError && (
                    <div className="flex items-center gap-2 mt-2 rounded-md bg-red-500/10 border border-red-500/20 px-2 py-1.5 text-[10px] text-red-400 shrink-0">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        <span>{applyError}</span>
                    </div>
                )}
                <div className="flex items-center justify-between mt-2 shrink-0 min-h-[20px]">
                    {lastSaved === true && !applyError && (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-500/90">
                            <CheckCircle2 className="h-3 w-3" />
                            Auto-saved • diagram updated
                        </span>
                    )}
                    {lastSaved === null && !applyError && script.trim() && (
                        <span className="text-[10px] text-muted-foreground/70">
                            Edits sync to diagram automatically
                        </span>
                    )}
                    {!script.trim() && (
                        <span className="text-[10px] text-muted-foreground/50">
                            Paste or type CREATE TABLE statements
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
