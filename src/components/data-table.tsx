"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import {
    dbGetTableData,
    dbGetFunctionDefinition,
    dbGetTypeDefinition,
    dbGetColumns,
    dbUpdateTableRow,
    dbDeleteTableRows,
} from "@/lib/tauri";
import { formatCellValue } from "@/lib/types";
import type {
    QueryResult,
    TypeDefinitionDetail,
    PreviewSelection,
    EventTriggerInfo,
    CellValue,
    ColumnInfo,
} from "@/lib/types";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    ArrowUp,
    ArrowDown,
    ArrowUpDown,
    Table2,
    Clock,
    Rows3,
    Loader2,
    RefreshCw,
    AlertCircle,
    Copy,
    Code2,
    Type,
    Zap,
    Braces,
    LayoutGrid,
    Save,
    Trash2,
    GalleryVerticalEnd,
    Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** Convert a cell to a JSON-serializable value for JSON view (preserves null, number, boolean). */
function cellToJsonValue(cell: CellValue): unknown {
    if (cell.type === "Null") return null;
    if (cell.type === "Bool" || cell.type === "Int16" || cell.type === "Int32" || cell.type === "Int64" || cell.type === "Float32" || cell.type === "Float64") return cell.value;
    if (cell.type === "String" || cell.type === "DateTime" || cell.type === "Date" || cell.type === "Time" || cell.type === "Uuid") return cell.value ?? "";
    if (cell.type === "Json") return cell.value;
    if (cell.type === "Bytes") return "[bytes]";
    return cell.value ?? null;
}

/** Cell to string for edit input; null -> "". */
function cellToEditValue(cell: CellValue): string {
    if (cell.type === "Null") return "";
    return formatCellValue(cell);
}

/** Cell to string | null for API (null stays null). */
function cellToApiValue(cell: CellValue): string | null {
    if (cell.type === "Null") return null;
    return formatCellValue(cell);
}

/** Stable row key from PK values for selection/edit. */
function getRowKey(
    row: CellValue[],
    columns: { name: string }[],
    pkColumns: string[]
): string {
    if (pkColumns.length === 0) return "";
    return pkColumns
        .map((name) => {
            const i = columns.findIndex((c) => c.name === name);
            return i >= 0 ? formatCellValue(row[i] ?? { type: "Null" }) : "";
        })
        .join("\t");
}

/** PK values for a row (for update/delete API). */
function getRowPkValues(
    row: CellValue[],
    columns: { name: string }[],
    pkColumns: string[]
): (string | null)[] {
    return pkColumns.map((name) => {
        const i = columns.findIndex((c) => c.name === name);
        return i >= 0 ? cellToApiValue(row[i] ?? { type: "Null" }) : null;
    });
}

/** Validate edit value by data type. Returns error message or null. */
function validateCell(
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

const BATCH_SIZE = 30;

export function DataTable() {
    const {
        connectionId,
        selectedSchema,
        selectedTable,
        previewSelection,
        eventTriggers,
    } = useConnectionStore();

    // ── Core data ─────────────────────────────────────────────────────────────
    const [result, setResult] = useState<QueryResult | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Scroll / pagination mode ──────────────────────────────────────────────
    const [scrollMode, setScrollMode] = useState<"infinite" | "pagination">("infinite");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(BATCH_SIZE);
    const [sortColumn, setSortColumn] = useState<string | null>(null);
    const [sortDirection, setSortDirection] = useState<"ASC" | "DESC">("ASC");
    const [dataViewMode, setDataViewMode] = useState<"table" | "json">("table");

    // ── Infinite scroll state ─────────────────────────────────────────────────
    const [accumulatedRows, setAccumulatedRows] = useState<CellValue[][]>([]);
    const [nextFetchPage, setNextFetchPage] = useState(2);
    const [hasMore, setHasMore] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    // ── Refs ──────────────────────────────────────────────────────────────────
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    // Stable ref to fetchMore so observers never become stale
    const fetchMoreRef = useRef<() => void>(() => {});

    // ── Editing state ─────────────────────────────────────────────────────────
    const [tableColumns, setTableColumns] = useState<ColumnInfo[] | null>(null);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set());
    const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
    const [editingDraft, setEditingDraft] = useState<Record<string, string>>({});
    const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
    const [isSaving, setIsSaving] = useState(false);

    // ── Display rows (unified) ────────────────────────────────────────────────
    const displayRows = useMemo(
        () => (scrollMode === "infinite" ? accumulatedRows : (result?.rows ?? [])),
        [scrollMode, accumulatedRows, result]
    );

    // ── Initial / full fetch ──────────────────────────────────────────────────
    const fetchData = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable) return;
        setIsLoading(true);
        setError(null);
        setAccumulatedRows([]);
        setHasMore(false);
        setNextFetchPage(2);
        try {
            const batchSize = scrollMode === "infinite" ? BATCH_SIZE : pageSize;
            const p = scrollMode === "infinite" ? 1 : page;
            const data = await dbGetTableData(
                connectionId, selectedSchema, selectedTable,
                p, batchSize, sortColumn ?? undefined, sortDirection
            );
            setResult(data);
            if (scrollMode === "infinite") {
                setAccumulatedRows(data.rows);
                const total = data.total_rows ?? 0;
                setHasMore(data.rows.length > 0 && data.rows.length < total);
            }
        } catch (err) {
            const msg = String(err);
            setError(msg.replace(/^[a-z_]+:\s*/i, "").trim() || "Failed to load table data.");
            setResult(null);
        } finally {
            setIsLoading(false);
        }
    }, [connectionId, selectedSchema, selectedTable, page, pageSize, sortColumn, sortDirection, scrollMode]);

    // ── Incremental fetch for infinite scroll ─────────────────────────────────
    const fetchMore = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable) return;
        if (!hasMore || isLoadingMore || isLoading) return;
        setIsLoadingMore(true);
        try {
            const data = await dbGetTableData(
                connectionId, selectedSchema, selectedTable,
                nextFetchPage, BATCH_SIZE, sortColumn ?? undefined, sortDirection
            );
            if (data.rows.length === 0) { setHasMore(false); return; }
            setAccumulatedRows((prev) => {
                const merged = [...prev, ...data.rows];
                setHasMore(merged.length < (data.total_rows ?? 0));
                return merged;
            });
            setNextFetchPage((p) => p + 1);
        } catch {
            // silent — don't interrupt the user
        } finally {
            setIsLoadingMore(false);
        }
    }, [connectionId, selectedSchema, selectedTable, hasMore, isLoadingMore, isLoading, nextFetchPage, sortColumn, sortDirection]);

    // Keep the ref in sync with the latest fetchMore closure
    useEffect(() => { fetchMoreRef.current = fetchMore; }, [fetchMore]);

    // ── IntersectionObserver: load more when sentinel enters view ─────────────
    useEffect(() => {
        if (scrollMode !== "infinite") return;
        const container = scrollContainerRef.current;
        const sentinel = sentinelRef.current;
        if (!container || !sentinel) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry?.isIntersecting) fetchMoreRef.current(); },
            { root: container, rootMargin: "250px", threshold: 0 }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    // Re-attach after initial load so sentinel is part of the DOM
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scrollMode, isLoading]);

    // ── Auto-fill viewport when initial batch is shorter than the container ───
    useEffect(() => {
        if (scrollMode !== "infinite" || isLoading || isLoadingMore || !hasMore) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        if (container.scrollHeight <= container.clientHeight + 100) {
            fetchMoreRef.current();
        }
    }, [scrollMode, isLoading, isLoadingMore, hasMore, accumulatedRows.length]);

    // ── Reset on table / schema change ────────────────────────────────────────
    useEffect(() => {
        setPage(1);
        setSortColumn(null);
        setResult(null);
        setError(null);
        setTableColumns(null);
        setSelectedRowKeys(new Set());
        setEditingRowKey(null);
        setEditingDraft({});
        setValidationErrors({});
        setAccumulatedRows([]);
        setHasMore(false);
        setNextFetchPage(2);
    }, [selectedTable, selectedSchema]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // ── Column metadata for edit/delete ───────────────────────────────────────
    const isTableNotView =
        previewSelection?.kind === "table" || previewSelection?.kind === "view"
            ? previewSelection.kind === "table"
            : false;

    useEffect(() => {
        if (!connectionId || !selectedSchema || !selectedTable || !isTableNotView) return;
        dbGetColumns(connectionId, selectedSchema, selectedTable)
            .then(setTableColumns)
            .catch(() => setTableColumns(null));
    }, [connectionId, selectedSchema, selectedTable, isTableNotView]);

    const pkColumnNames = useMemo(
        () => (tableColumns?.filter((c) => c.is_primary_key).map((c) => c.name) ?? []),
        [tableColumns]
    );
    const canEditDelete = isTableNotView && pkColumnNames.length > 0;

    // ── Save edit ─────────────────────────────────────────────────────────────
    const handleSaveEdit = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable || !result || !editingRowKey || !tableColumns) return;
        const rowIdx = displayRows.findIndex(
            (row) => getRowKey(row, result!.columns, pkColumnNames) === editingRowKey
        );
        if (rowIdx < 0) return;
        const row = displayRows[rowIdx];
        const colByName = Object.fromEntries(tableColumns.map((c) => [c.name, c]));
        const updates: { column: string; value: string | null }[] = [];
        const errs: Record<string, string> = {};
        for (let i = 0; i < result.columns.length; i++) {
            const col = result.columns[i];
            const draftVal = editingDraft[col.name];
            if (draftVal === undefined) continue;
            const original = cellToEditValue(row[i] ?? { type: "Null" });
            if (draftVal === original) continue;
            const info = colByName[col.name];
            const err = validateCell(draftVal, col.data_type, info?.is_nullable ?? true);
            if (err) errs[col.name] = err;
            else updates.push({ column: col.name, value: draftVal.trim() === "" ? null : draftVal.trim() });
        }
        if (Object.keys(errs).length > 0) { setValidationErrors(errs); return; }
        if (updates.length === 0) { setEditingRowKey(null); setEditingDraft({}); return; }
        setValidationErrors({});
        setIsSaving(true);
        try {
            const pkValues = getRowPkValues(row, result.columns, pkColumnNames);
            await dbUpdateTableRow(connectionId, selectedSchema, selectedTable, pkColumnNames, pkValues, updates);
            setEditingRowKey(null);
            setEditingDraft({});
            toast.success("Row saved");
            fetchData();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setIsSaving(false);
        }
    }, [connectionId, selectedSchema, selectedTable, result, editingRowKey, editingDraft, tableColumns, pkColumnNames, fetchData, displayRows]);

    // ── Delete selected ───────────────────────────────────────────────────────
    const handleDeleteSelected = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable || !result) return;
        const rowsToDelete = displayRows.filter((row) =>
            selectedRowKeys.has(getRowKey(row, result!.columns, pkColumnNames))
        );
        if (rowsToDelete.length === 0) return;
        if (!confirm(`Delete ${rowsToDelete.length} row(s)? This cannot be undone.`)) return;
        const rowsPkValues = rowsToDelete.map((row) => getRowPkValues(row, result!.columns, pkColumnNames));
        try {
            const n = await dbDeleteTableRows(connectionId, selectedSchema, selectedTable, pkColumnNames, rowsPkValues);
            setSelectedRowKeys(new Set());
            toast.success(`${n} row(s) deleted`);
            fetchData();
        } catch (e) {
            toast.error(String(e));
        }
    }, [connectionId, selectedSchema, selectedTable, result, selectedRowKeys, pkColumnNames, fetchData, displayRows]);

    // ── Cmd+Enter to save ─────────────────────────────────────────────────────
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && editingRowKey && canEditDelete) {
                e.preventDefault();
                handleSaveEdit();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [editingRowKey, canEditDelete, handleSaveEdit]);

    const totalPages = result?.total_rows ? Math.ceil(result.total_rows / pageSize) : 1;

    const handleSort = (column: string) => {
        if (sortColumn === column) setSortDirection((d) => (d === "ASC" ? "DESC" : "ASC"));
        else { setSortColumn(column); setSortDirection("ASC"); }
        setPage(1);
    };

    const copyCell = (value: string) =>
        navigator.clipboard.writeText(value).then(() => toast.success("Copied to clipboard", { duration: 1500 }));

    /** JSON view (memoized) */
    const tableDataJsonString = useMemo(() => {
        if (!result || !result.columns.length) return "[]";
        return JSON.stringify(
            displayRows.map((row) =>
                Object.fromEntries(result!.columns.map((col, i) => [col.name, cellToJsonValue(row[i] ?? { type: "Null" })]))
            ),
            null, 2
        );
    }, [result, displayRows]);

    const isTableView = previewSelection?.kind === "table" || previewSelection?.kind === "view";

    // ── Empty / non-table states ──────────────────────────────────────────────
    if (!previewSelection) {
        return (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground select-none">
                <div className="flex flex-col items-center gap-3">
                    <div className="h-16 w-16 rounded-2xl bg-muted/20 flex items-center justify-center">
                        <Table2 className="h-8 w-8 opacity-20" />
                    </div>
                    <div className="text-center">
                        <p className="text-sm font-medium text-muted-foreground/70">Select an object</p>
                        <p className="text-xs mt-1 text-muted-foreground/40">
                            Choose a table, view, function, type, or event trigger from the sidebar
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (!isTableView) {
        return (
            <ObjectPreviewPanel
                connectionId={connectionId}
                previewSelection={previewSelection}
                eventTriggers={eventTriggers}
            />
        );
    }

    const tableSchema = previewSelection.kind === "table" || previewSelection.kind === "view" ? previewSelection.schema : "";
    const tableName = previewSelection.kind === "table" || previewSelection.kind === "view" ? previewSelection.name : "";

    if (error && !isLoading) {
        return (
            <div className="flex h-full flex-col">
                <TableToolbar
                    schema={tableSchema} table={tableName} result={null}
                    pageSize={pageSize} onPageSizeChange={(v) => { setPageSize(v); setPage(1); }}
                    onRefresh={fetchData} isLoading={false}
                    dataViewMode={dataViewMode} onDataViewModeChange={setDataViewMode}
                    scrollMode={scrollMode} onScrollModeChange={setScrollMode}
                />
                <div className="flex-1 flex items-center justify-center p-8">
                    <div className="max-w-md w-full rounded-xl bg-destructive/10 border border-destructive/20 p-6">
                        <div className="flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-semibold text-destructive">Failed to load data</p>
                                <p className="mt-1.5 text-xs font-mono text-destructive/70 leading-relaxed">{error}</p>
                                <Button size="sm" variant="outline"
                                    className="mt-4 h-8 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                                    onClick={fetchData}
                                >
                                    <RefreshCw className="h-3 w-3 mr-1.5" />
                                    Try Again
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <TableToolbar
                schema={tableSchema} table={tableName} result={result}
                pageSize={pageSize} onPageSizeChange={(v) => { setPageSize(v); setPage(1); }}
                onRefresh={fetchData} isLoading={isLoading}
                dataViewMode={dataViewMode} onDataViewModeChange={setDataViewMode}
                scrollMode={scrollMode} onScrollModeChange={setScrollMode}
                rowsLoaded={scrollMode === "infinite" ? accumulatedRows.length : undefined}
            />

            {/* Unsaved changes bar */}
            {canEditDelete && editingRowKey && dataViewMode === "table" && (() => {
                const rowIdx = displayRows.findIndex(
                    (row) => getRowKey(row, result!.columns, pkColumnNames) === editingRowKey
                );
                const hasChanges = rowIdx >= 0 && result?.columns.some((col, colIdx) => {
                    const draft = editingDraft[col.name];
                    if (draft === undefined) return false;
                    return draft !== cellToEditValue(displayRows[rowIdx]?.[colIdx] ?? { type: "Null" });
                });
                if (!hasChanges) return null;
                return (
                    <div className="flex items-center justify-between px-4 py-2 border-b border-emerald-500/30 bg-emerald-500/5 shrink-0">
                        <span className="text-xs text-emerald-600 dark:text-emerald-400">Unsaved changes</span>
                        <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-7 text-xs"
                                onClick={() => { setEditingRowKey(null); setEditingDraft({}); setValidationErrors({}); }}>
                                Cancel
                            </Button>
                            <Button size="sm" className="h-7 text-xs gap-1.5" onClick={handleSaveEdit} disabled={isSaving}>
                                <Save className="h-3 w-3" />Save (⌘↵)
                            </Button>
                        </div>
                    </div>
                );
            })()}

            {/* Delete bar */}
            {canEditDelete && selectedRowKeys.size > 0 && dataViewMode === "table" && (
                <div className="flex items-center justify-between px-4 py-2 border-b border-destructive/20 bg-destructive/5 shrink-0">
                    <span className="text-xs text-destructive/90">{selectedRowKeys.size} row(s) selected</span>
                    <Button variant="destructive" size="sm" className="h-7 text-xs gap-1.5" onClick={handleDeleteSelected}>
                        <Trash2 className="h-3 w-3" />Delete
                    </Button>
                </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-hidden relative">
                {dataViewMode === "json" ? (
                    <div className="h-full overflow-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40">
                        <div className="p-4 flex items-start justify-between gap-2">
                            <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre overflow-x-auto flex-1 min-w-0 rounded-lg bg-muted/20 border border-border/30 p-4">
                                <code>{tableDataJsonString}</code>
                            </pre>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="outline" size="sm" className="h-8 shrink-0"
                                        onClick={() => { navigator.clipboard.writeText(tableDataJsonString); toast.success("JSON copied", { duration: 1500 }); }}>
                                        <Copy className="h-3.5 w-3.5 mr-1.5" />Copy
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy JSON</TooltipContent>
                            </Tooltip>
                        </div>
                    </div>
                ) : (
                    <div
                        ref={scrollContainerRef}
                        className="h-full overflow-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent"
                    >
                        {isLoading && !result ? (
                            <div className="p-3 space-y-1.5">
                                <div className="flex gap-2 mb-3">
                                    {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-7 flex-1 rounded" />)}
                                </div>
                                {[...Array(12)].map((_, i) => <Skeleton key={i} className="h-7 w-full rounded" />)}
                            </div>
                        ) : result && result.columns.length > 0 ? (
                            <>
                                <Table>
                                    <TableHeader>
                                        <TableRow className="hover:bg-transparent border-border/20 bg-card/30 sticky top-0 z-10">
                                            {canEditDelete && (
                                                <TableHead className="w-10 px-2 sticky left-0 bg-card/80 backdrop-blur-sm z-20">
                                                    <input
                                                        type="checkbox"
                                                        className="h-3.5 w-3.5 rounded border-border"
                                                        checked={displayRows.length > 0 && displayRows.every((row) => selectedRowKeys.has(getRowKey(row, result.columns, pkColumnNames)))}
                                                        onChange={(e) => {
                                                            if (e.target.checked) setSelectedRowKeys(new Set(displayRows.map((row) => getRowKey(row, result.columns, pkColumnNames))));
                                                            else setSelectedRowKeys(new Set());
                                                        }}
                                                    />
                                                </TableHead>
                                            )}
                                            <TableHead className={cn("w-10 text-center text-[10px] font-mono text-muted-foreground/30 px-2 sticky bg-card/80 backdrop-blur-sm z-20", canEditDelete ? "left-9" : "left-0")}>
                                                #
                                            </TableHead>
                                            {result.columns.map((col) => (
                                                <TableHead
                                                    key={col.name}
                                                    className="cursor-pointer select-none group whitespace-nowrap px-3 py-2"
                                                    onClick={() => handleSort(col.name)}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-xs font-semibold text-foreground/80">{col.name}</span>
                                                        <span className="text-[9px] font-mono text-muted-foreground/30 hidden group-hover:inline">{col.data_type}</span>
                                                        {sortColumn === col.name ? (
                                                            sortDirection === "ASC"
                                                                ? <ArrowUp className="h-3 w-3 text-emerald-400 shrink-0" />
                                                                : <ArrowDown className="h-3 w-3 text-emerald-400 shrink-0" />
                                                        ) : (
                                                            <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-25 transition-opacity shrink-0" />
                                                        )}
                                                    </div>
                                                </TableHead>
                                            ))}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {displayRows.map((row, rowIdx) => {
                                            const rowKey = getRowKey(row, result.columns, pkColumnNames);
                                            const isEditing = canEditDelete && editingRowKey === rowKey;
                                            const isSelected = selectedRowKeys.has(rowKey);
                                            const rowNumber = scrollMode === "infinite"
                                                ? rowIdx + 1
                                                : (page - 1) * pageSize + rowIdx + 1;
                                            const startEdit = () => {
                                                if (!canEditDelete) return;
                                                setEditingRowKey(rowKey);
                                                const draft: Record<string, string> = {};
                                                result.columns.forEach((col, i) => { draft[col.name] = cellToEditValue(row[i] ?? { type: "Null" }); });
                                                setEditingDraft(draft);
                                                setValidationErrors({});
                                            };
                                            return (
                                                <TableRow
                                                    key={rowKey || rowIdx}
                                                    className={cn(
                                                        "border-border/10 transition-colors group",
                                                        isEditing && "bg-primary/5 ring-1 ring-primary/20",
                                                        !isEditing && "hover:bg-accent/20"
                                                    )}
                                                >
                                                    {canEditDelete && (
                                                        <TableCell className="px-2 sticky left-0 bg-background group-hover:bg-accent/20 z-10" onClick={(e) => e.stopPropagation()}>
                                                            <input
                                                                type="checkbox"
                                                                className="h-3.5 w-3.5 rounded border-border"
                                                                checked={isSelected}
                                                                onChange={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedRowKeys((prev) => {
                                                                        const next = new Set(prev);
                                                                        if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
                                                                        return next;
                                                                    });
                                                                }}
                                                            />
                                                        </TableCell>
                                                    )}
                                                    <TableCell className={cn("text-center text-[10px] font-mono text-muted-foreground/25 px-2 sticky bg-background group-hover:bg-accent/20 transition-colors z-10", canEditDelete ? "left-9" : "left-0")}>
                                                        {rowNumber}
                                                    </TableCell>
                                                    {row.map((cell, colIdx) => {
                                                        const col = result.columns[colIdx];
                                                        const colInfo = tableColumns?.find((c) => c.name === col.name);
                                                        if (isEditing) {
                                                            const val = editingDraft[col.name] ?? cellToEditValue(cell);
                                                            const err = validationErrors[col.name];
                                                            return (
                                                                <TableCell key={colIdx} className="p-1 align-top" onClick={(e) => e.stopPropagation()}>
                                                                    <Input
                                                                        value={val}
                                                                        onChange={(e) => {
                                                                            setEditingDraft((d) => ({ ...d, [col.name]: e.target.value }));
                                                                            if (validationErrors[col.name]) setValidationErrors((v) => { const n = { ...v }; delete n[col.name]; return n; });
                                                                        }}
                                                                        onBlur={() => {
                                                                            const e2 = validateCell(val, col.data_type, colInfo?.is_nullable ?? true);
                                                                            setValidationErrors((v) => (e2 ? { ...v, [col.name]: e2 } : (() => { const n = { ...v }; delete n[col.name]; return n; })()));
                                                                        }}
                                                                        className={cn("h-7 text-xs font-mono", err && "border-destructive")}
                                                                    />
                                                                    {err && <p className="text-[10px] text-destructive mt-0.5">{err}</p>}
                                                                </TableCell>
                                                            );
                                                        }
                                                        const formatted = formatCellValue(cell);
                                                        const isNull = cell.type === "Null";
                                                        return (
                                                            <TableCell
                                                                key={colIdx}
                                                                className={cn("text-xs font-mono max-w-[280px] truncate px-3 py-1.5 cursor-default", isNull && "text-muted-foreground/25 italic")}
                                                                title={isNull ? "NULL" : formatted}
                                                                onClick={(e) => {
                                                                    if (canEditDelete && !(e.target as HTMLElement).closest("input")) startEdit();
                                                                    else if (!isNull) copyCell(formatted);
                                                                }}
                                                            >
                                                                {formatted}
                                                            </TableCell>
                                                        );
                                                    })}
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>

                                {/* Sentinel — IntersectionObserver watches this */}
                                {scrollMode === "infinite" && (
                                    <div ref={sentinelRef} className="h-1 w-full" aria-hidden />
                                )}

                                {/* Loading more indicator */}
                                {scrollMode === "infinite" && isLoadingMore && (
                                    <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground/50">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        <span className="text-[11px]">Loading more…</span>
                                    </div>
                                )}

                                {/* End-of-data marker */}
                                {scrollMode === "infinite" && !hasMore && !isLoading && displayRows.length > 0 && (
                                    <div className="flex items-center justify-center py-3">
                                        <span className="text-[10px] text-muted-foreground/25 font-mono tabular-nums">
                                            {displayRows.length.toLocaleString()} rows total
                                        </span>
                                    </div>
                                )}
                            </>
                        ) : result && result.columns.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-muted-foreground py-20">
                                <div className="text-center">
                                    <p className="text-sm font-medium text-muted-foreground/60">Empty table</p>
                                    <p className="text-xs mt-1 text-muted-foreground/40">This table has no rows</p>
                                </div>
                            </div>
                        ) : null}
                    </div>
                )}

                {/* Refresh overlay */}
                {isLoading && result && (
                    <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px] flex items-center justify-center z-30">
                        <div className="flex items-center gap-2 bg-card/90 px-4 py-2.5 rounded-lg shadow-xl border border-border/40">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
                            <span className="text-xs font-medium">Loading…</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Pagination footer — only in pagination mode */}
            {scrollMode === "pagination" && result && result.total_rows !== null && result.total_rows > 0 && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-border/20 bg-card/20 shrink-0">
                    <p className="text-[11px] text-muted-foreground/60 font-mono tabular-nums">
                        {((page - 1) * pageSize + 1).toLocaleString()}–
                        {Math.min(page * pageSize, result.total_rows).toLocaleString()} of{" "}
                        {result.total_rows.toLocaleString()} rows
                    </p>
                    <div className="flex items-center gap-0.5">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(1)}>
                                    <ChevronsLeft className="h-3.5 w-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>First page</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Previous page</TooltipContent>
                        </Tooltip>
                        <span className="px-3 text-xs font-mono text-muted-foreground/70 tabular-nums">{page} / {totalPages}</span>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                                    <ChevronRight className="h-3.5 w-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Next page</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>
                                    <ChevronsRight className="h-3.5 w-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Last page</TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            )}
        </div>
    );
}

function TableToolbar({
    schema,
    table,
    result,
    pageSize,
    onPageSizeChange,
    onRefresh,
    isLoading,
    dataViewMode,
    onDataViewModeChange,
    scrollMode,
    onScrollModeChange,
    rowsLoaded,
}: {
    schema: string;
    table: string;
    result: QueryResult | null;
    pageSize: number;
    onPageSizeChange: (v: number) => void;
    onRefresh: () => void;
    isLoading: boolean;
    dataViewMode: "table" | "json";
    onDataViewModeChange: (v: "table" | "json") => void;
    scrollMode: "infinite" | "pagination";
    onScrollModeChange: (v: "infinite" | "pagination") => void;
    rowsLoaded?: number;
}) {
    const totalRows = result?.total_rows;
    const rowCountLabel = scrollMode === "infinite" && rowsLoaded !== undefined && totalRows != null
        ? `${rowsLoaded.toLocaleString()} / ${totalRows.toLocaleString()}`
        : totalRows?.toLocaleString() ?? "?";

    return (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/20 bg-card/30 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                    <Table2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span className="font-mono text-xs font-medium truncate">
                        <span className="text-muted-foreground">{schema}.</span>
                        <span className="text-foreground">{table}</span>
                    </span>
                </div>
                {result && (
                    <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono gap-1 bg-muted/40">
                            <Rows3 className="h-2.5 w-2.5" />
                            {rowCountLabel} rows
                        </Badge>
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono gap-1 border-emerald-500/20 text-emerald-400/80">
                            <Clock className="h-2.5 w-2.5" />
                            {result.execution_time_ms.toFixed(1)}ms
                        </Badge>
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
                {/* Scroll mode toggle */}
                <div className="flex rounded-lg bg-muted/40 p-0.5 border border-border/20">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={() => onScrollModeChange("infinite")}
                                className={cn(
                                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                                    scrollMode === "infinite"
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <GalleryVerticalEnd className="h-3 w-3" />
                                Scroll
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Infinite scroll — loads 30 rows at a time</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={() => onScrollModeChange("pagination")}
                                className={cn(
                                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                                    scrollMode === "pagination"
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Layers className="h-3 w-3" />
                                Pages
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Paginate results</TooltipContent>
                    </Tooltip>
                </div>

                {/* Table / JSON view toggle */}
                <div className="flex rounded-lg bg-muted/40 p-0.5 border border-border/20">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={() => onDataViewModeChange("table")}
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
                                onClick={() => onDataViewModeChange("json")}
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

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={onRefresh} disabled={isLoading}
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Refresh data</TooltipContent>
                </Tooltip>

                {/* Rows-per-page selector only visible in pagination mode */}
                {scrollMode === "pagination" && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground/60">Rows</span>
                        <Select value={pageSize.toString()} onValueChange={(v) => onPageSizeChange(Number(v))}>
                            <SelectTrigger className="h-7 w-20 text-xs bg-background/40 border-border/30">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[10, 20, 30, 50, 100, 250, 500, 1000, 5000, 10000, 50000, 100000].map((size) => (
                                    <SelectItem key={size} value={size.toString()} className="text-xs">{size}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                                if (!result) return;
                                const header = result.columns.map((c) => c.name).join("\t");
                                const rows = result.rows.map((row) => row.map((cell) => formatCellValue(cell)).join("\t"));
                                navigator.clipboard.writeText([header, ...rows].join("\n"));
                                toast.success("Table data copied", { duration: 1500 });
                            }}
                            disabled={!result || result.rows.length === 0}
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy as TSV</TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
}

/** Preview panel for function, type, or event trigger (lazy-fetched where needed) */
function ObjectPreviewPanel({
    connectionId,
    previewSelection,
    eventTriggers,
}: {
    connectionId: string | null;
    previewSelection: PreviewSelection;
    eventTriggers: EventTriggerInfo[];
}) {
    if (
        previewSelection.kind !== "function" &&
        previewSelection.kind !== "type" &&
        previewSelection.kind !== "event_trigger"
    ) {
        return null;
    }

    if (previewSelection.kind === "event_trigger") {
        const et = eventTriggers.find((e) => e.name === previewSelection.name);
        return (
            <div className="flex h-full flex-col">
                <div className="shrink-0 border-b border-border/20 bg-card/30 px-4 py-2.5 flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-violet-400" />
                    <span className="font-mono text-xs font-medium">{previewSelection.name}</span>
                    <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-400/90">
                        Event Trigger
                    </Badge>
                </div>
                <div className="flex-1 overflow-auto p-4">
                    {et ? (
                        <div className="rounded-xl border border-border/30 bg-card/20 overflow-hidden">
                            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2.5 p-4 text-xs">
                                <DetailRow label="Event" value={et.event} />
                                <DetailRow label="Enabled" value={et.enabled} />
                                <DetailRow label="Function" value={et.function_name} />
                            </dl>
                        </div>
                    ) : (
                        <p className="text-muted-foreground/60 text-xs">Trigger not found.</p>
                    )}
                </div>
            </div>
        );
    }

    if (previewSelection.kind === "function") {
        return (
            <FunctionPreview
                connectionId={connectionId}
                schema={previewSelection.schema}
                name={previewSelection.name}
                arguments={previewSelection.arguments}
            />
        );
    }

    return (
        <TypePreview
            connectionId={connectionId}
            schema={previewSelection.schema}
            name={previewSelection.name}
        />
    );
}

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="text-muted-foreground/70 font-medium">{label}</dt>
            <dd className="font-mono text-foreground/90">{value}</dd>
        </>
    );
}

function FunctionPreview({
    connectionId,
    schema,
    name,
    arguments: args,
}: {
    connectionId: string | null;
    schema: string;
    name: string;
    arguments: string;
}) {
    const [definition, setDefinition] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        if (!connectionId) return;
        setLoading(true);
        setErr(null);
        dbGetFunctionDefinition(connectionId, schema, name, args)
            .then((def) => {
                setDefinition(def ?? null);
            })
            .catch((e) => setErr(String(e)))
            .finally(() => setLoading(false));
    }, [connectionId, schema, name, args]);

    const copy = () => {
        if (definition) {
            navigator.clipboard.writeText(definition);
            toast.success("Definition copied", { duration: 1500 });
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-border/20 bg-card/30 px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    <Code2 className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                    <span className="font-mono text-xs font-medium truncate">
                        {schema}.{name}({args || "..."})
                    </span>
                    <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-400/90 shrink-0">
                        Function
                    </Badge>
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={copy} disabled={!definition}>
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
                {loading && (
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-full rounded" />
                        <Skeleton className="h-4 w-3/4 rounded" />
                        <Skeleton className="h-4 w-5/6 rounded" />
                    </div>
                )}
                {err && (
                    <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive">
                        {err}
                    </div>
                )}
                {!loading && !err && definition && (
                    <ScrollArea className="rounded-xl border border-border/30 bg-muted/20">
                        <pre className="p-4 text-[11px] font-mono text-foreground/90 whitespace-pre overflow-x-auto">
                            <code>{definition}</code>
                        </pre>
                    </ScrollArea>
                )}
            </div>
        </div>
    );
}

function TypePreview({
    connectionId,
    schema,
    name,
}: {
    connectionId: string | null;
    schema: string;
    name: string;
}) {
    const [detail, setDetail] = useState<TypeDefinitionDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        if (!connectionId) return;
        setLoading(true);
        setErr(null);
        dbGetTypeDefinition(connectionId, schema, name)
            .then((d) => setDetail(d ?? null))
            .catch((e) => setErr(String(e)))
            .finally(() => setLoading(false));
    }, [connectionId, schema, name]);

    if (loading) {
        return (
            <div className="flex h-full flex-col">
                <div className="shrink-0 border-b border-border/20 bg-card/30 px-4 py-2.5 flex items-center gap-2">
                    <Type className="h-3.5 w-3.5 text-rose-400" />
                    <span className="font-mono text-xs font-medium">{schema}.{name}</span>
                </div>
                <div className="flex-1 p-4 space-y-2">
                    <Skeleton className="h-4 w-full rounded" />
                    <Skeleton className="h-4 w-2/3 rounded" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-border/20 bg-card/30 px-4 py-2.5 flex items-center gap-2">
                <Type className="h-3.5 w-3.5 text-rose-400" />
                <span className="font-mono text-xs font-medium">{schema}.{name}</span>
                {detail && (
                    <Badge variant="outline" className="text-[10px] border-rose-500/30 text-rose-400/90">
                        {detail.kind}
                    </Badge>
                )}
            </div>
            <div className="flex-1 overflow-auto p-4">
                {err && (
                    <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive">
                        {err}
                    </div>
                )}
                {detail && !err && (
                    <div className="rounded-xl border border-border/30 bg-card/20 overflow-hidden">
                        <dl className="p-4 space-y-3 text-xs">
                            {detail.enum_labels && detail.enum_labels.length > 0 && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1.5">Values</dt>
                                    <dd className="font-mono flex flex-wrap gap-1.5">
                                        {detail.enum_labels.map((l) => (
                                            <Badge key={l} variant="secondary" className="text-[10px] font-mono">
                                                {l}
                                            </Badge>
                                        ))}
                                    </dd>
                                </div>
                            )}
                            {detail.composite_attrs && detail.composite_attrs.length > 0 && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1.5">Attributes</dt>
                                    <dd>
                                        <ul className="space-y-1 font-mono">
                                            {detail.composite_attrs.map(([attr, typ], i) => (
                                                <li key={i} className="flex gap-2">
                                                    <span className="text-foreground/90">{attr}</span>
                                                    <span className="text-muted-foreground/60">→</span>
                                                    <span className="text-muted-foreground/80">{typ}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </dd>
                                </div>
                            )}
                            {detail.domain_base_type && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1">Base type</dt>
                                    <dd className="font-mono text-foreground/90">{detail.domain_base_type}</dd>
                                </div>
                            )}
                            {detail.domain_check && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1">Check</dt>
                                    <dd className="font-mono text-[11px] text-foreground/80 break-all">{detail.domain_check}</dd>
                                </div>
                            )}
                            {detail.range_subtype && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1">Subtype</dt>
                                    <dd className="font-mono text-foreground/90">{detail.range_subtype}</dd>
                                </div>
                            )}
                            {detail.kind === "multirange" &&
                                !detail.enum_labels?.length &&
                                !detail.composite_attrs?.length &&
                                !detail.domain_base_type &&
                                !detail.range_subtype && (
                                <p className="text-muted-foreground/60">Multirange type (no extra details)</p>
                            )}
                        </dl>
                    </div>
                )}
            </div>
        </div>
    );
}
