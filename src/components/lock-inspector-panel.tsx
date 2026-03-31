"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    dbCancelBackend,
    dbGetLockInspector,
    dbTerminateBackend,
} from "@/lib/db-platform";
import { useConnectionStore } from "@/stores/connection-store";
import type { LockInventoryRow, LockWaitEdge } from "@/lib/types";
import { LockWaitGraphView } from "@/components/lock-inspector-graph";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    AlertCircle,
    Ban,
    GitBranch,
    Layers,
    Link2,
    Loader2,
    RefreshCw,
    Search,
    Skull,
    Table2,
} from "lucide-react";

type RefreshMs = 0 | 2000 | 5000;

function SummaryCard({
    icon,
    label,
    value,
    accent,
}: {
    icon: React.ReactNode;
    label: string;
    value: number | string;
    accent?: string;
}) {
    return (
        <div className="flex items-center gap-2.5 rounded-lg border border-border/20 bg-card/30 px-3.5 py-2.5">
            <div
                className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    accent ?? "bg-muted/40 text-muted-foreground"
                )}
            >
                {icon}
            </div>
            <div className="min-w-0">
                <div className="text-lg font-bold leading-none tabular-nums">{value}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground/70">{label}</div>
            </div>
        </div>
    );
}

function truncateOneLine(s: string | null, max = 72): string {
    if (!s) return "—";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

type SortKey = "blocked_pid" | "blocking_pid" | "locktype";

export function LockInspectorPanel() {
    const { connectionId } = useConnectionStore();

    const [waitEdges, setWaitEdges] = useState<LockWaitEdge[]>([]);
    const [inventory, setInventory] = useState<LockInventoryRow[]>([]);
    const [inventoryTruncated, setInventoryTruncated] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [refreshMs, setRefreshMs] = useState<RefreshMs>(2000);
    const [invFilter, setInvFilter] = useState("");
    const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
        key: "blocked_pid",
        dir: "asc",
    });

    const [detailEdge, setDetailEdge] = useState<LockWaitEdge | null>(null);
    const [confirm, setConfirm] = useState<{
        type: "cancel" | "terminate";
        pid: number;
        canCancel: boolean;
    } | null>(null);
    const [actionBusy, setActionBusy] = useState(false);

    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchData = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        setError(null);
        try {
            const data = await dbGetLockInspector(connectionId);
            setWaitEdges(data.wait_edges);
            setInventory(data.inventory);
            setInventoryTruncated(data.inventory_truncated);
            setLastRefresh(new Date());
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [connectionId]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (refreshMs <= 0 || !connectionId) return;
        timerRef.current = setInterval(fetchData, refreshMs);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [refreshMs, connectionId, fetchData]);

    const kpis = useMemo(() => {
        const blockedSet = new Set(waitEdges.map((e) => e.blocked_pid));
        const blockingSet = new Set(waitEdges.map((e) => e.blocking_pid));
        const advisory = waitEdges.filter((e) => e.locktype === "advisory").length;
        const relation = waitEdges.filter((e) => e.locktype === "relation").length;
        return {
            waitPairs: waitEdges.length,
            waitingBackends: blockedSet.size,
            involvedBlockers: blockingSet.size,
            advisory,
            relation,
        };
    }, [waitEdges]);

    const sortedWaits = useMemo(() => {
        const rows = [...waitEdges];
        const { key, dir } = sort;
        rows.sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            if (typeof av === "number" && typeof bv === "number") {
                return dir === "asc" ? av - bv : bv - av;
            }
            return dir === "asc"
                ? String(av).localeCompare(String(bv))
                : String(bv).localeCompare(String(av));
        });
        return rows;
    }, [waitEdges, sort]);

    const filteredInventory = useMemo(() => {
        const q = invFilter.trim().toLowerCase();
        if (!q) return inventory;
        return inventory.filter((r) => {
            return (
                String(r.pid).includes(q) ||
                r.locktype.toLowerCase().includes(q) ||
                r.mode.toLowerCase().includes(q) ||
                (r.relation_schema ?? "").toLowerCase().includes(q) ||
                (r.relation_name ?? "").toLowerCase().includes(q) ||
                (r.usename ?? "").toLowerCase().includes(q) ||
                (r.query_snippet ?? "").toLowerCase().includes(q)
            );
        });
    }, [inventory, invFilter]);

    async function runConfirm() {
        if (!confirm || !connectionId) return;
        setActionBusy(true);
        try {
            if (confirm.type === "terminate") {
                await dbTerminateBackend(connectionId, confirm.pid);
                toast.success(`Sent terminate to PID ${confirm.pid}`);
            } else {
                await dbCancelBackend(connectionId, confirm.pid);
                toast.success(`Sent cancel to PID ${confirm.pid}`);
            }
            setConfirm(null);
            await fetchData();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setActionBusy(false);
        }
    }

    function SortTh({
        col,
        label,
        className,
    }: {
        col: SortKey;
        label: string;
        className?: string;
    }) {
        const active = sort.key === col;
        return (
            <TableHead
                className={cn(
                    "cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 hover:text-foreground",
                    className
                )}
                onClick={() =>
                    setSort({
                        key: col,
                        dir: active && sort.dir === "desc" ? "asc" : "desc",
                    })
                }
            >
                {label}
                {active ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
            </TableHead>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500/90 to-rose-600 shadow-sm shadow-orange-500/20">
                        <Link2 className="h-4 w-4 text-white" />
                    </div>
                    <div>
                        <h1 className="text-base font-semibold tracking-tight">Lock &amp; Blocking Analyzer</h1>
                        <p className="text-xs text-muted-foreground/75">
                            Live <span className="font-mono">pg_locks</span> wait graph and inventory
                            for the connected database
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={String(refreshMs)}
                        onValueChange={(v) => setRefreshMs(Number(v) as RefreshMs)}
                    >
                        <SelectTrigger className="h-8 w-[130px] text-xs">
                            <SelectValue placeholder="Refresh" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="0">Manual only</SelectItem>
                            <SelectItem value="2000">Every 2s</SelectItem>
                            <SelectItem value="5000">Every 5s</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => fetchData()}
                        disabled={loading}
                    >
                        {loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Refresh
                    </Button>
                </div>
            </div>

            {error ? (
                <Alert variant="destructive" className="border-red-500/30 bg-red-500/5">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Could not read lock data</AlertTitle>
                    <AlertDescription className="text-xs">
                        {error}. You need permission to read{" "}
                        <span className="font-mono">pg_locks</span> and{" "}
                        <span className="font-mono">pg_stat_activity</span> (e.g. superuser, or{" "}
                        <span className="font-mono">pg_monitor</span> where applicable).
                    </AlertDescription>
                </Alert>
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <SummaryCard
                    icon={<GitBranch className="h-3.5 w-3.5" />}
                    label="Wait edges"
                    value={kpis.waitPairs}
                    accent="bg-orange-500/15 text-orange-400"
                />
                <SummaryCard
                    icon={<Loader2 className="h-3.5 w-3.5" />}
                    label="Waiting backends"
                    value={kpis.waitingBackends}
                    accent="bg-amber-500/15 text-amber-400"
                />
                <SummaryCard
                    icon={<Layers className="h-3.5 w-3.5" />}
                    label="Holding blockers"
                    value={kpis.involvedBlockers}
                    accent="bg-emerald-500/15 text-emerald-400"
                />
                <SummaryCard
                    icon={<Table2 className="h-3.5 w-3.5" />}
                    label="Relation waits"
                    value={kpis.relation}
                    accent="bg-violet-500/15 text-violet-400"
                />
                <SummaryCard
                    icon={<Link2 className="h-3.5 w-3.5" />}
                    label="Advisory waits"
                    value={kpis.advisory}
                    accent="bg-sky-500/15 text-sky-400"
                />
            </div>

            <div className="text-[10px] text-muted-foreground/50">
                {lastRefresh
                    ? `Last updated ${lastRefresh.toLocaleTimeString()}`
                    : "Not loaded yet"}
                {refreshMs > 0 ? ` · Auto refresh ${refreshMs / 1000}s` : " · Auto refresh off"}
                {inventoryTruncated ? " · Inventory capped at 500 rows" : ""}
            </div>

            <Tabs defaultValue="graph" className="w-full">
                <TabsList className="h-9 w-full justify-start gap-1 bg-muted/30 p-1 sm:w-auto">
                    <TabsTrigger value="graph" className="gap-1.5 text-xs">
                        <GitBranch className="h-3.5 w-3.5" />
                        Graph
                    </TabsTrigger>
                    <TabsTrigger value="waits" className="gap-1.5 text-xs">
                        <Layers className="h-3.5 w-3.5" />
                        Wait chains
                    </TabsTrigger>
                    <TabsTrigger value="inventory" className="gap-1.5 text-xs">
                        <Table2 className="h-3.5 w-3.5" />
                        Lock inventory
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="graph" className="mt-4 outline-none">
                    <Card className="border-border/35 bg-card/40">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Blocking graph</CardTitle>
                            <CardDescription className="text-xs">
                                Arrows point from the session holding the lock to the session waiting.
                                Based on PostgreSQL&apos;s join of ungranted and granted lock rows.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <LockWaitGraphView edges={waitEdges} />
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="waits" className="mt-4 outline-none">
                    <Card className="border-border/35 bg-card/40">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Wait chains</CardTitle>
                            <CardDescription className="text-xs">
                                One row per blocked / blocking pair. Open a row for full query text;
                                use actions with care on production.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="p-0 sm:p-2">
                            {sortedWaits.length === 0 ? (
                                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                                    No active lock waits.
                                </div>
                            ) : (
                                <ScrollArea className="h-[min(52vh,480px)] rounded-md border border-border/25">
                                    <Table>
                                        <TableHeader>
                                            <TableRow className="hover:bg-transparent">
                                                <SortTh col="blocked_pid" label="Blocked PID" />
                                                <SortTh col="blocking_pid" label="Blocking PID" />
                                                <SortTh col="locktype" label="Lock type" />
                                                <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                    Modes
                                                </TableHead>
                                                <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                    Object
                                                </TableHead>
                                                <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                    Wait event
                                                </TableHead>
                                                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                    Actions
                                                </TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {sortedWaits.map((e, idx) => (
                                                <TableRow
                                                    key={`${e.blocked_pid}-${e.blocking_pid}-${idx}`}
                                                    className="group cursor-pointer border-border/20"
                                                    onClick={() => setDetailEdge(e)}
                                                >
                                                    <TableCell className="font-mono text-xs tabular-nums">
                                                        {e.blocked_pid}
                                                    </TableCell>
                                                    <TableCell className="font-mono text-xs tabular-nums">
                                                        {e.blocking_pid}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge
                                                            variant="outline"
                                                            className="font-mono text-[10px]"
                                                        >
                                                            {e.locktype}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="max-w-[140px] font-mono text-[10px] text-muted-foreground">
                                                        {e.blocking_mode} → {e.blocked_mode}
                                                    </TableCell>
                                                    <TableCell className="max-w-[160px] truncate font-mono text-[10px]">
                                                        {e.relation_schema && e.relation_name
                                                            ? `${e.relation_schema}.${e.relation_name}`
                                                            : "—"}
                                                    </TableCell>
                                                    <TableCell className="max-w-[120px] truncate text-[10px] text-muted-foreground">
                                                        {e.blocked_wait_event
                                                            ? `${e.blocked_wait_event_type ?? ""}/${e.blocked_wait_event}`
                                                            : "—"}
                                                    </TableCell>
                                                    <TableCell
                                                        className="text-right"
                                                        onClick={(ev) => ev.stopPropagation()}
                                                    >
                                                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        className="h-7 w-7 p-0 text-amber-500/80 hover:bg-amber-500/10"
                                                                        onClick={() =>
                                                                            setConfirm({
                                                                                type: "cancel",
                                                                                pid: e.blocked_pid,
                                                                                canCancel:
                                                                                    e.blocked_state ===
                                                                                    "active",
                                                                            })
                                                                        }
                                                                        disabled={
                                                                            e.blocked_state !==
                                                                            "active"
                                                                        }
                                                                    >
                                                                        <Ban className="h-3 w-3" />
                                                                    </Button>
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    Cancel blocked session query
                                                                </TooltipContent>
                                                            </Tooltip>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        className="h-7 w-7 p-0 text-red-500/80 hover:bg-red-500/10"
                                                                        onClick={() =>
                                                                            setConfirm({
                                                                                type: "terminate",
                                                                                pid: e.blocked_pid,
                                                                                canCancel: true,
                                                                            })
                                                                        }
                                                                    >
                                                                        <Skull className="h-3 w-3" />
                                                                    </Button>
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    Terminate blocked backend
                                                                </TooltipContent>
                                                            </Tooltip>
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="inventory" className="mt-4 outline-none">
                    <Card className="border-border/35 bg-card/40">
                        <CardHeader className="space-y-3 pb-2">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <CardTitle className="text-sm">Lock inventory</CardTitle>
                                    <CardDescription className="text-xs">
                                        Rows from <span className="font-mono">pg_locks</span> for this
                                        database (plus global lock types), newest sort by grant status.
                                    </CardDescription>
                                </div>
                                <div className="relative max-w-xs">
                                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                                    <Input
                                        className="h-8 pl-8 text-xs"
                                        placeholder="Filter PID, type, relation…"
                                        value={invFilter}
                                        onChange={(ev) => setInvFilter(ev.target.value)}
                                    />
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="p-0 sm:p-2">
                            <ScrollArea className="h-[min(52vh,480px)] rounded-md border border-border/25">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="hover:bg-transparent">
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                PID
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Type
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Mode
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Granted
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Relation
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Session
                                            </TableHead>
                                            <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                                Query
                                            </TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {filteredInventory.map((r, i) => (
                                            <TableRow key={`${r.pid}-${r.locktype}-${r.mode}-${i}`}>
                                                <TableCell className="font-mono text-xs tabular-nums">
                                                    {r.pid}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant="outline"
                                                        className="font-mono text-[10px]"
                                                    >
                                                        {r.locktype}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="font-mono text-[10px]">
                                                    {r.mode}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant="outline"
                                                        className={cn(
                                                            "text-[9px]",
                                                            r.granted
                                                                ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                                                                : "border-orange-500/35 text-orange-600 dark:text-orange-400"
                                                        )}
                                                    >
                                                        {r.granted ? "granted" : "waiting"}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="max-w-[160px] truncate font-mono text-[10px]">
                                                    {r.relation_schema && r.relation_name
                                                        ? `${r.relation_schema}.${r.relation_name}`
                                                        : "—"}
                                                </TableCell>
                                                <TableCell className="max-w-[120px] text-[10px]">
                                                    <div className="truncate font-mono text-muted-foreground">
                                                        {r.usename ?? "—"}
                                                    </div>
                                                    <div className="truncate text-[9px] text-muted-foreground/70">
                                                        {r.state ?? ""}
                                                    </div>
                                                </TableCell>
                                                <TableCell
                                                    className="max-w-[220px] font-mono text-[10px] text-muted-foreground"
                                                    title={r.query_snippet ?? ""}
                                                >
                                                    {truncateOneLine(r.query_snippet, 64)}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                            {inventoryTruncated ? (
                                <p className="mt-2 px-2 text-[10px] text-muted-foreground/60">
                                    Showing first 500 locks; total may be higher.
                                </p>
                            ) : null}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            <Dialog open={!!detailEdge} onOpenChange={(o) => !o && setDetailEdge(null)}>
                <DialogContent className="max-w-2xl border-border/30 bg-card">
                    <DialogHeader>
                        <DialogTitle className="text-sm">
                            Wait detail — {detailEdge?.blocked_pid} blocked by{" "}
                            {detailEdge?.blocking_pid}
                        </DialogTitle>
                        <DialogDescription className="text-xs">
                            {detailEdge?.locktype}
                            {detailEdge?.relation_schema && detailEdge?.relation_name
                                ? ` · ${detailEdge.relation_schema}.${detailEdge.relation_name}`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    {detailEdge ? (
                        <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="rounded-md bg-muted/20 px-2.5 py-1.5">
                                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                                        Blocked mode (wanted)
                                    </div>
                                    <div className="font-mono">{detailEdge.blocked_mode}</div>
                                </div>
                                <div className="rounded-md bg-muted/20 px-2.5 py-1.5">
                                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                                        Blocking mode (held)
                                    </div>
                                    <div className="font-mono">{detailEdge.blocking_mode}</div>
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                                    Blocked session query
                                </div>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/20 bg-muted/25 p-3 font-mono text-[11px] leading-relaxed">
                                    {detailEdge.blocked_query || "(none)"}
                                </pre>
                            </div>
                            <div>
                                <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                                    Blocking session query
                                </div>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/20 bg-muted/25 p-3 font-mono text-[11px] leading-relaxed">
                                    {detailEdge.blocking_query || "(none)"}
                                </pre>
                            </div>
                        </div>
                    ) : null}
                    <DialogFooter className="gap-2">
                        {detailEdge ? (
                            <>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 text-xs"
                                    onClick={() => {
                                        setConfirm({
                                            type: "cancel",
                                            pid: detailEdge.blocked_pid,
                                            canCancel: detailEdge.blocked_state === "active",
                                        });
                                        setDetailEdge(null);
                                    }}
                                    disabled={detailEdge.blocked_state !== "active"}
                                >
                                    <Ban className="mr-1.5 h-3.5 w-3.5" />
                                    Cancel blocked query
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 border-red-500/30 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
                                    onClick={() => {
                                        setConfirm({
                                            type: "terminate",
                                            pid: detailEdge.blocked_pid,
                                            canCancel: true,
                                        });
                                        setDetailEdge(null);
                                    }}
                                >
                                    <Skull className="mr-1.5 h-3.5 w-3.5" />
                                    Terminate blocked
                                </Button>
                            </>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
                <DialogContent className="border-border/30 bg-card sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-sm">
                            {confirm?.type === "terminate"
                                ? "Terminate backend?"
                                : "Cancel query?"}
                        </DialogTitle>
                        <DialogDescription className="text-xs">
                            {confirm
                                ? confirm.type === "terminate"
                                    ? `This will end PID ${confirm.pid} with pg_terminate_backend.`
                                    : `This will send pg_cancel_backend to PID ${confirm.pid}.`
                                : null}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                            Back
                        </Button>
                        <Button
                            size="sm"
                            variant={confirm?.type === "terminate" ? "destructive" : "default"}
                            disabled={
                                actionBusy ||
                                (!!confirm && confirm.type === "cancel" && !confirm.canCancel)
                            }
                            onClick={() => runConfirm()}
                        >
                            {actionBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : confirm?.type === "terminate" ? (
                                "Terminate"
                            ) : (
                                "Cancel query"
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
