"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { QueryResult, CellValue } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import type { ColumnInfo } from "@/lib/types";
import { VirtualizedQueryResultTable } from "@/components/virtualized-query-result-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckCircle2, Clock, Copy, Download, FileText, Braces, Columns, LayoutGrid, ChevronDown, Check, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { dbGetColumns, dbUpdateTableRow } from "@/lib/tauri";
import { formatDbError } from "@/lib/db-errors";
import { getDateTimeMode } from "@/lib/date-time";
import { DateTimeInput } from "@/components/date-time-input";

function getDisplayCount(result: QueryResult): number {
    return result.row_count ?? result.rows?.length ?? 0;
}

function getRowCountLabel(result: QueryResult): string {
    const n = getDisplayCount(result);
    if (n === 1) return "1 row returned";
    return `${n.toLocaleString()} rows returned`;
}

/** Build a QueryResult with only visible columns (for export/copy). */
function filterResultToVisible(
    result: QueryResult,
    visibleIndexes: number[]
): QueryResult {
    const columns = visibleIndexes.map((i) => result.columns[i]);
    const rows = result.rows.map((row) => visibleIndexes.map((i) => row[i] ?? { type: "Null" as const }));
    return {
        ...result,
        columns,
        rows,
        row_count: rows.length,
    };
}

function resultToJSON(result: QueryResult): string {
    const rows = result.rows.map((row) =>
        Object.fromEntries(
            result.columns.map((col, i) => {
                const cell = row[i] ?? { type: "Null" as const };
                if (cell.type === "Null") return [col.name, null];
                if (["Bool", "Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                    return [col.name, cell.value];
                if (cell.type === "Json") return [col.name, cell.value];
                return [col.name, formatCellValue(cell)];
            })
        )
    );
    return JSON.stringify(rows, null, 2);
}

// ── Edit helpers (aligned with data-table) ─────────────────────────────────
function cellToEditValue(cell: CellValue): string {
    if (cell.type === "Null") return "";
    return formatCellValue(cell);
}

function getRowKey(row: CellValue[], columns: { name: string }[], pkColumns: string[]): string {
    if (pkColumns.length === 0) return "";
    return pkColumns
        .map((name) => {
            const i = columns.findIndex((c) => c.name === name);
            return i >= 0 ? formatCellValue(row[i] ?? { type: "Null" }) : "";
        })
        .join("\t");
}

function getRowPkValues(row: CellValue[], columns: { name: string }[], pkColumns: string[]): (string | null)[] {
    return pkColumns.map((name) => {
        const i = columns.findIndex((c) => c.name === name);
        if (i < 0) return null;
        const cell = row[i];
        if (!cell || cell.type === "Null") return null;
        return formatCellValue(cell);
    });
}

function validateCell(value: string, dataType: string, isNullable: boolean, enumLabels?: string[] | null): string | null {
    const t = dataType.toLowerCase();
    const trimmed = value.trim();
    if (trimmed === "") return isNullable ? null : "Required";
    if (enumLabels?.length) {
        if (!enumLabels.includes(trimmed)) return `Must be one of: ${enumLabels.slice(0, 8).join(", ")}${enumLabels.length > 8 ? "…" : ""}`;
        return null;
    }
    if (t.includes("int") || t.includes("serial")) {
        const n = Number(trimmed);
        if (Number.isNaN(n) || !Number.isInteger(n)) return "Invalid integer";
    }
    if (t.includes("numeric") || t.includes("decimal") || t.includes("float") || t.includes("real")) {
        if (Number.isNaN(Number(trimmed))) return "Invalid number";
    }
    if (t === "boolean" || t === "bool") {
        if (!["true", "false", "yes", "no", "1", "0"].includes(trimmed.toLowerCase())) return "Invalid boolean";
    }
    if (t === "uuid" && !/^[0-9a-f-]{36}$/i.test(trimmed)) return "Invalid UUID";
    return null;
}

// ── Editable result table ──────────────────────────────────────────────────
function EditableResultTable({
    result,
    connectionId,
    schema,
    table,
    tableColumns,
    onSaveSuccess,
}: {
    result: QueryResult;
    connectionId: string;
    schema: string;
    table: string;
    tableColumns: ColumnInfo[];
    onSaveSuccess: () => void;
}) {
    const pkColumnNames = useMemo(
        () => tableColumns.filter((c) => c.is_primary_key).map((c) => c.name),
        [tableColumns]
    );
    const [editingCell, setEditingCell] = useState<{ rowKey: string; colName: string; originalValue: string } | null>(null);
    const [editingValue, setEditingValue] = useState("");
    const [cellError, setCellError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const preventBlurSaveRef = useRef(false);

    const saveCellEdit = useCallback(
        async (source: "blur" | "explicit") => {
            if (source === "blur" && preventBlurSaveRef.current) return;
            if (!editingCell || !connectionId || !result || !tableColumns.length) {
                setEditingCell(null);
                return;
            }
            const { rowKey, colName, originalValue } = editingCell;
            if (editingValue === originalValue) {
                setEditingCell(null);
                setEditingValue("");
                setCellError(null);
                return;
            }
            const col = result.columns.find((c) => c.name === colName);
            const colInfo = tableColumns.find((c) => c.name === colName);
            if (col) {
                const err = validateCell(editingValue, col.data_type, colInfo?.is_nullable ?? true, col.enum_labels ?? undefined);
                if (err) {
                    setCellError(err);
                    return;
                }
            }
            setCellError(null);
            const row = result.rows.find((r) => getRowKey(r, result.columns, pkColumnNames) === rowKey);
            if (!row) {
                setEditingCell(null);
                return;
            }
            setIsSaving(true);
            try {
                const pkValues = getRowPkValues(row, result.columns, pkColumnNames);
                const value = editingValue.trim() === "" ? null : editingValue.trim();
                await dbUpdateTableRow(connectionId, schema, table, pkColumnNames, pkValues, [{ column: colName, value }]);
                setEditingCell(null);
                setEditingValue("");
                toast.success(`${colName} updated`, { duration: 1500 });
                onSaveSuccess();
            } catch (e) {
                const err = formatDbError(e, "update");
                toast.error(err.title, { description: err.description });
            } finally {
                setIsSaving(false);
            }
        },
        [editingCell, editingValue, connectionId, schema, table, result, tableColumns, pkColumnNames, onSaveSuccess]
    );

    const armBlurGuard = useCallback((delay = 80) => {
        preventBlurSaveRef.current = true;
        setTimeout(() => { preventBlurSaveRef.current = false; }, delay);
    }, []);

    const cancelCellEdit = useCallback(() => {
        setEditingCell(null);
        setEditingValue("");
        setCellError(null);
        armBlurGuard();
    }, [armBlurGuard]);

    const rows = result.rows;
    const cols = result.columns;

    return (
        <div className="flex-1 min-h-0 overflow-auto border-t border-border [scrollbar-width:thin]">
            {isSaving && (
                <div className="sticky top-0 z-30 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="animate-pulse">Saving…</span>
                </div>
            )}
            <Table role="grid" className="w-full border-0">
                <TableHeader>
                    <TableRow className="hover:bg-transparent border-border bg-muted sticky top-0 z-10">
                        <TableHead className="w-12 px-2 text-center text-[10px] font-mono text-muted-foreground/60 border-r border-border/40 sticky left-0 bg-muted z-20">
                            #
                        </TableHead>
                        {cols.map((col) => (
                            <TableHead key={col.name} className="px-3 py-2 text-xs font-semibold whitespace-nowrap border-r border-border/40 last:border-r-0 min-w-[140px]">
                                <span className="truncate">{col.name}</span>
                                <span className="text-[10px] font-mono text-muted-foreground/50 ml-1">({col.data_type})</span>
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row, rowIdx) => {
                        const rowKey = getRowKey(row, cols, pkColumnNames);
                        const isRowEditing = editingCell?.rowKey === rowKey;
                        return (
                            <TableRow
                                key={rowKey || rowIdx}
                                className={cn(
                                    "border-border/40 transition-colors",
                                    isRowEditing ? "bg-primary/5" : "hover:bg-accent/20"
                                )}
                            >
                                <TableCell className="text-center text-[10px] font-mono text-muted-foreground/50 px-2 border-r border-border/40 sticky left-0 z-10 bg-background w-12 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]">
                                    {rowIdx + 1}
                                </TableCell>
                                {cols.map((col, colIdx) => {
                                    const cell = row[colIdx] ?? { type: "Null" as const };
                                    const colInfo = tableColumns.find((c) => c.name === col.name);
                                    const isThisCellEditing = editingCell?.rowKey === rowKey && editingCell?.colName === col.name;

                                    if (isThisCellEditing) {
                                        const enumLabels = col.enum_labels?.length ? col.enum_labels : null;
                                        const isNullable = colInfo?.is_nullable ?? true;
                                        const lowerType = col.data_type.toLowerCase();
                                        const isBoolType = lowerType === "bool" || lowerType === "boolean";
                                        const dateTimeMode = getDateTimeMode(col.data_type);
                                        const selectValue = editingValue === "" ? "__null__" : editingValue;
                                        return (
                                            <TableCell
                                                key={col.name}
                                                className={cn(
                                                    "p-0 align-middle min-w-[160px] relative z-20 outline outline-2 outline-offset-[-2px] bg-background shadow-md",
                                                    cellError ? "outline-destructive" : "outline-emerald-500"
                                                )}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <div className="flex items-center w-full">
                                                    <div className="flex-1 min-w-0">
                                                        {enumLabels ? (
                                                            <Select
                                                                value={selectValue}
                                                                onValueChange={(v) => { setEditingValue(v === "__null__" ? "" : v); setCellError(null); }}
                                                                onOpenChange={(open) => { if (!open) { armBlurGuard(); void saveCellEdit("explicit"); } }}
                                                            >
                                                                <SelectTrigger className="h-9 px-3 text-xs font-mono w-full border-0 focus-visible:ring-0 rounded-none shadow-none bg-transparent" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancelCellEdit(); } }}>
                                                                    <SelectValue placeholder="—" />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    {isNullable && <SelectItem value="__null__">—</SelectItem>}
                                                                    {enumLabels.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                                                                </SelectContent>
                                                            </Select>
                                                        ) : isBoolType ? (
                                                            <Select
                                                                value={selectValue}
                                                                onValueChange={(v) => { setEditingValue(v === "__null__" ? "" : v); setCellError(null); }}
                                                                onOpenChange={(open) => { if (!open) { armBlurGuard(); void saveCellEdit("explicit"); } }}
                                                            >
                                                                <SelectTrigger className="h-9 px-3 text-xs font-mono w-full border-0 focus-visible:ring-0 rounded-none shadow-none bg-transparent" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancelCellEdit(); } }}>
                                                                    <SelectValue placeholder="—" />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    {isNullable && <SelectItem value="__null__">—</SelectItem>}
                                                                    <SelectItem value="true">true</SelectItem>
                                                                    <SelectItem value="false">false</SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                        ) : dateTimeMode ? (
                                                            <DateTimeInput
                                                                value={editingValue}
                                                                mode={dateTimeMode}
                                                                onChange={(v) => { setEditingValue(v); setCellError(null); }}
                                                                onBlur={() => saveCellEdit("blur")}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter") { e.preventDefault(); armBlurGuard(); void saveCellEdit("explicit"); }
                                                                    if (e.key === "Escape") { e.preventDefault(); cancelCellEdit(); }
                                                                }}
                                                                open={datePickerOpen}
                                                                onOpenChange={(open) => { setDatePickerOpen(open); if (!open) { armBlurGuard(); void saveCellEdit("explicit"); } }}
                                                                inputClassName="h-9 px-3 text-xs font-mono w-full border-0 focus-visible:ring-0 rounded-none shadow-none bg-transparent"
                                                            />
                                                        ) : (
                                                            <Input
                                                                autoFocus
                                                                value={editingValue}
                                                                onChange={(e) => { setEditingValue(e.target.value); setCellError(null); }}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter") { e.preventDefault(); armBlurGuard(); void saveCellEdit("explicit"); }
                                                                    if (e.key === "Escape") { e.preventDefault(); cancelCellEdit(); }
                                                                }}
                                                                onBlur={() => saveCellEdit("blur")}
                                                                className="h-9 px-3 text-xs font-mono w-full border-0 focus-visible:ring-0 rounded-none shadow-none bg-transparent"
                                                            />
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-0.5 pr-1">
                                                        <button type="button" onMouseDown={(e) => { e.preventDefault(); armBlurGuard(); void saveCellEdit("explicit"); }} className="shrink-0 p-1.5 rounded-sm text-emerald-500/80 hover:text-emerald-500 hover:bg-emerald-500/15" title="Save (Enter)"><Check className="h-4 w-4" /></button>
                                                        <button type="button" onMouseDown={(e) => { e.preventDefault(); cancelCellEdit(); }} className="shrink-0 p-1.5 rounded-sm text-muted-foreground/50 hover:text-destructive hover:bg-destructive/15" title="Cancel (Esc)"><X className="h-4 w-4" /></button>
                                                    </div>
                                                </div>
                                                {cellError && (
                                                    <div className="absolute top-[calc(100%+4px)] left-0 z-50 bg-destructive/90 text-destructive-foreground text-[11px] font-medium px-2 py-1.5 rounded shadow-lg whitespace-nowrap">{cellError}</div>
                                                )}
                                            </TableCell>
                                        );
                                    }

                                    const formatted = formatCellValue(cell);
                                    const isNull = cell.type === "Null";
                                    return (
                                        <TableCell
                                            key={col.name}
                                            className={cn(
                                                "text-xs font-mono max-w-[280px] truncate px-3 py-1.5 cursor-text hover:bg-muted/20 group/cell border-r border-border/40",
                                                isNull && "text-muted-foreground/30 italic"
                                            )}
                                            title={isNull ? "NULL" : formatted}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                preventBlurSaveRef.current = false;
                                                setEditingCell({ rowKey, colName: col.name, originalValue: cellToEditValue(cell) });
                                                setEditingValue(cellToEditValue(cell));
                                                setCellError(null);
                                            }}
                                        >
                                            <div className="flex items-center gap-1 min-w-0">
                                                <span className="truncate flex-1">{formatted}</span>
                                                <button
                                                    type="button"
                                                    className="shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity p-1 rounded hover:bg-muted/60"
                                                    onClick={(e) => { e.stopPropagation(); preventBlurSaveRef.current = false; setEditingCell({ rowKey, colName: col.name, originalValue: cellToEditValue(cell) }); setEditingValue(cellToEditValue(cell)); setCellError(null); }}
                                                    title={`Edit ${col.name}`}
                                                >
                                                    <Pencil className="h-3 w-3 text-muted-foreground/60" />
                                                </button>
                                            </div>
                                        </TableCell>
                                    );
                                })}
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

export interface QueryResultViewProps {
    result: QueryResult;
    onExport: (format: "csv" | "json", resultOverride?: QueryResult) => void;
    connectionId?: string | null;
    editableTable?: { schema: string; table: string };
    onRefresh?: () => void;
    className?: string;
}

export function QueryResultView({ result, onExport, connectionId, editableTable, onRefresh, className }: QueryResultViewProps) {
    const [dataViewMode, setDataViewMode] = useState<"table" | "json">("table");
    const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
    const [columnSearch, setColumnSearch] = useState("");
    const [tableColumns, setTableColumns] = useState<ColumnInfo[] | null>(null);

    useEffect(() => {
        if (!connectionId || !editableTable) {
            setTableColumns(null);
            return;
        }
        dbGetColumns(connectionId, editableTable.schema, editableTable.table)
            .then(setTableColumns)
            .catch(() => setTableColumns(null));
    }, [connectionId, editableTable?.schema, editableTable?.table]);

    const pkColumnNames = useMemo(
        () => (tableColumns?.filter((c) => c.is_primary_key).map((c) => c.name) ?? []),
        [tableColumns]
    );
    const canEdit = Boolean(connectionId && editableTable && pkColumnNames.length > 0 && onRefresh);

    const columns = result.columns;
    const visibleColumnIndexes = useMemo(() => {
        return columns.reduce<number[]>((acc, col, idx) => {
            if (!hiddenColumns.has(col.name)) acc.push(idx);
            return acc;
        }, []);
    }, [columns, hiddenColumns]);

    const visibleResult = useMemo(() => filterResultToVisible(result, visibleColumnIndexes), [result, visibleColumnIndexes]);
    const visibleCount = visibleColumnIndexes.length;
    const hiddenColumnCount = Math.max(0, columns.length - visibleCount);

    const filteredColumns = useMemo(() => {
        const q = columnSearch.trim().toLowerCase();
        if (!q) return columns;
        return columns.filter(
            (c) => c.name.toLowerCase().includes(q) || (c.data_type?.toLowerCase().includes(q))
        );
    }, [columns, columnSearch]);

    useEffect(() => setColumnSearch(""), [result.query]);

    const setColumnVisibility = useCallback((name: string, visible: boolean) => {
        setHiddenColumns((prev) => {
            const next = new Set(prev);
            if (visible) next.delete(name);
            else next.add(name);
            return next;
        });
    }, []);

    const showAllColumns = useCallback(() => setHiddenColumns(new Set()), []);
    const hideAllColumns = useCallback(() => {
        if (columns.length) setHiddenColumns(new Set(columns.map((c) => c.name)));
    }, [columns]);

    const handleCopyTSV = useCallback(() => {
        const header = visibleResult.columns.map((c) => c.name).join("\t");
        const rows = visibleResult.rows.map((row) =>
            row.map((cell) => formatCellValue(cell)).join("\t")
        );
        navigator.clipboard.writeText([header, ...rows].join("\n"));
        toast.success("Copied as TSV", { duration: 1500 });
    }, [visibleResult]);

    const jsonString = useMemo(() => resultToJSON(visibleResult), [visibleResult]);

    const hasRows = result.rows.length > 0;
    const rowLabel = getRowCountLabel(result);

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            {/* Toolbar — same style as Data tab */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs font-medium text-foreground/90">{rowLabel}</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono gap-1 border-emerald-500/20 text-emerald-400/80">
                        <Clock className="h-2.5 w-2.5" />
                        {result.execution_time_ms.toFixed(1)}ms
                    </Badge>
                    {canEdit && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                            <Pencil className="h-2.5 w-2.5" />
                            Editable
                        </Badge>
                    )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                                onClick={handleCopyTSV}
                                disabled={!hasRows}
                            >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy as TSV</TooltipContent>
                    </Tooltip>

                    <DropdownMenu>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 gap-1 text-muted-foreground hover:text-foreground text-xs"
                                        disabled={!hasRows}
                                    >
                                        <Download className="h-3.5 w-3.5" />
                                        <ChevronDown className="h-2.5 w-2.5" />
                                    </Button>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>Export data</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                                onClick={() => onExport("csv", visibleResult)}
                                className="gap-2 text-xs"
                            >
                                <FileText className="h-3.5 w-3.5" />
                                Download as CSV
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => onExport("json", visibleResult)}
                                className="gap-2 text-xs"
                            >
                                <Braces className="h-3.5 w-3.5" />
                                Download as JSON
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <Popover>
                        <PopoverTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                                disabled={columns.length === 0}
                            >
                                <Columns className="h-3.5 w-3.5" />
                                Columns
                                {hiddenColumnCount > 0 && (
                                    <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-muted/60 px-1 text-[9px] font-bold text-foreground/70">
                                        {hiddenColumnCount}
                                    </span>
                                )}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-72 p-0">
                            <div className="px-3 py-2 border-b border-border/40">
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-semibold text-foreground/80">Columns</span>
                                    <span className="text-[10px] text-muted-foreground/60">
                                        {visibleCount}/{columns.length} visible
                                    </span>
                                </div>
                                <Input
                                    value={columnSearch}
                                    onChange={(e) => setColumnSearch(e.target.value)}
                                    placeholder="Search columns…"
                                    className="mt-2 h-7 text-xs"
                                />
                            </div>
                            <ScrollArea className="h-56">
                                <div className="py-1">
                                    {filteredColumns.length === 0 ? (
                                        <div className="px-3 py-6 text-xs text-muted-foreground/60 text-center">
                                            No columns found
                                        </div>
                                    ) : (
                                        filteredColumns.map((col) => {
                                            const isVisible = !hiddenColumns.has(col.name);
                                            return (
                                                <label
                                                    key={col.name}
                                                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer"
                                                >
                                                    <Checkbox
                                                        checked={isVisible}
                                                        onCheckedChange={(v) => setColumnVisibility(col.name, v === true)}
                                                    />
                                                    <span className="font-mono text-xs text-foreground/90 truncate flex-1">
                                                        {col.name}
                                                    </span>
                                                    {col.data_type && (
                                                        <span className="text-[9px] text-muted-foreground/50 font-mono">
                                                            {col.data_type}
                                                        </span>
                                                    )}
                                                </label>
                                            );
                                        })
                                    )}
                                </div>
                            </ScrollArea>
                            <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
                                <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
                                    onClick={showAllColumns}
                                >
                                    Show all
                                </button>
                                <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
                                    onClick={hideAllColumns}
                                >
                                    Hide all
                                </button>
                            </div>
                        </PopoverContent>
                    </Popover>

                    <div className="flex rounded-lg bg-muted/40 p-0.5 border border-border/20">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={() => setDataViewMode("table")}
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                                        dataViewMode === "table"
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    <LayoutGrid className="h-3 w-3" />
                                    Table
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Table view</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={() => setDataViewMode("json")}
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                                        dataViewMode === "json"
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    <Braces className="h-3 w-3" />
                                    JSON
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>JSON view</TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            </div>

            {/* Body */}
            {dataViewMode === "json" ? (
                <div className="flex-1 min-h-0 overflow-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40">
                    <div className="p-4 flex items-start justify-between gap-2">
                        <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre overflow-x-auto flex-1 min-w-0 rounded-lg bg-muted/20 border border-border/30 p-4">
                            <code>{jsonString}</code>
                        </pre>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 shrink-0"
                                    onClick={() => {
                                        navigator.clipboard.writeText(jsonString);
                                        toast.success("JSON copied", { duration: 1500 });
                                    }}
                                >
                                    <Copy className="h-3.5 w-3.5 mr-1.5" />
                                    Copy
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy JSON</TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            ) : visibleCount === 0 && !canEdit ? (
                <div className="flex-1 flex items-center justify-center p-8 text-center">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground/80">All columns hidden</p>
                        <p className="text-xs mt-1 text-muted-foreground/50">Use the Columns menu to show fields.</p>
                        <Button type="button" size="sm" variant="outline" className="mt-3 h-7 text-xs" onClick={showAllColumns}>
                            Show all columns
                        </Button>
                    </div>
                </div>
            ) : canEdit && dataViewMode === "table" && tableColumns && connectionId && editableTable && onRefresh ? (
                <EditableResultTable
                    result={result}
                    connectionId={connectionId}
                    schema={editableTable.schema}
                    table={editableTable.table}
                    tableColumns={tableColumns}
                    onSaveSuccess={onRefresh}
                />
            ) : (
                <div className="flex-1 min-h-0 overflow-hidden">
                    <VirtualizedQueryResultTable result={visibleResult} showRowIndex className="h-full" />
                </div>
            )}
        </div>
    );
}
