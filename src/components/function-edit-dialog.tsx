"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { dbExecuteQuery, dbGetColumns } from "@/lib/tauri";
import { MonacoSqlEditor } from "@/components/monaco-sql-editor";
import type { SchemaContext } from "@/lib/ai-suggestions";
import { format as formatSQL } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Play, Loader2, AlertCircle, Braces, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const BATCH = 6;

/** Extract a short, readable message from Rust/DbError-style validation errors */
function parseValidationMessage(raw: string): string {
    const m = raw.match(/message:\s*"([^"]+)"/);
    if (m) return m[1];
    if (raw.length > 200) return raw.slice(0, 200).trim() + "…";
    return raw;
}

export interface FunctionEditInlineProps {
    connectionId: string | null;
    schema: string;
    name: string;
    arguments: string;
    initialDefinition: string;
    onSaved?: () => void;
    onCancel?: () => void;
    className?: string;
}

export function FunctionEditInline({
    connectionId,
    schema,
    name,
    arguments: args,
    initialDefinition,
    onSaved,
    onCancel,
    className,
}: FunctionEditInlineProps) {
    const { tables } = useConnectionStore();
    const [definition, setDefinition] = useState(initialDefinition);
    const [running, setRunning] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [columnCache, setColumnCache] = useState<Record<string, string[]>>({});
    const columnCacheRef = useRef<Record<string, string[]>>({});
    useEffect(() => { columnCacheRef.current = columnCache; }, [columnCache]);

    useEffect(() => {
        setDefinition(initialDefinition);
        setValidationError(null);
    }, [initialDefinition]);

    const schemaContext: SchemaContext = useMemo(
        () => ({
            tables: tables.map((t) => t.name),
            columns: columnCache,
        }),
        [tables, columnCache]
    );

    useEffect(() => {
        if (!connectionId || tables.length === 0) return;
        let cancelled = false;
        const load = async () => {
            for (let i = 0; i < tables.length; i += BATCH) {
                if (cancelled) break;
                const batch = tables.slice(i, i + BATCH);
                await Promise.allSettled(
                    batch
                        .filter((t) => !columnCacheRef.current[t.name])
                        .map(async (tableInfo) => {
                            try {
                                const cols = await dbGetColumns(
                                    connectionId,
                                    tableInfo.schema,
                                    tableInfo.name
                                );
                                if (!cancelled) {
                                    setColumnCache((prev) => ({
                                        ...prev,
                                        [tableInfo.name]: cols.map((c) => c.name),
                                    }));
                                }
                            } catch {
                                // ignore
                            }
                        })
                );
            }
        };
        load();
        return () => { cancelled = true; };
    }, [connectionId, tables]);

    const handleFetchColumns = useCallback(
        async (tableName: string): Promise<string[]> => {
            if (!connectionId) return [];
            const cached = columnCacheRef.current[tableName];
            if (cached) return cached;
            const tableInfo = tables.find(
                (t) => t.name.toLowerCase() === tableName.toLowerCase()
            );
            if (!tableInfo) return [];
            try {
                const cols = await dbGetColumns(
                    connectionId,
                    tableInfo.schema,
                    tableInfo.name
                );
                const colNames = cols.map((c) => c.name);
                setColumnCache((prev) => ({ ...prev, [tableName]: colNames }));
                return colNames;
            } catch {
                return [];
            }
        },
        [connectionId, tables]
    );

    const handleFormatSql = useCallback((sql: string) => {
        try {
            const formatted = formatSQL(sql, {
                language: "postgresql",
                tabWidth: 4,
                keywordCase: "upper",
            });
            setDefinition(formatted);
            setValidationError(null);
            toast.success("SQL formatted", { duration: 1200 });
        } catch {
            toast.error("Could not format SQL", { duration: 1500 });
        }
    }, []);

    const handleRun = useCallback(async () => {
        if (!connectionId) return;
        const sql = definition.trim();
        if (!sql) {
            setValidationError("Enter the function definition (CREATE OR REPLACE FUNCTION ...).");
            return;
        }
        setValidationError(null);
        setRunning(true);
        try {
            const result = await dbExecuteQuery(connectionId, sql);
            if (result.is_error) {
                setValidationError(
                    parseValidationMessage(result.error_message ?? "Execution failed.")
                );
                return;
            }
            toast.success("Function updated", { duration: 2000 });
            onSaved?.();
        } catch (e) {
            setValidationError(parseValidationMessage(String(e)));
        } finally {
            setRunning(false);
        }
    }, [connectionId, definition, onSaved]);

    return (
        <div className={cn("flex flex-col h-full min-h-0", className)}>
            {/* Minimal toolbar */}
            <div className="flex items-center gap-2 shrink-0 py-2 px-1 border-b border-border/20">
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => handleFormatSql(definition)}
                    disabled={!definition.trim()}
                >
                    <Braces className="h-3 w-3 mr-1" />
                    Format
                </Button>
                <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleRun}
                    disabled={!definition.trim() || running}
                >
                    {running ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                        <Play className="h-3 w-3 mr-1" />
                    )}
                    Run & save
                </Button>
                {onCancel && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs ml-auto text-muted-foreground"
                        onClick={onCancel}
                        disabled={running}
                    >
                        <X className="h-3 w-3 mr-1" />
                        Cancel
                    </Button>
                )}
            </div>

            {/* Editor */}
            <div className="flex-1 min-h-[240px] rounded-b-md overflow-hidden border border-t-0 border-border/30">
                <MonacoSqlEditor
                    value={definition}
                    onChange={setDefinition}
                    onExecute={handleRun}
                    onFormatSql={handleFormatSql}
                    onFetchColumns={handleFetchColumns}
                    schemaContext={schemaContext}
                    disabled={running}
                    editorHeight={320}
                    className="h-full border-0"
                />
            </div>

            {/* Validation error — minimal single line when possible */}
            {validationError && (
                <div
                    className="shrink-0 flex items-start gap-2 mt-2 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono"
                    role="alert"
                >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span className="break-words">{validationError}</span>
                </div>
            )}
        </div>
    );
}
