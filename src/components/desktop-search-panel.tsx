"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowRight,
    Bookmark,
    BookmarkCheck,
    ChevronLeft,
    ChevronRight,
    Clock3,
    Copy,
    Database,
    Info,
    Loader2,
    MonitorUp,
    PanelLeftClose,
    PencilLine,
    Play,
    PlugZap,
    RefreshCw,
    Search,
    Table2,
    TerminalSquare,
    Trash2,
    X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    buildStructuredCommandSearchSQL,
    COMMAND_SEARCH_OPERATORS,
    parseCommandSearchInput,
    tokenizeCommandSearchInput,
    type CommandSearchStage,
} from "@/lib/command-search";
import {
    dbExecuteQuery,
    dbGetColumns,
    dbGetTableData,
    dbListEventTriggers,
    dbListFunctions,
    dbListSchemas,
    dbListTables,
    dbListTypes,
    dbSearchTableDataMulti,
} from "@/lib/db-platform";
import { isEditableTarget } from "@/lib/shortcut-keys";
import {
    dbConnect,
    dbDeleteTableRows,
    dbUpdateTableRow,
    desktopFocusMainWindow,
    desktopGetQuickSearchContext,
    desktopHideQuickSearchPanel,
    desktopSetActiveConnection,
    getSavedConnections,
    updateSavedConnectionDatabaseName,
} from "@/lib/tauri";
import type {
    CellValue,
    ColumnInfo,
    DesktopConnectedConnection,
    DesktopQuickSearchContext,
    FilterCondition,
    QueryResult,
    SavedConnection,
    TableInfo,
} from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSearchStore } from "@/stores/search-store";

function connectionSummaryLine(conn: DesktopConnectedConnection): string {
    return `${conn.database_name} · ${conn.host}`;
}

function connectionTooltipLines(conn: DesktopConnectedConnection): string {
    return `${conn.user}@${conn.host}:${conn.port}\n${conn.server_version}`;
}

/** When total_rows is 0 but rows were returned, prefer row_count or page size. */
function effectiveTotalRows(result: QueryResult): number {
    const n = result.rows.length;
    const tr = result.total_rows;
    const rc = result.row_count;
    if (tr != null && tr > 0) return tr;
    if (tr === 0 && n > 0) {
        if (rc > 0) return rc;
        return n;
    }
    if (tr != null) return tr;
    if (rc > 0) return rc;
    return n;
}

function inspectorResultFooterText(result: QueryResult): string {
    const ms = Math.max(1, result.execution_time_ms);
    const shown = result.rows.length;
    const total = effectiveTotalRows(result);
    if (shown === 0) {
        return `0 rows · ${ms.toLocaleString()} ms`;
    }
    if (total >= shown) {
        return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows · ${ms.toLocaleString()} ms`;
    }
    return `${shown.toLocaleString()} rows · ${ms.toLocaleString()} ms`;
}

type InspectorContext =
    | {
        kind: "table";
        connectionId: string;
        schema: string;
        table: string;
        label: string;
        conditions: FilterCondition[];
        sqlPreview: string;
    }
    | {
        kind: "sql";
        connectionId: string;
        label: string;
        sql: string;
    };

const PAGE_SIZE = 40;
const EXAMPLE_QUERIES = [
    "users.email ILIKE %@acme.com%",
    "orders.status = paid",
    "invoices.total > 5000",
    "SELECT * FROM public.users LIMIT 25",
];

function tableKey(schema: string, table: string): string {
    return `${schema}::${table}`;
}

function searchSignature(query: string, sql: string): string {
    return `${query.trim().toLowerCase()}::${sql.trim().toLowerCase()}`;
}

function allTokensMatch(tokens: string[], text: string): boolean {
    return tokens.every((token) => text.includes(token));
}

function scoreMatch(query: string, tokens: string[], primary: string, searchText: string): number {
    if (!query) return 0;

    let score = 0;
    const primaryLower = primary.toLowerCase();
    if (primaryLower === query) score += 160;
    if (primaryLower.startsWith(query)) score += 120;
    if (searchText.includes(query)) score += 42;

    for (const token of tokens) {
        if (primaryLower === token) score += 72;
        else if (primaryLower.startsWith(token)) score += 26;
        else if (primaryLower.includes(token)) score += 18;
        if (searchText.includes(token)) score += 8;
    }

    return score;
}

function formatAge(timestamp: number): string {
    const delta = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];

    const results = new Array<R>(items.length);
    let cursor = 0;

    async function runWorker() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index]);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
    );

    return results;
}

function cellToInputValue(cell: CellValue | undefined): string {
    if (!cell || cell.type === "Null") return "";
    return formatCellValue(cell);
}

function cellToPkValue(cell: CellValue | undefined): string | null {
    if (!cell || cell.type === "Null") return null;
    return formatCellValue(cell);
}

function hasFilterValue(operator: string): boolean {
    return operator !== "IS NULL" && operator !== "IS NOT NULL";
}

const QS_PANEL_BROWSE = { width: 980, height: 720 } as const;
const QS_PANEL_INSPECT = { width: 1240, height: 820 } as const;

async function hideCurrentDesktopPanel() {
    try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        await getCurrentWebviewWindow().hide();
    } catch {
        await desktopHideQuickSearchPanel().catch(() => {});
    }
}

async function setQuickSearchWindowLayout(inspect: boolean) {
    try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const { LogicalSize } = await import("@tauri-apps/api/window");
        const win = getCurrentWebviewWindow();
        const dim = inspect ? QS_PANEL_INSPECT : QS_PANEL_BROWSE;
        await win.setSize(new LogicalSize(dim.width, dim.height));
    } catch {
        /* Not running inside Tauri */
    }
}

export function DesktopSearchPanel() {
    const {
        recentSearches,
        savedSearches,
        addRecentSearch,
        saveSearch,
        unsaveSearch,
    } = useSearchStore();

    const [context, setContext] = useState<DesktopQuickSearchContext | null>(null);
    const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
    const [isBootstrapping, setIsBootstrapping] = useState(true);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [tables, setTables] = useState<TableInfo[]>([]);
    const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [input, setInput] = useState("");
    const [columnCache, setColumnCache] = useState<Record<string, ColumnInfo[]>>({});
    const [inspectorContext, setInspectorContext] = useState<InspectorContext | null>(null);
    const [page, setPage] = useState(1);
    const [result, setResult] = useState<QueryResult | null>(null);
    const [resultColumns, setResultColumns] = useState<ColumnInfo[]>([]);
    const [isLoadingResult, setIsLoadingResult] = useState(false);
    const [resultError, setResultError] = useState<string | null>(null);
    const [editingCell, setEditingCell] = useState<{ rowIndex: number; column: string } | null>(null);
    const [editingValue, setEditingValue] = useState("");
    const [isSavingCell, setIsSavingCell] = useState(false);
    const [deletingRowIndex, setDeletingRowIndex] = useState<number | null>(null);
    const [connectingSavedId, setConnectingSavedId] = useState<string | null>(null);
    const [debouncedTableFilter, setDebouncedTableFilter] = useState("");
    const [catalogStats, setCatalogStats] = useState<{
        functions: number;
        types: number;
        triggers: number;
    } | null>(null);
    const [catalogStatsLoading, setCatalogStatsLoading] = useState(false);

    const columnCacheRef = useRef<Record<string, ColumnInfo[]>>({});
    columnCacheRef.current = columnCache;

    const connectedConnections = useMemo(
        () => context?.connected_connections ?? [],
        [context]
    );

    const selectedConnection = useMemo<DesktopConnectedConnection | null>(
        () =>
            connectedConnections.find(
                (connection) => connection.connection_id === selectedConnectionId
            ) ?? null,
        [connectedConnections, selectedConnectionId]
    );

    const normalizedInput = input.trim().toLowerCase();
    const debouncedNormalized = debouncedTableFilter.trim().toLowerCase();
    const parsed = useMemo<CommandSearchStage>(
        () => parseCommandSearchInput(input, tables),
        [input, tables]
    );

    useEffect(() => {
        if (parsed.type !== "table" && parsed.type !== "init") {
            setDebouncedTableFilter(input);
            return;
        }
        const id = window.setTimeout(() => setDebouncedTableFilter(input), 160);
        return () => window.clearTimeout(id);
    }, [input, parsed.type]);

    const savedBySignature = useMemo(() => {
        const map = new Map<string, { id: string; label: string }>();
        for (const entry of savedSearches) {
            map.set(searchSignature(entry.query, entry.sql), {
                id: entry.id,
                label: entry.label,
            });
        }
        return map;
    }, [savedSearches]);

    const refreshDesktopContext = useCallback(async (preferredConnectionId?: string | null) => {
        setIsBootstrapping(true);
        try {
            const [quickSearchContext, availableSavedConnections] = await Promise.all([
                desktopGetQuickSearchContext(),
                getSavedConnections().catch(() => []),
            ]);

            setContext(quickSearchContext);
            setSavedConnections(availableSavedConnections);

            const nextConnectionId = preferredConnectionId
                ?? quickSearchContext.active_connection_id
                ?? quickSearchContext.connected_connections?.[0]?.connection_id
                ?? null;

            setSelectedConnectionId(nextConnectionId);
        } finally {
            setIsBootstrapping(false);
        }
    }, []);

    const hydrateCatalogStats = useCallback(async (connId: string, mergedTables: TableInfo[]) => {
        setCatalogStatsLoading(true);
        setCatalogStats(null);
        try {
            const schemaNames = Array.from(new Set(mergedTables.map((t) => t.schema))).sort();
            const [triggers, fnLists, typeLists] = await Promise.all([
                dbListEventTriggers(connId).catch(() => []),
                mapWithConcurrency(schemaNames, 4, async (schema) => {
                    try {
                        return await dbListFunctions(connId, schema);
                    } catch {
                        return [];
                    }
                }),
                mapWithConcurrency(schemaNames, 4, async (schema) => {
                    try {
                        return await dbListTypes(connId, schema);
                    } catch {
                        return [];
                    }
                }),
            ]);
            const functions = fnLists.reduce((acc, xs) => acc + xs.length, 0);
            const types = typeLists.reduce((acc, xs) => acc + xs.length, 0);
            setCatalogStats({
                functions,
                types,
                triggers: triggers.length,
            });
        } finally {
            setCatalogStatsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refreshDesktopContext();
    }, [refreshDesktopContext]);

    useEffect(() => {
        if (!selectedConnectionId) {
            setTables([]);
            setCatalogError(null);
            setIsLoadingCatalog(false);
            setCatalogStats(null);
            setInspectorContext(null);
            setResult(null);
            setResultColumns([]);
            return;
        }

        let cancelled = false;
        setIsLoadingCatalog(true);
        setCatalogError(null);
        setColumnCache({});
        setInspectorContext(null);
        setResult(null);
        setResultColumns([]);
        setPage(1);

        void (async () => {
            try {
                const schemas = await dbListSchemas(selectedConnectionId);
                const tableGroups = await mapWithConcurrency(schemas, 4, async (schema) => {
                    try {
                        return await dbListTables(selectedConnectionId, schema.name);
                    } catch {
                        return [] as TableInfo[];
                    }
                });

                if (cancelled) return;

                const mergedTables = tableGroups
                    .flat()
                    .sort((left, right) =>
                        `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`)
                    );

                setTables(mergedTables);
                void hydrateCatalogStats(selectedConnectionId, mergedTables);
            } catch (error) {
                if (!cancelled) {
                    setCatalogError(String(error));
                    setTables([]);
                }
            } finally {
                if (!cancelled) setIsLoadingCatalog(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [selectedConnectionId, hydrateCatalogStats]);

    const ensureColumns = useCallback(
        async (schema: string, table: string) => {
            if (!selectedConnectionId) return [] as ColumnInfo[];

            const key = tableKey(schema, table);
            const cached = columnCacheRef.current[key];
            if (cached) return cached;

            const loadedColumns = await dbGetColumns(selectedConnectionId, schema, table);
            setColumnCache((current) => ({ ...current, [key]: loadedColumns }));
            return loadedColumns;
        },
        [selectedConnectionId]
    );

    useEffect(() => {
        if (
            parsed.type === "column"
            || parsed.type === "operator"
            || parsed.type === "value"
        ) {
            void ensureColumns(parsed.schema, parsed.table);
        }
    }, [ensureColumns, parsed]);

    const currentColumns = useMemo(() => {
        if (
            parsed.type !== "column"
            && parsed.type !== "operator"
            && parsed.type !== "value"
        ) {
            return [] as ColumnInfo[];
        }
        return columnCache[tableKey(parsed.schema, parsed.table)] ?? [];
    }, [columnCache, parsed]);

    const filteredTables = useMemo(() => {
        if (tables.length === 0) return [] as TableInfo[];
        const stageNormalized =
            parsed.type === "table" || parsed.type === "init"
                ? debouncedNormalized
                : normalizedInput;
        const stageTokens = tokenizeCommandSearchInput(stageNormalized);
        if (!stageNormalized || parsed.type !== "table") {
            return tables.slice(0, 18);
        }

        return tables
            .map((table) => {
                const primary = `${table.schema}.${table.name}`.toLowerCase();
                const searchText = `${table.schema} ${table.name} ${table.table_comment ?? ""}`.toLowerCase();
                if (!allTokensMatch(stageTokens, searchText)) {
                    return { table, score: 0 };
                }

                return {
                    table,
                    score: scoreMatch(stageNormalized, stageTokens, primary, searchText),
                };
            })
            .filter(
                (item) =>
                    item.score > 0 || item.table.name.toLowerCase().includes(stageNormalized)
            )
            .sort((left, right) => right.score - left.score)
            .slice(0, 24)
            .map((item) => item.table);
    }, [debouncedNormalized, normalizedInput, parsed.type, tables]);

    const filteredTablesBySchema = useMemo(() => {
        const m = new Map<string, TableInfo[]>();
        for (const t of filteredTables) {
            const list = m.get(t.schema) ?? [];
            list.push(t);
            m.set(t.schema, list);
        }
        return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    }, [filteredTables]);

    const displayColumns = useMemo(() => {
        if (parsed.type === "column") {
            const filter = parsed.filter.toLowerCase();
            return (filter
                ? currentColumns.filter((column) =>
                    column.name.toLowerCase().startsWith(filter)
                )
                : currentColumns
            ).slice(0, 16);
        }

        if (parsed.type === "operator" || parsed.type === "value") {
            return currentColumns.slice(0, 16);
        }

        return [] as ColumnInfo[];
    }, [currentColumns, parsed]);

    const filteredOperators = useMemo(() => {
        if (parsed.type !== "operator") return [] as typeof COMMAND_SEARCH_OPERATORS;
        const filter = parsed.opFilter.toLowerCase();
        return (filter
            ? COMMAND_SEARCH_OPERATORS.filter(
                (operator) =>
                    operator.label.toLowerCase().startsWith(filter)
                    || operator.description.toLowerCase().includes(filter)
            )
            : COMMAND_SEARCH_OPERATORS
        ).slice(0, 10);
    }, [parsed]);

    const previewSql = useMemo(() => {
        if (parsed.type !== "value") return "";
        return buildStructuredCommandSearchSQL(
            parsed.schema,
            parsed.table,
            parsed.col,
            parsed.op,
            parsed.value
        );
    }, [parsed]);

    const loadInspector = useCallback(async () => {
        if (!inspectorContext) {
            setResult(null);
            setResultColumns([]);
            setResultError(null);
            return;
        }

        setIsLoadingResult(true);
        setResultError(null);
        setEditingCell(null);
        setEditingValue("");

        try {
            if (inspectorContext.kind === "table") {
                const [columns, tableResult] = await Promise.all([
                    ensureColumns(inspectorContext.schema, inspectorContext.table),
                    inspectorContext.conditions.length > 0
                        ? dbSearchTableDataMulti(
                            inspectorContext.connectionId,
                            inspectorContext.schema,
                            inspectorContext.table,
                            inspectorContext.conditions,
                            PAGE_SIZE,
                            page
                        )
                        : dbGetTableData(
                            inspectorContext.connectionId,
                            inspectorContext.schema,
                            inspectorContext.table,
                            page,
                            PAGE_SIZE
                        ),
                ]);

                setResultColumns(columns);
                setResult(tableResult);
            } else {
                const sqlResult = await dbExecuteQuery(
                    inspectorContext.connectionId,
                    inspectorContext.sql
                );
                setResultColumns([]);
                setResult(sqlResult);
            }
        } catch (error) {
            setResultError(String(error));
            setResult(null);
        } finally {
            setIsLoadingResult(false);
        }
    }, [ensureColumns, inspectorContext, page]);

    useEffect(() => {
        void loadInspector();
    }, [loadInspector]);

    const backToBrowse = useCallback(() => {
        setInspectorContext(null);
        setResult(null);
        setResultColumns([]);
        setResultError(null);
        setPage(1);
        setEditingCell(null);
        setEditingValue("");
    }, []);

    const isInspectMode = inspectorContext !== null;

    useEffect(() => {
        void setQuickSearchWindowLayout(isInspectMode);
    }, [isInspectMode]);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || isEditableTarget(event.target)) return;
            event.preventDefault();
            if (inspectorContext) {
                backToBrowse();
                return;
            }
            void hideCurrentDesktopPanel();
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [inspectorContext, backToBrowse]);

    const openTable = useCallback(
        async (schema: string, table: string, label?: string) => {
            if (!selectedConnectionId) return;
            const sqlPreview = `SELECT * FROM "${schema}"."${table}" LIMIT ${PAGE_SIZE}`;
            setInspectorContext({
                kind: "table",
                connectionId: selectedConnectionId,
                schema,
                table,
                label: label ?? `${schema}.${table}`,
                conditions: [],
                sqlPreview,
            });
            setPage(1);
        },
        [selectedConnectionId]
    );

    const runStructuredSearch = useCallback(
        async (
            schema: string,
            table: string,
            column: string,
            operator: string,
            value: string
        ) => {
            if (!selectedConnectionId) return;

            const label = `${table}.${column} ${operator}${hasFilterValue(operator) && value ? ` ${value}` : ""}`;
            const sql = buildStructuredCommandSearchSQL(schema, table, column, operator, value);

            addRecentSearch(label, sql);
            setInspectorContext({
                kind: "table",
                connectionId: selectedConnectionId,
                schema,
                table,
                label,
                conditions: [
                    {
                        column,
                        operator,
                        value: hasFilterValue(operator) ? value : null,
                        logical_op: "AND",
                    },
                ],
                sqlPreview: sql,
            });
            setPage(1);
        },
        [addRecentSearch, selectedConnectionId]
    );

    const runRawSql = useCallback(
        async (sql: string, label: string) => {
            if (!selectedConnectionId) return;

            addRecentSearch(label, sql);
            setInspectorContext({
                kind: "sql",
                connectionId: selectedConnectionId,
                label,
                sql,
            });
            setPage(1);
        },
        [addRecentSearch, selectedConnectionId]
    );

    const toggleSaveCurrentSearch = useCallback(() => {
        if (!inspectorContext) return;

        const query =
            inspectorContext.kind === "table"
                ? inspectorContext.label
                : inspectorContext.label;
        const sql =
            inspectorContext.kind === "table"
                ? inspectorContext.sqlPreview
                : inspectorContext.sql;
        const signature = searchSignature(query, sql);
        const existing = savedBySignature.get(signature);

        if (existing) {
            unsaveSearch(existing.id);
            return;
        }

        saveSearch(query, query, sql);
    }, [inspectorContext, saveSearch, savedBySignature, unsaveSearch]);

    const activateConnection = useCallback(async (connectionId: string) => {
        await desktopSetActiveConnection(connectionId).catch(() => {});
        setSelectedConnectionId(connectionId);
        setContext((current) =>
            current
                ? {
                    ...current,
                    active_connection_id: connectionId,
                    connected_connections: (current.connected_connections ?? []).map((item) => ({
                        ...item,
                        is_active: item.connection_id === connectionId,
                    })),
                }
                : current
        );
    }, []);

    const connectSavedConnection = useCallback(
        async (savedConnection: SavedConnection) => {
            setConnectingSavedId(savedConnection.id);
            try {
                const response = await dbConnect(
                    savedConnection.connection_string,
                    savedConnection.id,
                    savedConnection.ssh_tunnel ?? undefined
                );
                await desktopSetActiveConnection(response.connection_id).catch(() => {});
                await updateSavedConnectionDatabaseName(
                    savedConnection.id,
                    response.database_name
                ).catch(() => {});
                await refreshDesktopContext(response.connection_id);
                toast.success(`Connected to ${response.database_name}`);
            } catch (error) {
                toast.error(String(error));
            } finally {
                setConnectingSavedId(null);
            }
        },
        [refreshDesktopContext]
    );

    const copyConnectionEndpoint = useCallback(() => {
        if (!selectedConnection) return;
        const text = `${selectedConnection.user}@${selectedConnection.host}:${selectedConnection.port}`;
        void navigator.clipboard.writeText(text).then(() => {
            toast.success("Connection details copied");
        });
    }, [selectedConnection]);

    const pkColumnNames = useMemo(
        () => resultColumns.filter((column) => column.is_primary_key).map((column) => column.name),
        [resultColumns]
    );
    const resultColumnIndexes = useMemo(() => {
        if (!result?.columns?.length) return new Map<string, number>();
        return new Map(result.columns.map((column, index) => [column.name, index]));
    }, [result?.columns]);

    const saveEditedCell = useCallback(async () => {
        if (
            !editingCell
            || !inspectorContext
            || inspectorContext.kind !== "table"
            || !result
            || pkColumnNames.length === 0
        ) {
            return;
        }

        const row = result.rows[editingCell.rowIndex];
        if (!row) return;

        const columnIndex = resultColumnIndexes.get(editingCell.column);
        if (columnIndex == null) return;

        const currentCell = row[columnIndex];
        if (cellToInputValue(currentCell) === editingValue) {
            setEditingCell(null);
            setEditingValue("");
            return;
        }

        const pkValues = pkColumnNames.map((columnName) =>
            cellToPkValue(row[resultColumnIndexes.get(columnName) ?? -1])
        );

        setIsSavingCell(true);
        try {
            await dbUpdateTableRow(
                inspectorContext.connectionId,
                inspectorContext.schema,
                inspectorContext.table,
                pkColumnNames,
                pkValues,
                [
                    {
                        column: editingCell.column,
                        value: editingValue.trim() === "" ? null : editingValue.trim(),
                    },
                ]
            );

            setEditingCell(null);
            setEditingValue("");
            await loadInspector();
        } catch (error) {
            toast.error(String(error));
        } finally {
            setIsSavingCell(false);
        }
    }, [
        editingCell,
        editingValue,
        inspectorContext,
        loadInspector,
        pkColumnNames,
        result,
        resultColumnIndexes,
    ]);

    const deleteRow = useCallback(
        async (rowIndex: number) => {
            if (
                !inspectorContext
                || inspectorContext.kind !== "table"
                || !result
                || pkColumnNames.length === 0
            ) {
                return;
            }

            const row = result.rows[rowIndex];
            if (!row) return;

            const pkValues = pkColumnNames.map((columnName) =>
                cellToPkValue(row[resultColumnIndexes.get(columnName) ?? -1])
            );

            setDeletingRowIndex(rowIndex);
            try {
                await dbDeleteTableRows(
                    inspectorContext.connectionId,
                    inspectorContext.schema,
                    inspectorContext.table,
                    pkColumnNames,
                    [pkValues]
                );
                toast.success("Row deleted");
                await loadInspector();
            } catch (error) {
                toast.error(String(error));
            } finally {
                setDeletingRowIndex(null);
            }
        },
        [inspectorContext, loadInspector, pkColumnNames, result, resultColumnIndexes]
    );

    const canEditRows = inspectorContext?.kind === "table" && pkColumnNames.length > 0;
    const hasCurrentSearchSaved = useMemo(() => {
        if (!inspectorContext) return false;
        if (inspectorContext.kind === "table") {
            return savedBySignature.has(
                searchSignature(inspectorContext.label, inspectorContext.sqlPreview)
            );
        }
        return savedBySignature.has(
            searchSignature(inspectorContext.label, inspectorContext.sql)
        );
    }, [inspectorContext, savedBySignature]);

    const renderInspectorEmptyState = () => (
        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-[16px] border border-white/[0.1] bg-white/[0.06] shadow-[0_12px_40px_-8px_rgba(0,0,0,0.4)]">
                <Search className="h-7 w-7 text-emerald-300/80" />
            </div>
            <h2 className="mt-5 text-xl font-semibold text-foreground/95">
                Search across live table data
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground/85">
                Use plain table names to browse data, or structured filters like
                <span className="mx-1 rounded bg-white/5 px-1.5 py-0.5 font-mono text-sm text-emerald-200">
                    users.email ILIKE %@acme.com%
                </span>
                to jump straight into the rows you need.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                {EXAMPLE_QUERIES.map((example) => (
                    <button
                        key={example}
                        type="button"
                        onClick={() => setInput(example)}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-foreground/80 transition hover:border-emerald-400/40 hover:bg-emerald-400/10 hover:text-foreground"
                    >
                        {example}
                    </button>
                ))}
            </div>
        </div>
    );

    const currentPage = result?.page ?? page;
    const totalRowsForPaging = result ? effectiveTotalRows(result) : 0;
    const totalPages = Math.max(1, Math.ceil(totalRowsForPaging / PAGE_SIZE));

    const inspectorSql =
        inspectorContext
            ? inspectorContext.kind === "table"
                ? inspectorContext.sqlPreview
                : inspectorContext.sql
            : "";

    const footerStatsText = useMemo(() => {
        const n = tables.length;
        if (catalogStatsLoading) {
            return `${n} tables · …`;
        }
        if (!catalogStats) {
            return `${n} tables`;
        }
        return `${n} tables · ${catalogStats.functions} functions · ${catalogStats.types} types · ${catalogStats.triggers} triggers`;
    }, [tables.length, catalogStats, catalogStatsLoading]);

    return (
        <div className="box-border flex h-screen w-screen overflow-hidden bg-transparent p-0 text-foreground antialiased [isolation:isolate]">
            <div
                className={cn(
                    "relative flex h-full min-h-0 w-full overflow-hidden rounded-[20px]",
                    // No border / inset ring — those show as light fringing on macOS vibrancy + WKWebView corners.
                    "bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(16,185,129,0.1),transparent_52%),radial-gradient(ellipse_90%_60%_at_100%_0%,rgba(14,165,233,0.08),transparent_48%),linear-gradient(165deg,rgba(22,28,38,0.94)_0%,rgba(10,13,18,0.96)_45%,rgba(8,11,16,0.97)_100%)]",
                    // Soft outer depth only (matches native window shadow; avoids corner halos from inset strokes).
                    "shadow-[0_14px_40px_-10px_rgba(0,0,0,0.5)]",
                    "transform-gpu [backface-visibility:hidden]"
                )}
            >
                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[20px]">
                    <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_100%_100%_at_50%_-30%,rgba(94,234,212,0.08),transparent_72%)]" />
                </div>

                <div
                    className={cn(
                        "relative z-[1] flex shrink-0 flex-col border-r border-white/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] backdrop-blur-xl transition-[width,min-width,max-width] duration-300 ease-out",
                        isInspectMode
                            ? "w-[92px] min-w-[92px] max-w-[92px]"
                            : "w-[420px] min-w-[22rem] max-w-[26rem]"
                    )}
                >
                    {isInspectMode ? (
                        <div className="flex h-full min-h-0 flex-col items-center gap-3 py-4">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 shrink-0 rounded-full border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                                        onClick={backToBrowse}
                                        aria-label="Back to search"
                                    >
                                        <PanelLeftClose className="h-5 w-5" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="text-xs">
                                    Back to search
                                </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 shrink-0 rounded-full border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                                        onClick={() => void refreshDesktopContext(selectedConnectionId)}
                                        disabled={isBootstrapping}
                                        aria-label="Refresh connections"
                                    >
                                        <RefreshCw className={cn("h-5 w-5", isBootstrapping && "animate-spin")} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="text-xs">
                                    Refresh
                                </TooltipContent>
                            </Tooltip>
                            <div className="min-h-0 flex-1" />
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 shrink-0 rounded-full border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                                        onClick={() => void hideCurrentDesktopPanel()}
                                        aria-label="Hide quick search panel"
                                    >
                                        <X className="h-5 w-5" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="text-xs">
                                    Close panel
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    ) : (
                    <>
                    <div className="border-b border-white/10 px-5 py-5">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs font-medium tracking-wide text-emerald-200/80">
                                    Desktop Search
                                </p>
                                <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground/95">
                                    Quick data access
                                </h1>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10 rounded-full border border-white/10 bg-white/5 text-muted-foreground/80 hover:bg-white/10 hover:text-foreground"
                                    onClick={() => void refreshDesktopContext(selectedConnectionId)}
                                    disabled={isBootstrapping}
                                    aria-label="Refresh quick search context"
                                >
                                    <RefreshCw className={cn("h-5 w-5", isBootstrapping && "animate-spin")} />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10 rounded-full border border-white/10 bg-white/5 text-muted-foreground/80 hover:bg-white/10 hover:text-foreground"
                                    onClick={() => void hideCurrentDesktopPanel()}
                                    aria-label="Hide quick search panel"
                                >
                                    <X className="h-5 w-5" />
                                </Button>
                            </div>
                        </div>

                        <div className="mt-4 space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                    variant="outline"
                                    className="border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-100"
                                >
                                    {selectedConnection ? "Live connection" : "No live connection"}
                                </Badge>
                                {selectedConnection && (
                                    <Badge
                                        variant="outline"
                                        className="border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground"
                                    >
                                        {selectedConnection.server_version}
                                    </Badge>
                                )}
                            </div>

                            {connectedConnections.length ? (
                                <Select
                                    value={selectedConnectionId ?? undefined}
                                    onValueChange={(value) => void activateConnection(value)}
                                >
                                    <SelectTrigger className="h-12 rounded-[14px] border-white/[0.1] bg-white/[0.05] text-sm shadow-none">
                                        <SelectValue placeholder="Select a live connection" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {connectedConnections.map((connection) => (
                                            <SelectItem
                                                key={connection.connection_id}
                                                value={connection.connection_id}
                                            >
                                                {connection.database_name} · {connection.host}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <div className="rounded-[14px] border border-dashed border-white/[0.12] bg-white/[0.03] px-3 py-3 text-sm text-muted-foreground/85">
                                    Connect a saved database below, or jump to the full workspace.
                                </div>
                            )}
                        </div>
                    </div>

                    <Command
                        shouldFilter={false}
                        className="min-h-0 flex-1 border-0 bg-transparent [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
                    >
                        <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3">
                            <CommandInput
                                value={input}
                                onValueChange={setInput}
                                placeholder={
                                    selectedConnectionId
                                        ? "Search tables or run table.column = value"
                                        : "Pick or connect a database first"
                                }
                                disabled={!selectedConnectionId}
                                className="text-sm"
                            />
                        </div>

                        <CommandList className="max-h-none flex-1 px-2 py-2">
                            {connectedConnections.length ? (
                                <CommandGroup heading="Connections">
                                    {connectedConnections.map((connection) => (
                                        <CommandItem
                                            key={connection.connection_id}
                                            value={`conn-${connection.connection_id}`}
                                            onSelect={() => void activateConnection(connection.connection_id)}
                                            className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                        >
                                            <Database className="h-5 w-5 text-emerald-300/75" />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium text-foreground/90">
                                                    {connection.database_name}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground/75">
                                                    {connection.user}@{connection.host}:{connection.port}
                                                </p>
                                            </div>
                                            {connection.is_active && (
                                                <CommandShortcut className="tracking-normal text-emerald-200/80">
                                                    Active
                                                </CommandShortcut>
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            ) : null}

                            {!connectedConnections.length && savedConnections.length > 0 && (
                                <CommandGroup heading="Saved connections">
                                    {savedConnections.map((connection) => (
                                        <CommandItem
                                            key={connection.id}
                                            value={`saved-connection-${connection.id}`}
                                            onSelect={() => void connectSavedConnection(connection)}
                                            className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                        >
                                            {connectingSavedId === connection.id ? (
                                                <Loader2 className="h-5 w-5 animate-spin text-emerald-300/80" />
                                            ) : (
                                                <PlugZap className="h-5 w-5 text-emerald-300/75" />
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium text-foreground/90">
                                                    {connection.name}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground/75">
                                                    {connection.database_name ?? connection.connection_string}
                                                </p>
                                            </div>
                                            <CommandShortcut className="tracking-normal">
                                                Connect
                                            </CommandShortcut>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {selectedConnectionId && (
                                <>
                                    <CommandSeparator className="my-2 bg-white/8" />

                                    {(parsed.type === "init" || parsed.type === "table") &&
                                        filteredTablesBySchema.length > 0 &&
                                        filteredTablesBySchema.map(([schemaName, schemaTables]) => (
                                            <CommandGroup key={schemaName} heading={schemaName}>
                                                {schemaTables.map((table) => (
                                                    <CommandItem
                                                        key={tableKey(table.schema, table.name)}
                                                        value={tableKey(table.schema, table.name)}
                                                        onSelect={() => void openTable(table.schema, table.name)}
                                                        className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                                    >
                                                        <Table2 className="h-5 w-5 text-cyan-300/80" />
                                                        <div className="min-w-0 flex-1">
                                                            <p className="truncate text-sm font-medium text-foreground/90">
                                                                {table.name}
                                                            </p>
                                                            <p className="truncate text-xs text-muted-foreground/75">
                                                                {table.table_comment || table.table_type}
                                                            </p>
                                                        </div>
                                                        <CommandShortcut className="tracking-normal">
                                                            Browse
                                                        </CommandShortcut>
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        ))}

                                    {parsed.type === "column" && displayColumns.length > 0 && (
                                        <CommandGroup heading="Columns">
                                            {displayColumns.map((column) => (
                                                <CommandItem
                                                    key={`column-${column.name}`}
                                                    value={`column-${column.name}`}
                                                    onSelect={() => setInput(`${parsed.table}.${column.name} `)}
                                                    className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                                >
                                                    <Search className="h-5 w-5 text-emerald-300/75" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate font-mono text-sm text-foreground/90">
                                                            {column.name}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground/75">
                                                            {column.data_type}
                                                        </p>
                                                    </div>
                                                    <CommandShortcut className="tracking-normal">
                                                        Filter
                                                    </CommandShortcut>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    )}

                                    {parsed.type === "operator" && filteredOperators.length > 0 && (
                                        <CommandGroup heading="Operators">
                                            {filteredOperators.map((operator) => (
                                                <CommandItem
                                                    key={operator.label}
                                                    value={`operator-${operator.label}`}
                                                    onSelect={() => {
                                                        const suffix = operator.noValue ? "" : " ";
                                                        setInput(`${parsed.table}.${parsed.col} ${operator.label}${suffix}`);
                                                    }}
                                                    className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                                >
                                                    <ArrowRight className="h-5 w-5 text-emerald-300/75" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-medium text-foreground/90">
                                                            {operator.label}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground/75">
                                                            {operator.description}
                                                        </p>
                                                    </div>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    )}

                                    {parsed.type === "value" && (
                                        <CommandGroup heading="Run query">
                                            <CommandItem
                                                value="run-structured-query"
                                                onSelect={() =>
                                                    void runStructuredSearch(
                                                        parsed.schema,
                                                        parsed.table,
                                                        parsed.col,
                                                        parsed.op,
                                                        parsed.value
                                                    )
                                                }
                                                className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                            >
                                                <Play className="h-5 w-5 text-emerald-300/80" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium text-foreground/90">
                                                        Run structured search
                                                    </p>
                                                    <p className="truncate font-mono text-xs text-muted-foreground/75">
                                                        {previewSql}
                                                    </p>
                                                </div>
                                                <CommandShortcut className="tracking-normal">
                                                    Enter
                                                </CommandShortcut>
                                            </CommandItem>
                                        </CommandGroup>
                                    )}

                                    {parsed.type === "raw_sql" && (
                                        <CommandGroup heading="Execute SQL">
                                            <CommandItem
                                                value="run-raw-sql"
                                                onSelect={() =>
                                                    void runRawSql(
                                                        parsed.sql,
                                                        parsed.sql.length > 64
                                                            ? `${parsed.sql.slice(0, 64)}...`
                                                            : parsed.sql
                                                    )
                                                }
                                                className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                            >
                                                <TerminalSquare className="h-5 w-5 text-cyan-300/80" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium text-foreground/90">
                                                        Run SQL in panel
                                                    </p>
                                                    <p className="truncate font-mono text-xs text-muted-foreground/75">
                                                        {parsed.sql}
                                                    </p>
                                                </div>
                                                <CommandShortcut className="tracking-normal">
                                                    Read-only
                                                </CommandShortcut>
                                            </CommandItem>
                                        </CommandGroup>
                                    )}

                                    {savedSearches.length > 0 && (
                                        <CommandGroup heading="Saved searches">
                                            {savedSearches.slice(0, 6).map((search) => (
                                                <CommandItem
                                                    key={search.id}
                                                    value={`saved-search-${search.id}`}
                                                    onSelect={() => {
                                                        const savedParsed = parseCommandSearchInput(search.query, tables);
                                                        if (savedParsed.type === "value") {
                                                            void runStructuredSearch(
                                                                savedParsed.schema,
                                                                savedParsed.table,
                                                                savedParsed.col,
                                                                savedParsed.op,
                                                                savedParsed.value
                                                            );
                                                            return;
                                                        }
                                                        void runRawSql(search.sql, search.label || search.query);
                                                    }}
                                                    className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                                >
                                                    <BookmarkCheck className="h-5 w-5 text-emerald-300/80" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-foreground/90">
                                                            {search.label || search.query}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground/75">
                                                            {search.query}
                                                        </p>
                                                    </div>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    )}

                                    {recentSearches.length > 0 && (
                                        <CommandGroup heading="Recent">
                                            {recentSearches.slice(0, 6).map((recent, index) => (
                                                <CommandItem
                                                    key={`${recent.timestamp}-${index}`}
                                                    value={`recent-search-${index}`}
                                                    onSelect={() => setInput(recent.query)}
                                                    className="cursor-pointer rounded-[14px] px-3 py-3.5"
                                                >
                                                    <Clock3 className="h-5 w-5 text-muted-foreground/80" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm text-foreground/90">
                                                            {recent.query}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground/70">
                                                            {formatAge(recent.timestamp)}
                                                        </p>
                                                    </div>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    )}
                                </>
                            )}

                            {selectedConnectionId && !isLoadingCatalog && filteredTables.length === 0 && parsed.type === "table" && (
                                <CommandEmpty>
                                    No tables match <span className="font-mono">{input}</span>
                                </CommandEmpty>
                            )}

                            {catalogError && (
                                <div className="rounded-[14px] border border-red-400/20 bg-red-400/10 px-3 py-3 text-sm text-red-100/80">
                                    {catalogError}
                                </div>
                            )}
                        </CommandList>
                        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5">
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/40">
                                <span>↑↓ navigate</span>
                                <span>↵ select</span>
                                <span>esc back or close</span>
                            </div>
                            {selectedConnectionId ? (
                                <span
                                    className="max-w-[55%] shrink-0 truncate text-[10px] font-mono text-muted-foreground/35"
                                    title={footerStatsText}
                                >
                                    {footerStatsText}
                                </span>
                            ) : null}
                        </div>
                    </Command>

                    <div className="border-t border-white/10 px-4 py-3">
                        <Button
                            variant="outline"
                            className="h-10 w-full rounded-[14px] border-white/[0.12] bg-white/[0.05] text-sm hover:bg-white/[0.08]"
                            onClick={() => void desktopFocusMainWindow()}
                        >
                            <MonitorUp className="mr-2 h-5 w-5" />
                            Open full workspace
                        </Button>
                    </div>
                    </>
                    )}
                </div>

                <div
                    className={cn(
                        "relative z-[1] flex min-w-0 flex-1 flex-col transition-[flex-grow] duration-300 ease-out",
                        isInspectMode && "min-w-0"
                    )}
                >
                    <div className="border-b border-white/[0.06] px-7 pb-5 pt-7 sm:px-8 sm:pt-8">
                        <div className="flex items-start justify-between gap-5">
                            <div className="min-w-0 flex-1 pr-2">
                                <p className="text-xs font-medium tracking-wide text-cyan-200/85">
                                    Live Inspector
                                </p>
                                <h2 className="mt-1.5 truncate text-2xl font-semibold tracking-tight text-foreground/95">
                                    {inspectorContext
                                        ? inspectorContext.kind === "table"
                                            ? `${inspectorContext.schema}.${inspectorContext.table}`
                                            : inspectorContext.label
                                        : selectedConnection
                                            ? `${selectedConnection.database_name} · ${selectedConnection.host}`
                                            : "No active connection"}
                                </h2>
                                {inspectorContext ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <p className="mt-3 w-full cursor-default truncate text-left font-mono text-sm leading-relaxed text-muted-foreground">
                                                {inspectorSql}
                                            </p>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="bottom"
                                            hideArrow
                                            className="max-w-[min(90vw,36rem)] text-left font-mono text-xs whitespace-pre-wrap"
                                        >
                                            {inspectorSql}
                                        </TooltipContent>
                                    </Tooltip>
                                ) : null}
                            </div>

                            <div className="flex shrink-0 items-center gap-2.5 pt-0.5 sm:gap-3">
                                {isInspectMode ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-10 rounded-full border border-white/[0.08] bg-white/[0.06] px-4 text-sm hover:bg-white/[0.1]"
                                        onClick={backToBrowse}
                                    >
                                        <PanelLeftClose className="mr-2 h-4 w-4" />
                                        Search
                                    </Button>
                                ) : null}
                                {inspectorContext && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-10 rounded-full border border-white/[0.08] bg-white/[0.06] px-4 text-sm hover:bg-white/[0.1]"
                                        onClick={toggleSaveCurrentSearch}
                                    >
                                        {hasCurrentSearchSaved ? (
                                            <BookmarkCheck className="mr-2 h-4 w-4 text-emerald-300/85" />
                                        ) : (
                                            <Bookmark className="mr-2 h-4 w-4 text-muted-foreground/80" />
                                        )}
                                        {hasCurrentSearchSaved ? "Saved" : "Save search"}
                                    </Button>
                                )}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-10 rounded-full border border-white/[0.08] bg-white/[0.06] px-4 text-sm hover:bg-white/[0.1]"
                                    onClick={() => void loadInspector()}
                                    disabled={isLoadingResult}
                                >
                                    <RefreshCw className={cn("mr-2 h-4 w-4", isLoadingResult && "animate-spin")} />
                                    Refresh
                                </Button>
                            </div>
                        </div>

                        {selectedConnection ? (
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            className="inline-flex max-w-[min(100%,24rem)] min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-left text-xs text-foreground outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <span className="truncate">{connectionSummaryLine(selectedConnection)}</span>
                                            <Info className="h-4 w-4 shrink-0 opacity-55" aria-hidden />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        hideArrow
                                        className="max-w-md whitespace-pre-wrap text-left"
                                    >
                                        {connectionTooltipLines(selectedConnection)}
                                    </TooltipContent>
                                </Tooltip>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-9 w-9 shrink-0 rounded-full border border-white/10 bg-white/5"
                                    onClick={copyConnectionEndpoint}
                                    aria-label="Copy user@host:port"
                                >
                                    <Copy className="h-4 w-4" />
                                </Button>
                                <Badge variant="outline" className="border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground">
                                    {selectedConnection.server_version}
                                </Badge>
                                {canEditRows ? (
                                    <Badge variant="outline" className="border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-100">
                                        <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                                        Editable
                                    </Badge>
                                ) : inspectorContext?.kind === "table" ? (
                                    <Badge variant="outline" className="border-white/10 bg-white/5 px-3 py-1.5 text-xs">
                                        View only
                                    </Badge>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    <div className="min-h-0 flex-1">
                        {!selectedConnectionId && !isBootstrapping ? (
                            renderInspectorEmptyState()
                        ) : !inspectorContext ? (
                            renderInspectorEmptyState()
                        ) : isLoadingResult ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="rounded-[14px] border border-white/[0.09] bg-white/[0.05] px-4 py-3 text-sm text-muted-foreground/85">
                                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                                    Loading rows…
                                </div>
                            </div>
                        ) : resultError ? (
                            <div className="flex h-full items-center justify-center px-8">
                                <div className="max-w-lg rounded-3xl border border-red-400/20 bg-red-400/10 p-6 text-sm text-red-50/85 shadow-[0_24px_65px_rgba(0,0,0,0.35)]">
                                    <p className="font-semibold">Couldn’t load data</p>
                                    <p className="mt-2 whitespace-pre-wrap break-words text-red-100/70">
                                        {resultError}
                                    </p>
                                </div>
                            </div>
                        ) : !result ? (
                            renderInspectorEmptyState()
                        ) : (
                            <div className="flex h-full min-h-0 flex-col">
                                <div className="border-b border-white/[0.06] px-7 py-3 text-sm leading-relaxed text-muted-foreground sm:px-8">
                                    {inspectorResultFooterText(result)}
                                </div>

                                <ScrollArea className="min-h-0 flex-1">
                                    <div className="min-w-max px-7 py-4 sm:px-8">
                                        <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
                                            <TableHeader>
                                                <TableRow className="border-b-0 hover:bg-transparent">
                                                    <TableHead className="sticky top-0 z-10 border-b border-white/10 bg-[#101924] px-4 py-3 text-left font-mono text-xs font-medium text-muted-foreground">
                                                        #
                                                    </TableHead>
                                                    {result.columns.map((column) => (
                                                        <TableHead
                                                            key={column.name}
                                                            className="sticky top-0 z-10 border-b border-white/10 bg-[#101924] px-4 py-3 text-left font-mono text-xs font-medium text-muted-foreground"
                                                        >
                                                            {column.name}
                                                        </TableHead>
                                                    ))}
                                                    {canEditRows ? (
                                                        <TableHead className="sticky top-0 z-10 border-b border-white/10 bg-[#101924] px-4 py-3 text-right font-mono text-xs font-medium text-muted-foreground">
                                                            Row
                                                        </TableHead>
                                                    ) : null}
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {result.rows.map((row, rowIndex) => (
                                                    <TableRow
                                                        key={`row-${rowIndex}`}
                                                        className="group border-b-0 hover:bg-white/[0.04]"
                                                    >
                                                        <TableCell className="border-b border-white/6 px-4 py-2.5 text-sm text-muted-foreground">
                                                            {(rowIndex + 1 + (currentPage - 1) * PAGE_SIZE).toLocaleString()}
                                                        </TableCell>
                                                        {result.columns.map((column, columnIndex) => {
                                                            const activeEditing =
                                                                editingCell?.rowIndex === rowIndex
                                                                && editingCell.column === column.name;
                                                            const editable =
                                                                canEditRows
                                                                && !pkColumnNames.includes(column.name)
                                                                && inspectorContext.kind === "table";
                                                            const cell = row[columnIndex];

                                                            return (
                                                                <TableCell
                                                                    key={`${rowIndex}-${column.name}`}
                                                                    className="max-w-[280px] border-b border-white/6 px-4 py-2.5 align-top"
                                                                >
                                                                    {activeEditing ? (
                                                                        <Input
                                                                            autoFocus
                                                                            value={editingValue}
                                                                            onChange={(event) => setEditingValue(event.target.value)}
                                                                            onBlur={() => void saveEditedCell()}
                                                                            onKeyDown={(event) => {
                                                                                if (event.key === "Enter") {
                                                                                    event.preventDefault();
                                                                                    void saveEditedCell();
                                                                                }
                                                                                if (event.key === "Escape") {
                                                                                    event.preventDefault();
                                                                                    setEditingCell(null);
                                                                                    setEditingValue("");
                                                                                }
                                                                            }}
                                                                            className="h-10 w-[min(18rem,100%)] rounded-lg border-emerald-400/30 bg-emerald-400/10"
                                                                        />
                                                                    ) : (
                                                                        <button
                                                                            type="button"
                                                                            onDoubleClick={() => {
                                                                                if (!editable) return;
                                                                                setEditingCell({
                                                                                    rowIndex,
                                                                                    column: column.name,
                                                                                });
                                                                                setEditingValue(cellToInputValue(cell));
                                                                            }}
                                                                            className={cn(
                                                                                "max-w-[280px] rounded-lg px-2 py-1 text-left text-sm leading-6 text-foreground/90",
                                                                                editable
                                                                                    ? "cursor-text transition hover:bg-white/7"
                                                                                    : "cursor-default"
                                                                            )}
                                                                            title={formatCellValue(cell)}
                                                                        >
                                                                            <span className={cn(
                                                                                "block truncate",
                                                                                cell?.type === "Null" && "italic text-muted-foreground/55"
                                                                            )}>
                                                                                {cell?.type === "Null" ? "NULL" : formatCellValue(cell)}
                                                                            </span>
                                                                        </button>
                                                                    )}
                                                                </TableCell>
                                                            );
                                                        })}
                                                        {canEditRows ? (
                                                            <TableCell className="border-b border-white/6 px-4 py-2.5 text-right">
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-9 w-9 rounded-full border border-transparent bg-transparent text-muted-foreground/70 opacity-0 transition group-hover:border-white/10 group-hover:bg-white/5 group-hover:opacity-100 hover:text-red-100"
                                                                    onClick={() => void deleteRow(rowIndex)}
                                                                    disabled={deletingRowIndex === rowIndex}
                                                                >
                                                                    {deletingRowIndex === rowIndex ? (
                                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                                    ) : (
                                                                        <Trash2 className="h-4 w-4" />
                                                                    )}
                                                                </Button>
                                                            </TableCell>
                                                        ) : null}
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </table>
                                    </div>
                                    <ScrollBar orientation="horizontal" />
                                    <ScrollBar orientation="vertical" />
                                </ScrollArea>

                                <div className="flex items-center justify-between border-t border-white/[0.06] px-7 py-3.5 sm:px-8">
                                    <div className="text-xs leading-relaxed text-muted-foreground">
                                        {canEditRows
                                            ? "Double-click a cell to edit. Empty input saves as NULL."
                                            : inspectorContext.kind === "sql"
                                                ? "Raw SQL results stay read-only in the quick panel."
                                                : "This table needs a primary key for inline edits."}
                                        {isSavingCell && (
                                            <span className="ml-2 inline-flex items-center gap-1 text-emerald-200/80">
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                Saving…
                                            </span>
                                        )}
                                    </div>

                                    {inspectorContext.kind === "table" && (
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-10 rounded-full border border-white/10 bg-white/5 px-4 text-sm hover:bg-white/10"
                                                onClick={() => setPage((current) => Math.max(1, current - 1))}
                                                disabled={currentPage <= 1}
                                            >
                                                <ChevronLeft className="mr-1.5 h-4 w-4" />
                                                Prev
                                            </Button>
                                            <span className="text-sm text-muted-foreground">
                                                Page {currentPage} / {totalPages}
                                            </span>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-10 rounded-full border border-white/10 bg-white/5 px-4 text-sm hover:bg-white/10"
                                                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                                                disabled={currentPage >= totalPages}
                                            >
                                                Next
                                                <ChevronRight className="ml-1.5 h-4 w-4" />
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
