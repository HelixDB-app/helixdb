"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dbInsertTableRow } from "@/lib/tauri";
import { dbGetTableDetails } from "@/lib/db-platform";
import { writableInsertColumns, type ColumnInfo, type ResultColumn, type TableDetails } from "@/lib/types";
import { formatDbError } from "@/lib/db-errors";
import { Loader2, Plus, Sparkles, Undo2, PanelLeftClose, PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { RowFormFields, hasColumnDefault } from "@/components/row-form-fields";
import { generateRowFormFill } from "@/lib/row-form-ai";
import { cn } from "@/lib/utils";
import { useResolvedGeminiApiKey } from "@/stores/settings-store";

function validateCellValue(
    value: string,
    dataType: string,
    isNullable: boolean
): string | null {
    const t = dataType.toLowerCase();
    const trimmed = value.trim();
    if (trimmed === "") return isNullable ? null : "Required";
    if (t.includes("int") || t === "smallint" || t === "bigint" || t === "serial" || t === "bigserial") {
        const n = Number(trimmed);
        if (Number.isNaN(n) || !Number.isInteger(n)) return "Invalid integer";
    }
    if (t.includes("double") || t.includes("real") || t === "numeric" || t === "decimal") {
        if (Number.isNaN(Number(trimmed))) return "Invalid number";
    }
    if (t === "boolean" || t === "bool") {
        const v = trimmed.toLowerCase();
        if (!["true", "false", "yes", "no", "1", "0"].includes(v)) return "Invalid boolean";
    }
    if (t === "uuid" && !/^[0-9a-f-]{36}$/i.test(trimmed)) return "Invalid UUID";
    return null;
}

function emptyTableDetails(schema: string, table: string, columns: ColumnInfo[]): TableDetails {
    return {
        schema,
        name: table,
        table_type: "BASE TABLE",
        columns,
        constraints: [],
        indexes: [],
        triggers: [],
        row_count: 0,
        total_size: "",
        table_size: "",
        indexes_size: "",
        comment: null,
    };
}

export function InsertRowDialog({
    open,
    onOpenChange,
    connectionId,
    schema,
    table,
    columns,
    resultColumns,
    onSuccess,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connectionId: string | null;
    schema: string;
    table: string;
    columns: ColumnInfo[];
    /** Optional grid column metadata (e.g. enum labels). */
    resultColumns?: ResultColumn[] | null;
    onSuccess: () => void;
}) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const valuesRef = useRef(values);
    valuesRef.current = values;

    const [tableDetails, setTableDetails] = useState<TableDetails | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [aiPrompt, setAiPrompt] = useState("");
    const [fillEmptyOnly, setFillEmptyOnly] = useState(false);
    const [aiGenerating, setAiGenerating] = useState(false);
    const [preAiSnapshot, setPreAiSnapshot] = useState<Record<string, string> | null>(null);
    const [columnFilter, setColumnFilter] = useState("");
    const [lastInsertError, setLastInsertError] = useState<string | null>(null);
    const [aiRailOpen, setAiRailOpen] = useState(true);
    const abortRef = useRef<AbortController | null>(null);

    const geminiApiKey = useResolvedGeminiApiKey();

    const insertableColumns = useMemo(() => writableInsertColumns(columns), [columns]);

    const effectiveDetails = useMemo((): TableDetails | null => {
        if (!schema || !table || columns.length === 0) return null;
        if (tableDetails) return tableDetails;
        return emptyTableDetails(schema, table, columns);
    }, [tableDetails, schema, table, columns]);

    const detailsForAi = useMemo((): TableDetails | null => {
        if (!effectiveDetails) return null;
        const w = writableInsertColumns(effectiveDetails.columns);
        return { ...effectiveDetails, columns: w };
    }, [effectiveDetails]);

    const resultColumnsForInsert = useMemo(() => {
        if (!resultColumns?.length) return null;
        const allow = new Set(insertableColumns.map((c) => c.name));
        return resultColumns.filter((rc) => allow.has(rc.name));
    }, [resultColumns, insertableColumns]);

    useEffect(() => {
        if (!open) {
            abortRef.current?.abort();
            abortRef.current = null;
            return;
        }
        setLastInsertError(null);
        setPreAiSnapshot(null);
        setColumnFilter("");
        setAiPrompt("");
        if (!connectionId || !schema || !table) {
            setTableDetails(null);
            return;
        }
        setDetailsLoading(true);
        dbGetTableDetails(connectionId, schema, table)
            .then(setTableDetails)
            .catch(() => {
                setTableDetails(null);
                toast.error("Could not load full table metadata; AI will use column list only.");
            })
            .finally(() => setDetailsLoading(false));
    }, [open, connectionId, schema, table]);

    useEffect(() => {
        if (open && insertableColumns.length > 0) {
            const t = setTimeout(() => {
                contentRef.current?.querySelector<HTMLInputElement>("input")?.focus();
            }, 80);
            return () => clearTimeout(t);
        }
    }, [open, insertableColumns.length]);

    const resetForm = useCallback(() => {
        setValues({});
        setErrors({});
        setPreAiSnapshot(null);
        setLastInsertError(null);
    }, []);

    const setColumnValue = useCallback((name: string, value: string) => {
        setValues((prev) => ({ ...prev, [name]: value }));
        setErrors((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
    }, []);

    const applyGeneratedRow = useCallback(
        (row: Record<string, string | null>, fillEmpty: boolean) => {
            setPreAiSnapshot({ ...valuesRef.current });
            setValues((prev) => {
                const next = { ...prev };
                for (const col of insertableColumns) {
                    if (fillEmpty && (prev[col.name] ?? "").trim() !== "") continue;
                    const v = row[col.name];
                    next[col.name] = v === null || v === undefined ? "" : String(v);
                }
                return next;
            });
            setErrors({});
        },
        [insertableColumns]
    );

    const handleUndoAi = useCallback(() => {
        if (preAiSnapshot) {
            setValues(preAiSnapshot);
            setPreAiSnapshot(null);
            setErrors({});
        }
    }, [preAiSnapshot]);

    const runAiFill = useCallback(
        async (previousError?: string) => {
            if (!detailsForAi) return;
            const instruction = aiPrompt.trim();
            if (!previousError && !instruction) {
                toast.error("Describe what to fill in, or use Adjust with AI after an insert error.");
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
                const row = await generateRowFormFill(
                    detailsForAi,
                    instruction,
                    "insert",
                    {
                        signal: ac.signal,
                        previousError: previousError?.trim() || undefined,
                        fillEmptyOnly: fillEmptyOnly && !previousError,
                    }
                );
                applyGeneratedRow(row, fillEmptyOnly && !previousError);
                toast.success(previousError ? "Form updated from AI" : "Form filled from AI");
                if (previousError) setLastInsertError(null);
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

    const handleSubmit = useCallback(async () => {
        if (!connectionId || insertableColumns.length === 0) return;

        const fieldErrors: Record<string, string> = {};
        const insertValues: { column: string; value: string | null }[] = [];

        for (const col of insertableColumns) {
            const raw = values[col.name] ?? "";
            const trimmed = raw.trim();
            const useDefault = trimmed.toLowerCase() === "default";
            if (trimmed === "" || (useDefault && hasColumnDefault(col))) {
                if (trimmed === "" && !useDefault) {
                    if (col.is_nullable) {
                        insertValues.push({ column: col.name, value: null });
                    } else if (hasColumnDefault(col)) {
                        // omit
                    } else {
                        fieldErrors[col.name] = "Required";
                    }
                }
            } else if (useDefault && !hasColumnDefault(col)) {
                fieldErrors[col.name] = "DEFAULT only for columns with a default";
            } else {
                const err = validateCellValue(trimmed, col.data_type, col.is_nullable);
                if (err) {
                    fieldErrors[col.name] = err;
                } else {
                    insertValues.push({ column: col.name, value: trimmed });
                }
            }
        }

        if (Object.keys(fieldErrors).length > 0) {
            setErrors(fieldErrors);
            return;
        }

        if (insertValues.length === 0) {
            toast.error("Provide at least one column value");
            return;
        }

        setIsSubmitting(true);
        setErrors({});
        setLastInsertError(null);
        try {
            await dbInsertTableRow(connectionId, schema, table, insertValues);
            toast.success("Row inserted");
            resetForm();
            onOpenChange(false);
            onSuccess();
        } catch (e) {
            const err = formatDbError(e, "insert");
            const detail = [err.description, err.title].filter(Boolean).join("\n") || String(e);
            setLastInsertError(detail);
            toast.error(err.title, { description: err.description });
        } finally {
            setIsSubmitting(false);
        }
    }, [connectionId, schema, table, insertableColumns, values, onSuccess, onOpenChange, resetForm]);

    const handleOpenChange = useCallback(
        (next: boolean) => {
            if (!next) {
                resetForm();
                abortRef.current?.abort();
            }
            onOpenChange(next);
        },
        [onOpenChange, resetForm]
    );

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                showCloseButton
                className={cn(
                    "fixed inset-0 left-0 top-0 z-50 flex h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:max-w-none"
                )}
            >
                <DialogHeader className="shrink-0 border-b border-border/30 bg-card/40 px-4 py-4 text-left sm:px-6">
                    <DialogTitle className="flex items-center gap-3 text-lg">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10">
                            <Plus className="h-5 w-5 text-emerald-500" />
                        </div>
                        Add row
                    </DialogTitle>
                    <DialogDescription className="space-y-1 pt-1">
                        <span className="font-mono text-foreground/90">{schema}.{table}</span>
                        <span className="text-muted-foreground"> — enter values for the new row.</span>
                        {tableDetails?.comment?.trim() ? (
                            <p className="text-xs text-muted-foreground/80 max-w-3xl leading-relaxed">
                                {tableDetails.comment.trim()}
                            </p>
                        ) : null}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                    {/* AI rail */}
                    <aside
                        className={cn(
                            "flex shrink-0 flex-col border-b border-border/30 bg-muted/20 lg:w-[min(22rem,100%)] lg:border-b-0 lg:border-r",
                            !aiRailOpen && "hidden lg:flex lg:w-12"
                        )}
                    >
                        <div className="flex items-center justify-between gap-2 border-b border-border/20 px-3 py-2 lg:px-4">
                            <div className="flex items-center gap-2 min-w-0">
                                <Sparkles className="h-4 w-4 shrink-0 text-violet-500" />
                                {aiRailOpen && (
                                    <span className="text-xs font-medium truncate">AI fill</span>
                                )}
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={() => setAiRailOpen((o) => !o)}
                                title={aiRailOpen ? "Collapse panel" : "Expand panel"}
                            >
                                {aiRailOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
                            </Button>
                        </div>
                        {aiRailOpen && (
                            <div className="flex flex-1 flex-col gap-3 p-3 lg:p-4 min-h-0">
                                <p className="text-[11px] text-muted-foreground leading-snug">
                                    Describe sample data in plain language (e.g. &quot;car product with SKU and
                                    price&quot;). Requires a Gemini API key in Settings → AI.
                                </p>
                                <Textarea
                                    value={aiPrompt}
                                    onChange={(e) => setAiPrompt(e.target.value)}
                                    placeholder="e.g. Fill with realistic shipping address for Jane Doe in Austin, TX"
                                    className="min-h-[100px] flex-1 resize-y text-sm"
                                    disabled={aiGenerating || isSubmitting}
                                />
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        id="fill-empty-only"
                                        checked={fillEmptyOnly}
                                        onCheckedChange={(v) => setFillEmptyOnly(v === true)}
                                        disabled={aiGenerating || isSubmitting}
                                    />
                                    <label htmlFor="fill-empty-only" className="text-xs text-muted-foreground cursor-pointer">
                                        Fill empty fields only
                                    </label>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
                                        disabled={
                                            aiGenerating ||
                                            isSubmitting ||
                                            !geminiApiKey?.trim() ||
                                            detailsLoading ||
                                            !detailsForAi ||
                                            insertableColumns.length === 0
                                        }
                                        onClick={() => runAiFill()}
                                    >
                                        {aiGenerating ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Sparkles className="h-3.5 w-3.5" />
                                        )}
                                        Generate
                                    </Button>
                                    {preAiSnapshot && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={handleUndoAi}
                                            disabled={aiGenerating || isSubmitting}
                                        >
                                            <Undo2 className="h-3.5 w-3.5" />
                                            Undo AI
                                        </Button>
                                    )}
                                </div>
                                {lastInsertError && (
                                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-2">
                                        <p className="text-[10px] text-muted-foreground font-mono leading-snug line-clamp-4">
                                            {lastInsertError}
                                        </p>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="secondary"
                                            className="w-full gap-1.5"
                                            disabled={aiGenerating || isSubmitting || !geminiApiKey?.trim()}
                                            onClick={() => runAiFill(lastInsertError)}
                                        >
                                            {aiGenerating ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Sparkles className="h-3.5 w-3.5" />
                                            )}
                                            Adjust with AI
                                        </Button>
                                    </div>
                                )}
                                {!geminiApiKey?.trim() && (
                                    <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90">
                                        Open Settings → AI and add a Gemini API key to enable generation.
                                    </p>
                                )}
                            </div>
                        )}
                    </aside>

                    {/* Form */}
                    <div className="flex min-h-0 flex-1 flex-col bg-background/30">
                        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/20 px-4 py-2 sm:px-6">
                            <Input
                                value={columnFilter}
                                onChange={(e) => setColumnFilter(e.target.value)}
                                placeholder="Filter columns…"
                                className="h-8 max-w-xs text-xs"
                                disabled={isSubmitting}
                            />
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                                {insertableColumns.length} insertable
                                {columns.length !== insertableColumns.length
                                    ? ` · ${columns.length - insertableColumns.length} generated (DB)`
                                    : ""}
                            </span>
                        </div>
                        <ScrollArea className="min-h-0 flex-1">
                            <div className="px-4 py-4 sm:px-6 sm:py-5">
                                <RowFormFields
                                    columns={insertableColumns}
                                    values={values}
                                    onChange={setColumnValue}
                                    errors={errors}
                                    disabled={isSubmitting}
                                    variant="insert"
                                    resultColumns={resultColumnsForInsert}
                                    constraints={tableDetails?.constraints ?? null}
                                    columnFilter={columnFilter}
                                    contentRef={contentRef}
                                />
                            </div>
                        </ScrollArea>
                    </div>
                </div>

                <DialogFooter className="shrink-0 border-t border-border/30 bg-card/50 px-4 py-4 sm:px-6">
                    <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !connectionId || insertableColumns.length === 0}
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                                Inserting…
                            </>
                        ) : (
                            <>
                                <Plus className="h-3.5 w-3.5 mr-1.5" />
                                Insert row
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
