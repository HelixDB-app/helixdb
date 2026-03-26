"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, Check, Loader2, Database, AlertCircle, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dbUpdateTableRow } from "@/lib/tauri";
import { dbGetTableDetails } from "@/lib/db-platform";
import { formatDbError } from "@/lib/db-errors";
import { formatCellValue, writableInsertColumns, type CellValue, type ResultColumn, type ColumnInfo, type TableDetails } from "@/lib/types";
import { RowFormFields } from "@/components/row-form-fields";
import { generateRowFormFill } from "@/lib/row-form-ai";
import { useSettingsStore } from "@/stores/settings-store";

interface RowEditorPanelProps {
    connectionId: string | null;
    schema: string | null;
    table: string | null;
    pkColumnNames: string[];
    columns: ResultColumn[];
    tableColumnsInfo: ColumnInfo[] | null;
    row: CellValue[] | null;
    isOpen: boolean;
    onClose: () => void;
    onSaveSuccess: () => void;
}

function cellToEditValue(cell: CellValue): string {
    if (cell.type === "Null") return "";
    return formatCellValue(cell);
}

function syntheticColumnInfo(rc: ResultColumn, idx: number, pkColumnNames: string[]): ColumnInfo {
    return {
        name: rc.name,
        data_type: rc.data_type,
        is_nullable: true,
        ordinal_position: idx + 1,
        column_default: null,
        is_primary_key: pkColumnNames.includes(rc.name),
        is_generated: false,
        comment: null,
    };
}

export function RowEditorPanel({
    connectionId,
    schema,
    table,
    pkColumnNames,
    columns,
    tableColumnsInfo,
    row,
    isOpen,
    onClose,
    onSaveSuccess,
}: RowEditorPanelProps) {
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [originalValues, setOriginalValues] = useState<Record<string, string>>({});
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tableDetails, setTableDetails] = useState<TableDetails | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [aiPrompt, setAiPrompt] = useState("");
    const [fillEmptyOnly, setFillEmptyOnly] = useState(false);
    const [aiGenerating, setAiGenerating] = useState(false);
    const [preAiSnapshot, setPreAiSnapshot] = useState<Record<string, string> | null>(null);
    const [columnFilter, setColumnFilter] = useState("");
    const [lastUpdateError, setLastUpdateError] = useState<string | null>(null);
    const editValuesRef = useRef(editValues);
    editValuesRef.current = editValues;
    const abortRef = useRef<AbortController | null>(null);

    const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);

    const formColumns: ColumnInfo[] = useMemo(() => {
        const genByName = new Map<string, boolean>();
        for (const c of tableDetails?.columns ?? []) {
            if (c.is_generated) genByName.set(c.name, true);
        }
        return columns.map((rc, i) => {
            const info = tableColumnsInfo?.find((t) => t.name === rc.name);
            const base = info ?? syntheticColumnInfo(rc, i, pkColumnNames);
            if (genByName.get(rc.name) && !base.is_generated)
                return { ...base, is_generated: true };
            return base;
        });
    }, [columns, tableColumnsInfo, pkColumnNames, tableDetails]);

    const effectiveDetails = useMemo((): TableDetails | null => {
        if (!schema || !table || formColumns.length === 0) return null;
        if (tableDetails) return { ...tableDetails, columns: formColumns };
        return {
            schema,
            name: table,
            table_type: "BASE TABLE",
            columns: formColumns,
            constraints: [],
            indexes: [],
            triggers: [],
            row_count: 0,
            total_size: "",
            table_size: "",
            indexes_size: "",
            comment: null,
        };
    }, [tableDetails, schema, table, formColumns]);

    const detailsForAi = useMemo((): TableDetails | null => {
        if (!effectiveDetails) return null;
        return {
            ...effectiveDetails,
            columns: writableInsertColumns(effectiveDetails.columns),
        };
    }, [effectiveDetails]);

    useEffect(() => {
        if (!isOpen || !connectionId || !schema || !table) {
            setTableDetails(null);
            return;
        }
        setDetailsLoading(true);
        dbGetTableDetails(connectionId, schema, table)
            .then(setTableDetails)
            .catch(() => setTableDetails(null))
            .finally(() => setDetailsLoading(false));
    }, [isOpen, connectionId, schema, table]);

    useEffect(() => {
        if (!isOpen) {
            abortRef.current?.abort();
            abortRef.current = null;
            setAiPrompt("");
            setPreAiSnapshot(null);
            setColumnFilter("");
            setLastUpdateError(null);
            return;
        }
    }, [isOpen]);

    useEffect(() => {
        if (isOpen && row && columns.length > 0) {
            const initialMap: Record<string, string> = {};
            columns.forEach((col, idx) => {
                initialMap[col.name] = cellToEditValue(row[idx] ?? { type: "Null" });
            });
            setEditValues(initialMap);
            setOriginalValues(initialMap);
            setError(null);
            setLastUpdateError(null);
        }
    }, [isOpen, row, columns]);

    const setColumnValue = useCallback((name: string, value: string) => {
        setEditValues((prev) => ({ ...prev, [name]: value }));
    }, []);

    const applyGeneratedRow = useCallback(
        (generated: Record<string, string | null>, fillEmpty: boolean) => {
            setPreAiSnapshot({ ...editValuesRef.current });
            setEditValues((prev) => {
                const next = { ...prev };
                for (const col of writableInsertColumns(formColumns)) {
                    if (fillEmpty && (prev[col.name] ?? "").trim() !== "") continue;
                    const v = generated[col.name];
                    next[col.name] = v === null || v === undefined ? "" : String(v);
                }
                return next;
            });
        },
        [formColumns]
    );

    const handleUndoAi = useCallback(() => {
        if (preAiSnapshot) {
            setEditValues(preAiSnapshot);
            setPreAiSnapshot(null);
        }
    }, [preAiSnapshot]);

    const runAiFill = useCallback(
        async (previousError?: string) => {
            if (!detailsForAi) return;
            const instruction = aiPrompt.trim();
            if (!previousError && !instruction) {
                toast.error("Describe changes for the AI, or use Adjust with AI after a save error.");
                return;
            }
            if (!geminiApiKey?.trim()) {
                toast.error("Add your Gemini API key in Settings → AI.");
                return;
            }
            abortRef.current?.abort();
            const ac = new AbortController();
            abortRef.current = ac;
            setAiGenerating(true);
            try {
                const rowData = await generateRowFormFill(
                    detailsForAi,
                    instruction,
                    "edit",
                    {
                        signal: ac.signal,
                        previousError: previousError?.trim() || undefined,
                        fillEmptyOnly: fillEmptyOnly && !previousError,
                        currentValues: editValuesRef.current,
                    }
                );
                applyGeneratedRow(rowData, fillEmptyOnly && !previousError);
                toast.success(previousError ? "Form updated from AI" : "Form filled from AI");
                if (previousError) setLastUpdateError(null);
            } catch (e) {
                if (e instanceof DOMException && e.name === "AbortError") return;
                toast.error(e instanceof Error ? e.message : "AI fill failed");
            } finally {
                setAiGenerating(false);
                abortRef.current = null;
            }
        },
        [detailsForAi, aiPrompt, geminiApiKey, fillEmptyOnly, applyGeneratedRow]
    );

    if (!isOpen || !row) return null;

    const hasChanges = Object.keys(editValues).some((key) => editValues[key] !== originalValues[key]);

    const handleSave = async () => {
        if (!connectionId || !schema || !table || pkColumnNames.length === 0) {
            setError("Cannot update row: missing connection, table info, or primary keys.");
            return;
        }

        const updates: { column: string; value: string | null }[] = [];
        const generatedNames = new Set(
            formColumns.filter((c) => c.is_generated).map((c) => c.name)
        );
        for (const col of columns) {
            if (generatedNames.has(col.name)) continue;
            const current = editValues[col.name];
            const original = originalValues[col.name];
            if (current !== original) {
                updates.push({
                    column: col.name,
                    value: current.trim() === "" ? null : current.trim(),
                });
            }
        }

        if (updates.length === 0) {
            onClose();
            return;
        }

        const pkValues = pkColumnNames.map((pkName) => {
            const val = originalValues[pkName];
            return val && val.trim() !== "" ? val : null;
        });

        setIsSaving(true);
        setError(null);
        setLastUpdateError(null);

        try {
            await dbUpdateTableRow(connectionId, schema, table, pkColumnNames, pkValues, updates);
            toast.success("Row updated successfully");
            onSaveSuccess();
            onClose();
        } catch (err) {
            const parsed = formatDbError(err, "update");
            const detail = [parsed.description, parsed.title].filter(Boolean).join("\n") || String(err);
            setLastUpdateError(detail);
            setError(parsed.description ?? parsed.title);
            toast.error(parsed.title, { description: parsed.description });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="absolute top-0 right-0 bottom-0 z-50 flex w-[min(520px,100vw)] flex-col border-l border-border/40 bg-card shadow-2xl transition-transform duration-300 ease-in-out translate-x-0">
            <div className="flex shrink-0 items-center justify-between border-b border-border/20 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    <Database className="h-4 w-4 shrink-0 text-emerald-500" />
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">Edit row</h3>
                        {schema && table && (
                            <p className="truncate font-mono text-[10px] text-muted-foreground">
                                {schema}.{table}
                            </p>
                        )}
                    </div>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" onClick={onClose}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <div className="shrink-0 space-y-2 border-b border-border/20 bg-muted/15 p-3">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-[11px] font-medium text-foreground/90">AI assist</span>
                    {detailsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                    AI overwrites fields to match your prompt unless &quot;Fill empty only&quot; is checked. Primary keys
                    should stay valid for the update.
                </p>
                <Textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="e.g. Set status to shipped and add tracking note"
                    className="min-h-[72px] resize-y text-xs"
                    disabled={aiGenerating || isSaving}
                />
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="edit-fill-empty-only"
                        checked={fillEmptyOnly}
                        onCheckedChange={(v) => setFillEmptyOnly(v === true)}
                        disabled={aiGenerating || isSaving}
                    />
                    <label htmlFor="edit-fill-empty-only" className="cursor-pointer text-[10px] text-muted-foreground">
                        Fill empty only
                    </label>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        size="sm"
                        className="h-7 gap-1 bg-violet-600 px-2 text-xs text-white hover:bg-violet-700"
                        disabled={
                            aiGenerating ||
                            isSaving ||
                            !geminiApiKey?.trim() ||
                            !detailsForAi ||
                            detailsForAi.columns.length === 0
                        }
                        onClick={() => runAiFill()}
                    >
                        {aiGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        Generate
                    </Button>
                    {preAiSnapshot && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={handleUndoAi}
                            disabled={aiGenerating || isSaving}
                        >
                            <Undo2 className="h-3 w-3" />
                            Undo AI
                        </Button>
                    )}
                </div>
                {lastUpdateError && (
                    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                        <p className="line-clamp-3 font-mono text-[9px] leading-snug text-muted-foreground">
                            {lastUpdateError}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-7 w-full gap-1 text-xs"
                            disabled={aiGenerating || isSaving || !geminiApiKey?.trim()}
                            onClick={() => runAiFill(lastUpdateError)}
                        >
                            {aiGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                            Adjust with AI
                        </Button>
                    </div>
                )}
                {!geminiApiKey?.trim() && (
                    <p className="text-[10px] text-amber-600/90 dark:text-amber-400/90">Add a Gemini API key in Settings → AI.</p>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-2 border-b border-border/15 px-3 py-2">
                <Input
                    value={columnFilter}
                    onChange={(e) => setColumnFilter(e.target.value)}
                    placeholder="Filter columns…"
                    className="h-7 text-xs"
                    disabled={isSaving}
                />
            </div>

            <ScrollArea className="min-h-0 flex-1 p-4">
                {error && !lastUpdateError && (
                    <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <RowFormFields
                    columns={formColumns}
                    values={editValues}
                    onChange={setColumnValue}
                    disabled={isSaving}
                    variant="edit"
                    resultColumns={columns}
                    constraints={tableDetails?.constraints ?? null}
                    columnFilter={columnFilter}
                    gridClassName="grid-cols-1"
                />
            </ScrollArea>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/20 bg-muted/10 p-4">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={isSaving}>
                    Cancel
                </Button>
                <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!hasChanges || isSaving}
                    className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Save changes
                </Button>
            </div>
        </div>
    );
}
