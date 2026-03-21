"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { dbGetTableDetails, dbListSchemas, dbListTables } from "@/lib/db-platform";
import { dbGetAccessProfile, dbInsertTableRowsBulk } from "@/lib/tauri";
import type { TableDetails, DatabaseAccessProfile, SchemaInfo, TableInfo, ColumnInfo } from "@/lib/types";
import { GEMINI_MODELS, type GeminiModelId } from "@/lib/ai-chat-engine";
import { useSettingsStore } from "@/stores/settings-store";
import { generateSeedData, type SeedDataRow } from "@/lib/seed-data-engine";
import { AIError } from "@/lib/ai-chat-engine";
import { Loader2, Sparkles, Database, Table2, AlertTriangle, Pencil, Code2, Copy, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const MODEL_IDS = Object.keys(GEMINI_MODELS) as GeminiModelId[];
const MIN_ROWS = 1;
const MAX_ROWS = 100;
const DEFAULT_ROWS = 10;

/** Normalize cell value for insert: empty string -> null when column is nullable. */
function normalizeRowForInsert(
    row: SeedDataRow,
    columns: ColumnInfo[]
): { column: string; value: string | null }[] {
    return columns.map((col) => {
        const raw = row[col.name];
        const val = raw === null || raw === undefined ? "" : String(raw).trim();
        const value = val === "" && col.is_nullable ? null : (val || null);
        return { column: col.name, value };
    });
}

/** Escape a string for use inside single-quoted SQL literal; NULL stays NULL. */
function sqlLiteral(value: string | null): string {
    if (value === null || value === undefined) return "NULL";
    const s = String(value);
    return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** Quote identifier for PostgreSQL (reserved words, case). */
function quoteId(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
}

/** Build a single INSERT statement (multi-row VALUES) for preview/copy. */
function buildInsertSql(
    schema: string,
    table: string,
    columns: ColumnInfo[],
    rows: SeedDataRow[]
): string {
    const schemaQ = quoteId(schema);
    const tableQ = quoteId(table);
    const cols = columns.map((c) => quoteId(c.name)).join(", ");
    const valuesList = rows.map((row) => {
        const vals = columns.map((col) => {
            const raw = row[col.name];
            const val = raw === null || raw === undefined ? "" : String(raw).trim();
            const isNull = val === "" && col.is_nullable;
            return isNull ? "NULL" : sqlLiteral(val || "");
        });
        return "  (" + vals.join(", ") + ")";
    });
    return `INSERT INTO ${schemaQ}.${tableQ} (${cols})\nVALUES\n${valuesList.join(",\n")};`;
}

/** Validate rows before insert; returns error message if invalid. */
function validateRowsForInsert(
    rows: SeedDataRow[],
    columns: ColumnInfo[]
): { ok: true } | { ok: false; message: string } {
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (const col of columns) {
            if (col.is_nullable) continue;
            const v = row[col.name];
            const s = v === null || v === undefined ? "" : String(v).trim();
            if (s === "") {
                return {
                    ok: false,
                    message: `Row ${i + 1}: required column "${col.name}" is empty.`,
                };
            }
        }
    }
    return { ok: true };
}

/** Extract a short, user-friendly message from a Postgres/Tauri error. */
function formatInsertError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission denied/i.test(msg))
        return "You do not have permission to insert into this table.";
    if (/duplicate key|unique constraint/i.test(msg))
        return "A row with this key already exists. Edit the data or regenerate.";
    if (/foreign key|violates foreign key/i.test(msg))
        return "A value does not exist in the referenced table. Check foreign key columns.";
    if (/null value in column/i.test(msg))
        return "A required column has no value. Fill in all required fields.";
    if (/invalid input syntax/i.test(msg))
        return "A value has the wrong type (e.g. number vs text). Check the preview.";
    const firstLine = msg.split(/\n/)[0]?.trim() ?? msg;
    return firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
}

export interface SeedDataDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connectionId: string | null;
    schema?: string;
    table?: string;
    onSuccess?: () => void;
}

export function SeedDataDialog({
    open,
    onOpenChange,
    connectionId,
    schema: initialSchema,
    table: initialTable,
    onSuccess,
}: SeedDataDialogProps) {
    const defaultModel = useSettingsStore((s) => s.defaultAiModel) as GeminiModelId;
    const [details, setDetails] = useState<TableDetails | null>(null);
    const [accessProfile, setAccessProfile] = useState<DatabaseAccessProfile | null>(null);
    const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
    const [tables, setTables] = useState<TableInfo[]>([]);
    const [selectedSchema, setSelectedSchema] = useState<string>(initialSchema ?? "");
    const [selectedTable, setSelectedTable] = useState<string>(initialTable ?? "");
    const [rowCount, setRowCount] = useState(DEFAULT_ROWS);
    const [model, setModel] = useState<GeminiModelId>(defaultModel);
    const [generatedRows, setGeneratedRows] = useState<SeedDataRow[] | null>(null);
    const [loadingDetails, setLoadingDetails] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [inserting, setInserting] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [showSqlPreview, setShowSqlPreview] = useState(false);
    const [insertError, setInsertError] = useState<string | null>(null);
    const [fixingWithAi, setFixingWithAi] = useState(false);

    const schemaProvided = initialSchema != null && initialSchema !== "";
    const tableProvided = initialTable != null && initialTable !== "";
    const hasContext = schemaProvided && tableProvided;
    const effectiveSchema = hasContext ? initialSchema! : selectedSchema;
    const effectiveTable = hasContext ? initialTable! : selectedTable;

    const loadDetails = useCallback(async () => {
        if (!connectionId || !effectiveSchema || !effectiveTable) return;
        setLoadingDetails(true);
        try {
            const [d, profile] = await Promise.all([
                dbGetTableDetails(connectionId, effectiveSchema, effectiveTable),
                dbGetAccessProfile(connectionId),
            ]);
            setDetails(d);
            setAccessProfile(profile);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to load table details.");
            setDetails(null);
        } finally {
            setLoadingDetails(false);
        }
    }, [connectionId, effectiveSchema, effectiveTable]);

    useEffect(() => {
        if (!open || !connectionId) return;
        if (hasContext) {
            loadDetails();
            return;
        }
        dbListSchemas(connectionId).then(setSchemas).catch(() => setSchemas([]));
    }, [open, connectionId, hasContext, loadDetails]);

    useEffect(() => {
        if (!open || !connectionId || hasContext || !selectedSchema) return;
        dbListTables(connectionId, selectedSchema).then(setTables).catch(() => setTables([]));
    }, [open, connectionId, hasContext, selectedSchema]);

    useEffect(() => {
        if (!hasContext && selectedSchema && selectedTable) loadDetails();
    }, [hasContext, selectedSchema, selectedTable, loadDetails]);

    const handleGenerate = useCallback(async () => {
        if (!details || !connectionId) return;
        setGenerating(true);
        setGeneratedRows(null);
        const ac = new AbortController();
        try {
            const rows = await generateSeedData(
                details.schema,
                details.name,
                details,
                Math.min(MAX_ROWS, Math.max(MIN_ROWS, rowCount)),
                { model, signal: ac.signal }
            );
            setGeneratedRows(rows);
        } catch (e) {
            if (e instanceof AIError) toast.error(e.userMessage);
            else toast.error(e instanceof Error ? e.message : "Failed to generate data.");
        } finally {
            setGenerating(false);
        }
    }, [details, connectionId, rowCount, model]);

    const setCellValue = useCallback((rowIndex: number, columnName: string, value: string | null) => {
        setGeneratedRows((prev) => {
            if (!prev) return prev;
            const next = prev.map((row, i) =>
                i === rowIndex ? { ...row, [columnName]: value === "" ? null : value } : row
            );
            return next;
        });
    }, []);

    const handleConfirmInsert = useCallback(async () => {
        if (!connectionId || !details || !generatedRows?.length) return;
        const validation = validateRowsForInsert(generatedRows, details.columns);
        if (!validation.ok) {
            toast.error(validation.message);
            return;
        }
        setInsertError(null);
        setInserting(true);
        try {
            const rows = generatedRows.map((row) => normalizeRowForInsert(row, details.columns));
            await dbInsertTableRowsBulk(connectionId, details.schema, details.name, rows);
            toast.success(`${generatedRows.length} row(s) inserted successfully.`);
            setConfirmOpen(false);
            setInsertError(null);
            setGeneratedRows(null);
            onSuccess?.();
            onOpenChange(false);
        } catch (e) {
            const fullMsg = e instanceof Error ? e.message : String(e);
            setInsertError(fullMsg);
            toast.error(formatInsertError(e));
        } finally {
            setInserting(false);
        }
    }, [connectionId, details, generatedRows, onSuccess, onOpenChange]);

    const handleFixWithAi = useCallback(
        async (errorMessage: string | null) => {
            if (!details || !errorMessage?.trim() || !generatedRows?.length) return;
            setConfirmOpen(false);
            setInsertError(null);
            setFixingWithAi(true);
            try {
                const rows = await generateSeedData(
                    details.schema,
                    details.name,
                    details,
                    generatedRows.length,
                    { model, previousError: errorMessage }
                );
                setGeneratedRows(rows);
                toast.success("Data regenerated based on the error. Review the preview and try inserting again.");
            } catch (e) {
                if (e instanceof AIError) toast.error(e.userMessage);
                else toast.error(e instanceof Error ? e.message : "Failed to fix with AI.");
                setInsertError(errorMessage);
                setConfirmOpen(true);
            } finally {
                setFixingWithAi(false);
            }
        },
        [details, generatedRows?.length, model]
    );

    const canInsert = accessProfile?.can_create_in_database !== false;
    const insertDisabled = !canInsert || inserting || !generatedRows?.length;

    const resetOnClose = useCallback(() => {
        setGeneratedRows(null);
        setConfirmOpen(false);
        setShowSqlPreview(false);
        setInsertError(null);
        setFixingWithAi(false);
        if (!hasContext) {
            setSelectedSchema(initialSchema ?? "");
            setSelectedTable(initialTable ?? "");
        }
        setRowCount(DEFAULT_ROWS);
        setModel(defaultModel);
    }, [hasContext, initialSchema, initialTable, defaultModel]);

    return (
        <>
            <Dialog
                open={open}
                onOpenChange={(o) => {
                    if (!o) resetOnClose();
                    onOpenChange(o);
                }}
            >
                <DialogContent className="max-w-[90vw] w-full max-w-5xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden">
                    <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b border-border/50">
                        <DialogTitle className="flex items-center gap-3 text-lg">
                            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 border border-amber-500/25">
                                <Sparkles className="h-5 w-5 text-amber-400" />
                            </span>
                            Seed data
                        </DialogTitle>
                        <DialogDescription className="text-sm mt-1">
                            Generate realistic sample rows from the table schema using AI. Edit the preview below, then insert when ready.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex-1 overflow-hidden flex flex-col min-h-0 px-6 pb-6">
                        {!hasContext && (
                            <div className="grid grid-cols-2 gap-4 py-4 shrink-0">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Database className="h-4 w-4" /> Schema
                                    </label>
                                    <Select
                                        value={selectedSchema}
                                        onValueChange={(v) => {
                                            setSelectedSchema(v);
                                            setSelectedTable("");
                                            setDetails(null);
                                        }}
                                    >
                                        <SelectTrigger className="h-10 bg-muted/30">
                                            <SelectValue placeholder="Select schema" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {schemas.map((s) => (
                                                <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Table2 className="h-4 w-4" /> Table
                                    </label>
                                    <Select
                                        value={selectedTable}
                                        onValueChange={(v) => {
                                            setSelectedTable(v);
                                            setDetails(null);
                                        }}
                                        disabled={!selectedSchema}
                                    >
                                        <SelectTrigger className="h-10 bg-muted/30">
                                            <SelectValue placeholder="Select table" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {tables
                                                .filter((t) => t.table_type === "BASE TABLE")
                                                .map((t) => (
                                                    <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                                                ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}

                        {loadingDetails && (
                            <div className="flex items-center gap-3 text-sm text-muted-foreground py-6">
                                <Loader2 className="h-5 w-5 animate-spin shrink-0" />
                                Loading table details…
                            </div>
                        )}

                        {details && !loadingDetails && (
                            <>
                                <div className="flex flex-wrap items-end gap-4 py-4 shrink-0">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Row count</label>
                                        <Input
                                            type="number"
                                            min={MIN_ROWS}
                                            max={MAX_ROWS}
                                            value={rowCount}
                                            onChange={(e) =>
                                                setRowCount(Math.min(MAX_ROWS, Math.max(MIN_ROWS, Number(e.target.value) || DEFAULT_ROWS)))
                                            }
                                            className="w-28 h-10 bg-muted/30 text-sm"
                                            disabled={generating}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">AI model</label>
                                        <Select value={model} onValueChange={(v) => setModel(v as GeminiModelId)} disabled={generating}>
                                            <SelectTrigger className="w-48 h-10 bg-muted/30">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {MODEL_IDS.map((id) => (
                                                    <SelectItem key={id} value={id}>{GEMINI_MODELS[id].displayName}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <Button
                                        size="default"
                                        className="h-10 gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0"
                                        onClick={handleGenerate}
                                        disabled={generating}
                                    >
                                        {generating ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Sparkles className="h-4 w-4" />
                                        )}
                                        Generate
                                    </Button>
                                </div>

                                {generatedRows && generatedRows.length > 0 && (
                                    <>
                                        <div className="flex items-center gap-2 py-2 shrink-0">
                                            <Pencil className="h-4 w-4 text-muted-foreground" />
                                            <span className="text-sm text-muted-foreground">
                                                Preview: {generatedRows.length} row(s). Edit any cell, then insert.
                                            </span>
                                        </div>
                                        <ScrollArea className="flex-1 min-h-[320px] rounded-lg border border-border/60 bg-muted/10">
                                            <div className="min-w-full inline-block">
                                                <table className="w-full text-sm border-collapse">
                                                    <thead>
                                                        <tr className="border-b border-border/60 bg-muted/30 sticky top-0 z-10">
                                                            {details.columns.map((c) => (
                                                                <th
                                                                    key={c.name}
                                                                    className="text-left px-3 py-3 font-semibold font-mono text-muted-foreground whitespace-nowrap min-w-[140px] max-w-[220px]"
                                                                    title={`${c.name} (${c.data_type})${c.is_nullable ? " nullable" : ""}`}
                                                                >
                                                                    {c.name}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {generatedRows.map((row, rowIndex) => (
                                                            <tr
                                                                key={rowIndex}
                                                                className={cn(
                                                                    "border-b border-border/40 hover:bg-muted/20 transition-colors",
                                                                    rowIndex % 2 === 0 ? "bg-background/50" : "bg-muted/5"
                                                                )}
                                                            >
                                                                {details.columns.map((col) => (
                                                                    <td
                                                                        key={col.name}
                                                                        className="p-1 align-middle min-w-[140px] max-w-[220px]"
                                                                    >
                                                                        <Input
                                                                            value={row[col.name] ?? ""}
                                                                            onChange={(e) =>
                                                                                setCellValue(rowIndex, col.name, e.target.value)
                                                                            }
                                                                            placeholder={col.is_nullable ? "NULL" : "required"}
                                                                            className={cn(
                                                                                "h-9 font-mono text-[13px] bg-background/80 border-border/50 focus-visible:ring-amber-500/30",
                                                                                (row[col.name] ?? "") === "" && !col.is_nullable && "border-amber-500/50"
                                                                            )}
                                                                            title={col.data_type}
                                                                        />
                                                                    </td>
                                                                ))}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                            <ScrollBar orientation="horizontal" />
                                        </ScrollArea>

                                        <div className="py-3 shrink-0">
                                            <button
                                                type="button"
                                                onClick={() => setShowSqlPreview((v) => !v)}
                                                className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                                            >
                                                <Code2 className="h-4 w-4" />
                                                {showSqlPreview ? "Hide" : "View"} INSERT command
                                                {showSqlPreview ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                            </button>
                                            {showSqlPreview && details && generatedRows && (
                                                <div className="mt-2 rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
                                                    <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/30">
                                                        <span className="text-xs font-medium text-muted-foreground">Generated SQL (read-only)</span>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 gap-1.5 text-xs"
                                                            onClick={() => {
                                                                const sql = buildInsertSql(details.schema, details.name, details.columns, generatedRows);
                                                                navigator.clipboard.writeText(sql);
                                                                toast.success("SQL copied to clipboard");
                                                            }}
                                                        >
                                                            <Copy className="h-3.5 w-3.5" /> Copy
                                                        </Button>
                                                    </div>
                                                    <ScrollArea className="max-h-[220px] w-full">
                                                        <pre className="p-3 text-xs font-mono text-foreground/90 whitespace-pre-wrap break-all">
                                                            {buildInsertSql(details.schema, details.name, details.columns, generatedRows)}
                                                        </pre>
                                                    </ScrollArea>
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex items-center justify-between gap-4 pt-4 shrink-0 border-t border-border/50 mt-4">
                                            {!canInsert && (
                                                <span className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
                                                    <AlertTriangle className="h-4 w-4 shrink-0" />
                                                    Your database user cannot create data in this database.
                                                </span>
                                            )}
                                            <div className="flex gap-2 ml-auto">
                                                <Button
                                                    variant="outline"
                                                    size="default"
                                                    className="h-9"
                                                    onClick={handleGenerate}
                                                    disabled={generating}
                                                >
                                                    Regenerate
                                                </Button>
                                                <Button
                                                    size="default"
                                                    className="h-9 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                                                    onClick={() => {
                                                        setInsertError(null);
                                                        setConfirmOpen(true);
                                                    }}
                                                    disabled={insertDisabled}
                                                    title={!canInsert ? "No insert permission" : undefined}
                                                >
                                                    Insert {generatedRows.length} row(s)
                                                </Button>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    <DialogFooter className="px-6 py-4 border-t border-border/50 shrink-0 bg-muted/5">
                        <Button variant="ghost" size="sm" className="h-9" onClick={() => onOpenChange(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmOpen} onOpenChange={(open) => { if (!open) setInsertError(null); setConfirmOpen(open); }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Insert {generatedRows?.length ?? 0} row(s)?</DialogTitle>
                        <DialogDescription>
                            Data will be inserted into <span className="font-mono">{effectiveSchema}.{effectiveTable}</span>. This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    {insertError && (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                            <p className="text-xs font-medium text-destructive/90 mb-1">Error details</p>
                            <ScrollArea className="max-h-24 w-full">
                                <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">{insertError}</pre>
                            </ScrollArea>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1.5 text-xs"
                                    onClick={() => {
                                        navigator.clipboard.writeText(insertError);
                                        toast.success("Error copied");
                                    }}
                                >
                                    <Copy className="h-3 w-3" /> Copy error
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7 gap-1.5 text-xs bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border-0"
                                    onClick={() => handleFixWithAi(insertError)}
                                    disabled={fixingWithAi || inserting}
                                >
                                    {fixingWithAi ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                    {fixingWithAi ? "Fixing…" : "Fix with AI"}
                                </Button>
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={inserting || fixingWithAi}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={handleConfirmInsert} disabled={inserting || fixingWithAi} className="bg-emerald-600 hover:bg-emerald-700">
                            {inserting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                            {inserting ? "Inserting…" : "Insert"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
