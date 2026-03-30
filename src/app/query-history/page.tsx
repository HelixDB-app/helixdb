"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from "recharts";
import { APP_NAME } from "@/lib/app-config";
import {
    dbPgStatStatementsEnable,
    dbPgStatStatementsList,
    dbPgStatStatementsStatus,
    dbExecuteQuery,
    dbExplainQuery,
    queryHistoryExportCsv,
    queryHistoryGetDashboard,
    queryHistoryGetDetail,
    queryHistoryList,
    queryHistorySaveAiAnalysis,
    queryHistorySaveExplain,
    queryHistorySaveNote,
    queryHistoryToggleBookmark,
    slowQueryGetInsight,
    slowQueryIngestFromPgStat,
    slowQueryListPinnedFingerprints,
    slowQuerySaveAiForFingerprint,
    slowQuerySaveExplainForFingerprint,
    slowQuerySaveNoteForFingerprint,
    slowQuerySetPinnedForFingerprint,
    slowQuerySnapshotsForFingerprint,
    slowQueryListTrendRisks,
} from "@/lib/tauri";
import {
    analyzeQueryPerformance,
    parseQueryOptimizationPayload,
} from "@/lib/query-optimization-engine";
import {
    analyzePerformanceForecast,
    computeExecutionTrendMetrics,
} from "@/lib/query-performance-forecast-engine";
import type {
    QueryHistoryDashboard,
    QueryHistoryDetail,
    QueryHistoryFilter,
    QueryHistoryListResponse,
    QueryHistorySummary,
    PgStatStatementEntry,
    PgStatStatementsFilter,
    PgStatStatementsStatus,
    PerformanceForecastPayload,
    SlowQueryInsight,
    SlowQuerySnapshotRecord,
    SlowQueryTrendRisk,
} from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { QueryPlanViewer } from "@/components/query-plan-viewer";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { PgStatStatementsSetupCallout } from "@/components/pg-stat-statements-setup-callout";
import { QueryHistoryPerformanceDashboard } from "@/components/query-history-performance-dashboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    Clock3,
    Copy,
    Database,
    Download,
    Flame,
    Layers,
    Loader2,
    Pin,
    PinOff,
    Play,
    RefreshCw,
    Search,
    Sparkles,
    TrendingUp,
    WandSparkles,
    Shield,
} from "lucide-react";
import { toast } from "sonner";
import { buildPerformanceReplayBundle, downloadReplayBundle } from "@/lib/performance-replay";

type RangeKey = "1h" | "today" | "7d" | "30d" | "all";
type StatusChip = "all" | "slow" | "failed" | "cached";
type SortKey = "slowest" | "recent" | "frequency" | "disk" | "rows" | "errors" | "table";
type ViewMode = "history" | "dashboard";
type HistorySource = "local" | "pg_stat";

function formatMs(ms: number): string {
    if (!Number.isFinite(ms)) return "-";
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)}s`;
    return `${Math.round(ms)}ms`;
}

function formatNumber(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return "-";
    return value.toLocaleString();
}

function timeAgo(epochMs: number): string {
    const diff = Date.now() - epochMs;
    if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(epochMs).toLocaleDateString();
}

function clampPreview(text: string, max = 120): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max)}…`;
}

function severityLabel(item: QueryHistorySummary): {
    dot: string;
    textClass: string;
    label: string;
} {
    if (item.status === "failed") {
        return { dot: "⚫", textClass: "text-red-300", label: "Failed" };
    }
    if (item.was_cached) {
        return { dot: "🔵", textClass: "text-cyan-300", label: "Cached" };
    }
    if (item.total_ms >= 3000) {
        return { dot: "🔴", textClass: "text-red-300", label: "Very slow" };
    }
    if (item.total_ms >= 1000) {
        return { dot: "🟠", textClass: "text-orange-300", label: "Slow" };
    }
    if (item.total_ms >= 200) {
        return { dot: "🟡", textClass: "text-yellow-300", label: "Moderate" };
    }
    return { dot: "🟢", textClass: "text-emerald-300", label: "Fast" };
}

function severityFromMeanMs(ms: number): { dot: string; textClass: string; label: string } {
    if (ms >= 3000) return { dot: "🔴", textClass: "text-red-300", label: "Very slow" };
    if (ms >= 1000) return { dot: "🟠", textClass: "text-orange-300", label: "Slow" };
    if (ms >= 200) return { dot: "🟡", textClass: "text-yellow-300", label: "Moderate" };
    return { dot: "🟢", textClass: "text-emerald-300", label: "Fast" };
}

function csvDownload(content: string, filename: string) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

function rangeBounds(range: RangeKey): { from: number | null; to: number | null } {
    const now = Date.now();
    switch (range) {
        case "1h":
            return { from: now - 60 * 60 * 1000, to: now };
        case "today": {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return { from: d.getTime(), to: now };
        }
        case "7d":
            return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
        case "30d":
            return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
        default:
            return { from: null, to: null };
    }
}

function sortValue(sortBy: SortKey): string {
    switch (sortBy) {
        case "slowest":
            return "total_ms";
        case "recent":
            return "executed_at";
        case "frequency":
            return "frequency";
        case "disk":
            return "blks_read";
        case "rows":
            return "rows_returned";
        case "errors":
            return "errors";
        case "table":
            return "table";
    }
}

function QueryRow({
    item,
    active,
    onClick,
}: {
    item: QueryHistorySummary;
    active: boolean;
    onClick: () => void;
}) {
    const severity = severityLabel(item);
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "w-full rounded-xl border p-3 text-left transition-all",
                active
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-border/40 bg-card/20 hover:border-border/70 hover:bg-card/40"
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs">{severity.dot}</span>
                    <span className={cn("text-xs font-mono", severity.textClass)}>{formatMs(item.total_ms)}</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-border/50">
                        {item.query_type}
                    </Badge>
                    {item.environment && <ConnectionEnvBadge environment={item.environment} compact />}
                    {item.bookmark && <Pin className="h-3 w-3 text-amber-300" />}
                </div>
                <span className="text-[11px] text-muted-foreground/70 shrink-0">{timeAgo(item.executed_at)}</span>
            </div>

            <p className="mt-2 text-[12px] font-mono text-foreground/90 line-clamp-2">
                {clampPreview(item.query_text, 180)}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/70">
                <span>Rows: {formatNumber(item.rows_returned ?? item.rows_affected ?? 0)}</span>
                <span>Disk: {formatNumber(item.blks_read ?? 0)}</span>
                <span>Runs: {formatNumber(item.run_count)}</span>
                {item.tables_touched.length > 0 && (
                    <span className="truncate max-w-[200px]">{item.tables_touched.join(", ")}</span>
                )}
            </div>
        </button>
    );
}

function PgStatRow({
    item,
    active,
    onClick,
    pinned,
    trendRisk,
}: {
    item: PgStatStatementEntry;
    active: boolean;
    onClick: () => void;
    pinned?: boolean;
    /** From local snapshot trend ranking (high | medium | low). */
    trendRisk?: string | null;
}) {
    const severity = severityFromMeanMs(item.mean_exec_time_ms);
    const rowsPerCall = item.calls > 0 ? item.rows / item.calls : 0;

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "w-full rounded-xl border p-3 text-left transition-all",
                active
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : trendRisk === "high"
                      ? "border-amber-500/40 bg-amber-500/[0.06] hover:border-amber-500/55 hover:bg-amber-500/10"
                      : trendRisk === "medium"
                        ? "border-border/40 bg-card/20 hover:border-amber-500/25 hover:bg-card/35"
                        : "border-border/40 bg-card/20 hover:border-border/70 hover:bg-card/40"
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs">{severity.dot}</span>
                    <span className={cn("text-xs font-mono", severity.textClass)}>{formatMs(item.mean_exec_time_ms)}</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-border/50">
                        avg
                    </Badge>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-red-400/40 text-red-300">
                        slow≈{formatNumber(item.slow_call_estimate)}
                    </Badge>
                    {trendRisk === "high" ? (
                        <Badge variant="outline" className="h-5 border-amber-500/40 px-1.5 text-[10px] text-amber-200">
                            trend risk
                        </Badge>
                    ) : null}
                    {pinned ? <Pin className="h-3 w-3 text-amber-300" /> : null}
                </div>
                <span className="text-[11px] text-muted-foreground/70 shrink-0">
                    calls {formatNumber(item.calls)}
                </span>
            </div>

            <p className="mt-2 text-[12px] font-mono text-foreground/90 line-clamp-2">
                {clampPreview(item.query, 180)}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/70">
                <span>Total: {formatMs(item.total_exec_time_ms)}</span>
                <span>Max: {formatMs(item.max_exec_time_ms)}</span>
                <span>Rows/call: {formatNumber(rowsPerCall)}</span>
                <span>Disk: {formatNumber(item.shared_blks_read)}</span>
                <span>Hit: {item.hit_percent.toFixed(1)}%</span>
            </div>
        </button>
    );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-lg border border-border/40 bg-card/20 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</p>
            <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
            {hint && <p className="mt-1 text-[11px] text-muted-foreground/70">{hint}</p>}
        </div>
    );
}

export default function QueryHistoryPage() {
    const isConnected = useConnectionStore((state) => state.isConnected);
    const connectionId = useConnectionStore((state) => state.connectionId);
    const databaseName = useConnectionStore((state) => state.databaseName);
    const queryHistoryAutoSnapshotPgStat = useSettingsStore((s) => s.queryHistoryAutoSnapshotPgStat);
    const updateSettings = useSettingsStore((s) => s.updateSettings);

    const LOCAL_PAGE_SIZE = 200;
    const PG_STAT_PAGE_SIZE = 200;
    const MAX_IN_MEMORY_ROWS = 4000;

    const [viewMode, setViewMode] = useState<ViewMode>("history");
    const [source, setSource] = useState<HistorySource>("local");
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [range, setRange] = useState<RangeKey>("7d");
    const [statusChip, setStatusChip] = useState<StatusChip>("all");
    const [sortBy, setSortBy] = useState<SortKey>("slowest");
    const [selectedConnection, setSelectedConnection] = useState<string>("all");
    const [queryType, setQueryType] = useState<"all" | "SELECT" | "DML" | "DDL">("all");
    const [groupByHash, setGroupByHash] = useState(false);
    const [bookmarksOnly, setBookmarksOnly] = useState(false);

    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState<string | null>(null);
    const [listData, setListData] = useState<QueryHistoryListResponse | null>(null);
    const [localLoadingMore, setLocalLoadingMore] = useState(false);
    const [localHasMore, setLocalHasMore] = useState(false);
    const [localNextOffset, setLocalNextOffset] = useState(0);

    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [detail, setDetail] = useState<QueryHistoryDetail | null>(null);
    const [noteDraft, setNoteDraft] = useState("");
    const [replayRedact, setReplayRedact] = useState(true);
    const [isExportingReplay, setIsExportingReplay] = useState(false);

    const [dashboardLoading, setDashboardLoading] = useState(false);
    const [dashboardError, setDashboardError] = useState<string | null>(null);
    const [dashboard, setDashboard] = useState<QueryHistoryDashboard | null>(null);

    const [pgStatStatusLoading, setPgStatStatusLoading] = useState(false);
    const [pgStatStatusError, setPgStatStatusError] = useState<string | null>(null);
    const [pgStatStatus, setPgStatStatus] = useState<PgStatStatementsStatus | null>(null);
    const [pgStatItems, setPgStatItems] = useState<PgStatStatementEntry[]>([]);
    const [pgStatTotalCount, setPgStatTotalCount] = useState(0);
    const [pgStatLoading, setPgStatLoading] = useState(false);
    const [pgStatLoadingMore, setPgStatLoadingMore] = useState(false);
    const [pgStatError, setPgStatError] = useState<string | null>(null);
    const [pgStatNextOffset, setPgStatNextOffset] = useState(0);
    const [pgStatHasMore, setPgStatHasMore] = useState(false);
    const [selectedPgStatId, setSelectedPgStatId] = useState<string | null>(null);

    const [isCapturingExplain, setIsCapturingExplain] = useState(false);
    const [isGeneratingAi, setIsGeneratingAi] = useState(false);
    const [isRunningAgain, setIsRunningAgain] = useState(false);
    const [isSavingNote, setIsSavingNote] = useState(false);
    const [isEnablingPgStat, setIsEnablingPgStat] = useState(false);

    const [pgStatPinnedOnly, setPgStatPinnedOnly] = useState(false);
    const [pinnedFingerprints, setPinnedFingerprints] = useState<string[]>([]);
    const [slowSnapshots, setSlowSnapshots] = useState<SlowQuerySnapshotRecord[]>([]);
    const [slowInsight, setSlowInsight] = useState<SlowQueryInsight | null>(null);
    const [pgStatNoteDraft, setPgStatNoteDraft] = useState("");
    const [isIngestingSlow, setIsIngestingSlow] = useState(false);
    const [isCapturingExplainPg, setIsCapturingExplainPg] = useState(false);
    const [isSavingPgStatNote, setIsSavingPgStatNote] = useState(false);
    const autoSnapshotPgRef = useRef(false);

    const [connectionTrendRisks, setConnectionTrendRisks] = useState<SlowQueryTrendRisk[]>([]);
    const [performanceForecast, setPerformanceForecast] = useState<PerformanceForecastPayload | null>(null);
    const [isForecastingPerformance, setIsForecastingPerformance] = useState(false);

    const [refreshTick, setRefreshTick] = useState(0);

    const pgStatStatusErrorDisplay =
        !pgStatStatusError?.trim() || pgStatStatusError === "db error"
            ? "Could not check the extension. Verify your database connection and that you have permission to read system catalogs (e.g. pg_extension, pg_settings)."
            : pgStatStatusError;

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 200);
        return () => window.clearTimeout(timer);
    }, [search]);

    const rangeWindow = useMemo(() => rangeBounds(range), [range]);

    const filter = useMemo<QueryHistoryFilter>(() => {
        const out: QueryHistoryFilter = {
            search_text: debouncedSearch || null,
            connection_id: selectedConnection === "all" ? null : selectedConnection,
            query_type: queryType === "all" ? null : queryType,
            min_time_ms: statusChip === "slow" ? 1000 : null,
            status: statusChip === "failed" ? "failed" : null,
            was_cached: statusChip === "cached" ? true : null,
            bookmark_only: bookmarksOnly,
            from_time: rangeWindow.from,
            to_time: rangeWindow.to,
            sort_by: sortValue(sortBy),
            sort_dir: "desc",
            limit: null,
            offset: null,
        };

        return out;
    }, [
        debouncedSearch,
        selectedConnection,
        queryType,
        statusChip,
        bookmarksOnly,
        rangeWindow.from,
        rangeWindow.to,
        sortBy,
    ]);

    const pgStatFilter = useMemo<PgStatStatementsFilter>(() => {
        const sortMap: Record<SortKey, string> = {
            slowest: "slowest",
            recent: "total",
            frequency: "calls",
            disk: "disk",
            rows: "rows",
            errors: "max",
            table: "total",
        };
        return {
            search_text: debouncedSearch || null,
            min_mean_ms: statusChip === "slow" ? 1000 : null,
            sort_by: sortMap[sortBy],
            sort_dir: "DESC",
            limit: null,
            offset: null,
        };
    }, [debouncedSearch, statusChip, sortBy]);

    const refreshList = useCallback(() => {
        setRefreshTick((x) => x + 1);
    }, []);

    useEffect(() => {
        if (source !== "local") return;

        let cancelled = false;
        setListLoading(true);
        setListError(null);
        setLocalLoadingMore(false);
        setLocalHasMore(false);
        setLocalNextOffset(0);

        queryHistoryList({
            ...filter,
            limit: LOCAL_PAGE_SIZE,
            offset: 0,
        })
            .then((response) => {
                if (cancelled) return;
                setListData(response);
                setLocalNextOffset(response.items.length);
                setLocalHasMore(response.items.length < response.total_count);
                setSelectedConnection((current) => {
                    if (current === "all") return current;
                    const exists = response.connections.some((c) => c.connection_id === current);
                    return exists ? current : "all";
                });
                setSelectedId((current) => {
                    if (!current) return response.items[0]?.id ?? null;
                    if (response.items.some((item) => item.id === current)) return current;
                    return response.items[0]?.id ?? null;
                });
            })
            .catch((error) => {
                if (cancelled) return;
                setListError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (!cancelled) setListLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [source, filter, refreshTick]);

    const loadMoreLocal = useCallback(() => {
        if (source !== "local" || listLoading || localLoadingMore || !localHasMore) return;
        const currentOffset = localNextOffset;
        setLocalLoadingMore(true);
        setListError(null);

        queryHistoryList({
            ...filter,
            limit: LOCAL_PAGE_SIZE,
            offset: currentOffset,
        })
            .then((response) => {
                setListData((prev) => {
                    const existing = prev?.items ?? [];
                    const byId = new Map<number, QueryHistorySummary>();
                    for (const row of existing) byId.set(row.id, row);
                    for (const row of response.items) {
                        if (!byId.has(row.id)) byId.set(row.id, row);
                    }
                    const merged = Array.from(byId.values()).slice(0, MAX_IN_MEMORY_ROWS);
                    return {
                        ...(prev ?? response),
                        ...response,
                        items: merged,
                    };
                });
                const fetched = response.items.length;
                setLocalNextOffset(currentOffset + fetched);
                setLocalHasMore(currentOffset + fetched < response.total_count);
            })
            .catch((error) => {
                setListError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                setLocalLoadingMore(false);
            });
    }, [source, listLoading, localLoadingMore, localHasMore, localNextOffset, filter]);

    useEffect(() => {
        if (source !== "local") {
            setDetail(null);
            setDetailError(null);
            return;
        }
        if (!selectedId) {
            setDetail(null);
            setDetailError(null);
            return;
        }

        let cancelled = false;
        setDetailLoading(true);
        setDetailError(null);

        queryHistoryGetDetail(selectedId)
            .then((response) => {
                if (cancelled) return;
                setDetail(response);
                setNoteDraft(response.item.note ?? "");
            })
            .catch((error) => {
                if (cancelled) return;
                setDetailError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (!cancelled) setDetailLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [source, selectedId]);

    useEffect(() => {
        if (viewMode !== "dashboard" || source !== "local") return;

        let cancelled = false;
        setDashboardLoading(true);
        setDashboardError(null);

        queryHistoryGetDashboard({
            connection_id: selectedConnection === "all" ? null : selectedConnection,
            from_time: rangeWindow.from,
            to_time: rangeWindow.to,
        })
            .then((response) => {
                if (cancelled) return;
                setDashboard(response);
            })
            .catch((error) => {
                if (cancelled) return;
                setDashboardError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (!cancelled) setDashboardLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [viewMode, source, selectedConnection, rangeWindow.from, rangeWindow.to, refreshTick]);

    useEffect(() => {
        if (source !== "pg_stat") return;

        if (!connectionId || !isConnected) {
            setPgStatStatus(null);
            setPgStatItems([]);
            setPgStatTotalCount(0);
            setPgStatHasMore(false);
            setPgStatNextOffset(0);
            return;
        }

        let cancelled = false;
        setPgStatStatusLoading(true);
        setPgStatStatusError(null);

        dbPgStatStatementsStatus(connectionId)
            .then((status) => {
                if (cancelled) return;
                setPgStatStatus(status);
            })
            .catch((error) => {
                if (cancelled) return;
                setPgStatStatusError(error instanceof Error ? error.message : String(error));
                setPgStatStatus(null);
            })
            .finally(() => {
                if (!cancelled) setPgStatStatusLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [source, connectionId, isConnected, refreshTick]);

    useEffect(() => {
        if (source !== "pg_stat") return;
        if (!connectionId || !isConnected) return;
        if (!pgStatStatus?.can_query) {
            setPgStatItems([]);
            setPgStatTotalCount(0);
            setPgStatHasMore(false);
            setPgStatNextOffset(0);
            return;
        }

        let cancelled = false;
        setPgStatLoading(true);
        setPgStatError(null);
        setPgStatLoadingMore(false);

        dbPgStatStatementsList(connectionId, {
            ...pgStatFilter,
            limit: PG_STAT_PAGE_SIZE,
            offset: 0,
        })
            .then((response) => {
                if (cancelled) return;
                setPgStatItems(response.items);
                setPgStatTotalCount(response.total_count);
                setPgStatNextOffset(response.items.length);
                setPgStatHasMore(response.has_more);
                setSelectedPgStatId((current) => {
                    if (current && response.items.some((row) => row.query_id === current)) return current;
                    return response.items[0]?.query_id ?? null;
                });
            })
            .catch((error) => {
                if (cancelled) return;
                setPgStatError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (!cancelled) setPgStatLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [source, connectionId, isConnected, pgStatStatus?.can_query, pgStatFilter, refreshTick]);

    useEffect(() => {
        if (source !== "pg_stat" || !connectionId || !pgStatStatus?.can_query) {
            setPinnedFingerprints([]);
            return;
        }
        let cancelled = false;
        slowQueryListPinnedFingerprints(connectionId)
            .then((ids) => {
                if (!cancelled) setPinnedFingerprints(ids);
            })
            .catch(() => {
                if (!cancelled) setPinnedFingerprints([]);
            });
        return () => {
            cancelled = true;
        };
    }, [source, connectionId, pgStatStatus?.can_query, refreshTick]);

    useEffect(() => {
        if (source !== "pg_stat" || !connectionId || !pgStatStatus?.can_query) {
            setConnectionTrendRisks([]);
            return;
        }
        let cancelled = false;
        slowQueryListTrendRisks(connectionId, 3, 50)
            .then((rows) => {
                if (!cancelled) setConnectionTrendRisks(rows);
            })
            .catch(() => {
                if (!cancelled) setConnectionTrendRisks([]);
            });
        return () => {
            cancelled = true;
        };
    }, [source, connectionId, pgStatStatus?.can_query, refreshTick]);

    useEffect(() => {
        setPerformanceForecast(null);
    }, [selectedPgStatId]);

    useEffect(() => {
        autoSnapshotPgRef.current = false;
    }, [connectionId]);

    useEffect(() => {
        if (source !== "pg_stat" || !queryHistoryAutoSnapshotPgStat) return;
        if (!connectionId || !isConnected || !pgStatStatus?.can_query) return;
        if (autoSnapshotPgRef.current) return;
        autoSnapshotPgRef.current = true;
        slowQueryIngestFromPgStat(connectionId, 100, 200)
            .then((n) => {
                if (n > 0) {
                    toast.success(`Recorded ${n} slow-query snapshot rows locally for trends.`);
                }
            })
            .catch(() => {});
    }, [
        source,
        connectionId,
        isConnected,
        pgStatStatus?.can_query,
        queryHistoryAutoSnapshotPgStat,
    ]);

    const loadMorePgStat = useCallback(() => {
        if (
            source !== "pg_stat" ||
            !connectionId ||
            !pgStatStatus?.can_query ||
            pgStatLoading ||
            pgStatLoadingMore ||
            !pgStatHasMore
        ) {
            return;
        }
        const currentOffset = pgStatNextOffset;
        setPgStatLoadingMore(true);
        setPgStatError(null);

        dbPgStatStatementsList(connectionId, {
            ...pgStatFilter,
            limit: PG_STAT_PAGE_SIZE,
            offset: currentOffset,
        })
            .then((response) => {
                setPgStatItems((prev) => {
                    const byId = new Map<string, PgStatStatementEntry>();
                    for (const row of prev) byId.set(row.query_id, row);
                    for (const row of response.items) {
                        if (!byId.has(row.query_id)) byId.set(row.query_id, row);
                    }
                    return Array.from(byId.values()).slice(0, MAX_IN_MEMORY_ROWS);
                });
                const fetched = response.items.length;
                setPgStatTotalCount(response.total_count);
                setPgStatNextOffset(currentOffset + fetched);
                setPgStatHasMore(response.has_more);
            })
            .catch((error) => {
                setPgStatError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                setPgStatLoadingMore(false);
            });
    }, [
        source,
        connectionId,
        pgStatStatus?.can_query,
        pgStatLoading,
        pgStatLoadingMore,
        pgStatHasMore,
        pgStatNextOffset,
        pgStatFilter,
    ]);

    const handleListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 260;
        if (!nearBottom) return;
        if (source === "local") {
            loadMoreLocal();
        } else {
            loadMorePgStat();
        }
    }, [source, loadMoreLocal, loadMorePgStat]);

    const visibleItems = useMemo(() => {
        const raw = listData?.items ?? [];
        if (!groupByHash) return raw;

        const grouped = new Map<number, QueryHistorySummary>();
        for (const item of raw) {
            const existing = grouped.get(item.query_hash);
            if (!existing || item.executed_at > existing.executed_at) {
                grouped.set(item.query_hash, item);
            }
        }

        return Array.from(grouped.values());
    }, [listData?.items, groupByHash]);

    const selectedItem = detail?.item ?? visibleItems.find((item) => item.id === selectedId) ?? null;

    const displayPgStatItems = useMemo(() => {
        if (!pgStatPinnedOnly) return pgStatItems;
        const pinSet = new Set(pinnedFingerprints);
        return pgStatItems.filter((row) => pinSet.has(row.query_id));
    }, [pgStatItems, pgStatPinnedOnly, pinnedFingerprints]);

    const selectedPgStatItem = useMemo(
        () =>
            displayPgStatItems.find((item) => item.query_id === selectedPgStatId) ??
            displayPgStatItems[0] ??
            null,
        [displayPgStatItems, selectedPgStatId]
    );

    const aiPayload = parseQueryOptimizationPayload(detail?.ai_analysis ?? null);
    const pgStatAiPayload = parseQueryOptimizationPayload(slowInsight?.ai_analysis_json ?? null);

    useEffect(() => {
        if (source !== "pg_stat" || !connectionId || !selectedPgStatItem) {
            setSlowInsight(null);
            setSlowSnapshots([]);
            setPgStatNoteDraft("");
            return;
        }
        const fp = selectedPgStatItem.query_id;
        let cancelled = false;
        Promise.all([
            slowQueryGetInsight(connectionId, fp),
            slowQuerySnapshotsForFingerprint(connectionId, fp, 80),
        ])
            .then(([ins, snaps]) => {
                if (cancelled) return;
                setSlowInsight(ins);
                setSlowSnapshots(snaps);
                setPgStatNoteDraft(ins?.note ?? "");
            })
            .catch(() => {
                if (!cancelled) {
                    setSlowInsight(null);
                    setSlowSnapshots([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [source, connectionId, selectedPgStatItem?.query_id]);

    useEffect(() => {
        if (source !== "pg_stat") return;
        if (!selectedPgStatId) return;
        if (displayPgStatItems.some((i) => i.query_id === selectedPgStatId)) return;
        setSelectedPgStatId(displayPgStatItems[0]?.query_id ?? null);
    }, [source, displayPgStatItems, selectedPgStatId]);

    const canExecuteOnCurrentConnection = Boolean(isConnected && connectionId);

    const connectionComparison = useMemo(() => {
        if (!detail) return [];

        const all = [
            {
                connection_label: detail.item.connection_label,
                total_ms: detail.item.total_ms,
                rows: detail.item.rows_returned ?? detail.item.rows_affected ?? 0,
                disk: detail.item.blks_read ?? 0,
                sample_count: 1,
            },
            ...detail.similar_by_hash.map((q) => ({
                connection_label: q.connection_label,
                total_ms: q.total_ms,
                rows: 0,
                disk: 0,
                sample_count: 1,
            })),
        ];

        const byConn = new Map<string, { total_ms: number; runs: number; rows: number; disk: number }>();
        for (const row of all) {
            const prev = byConn.get(row.connection_label) ?? { total_ms: 0, runs: 0, rows: 0, disk: 0 };
            prev.total_ms += row.total_ms;
            prev.runs += row.sample_count;
            prev.rows += row.rows;
            prev.disk += row.disk;
            byConn.set(row.connection_label, prev);
        }

        return Array.from(byConn.entries())
            .map(([connection, v]) => ({
                connection,
                avg_ms: v.total_ms / Math.max(1, v.runs),
                rows: v.rows,
                disk: v.disk,
                runs: v.runs,
            }))
            .sort((a, b) => a.avg_ms - b.avg_ms)
            .slice(0, 3);
    }, [detail]);

    const handleExport = useCallback(async () => {
        if (source !== "local") {
            toast.error("CSV export is currently available for local history mode.");
            return;
        }
        try {
            const csv = await queryHistoryExportCsv(filter);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            csvDownload(csv, `query-history-${stamp}.csv`);
            toast.success("Query history exported");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }, [source, filter]);

    const handleEnablePgStat = useCallback(async () => {
        if (!connectionId || !isConnected) {
            toast.error("Connect to a database first.");
            return;
        }
        setIsEnablingPgStat(true);
        setPgStatStatusError(null);
        try {
            const status = await dbPgStatStatementsEnable(connectionId);
            setPgStatStatus(status);
            if (status.can_query) {
                toast.success("pg_stat_statements is ready.");
            } else {
                toast.warning("Server preload or restart may still be required — see the setup panel above.");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setPgStatStatusError(message);
            toast.error(message);
        } finally {
            setIsEnablingPgStat(false);
        }
    }, [connectionId, isConnected]);

    const handleCaptureExplain = useCallback(async () => {
        if (!detail || !selectedItem) return;
        if (!canExecuteOnCurrentConnection || !connectionId) {
            toast.error("Connect to a database to capture EXPLAIN ANALYZE.");
            return;
        }

        setIsCapturingExplain(true);
        try {
            const raw = await dbExplainQuery(connectionId, selectedItem.query_text);
            await queryHistorySaveExplain(selectedItem.id, raw);
            setDetail((prev) => (prev ? { ...prev, explain_json: raw } : prev));
            toast.success("Execution plan captured");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsCapturingExplain(false);
        }
    }, [canExecuteOnCurrentConnection, connectionId, detail, selectedItem]);

    const handleGenerateAi = useCallback(async () => {
        if (!detail) return;
        setIsGeneratingAi(true);
        try {
            const payload = await analyzeQueryPerformance({
                source: "local",
                localItem: detail.item,
                explainJson: detail.explain_json ?? null,
            });
            const serialized = JSON.stringify(payload);
            await queryHistorySaveAiAnalysis(detail.item.id, serialized);
            setDetail((prev) => (prev ? { ...prev, ai_analysis: serialized } : prev));
            toast.success(
                payload.provider === "gemini"
                    ? "AI optimization analysis generated"
                    : "Heuristic analysis generated (add a Gemini key in Settings → AI for full AI)"
            );
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsGeneratingAi(false);
        }
    }, [detail]);

    const handleRecordSlowSnapshots = useCallback(async () => {
        if (!connectionId || !isConnected) {
            toast.error("Connect to a database first.");
            return;
        }
        setIsIngestingSlow(true);
        try {
            const n = await slowQueryIngestFromPgStat(connectionId, 100, 200);
            toast.success(
                n > 0 ? `Recorded ${n} slow-query snapshot rows locally.` : "No statements matched mean ≥100ms."
            );
            const fp = selectedPgStatItem?.query_id;
            if (fp) {
                const snaps = await slowQuerySnapshotsForFingerprint(connectionId, fp, 80);
                setSlowSnapshots(snaps);
            }
            const risks = await slowQueryListTrendRisks(connectionId, 3, 20);
            setConnectionTrendRisks(risks);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsIngestingSlow(false);
        }
    }, [connectionId, isConnected, selectedPgStatItem?.query_id]);

    const handleCaptureExplainPg = useCallback(async () => {
        if (!selectedPgStatItem || !connectionId) return;
        if (!canExecuteOnCurrentConnection) {
            toast.error("Connect to a database to capture EXPLAIN ANALYZE.");
            return;
        }
        setIsCapturingExplainPg(true);
        try {
            const raw = await dbExplainQuery(connectionId, selectedPgStatItem.query);
            await slowQuerySaveExplainForFingerprint(
                connectionId,
                selectedPgStatItem.query_id,
                selectedPgStatItem.query,
                raw
            );
            setSlowInsight((prev) => ({
                connection_id: connectionId,
                query_fingerprint: selectedPgStatItem.query_id,
                query_text_last_seen: selectedPgStatItem.query,
                explain_json: raw,
                ai_analysis_json: prev?.ai_analysis_json ?? null,
                note: prev?.note ?? null,
                pinned: prev?.pinned ?? false,
                updated_at: Date.now(),
            }));
            toast.success("Execution plan captured");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsCapturingExplainPg(false);
        }
    }, [canExecuteOnCurrentConnection, connectionId, selectedPgStatItem]);

    const handleGenerateAiPg = useCallback(async () => {
        if (!selectedPgStatItem || !connectionId) return;
        setIsGeneratingAi(true);
        try {
            const payload = await analyzeQueryPerformance({
                source: "pg_stat",
                pgStatEntry: selectedPgStatItem,
                explainJson: slowInsight?.explain_json ?? null,
            });
            const serialized = JSON.stringify(payload);
            await slowQuerySaveAiForFingerprint(
                connectionId,
                selectedPgStatItem.query_id,
                selectedPgStatItem.query,
                serialized
            );
            setSlowInsight((prev) => ({
                connection_id: connectionId,
                query_fingerprint: selectedPgStatItem.query_id,
                query_text_last_seen: selectedPgStatItem.query,
                explain_json: prev?.explain_json ?? null,
                ai_analysis_json: serialized,
                note: prev?.note ?? null,
                pinned: prev?.pinned ?? false,
                updated_at: Date.now(),
            }));
            toast.success(
                payload.provider === "gemini"
                    ? "AI optimization analysis generated"
                    : "Heuristic analysis generated (add a Gemini key in Settings → AI for full AI)"
            );
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsGeneratingAi(false);
        }
    }, [connectionId, selectedPgStatItem, slowInsight?.explain_json]);

    const handleSavePgStatNote = useCallback(async () => {
        if (!selectedPgStatItem || !connectionId) return;
        setIsSavingPgStatNote(true);
        try {
            const trimmed = pgStatNoteDraft.trim() ? pgStatNoteDraft.trim() : null;
            await slowQuerySaveNoteForFingerprint(
                connectionId,
                selectedPgStatItem.query_id,
                selectedPgStatItem.query,
                trimmed
            );
            setSlowInsight((prev) =>
                prev
                    ? { ...prev, note: trimmed, updated_at: Date.now() }
                    : {
                          connection_id: connectionId,
                          query_fingerprint: selectedPgStatItem.query_id,
                          query_text_last_seen: selectedPgStatItem.query,
                          explain_json: null,
                          ai_analysis_json: null,
                          note: trimmed,
                          pinned: false,
                          updated_at: Date.now(),
                      }
            );
            toast.success("Note saved");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsSavingPgStatNote(false);
        }
    }, [connectionId, selectedPgStatItem, pgStatNoteDraft]);

    const handleTogglePgStatPin = useCallback(async () => {
        if (!selectedPgStatItem || !connectionId) return;
        const next = !slowInsight?.pinned;
        try {
            await slowQuerySetPinnedForFingerprint(
                connectionId,
                selectedPgStatItem.query_id,
                selectedPgStatItem.query,
                next
            );
            setSlowInsight((prev) =>
                prev
                    ? { ...prev, pinned: next, updated_at: Date.now() }
                    : {
                          connection_id: connectionId,
                          query_fingerprint: selectedPgStatItem.query_id,
                          query_text_last_seen: selectedPgStatItem.query,
                          explain_json: null,
                          ai_analysis_json: null,
                          note: null,
                          pinned: next,
                          updated_at: Date.now(),
                      }
            );
            const ids = await slowQueryListPinnedFingerprints(connectionId);
            setPinnedFingerprints(ids);
            toast.success(next ? "Pinned for this connection" : "Unpinned");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }, [connectionId, selectedPgStatItem, slowInsight?.pinned]);

    const handlePerformanceForecast = useCallback(async () => {
        if (!selectedPgStatItem || !connectionId) return;
        if (slowSnapshots.length < 3) {
            toast.info("Record at least 3 hourly snapshots for this statement to forecast trends.");
            return;
        }
        setIsForecastingPerformance(true);
        try {
            const result = await analyzePerformanceForecast({
                snapshots: slowSnapshots,
                pgStatEntry: selectedPgStatItem,
                connectionTrendRisks,
                explainJson: slowInsight?.explain_json ?? null,
            });
            if (result) {
                setPerformanceForecast(result);
                toast.success(
                    result.provider === "gemini"
                        ? "Predictive analysis generated"
                        : "Heuristic forecast generated (add Gemini key in Settings → AI for deeper analysis)"
                );
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsForecastingPerformance(false);
        }
    }, [
        connectionId,
        selectedPgStatItem,
        slowSnapshots,
        connectionTrendRisks,
        slowInsight?.explain_json,
    ]);

    const handleRunAgain = useCallback(async () => {
        const sqlToRun = source === "pg_stat" ? selectedPgStatItem?.query : selectedItem?.query_text;
        if (!sqlToRun) return;
        if (!canExecuteOnCurrentConnection || !connectionId) {
            toast.error("Connect to a database to replay this query.");
            return;
        }
        setIsRunningAgain(true);
        try {
            const result = await dbExecuteQuery(connectionId, sqlToRun);
            if (result.is_error) {
                toast.error(result.error_message ?? "Replay failed");
            } else {
                toast.success(`Replay completed in ${formatMs(result.execution_time_ms)}`);
                refreshList();
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsRunningAgain(false);
        }
    }, [
        source,
        selectedPgStatItem?.query,
        selectedItem?.query_text,
        canExecuteOnCurrentConnection,
        connectionId,
        refreshList,
    ]);

    const handleCopySql = useCallback(() => {
        const sqlToCopy = source === "pg_stat" ? selectedPgStatItem?.query : selectedItem?.query_text;
        if (!sqlToCopy) return;
        navigator.clipboard.writeText(sqlToCopy);
        toast.success("SQL copied");
    }, [source, selectedPgStatItem?.query, selectedItem?.query_text]);

    const handleExportReplay = useCallback(async () => {
        if (source !== "local") {
            toast.info("Replay bundles are available for Local History only.");
            return;
        }
        if (!connectionId) {
            toast.error("Connect to a database to export a replay bundle.");
            return;
        }
        if (!selectedItem) return;

        setIsExportingReplay(true);
        try {
            const bundle = await buildPerformanceReplayBundle({
                connectionId,
                summary: selectedItem,
                detail: detail ?? undefined,
                redact: replayRedact,
            });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadReplayBundle(bundle, `performance-replay-${selectedItem.id}-${stamp}.json`);
            toast.success("Replay bundle exported.");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to export replay bundle.");
        } finally {
            setIsExportingReplay(false);
        }
    }, [source, connectionId, selectedItem, detail, replayRedact]);

    const handleToggleBookmark = useCallback(async () => {
        if (source !== "local") return;
        if (!selectedItem) return;
        const next = !selectedItem.bookmark;
        try {
            await queryHistoryToggleBookmark(selectedItem.id, next);
            setDetail((prev) => (prev ? { ...prev, item: { ...prev.item, bookmark: next } } : prev));
            setListData((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    items: prev.items.map((item) =>
                        item.id === selectedItem.id ? { ...item, bookmark: next } : item
                    ),
                };
            });
            toast.success(next ? "Query bookmarked" : "Bookmark removed");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }, [source, selectedItem]);

    const handleSaveNote = useCallback(async () => {
        if (source !== "local") return;
        if (!selectedItem) return;
        setIsSavingNote(true);
        try {
            await queryHistorySaveNote(selectedItem.id, noteDraft.trim() || null);
            setDetail((prev) =>
                prev
                    ? {
                          ...prev,
                          item: {
                              ...prev.item,
                              note: noteDraft.trim() || null,
                          },
                      }
                    : prev
            );
            setListData((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    items: prev.items.map((item) =>
                        item.id === selectedItem.id ? { ...item, note: noteDraft.trim() || null } : item
                    ),
                };
            });
            toast.success("Note saved");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsSavingNote(false);
        }
    }, [source, selectedItem, noteDraft]);

    const showPgStatSetupCallout =
        source === "pg_stat" &&
        isConnected &&
        Boolean(connectionId) &&
        !pgStatStatusLoading &&
        !pgStatStatusError &&
        pgStatStatus != null &&
        !pgStatStatus.can_query;

    const pgStatSummary = useMemo(() => {
        let calls = 0;
        let slowEstimate = 0;
        let totalExecMs = 0;
        for (const row of pgStatItems) {
            calls += row.calls;
            slowEstimate += row.slow_call_estimate;
            totalExecMs += row.total_exec_time_ms;
        }
        return { calls, slowEstimate, totalExecMs };
    }, [pgStatItems]);

    const pgStatDiagnosis = useMemo(() => {
        if (!selectedPgStatItem) return "";
        const rowsPerCall = selectedPgStatItem.calls > 0 ? selectedPgStatItem.rows / selectedPgStatItem.calls : 0;
        const severity = severityFromMeanMs(selectedPgStatItem.mean_exec_time_ms).label;
        const diskHeavy = selectedPgStatItem.shared_blks_read > selectedPgStatItem.shared_blks_hit;
        const cacheHint = selectedPgStatItem.hit_percent < 90 ? "cache hit is low" : "cache hit is healthy";
        const rowsHint = rowsPerCall > 1000 ? "high rows/call suggests missing LIMIT or broad filters" : "rows/call looks controlled";

        return [
            `This statement is ${severity.toLowerCase()} at ${formatMs(selectedPgStatItem.mean_exec_time_ms)} average over ${formatNumber(selectedPgStatItem.calls)} calls.`,
            `${rowsHint}; ${cacheHint}.`,
            diskHeavy
                ? "Disk reads dominate cache hits, so index coverage and filter selectivity should be reviewed first."
                : "Most blocks are served from shared buffers, so focus on reducing call frequency or query shape.",
        ].join(" ");
    }, [selectedPgStatItem]);

    const pgStatWorkloadSharePct = useMemo(() => {
        if (!selectedPgStatItem) return null;
        const sum = pgStatItems.reduce((a, r) => a + r.total_exec_time_ms, 0);
        if (sum <= 0) return null;
        return (100 * selectedPgStatItem.total_exec_time_ms) / sum;
    }, [pgStatItems, selectedPgStatItem]);

    const trendRiskByFingerprint = useMemo(() => {
        const m = new Map<string, string>();
        for (const r of connectionTrendRisks) {
            m.set(r.query_fingerprint, r.risk_level);
        }
        return m;
    }, [connectionTrendRisks]);

    const snapshotRegression = useMemo(() => {
        if (slowSnapshots.length < 3) return null;
        const chronological = [...slowSnapshots].sort((a, b) => a.captured_at - b.captured_at);
        const last = chronological[chronological.length - 1]?.mean_exec_time_ms;
        const prev = chronological.slice(0, -1);
        const sorted = [...prev].sort((a, b) => a.mean_exec_time_ms - b.mean_exec_time_ms);
        const med = sorted[Math.floor(sorted.length / 2)]?.mean_exec_time_ms;
        if (last == null || med == null || med < 1) return null;
        if (last > med * 1.5) return { ratio: last / med, last, med };
        return null;
    }, [slowSnapshots]);

    const snapshotChartData = useMemo(
        () =>
            [...slowSnapshots]
                .sort((a, b) => a.captured_at - b.captured_at)
                .map((r) => ({
                    t: r.captured_at,
                    label: new Date(r.captured_at).toLocaleString(),
                    meanMs: r.mean_exec_time_ms,
                })),
        [slowSnapshots]
    );

    const trendExecutionMetrics = useMemo(
        () => computeExecutionTrendMetrics(slowSnapshots),
        [slowSnapshots]
    );

    const pgStatDetailBody = (
        <div className="h-full overflow-hidden">
            {pgStatLoading ? (
                <div className="flex h-full items-center justify-center">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading pg_stat_statements…
                    </div>
                </div>
            ) : pgStatStatusLoading ? (
                <div className="flex h-full items-center justify-center">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Checking extension status…
                    </div>
                </div>
            ) : pgStatStatusError ? (
                <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                    <p className="text-sm font-medium text-destructive">Could not read pg_stat_statements status</p>
                    <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{pgStatStatusErrorDisplay}</p>
                    <Button variant="outline" size="sm" className="mt-3 h-7" onClick={refreshList}>
                        Retry
                    </Button>
                </div>
            ) : !isConnected || !connectionId ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                    <p className="text-sm">Connect to a database to inspect pg_stat_statements.</p>
                </div>
            ) : !pgStatStatus?.can_query ? (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted-foreground">
                    <p className="text-sm">Complete the setup steps above to load statement details.</p>
                </div>
            ) : pgStatError ? (
                <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                    <p className="text-sm font-medium text-destructive">Failed to load statement stats</p>
                    <p className="mt-1 text-xs text-muted-foreground">{pgStatError}</p>
                </div>
            ) : !selectedPgStatItem ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                    <p className="text-sm">No statement rows matched the current filter.</p>
                </div>
            ) : (
                <ScrollArea className="h-full">
                    <div className="space-y-4 p-4">
                        <p className="text-[11px] text-muted-foreground/80">
                            Local snapshots store hourly pg_stat metrics on this device for trends and regression hints.
                        </p>
                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-y-2">
                                <div className="min-w-0">
                                    <h2 className="text-sm font-semibold">Query Text (pg_stat_statements)</h2>
                                    {selectedPgStatItem.pg_query_id ? (
                                        <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">
                                            pg queryid: {selectedPgStatItem.pg_query_id}
                                        </p>
                                    ) : null}
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                                    <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={handleCopySql}>
                                        <Copy className="h-3.5 w-3.5" />
                                        Copy SQL
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleTogglePgStatPin}
                                    >
                                        {slowInsight?.pinned ? (
                                            <PinOff className="h-3.5 w-3.5" />
                                        ) : (
                                            <Pin className="h-3.5 w-3.5" />
                                        )}
                                        {slowInsight?.pinned ? "Unpin" : "Pin"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleRecordSlowSnapshots}
                                        disabled={isIngestingSlow}
                                    >
                                        {isIngestingSlow ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Database className="h-3.5 w-3.5" />
                                        )}
                                        Record snapshot
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleRunAgain}
                                        disabled={isRunningAgain}
                                    >
                                        {isRunningAgain ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play className="h-3.5 w-3.5" />
                                        )}
                                        Run Again
                                    </Button>
                                </div>
                            </div>
                            <pre className="mt-3 w-full min-w-0 max-w-full whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-xs leading-relaxed text-emerald-200/90 [overflow-wrap:anywhere]">
                                {selectedPgStatItem.query}
                            </pre>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="mb-3 text-sm font-semibold">Performance Metrics</h2>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                <MetricCard
                                    label="Mean Execution"
                                    value={formatMs(selectedPgStatItem.mean_exec_time_ms)}
                                    hint={severityFromMeanMs(selectedPgStatItem.mean_exec_time_ms).label}
                                />
                                <MetricCard label="Max Execution" value={formatMs(selectedPgStatItem.max_exec_time_ms)} />
                                <MetricCard label="Min Execution" value={formatMs(selectedPgStatItem.min_exec_time_ms)} />
                                <MetricCard label="Total Execution" value={formatMs(selectedPgStatItem.total_exec_time_ms)} />
                                <MetricCard label="Calls" value={formatNumber(selectedPgStatItem.calls)} />
                                <MetricCard label="Estimated Slow Calls" value={formatNumber(selectedPgStatItem.slow_call_estimate)} />
                                <MetricCard
                                    label="Rows / Call"
                                    value={formatNumber(selectedPgStatItem.calls > 0 ? selectedPgStatItem.rows / selectedPgStatItem.calls : 0)}
                                />
                                <MetricCard label="Cache Hit Rate" value={`${selectedPgStatItem.hit_percent.toFixed(1)}%`} />
                                <MetricCard label="Std Dev" value={formatMs(selectedPgStatItem.stddev_exec_time_ms ?? 0)} />
                                {pgStatWorkloadSharePct != null ? (
                                    <MetricCard
                                        label="Loaded list workload"
                                        value={`${pgStatWorkloadSharePct.toFixed(1)}%`}
                                        hint="Share of total execution time in the statements currently loaded"
                                    />
                                ) : null}
                            </div>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="text-sm font-semibold">I/O Breakdown</h2>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                <MetricCard label="Shared Blocks Hit" value={formatNumber(selectedPgStatItem.shared_blks_hit)} />
                                <MetricCard label="Shared Blocks Read" value={formatNumber(selectedPgStatItem.shared_blks_read)} />
                                <MetricCard label="Temp Blocks Written" value={formatNumber(selectedPgStatItem.temp_blks_written)} />
                                <MetricCard label="Block Read Time" value={formatMs(selectedPgStatItem.blk_read_time_ms ?? 0)} />
                                <MetricCard label="Block Write Time" value={formatMs(selectedPgStatItem.blk_write_time_ms ?? 0)} />
                            </div>
                            <div className="mt-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                                {pgStatDiagnosis}
                            </div>
                        </section>

                        {snapshotRegression ? (
                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
                                Regression: latest snapshot mean ({formatMs(snapshotRegression.last)}) is{" "}
                                {snapshotRegression.ratio.toFixed(2)}× the prior median ({formatMs(snapshotRegression.med)}).
                            </div>
                        ) : null}

                        {snapshotChartData.length >= 2 ? (
                            <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                                <h2 className="text-sm font-semibold">Mean time (local snapshots)</h2>
                                <div className="mt-3 h-40 w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={snapshotChartData}>
                                            <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
                                            <XAxis
                                                dataKey="label"
                                                tick={{ fontSize: 9 }}
                                                interval="preserveStartEnd"
                                                hide
                                            />
                                            <YAxis tick={{ fontSize: 9 }} width={44} />
                                            <RechartsTooltip
                                                contentStyle={{ fontSize: 11 }}
                                                formatter={(v) => [formatMs(Number(v ?? 0)), "Mean"]}
                                                labelFormatter={(_, p) =>
                                                    (p?.[0]?.payload as { label?: string })?.label ?? ""
                                                }
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="meanMs"
                                                stroke="hsl(var(--primary))"
                                                strokeWidth={2}
                                                dot={{ r: 2 }}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </section>
                        ) : null}

                        <section className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <TrendingUp className="h-4 w-4 text-cyan-300/90" />
                                    <h2 className="text-sm font-semibold">Predictive performance</h2>
                                    {trendExecutionMetrics ? (
                                        <Badge
                                            variant="outline"
                                            className={cn(
                                                "h-5 text-[10px]",
                                                trendExecutionMetrics.riskLabel === "elevated" &&
                                                    "border-amber-500/50 text-amber-200",
                                                trendExecutionMetrics.riskLabel === "watch" &&
                                                    "border-cyan-500/40 text-cyan-200"
                                            )}
                                        >
                                            Trend: {trendExecutionMetrics.riskLabel}
                                        </Badge>
                                    ) : null}
                                    {performanceForecast ? (
                                        <Badge variant="outline" className="h-5 text-[10px]">
                                            {performanceForecast.provider === "gemini" ? "Gemini" : "Heuristic"}
                                        </Badge>
                                    ) : null}
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5"
                                    onClick={handlePerformanceForecast}
                                    disabled={isForecastingPerformance || slowSnapshots.length < 3}
                                >
                                    {isForecastingPerformance ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Flame className="h-3.5 w-3.5" />
                                    )}
                                    Forecast bottlenecks
                                </Button>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                                Uses local snapshot time series, live pg_stat aggregates, connection-wide risk ranks, and
                                optional EXPLAIN JSON to estimate where latency may head and what to do before it hurts
                                production SLOs.
                            </p>
                            {trendExecutionMetrics ? (
                                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                    <MetricCard
                                        label="Slope"
                                        value={`${trendExecutionMetrics.slopeMsPerDay.toFixed(2)} ms/day`}
                                        hint="Linear trend of mean execution time"
                                    />
                                    <MetricCard
                                        label="Last vs baseline"
                                        value={`${trendExecutionMetrics.lastVsBaseline.toFixed(2)}×`}
                                        hint="Latest mean vs median of prior snapshots"
                                    />
                                    <MetricCard
                                        label="Span"
                                        value={`${trendExecutionMetrics.spanDays.toFixed(1)}d`}
                                        hint={`${trendExecutionMetrics.snapshotCount} snapshots`}
                                    />
                                </div>
                            ) : (
                                <p className="mt-3 text-xs text-muted-foreground">
                                    Record multiple snapshots over time to unlock quantitative trend signals.
                                </p>
                            )}
                            {performanceForecast ? (
                                <div className="mt-4 space-y-3 border-t border-border/30 pt-4">
                                    <p className="text-sm font-medium text-foreground">{performanceForecast.headline}</p>
                                    <p className="text-[11px] text-muted-foreground">
                                        Horizon ~{performanceForecast.horizon_weeks} week(s) · Confidence{" "}
                                        {performanceForecast.confidence}
                                    </p>
                                    <div className="space-y-2">
                                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                            Likely bottlenecks
                                        </p>
                                        {performanceForecast.predicted_bottlenecks.map((b, i) => (
                                            <div
                                                key={`${b.title}-${i}`}
                                                className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs"
                                            >
                                                <p className="font-medium text-foreground">{b.title}</p>
                                                <p className="mt-1 text-muted-foreground">{b.rationale}</p>
                                                <p className="mt-1 text-[10px] text-muted-foreground/80">
                                                    {b.likelihood} · {b.timeframe}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="space-y-2">
                                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                            Preventive actions
                                        </p>
                                        {performanceForecast.preventive_actions.map((a, i) => (
                                            <div
                                                key={`${a.action}-${i}`}
                                                className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs"
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Badge variant="outline" className="h-5 text-[10px]">
                                                        {a.priority}
                                                    </Badge>
                                                    <span className="font-medium text-foreground">{a.action}</span>
                                                </div>
                                                <p className="mt-1 text-muted-foreground">
                                                    {a.expected_impact} · Effort: {a.effort}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                    {performanceForecast.monitoring_suggestions.length > 0 ? (
                                        <div className="rounded-lg border border-border/40 bg-background/30 p-3">
                                            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                                                Monitoring
                                            </p>
                                            <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                                                {performanceForecast.monitoring_suggestions.map((s) => (
                                                    <li key={s}>{s}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex items-center justify-between gap-2">
                                <h2 className="text-sm font-semibold">Execution Plan</h2>
                                {!slowInsight?.explain_json ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleCaptureExplainPg}
                                        disabled={isCapturingExplainPg}
                                    >
                                        {isCapturingExplainPg ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <WandSparkles className="h-3.5 w-3.5" />
                                        )}
                                        Capture EXPLAIN
                                    </Button>
                                ) : null}
                            </div>
                            <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-2">
                                {slowInsight?.explain_json ? (
                                    <QueryPlanViewer
                                        rawJson={slowInsight.explain_json}
                                        onApplyFix={async (sql) => {
                                            navigator.clipboard.writeText(sql);
                                            toast.success("Suggested fix copied");
                                        }}
                                    />
                                ) : (
                                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                        No execution plan captured yet. Persists locally per statement fingerprint.
                                    </p>
                                )}
                            </div>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-sm font-semibold">AI Explanation &amp; Optimization</h2>
                                    {pgStatAiPayload ? (
                                        <Badge variant="outline" className="h-5 text-[10px]">
                                            {pgStatAiPayload.provider === "gemini" ? "Gemini" : "Heuristic"}
                                        </Badge>
                                    ) : null}
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5"
                                    onClick={handleGenerateAiPg}
                                    disabled={isGeneratingAi}
                                >
                                    {isGeneratingAi ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Bot className="h-3.5 w-3.5" />
                                    )}
                                    Generate Optimized Version
                                </Button>
                            </div>

                            {!pgStatAiPayload ? (
                                <p className="mt-3 text-xs text-muted-foreground">
                                    Uses pg_stat metrics and optional EXPLAIN JSON. Add a Gemini API key in Settings → AI
                                    for intelligent rewrite and index suggestions.
                                </p>
                            ) : (
                                <div className="mt-3 space-y-3">
                                    <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-sm text-muted-foreground">
                                        {pgStatAiPayload.explanation}
                                    </div>
                                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                        <p className="mb-1 text-[11px] uppercase tracking-wide text-emerald-300/80">
                                            Optimized SQL
                                        </p>
                                        <pre className="overflow-x-auto text-xs leading-relaxed text-emerald-200/90">
                                            {pgStatAiPayload.optimized_sql}
                                        </pre>
                                    </div>

                                    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                                            Changes Made
                                        </p>
                                        <div className="space-y-2">
                                            {pgStatAiPayload.changes_made.map((change, idx) => (
                                                <div key={`${change.change}-${idx}`} className="rounded border border-border/30 p-2">
                                                    <p className="text-xs font-medium text-foreground">{change.change}</p>
                                                    <p className="mt-1 text-[11px] text-muted-foreground">{change.reason}</p>
                                                    <p className="mt-1 text-[11px] text-emerald-300/80">Impact: {change.impact}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {pgStatAiPayload.required_indexes.length > 0 ? (
                                        <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                                                Fix Actions
                                            </p>
                                            <div className="space-y-2">
                                                {pgStatAiPayload.required_indexes.map((index, idx) => (
                                                    <div key={`${index.sql}-${idx}`} className="rounded border border-border/30 p-2">
                                                        <pre className="overflow-x-auto text-xs text-cyan-200/90">{index.sql}</pre>
                                                        <p className="mt-1 text-[11px] text-muted-foreground">
                                                            Estimated size: {index.estimated_size_mb}MB | Build time:{" "}
                                                            {index.build_time_minutes}m |{" "}
                                                            {index.locks_table ? "May lock table" : "No table lock (CONCURRENTLY)"}
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : null}

                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <MetricCard
                                            label="Current"
                                            value={formatMs(pgStatAiPayload.estimated_improvement.current_ms)}
                                        />
                                        <MetricCard
                                            label="Estimated"
                                            value={formatMs(pgStatAiPayload.estimated_improvement.optimized_ms)}
                                        />
                                        <MetricCard
                                            label="Speedup"
                                            value={`${pgStatAiPayload.estimated_improvement.speedup_factor}x`}
                                            hint={`Confidence: ${pgStatAiPayload.estimated_improvement.confidence}`}
                                        />
                                    </div>
                                </div>
                            )}
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="text-sm font-semibold">Notes</h2>
                            <Textarea
                                value={pgStatNoteDraft}
                                onChange={(e) => setPgStatNoteDraft(e.target.value)}
                                placeholder="Team context, incident notes, or follow-up for this statement…"
                                className="mt-3 min-h-[90px] text-sm"
                            />
                            <div className="mt-2 flex justify-end">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5"
                                    onClick={handleSavePgStatNote}
                                    disabled={isSavingPgStatNote}
                                >
                                    {isSavingPgStatNote ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-3.5 w-3.5" />
                                    )}
                                    Save Note
                                </Button>
                            </div>
                        </section>
                    </div>
                </ScrollArea>
            )}
        </div>
    );

    const detailBody = (
        <div className="h-full overflow-hidden">
            {detailLoading ? (
                <div className="flex h-full items-center justify-center">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading query detail…
                    </div>
                </div>
            ) : detailError ? (
                <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                        <div>
                            <p className="text-sm font-medium text-destructive">Failed to load query detail</p>
                            <p className="mt-1 text-xs text-muted-foreground">{detailError}</p>
                        </div>
                    </div>
                </div>
            ) : !detail || !selectedItem ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                    <p className="text-sm">Select a query to inspect full performance detail.</p>
                </div>
            ) : (
                <ScrollArea className="h-full">
                    <div className="space-y-4 p-4">
                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-y-2">
                                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                    <h2 className="shrink-0 text-sm font-semibold">Query Text</h2>
                                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-border/50">
                                        {selectedItem.query_type}
                                    </Badge>
                                    {selectedItem.environment && (
                                        <ConnectionEnvBadge environment={selectedItem.environment} compact />
                                    )}
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                                    <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={handleCopySql}>
                                        <Copy className="h-3.5 w-3.5" />
                                        Copy SQL
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={() => setReplayRedact((v) => !v)}
                                        disabled={source !== "local"}
                                        title="Redact literals (strings/numbers) in exported bundle"
                                    >
                                        <Shield className="h-3.5 w-3.5" />
                                        Redact: {replayRedact ? "On" : "Off"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleExportReplay}
                                        disabled={source !== "local" || isExportingReplay}
                                    >
                                        {isExportingReplay ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Download className="h-3.5 w-3.5" />
                                        )}
                                        Export Replay
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleRunAgain}
                                        disabled={isRunningAgain}
                                    >
                                        {isRunningAgain ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play className="h-3.5 w-3.5" />
                                        )}
                                        Run Again
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleToggleBookmark}
                                    >
                                        {selectedItem.bookmark ? (
                                            <PinOff className="h-3.5 w-3.5" />
                                        ) : (
                                            <Pin className="h-3.5 w-3.5" />
                                        )}
                                        {selectedItem.bookmark ? "Unpin" : "Pin"}
                                    </Button>
                                </div>
                            </div>
                            <pre className="mt-3 w-full min-w-0 max-w-full whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-xs leading-relaxed text-emerald-200/90 [overflow-wrap:anywhere]">
                                {selectedItem.query_text}
                            </pre>
                            {selectedItem.guard_reason && (
                                <div className="mt-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                                    <span className="font-medium text-foreground/90">Production guard reason:</span>{" "}
                                    {selectedItem.guard_reason}
                                </div>
                            )}
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="mb-3 text-sm font-semibold">Performance Metrics</h2>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                <MetricCard label="Total Time" value={formatMs(selectedItem.total_ms)} hint={severityLabel(selectedItem).label} />
                                <MetricCard
                                    label="Execution Time"
                                    value={formatMs(selectedItem.execution_ms)}
                                    hint={selectedItem.execution_ms > selectedItem.total_ms * 0.8 ? "Execution dominates" : "Planning dominates"}
                                />
                                <MetricCard label="Planning Time" value={formatMs(selectedItem.planning_ms ?? 0)} hint="Plan build phase" />
                                <MetricCard label="Rows Returned" value={formatNumber(selectedItem.rows_returned)} hint="Large values suggest LIMIT/pagination" />
                                <MetricCard label="Disk Reads" value={formatNumber(selectedItem.blks_read)} hint="High reads imply cold scans" />
                                <MetricCard
                                    label="Cache State"
                                    value={selectedItem.was_cached ? "Cached" : "DB Hit"}
                                    hint={selectedItem.was_cached ? "Served from app cache" : "Executed against database"}
                                />
                            </div>
                            <div className="mt-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                                Compared to similar runs: this query is {Math.max(1, Math.round(selectedItem.total_ms / Math.max(1, selectedItem.avg_ms)))}x of its own average ({formatMs(selectedItem.avg_ms)}).
                            </div>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex items-center justify-between gap-2">
                                <h2 className="text-sm font-semibold">Execution Plan</h2>
                                {!detail.explain_json && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1.5"
                                        onClick={handleCaptureExplain}
                                        disabled={isCapturingExplain}
                                    >
                                        {isCapturingExplain ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <WandSparkles className="h-3.5 w-3.5" />
                                        )}
                                        Capture EXPLAIN
                                    </Button>
                                )}
                            </div>
                            <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-2">
                                {detail.explain_json ? (
                                    <QueryPlanViewer
                                        rawJson={detail.explain_json}
                                        onApplyFix={async (sql) => {
                                            navigator.clipboard.writeText(sql);
                                            toast.success("Suggested fix copied");
                                        }}
                                    />
                                ) : (
                                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                        No execution plan captured yet. Use capture to run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and persist it locally.
                                    </p>
                                )}
                            </div>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-sm font-semibold">AI Explanation & Optimization</h2>
                                    {aiPayload ? (
                                        <Badge variant="outline" className="h-5 text-[10px]">
                                            {aiPayload.provider === "gemini" ? "Gemini" : "Heuristic"}
                                        </Badge>
                                    ) : null}
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5"
                                    onClick={handleGenerateAi}
                                    disabled={isGeneratingAi}
                                >
                                    {isGeneratingAi ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Bot className="h-3.5 w-3.5" />
                                    )}
                                    Generate Optimized Version
                                </Button>
                            </div>

                            {!aiPayload ? (
                                <p className="mt-3 text-xs text-muted-foreground">
                                    Generate an optimization package to get a rewritten query, index recommendations, and estimated speedup.
                                </p>
                            ) : (
                                <div className="mt-3 space-y-3">
                                    <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-sm text-muted-foreground">
                                        {aiPayload.explanation}
                                    </div>
                                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                        <p className="mb-1 text-[11px] uppercase tracking-wide text-emerald-300/80">Optimized SQL</p>
                                        <pre className="overflow-x-auto text-xs leading-relaxed text-emerald-200/90">
                                            {aiPayload.optimized_sql}
                                        </pre>
                                    </div>

                                    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Changes Made</p>
                                        <div className="space-y-2">
                                            {aiPayload.changes_made.map((change, idx) => (
                                                <div key={`${change.change}-${idx}`} className="rounded border border-border/30 p-2">
                                                    <p className="text-xs font-medium text-foreground">{change.change}</p>
                                                    <p className="mt-1 text-[11px] text-muted-foreground">{change.reason}</p>
                                                    <p className="mt-1 text-[11px] text-emerald-300/80">Impact: {change.impact}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {aiPayload.required_indexes.length > 0 && (
                                        <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Fix Actions</p>
                                            <div className="space-y-2">
                                                {aiPayload.required_indexes.map((index, idx) => (
                                                    <div key={`${index.sql}-${idx}`} className="rounded border border-border/30 p-2">
                                                        <pre className="overflow-x-auto text-xs text-cyan-200/90">{index.sql}</pre>
                                                        <p className="mt-1 text-[11px] text-muted-foreground">
                                                            Estimated size: {index.estimated_size_mb}MB | Build time: {index.build_time_minutes}m | {index.locks_table ? "May lock table" : "No table lock (CONCURRENTLY)"}
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <MetricCard label="Current" value={formatMs(aiPayload.estimated_improvement.current_ms)} />
                                        <MetricCard label="Estimated" value={formatMs(aiPayload.estimated_improvement.optimized_ms)} />
                                        <MetricCard
                                            label="Speedup"
                                            value={`${aiPayload.estimated_improvement.speedup_factor}x`}
                                            hint={`Confidence: ${aiPayload.estimated_improvement.confidence}`}
                                        />
                                    </div>
                                </div>
                            )}
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="text-sm font-semibold">Connection Comparison</h2>
                            {connectionComparison.length === 0 ? (
                                <p className="mt-2 text-xs text-muted-foreground">No comparable runs across connections yet.</p>
                            ) : (
                                <div className="mt-3 overflow-x-auto">
                                    <table className="min-w-full text-xs">
                                        <thead>
                                            <tr className="text-left text-muted-foreground/70">
                                                <th className="px-2 py-1">Connection</th>
                                                <th className="px-2 py-1">Avg Time</th>
                                                <th className="px-2 py-1">Runs</th>
                                                <th className="px-2 py-1">Rows</th>
                                                <th className="px-2 py-1">Disk Reads</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {connectionComparison.map((row) => (
                                                <tr key={row.connection} className="border-t border-border/30">
                                                    <td className="px-2 py-1.5 font-medium text-foreground">{row.connection}</td>
                                                    <td className="px-2 py-1.5">{formatMs(row.avg_ms)}</td>
                                                    <td className="px-2 py-1.5">{row.runs}</td>
                                                    <td className="px-2 py-1.5">{formatNumber(row.rows)}</td>
                                                    <td className="px-2 py-1.5">{formatNumber(row.disk)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="text-sm font-semibold">Bookmarks & Notes</h2>
                            <Textarea
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                                placeholder="Add team context, incident notes, or follow-up actions for this query…"
                                className="mt-3 min-h-[90px] text-sm"
                            />
                            <div className="mt-2 flex justify-end">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5"
                                    onClick={handleSaveNote}
                                    disabled={isSavingNote}
                                >
                                    {isSavingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                    Save Note
                                </Button>
                            </div>
                        </section>

                        <section className="rounded-xl border border-border/40 bg-card/20 p-4">
                            <h2 className="text-sm font-semibold">Similar Queries</h2>
                            <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Same Hash</p>
                                    <div className="mt-2 space-y-2">
                                        {detail.similar_by_hash.slice(0, 8).map((q) => (
                                            <button
                                                key={q.id}
                                                type="button"
                                                onClick={() => setSelectedId(q.id)}
                                                className="w-full rounded border border-border/30 px-2 py-1.5 text-left hover:bg-card/40"
                                            >
                                                <p className="truncate font-mono text-[11px] text-foreground/90">{clampPreview(q.query_text, 90)}</p>
                                                <p className="mt-1 text-[10px] text-muted-foreground">
                                                    {formatMs(q.total_ms)} · {q.connection_label} · {timeAgo(q.executed_at)}
                                                </p>
                                            </button>
                                        ))}
                                        {detail.similar_by_hash.length === 0 && (
                                            <p className="text-[11px] text-muted-foreground">No hash matches yet.</p>
                                        )}
                                    </div>
                                </div>
                                <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Same Tables</p>
                                    <div className="mt-2 space-y-2">
                                        {detail.similar_by_table.slice(0, 8).map((q) => (
                                            <button
                                                key={q.id}
                                                type="button"
                                                onClick={() => setSelectedId(q.id)}
                                                className="w-full rounded border border-border/30 px-2 py-1.5 text-left hover:bg-card/40"
                                            >
                                                <p className="truncate font-mono text-[11px] text-foreground/90">{clampPreview(q.query_text, 90)}</p>
                                                <p className="mt-1 text-[10px] text-muted-foreground">
                                                    {formatMs(q.total_ms)} · {q.connection_label} · {timeAgo(q.executed_at)}
                                                </p>
                                            </button>
                                        ))}
                                        {detail.similar_by_table.length === 0 && (
                                            <p className="text-[11px] text-muted-foreground">No table overlaps yet.</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </ScrollArea>
            )}
        </div>
    );

    return (
        <div className="flex h-screen flex-col bg-transparent">
            <header className="flex h-11 items-center justify-between border-b border-border/20 bg-card/20 px-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    <Link href="/" className="flex items-center gap-2">
                        <Image
                            src="/logo.png"
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded-md object-contain"
                        />
                        <span className="text-sm font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            {APP_NAME}
                        </span>
                    </Link>
                    <div className="h-4 w-px bg-border/40" />
                    <div className="flex items-center gap-1.5 min-w-0">
                        <Clock3 className="h-3.5 w-3.5 text-cyan-300/80" />
                        <span className="truncate text-xs font-medium text-muted-foreground">Query History & Performance Intelligence</span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Badge variant="outline" className="h-6 px-2 text-[10px] border-border/40">
                        {isConnected ? `Connected: ${databaseName || "database"}` : "Offline view"}
                    </Badge>
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
                        <Link href="/">
                            <ArrowLeft className="h-3.5 w-3.5" />
                            Back
                        </Link>
                    </Button>
                </div>
            </header>

            <div className="flex-1 min-h-0 overflow-hidden">
                <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)} className="h-full">
                    <div className="border-b border-border/20 px-3 py-2 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative min-w-[260px] flex-1">
                                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                                <Input
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search SQL, table, error, or use >5000 / today / last week"
                                    className="h-8 pl-8 text-xs"
                                />
                            </div>

                            <select
                                value={source === "pg_stat" ? "all" : selectedConnection}
                                onChange={(e) => setSelectedConnection(e.target.value)}
                                disabled={source === "pg_stat"}
                                className={cn(
                                    "h-8 rounded border border-border/40 bg-card/30 px-2 text-xs",
                                    source === "pg_stat" && "opacity-60"
                                )}
                            >
                                {source === "pg_stat" ? (
                                    <option value="all">{isConnected ? (databaseName || "Current connection") : "Connect a DB"}</option>
                                ) : (
                                    <>
                                        <option value="all">All connections</option>
                                        {(listData?.connections ?? []).map((conn) => (
                                            <option key={conn.connection_id} value={conn.connection_id}>
                                                {conn.connection_label} ({conn.query_count})
                                            </option>
                                        ))}
                                    </>
                                )}
                            </select>

                            <select
                                value={range}
                                onChange={(e) => setRange(e.target.value as RangeKey)}
                                disabled={source === "pg_stat"}
                                className={cn(
                                    "h-8 rounded border border-border/40 bg-card/30 px-2 text-xs",
                                    source === "pg_stat" && "opacity-60"
                                )}
                            >
                                <option value="1h">Last hour</option>
                                <option value="today">Today</option>
                                <option value="7d">Last 7 days</option>
                                <option value="30d">Last 30 days</option>
                                <option value="all">All time</option>
                            </select>

                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as SortKey)}
                                className="h-8 rounded border border-border/40 bg-card/30 px-2 text-xs"
                            >
                                <option value="slowest">Slowest first</option>
                                <option value="recent">Most recent</option>
                                <option value="frequency">Most frequent</option>
                                <option value="disk">Most disk reads</option>
                                <option value="rows">Highest row count</option>
                                <option value="errors">Most errors</option>
                                <option value="table">Alphabetical by table</option>
                            </select>

                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={handleExport}
                                disabled={source !== "local"}
                            >
                                <Download className="h-3.5 w-3.5" />
                                Export CSV
                            </Button>

                            <Button variant="outline" size="icon" className="h-8 w-8" onClick={refreshList}>
                                <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center rounded-lg border border-border/40 bg-card/20 p-1">
                                <button
                                    type="button"
                                    onClick={() => setSource("local")}
                                    className={cn(
                                        "rounded px-2 py-1 text-[11px] transition-colors",
                                        source === "local"
                                            ? "bg-emerald-500/20 text-emerald-200"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    Local History
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSource("pg_stat");
                                        setViewMode("history");
                                        setStatusChip("all");
                                        setQueryType("all");
                                        setGroupByHash(false);
                                        setBookmarksOnly(false);
                                    }}
                                    className={cn(
                                        "rounded px-2 py-1 text-[11px] transition-colors",
                                        source === "pg_stat"
                                            ? "bg-cyan-500/20 text-cyan-200"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    pg_stat_statements
                                </button>
                            </div>

                            <div className="flex items-center rounded-lg border border-border/40 bg-card/20 p-1">
                                {([
                                    ["all", "All"],
                                    ["slow", "Slow >1s"],
                                    ["failed", "Failed"],
                                    ["cached", "Cached"],
                                ] as const).map(([value, label]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setStatusChip(value)}
                                        disabled={source === "pg_stat" && (value === "failed" || value === "cached")}
                                        className={cn(
                                            "rounded px-2 py-1 text-[11px] transition-colors",
                                            source === "pg_stat" && (value === "failed" || value === "cached")
                                                ? "cursor-not-allowed opacity-40"
                                                : "",
                                            statusChip === value
                                                ? "bg-emerald-500/20 text-emerald-200"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>

                            <div className="flex items-center rounded-lg border border-border/40 bg-card/20 p-1">
                                {([
                                    ["all", "All Types"],
                                    ["SELECT", "SELECT"],
                                    ["DML", "DML"],
                                    ["DDL", "DDL"],
                                ] as const).map(([value, label]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setQueryType(value)}
                                        disabled={source === "pg_stat"}
                                        className={cn(
                                            "rounded px-2 py-1 text-[11px] transition-colors",
                                            source === "pg_stat" && "cursor-not-allowed opacity-40",
                                            queryType === value
                                                ? "bg-cyan-500/20 text-cyan-200"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>

                            <Button
                                variant={groupByHash ? "default" : "outline"}
                                size="sm"
                                className="h-7 gap-1.5 text-[11px]"
                                onClick={() => setGroupByHash((x) => !x)}
                                disabled={source === "pg_stat"}
                            >
                                <Layers className="h-3.5 w-3.5" />
                                Query Groups
                            </Button>

                            <Button
                                variant={bookmarksOnly ? "default" : "outline"}
                                size="sm"
                                className="h-7 gap-1.5 text-[11px]"
                                onClick={() => setBookmarksOnly((x) => !x)}
                                disabled={source === "pg_stat"}
                            >
                                <Pin className="h-3.5 w-3.5" />
                                Bookmarked
                            </Button>

                            <Button
                                variant={pgStatPinnedOnly ? "default" : "outline"}
                                size="sm"
                                className="h-7 gap-1.5 text-[11px]"
                                onClick={() => setPgStatPinnedOnly((x) => !x)}
                                disabled={source !== "pg_stat"}
                            >
                                <Pin className="h-3.5 w-3.5" />
                                Pinned
                            </Button>

                            {source === "pg_stat" ? (
                                <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/20 px-2 py-1">
                                    <Switch
                                        id="qh-auto-snap"
                                        checked={queryHistoryAutoSnapshotPgStat}
                                        onCheckedChange={(c) =>
                                            updateSettings({ queryHistoryAutoSnapshotPgStat: c })
                                        }
                                        className="scale-90"
                                    />
                                    <Label htmlFor="qh-auto-snap" className="cursor-pointer text-[11px] text-muted-foreground">
                                        Auto-snapshot
                                    </Label>
                                </div>
                            ) : null}

                            <TabsList className="ml-auto" variant="line">
                                <TabsTrigger value="history" className="text-xs px-3">List View</TabsTrigger>
                                <TabsTrigger value="dashboard" className="text-xs px-3">
                                    Dashboard
                                </TabsTrigger>
                            </TabsList>
                        </div>
                    </div>

                    <TabsContent value="history" className="h-full min-h-0">
                        <div className="flex h-full min-h-0 flex-col">
                            {showPgStatSetupCallout && pgStatStatus ? (
                                <PgStatStatementsSetupCallout
                                    status={pgStatStatus}
                                    onSetup={handleEnablePgStat}
                                    isSettingUp={isEnablingPgStat}
                                />
                            ) : null}
                            {source === "pg_stat" &&
                            pgStatStatus?.can_query &&
                            connectionTrendRisks.some((r) => r.risk_level === "high" || r.risk_level === "medium") ? (
                                <div className="mx-3 mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100/90">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                                    <div>
                                        <p className="font-medium text-amber-50/95">
                                            {connectionTrendRisks.filter((r) => r.risk_level === "high").length} high ·{" "}
                                            {connectionTrendRisks.filter((r) => r.risk_level === "medium").length} medium
                                            risk statements from local snapshot trends
                                        </p>
                                        <p className="mt-0.5 text-[11px] text-amber-100/70">
                                            Select a statement with snapshots and use{" "}
                                            <span className="font-medium">Forecast bottlenecks</span> for preventive
                                            recommendations.
                                        </p>
                                    </div>
                                </div>
                            ) : null}
                            <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
                                <ResizablePanel defaultSize={42} minSize={25}>
                                    <div className="h-full border-r border-border/20 bg-card/10">
                                        {source === "local" ? (
                                            listLoading ? (
                                                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading query history…
                                                </div>
                                            ) : listError ? (
                                                <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                                                    <p className="text-sm font-medium text-destructive">Failed to load query history</p>
                                                    <p className="mt-1 text-xs text-muted-foreground">{listError}</p>
                                                    <Button variant="outline" size="sm" className="mt-3 h-7" onClick={refreshList}>
                                                        Retry
                                                    </Button>
                                                </div>
                                            ) : visibleItems.length === 0 ? (
                                                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                                                    <Clock3 className="h-8 w-8 text-muted-foreground/30" />
                                                    <p className="mt-2 text-sm text-muted-foreground">No queries matched your filters.</p>
                                                </div>
                                            ) : (
                                                <div className="h-full overflow-auto p-3" onScroll={handleListScroll}>
                                                    <div className="space-y-2">
                                                        {visibleItems.map((item) => (
                                                            <QueryRow
                                                                key={item.id}
                                                                item={item}
                                                                active={item.id === selectedId}
                                                                onClick={() => setSelectedId(item.id)}
                                                            />
                                                        ))}
                                                    </div>
                                                    <div className="mt-3 space-y-2 pb-3">
                                                        {localLoadingMore && (
                                                            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                Loading more…
                                                            </div>
                                                        )}
                                                        <p className="text-center text-[11px] text-muted-foreground/70">
                                                            Loaded {formatNumber(listData?.items.length ?? 0)} of{" "}
                                                            {formatNumber(listData?.total_count ?? 0)}
                                                        </p>
                                                    </div>
                                                </div>
                                            )
                                        ) : pgStatStatusLoading ? (
                                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking extension status…
                                            </div>
                                        ) : pgStatLoading ? (
                                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading pg_stat_statements…
                                            </div>
                                        ) : pgStatStatusError ? (
                                            <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                                                <p className="text-sm font-medium text-destructive">Could not check extension status</p>
                                                <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{pgStatStatusErrorDisplay}</p>
                                                <Button variant="outline" size="sm" className="mt-3 h-7" onClick={refreshList}>
                                                    Retry
                                                </Button>
                                            </div>
                                        ) : !isConnected || !connectionId ? (
                                            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                                                <Database className="h-8 w-8 text-muted-foreground/30" />
                                                <p className="mt-2 text-sm text-muted-foreground">
                                                    Connect to a database to use pg_stat_statements.
                                                </p>
                                            </div>
                                        ) : !pgStatStatus?.can_query ? (
                                            <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted-foreground">
                                                <p className="text-sm">Complete the setup steps above to list statements.</p>
                                            </div>
                                        ) : pgStatError ? (
                                            <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                                                <p className="text-sm font-medium text-destructive">Failed to load statement stats</p>
                                                <p className="mt-1 text-xs text-muted-foreground">{pgStatError}</p>
                                                <Button variant="outline" size="sm" className="mt-3 h-7" onClick={refreshList}>
                                                    Retry
                                                </Button>
                                            </div>
                                        ) : pgStatItems.length === 0 ? (
                                            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                                                <Clock3 className="h-8 w-8 text-muted-foreground/30" />
                                                <p className="mt-2 text-sm text-muted-foreground">No statements matched your filters.</p>
                                            </div>
                                        ) : displayPgStatItems.length === 0 ? (
                                            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                                                <Pin className="h-8 w-8 text-muted-foreground/30" />
                                                <p className="mt-2 text-sm text-muted-foreground">
                                                    No pinned statements. Pin items from the detail panel to list them here.
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="h-full overflow-auto p-3" onScroll={handleListScroll}>
                                                <div className="space-y-2">
                                                    {displayPgStatItems.map((item) => (
                                                        <PgStatRow
                                                            key={item.query_id}
                                                            item={item}
                                                            active={item.query_id === selectedPgStatId}
                                                            pinned={pinnedFingerprints.includes(item.query_id)}
                                                            trendRisk={trendRiskByFingerprint.get(item.query_id) ?? null}
                                                            onClick={() => setSelectedPgStatId(item.query_id)}
                                                        />
                                                    ))}
                                                </div>
                                                <div className="mt-3 space-y-2 pb-3">
                                                    {pgStatLoadingMore && (
                                                        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                            Loading more…
                                                        </div>
                                                    )}
                                                    <p className="text-center text-[11px] text-muted-foreground/70">
                                                        Showing {formatNumber(displayPgStatItems.length)} of{" "}
                                                        {formatNumber(pgStatItems.length)} loaded (
                                                        {formatNumber(pgStatTotalCount)} total)
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </ResizablePanel>

                                <ResizableHandle className="w-px bg-border/20" />

                                <ResizablePanel defaultSize={58} minSize={35}>
                                    {source === "pg_stat" ? pgStatDetailBody : detailBody}
                                </ResizablePanel>
                            </ResizablePanelGroup>

                            <div className="border-t border-border/20 bg-card/10 px-3 py-2">
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                    {source === "local" ? (
                                        <>
                                            <span>Total: <span className="font-medium text-foreground">{formatNumber(listData?.stats.total_queries ?? 0)}</span></span>
                                            <span>Avg: <span className="font-medium text-foreground">{formatMs(listData?.stats.avg_time_ms ?? 0)}</span></span>
                                            <span>Slowest: <span className="font-medium text-foreground">{formatMs(listData?.stats.slowest_ms ?? 0)}</span></span>
                                            <span>Failed: <span className="font-medium text-foreground">{formatNumber(listData?.stats.failed_count ?? 0)}</span></span>
                                            <span>Cached: <span className="font-medium text-foreground">{formatNumber(listData?.stats.cached_count ?? 0)}</span></span>
                                            <span>Today: <span className="font-medium text-foreground">{formatNumber(listData?.stats.today_count ?? 0)}</span></span>
                                        </>
                                    ) : (
                                        <>
                                            <span>Statements: <span className="font-medium text-foreground">{formatNumber(pgStatTotalCount)}</span></span>
                                            <span>Loaded: <span className="font-medium text-foreground">{formatNumber(pgStatItems.length)}</span></span>
                                            <span>Calls: <span className="font-medium text-foreground">{formatNumber(pgStatSummary.calls)}</span></span>
                                            <span>Slow call estimate: <span className="font-medium text-foreground">{formatNumber(pgStatSummary.slowEstimate)}</span></span>
                                            <span>Total exec: <span className="font-medium text-foreground">{formatMs(pgStatSummary.totalExecMs)}</span></span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="dashboard" className="h-full min-h-0">
                        <div className="h-full overflow-auto p-4">
                            {source === "local" ? (
                                <QueryHistoryPerformanceDashboard
                                    variant="local"
                                    dashboard={dashboard}
                                    loading={dashboardLoading}
                                    error={dashboardError}
                                    listStats={listData?.stats ?? null}
                                />
                            ) : (
                                <QueryHistoryPerformanceDashboard
                                    variant="pg_stat"
                                    isConnected={Boolean(isConnected && connectionId)}
                                    statusLoading={pgStatStatusLoading}
                                    statusError={pgStatStatusError}
                                    statusErrorDisplay={pgStatStatusErrorDisplay}
                                    canQuery={pgStatStatus?.can_query}
                                    itemsLoading={pgStatLoading}
                                    itemsError={pgStatError}
                                    items={pgStatItems}
                                    totalCount={pgStatTotalCount}
                                    trendRisks={connectionTrendRisks}
                                />
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
