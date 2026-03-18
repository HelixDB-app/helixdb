"use client";

import { useState, useEffect } from "react";
import { X, Check, Loader2, Database, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dbUpdateTableRow } from "@/lib/tauri";
import type { CellValue, ResultColumn, ColumnInfo } from "@/lib/types";
import { formatCellValue } from "@/lib/types";

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

// Convert cell value to a string for editing
function cellToEditValue(cell: CellValue): string {
    if (cell.type === "Null") return "";
    return formatCellValue(cell);
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

    // Initialize edit state when opened or row changes
    useEffect(() => {
        if (isOpen && row && columns.length > 0) {
            const initialMap: Record<string, string> = {};
            columns.forEach((col, idx) => {
                initialMap[col.name] = cellToEditValue(row[idx] ?? { type: "Null" });
            });
            setEditValues(initialMap);
            setOriginalValues(initialMap);
            setError(null);
        }
    }, [isOpen, row, columns]);

    if (!isOpen || !row) return null;

    const hasChanges = Object.keys(editValues).some(
        (key) => editValues[key] !== originalValues[key]
    );

    const handleSave = async () => {
        if (!connectionId || !schema || !table || pkColumnNames.length === 0) {
            setError("Cannot update row: missing connection, table info, or primary keys.");
            return;
        }

        const updates: { column: string; value: string | null }[] = [];
        for (const col of columns) {
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

        // Get PK values for the WHERE clause (from original row)
        const pkValues = pkColumnNames.map((pkName) => {
            const val = originalValues[pkName];
            return val && val.trim() !== "" ? val : null;
        });

        setIsSaving(true);
        setError(null);

        try {
            await dbUpdateTableRow(connectionId, schema, table, pkColumnNames, pkValues, updates);
            toast.success("Row updated successfully");
            onSaveSuccess();
            onClose();
        } catch (err) {
            setError(String(err));
            toast.error("Failed to update row");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="absolute top-0 right-0 bottom-0 w-[400px] bg-card border-l border-border/40 shadow-2xl z-50 flex flex-col translate-x-0 transition-transform duration-300 ease-in-out">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20 shrink-0">
                <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-emerald-500" />
                    <h3 className="font-semibold text-sm">Edit Row</h3>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onClose}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1 p-4">
                {error && (
                    <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{error}</span>
                    </div>
                )}
                
                <div className="space-y-4">
                    {columns.map((col) => {
                        const isPk = pkColumnNames.includes(col.name);
                        const colInfo = tableColumnsInfo?.find(c => c.name === col.name);
                        const isNullable = colInfo?.is_nullable ?? true;
                        
                        return (
                            <div key={col.name} className="space-y-1.5">
                                <Label className="text-xs flex items-center gap-2">
                                    <span className={isPk ? "text-amber-500 font-semibold" : "text-foreground"}>
                                        {col.name}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/60 font-mono font-normal">
                                        {col.data_type}
                                    </span>
                                    {isPk && (
                                        <span className="text-[9px] uppercase tracking-wider bg-amber-500/10 text-amber-500 px-1.5 rounded-sm">
                                            PK
                                        </span>
                                    )}
                                    {!isNullable && !isPk && (
                                        <span className="text-[10px] text-destructive/70">*</span>
                                    )}
                                </Label>
                                <Input
                                    value={editValues[col.name] ?? ""}
                                    onChange={(e) => setEditValues(prev => ({ ...prev, [col.name]: e.target.value }))}
                                    className="h-8 text-xs font-mono bg-background focus-visible:ring-emerald-500/50"
                                    placeholder={isNullable ? "NULL" : ""}
                                />
                            </div>
                        );
                    })}
                </div>
            </ScrollArea>

            <div className="p-4 border-t border-border/20 bg-muted/10 shrink-0 flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={isSaving}>
                    Cancel
                </Button>
                <Button 
                    size="sm" 
                    onClick={handleSave} 
                    disabled={!hasChanges || isSaving}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                >
                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Save Changes
                </Button>
            </div>
        </div>
    );
}
