"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dbExecuteQuery } from "@/lib/db-platform";
import {
    SQL_OVERVIEW_DATABASE_STATS,
    SQL_OVERVIEW_CONNECTIONS,
    SQL_OVERVIEW_ACTIVITY_BY_STATE,
    SQL_OVERVIEW_RECOVERY,
    SQL_OVERVIEW_BGWRITER,
    SQL_STORAGE_LARGEST_RELATIONS,
    SQL_STORAGE_BLOAT_CANDIDATES,
    SQL_INDEXES_UNUSED,
    SQL_INDEXES_INVALID,
    SQL_ACTIVITY_LONG_RUNNING,
    VITALS_QUERY_LABELS,
    PGSTUDIO_PENDING_QUERY_TAB_KEY,
} from "@/lib/database-vitals-queries";
import type { QueryResult } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
    ClipboardCopy,
    ExternalLink,
    RefreshCw,
    AlertCircle,
    Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

type VitalsTab = "overview" | "storage" | "indexes" | "activity";

type SectionKey =
    | "ov_db"
    | "ov_conn"
    | "ov_state"
    | "ov_rec"
    | "ov_bg"
    | "st_size"
    | "st_bloat"
    | "ix_unused"
    | "ix_invalid"
    | "act_long";

type SectionState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; result: QueryResult };

const TAB_SECTIONS: Record<VitalsTab, { key: SectionKey; sql: string; title: string }[]> = {
    overview: [
        { key: "ov_db", sql: SQL_OVERVIEW_DATABASE_STATS, title: "Database I/O & tuples" },
        { key: "ov_conn", sql: SQL_OVERVIEW_CONNECTIONS, title: "Connection budget" },
        { key: "ov_state", sql: SQL_OVERVIEW_ACTIVITY_BY_STATE, title: "Backends by state" },
        { key: "ov_rec", sql: SQL_OVERVIEW_RECOVERY, title: "Replication role" },
        { key: "ov_bg", sql: SQL_OVERVIEW_BGWRITER, title: "Background writer (cluster)" },
    ],
    storage: [
        { key: "st_size", sql: SQL_STORAGE_LARGEST_RELATIONS, title: "Largest relations" },
        { key: "st_bloat", sql: SQL_STORAGE_BLOAT_CANDIDATES, title: "High dead-tuple ratio (≥10%)" },
    ],
    indexes: [
        { key: "ix_unused", sql: SQL_INDEXES_UNUSED, title: "Never-scanned indexes (non-PK)" },
        { key: "ix_invalid", sql: SQL_INDEXES_INVALID, title: "Invalid indexes" },
    ],
    activity: [{ key: "act_long", sql: SQL_ACTIVITY_LONG_RUNNING, title: "Long-running active queries" }],
};

const LABEL_FOR_SECTION: Partial<Record<SectionKey, string>> = {
    ov_db: VITALS_QUERY_LABELS.overview_db,
    ov_conn: VITALS_QUERY_LABELS.overview_conn,
    ov_state: VITALS_QUERY_LABELS.overview_state,
    ov_rec: VITALS_QUERY_LABELS.overview_recovery,
    ov_bg: VITALS_QUERY_LABELS.overview_bgwriter,
    st_size: VITALS_QUERY_LABELS.storage_size,
    st_bloat: VITALS_QUERY_LABELS.storage_bloat,
    ix_unused: VITALS_QUERY_LABELS.indexes_unused,
    ix_invalid: VITALS_QUERY_LABELS.indexes_invalid,
    act_long: VITALS_QUERY_LABELS.activity_long,
};

function initialSectionMap(): Record<SectionKey, SectionState> {
    return {
        ov_db: { status: "idle" },
        ov_conn: { status: "idle" },
        ov_state: { status: "idle" },
        ov_rec: { status: "idle" },
        ov_bg: { status: "idle" },
        st_size: { status: "idle" },
        st_bloat: { status: "idle" },
        ix_unused: { status: "idle" },
        ix_invalid: { status: "idle" },
        act_long: { status: "idle" },
    };
}

function VitalsResultTable({ result }: { result: QueryResult }) {
    if (result.row_count === 0) {
        return (
            <p className="py-6 text-center text-sm text-muted-foreground">No rows returned.</p>
        );
    }
    return (
        <Table>
            <TableHeader>
                <TableRow className="border-border/40 hover:bg-transparent">
                    {result.columns.map((col) => (
                        <TableHead key={col.name} className="font-mono text-[11px] text-muted-foreground">
                            {col.name}
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {result.rows.map((row, ri) => (
                    <TableRow key={ri} className="border-border/30">
                        {row.map((cell, ci) => (
                            <TableCell
                                key={ci}
                                className="max-w-[min(28rem,40vw)] truncate font-mono text-[11px]"
                                title={formatCellValue(cell)}
                            >
                                {formatCellValue(cell)}
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

function SectionBlock({
    title,
    sectionKey,
    sql,
    state,
    onCopy,
    onOpenWorkspace,
    badgeVariant,
    badgeText,
}: {
    title: string;
    sectionKey: SectionKey;
    sql: string;
    state: SectionState;
    onCopy: (sql: string) => void;
    onOpenWorkspace: (sql: string, label: string) => void;
    badgeVariant?: "default" | "secondary" | "destructive" | "outline";
    badgeText?: string;
}) {
    return (
        <section className="rounded-xl border border-border/40 bg-card/30 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/35 px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
                    {badgeText ? (
                        <Badge variant={badgeVariant ?? "secondary"} className="text-[10px] font-normal">
                            {badgeText}
                        </Badge>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[11px] text-muted-foreground"
                                onClick={() => onCopy(sql)}
                                aria-label="Copy SQL"
                            >
                                <ClipboardCopy className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Copy SQL</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[11px] text-muted-foreground"
                                onClick={() =>
                                    onOpenWorkspace(sql, LABEL_FOR_SECTION[sectionKey] ?? title)
                                }
                                aria-label="Open in workspace query editor"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Open in Query</TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <div className="p-3">
                {state.status === "idle" || state.status === "loading" ? (
                    <div className="space-y-2 py-2">
                        <Skeleton className="h-8 w-full rounded-md" />
                        <Skeleton className="h-8 w-full rounded-md" />
                        <Skeleton className="h-8 w-2/3 rounded-md" />
                    </div>
                ) : state.status === "error" ? (
                    <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle className="text-sm">Could not load this section</AlertTitle>
                        <AlertDescription className="text-xs font-mono">{state.message}</AlertDescription>
                        <p className="mt-2 text-xs text-muted-foreground">
                            Some statistics require elevated privileges (e.g. role{" "}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">pg_monitor</code>
                            ).
                        </p>
                    </Alert>
                ) : (
                    <VitalsResultTable result={state.result} />
                )}
            </div>
        </section>
    );
}

export function DatabaseVitalsPanel({ connectionId }: { connectionId: string }) {
    const router = useRouter();
    const [tab, setTab] = useState<VitalsTab>("overview");
    const [sections, setSections] = useState<Record<SectionKey, SectionState>>(initialSectionMap);
    const [refreshing, setRefreshing] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const connectionIdRef = useRef(connectionId);
    connectionIdRef.current = connectionId;

    const runSection = useCallback(async (key: SectionKey, sql: string) => {
        setSections((prev) => ({ ...prev, [key]: { status: "loading" } }));
        try {
            const result = await dbExecuteQuery(connectionIdRef.current, sql);
            if (result.is_error) {
                setSections((prev) => ({
                    ...prev,
                    [key]: {
                        status: "error",
                        message: result.error_message?.trim() || "Query failed",
                    },
                }));
            } else {
                setSections((prev) => ({ ...prev, [key]: { status: "ok", result } }));
            }
        } catch (e) {
            setSections((prev) => ({
                ...prev,
                [key]: { status: "error", message: e instanceof Error ? e.message : String(e) },
            }));
        }
    }, []);

    const loadTab = useCallback(
        async (t: VitalsTab, showSpinner = false) => {
            if (showSpinner) setRefreshing(true);
            const jobs = TAB_SECTIONS[t].map(({ key, sql }) => runSection(key, sql));
            await Promise.all(jobs);
            setLastUpdated(Date.now());
            if (showSpinner) setRefreshing(false);
        },
        [runSection]
    );

    useEffect(() => {
        setSections(initialSectionMap());
    }, [connectionId]);

    useEffect(() => {
        void loadTab(tab, false);
    }, [connectionId, tab, loadTab]);

    useEffect(() => {
        if (!autoRefresh || tab !== "overview") return;
        const id = window.setInterval(() => {
            void loadTab("overview", false);
        }, 12_000);
        return () => window.clearInterval(id);
    }, [autoRefresh, tab, loadTab]);

    const handleRefresh = () => {
        void loadTab(tab, true);
    };

    const copySql = async (sql: string) => {
        try {
            await navigator.clipboard.writeText(sql.trim());
            toast.success("SQL copied");
        } catch {
            toast.error("Could not copy");
        }
    };

    const openInWorkspace = (sql: string, label: string) => {
        try {
            sessionStorage.setItem(
                PGSTUDIO_PENDING_QUERY_TAB_KEY,
                JSON.stringify({ sql: sql.trim(), title: label })
            );
        } catch {
            toast.error("Could not prepare query tab");
            return;
        }
        router.push("/");
    };

    const overviewExtras = buildOverviewHints(sections);

    return (
        <div className="space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <Database className="h-5 w-5" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold tracking-tight">Database Vitals</h1>
                        <p className="text-xs text-muted-foreground">
                            Live catalog and stats for the connected database. Each block loads independently.
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    {lastUpdated ? (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                            Updated {new Date(lastUpdated).toLocaleTimeString()}
                        </span>
                    ) : null}
                    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-2 py-1.5">
                        <Switch
                            id="vitals-auto-refresh"
                            checked={autoRefresh}
                            onCheckedChange={setAutoRefresh}
                            disabled={tab !== "overview"}
                        />
                        <Label
                            htmlFor="vitals-auto-refresh"
                            className={cn(
                                "cursor-pointer text-[11px] text-muted-foreground",
                                tab !== "overview" && "opacity-50"
                            )}
                        >
                            Auto-refresh overview (~12s)
                        </Label>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={handleRefresh}
                        disabled={refreshing}
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                        Refresh
                    </Button>
                </div>
            </div>

            {overviewExtras.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {overviewExtras.map((hint) => (
                        <Badge
                            key={hint.key}
                            variant={hint.tone === "warn" ? "outline" : "secondary"}
                            className={cn(
                                "text-[10px] font-normal",
                                hint.tone === "warn" &&
                                    "border-amber-500/40 text-amber-700 dark:text-amber-400"
                            )}
                        >
                            {hint.text}
                        </Badge>
                    ))}
                </div>
            ) : null}

            <Tabs value={tab} onValueChange={(v) => setTab(v as VitalsTab)} className="gap-4">
                <TabsList className="h-9 w-full justify-start overflow-x-auto bg-muted/30 p-1 sm:w-auto">
                    <TabsTrigger value="overview" className="text-xs">
                        Overview
                    </TabsTrigger>
                    <TabsTrigger value="storage" className="text-xs">
                        Storage &amp; vacuum
                    </TabsTrigger>
                    <TabsTrigger value="indexes" className="text-xs">
                        Indexes
                    </TabsTrigger>
                    <TabsTrigger value="activity" className="text-xs">
                        Activity
                    </TabsTrigger>
                </TabsList>

                {(["overview", "storage", "indexes", "activity"] as const).map((t) => (
                    <TabsContent key={t} value={t} className="mt-0 space-y-4 focus-visible:outline-none">
                        {TAB_SECTIONS[t].map(({ key, sql, title }) => (
                            <SectionBlock
                                key={key}
                                sectionKey={key}
                                title={title}
                                sql={sql}
                                state={sections[key]}
                                onCopy={copySql}
                                onOpenWorkspace={openInWorkspace}
                                {...sectionBadges(key, sections[key])}
                            />
                        ))}
                    </TabsContent>
                ))}
            </Tabs>
        </div>
    );
}

function sectionBadges(
    key: SectionKey,
    state: SectionState
): { badgeText?: string; badgeVariant?: "default" | "secondary" | "destructive" | "outline" } {
    if (state.status !== "ok") return {};
    const r = state.result;
    if (key === "ix_invalid" && r.row_count > 0) {
        return { badgeText: `${r.row_count} invalid`, badgeVariant: "destructive" };
    }
    if (key === "st_bloat" && r.row_count > 0) {
        return { badgeText: `${r.row_count} tables`, badgeVariant: "outline" };
    }
    if (key === "ix_unused" && r.row_count > 0) {
        return { badgeText: `${r.row_count} indexes`, badgeVariant: "secondary" };
    }
    return {};
}

function buildOverviewHints(sections: Record<SectionKey, SectionState>): { key: string; text: string; tone: "info" | "warn" }[] {
    const hints: { key: string; text: string; tone: "info" | "warn" }[] = [];
    const db = sections.ov_db;
    if (db.status === "ok" && db.result.rows[0]) {
        const cols = db.result.columns.map((c) => c.name);
        const row = db.result.rows[0];
        const num = (name: string) => {
            const i = cols.indexOf(name);
            if (i < 0) return null;
            const c = row[i];
            if (c?.type === "Null" || c?.value == null) return null;
            const v = c.value;
            if (typeof v === "number") return v;
            if (typeof v === "string") {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            }
            return null;
        };
        const hit = num("buffer_hit_pct");
        if (hit != null && hit < 90) {
            hints.push({
                key: "buffer",
                text: `Buffer cache hit ${hit.toFixed(1)}% (consider workload or memory)`,
                tone: "warn",
            });
        }
        const deadlocks = num("deadlocks");
        if (deadlocks != null && deadlocks > 0) {
            hints.push({ key: "dl", text: `${deadlocks} deadlocks recorded (since stats_reset)`, tone: "warn" });
        }
        const tempFiles = num("temp_files");
        if (tempFiles != null && tempFiles > 0) {
            hints.push({ key: "temp", text: `${tempFiles} temp files spilled to disk`, tone: "warn" });
        }
    }
    const conn = sections.ov_conn;
    if (conn.status === "ok" && conn.result.rows[0]) {
        const cols = conn.result.columns.map((c) => c.name);
        const row = conn.result.rows[0];
        const get = (name: string) => {
            const i = cols.indexOf(name);
            if (i < 0) return null;
            const c = row[i];
            if (c?.type === "Null" || c?.value == null) return null;
            return typeof c.value === "number" ? c.value : Number(c.value);
        };
        const maxC = get("max_connections");
        const total = get("total_backends");
        if (maxC != null && total != null && maxC > 0) {
            const pct = (100 * total) / maxC;
            if (pct >= 85) {
                hints.push({
                    key: "conn",
                    text: `Connections ${total} / ${maxC} (${pct.toFixed(0)}% of max_connections)`,
                    tone: "warn",
                });
            }
        }
    }
    const rec = sections.ov_rec;
    if (rec.status === "ok" && rec.result.rows[0]) {
        const cols = rec.result.columns.map((c) => c.name);
        const i = cols.indexOf("is_in_recovery");
        if (i >= 0) {
            const c = rec.result.rows[0]![i];
            const v = c?.value === true || c?.value === "t" || String(c?.value).toLowerCase() === "true";
            if (v) {
                hints.push({ key: "rep", text: "This session is connected to a standby (read-only)", tone: "info" });
            }
        }
    }
    return hints;
}
