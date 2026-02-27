"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { dbInsertTableRow } from "@/lib/tauri";
import type { ColumnInfo } from "@/lib/types";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

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

function hasDefault(col: ColumnInfo): boolean {
    return col.column_default != null && col.column_default.trim() !== "";
}

export function InsertRowDialog({
    open,
    onOpenChange,
    connectionId,
    schema,
    table,
    columns,
    onSuccess,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connectionId: string | null;
    schema: string;
    table: string;
    columns: ColumnInfo[];
    onSuccess: () => void;
}) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open && columns.length > 0) {
            const t = setTimeout(() => {
                contentRef.current?.querySelector<HTMLInputElement>("input")?.focus();
            }, 50);
            return () => clearTimeout(t);
        }
    }, [open, columns.length]);

    const resetForm = useCallback(() => {
        setValues({});
        setErrors({});
    }, []);

    const setColumnValue = useCallback((name: string, value: string) => {
        setValues((prev) => ({ ...prev, [name]: value }));
        setErrors((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
    }, []);

    const handleSubmit = useCallback(async () => {
        if (!connectionId || columns.length === 0) return;

        const fieldErrors: Record<string, string> = {};
        const insertValues: { column: string; value: string | null }[] = [];

        for (const col of columns) {
            const raw = values[col.name] ?? "";
            const trimmed = raw.trim();
            if (trimmed === "") {
                if (col.is_nullable) {
                    insertValues.push({ column: col.name, value: null });
                } else if (hasDefault(col)) {
                    // omit
                } else {
                    fieldErrors[col.name] = "Required";
                }
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
        try {
            await dbInsertTableRow(connectionId, schema, table, insertValues);
            toast.success("Row inserted");
            resetForm();
            onOpenChange(false);
            onSuccess();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setIsSubmitting(false);
        }
    }, [connectionId, schema, table, columns, values, onSuccess, onOpenChange, resetForm]);

    const handleOpenChange = useCallback(
        (next: boolean) => {
            if (!next) resetForm();
            onOpenChange(next);
        },
        [onOpenChange, resetForm]
    );

    const placeholder = (col: ColumnInfo) => {
        if (hasDefault(col)) return "DEFAULT";
        if (col.is_nullable) return "NULL";
        return "Value…";
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-2xl w-[90vw] max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
                <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                            <Plus className="h-4 w-4 text-emerald-500" />
                        </div>
                        Add row
                    </DialogTitle>
                    <DialogDescription>
                        <span className="font-mono text-foreground/80">{schema}.{table}</span>
                        {" — enter values for the new row."}
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="flex-1 min-h-0 px-6">
                    <div ref={contentRef} className="space-y-4 py-4 pr-4">
                        {columns.map((col, idx) => (
                            <div key={col.name} className="space-y-1.5">
                                <label className="text-xs font-medium flex items-center gap-2" id={`insert-${col.name}`}>
                                    <span className="font-mono text-foreground">{col.name}</span>
                                    <span className="font-mono text-muted-foreground text-[10px]">
                                        {col.data_type}
                                    </span>
                                    {!col.is_nullable && !hasDefault(col) && (
                                        <span className="text-destructive/80">*</span>
                                    )}
                                </label>
                                <Input
                                    aria-labelledby={`insert-${col.name}`}
                                    aria-invalid={Boolean(errors[col.name])}
                                    value={values[col.name] ?? ""}
                                    onChange={(e) => setColumnValue(col.name, e.target.value)}
                                    placeholder={placeholder(col)}
                                    className={errors[col.name] ? "border-destructive/50 focus-visible:ring-destructive/30" : ""}
                                    disabled={isSubmitting}
                                    autoComplete="off"
                                />
                                {errors[col.name] && (
                                    <p className="text-[11px] text-destructive">{errors[col.name]}</p>
                                )}
                            </div>
                        ))}
                    </div>
                </ScrollArea>

                <DialogFooter className="px-6 py-4 border-t border-border/20 shrink-0">
                    <Button
                        variant="outline"
                        onClick={() => handleOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !connectionId}
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
