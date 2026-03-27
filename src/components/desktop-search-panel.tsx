"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Bookmark,
    BookmarkCheck,
    Database,
    Loader2,
    MonitorUp,
    PanelLeftClose,
    RefreshCw,
    Table2,
    Unplug,
    Wifi,
    X,
} from "lucide-react";
import { toast } from "sonner";

import { CommandPalette } from "@/components/command-palette";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
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
import { dbExecuteQuery } from "@/lib/db-platform";
import { isEditableTarget } from "@/lib/shortcut-keys";
import {
    dbConnect,
    desktopFocusMainWindow,
    desktopGetQuickSearchContext,
    desktopHideQuickSearchPanel,
    desktopRepositionQuickSearchPanel,
    desktopResizeQuickSearchPanel,
    desktopSetActiveConnection,
    getSavedConnections,
    updateSavedConnectionDatabaseName,
} from "@/lib/tauri";
import type {
    DesktopConnectedConnection,
    DesktopQuickSearchContext,
    QueryResult,
    SavedConnection,
} from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import {
    getQuickSearchLastSavedId,
    setQuickSearchLastSavedId,
} from "@/lib/quick-search-prefs";
import { cn } from "@/lib/utils";
import { useSearchStore } from "@/stores/search-store";

function searchSignature(query: string, sql: string): string {
    return `${query.trim().toLowerCase()}::${sql.trim().toLowerCase()}`;
}

function connectionTooltipLines(conn: DesktopConnectedConnection): string {
    return `${conn.user}@${conn.host}:${conn.port}\n${conn.server_version}`;
}

const PICKER_LIVE_PREFIX = "hqlive:" as const;
const PICKER_SAVED_PREFIX = "hqsaved:" as const;

function pickerLiveValue(id: string): string {
    return `${PICKER_LIVE_PREFIX}${id}`;
}

function pickerSavedValue(id: string): string {
    return `${PICKER_SAVED_PREFIX}${id}`;
}

function savedProfileSubtitle(saved: SavedConnection): string {
    if (saved.database_name?.trim()) {
        return `${saved.name} · ${saved.database_name}`;
    }
    return saved.connection_string;
}

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

function sqlResultFooterText(result: QueryResult): string {
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

type SqlInspectorContext = {
    connectionId: string;
    label: string;
    sql: string;
};

/** Logical size for Tauri `desktop_resize_quick_search_panel` — keep in sync with `desktop_panel.rs` `quick_search_sizes`. */
const QS_SEARCH = { width: 580, height: 720 } as const;
const QS_TABLE = { width: 1480, height: 920 } as const;
const QS_SQL_SPLIT = { width: 1080, height: 800 } as const;

/** Rounded shell aligned with macOS window vibrancy radius (~22pt). */
const spotlightCardClass =
    "flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[22px] border border-border/25 bg-gradient-to-b from-card/98 via-card/95 to-muted/35 shadow-[0_28px_90px_-28px_rgba(0,0,0,0.72)] ring-1 ring-inset ring-white/[0.05] backdrop-blur-xl";

async function hideCurrentDesktopPanel() {
    try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        await getCurrentWebviewWindow().hide();
    } catch {
        await desktopHideQuickSearchPanel().catch(() => {});
    }
}

async function setQuickSearchWindowSize(width: number, height: number) {
    const w = Math.max(width, 380);
    const h = Math.max(height, 420);
    try {
        await desktopResizeQuickSearchPanel(w, h);
    } catch {
        try {
            const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const { LogicalSize } = await import("@tauri-apps/api/window");
            await getCurrentWebviewWindow().setSize(new LogicalSize(w, h));
            await desktopRepositionQuickSearchPanel().catch(() => {});
        } catch {
            /* not Tauri */
        }
    }
}

export function DesktopSearchPanel() {
    const { savedSearches, saveSearch, unsaveSearch } = useSearchStore();

    const [context, setContext] = useState<DesktopQuickSearchContext | null>(null);
    const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
    const [isBootstrapping, setIsBootstrapping] = useState(true);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [connectingSavedId, setConnectingSavedId] = useState<string | null>(null);

    const [dataTableTarget, setDataTableTarget] = useState<{ schema: string; table: string } | null>(null);
    const [sqlInspector, setSqlInspector] = useState<SqlInspectorContext | null>(null);

    const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);
    const [sqlLoading, setSqlLoading] = useState(false);
    const [sqlError, setSqlError] = useState<string | null>(null);

    const connectSavedInflightRef = useRef(false);
    const triedAutoConnectRef = useRef(false);

    const connectedConnections = useMemo(() => context?.connected_connections ?? [], [context]);

    const showConnectionPicker =
        savedConnections.length > 0 || connectedConnections.length > 0;

    const { savedPickerRows, orphanConnections } = useMemo(() => {
        const savedSorted = [...savedConnections].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        const connById = new Map(
            connectedConnections.map((c) => [c.connection_id, c] as const)
        );
        const savedPickerRows = savedSorted.map((saved) => {
            const conn = connById.get(saved.id);
            return conn
                ? ({ kind: "live-saved" as const, saved, conn })
                : ({ kind: "offline-saved" as const, saved });
        });
        const savedIds = new Set(savedConnections.map((s) => s.id));
        const orphanConnections = connectedConnections
            .filter((c) => !savedIds.has(c.connection_id))
            .sort((a, b) => {
                const byDb = a.database_name.localeCompare(b.database_name, undefined, {
                    sensitivity: "base",
                });
                if (byDb !== 0) return byDb;
                return a.host.localeCompare(b.host);
            });
        return { savedPickerRows, orphanConnections };
    }, [savedConnections, connectedConnections]);

    const pickerSelectValue = useMemo(() => {
        if (!selectedConnectionId) return undefined;
        const isLive = connectedConnections.some((c) => c.connection_id === selectedConnectionId);
        return isLive ? pickerLiveValue(selectedConnectionId) : undefined;
    }, [selectedConnectionId, connectedConnections]);

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

            const live = quickSearchContext.connected_connections ?? [];
            const liveIds = new Set(live.map((c) => c.connection_id));

            const preferred =
                preferredConnectionId && liveIds.has(preferredConnectionId)
                    ? preferredConnectionId
                    : null;
            const activeFromHost =
                quickSearchContext.active_connection_id &&
                liveIds.has(quickSearchContext.active_connection_id)
                    ? quickSearchContext.active_connection_id
                    : null;

            const nextConnectionId =
                preferred ?? activeFromHost ?? live[0]?.connection_id ?? null;

            setSelectedConnectionId(nextConnectionId);
            if (nextConnectionId) {
                void desktopSetActiveConnection(nextConnectionId);
                if (availableSavedConnections.some((s) => s.id === nextConnectionId)) {
                    setQuickSearchLastSavedId(nextConnectionId);
                }
            } else {
                triedAutoConnectRef.current = false;
            }
        } finally {
            setIsBootstrapping(false);
        }
    }, []);

    useEffect(() => {
        void refreshDesktopContext();
    }, [refreshDesktopContext]);

    useEffect(() => {
        if (dataTableTarget) {
            void setQuickSearchWindowSize(QS_TABLE.width, QS_TABLE.height);
            return;
        }
        if (sqlInspector) {
            void setQuickSearchWindowSize(QS_SQL_SPLIT.width, QS_SQL_SPLIT.height);
            return;
        }
        void setQuickSearchWindowSize(QS_SEARCH.width, QS_SEARCH.height);
    }, [dataTableTarget, sqlInspector]);

    const activateConnection = useCallback(
        async (connectionId: string) => {
            await desktopSetActiveConnection(connectionId).catch(() => {});
            setSelectedConnectionId(connectionId);
            if (savedConnections.some((s) => s.id === connectionId)) {
                setQuickSearchLastSavedId(connectionId);
            }
            setDataTableTarget(null);
            setSqlInspector(null);
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
        },
        [savedConnections]
    );

    const connectSavedConnection = useCallback(
        async (savedConnection: SavedConnection) => {
            if (connectSavedInflightRef.current) return;
            connectSavedInflightRef.current = true;
            setConnectingSavedId(savedConnection.id);
            try {
                const response = await dbConnect(
                    savedConnection.connection_string,
                    savedConnection.id,
                    savedConnection.ssh_tunnel ?? undefined
                );
                setQuickSearchLastSavedId(savedConnection.id);
                await desktopSetActiveConnection(response.connection_id).catch(() => {});
                await updateSavedConnectionDatabaseName(
                    savedConnection.id,
                    response.database_name
                ).catch(() => {});
                await refreshDesktopContext(response.connection_id);
                setDataTableTarget(null);
                setSqlInspector(null);
                toast.success(`Connected to ${response.database_name}`);
            } catch (error) {
                toast.error(String(error));
            } finally {
                connectSavedInflightRef.current = false;
                setConnectingSavedId(null);
            }
        },
        [refreshDesktopContext]
    );

    useEffect(() => {
        if (isBootstrapping) return;
        if (selectedConnectionId || connectingSavedId) return;
        if (savedConnections.length === 0 || connectedConnections.length > 0) return;
        if (triedAutoConnectRef.current) return;

        triedAutoConnectRef.current = true;
        const last = getQuickSearchLastSavedId();
        const sorted = [...savedConnections].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        const saved =
            (last ? savedConnections.find((s) => s.id === last) : undefined) ?? sorted[0];
        if (saved) void connectSavedConnection(saved);
    }, [
        isBootstrapping,
        selectedConnectionId,
        connectingSavedId,
        savedConnections,
        connectedConnections.length,
        connectSavedConnection,
    ]);

    const onPickerValueChange = useCallback(
        (value: string) => {
            if (value.startsWith(PICKER_LIVE_PREFIX)) {
                void activateConnection(value.slice(PICKER_LIVE_PREFIX.length));
                return;
            }
            if (value.startsWith(PICKER_SAVED_PREFIX)) {
                const id = value.slice(PICKER_SAVED_PREFIX.length);
                const saved = savedConnections.find((s) => s.id === id);
                if (saved) void connectSavedConnection(saved);
            }
        },
        [savedConnections, activateConnection, connectSavedConnection]
    );

    const openDesktopTable = useCallback(
        (schema: string, table: string) => {
            if (!selectedConnectionId) return;
            setSqlInspector(null);
            setSqlResult(null);
            setSqlError(null);
            setDataTableTarget({ schema, table });
        },
        [selectedConnectionId]
    );

    const onDesktopSqlRun = useCallback(
        (sql: string, label: string) => {
            if (!selectedConnectionId) return;
            setDataTableTarget(null);
            setSqlInspector({
                connectionId: selectedConnectionId,
                label,
                sql,
            });
        },
        [selectedConnectionId]
    );

    const loadSql = useCallback(async () => {
        if (!sqlInspector) {
            setSqlResult(null);
            setSqlError(null);
            return;
        }
        setSqlLoading(true);
        setSqlError(null);
        try {
            const res = await dbExecuteQuery(sqlInspector.connectionId, sqlInspector.sql);
            setSqlResult(res);
        } catch (e) {
            setSqlError(String(e));
            setSqlResult(null);
        } finally {
            setSqlLoading(false);
        }
    }, [sqlInspector]);

    useEffect(() => {
        void loadSql();
    }, [loadSql]);

    const clearSql = useCallback(() => {
        setSqlInspector(null);
        setSqlResult(null);
        setSqlError(null);
    }, []);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || isEditableTarget(event.target)) return;
            event.preventDefault();
            if (dataTableTarget) {
                setDataTableTarget(null);
                return;
            }
            if (sqlInspector) {
                clearSql();
                return;
            }
            void hideCurrentDesktopPanel();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [dataTableTarget, sqlInspector, clearSql]);

    const toggleSaveSqlSearch = useCallback(() => {
        if (!sqlInspector) return;
        const signature = searchSignature(sqlInspector.label, sqlInspector.sql);
        const existing = savedBySignature.get(signature);
        if (existing) {
            unsaveSearch(existing.id);
            return;
        }
        saveSearch(sqlInspector.label, sqlInspector.label, sqlInspector.sql);
    }, [sqlInspector, saveSearch, savedBySignature, unsaveSearch]);

    const sqlSearchSaved = useMemo(() => {
        if (!sqlInspector) return false;
        return savedBySignature.has(searchSignature(sqlInspector.label, sqlInspector.sql));
    }, [sqlInspector, savedBySignature]);

    /* —— Full table view (same DataTable as main workspace) —— */
    if (dataTableTarget && selectedConnectionId) {
        return (
            <div className="box-border flex h-screen w-screen min-h-0 flex-col overflow-hidden bg-transparent text-foreground">
                <div className={cn(spotlightCardClass, "bg-card/95")}>
                    <div className="flex h-[38px] min-h-[38px] shrink-0 items-stretch border-b border-border/30 bg-muted/15">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-full shrink-0 rounded-none rounded-tl-[55px] border-r border-border/30 px-3 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                            onClick={() => setDataTableTarget(null)}
                        >
                            <PanelLeftClose className="mr-1.5 h-3.5 w-3.5" />
                            Search
                        </Button>
                        <div
                            className="flex min-w-0 flex-1 items-center gap-2 border-r border-border/30 bg-background/80 px-3"
                            title={`${dataTableTarget.schema}.${dataTableTarget.table}`}
                        >
                            <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/85" aria-hidden />
                            <span className="truncate font-mono text-[12.5px] font-medium text-emerald-600 dark:text-emerald-300/95">
                                {dataTableTarget.table}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/60">{dataTableTarget.schema}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 px-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                onClick={() => void refreshDesktopContext(selectedConnectionId)}
                                disabled={isBootstrapping}
                                aria-label="Refresh"
                            >
                                <RefreshCw className={cn("h-3.5 w-3.5", isBootstrapping && "animate-spin")} />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg rounded-tr-[55px]"
                                onClick={() => void hideCurrentDesktopPanel()}
                                aria-label="Close panel"
                            >
                                <X className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden rounded-b-[55px] bg-background">
                        <DataTable
                            connectionId={selectedConnectionId}
                            schema={dataTableTarget.schema}
                            table={dataTableTarget.table}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="box-border flex h-screen w-screen min-h-0 flex-col overflow-hidden bg-transparent text-foreground">
            <div
                className={cn(
                    spotlightCardClass,
                    "mx-auto flex min-h-0 flex-1",
                    sqlInspector ? "max-w-[min(1280px,calc(100%-4px))]" : "max-w-[min(584px,calc(100%-4px))]"
                )}
            >
                <div
                    className={cn(
                        "flex min-h-0 min-w-0 flex-1",
                        sqlInspector ? "flex-row" : "flex-col"
                    )}
                >
                    <div
                        className={cn(
                            "flex min-h-0 min-w-0 flex-col",
                            sqlInspector ? "w-[min(360px,34vw)] shrink-0 border-r border-border/20" : "w-full flex-1"
                        )}
                    >
                        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/20 bg-muted/[0.08] px-3 backdrop-blur-[2px]">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                {isBootstrapping ? (
                                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Syncing…
                                    </span>
                                ) : showConnectionPicker ? (
                                    <Select
                                        value={pickerSelectValue}
                                        onValueChange={onPickerValueChange}
                                        disabled={connectingSavedId !== null}
                                    >
                                        <SelectTrigger
                                            size="sm"
                                            aria-label="Database connection"
                                            className="h-8 min-w-[10.5rem] max-w-[min(320px,62vw)] rounded-[10px] border border-border/35 bg-gradient-to-b from-background/85 to-muted/25 px-2.5 text-left text-[11px] font-medium leading-tight shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] gap-2 [&_svg:not([class*='size-])]:size-3.5 data-[placeholder]:text-muted-foreground"
                                        >
                                            <Database
                                                className={cn(
                                                    "h-3.5 w-3.5 shrink-0",
                                                    pickerSelectValue
                                                        ? "text-emerald-500/90"
                                                        : "text-muted-foreground/55"
                                                )}
                                                aria-hidden
                                            />
                                            <SelectValue placeholder="Choose database…" />
                                        </SelectTrigger>
                                        <SelectContent
                                            className="max-h-[min(380px,55vh)] w-[min(340px,calc(100vw-24px))] text-xs"
                                            align="start"
                                            sideOffset={6}
                                        >
                                            {savedPickerRows.length > 0 ? (
                                                <SelectGroup>
                                                    <SelectLabel className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                                                        Saved profiles
                                                    </SelectLabel>
                                                    {savedPickerRows.map((row) =>
                                                        row.kind === "live-saved" ? (
                                                            <SelectItem
                                                                key={pickerLiveValue(row.conn.connection_id)}
                                                                value={pickerLiveValue(row.conn.connection_id)}
                                                                className="cursor-pointer py-2.5 pl-8 pr-2 text-xs"
                                                                title={connectionTooltipLines(row.conn)}
                                                            >
                                                                <span className="flex w-full items-start gap-2 text-left">
                                                                    <Wifi
                                                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500/80"
                                                                        aria-hidden
                                                                    />
                                                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                                        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
                                                                            <span className="font-medium text-foreground/95">
                                                                                {row.saved.name}
                                                                            </span>
                                                                            <span className="text-[10px] font-medium text-emerald-500/85">
                                                                                {row.conn.is_active ? "active" : "live"}
                                                                            </span>
                                                                        </span>
                                                                        <span className="truncate font-mono text-[10px] text-muted-foreground/75">
                                                                            {row.conn.user}@{row.conn.host}:{row.conn.port}
                                                                        </span>
                                                                    </span>
                                                                </span>
                                                            </SelectItem>
                                                        ) : (
                                                            <SelectItem
                                                                key={pickerSavedValue(row.saved.id)}
                                                                value={pickerSavedValue(row.saved.id)}
                                                                disabled={connectingSavedId === row.saved.id}
                                                                className="cursor-pointer py-2.5 pl-8 pr-2 text-xs"
                                                                title={row.saved.connection_string}
                                                            >
                                                                <span className="flex w-full items-start gap-2 text-left">
                                                                    <Unplug
                                                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                                                                        aria-hidden
                                                                    />
                                                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                                        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
                                                                            <span className="font-medium text-foreground/90">
                                                                                {row.saved.name}
                                                                            </span>
                                                                            <span className="text-[10px] font-normal text-muted-foreground/65">
                                                                                offline
                                                                            </span>
                                                                        </span>
                                                                        <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                                                                            {savedProfileSubtitle(row.saved)}
                                                                        </span>
                                                                    </span>
                                                                </span>
                                                            </SelectItem>
                                                        )
                                                    )}
                                                </SelectGroup>
                                            ) : null}
                                            {orphanConnections.length > 0 ? (
                                                <>
                                                    {savedPickerRows.length > 0 ? (
                                                        <SelectSeparator className="my-1 bg-border/60" />
                                                    ) : null}
                                                    <SelectGroup>
                                                        <SelectLabel className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                                                            Other active sessions
                                                        </SelectLabel>
                                                        {orphanConnections.map((c) => (
                                                        <SelectItem
                                                            key={pickerLiveValue(c.connection_id)}
                                                            value={pickerLiveValue(c.connection_id)}
                                                            className="cursor-pointer py-2.5 pl-8 pr-2 text-xs"
                                                            title={connectionTooltipLines(c)}
                                                        >
                                                            <span className="flex w-full items-start gap-2 text-left">
                                                                <Wifi
                                                                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500/80"
                                                                    aria-hidden
                                                                />
                                                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                                    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
                                                                        <span className="font-medium text-foreground/95">
                                                                            {c.database_name}
                                                                        </span>
                                                                        <span className="text-[10px] font-normal text-muted-foreground/65">
                                                                            unsaved
                                                                        </span>
                                                                        {c.is_active ? (
                                                                            <span className="text-[10px] font-medium text-emerald-500/85">
                                                                                active
                                                                            </span>
                                                                        ) : null}
                                                                    </span>
                                                                    <span className="truncate font-mono text-[10px] text-muted-foreground/75">
                                                                        {c.user}@{c.host}:{c.port}
                                                                    </span>
                                                                </span>
                                                            </span>
                                                        </SelectItem>
                                                        ))}
                                                    </SelectGroup>
                                                </>
                                            ) : null}
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <span className="text-[11px] text-muted-foreground">No active connection</span>
                                )}
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 rounded-full"
                                    onClick={() => void refreshDesktopContext(selectedConnectionId)}
                                    disabled={isBootstrapping}
                                    aria-label="Refresh connections"
                                >
                                    <RefreshCw className={cn("h-3.5 w-3.5", isBootstrapping && "animate-spin")} />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 rounded-full"
                                    onClick={() => void hideCurrentDesktopPanel()}
                                    aria-label="Close panel"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>

                        {isBootstrapping ? (
                            <div className="flex flex-1 items-center justify-center py-12 text-sm text-muted-foreground">
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Loading…
                            </div>
                        ) : (
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                {connectingSavedId && !selectedConnectionId ? (
                                    <div className="flex shrink-0 items-center gap-2 border-b border-border/20 bg-muted/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground">
                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-500" />
                                        Connecting saved profile…
                                    </div>
                                ) : null}
                                <CommandPalette
                                    open
                                    onOpenChange={() => {}}
                                    onNavigateToQuery={() => {}}
                                    onNavigateToTable={() => {}}
                                    onNavigateToData={() => {}}
                                    desktopConnectionId={selectedConnectionId}
                                    onDesktopTableSelect={(sch, tbl) => openDesktopTable(sch, tbl)}
                                    onDesktopSqlRun={onDesktopSqlRun}
                                    embedded
                                    embeddedSuppressFooter={Boolean(sqlInspector)}
                                    className="min-h-0 flex-1"
                                />
                                {!selectedConnectionId && !showConnectionPicker ? (
                                    <div className="shrink-0 border-t border-border/15 bg-muted/[0.04] px-3 py-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-8 w-full rounded-full border-border/35 text-xs font-medium"
                                            onClick={() => void desktopFocusMainWindow()}
                                        >
                                            <MonitorUp className="mr-2 h-3.5 w-3.5 opacity-80" />
                                            Open full workspace
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>

                    <div
                        className={cn(
                            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border/15 bg-muted/10",
                            !sqlInspector && "hidden"
                        )}
                    >
                        {sqlInspector ? (
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                <div className="shrink-0 border-b border-border/20 bg-muted/20">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <div className="flex items-center gap-2">
                                                <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/80" aria-hidden />
                                                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/85">
                                                    Results
                                                </p>
                                            </div>
                                            <p className="truncate font-mono text-[13px] font-medium text-foreground/95">
                                                {sqlInspector.label}
                                            </p>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <p className="line-clamp-1 cursor-default font-mono text-[10px] text-muted-foreground/70">
                                                        {sqlInspector.sql}
                                                    </p>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                    side="bottom"
                                                    className="max-w-xl whitespace-pre-wrap font-mono text-xs"
                                                    hideArrow
                                                >
                                                    {sqlInspector.sql}
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 rounded-full px-2.5 text-[11px]"
                                                onClick={toggleSaveSqlSearch}
                                            >
                                                {sqlSearchSaved ? (
                                                    <BookmarkCheck className="mr-1 h-3 w-3 text-emerald-500" />
                                                ) : (
                                                    <Bookmark className="mr-1 h-3 w-3" />
                                                )}
                                                {sqlSearchSaved ? "Saved" : "Save"}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 rounded-full px-2.5 text-[11px]"
                                                onClick={() => void loadSql()}
                                                disabled={sqlLoading}
                                            >
                                                <RefreshCw
                                                    className={cn("mr-1 h-3 w-3", sqlLoading && "animate-spin")}
                                                />
                                                Refresh
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 rounded-full px-2.5 text-[11px]"
                                                onClick={clearSql}
                                            >
                                                Close
                                            </Button>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5">
                                    {sqlLoading ? (
                                        <div className="flex min-h-[12rem] flex-1 items-center justify-center">
                                            <div className="flex items-center gap-2 rounded-xl border border-border/30 bg-card/80 px-4 py-2.5 text-xs text-muted-foreground">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Running query…
                                            </div>
                                        </div>
                                    ) : sqlError ? (
                                        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
                                            <div className="max-w-md rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm">
                                                <p className="font-semibold text-destructive">Query failed</p>
                                                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive/90">
                                                    {sqlError}
                                                </p>
                                            </div>
                                        </div>
                                    ) : !sqlResult ? (
                                        <div className="flex min-h-[10rem] flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/35 bg-background/40 px-4 py-8 text-center text-muted-foreground">
                                            <Table2 className="h-8 w-8 opacity-20" />
                                            <p className="text-sm">Awaiting result</p>
                                        </div>
                                    ) : sqlResult.rows.length === 0 ? (
                                        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-border/30 bg-background/50 px-4 py-10 text-center">
                                            <Table2 className="h-10 w-10 text-muted-foreground/25" />
                                            <div>
                                                <p className="text-sm font-medium text-foreground/90">No rows returned</p>
                                                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                                                    The query ran successfully; the result set is empty.
                                                </p>
                                                <p className="mt-3 font-mono text-[11px] tabular-nums text-muted-foreground/80">
                                                    {sqlResultFooterText(sqlResult)}
                                                </p>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/30 bg-card/40 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
                                            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/25 bg-muted/30 px-3 py-1.5">
                                                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                                                    {sqlResultFooterText(sqlResult)}
                                                </span>
                                                <span className="text-[10px] text-muted-foreground/55">
                                                    {sqlResult.columns.length} column
                                                    {sqlResult.columns.length === 1 ? "" : "s"}
                                                </span>
                                            </div>
                                            <div className="min-h-0 flex-1 overflow-auto">
                                                <table className="w-full border-collapse text-left text-xs">
                                                    <TableHeader className="sticky top-0 z-10 border-b border-border/40 bg-muted/50">
                                                        <TableRow className="border-0 hover:bg-transparent">
                                                            <TableHead className="h-9 w-10 bg-muted/50 px-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-md">
                                                                #
                                                            </TableHead>
                                                            {sqlResult.columns.map((col) => (
                                                                <TableHead
                                                                    key={col.name}
                                                                    className="h-9 min-w-[7rem] max-w-[24rem] bg-muted/50 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-foreground/85 backdrop-blur-md"
                                                                >
                                                                    <span className="block truncate" title={col.name}>
                                                                        {col.name}
                                                                    </span>
                                                                </TableHead>
                                                            ))}
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                        {sqlResult.rows.map((row, i) => (
                                                            <TableRow
                                                                key={i}
                                                                className={cn(
                                                                    "border-b border-border/10 transition-colors hover:bg-muted/35",
                                                                    i % 2 === 1 && "bg-muted/15"
                                                                )}
                                                            >
                                                                <TableCell className="px-2 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                                                                    {(i + 1).toLocaleString()}
                                                                </TableCell>
                                                                {sqlResult.columns.map((col, j) => {
                                                                    const cell = row[j];
                                                                    return (
                                                                        <TableCell
                                                                            key={col.name}
                                                                            className="max-w-[min(20rem,32vw)] px-2.5 py-1.5 align-top"
                                                                        >
                                                                            <span
                                                                                className={cn(
                                                                                    "block font-mono text-[11px] leading-snug",
                                                                                    cell?.type === "Null"
                                                                                        ? "italic text-muted-foreground/45"
                                                                                        : "text-foreground/90"
                                                                                )}
                                                                                title={formatCellValue(cell)}
                                                                            >
                                                                                {cell?.type === "Null"
                                                                                    ? "NULL"
                                                                                    : formatCellValue(cell)}
                                                                            </span>
                                                                        </TableCell>
                                                                    );
                                                                })}
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <p className="shrink-0 border-t border-border/15 bg-muted/10 px-3 py-1 text-[10px] text-muted-foreground/65">
                                    Read-only · edit in main workspace
                                </p>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
