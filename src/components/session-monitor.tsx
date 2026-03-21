"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    dbGetSessions,
    dbTerminateBackend,
    dbCancelBackend,
} from "@/lib/db-platform";
import { useConnectionStore } from "@/stores/connection-store";
import type { PgSession } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Activity,
    AlertTriangle,
    Ban,
    ChevronDown,
    ChevronUp,
    Clock,
    Database,
    Eye,
    Filter,
    Loader2,
    MonitorStop,
    Pause,
    Play,
    RefreshCw,
    Search,
    Shield,
    Skull,
    User,
    Wifi,
    X,
    Zap,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(secs: number | null): string {
    if (secs === null || secs < 0) return "—";
    if (secs < 1) return `${Math.round(secs * 1000)}ms`;
    if (secs < 60) return `${secs.toFixed(1)}s`;
    if (secs < 3600) {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}m ${s}s`;
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
}

function truncateQuery(q: string | null, maxLen = 80): string {
    if (!q) return "—";
    const cleaned = q.replace(/\s+/g, " ").trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}

type SessionState =
    | "active"
    | "idle"
    | "idle in transaction"
    | "idle in transaction (aborted)"
    | "fastpath function call"
    | "disabled";

interface StateBadgeProps {
    state: string | null;
}

function StateBadge({ state }: StateBadgeProps) {
    const s = (state ?? "").toLowerCase() as SessionState;
    const cfg: Record<string, { label: string; cls: string }> = {
        active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
        "idle in transaction": { label: "Idle in Txn", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
        "idle in transaction (aborted)": { label: "Aborted Txn", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
        idle: { label: "Idle", cls: "bg-muted/40 text-muted-foreground border-border/30" },
        disabled: { label: "Disabled", cls: "bg-muted/20 text-muted-foreground/50 border-border/20" },
    };
    const { label, cls } = cfg[s] ?? { label: state ?? "Unknown", cls: "bg-muted/30 text-muted-foreground border-border/30" };
    return (
        <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide", cls)}>
            {label}
        </span>
    );
}

interface SortConfig {
    key: keyof PgSession | "query_duration_secs";
    dir: "asc" | "desc";
}

// ─── Summary stats ────────────────────────────────────────────────────────────

interface SummaryCardProps {
    icon: React.ReactNode;
    label: string;
    value: number;
    accent?: string;
}

function SummaryCard({ icon, label, value, accent }: SummaryCardProps) {
    return (
        <div className="flex items-center gap-2.5 rounded-lg border border-border/20 bg-card/30 px-3.5 py-2.5">
            <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", accent ?? "bg-muted/40 text-muted-foreground")}>
                {icon}
            </div>
            <div className="min-w-0">
                <div className="text-lg font-bold leading-none tabular-nums">{value}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground/70">{label}</div>
            </div>
        </div>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SessionMonitor() {
    const { connectionId } = useConnectionStore();

    const [sessions, setSessions] = useState<PgSession[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [paused, setPaused] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

    // Filters
    const [search, setSearch] = useState("");
    const [stateFilter, setStateFilter] = useState<string>("all");
    const [backendTypeFilter, setBackendTypeFilter] = useState<string>("all");

    // Sort
    const [sort, setSort] = useState<SortConfig>({ key: "query_duration_secs", dir: "desc" });

    // Selected row for full-query modal
    const [selectedSession, setSelectedSession] = useState<PgSession | null>(null);

    // Confirm kill / cancel
    const [confirmAction, setConfirmAction] = useState<{ type: "terminate" | "cancel"; session: PgSession } | null>(null);
    const [actionLoading, setActionLoading] = useState(false);

    // Auto-refresh
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchSessions = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        setError(null);
        try {
            const data = await dbGetSessions(connectionId);
            setSessions(data);
            setLastRefresh(new Date());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [connectionId]);

    // Initial fetch + interval
    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    useEffect(() => {
        if (paused) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }
        timerRef.current = setInterval(fetchSessions, 2000);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [paused, fetchSessions]);

    // ── Derived stats ──────────────────────────────────────────────────────

    const stats = {
        total: sessions.length,
        active: sessions.filter((s) => s.state === "active").length,
        idle: sessions.filter((s) => s.state === "idle").length,
        idleInTxn: sessions.filter((s) => s.state?.startsWith("idle in transaction")).length,
        blocked: sessions.filter((s) => s.blocking_pids.length > 0).length,
        waiting: sessions.filter((s) => s.wait_event !== null).length,
    };

    // Unique backend types for filter dropdown
    const backendTypes = Array.from(
        new Set(sessions.map((s) => s.backend_type ?? "unknown"))
    ).sort();

    // ── Filtering & sorting ────────────────────────────────────────────────

    const filtered = sessions
        .filter((s) => {
            if (stateFilter !== "all" && s.state !== stateFilter) return false;
            if (backendTypeFilter !== "all" && (s.backend_type ?? "unknown") !== backendTypeFilter) return false;
            if (search) {
                const q = search.toLowerCase();
                return (
                    String(s.pid).includes(q) ||
                    (s.usename ?? "").toLowerCase().includes(q) ||
                    (s.application_name ?? "").toLowerCase().includes(q) ||
                    (s.datname ?? "").toLowerCase().includes(q) ||
                    (s.query ?? "").toLowerCase().includes(q) ||
                    (s.client_addr ?? "").toLowerCase().includes(q)
                );
            }
            return true;
        })
        .sort((a, b) => {
            const key = sort.key as keyof PgSession;
            let av: unknown = a[key];
            let bv: unknown = b[key];
            if (av === null || av === undefined) av = sort.dir === "asc" ? Infinity : -Infinity;
            if (bv === null || bv === undefined) bv = sort.dir === "asc" ? Infinity : -Infinity;
            if (typeof av === "number" && typeof bv === "number") {
                return sort.dir === "asc" ? av - bv : bv - av;
            }
            return sort.dir === "asc"
                ? String(av).localeCompare(String(bv))
                : String(bv).localeCompare(String(av));
        });

    // ── Sort header helper ─────────────────────────────────────────────────

    function SortHeader({ col, label, className }: { col: SortConfig["key"]; label: string; className?: string }) {
        const active = sort.key === col;
        return (
            <th
                className={cn(
                    "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 cursor-pointer select-none hover:text-foreground transition-colors",
                    className
                )}
                onClick={() => setSort({ key: col, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
            >
                <span className="inline-flex items-center gap-1">
                    {label}
                    {active ? (
                        sort.dir === "desc" ? <ChevronDown className="h-3 w-3 text-emerald-400" /> : <ChevronUp className="h-3 w-3 text-emerald-400" />
                    ) : (
                        <span className="h-3 w-3 opacity-0 group-hover:opacity-40"><ChevronDown className="h-3 w-3" /></span>
                    )}
                </span>
            </th>
        );
    }

    // ── Actions ────────────────────────────────────────────────────────────

    async function handleConfirmedAction() {
        if (!confirmAction || !connectionId) return;
        setActionLoading(true);
        try {
            if (confirmAction.type === "terminate") {
                await dbTerminateBackend(connectionId, confirmAction.session.pid);
            } else {
                await dbCancelBackend(connectionId, confirmAction.session.pid);
            }
            setConfirmAction(null);
            await fetchSessions();
        } catch (e) {
            setError(String(e));
        } finally {
            setActionLoading(false);
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <div className="flex h-full flex-col bg-background text-foreground">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/20 bg-card/10 px-4 py-3 shrink-0">
                <div className="flex items-center gap-2.5">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-purple-600 shadow-sm shadow-violet-500/20">
                        <Activity className="h-3.5 w-3.5 text-white" />
                    </div>
                    <div>
                        <h2 className="text-sm font-semibold">Session Monitor</h2>
                        <p className="text-[10px] text-muted-foreground/60">
                            Live view of all active PostgreSQL connections
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {lastRefresh && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                            {paused ? "Paused" : `Updated ${lastRefresh.toLocaleTimeString()}`}
                        </span>
                    )}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40"
                                onClick={() => setPaused((p) => !p)}
                            >
                                {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                                {paused ? "Resume" : "Pause"}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {paused ? "Resume auto-refresh (2s)" : "Pause auto-refresh"}
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40"
                                onClick={fetchSessions}
                                disabled={loading}
                            >
                                <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Refresh now</TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-2 px-4 py-3 shrink-0 sm:grid-cols-6 border-b border-border/10">
                <SummaryCard
                    icon={<Wifi className="h-3.5 w-3.5" />}
                    label="Total"
                    value={stats.total}
                    accent="bg-blue-500/15 text-blue-400"
                />
                <SummaryCard
                    icon={<Zap className="h-3.5 w-3.5" />}
                    label="Active"
                    value={stats.active}
                    accent="bg-emerald-500/15 text-emerald-400"
                />
                <SummaryCard
                    icon={<Clock className="h-3.5 w-3.5" />}
                    label="Idle"
                    value={stats.idle}
                    accent="bg-muted/40 text-muted-foreground"
                />
                <SummaryCard
                    icon={<Database className="h-3.5 w-3.5" />}
                    label="Idle in Txn"
                    value={stats.idleInTxn}
                    accent="bg-amber-500/15 text-amber-400"
                />
                <SummaryCard
                    icon={<Shield className="h-3.5 w-3.5" />}
                    label="Blocked"
                    value={stats.blocked}
                    accent={stats.blocked > 0 ? "bg-red-500/15 text-red-400" : "bg-muted/40 text-muted-foreground"}
                />
                <SummaryCard
                    icon={<AlertTriangle className="h-3.5 w-3.5" />}
                    label="Waiting"
                    value={stats.waiting}
                    accent={stats.waiting > 0 ? "bg-orange-500/15 text-orange-400" : "bg-muted/40 text-muted-foreground"}
                />
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 shrink-0 border-b border-border/10 bg-card/5">
                <div className="relative flex-1 min-w-36 max-w-72">
                    <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
                    <Input
                        placeholder="Search PID, user, query, app…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="h-7 pl-7 pr-7 text-xs bg-muted/20 border-border/20 focus:border-emerald-500/40 focus:ring-0 placeholder:text-muted-foreground/40"
                    />
                    {search && (
                        <button
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
                            onClick={() => setSearch("")}
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-1.5">
                    <Filter className="h-3 w-3 text-muted-foreground/50" />
                    <span className="text-[10px] text-muted-foreground/60">State:</span>
                    <div className="flex rounded-md border border-border/20 bg-muted/20 overflow-hidden">
                        {["all", "active", "idle", "idle in transaction"].map((s) => (
                            <button
                                key={s}
                                onClick={() => setStateFilter(s)}
                                className={cn(
                                    "px-2 py-1 text-[10px] font-medium transition-all",
                                    stateFilter === s
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {s === "all" ? "All" : s === "idle in transaction" ? "Idle Txn" : s.charAt(0).toUpperCase() + s.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>

                {backendTypes.length > 1 && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground/60">Type:</span>
                        <select
                            value={backendTypeFilter}
                            onChange={(e) => setBackendTypeFilter(e.target.value)}
                            className="h-7 rounded-md border border-border/20 bg-muted/20 px-2 text-[10px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus:border-emerald-500/40"
                        >
                            <option value="all">All types</option>
                            {backendTypes.map((t) => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                    {filtered.length} / {sessions.length} sessions
                </div>
            </div>

            {/* Error banner */}
            {error && (
                <div className="mx-4 mt-2 flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400 shrink-0">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button onClick={() => setError(null)} className="shrink-0 hover:text-red-300">
                        <X className="h-3 w-3" />
                    </button>
                </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-auto">
                {loading && sessions.length === 0 ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading sessions…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                        <MonitorStop className="h-8 w-8 opacity-30" />
                        <p className="text-sm">No sessions match your filters</p>
                        <p className="text-xs opacity-60">
                            {sessions.length === 0 ? "No active sessions found" : `${sessions.length} sessions exist but none match the current filter`}
                        </p>
                    </div>
                ) : (
                    <table className="w-full min-w-[900px] border-collapse text-xs">
                        <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur-sm border-b border-border/20">
                            <tr>
                                <SortHeader col="pid" label="PID" className="w-16" />
                                <SortHeader col="usename" label="User" className="w-28" />
                                <SortHeader col="application_name" label="Application" className="w-32" />
                                <SortHeader col="datname" label="Database" className="w-28" />
                                <SortHeader col="state" label="State" className="w-28" />
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-52">Query</th>
                                <SortHeader col="query_duration_secs" label="Duration" className="w-20" />
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-28">Wait Event</th>
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-24">Blocked By</th>
                                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-24">Client</th>
                                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-28 pr-4">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((session, i) => {
                                const isBlocked = session.blocking_pids.length > 0;
                                const isActive = session.state === "active";
                                const isLongRunning = (session.query_duration_secs ?? 0) > 30;

                                return (
                                    <tr
                                        key={session.pid}
                                        className={cn(
                                            "group border-b border-border/10 transition-colors hover:bg-muted/20",
                                            i % 2 === 0 ? "bg-transparent" : "bg-card/10",
                                            isBlocked && "border-l-2 border-l-red-500/50",
                                            isLongRunning && isActive && "border-l-2 border-l-amber-500/50"
                                        )}
                                    >
                                        {/* PID */}
                                        <td className="px-3 py-2">
                                            <span className="font-mono text-xs text-muted-foreground/80">{session.pid}</span>
                                        </td>

                                        {/* User */}
                                        <td className="px-3 py-2">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <User className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                                                <span className="truncate text-foreground/80">{session.usename ?? "—"}</span>
                                            </div>
                                        </td>

                                        {/* Application */}
                                        <td className="px-3 py-2">
                                            <span className="truncate text-muted-foreground/70 block max-w-[7rem]" title={session.application_name ?? undefined}>
                                                {session.application_name || "—"}
                                            </span>
                                        </td>

                                        {/* Database */}
                                        <td className="px-3 py-2">
                                            <span className="truncate text-muted-foreground/70 block max-w-[6rem]" title={session.datname ?? undefined}>
                                                {session.datname ?? "—"}
                                            </span>
                                        </td>

                                        {/* State */}
                                        <td className="px-3 py-2">
                                            <StateBadge state={session.state} />
                                        </td>

                                        {/* Query */}
                                        <td className="px-3 py-2 max-w-[13rem]">
                                            {session.query ? (
                                                <button
                                                    className="group/q flex items-start gap-1 text-left"
                                                    onClick={() => setSelectedSession(session)}
                                                >
                                                    <span className="font-mono text-[10px] text-foreground/70 leading-tight line-clamp-2 group-hover/q:text-foreground transition-colors">
                                                        {truncateQuery(session.query, 100)}
                                                    </span>
                                                    <Eye className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/40 group-hover/q:text-emerald-400 transition-colors" />
                                                </button>
                                            ) : (
                                                <span className="text-muted-foreground/30">—</span>
                                            )}
                                        </td>

                                        {/* Duration */}
                                        <td className="px-3 py-2">
                                            <span className={cn(
                                                "font-mono tabular-nums text-xs",
                                                isLongRunning && isActive ? "text-amber-400" : "text-muted-foreground/70"
                                            )}>
                                                {formatDuration(session.query_duration_secs)}
                                            </span>
                                        </td>

                                        {/* Wait Event */}
                                        <td className="px-3 py-2">
                                            {session.wait_event ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 text-[10px] text-orange-400 cursor-default max-w-[6rem]">
                                                            <span className="truncate">{session.wait_event}</span>
                                                        </span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        <p className="text-xs">Type: {session.wait_event_type ?? "unknown"}</p>
                                                        <p className="text-xs">Event: {session.wait_event}</p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <span className="text-muted-foreground/30">—</span>
                                            )}
                                        </td>

                                        {/* Blocked By */}
                                        <td className="px-3 py-2">
                                            {isBlocked ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 text-[10px] text-red-400 cursor-default">
                                                            <Shield className="h-2.5 w-2.5 shrink-0" />
                                                            {session.blocking_pids.length === 1
                                                                ? `PID ${session.blocking_pids[0]}`
                                                                : `${session.blocking_pids.length} PIDs`}
                                                        </span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        Blocked by PID{session.blocking_pids.length > 1 ? "s" : ""}: {session.blocking_pids.join(", ")}
                                                    </TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <span className="text-muted-foreground/30">—</span>
                                            )}
                                        </td>

                                        {/* Client */}
                                        <td className="px-3 py-2">
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <span className="truncate font-mono text-[10px] text-muted-foreground/60 block max-w-[5.5rem] cursor-default">
                                                        {session.client_addr
                                                            ? `${session.client_addr}${session.client_port ? `:${session.client_port}` : ""}`
                                                            : "local"}
                                                    </span>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {session.client_addr
                                                        ? `${session.client_addr}:${session.client_port ?? "?"}`
                                                        : "Local/Unix socket"}
                                                </TooltipContent>
                                            </Tooltip>
                                        </td>

                                        {/* Actions */}
                                        <td className="px-3 py-2 pr-4 text-right">
                                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-6 w-6 p-0 text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10"
                                                            onClick={() => setConfirmAction({ type: "cancel", session })}
                                                            disabled={!isActive}
                                                        >
                                                            <Ban className="h-3 w-3" />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Cancel query (pg_cancel_backend)</TooltipContent>
                                                </Tooltip>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-6 w-6 p-0 text-red-400/70 hover:text-red-400 hover:bg-red-500/10"
                                                            onClick={() => setConfirmAction({ type: "terminate", session })}
                                                        >
                                                            <Skull className="h-3 w-3" />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Terminate session (pg_terminate_backend)</TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Status bar */}
            <div className="flex items-center justify-between border-t border-border/20 bg-card/10 px-4 py-1.5 shrink-0">
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
                    <span>
                        <span className={cn("inline-block h-1.5 w-1.5 rounded-full mr-1.5", paused ? "bg-amber-500" : "bg-emerald-500 animate-pulse")} />
                        {paused ? "Paused" : "Live — refreshes every 2s"}
                    </span>
                    {loading && <span className="flex items-center gap-1"><Loader2 className="h-2.5 w-2.5 animate-spin" /> Fetching…</span>}
                </div>
                <div className="text-[10px] text-muted-foreground/40">
                    pg_stat_activity
                </div>
            </div>

            {/* Full query dialog */}
            <Dialog open={!!selectedSession} onOpenChange={(o) => !o && setSelectedSession(null)}>
                <DialogContent className="max-w-2xl bg-card border-border/30">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-sm">
                            <Eye className="h-4 w-4 text-emerald-400" />
                            Session Details — PID {selectedSession?.pid}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-muted-foreground/60">
                            Full query and session information
                        </DialogDescription>
                    </DialogHeader>

                    {selectedSession && (
                        <div className="space-y-3 text-xs">
                            {/* Meta grid */}
                            <div className="grid grid-cols-2 gap-2">
                                {[
                                    ["User", selectedSession.usename],
                                    ["Application", selectedSession.application_name],
                                    ["Database", selectedSession.datname],
                                    ["State", selectedSession.state],
                                    ["Client", selectedSession.client_addr
                                        ? `${selectedSession.client_addr}:${selectedSession.client_port ?? "?"}`
                                        : "Local socket"],
                                    ["Backend Type", selectedSession.backend_type],
                                    ["Query Duration", formatDuration(selectedSession.query_duration_secs)],
                                    ["Txn Duration", formatDuration(selectedSession.xact_duration_secs)],
                                    ["Connected Since", selectedSession.backend_duration_secs !== null
                                        ? formatDuration(selectedSession.backend_duration_secs)
                                        : "—"],
                                    ["Wait Event", selectedSession.wait_event
                                        ? `${selectedSession.wait_event_type ?? ""} / ${selectedSession.wait_event}`
                                        : "None"],
                                    ["Blocked By", selectedSession.blocking_pids.length > 0
                                        ? `PID ${selectedSession.blocking_pids.join(", ")}`
                                        : "None"],
                                ].map(([label, val]) => (
                                    <div key={label} className="rounded-md bg-muted/20 px-2.5 py-1.5">
                                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-0.5">{label}</div>
                                        <div className="font-medium text-foreground/80 truncate">{val || "—"}</div>
                                    </div>
                                ))}
                            </div>

                            {/* Full query */}
                            <div>
                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-1.5">Query</div>
                                <pre className="rounded-md bg-muted/30 border border-border/20 p-3 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-all max-h-52 overflow-auto">
                                    {selectedSession.query || "(no query)"}
                                </pre>
                            </div>
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        {selectedSession && (
                            <>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50"
                                    disabled={selectedSession.state !== "active"}
                                    onClick={() => {
                                        setConfirmAction({ type: "cancel", session: selectedSession });
                                        setSelectedSession(null);
                                    }}
                                >
                                    <Ban className="h-3 w-3 mr-1.5" />
                                    Cancel Query
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                                    onClick={() => {
                                        setConfirmAction({ type: "terminate", session: selectedSession });
                                        setSelectedSession(null);
                                    }}
                                >
                                    <Skull className="h-3 w-3 mr-1.5" />
                                    Terminate Session
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => setSelectedSession(null)}
                                >
                                    Close
                                </Button>
                            </>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Confirm action dialog */}
            <Dialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
                <DialogContent className="max-w-sm bg-card border-border/30">
                    <DialogHeader>
                        <DialogTitle className={cn(
                            "flex items-center gap-2 text-sm",
                            confirmAction?.type === "terminate" ? "text-red-400" : "text-amber-400"
                        )}>
                            {confirmAction?.type === "terminate"
                                ? <Skull className="h-4 w-4" />
                                : <Ban className="h-4 w-4" />}
                            {confirmAction?.type === "terminate"
                                ? "Terminate Session?"
                                : "Cancel Query?"}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-muted-foreground/70">
                            {confirmAction?.type === "terminate"
                                ? `This will forcefully disconnect PID ${confirmAction?.session.pid} (${confirmAction?.session.usename ?? "unknown user"}). Any uncommitted transactions will be rolled back.`
                                : `This will send a cancel signal to PID ${confirmAction?.session.pid} (${confirmAction?.session.usename ?? "unknown user"}). The session will remain connected.`}
                        </DialogDescription>
                    </DialogHeader>

                    {confirmAction?.session.query && (
                        <div className="rounded-md bg-muted/30 border border-border/20 p-2.5 text-[10px] font-mono text-muted-foreground/70 max-h-28 overflow-auto">
                            {truncateQuery(confirmAction.session.query, 200)}
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setConfirmAction(null)}
                            disabled={actionLoading}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className={cn(
                                "h-7 text-xs",
                                confirmAction?.type === "terminate"
                                    ? "bg-red-500/80 hover:bg-red-500 text-white border-red-500/50"
                                    : "bg-amber-500/80 hover:bg-amber-500 text-white border-amber-500/50"
                            )}
                            onClick={handleConfirmedAction}
                            disabled={actionLoading}
                        >
                            {actionLoading && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                            {confirmAction?.type === "terminate" ? "Terminate" : "Cancel Query"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
