"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listen } from "@tauri-apps/api/event";
import { useConnectionStore } from "@/stores/connection-store";
import { hasGeometryColumn, isGeometryColumn, extractLatLngFromGeoJSON } from "@/lib/geometry";
import { useSettingsStore } from "@/stores/settings-store";
import {
    dbGetTableData,
    dbGetFunctionDefinition,
    dbGetTypeDefinition,
    dbAlterEnumValues,
    dbGetColumns,
    dbUpdateTableRow,
    dbDeleteTableRows,
    dbSearchTableDataMulti,
    dbGetColumnStats,
    dbWatchTable,
    dbUnwatchTable,
} from "@/lib/tauri";
import { formatCellValue, watchEventName } from "@/lib/types";
import type { TableWatchEvent } from "@/lib/types";
import type {
    QueryResult,
    TypeDefinitionDetail,
    PreviewSelection,
    EventTriggerInfo,
    CellValue,
    ColumnInfo,
    ColumnStats,
    ResultColumn,
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
    Trash2,
    GalleryVerticalEnd,
    Layers,
    Pencil,
    X,
    Plus,
    SlidersHorizontal,
    ChevronDown,
    Download,
    FileText,
    BarChart2,
    Hash,
    Percent,
    Database,
    Radio,
    RadioTower,
    Sparkles,
    MapPin,
} from "lucide-react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator as DDSep,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InsertRowDialog } from "@/components/insert-row-dialog";
import { SeedDataDialog } from "@/components/seed-data-dialog";
import { FunctionEditInline } from "@/components/function-edit-dialog";

// ── Export / copy helpers ────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function rowsToCSV(columns: ResultColumn[], rows: CellValue[][]): string {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = columns.map((c) => esc(c.name)).join(",");
    const body = rows
        .map((row) =>
            row.map((cell) => (cell.type === "Null" ? "" : esc(formatCellValue(cell)))).join(",")
        )
        .join("\n");
    return header + "\n" + body;
}

function rowsToJSON(columns: ResultColumn[], rows: CellValue[][]): string {
    return JSON.stringify(
        rows.map((row) =>
            Object.fromEntries(
                columns.map((col, i) => {
                    const cell = row[i] ?? { type: "Null" as const };
                    if (cell.type === "Null") return [col.name, null];
                    if (["Bool", "Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                        return [col.name, cell.value];
                    if (cell.type === "Json") return [col.name, cell.value];
                    return [col.name, formatCellValue(cell)];
                })
            )
        ),
        null,
        2
    );
}

function rowToInsertSQL(
    schema: string,
    table: string,
    columns: ResultColumn[],
    row: CellValue[]
): string {
    const cols = columns.map((c) => `"${c.name}"`).join(", ");
    const vals = row
        .map((cell) => {
            if (cell.type === "Null") return "NULL";
            if (cell.type === "Bool") return cell.value ? "TRUE" : "FALSE";
            if (["Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                return String(cell.value ?? "NULL");
            return `'${String(cell.value ?? "").replace(/'/g, "''")}'`;
        })
        .join(", ");
    return `INSERT INTO "${schema}"."${table}" (${cols}) VALUES (${vals});`;
}

function rowToJSON(columns: ResultColumn[], row: CellValue[]): string {
    const obj = Object.fromEntries(
        columns.map((col, i) => {
            const cell = row[i] ?? { type: "Null" as const };
            if (cell.type === "Null") return [col.name, null];
            if (["Bool", "Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                return [col.name, cell.value];
            if (cell.type === "Json") return [col.name, cell.value];
            return [col.name, formatCellValue(cell)];
        })
    );
    return JSON.stringify(obj, null, 2);
}

// ── Filter types & helpers ────────────────────────────────────────────────

const NULL_OPS = ["IS NULL", "IS NOT NULL"] as const;

interface FilterConditionUI {
    id: string;
    column: string;
    operator: string;
    value: string;
    logicalOp: "AND" | "OR";
}

interface OperatorOption { value: string; label: string }

function getOperatorsForType(dataType: string): OperatorOption[] {
    const t = dataType.toLowerCase();
    const isNumeric =
        ["int2", "int4", "int8", "float4", "float8", "numeric", "decimal", "real", "double"].some(
            (x) => t.includes(x)
        );
    const isDate = ["date", "time", "timestamp", "interval"].some((x) => t.includes(x));
    const isBool = t === "bool" || t === "boolean";
    const isUuid = t === "uuid";

    const cmpOps: OperatorOption[] = [
        { value: "=", label: "= equals" },
        { value: "!=", label: "≠ not equals" },
        { value: ">", label: "> greater than" },
        { value: ">=", label: "≥ greater or equal" },
        { value: "<", label: "< less than" },
        { value: "<=", label: "≤ less or equal" },
    ];
    const nullOps: OperatorOption[] = [
        { value: "IS NULL", label: "is null" },
        { value: "IS NOT NULL", label: "is not null" },
    ];
    const textOps: OperatorOption[] = [
        { value: "=", label: "= equals" },
        { value: "!=", label: "≠ not equals" },
        { value: "ILIKE", label: "~ contains (ilike)" },
        { value: "NOT ILIKE", label: "!~ not contains" },
        { value: "LIKE", label: "LIKE (case sensitive)" },
        { value: "NOT LIKE", label: "NOT LIKE" },
    ];

    if (isBool)  return [{ value: "=", label: "= equals" }, ...nullOps];
    if (isUuid)  return [{ value: "=", label: "= equals" }, { value: "!=", label: "≠ not equals" }, ...nullOps];
    if (isNumeric || isDate) return [...cmpOps, ...nullOps];
    return [...textOps, ...nullOps];
}

function isNullOp(op: string) {
    return (NULL_OPS as readonly string[]).includes(op);
}

// ── Cell / row helpers ────────────────────────────────────────────────────

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

function formatRecentAge(openedAt: number): string {
    const deltaMs = Math.max(0, Date.now() - openedAt);
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

const BATCH_SIZE = 30;

export function DataTable() {
    const {
        connectionId,
        selectedSchema,
        selectedTable,
        previewSelection,
        recentTables,
        selectTable,
        eventTriggers,
        refreshTrigger,
    } = useConnectionStore();

    // ── Core data ─────────────────────────────────────────────────────────────
    const [result, setResult] = useState<QueryResult | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { defaultPageSize } = useSettingsStore();

    // ── Scroll / pagination mode ──────────────────────────────────────────────
    const [scrollMode, setScrollMode] = useState<"infinite" | "pagination">("infinite");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(() => defaultPageSize);
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
    // Prevents onBlur from saving after Enter/Escape are used
    const preventBlurSaveRef = useRef(false);

    // ── Column stats state ────────────────────────────────────────────────────
    const [colStats, setColStats] = useState<ColumnStats | null>(null);
    const [colStatsLoading, setColStatsLoading] = useState(false);
    const [colStatsColumn, setColStatsColumn] = useState<string | null>(null);

    const fetchColStats = useCallback(
        async (colName: string) => {
            if (!connectionId || !selectedSchema || !selectedTable) return;
            setColStatsColumn(colName);
            setColStats(null);
            setColStatsLoading(true);
            try {
                const stats = await dbGetColumnStats(
                    connectionId,
                    selectedSchema,
                    selectedTable,
                    colName
                );
                setColStats(stats);
            } catch {
                setColStats(null);
            } finally {
                setColStatsLoading(false);
            }
        },
        [connectionId, selectedSchema, selectedTable]
    );

    // ── Filter state ──────────────────────────────────────────────────────────
    const [filterBarOpen, setFilterBarOpen] = useState(false);
    const [filterConditions, setFilterConditions] = useState<FilterConditionUI[]>([]);
    // Debounced version — only updates 400 ms after last keystroke
    const [debouncedConditions, setDebouncedConditions] = useState<FilterConditionUI[]>([]);

    // ── Editing state (cell-level) ────────────────────────────────────────────
    const [tableColumns, setTableColumns] = useState<ColumnInfo[] | null>(null);
    const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set());
    // The single cell currently being edited
    const [editingCell, setEditingCell] = useState<{
        rowKey: string;
        colName: string;
        originalValue: string;
    } | null>(null);
    const [editingValue, setEditingValue] = useState<string>("");
    const [cellError, setCellError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [insertDialogOpen, setInsertDialogOpen] = useState(false);
    const [seedDialogOpen, setSeedDialogOpen] = useState(false);

    // ── Live Watch mode ───────────────────────────────────────────────────────
    const [watchMode, setWatchMode] = useState(false);
    const [watchConnecting, setWatchConnecting] = useState(false);
    // Tracks animation state per row-key: "new" | "updated" | "deleted" | undefined
    const [watchAnimState, setWatchAnimState] = useState<Map<string, "new" | "updated" | "deleted">>(new Map());
    const watchUnlistenRef = useRef<(() => void) | null>(null);

    // ── Debounce filter conditions ────────────────────────────────────────────
    useEffect(() => {
        if (filterConditions.length === 0) {
            setDebouncedConditions([]);
            return;
        }
        const timer = setTimeout(() => setDebouncedConditions(filterConditions), 400);
        return () => clearTimeout(timer);
    }, [filterConditions]);

    // Conditions that are complete enough to actually query
    const activeConditions = useMemo(
        () =>
            debouncedConditions.filter(
                (c) => c.column && c.operator && (isNullOp(c.operator) || c.value.trim() !== "")
            ),
        [debouncedConditions]
    );
    const hasActiveFilters = activeConditions.length > 0;

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

            const data = activeConditions.length > 0
                ? await dbSearchTableDataMulti(
                    connectionId, selectedSchema, selectedTable,
                    activeConditions.map((c) => ({
                        column: c.column,
                        operator: c.operator,
                        value: isNullOp(c.operator) ? null : (c.value.trim() || null),
                        logical_op: c.logicalOp,
                    })),
                    batchSize, p, sortColumn ?? undefined, sortDirection
                )
                : await dbGetTableData(
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
    }, [connectionId, selectedSchema, selectedTable, page, pageSize, sortColumn, sortDirection, scrollMode, activeConditions]);

    // ── Incremental fetch for infinite scroll ─────────────────────────────────
    const fetchMore = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable) return;
        if (!hasMore || isLoadingMore || isLoading) return;
        setIsLoadingMore(true);
        try {
            const data = activeConditions.length > 0
                ? await dbSearchTableDataMulti(
                    connectionId, selectedSchema, selectedTable,
                    activeConditions.map((c) => ({
                        column: c.column,
                        operator: c.operator,
                        value: isNullOp(c.operator) ? null : (c.value.trim() || null),
                        logical_op: c.logicalOp,
                    })),
                    BATCH_SIZE, nextFetchPage, sortColumn ?? undefined, sortDirection
                )
                : await dbGetTableData(
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
    }, [connectionId, selectedSchema, selectedTable, hasMore, isLoadingMore, isLoading, nextFetchPage, sortColumn, sortDirection, activeConditions]);

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
        setEditingCell(null);
        setEditingValue("");
        setCellError(null);
        setAccumulatedRows([]);
        setHasMore(false);
        setNextFetchPage(2);
        setFilterConditions([]);
        setDebouncedConditions([]);
    }, [selectedTable, selectedSchema]);

    useEffect(() => { fetchData(); }, [fetchData, refreshTrigger]);

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
    }, [connectionId, selectedSchema, selectedTable, isTableNotView, refreshTrigger]);

    const pkColumnNames = useMemo(
        () => (tableColumns?.filter((c) => c.is_primary_key).map((c) => c.name) ?? []),
        [tableColumns]
    );
    const columnCommentsByName = useMemo(() => {
        const map = new Map<string, string>();
        for (const col of tableColumns ?? []) {
            if (col.comment?.trim()) {
                map.set(col.name, col.comment.trim());
            }
        }
        return map;
    }, [tableColumns]);
    const canEditDelete = isTableNotView && pkColumnNames.length > 0;

    // ── Save cell edit ────────────────────────────────────────────────────────
    const saveCellEdit = useCallback(async (): Promise<void> => {
        if (preventBlurSaveRef.current) return;
        if (!editingCell || !connectionId || !selectedSchema || !selectedTable || !result || !tableColumns) {
            setEditingCell(null);
            return;
        }
        const { rowKey, colName, originalValue } = editingCell;
        // No change — dismiss silently
        if (editingValue === originalValue) {
            setEditingCell(null);
            setCellError(null);
            return;
        }
        // Validate
        const col = result.columns.find((c) => c.name === colName);
        const colInfo = tableColumns.find((c) => c.name === colName);
        if (col) {
            const err = validateCell(editingValue, col.data_type, colInfo?.is_nullable ?? true);
            if (err) { setCellError(err); return; }
        }
        setCellError(null);
        const row = displayRows.find((r) => getRowKey(r, result.columns, pkColumnNames) === rowKey);
        if (!row) { setEditingCell(null); return; }
        setIsSaving(true);
        try {
            const pkValues = getRowPkValues(row, result.columns, pkColumnNames);
            const value = editingValue.trim() === "" ? null : editingValue.trim();
            await dbUpdateTableRow(
                connectionId, selectedSchema, selectedTable,
                pkColumnNames, pkValues,
                [{ column: colName, value }]
            );
            setEditingCell(null);
            toast.success(`${colName} updated`, { duration: 1500 });
            fetchData();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setIsSaving(false);
        }
    }, [editingCell, editingValue, connectionId, selectedSchema, selectedTable, result, tableColumns, pkColumnNames, displayRows, fetchData]);

    // ── Cancel cell edit ──────────────────────────────────────────────────────
    const cancelCellEdit = useCallback(() => {
        preventBlurSaveRef.current = true;
        setEditingCell(null);
        setEditingValue("");
        setCellError(null);
        setTimeout(() => { preventBlurSaveRef.current = false; }, 50);
    }, []);

    // ── Watch mode helpers ────────────────────────────────────────────────────

    /** Convert a plain JSON object (from pg row_to_json) to a CellValue[] matching result.columns. */
    const jsonRowToCellValues = useCallback((
        obj: Record<string, unknown>,
        columns: { name: string }[]
    ): CellValue[] => {
        return columns.map((col) => {
            const v = obj[col.name];
            if (v === null || v === undefined) return { type: "Null" as const };
            if (typeof v === "boolean") return { type: "Bool" as const, value: v };
            if (typeof v === "number") {
                return Number.isInteger(v)
                    ? { type: "Int64" as const, value: v }
                    : { type: "Float64" as const, value: v };
            }
            if (typeof v === "object") return { type: "Json" as const, value: v };
            return { type: "String" as const, value: String(v) };
        });
    }, []);

    /** Get a stable row key from a JSON row object using PK columns. */
    const getPkKeyFromJsonRow = useCallback((
        obj: Record<string, unknown>,
        pkCols: string[]
    ): string => {
        return pkCols.map((pk) => String(obj[pk] ?? "")).join("\t");
    }, []);

    /** Toggle watch mode on/off. */
    const toggleWatch = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable) return;
        if (watchMode) {
            // Stop watch
            setWatchMode(false);
            setWatchAnimState(new Map());
            watchUnlistenRef.current?.();
            watchUnlistenRef.current = null;
            try { await dbUnwatchTable(connectionId, selectedSchema, selectedTable); } catch { /* ignore */ }
            toast.info("Watch stopped", { duration: 1500 });
        } else {
            // Start watch
            setWatchConnecting(true);
            try {
                await dbWatchTable(connectionId, selectedSchema, selectedTable);
                const eventName = watchEventName(connectionId, selectedSchema, selectedTable);
                const unlisten = await listen<TableWatchEvent>(eventName, (ev) => {
                    const e = ev.payload;
                    if (e.oversized) {
                        // Row too large for pg_notify — do a silent full refresh
                        fetchData();
                        return;
                    }
                    if (e.op === "INSERT" && e.new_row) {
                        setAccumulatedRows((prev) => {
                            if (!result?.columns) return prev;
                            const newRow = jsonRowToCellValues(e.new_row!, result.columns);
                            return [newRow, ...prev];
                        });
                        // We need the key to animate — build it after state update
                        if (result?.columns && pkColumnNames.length > 0) {
                            const k = getPkKeyFromJsonRow(e.new_row, pkColumnNames);
                            setWatchAnimState((m) => { const n = new Map(m); n.set(k, "new"); return n; });
                            setTimeout(() => setWatchAnimState((m) => { const n = new Map(m); n.delete(k); return n; }), 2200);
                        }
                    } else if (e.op === "UPDATE" && e.new_row) {
                        if (result?.columns && pkColumnNames.length > 0) {
                            const matchKey = e.old_row
                                ? getPkKeyFromJsonRow(e.old_row, pkColumnNames)
                                : getPkKeyFromJsonRow(e.new_row, pkColumnNames);
                            const updatedRow = jsonRowToCellValues(e.new_row, result.columns);
                            setAccumulatedRows((prev) => prev.map((row) => {
                                const k = getRowKey(row, result.columns, pkColumnNames);
                                return k === matchKey ? updatedRow : row;
                            }));
                            setWatchAnimState((m) => { const n = new Map(m); n.set(matchKey, "updated"); return n; });
                            setTimeout(() => setWatchAnimState((m) => { const n = new Map(m); n.delete(matchKey); return n; }), 2200);
                        }
                    } else if (e.op === "DELETE" && e.old_row) {
                        if (result?.columns && pkColumnNames.length > 0) {
                            const k = getPkKeyFromJsonRow(e.old_row, pkColumnNames);
                            setWatchAnimState((m) => { const n = new Map(m); n.set(k, "deleted"); return n; });
                            setTimeout(() => {
                                setAccumulatedRows((prev) => prev.filter(
                                    (row) => getRowKey(row, result!.columns, pkColumnNames) !== k
                                ));
                                setWatchAnimState((m) => { const n = new Map(m); n.delete(k); return n; });
                            }, 560);
                        }
                    }
                });
                watchUnlistenRef.current = unlisten;
                setWatchMode(true);
                toast.success("Live Watch active", { description: "Listening for INSERT · UPDATE · DELETE", duration: 2000 });
            } catch (err) {
                toast.error(`Watch failed: ${String(err)}`);
            } finally {
                setWatchConnecting(false);
            }
        }
    }, [watchMode, connectionId, selectedSchema, selectedTable, result, pkColumnNames,
        jsonRowToCellValues, getPkKeyFromJsonRow, fetchData]);

    // Stop watch when table/schema changes
    useEffect(() => {
        if (watchMode && watchUnlistenRef.current) {
            watchUnlistenRef.current();
            watchUnlistenRef.current = null;
            setWatchMode(false);
            setWatchAnimState(new Map());
            if (connectionId && selectedSchema && selectedTable) {
                dbUnwatchTable(connectionId, selectedSchema, selectedTable).catch(() => {});
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTable, selectedSchema]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            watchUnlistenRef.current?.();
        };
    }, []);

    // ── Delete selected: open confirmation dialog ───────────────────────────────
    const openDeleteConfirm = useCallback(() => {
        if (!result || selectedRowKeys.size === 0) return;
        setDeleteConfirmOpen(true);
    }, [result, selectedRowKeys.size]);

    // ── Delete confirmed: run DB delete (cascade handled by DB FK rules) ─────────
    const handleConfirmDelete = useCallback(async () => {
        if (!connectionId || !selectedSchema || !selectedTable || !result) return;
        const rowsToDelete = displayRows.filter((row) =>
            selectedRowKeys.has(getRowKey(row, result!.columns, pkColumnNames))
        );
        if (rowsToDelete.length === 0) {
            setDeleteConfirmOpen(false);
            return;
        }
        const rowsPkValues = rowsToDelete.map((row) => getRowPkValues(row, result!.columns, pkColumnNames));
        setIsDeleting(true);
        setDeleteConfirmOpen(false);
        try {
            const n = await dbDeleteTableRows(connectionId, selectedSchema, selectedTable, pkColumnNames, rowsPkValues);
            setSelectedRowKeys(new Set());
            if (n === 0) {
                toast.error("No rows were deleted. The row may have been modified or removed.");
            } else {
                toast.success(`${n} row(s) deleted`);
            }
            await fetchData();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setIsDeleting(false);
        }
    }, [connectionId, selectedSchema, selectedTable, result, selectedRowKeys, pkColumnNames, fetchData, displayRows]);

    // ── Delete handler uses editingCell rowKey guard ──────────────────────────
    // (no global keyboard handler needed; cells handle their own keys inline)

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
    const tableSchema = isTableView && previewSelection ? (previewSelection as { schema: string }).schema : "";
    const tableNameForExport = isTableView && previewSelection ? (previewSelection as { name: string }).name : "";

    const handleExport = useCallback(
        (format: "csv" | "json") => {
            if (!result) return;
            const cols = result.columns;
            const rows = displayRows;
            const base = `${tableNameForExport || "table"}-${Date.now()}`;
            if (format === "csv") {
                downloadBlob(rowsToCSV(cols, rows), `${base}.csv`, "text/csv;charset=utf-8;");
                toast.success("CSV downloaded", { duration: 1500 });
            } else {
                downloadBlob(rowsToJSON(cols, rows), `${base}.json`, "application/json");
                toast.success("JSON downloaded", { duration: 1500 });
            }
        },
        [result, displayRows, tableNameForExport]
    );

    // ── Empty / non-table states ──────────────────────────────────────────────
    if (!previewSelection) {
        return (
            <div className="flex h-full flex-col items-center justify-center px-6 text-muted-foreground select-none">
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
                {recentTables.length > 0 && (
                    <div className="mt-8 w-full max-w-2xl rounded-xl border border-border/60 bg-card/40 p-3">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/55">
                            Recent Tables
                        </p>
                        <div className="grid gap-1 md:grid-cols-2">
                            {recentTables.slice(0, 8).map((item) => (
                                <button
                                    key={`${item.schema}.${item.table}`}
                                    type="button"
                                    onClick={() => selectTable(item.schema, item.table)}
                                    className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-muted-foreground/70 hover:border-border hover:bg-muted/40 hover:text-foreground transition-all"
                                >
                                    <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
                                    <span className="truncate flex-1 font-mono text-xs">{item.table}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground/45">{item.schema}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground/45">{formatRecentAge(item.opened_at)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
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

    if (error && !isLoading) {
        return (
            <div className="flex h-full flex-col">
                <TableToolbar
                    schema={tableSchema} table={tableNameForExport} result={null}
                    pageSize={pageSize} onPageSizeChange={(v) => { setPageSize(v); setPage(1); }}
                    onRefresh={fetchData} isLoading={false}
                    dataViewMode={dataViewMode} onDataViewModeChange={setDataViewMode}
                    scrollMode={scrollMode} onScrollModeChange={setScrollMode}
                    filterCount={filterConditions.length}
                    filterBarOpen={filterBarOpen}
                    onToggleFilterBar={() => setFilterBarOpen((v) => !v)}
                    hasRows={false}
                    watchMode={watchMode}
                    watchConnecting={watchConnecting}
                    onToggleWatch={isTableNotView ? toggleWatch : undefined}
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
                    schema={tableSchema} table={tableNameForExport} result={result}
                    pageSize={pageSize} onPageSizeChange={(v) => { setPageSize(v); setPage(1); }}
                    onRefresh={fetchData} isLoading={isLoading}
                    dataViewMode={dataViewMode} onDataViewModeChange={setDataViewMode}
                    scrollMode={scrollMode} onScrollModeChange={setScrollMode}
                    rowsLoaded={scrollMode === "infinite" ? accumulatedRows.length : undefined}
                    onAddRow={canEditDelete ? () => setInsertDialogOpen(true) : undefined}
                    onSeedData={canEditDelete ? () => setSeedDialogOpen(true) : undefined}
                    filterCount={filterConditions.length}
                    filterBarOpen={filterBarOpen}
                    onToggleFilterBar={() => setFilterBarOpen((v) => !v)}
                    onExport={handleExport}
                    hasRows={displayRows.length > 0}
                    showMapButton={result ? hasGeometryColumn(result.columns) : false}
                    watchMode={watchMode}
                    watchConnecting={watchConnecting}
                    onToggleWatch={isTableNotView ? toggleWatch : undefined}
            />
            {/* Live watch banner */}
            {watchMode && (
                <div className="flex items-center gap-2 px-4 py-1 border-b border-rose-500/20 bg-rose-500/5 shrink-0">
                    <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                    </span>
                    <span className="text-[11px] font-medium text-rose-400">LIVE</span>
                    <span className="text-[10px] text-rose-400/60">streaming INSERT · UPDATE · DELETE via LISTEN/NOTIFY</span>
                </div>
            )}

            {/* Filter bar */}
            {filterBarOpen && (
                <FilterBar
                    columns={result?.columns ?? tableColumns?.map((c) => ({ name: c.name, data_type: c.data_type })) ?? []}
                    conditions={filterConditions}
                    onConditionsChange={(conds) => {
                        setFilterConditions(conds);
                        setPage(1);
                        setAccumulatedRows([]);
                        setHasMore(false);
                        setNextFetchPage(2);
                    }}
                    hasActiveFilters={hasActiveFilters}
                    resultCount={result?.total_rows ?? null}
                    isLoading={isLoading}
                />
            )}

            {previewSelection?.kind === "table" && (
                <>
                    <InsertRowDialog
                        open={insertDialogOpen}
                        onOpenChange={setInsertDialogOpen}
                        connectionId={connectionId}
                        schema={selectedSchema ?? ""}
                        table={selectedTable ?? ""}
                        columns={tableColumns ?? []}
                        onSuccess={fetchData}
                    />
                    <SeedDataDialog
                        open={seedDialogOpen}
                        onOpenChange={setSeedDialogOpen}
                        connectionId={connectionId}
                        schema={selectedSchema ?? undefined}
                        table={selectedTable ?? undefined}
                        onSuccess={fetchData}
                    />
                </>
            )}

            {/* Saving indicator */}
            {isSaving && (
                <div className="flex items-center gap-2 px-4 py-1.5 border-b border-emerald-500/20 bg-emerald-500/5 shrink-0">
                    <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">Saving…</span>
                </div>
            )}

            {/* Delete bar */}
            {canEditDelete && selectedRowKeys.size > 0 && dataViewMode === "table" && (
                <div className="flex items-center justify-between px-4 py-2 border-b border-destructive/20 bg-destructive/5 shrink-0">
                    <span className="text-xs text-destructive/90">{selectedRowKeys.size} row(s) selected</span>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        disabled={isDeleting}
                        onClick={openDeleteConfirm}
                    >
                        {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        {isDeleting ? "Deleting…" : "Delete"}
                    </Button>
                </div>
            )}

            {/* Delete confirmation dialog */}
            <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <DialogContent className="sm:max-w-md" showCloseButton={true}>
                    <DialogHeader>
                        <DialogTitle>Delete row(s)?</DialogTitle>
                        <DialogDescription>
                            This will permanently delete {selectedRowKeys.size} row(s) from the database.
                            Rows in other tables that reference these (via foreign keys with ON DELETE CASCADE) will also be removed. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
                            No, cancel
                        </Button>
                        <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
                            {isDeleting ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
                            Yes, delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
                                <Table
                                    role="grid"
                                    aria-label={selectedSchema && selectedTable ? `Table: ${selectedSchema}.${selectedTable}` : "Table data"}
                                    aria-rowcount={scrollMode === "pagination" && result ? (result.total_rows ?? result.row_count) : undefined}
                                    aria-colcount={(result?.columns?.length ?? 0) + (canEditDelete ? 2 : 1)}
                                >
                                    <TableHeader>
                                        <TableRow className="hover:bg-transparent border-border/20 bg-card/30 sticky top-0 z-10">
                                            {canEditDelete && (
                                                <TableHead className="w-10 px-2 sticky left-0 bg-card/80 backdrop-blur-sm z-20">
                                                    <input
                                                        type="checkbox"
                                                        className="h-3.5 w-3.5 rounded border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                        aria-label="Select all rows"
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
                                                    className="select-none group whitespace-nowrap px-3 py-2"
                                                    aria-sort={sortColumn === col.name ? (sortDirection === "ASC" ? "ascending" : "descending") : undefined}
                                                >
                                                    <div className="flex items-center gap-1">
                                                        {/* Sort clickable area */}
                                                        <button
                                                            type="button"
                                                            className="flex items-center gap-1.5 cursor-pointer flex-1 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                                            onClick={() => handleSort(col.name)}
                                                            aria-label={`Sort by ${col.name}${sortColumn === col.name ? ` ${sortDirection === "ASC" ? "ascending" : "descending"}` : ""}`}
                                                        >
                                                            <span
                                                                className="text-xs font-semibold text-foreground/80"
                                                                title={columnCommentsByName.get(col.name)}
                                                            >
                                                                {col.name}
                                                            </span>
                                                            <span className="text-[9px] font-mono text-muted-foreground/30 hidden group-hover:inline">{col.data_type}</span>
                                                            {sortColumn === col.name ? (
                                                                sortDirection === "ASC"
                                                                    ? <ArrowUp className="h-3 w-3 text-emerald-400 shrink-0" />
                                                                    : <ArrowDown className="h-3 w-3 text-emerald-400 shrink-0" />
                                                            ) : (
                                                                <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-25 transition-opacity shrink-0" />
                                                            )}
                                                        </button>
                                                        {/* Column stats popover */}
                                                        <Popover
                                                            onOpenChange={(open) => {
                                                                if (open) fetchColStats(col.name);
                                                                else { setColStats(null); setColStatsColumn(null); }
                                                            }}
                                                        >
                                                            <PopoverTrigger asChild>
                                                                <button
                                                                    type="button"
                                                                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:opacity-100"
                                                                    title={`Stats for ${col.name}`}
                                                                    aria-label={`Column stats for ${col.name}`}
                                                                    onClick={(e) => e.stopPropagation()}
                                                                >
                                                                    <BarChart2 className="h-3 w-3 text-muted-foreground" />
                                                                </button>
                                                            </PopoverTrigger>
                                                            <PopoverContent className="w-72 p-0" align="start">
                                                                <ColumnStatsPanel
                                                                    colName={col.name}
                                                                    dataType={col.data_type}
                                                                    stats={colStatsColumn === col.name ? colStats : null}
                                                                    loading={colStatsColumn === col.name && colStatsLoading}
                                                                />
                                                            </PopoverContent>
                                                        </Popover>
                                                    </div>
                                                </TableHead>
                                            ))}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {displayRows.length === 0 ? (
                                            <TableRow className="hover:bg-transparent">
                                                <TableCell
                                                    colSpan={(result?.columns?.length ?? 0) + (canEditDelete ? 2 : 1)}
                                                    className="text-center py-12 text-muted-foreground/60"
                                                >
                                                    <p className="text-sm font-medium">Empty table</p>
                                                    <p className="text-xs mt-1 text-muted-foreground/40">This table has no rows</p>
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                        displayRows.map((row, rowIdx) => {
                                            const rowKey = getRowKey(row, result.columns, pkColumnNames);
                                            const isSelected = selectedRowKeys.has(rowKey);
                                            const isRowEditing = canEditDelete && editingCell?.rowKey === rowKey;
                                            const rowNumber = scrollMode === "infinite"
                                                ? rowIdx + 1
                                                : (page - 1) * pageSize + rowIdx + 1;
                                            const watchAnim = watchAnimState.get(rowKey);

                                            return (
                                                <ContextMenu key={rowKey || rowIdx}>
                                                <ContextMenuTrigger asChild>
                                                <TableRow
                                                    className={cn(
                                                        "border-border/10 transition-colors group",
                                                        isRowEditing ? "bg-primary/5" : "hover:bg-accent/20",
                                                        isSelected && "bg-accent/10",
                                                        watchAnim === "new" && "watch-row-insert",
                                                        watchAnim === "updated" && "watch-row-update",
                                                        watchAnim === "deleted" && "watch-row-delete",
                                                    )}
                                                >
                                                    {canEditDelete && (
                                                        <TableCell
                                                            className="px-2 sticky left-0 bg-background group-hover:bg-accent/20 z-10"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
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
                                                    <TableCell className={cn(
                                                        "text-center text-[10px] font-mono text-muted-foreground/25 px-2 sticky bg-background group-hover:bg-accent/20 transition-colors z-10",
                                                        canEditDelete ? "left-9" : "left-0"
                                                    )}>
                                                        {rowNumber}
                                                    </TableCell>

                                                    {row.map((cell, colIdx) => {
                                                        const col = result.columns[colIdx];
                                                        const colInfo = tableColumns?.find((c) => c.name === col.name);
                                                        const isThisCellEditing =
                                                            canEditDelete &&
                                                            editingCell?.rowKey === rowKey &&
                                                            editingCell?.colName === col.name;

                                                        // ── Editing cell ──────────────────────────────────
                                                        if (isThisCellEditing) {
                                                            return (
                                                                <TableCell
                                                                    key={colIdx}
                                                                    className="p-1 align-middle min-w-[120px]"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                >
                                                                    <div className="flex items-center gap-1">
                                                                        <div className="flex-1 min-w-0">
                                                                            <Input
                                                                                autoFocus
                                                                                value={editingValue}
                                                                                onChange={(e) => {
                                                                                    setEditingValue(e.target.value);
                                                                                    if (cellError) setCellError(null);
                                                                                }}
                                                                                onKeyDown={(e) => {
                                                                                    if (e.key === "Enter") {
                                                                                        e.preventDefault();
                                                                                        preventBlurSaveRef.current = true;
                                                                                        saveCellEdit().finally(() => {
                                                                                            preventBlurSaveRef.current = false;
                                                                                        });
                                                                                    }
                                                                                    if (e.key === "Escape") {
                                                                                        e.preventDefault();
                                                                                        cancelCellEdit();
                                                                                    }
                                                                                }}
                                                                                onBlur={saveCellEdit}
                                                                                className={cn(
                                                                                    "h-7 text-xs font-mono w-full",
                                                                                    cellError && "border-destructive focus-visible:ring-destructive"
                                                                                )}
                                                                            />
                                                                            {cellError && (
                                                                                <p className="text-[10px] text-destructive mt-0.5 px-0.5">{cellError}</p>
                                                                            )}
                                                                        </div>
                                                                        {/* Cancel button — onMouseDown prevents input blur */}
                                                                        <button
                                                                            onMouseDown={(e) => {
                                                                                e.preventDefault();
                                                                                cancelCellEdit();
                                                                            }}
                                                                            className="shrink-0 p-0.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/60 transition-colors"
                                                                            title="Cancel (Esc)"
                                                                        >
                                                                            <X className="h-3 w-3" />
                                                                        </button>
                                                                    </div>
                                                                </TableCell>
                                                            );
                                                        }

                                                        // ── Read-only cell ────────────────────────────────
                                                        const formatted = formatCellValue(cell);
                                                        const isNull = cell.type === "Null";
                                                        const isGeomCol = isGeometryColumn(col);
                                                        const geomLatLng = isGeomCol && !isNull && cell.type === "String" && typeof cell.value === "string"
                                                            ? extractLatLngFromGeoJSON(cell.value)
                                                            : null;
                                                        const showMapLink = isGeomCol && geomLatLng && tableSchema && tableNameForExport;

                                                        return (
                                                            <TableCell
                                                                key={colIdx}
                                                                className={cn(
                                                                    "text-xs font-mono max-w-[280px] truncate px-3 py-1.5 cursor-default group/cell",
                                                                    isNull && !isGeomCol && "text-muted-foreground/25 italic",
                                                                    isGeomCol && isNull && "text-muted-foreground/40"
                                                                )}
                                                                title={isGeomCol && isNull ? "—" : isNull ? "NULL" : showMapLink ? "Open in map" : formatted}
                                                                onClick={() => {
                                                                    if (showMapLink) return;
                                                                    if (!canEditDelete && !isNull) copyCell(formatted);
                                                                }}
                                                                onDoubleClick={() => {
                                                                    if (showMapLink) return;
                                                                    if (canEditDelete) {
                                                                        preventBlurSaveRef.current = false;
                                                                        setEditingCell({
                                                                            rowKey,
                                                                            colName: col.name,
                                                                            originalValue: cellToEditValue(cell),
                                                                        });
                                                                        setEditingValue(cellToEditValue(cell));
                                                                        setCellError(null);
                                                                    } else if (!isNull) {
                                                                        copyCell(formatted);
                                                                    }
                                                                }}
                                                            >
                                                                <div className="flex items-center gap-1 min-w-0">
                                                                    {isGeomCol ? (
                                                                        isNull ? (
                                                                            <span className="text-muted-foreground/50">—</span>
                                                                        ) : showMapLink ? (
                                                                            <Link
                                                                                href={`/map-view?schema=${encodeURIComponent(tableSchema)}&table=${encodeURIComponent(tableNameForExport)}&lat=${geomLatLng!.lat}&lng=${geomLatLng!.lng}`}
                                                                                className="text-blue-500 hover:text-blue-400 underline underline-offset-1 truncate shrink-0"
                                                                                onClick={(e) => e.stopPropagation()}
                                                                            >
                                                                                View on map
                                                                            </Link>
                                                                        ) : (
                                                                            <span className="truncate flex-1 text-muted-foreground/70">{formatted}</span>
                                                                        )
                                                                    ) : (
                                                                        <span className="truncate flex-1">{formatted}</span>
                                                                    )}
                                                                    {/* Pencil icon — only for editable cells, only on hover; hide for geometry map link */}
                                                                    {canEditDelete && !isNull && !showMapLink && (
                                                                        <button
                                                                            className="shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted/60 ml-0.5"
                                                                            onMouseDown={(e) => {
                                                                                e.preventDefault();
                                                                                e.stopPropagation();
                                                                            }}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                preventBlurSaveRef.current = false;
                                                                                setEditingCell({
                                                                                    rowKey,
                                                                                    colName: col.name,
                                                                                    originalValue: cellToEditValue(cell),
                                                                                });
                                                                                setEditingValue(cellToEditValue(cell));
                                                                                setCellError(null);
                                                                            }}
                                                                            title={`Edit ${col.name}`}
                                                                        >
                                                                            <Pencil className="h-2.5 w-2.5 text-muted-foreground/50" />
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </TableCell>
                                                        );
                                                    })}
                                                </TableRow>
                                                </ContextMenuTrigger>
                                                <ContextMenuContent className="w-52">
                                                    <ContextMenuLabel className="text-[10px] text-muted-foreground/50 font-normal">
                                                        Row {rowNumber}
                                                    </ContextMenuLabel>
                                                    <ContextMenuSeparator />
                                                    <ContextMenuItem
                                                        className="gap-2 text-xs"
                                                        onClick={() => {
                                                            const sql = rowToInsertSQL(tableSchema, tableNameForExport, result.columns, row);
                                                            navigator.clipboard.writeText(sql);
                                                            toast.success("INSERT SQL copied", { duration: 1500 });
                                                        }}
                                                    >
                                                        <Copy className="h-3.5 w-3.5" />
                                                        Copy as INSERT SQL
                                                    </ContextMenuItem>
                                                    <ContextMenuItem
                                                        className="gap-2 text-xs"
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(rowToJSON(result.columns, row));
                                                            toast.success("Copied as JSON", { duration: 1500 });
                                                        }}
                                                    >
                                                        <Braces className="h-3.5 w-3.5" />
                                                        Copy as JSON
                                                    </ContextMenuItem>
                                                    <ContextMenuItem
                                                        className="gap-2 text-xs"
                                                        onClick={() => {
                                                            const line = row.map((c) => formatCellValue(c)).join(",");
                                                            navigator.clipboard.writeText(line);
                                                            toast.success("Copied as CSV row", { duration: 1500 });
                                                        }}
                                                    >
                                                        <FileText className="h-3.5 w-3.5" />
                                                        Copy as CSV row
                                                    </ContextMenuItem>
                                                </ContextMenuContent>
                                                </ContextMenu>
                                            );
                                        })
                                        )}
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
    onAddRow,
    onSeedData,
    filterCount,
    filterBarOpen,
    onToggleFilterBar,
    onExport,
    hasRows,
    showMapButton,
    watchMode,
    watchConnecting,
    onToggleWatch,
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
    hasRows?: boolean;
    rowsLoaded?: number;
    onAddRow?: () => void;
    onSeedData?: () => void;
    filterCount?: number;
    filterBarOpen?: boolean;
    onToggleFilterBar?: () => void;
    onExport?: (format: "csv" | "json") => void;
    showMapButton?: boolean;
    watchMode?: boolean;
    watchConnecting?: boolean;
    onToggleWatch?: () => void;
}) {
    const router = useRouter();
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
                {/* Watch mode toggle */}
                {onToggleWatch && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "h-7 gap-1.5 px-2.5 text-xs transition-all",
                                    watchMode
                                        ? "bg-rose-500/15 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                                onClick={onToggleWatch}
                                disabled={watchConnecting}
                            >
                                {watchConnecting ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : watchMode ? (
                                    <RadioTower className="h-3.5 w-3.5 animate-pulse" />
                                ) : (
                                    <Radio className="h-3.5 w-3.5" />
                                )}
                                {watchMode ? "Live" : "Watch"}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {watchMode
                                ? "Watching — INSERT · UPDATE · DELETE events stream in real-time. Click to stop."
                                : "Watch this table — stream live INSERT / UPDATE / DELETE changes via LISTEN/NOTIFY"}
                        </TooltipContent>
                    </Tooltip>
                )}

                {/* Filter toggle */}
                {onToggleFilterBar && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "h-7 gap-1.5 px-2.5 text-xs transition-colors",
                                    filterBarOpen
                                        ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/20"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                                onClick={onToggleFilterBar}
                            >
                                <SlidersHorizontal className="h-3.5 w-3.5" />
                                Filter
                                {filterCount != null && filterCount > 0 && (
                                    <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white">
                                        {filterCount}
                                    </span>
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Toggle filter bar (multi-condition WHERE clause)</TooltipContent>
                    </Tooltip>
                )}

                {onAddRow && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="default"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                                onClick={onAddRow}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add row
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Insert a new row into this table</TooltipContent>
                    </Tooltip>
                )}
                {onSeedData && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs border-amber-500/30 text-amber-400/90 hover:bg-amber-500/10"
                                onClick={onSeedData}
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                                {/* Seed data */}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Generate and insert sample data with AI</TooltipContent>
                    </Tooltip>
                )}
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
                                toast.success("Copied as TSV", { duration: 1500 });
                            }}
                            disabled={!hasRows}
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy as TSV</TooltipContent>
                </Tooltip>

                {/* Map button (geometry tables only) */}
                {showMapButton && schema && table && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 gap-1 text-muted-foreground hover:text-foreground text-xs"
                                onClick={() =>
                                    router.push(
                                        `/map-view?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`
                                    )
                                }
                            >
                                <MapPin className="h-3.5 w-3.5" />
                                {/* Map */}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Open map view</TooltipContent>
                    </Tooltip>
                )}

                {/* Export dropdown */}
                {onExport && (
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
                            <DropdownMenuItem onClick={() => onExport("csv")} className="gap-2 text-xs">
                                <FileText className="h-3.5 w-3.5" />
                                Download as CSV
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onExport("json")} className="gap-2 text-xs">
                                <Braces className="h-3.5 w-3.5" />
                                Download as JSON
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
        </div>
    );
}

// ── ColumnStatsPanel ──────────────────────────────────────────────────────

function ColumnStatsPanel({
    colName,
    dataType,
    stats,
    loading,
}: {
    colName: string;
    dataType: string;
    stats: ColumnStats | null;
    loading: boolean;
}) {
    return (
        <div className="overflow-hidden rounded-lg">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/20 bg-muted/20">
                <BarChart2 className="h-3.5 w-3.5 text-muted-foreground/60" />
                <div>
                    <p className="text-xs font-semibold leading-tight">{colName}</p>
                    <p className="text-[10px] font-mono text-muted-foreground/50">{dataType}</p>
                </div>
            </div>

            {loading && (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
                </div>
            )}

            {!loading && !stats && (
                <div className="flex items-center justify-center py-6">
                    <p className="text-xs text-muted-foreground/40">No data</p>
                </div>
            )}

            {!loading && stats && (
                <div className="p-3 space-y-3">
                    {/* Row counts */}
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { label: "Total rows", value: stats.total_rows.toLocaleString(), icon: Database },
                            { label: "Non-null", value: stats.non_null_count.toLocaleString(), icon: Hash },
                            { label: "Null", value: stats.null_count.toLocaleString(), icon: Percent },
                            { label: "Distinct", value: stats.distinct_count.toLocaleString(), icon: Layers },
                        ].map(({ label, value, icon: Icon }) => (
                            <div key={label} className="rounded-md bg-muted/30 px-2.5 py-2">
                                <p className="text-[10px] text-muted-foreground/50 mb-0.5 flex items-center gap-1">
                                    <Icon className="h-2.5 w-2.5" />
                                    {label}
                                </p>
                                <p className="text-xs font-mono font-semibold">{value}</p>
                            </div>
                        ))}
                    </div>

                    {/* Null % bar */}
                    <div>
                        <div className="flex justify-between text-[10px] text-muted-foreground/50 mb-1">
                            <span>Null %</span>
                            <span className="font-mono">{stats.null_pct.toFixed(1)}%</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                            <div
                                className="h-full rounded-full bg-amber-500/60 transition-all"
                                style={{ width: `${Math.min(stats.null_pct, 100)}%` }}
                            />
                        </div>
                    </div>

                    {/* Min / Max / Avg */}
                    {(stats.min_value !== null || stats.max_value !== null || stats.avg_value !== null) && (
                        <div className="space-y-1">
                            {stats.min_value !== null && (
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-muted-foreground/50">Min</span>
                                    <span className="font-mono truncate max-w-[160px]" title={stats.min_value}>{stats.min_value}</span>
                                </div>
                            )}
                            {stats.max_value !== null && (
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-muted-foreground/50">Max</span>
                                    <span className="font-mono truncate max-w-[160px]" title={stats.max_value}>{stats.max_value}</span>
                                </div>
                            )}
                            {stats.avg_value !== null && (
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-muted-foreground/50">Avg</span>
                                    <span className="font-mono">{stats.avg_value.toFixed(4)}</span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Top values */}
                    {stats.top_values.length > 0 && (
                        <div>
                            <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-1.5">
                                Top values
                            </p>
                            <div className="space-y-1">
                                {stats.top_values.map(([val, cnt]) => {
                                    const pct = stats.non_null_count > 0
                                        ? (cnt / stats.non_null_count) * 100
                                        : 0;
                                    return (
                                        <div key={val} className="flex items-center gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between text-[10px] mb-0.5">
                                                    <span className="font-mono truncate max-w-[140px]" title={val}>
                                                        {val}
                                                    </span>
                                                    <span className="text-muted-foreground/50 shrink-0">
                                                        {cnt.toLocaleString()}
                                                    </span>
                                                </div>
                                                <div className="h-1 w-full rounded-full bg-muted/30 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full bg-emerald-500/50"
                                                        style={{ width: `${pct}%` }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── FilterBar component ───────────────────────────────────────────────────

function FilterBar({
    columns,
    conditions,
    onConditionsChange,
    hasActiveFilters,
    resultCount,
    isLoading,
}: {
    columns: { name: string; data_type: string }[];
    conditions: FilterConditionUI[];
    onConditionsChange: (c: FilterConditionUI[]) => void;
    hasActiveFilters: boolean;
    resultCount: number | null;
    isLoading: boolean;
}) {
    const addCondition = () => {
        const firstCol = columns[0]?.name ?? "";
        const firstOps = columns[0] ? getOperatorsForType(columns[0].data_type) : [];
        onConditionsChange([
            ...conditions,
            {
                id: Math.random().toString(36).slice(2),
                column: firstCol,
                operator: firstOps[0]?.value ?? "=",
                value: "",
                logicalOp: "AND",
            },
        ]);
    };

    const remove = (id: string) =>
        onConditionsChange(conditions.filter((c) => c.id !== id));

    const update = (id: string, patch: Partial<FilterConditionUI>) =>
        onConditionsChange(conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)));

    return (
        <div className="shrink-0 border-b border-border/20 bg-card/10 px-4 py-2.5">
            {/* Header row */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-xs font-medium text-foreground/70">Filters</span>
                    {hasActiveFilters && !isLoading && resultCount !== null && (
                        <span className="text-[10px] font-mono text-muted-foreground/50">
                            — {resultCount.toLocaleString()} row{resultCount !== 1 ? "s" : ""} match
                        </span>
                    )}
                    {isLoading && hasActiveFilters && (
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
                        onClick={addCondition}
                        disabled={columns.length === 0}
                    >
                        <Plus className="h-3 w-3" />
                        Add condition
                    </Button>
                    {conditions.length > 0 && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-destructive"
                            onClick={() => onConditionsChange([])}
                        >
                            <X className="h-3 w-3" />
                            Clear all
                        </Button>
                    )}
                </div>
            </div>

            {/* Condition rows */}
            {conditions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/40 pl-0.5">
                    No conditions — click &ldquo;Add condition&rdquo; to filter rows.
                </p>
            ) : (
                <div className="space-y-1.5">
                    {conditions.map((cond, idx) => {
                        const colType =
                            columns.find((c) => c.name === cond.column)?.data_type ?? "text";
                        const ops = getOperatorsForType(colType);
                        const noValue = isNullOp(cond.operator);

                        return (
                            <div key={cond.id} className="flex items-center gap-1.5 group/row">
                                {/* Connector / WHERE label */}
                                <div className="w-12 flex justify-end shrink-0">
                                    {idx === 0 ? (
                                        <span className="text-[10px] font-mono text-muted-foreground/40 pr-1">
                                            WHERE
                                        </span>
                                    ) : (
                                        <button
                                            className={cn(
                                                "text-[10px] font-bold font-mono px-1.5 py-0.5 rounded uppercase transition-colors border",
                                                cond.logicalOp === "AND"
                                                    ? "bg-blue-500/10 text-blue-400 border-blue-500/25 hover:bg-blue-500/20"
                                                    : "bg-amber-500/10 text-amber-400 border-amber-500/25 hover:bg-amber-500/20"
                                            )}
                                            onClick={() =>
                                                update(cond.id, {
                                                    logicalOp: cond.logicalOp === "AND" ? "OR" : "AND",
                                                })
                                            }
                                            title="Click to toggle AND / OR"
                                        >
                                            {cond.logicalOp}
                                        </button>
                                    )}
                                </div>

                                {/* Column selector */}
                                <div className="relative">
                                    <select
                                        value={cond.column}
                                        onChange={(e) => {
                                            const newCol = e.target.value;
                                            const newOps = getOperatorsForType(
                                                columns.find((c) => c.name === newCol)?.data_type ?? "text"
                                            );
                                            update(cond.id, {
                                                column: newCol,
                                                operator: newOps[0]?.value ?? "=",
                                            });
                                        }}
                                        className="h-7 appearance-none text-[11px] font-mono bg-background/60 border border-border/40 rounded-md pl-2 pr-6 text-foreground/90 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 cursor-pointer hover:border-border/60 transition-colors min-w-[100px] max-w-[160px] truncate"
                                    >
                                        {columns.map((col) => (
                                            <option key={col.name} value={col.name}>
                                                {col.name}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                                </div>

                                {/* Operator selector */}
                                <div className="relative">
                                    <select
                                        value={cond.operator}
                                        onChange={(e) => update(cond.id, { operator: e.target.value })}
                                        className="h-7 appearance-none text-[11px] bg-background/60 border border-border/40 rounded-md pl-2 pr-6 text-foreground/90 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 cursor-pointer hover:border-border/60 transition-colors min-w-[80px] max-w-[180px]"
                                    >
                                        {ops.map((op) => (
                                            <option key={op.value} value={op.value}>
                                                {op.label}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                                </div>

                                {/* Value input */}
                                {!noValue && (
                                    <Input
                                        value={cond.value}
                                        onChange={(e) => update(cond.id, { value: e.target.value })}
                                        placeholder={
                                            ["LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE"].includes(
                                                cond.operator
                                            )
                                                ? "use % for wildcards…"
                                                : `${cond.column}…`
                                        }
                                        className="h-7 text-[11px] font-mono w-48 bg-background/60 border-border/40 focus-visible:ring-emerald-500/50"
                                        autoComplete="off"
                                        spellCheck={false}
                                    />
                                )}
                                {noValue && (
                                    <span className="text-[10px] text-muted-foreground/40 italic px-1">
                                        (no value needed)
                                    </span>
                                )}

                                {/* Remove */}
                                <button
                                    onClick={() => remove(cond.id)}
                                    className="opacity-0 group-hover/row:opacity-100 transition-opacity p-1 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                                    title="Remove condition"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
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
    const [editing, setEditing] = useState(false);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

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
    }, [connectionId, schema, name, args, refreshTrigger]);

    const copy = () => {
        if (definition) {
            navigator.clipboard.writeText(definition);
            toast.success("Definition copied", { duration: 1500 });
        }
    };

    return (
        <div className="flex h-full flex-col min-h-0">
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
                <div className="flex items-center gap-1 shrink-0">
                    {editing ? (
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setEditing(false)}>
                            <Pencil className="h-3 w-3 mr-1" />
                            View
                        </Button>
                    ) : (
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)} disabled={!definition || !connectionId}>
                            <Pencil className="h-3 w-3 mr-1" />
                            Edit
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={copy} disabled={!definition}>
                        <Copy className="h-3 w-3 mr-1" />
                        Copy
                    </Button>
                </div>
            </div>
            <div className={cn("flex-1 min-h-0 p-4", editing ? "flex flex-col" : "overflow-auto")}>
                {editing && definition != null && connectionId ? (
                    <FunctionEditInline
                        connectionId={connectionId}
                        schema={schema}
                        name={name}
                        arguments={args}
                        initialDefinition={definition}
                        onSaved={() => {
                            setRefreshTrigger((t) => t + 1);
                            setEditing(false);
                        }}
                        onCancel={() => setEditing(false)}
                        className="flex-1 min-h-0"
                    />
                ) : (
                    <>
                        {loading && (
                            <div className="space-y-2">
                                <Skeleton className="h-4 w-full rounded" />
                                <Skeleton className="h-4 w-3/4 rounded" />
                                <Skeleton className="h-4 w-5/6 rounded" />
                            </div>
                        )}
                        {err && (
                            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive">
                                {err}
                            </div>
                        )}
                        {!loading && !err && definition && (
                            <ScrollArea className="rounded-lg border border-border/30 bg-muted/20">
                                <pre className="p-4 text-[11px] font-mono text-foreground/90 whitespace-pre overflow-x-auto">
                                    <code>{definition}</code>
                                </pre>
                            </ScrollArea>
                        )}
                    </>
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
    const loadSchemaObjects = useConnectionStore((s) => s.loadSchemaObjects);
    const [detail, setDetail] = useState<TypeDefinitionDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [editingValues, setEditingValues] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const fetchDetail = useCallback(() => {
        if (!connectionId) return;
        setLoading(true);
        setErr(null);
        setSaveError(null);
        dbGetTypeDefinition(connectionId, schema, name)
            .then((d) => {
                setDetail(d ?? null);
                if (d == null) setErr("Type not found or not supported.");
                else if (d.kind === "enum")
                    setEditingValues(d.enum_labels?.slice() ?? []);
            })
            .catch((e) => setErr(String(e)))
            .finally(() => setLoading(false));
    }, [connectionId, schema, name]);

    useEffect(() => {
        fetchDetail();
    }, [fetchDetail]);

    useEffect(() => {
        if (detail?.kind === "enum" && detail.enum_labels)
            setEditingValues(detail.enum_labels.slice());
    }, [detail?.kind, detail?.enum_labels?.length]);

    const handleSaveEnum = useCallback(async () => {
        if (!connectionId || detail?.kind !== "enum") return;
        const original = detail.enum_labels ?? [];
        const current = editingValues.map((v) => v.trim()).filter(Boolean);
        const uniq = new Set(current);
        if (uniq.size !== current.length) {
            setSaveError("Duplicate values are not allowed.");
            return;
        }
        setSaveError(null);
        setSaving(true);
        try {
            const renames: [string, string][] = [];
            for (let i = 0; i < Math.min(original.length, current.length); i++) {
                if (original[i] !== current[i]) renames.push([original[i], current[i]]);
            }
            const additions: [string, string | null][] = current
                .slice(original.length)
                .map((v) => [v, null]);
            if (renames.length > 0 || additions.length > 0) {
                await dbAlterEnumValues(connectionId, schema, name, renames, additions);
                loadSchemaObjects(schema, undefined, true);
                fetchDetail();
            }
        } catch (e) {
            setSaveError(String(e));
        } finally {
            setSaving(false);
        }
    }, [connectionId, schema, name, detail?.kind, detail?.enum_labels, editingValues, fetchDetail, loadSchemaObjects]);

    const hasContent =
        detail &&
        ((detail.enum_labels && detail.enum_labels.length > 0) ||
            (detail.composite_attrs && detail.composite_attrs.length > 0) ||
            detail.domain_base_type != null ||
            detail.domain_check != null ||
            detail.range_subtype != null);

    const enumDirty =
        detail?.kind === "enum" &&
        (() => {
            const orig = detail.enum_labels ?? [];
            if (editingValues.length !== orig.length) return true;
            return editingValues.some((v, i) => (orig[i] ?? "") !== v);
        })();

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
                    <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive flex flex-col gap-2">
                        <span>{err}</span>
                        <Button size="sm" variant="outline" className="w-fit h-7 text-xs border-destructive/30" onClick={fetchDetail}>
                            <RefreshCw className="h-3 w-3 mr-1" /> Retry
                        </Button>
                    </div>
                )}
                {saveError && (
                    <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive mb-3">
                        {saveError}
                    </div>
                )}
                {detail && !err && (
                    <div className="rounded-xl border border-border/30 bg-card/20 overflow-hidden">
                        <dl className="p-4 space-y-3 text-xs">
                            {detail.kind === "enum" && (
                                <div>
                                    <dt className="text-muted-foreground/70 font-medium mb-1.5">Values</dt>
                                    <dd className="space-y-1.5">
                                        {editingValues.map((label, i) => (
                                            <div key={i} className="flex items-center gap-1.5">
                                                <Input
                                                    value={label}
                                                    onChange={(e) =>
                                                        setEditingValues((prev) => {
                                                            const next = [...prev];
                                                            next[i] = e.target.value;
                                                            return next;
                                                        })
                                                    }
                                                    className="h-7 text-[11px] font-mono"
                                                    placeholder="Value"
                                                />
                                            </div>
                                        ))}
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
                                            onClick={() => setEditingValues((prev) => [...prev, ""])}
                                        >
                                            + Add value
                                        </Button>
                                        {enumDirty && (
                                            <Button
                                                size="sm"
                                                className="h-7 mt-2 text-xs"
                                                disabled={saving}
                                                onClick={handleSaveEnum}
                                            >
                                                {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                                                Save
                                            </Button>
                                        )}
                                    </dd>
                                </div>
                            )}
                            {detail.enum_labels && detail.enum_labels.length > 0 && detail.kind !== "enum" && (
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
                            {!hasContent && detail.kind !== "enum" && (
                                <p className="text-muted-foreground/60">
                                    No values or attributes for this type.
                                </p>
                            )}
                        </dl>
                    </div>
                )}
            </div>
        </div>
    );
}
