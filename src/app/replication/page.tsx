"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/app-config";
import { isTauri } from "@/lib/tauri-runtime";
import { useConnectionStore } from "@/stores/connection-store";
import {
    useReplicationStore,
    getLagChartData,
    getSlotAlerts,
    getFailoverReadiness,
    formatBytes,
} from "@/stores/replication-store";
import type { ReplicationReplicaRow, ReplicationSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ReplicaLagChart } from "@/components/replication/replica-lag-chart";
import { ReplicationSetupDialog } from "@/components/replication/replication-setup-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
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
    Activity,
    AlertTriangle,
    ArrowLeft,
    ChevronDown,
    Copy,
    Download,
    GitBranch,
    Pause,
    Play,
    RefreshCw,
    Rocket,
    Server,
    Settings2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

function formatReplayLagMs(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatLagCell(ms: number | null): { text: string; cls: string } {
    if (ms == null) return { text: "—", cls: "text-muted-foreground" };
    const text = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    if (ms < 1000) return { text, cls: "text-emerald-400 tabular-nums" };
    if (ms <= 5000) return { text, cls: "text-amber-400 tabular-nums" };
    return { text, cls: "text-red-400 tabular-nums" };
}

function replicaStateBadge(state: string) {
    const s = state.toLowerCase();
    const map: Record<string, string> = {
        streaming: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        catchup: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        startup: "bg-sky-500/15 text-sky-400 border-sky-500/30",
        backup: "bg-violet-500/15 text-violet-300 border-violet-500/30",
        stopping: "bg-red-500/15 text-red-400 border-red-500/30",
    };
    const cls = map[s] ?? "bg-muted/30 text-muted-foreground border-border/30";
    return (
        <span
            className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                cls
            )}
        >
            {state || "unknown"}
        </span>
    );
}

function syncBadge(sync: string) {
    const s = sync.toLowerCase();
    const map: Record<string, string> = {
        sync: "bg-sky-500/15 text-sky-300 border-sky-500/30",
        async: "bg-muted/40 text-muted-foreground border-border/30",
        quorum: "bg-violet-500/15 text-violet-300 border-violet-500/30",
        potential: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    };
    const cls = map[s] ?? "bg-muted/30 text-muted-foreground border-border/30";
    return (
        <span
            className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide",
                cls
            )}
        >
            {sync || "—"}
        </span>
    );
}

async function copyText(label: string, text: string) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success(`Copied ${label}`);
    } catch {
        toast.error("Copy failed");
    }
}

function downloadSnapshot(snap: ReplicationSnapshot) {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replication-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Snapshot downloaded");
}

export default function ReplicationMonitorPage() {
    const desktop = typeof window !== "undefined" && isTauri();
    const [paused, setPaused] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [setupOpen, setSetupOpen] = useState(false);
    const [walMbDraft, setWalMbDraft] = useState("");

    const connectionId = useConnectionStore((s) => s.connectionId);
    const isConnected = useConnectionStore((s) => s.isConnected);
    const entry = useConnectionStore((s) =>
        s.connections.find((c) => c.connectionId === s.connectionId)
    );
    const databaseName = entry?.databaseName ?? "";
    const serverVersion = entry?.serverVersion ?? "";

    const {
        snapshots,
        latest,
        patroni,
        patroniError,
        snapshotWarning,
        isLoading,
        pollingIntervalMs,
        walAlertThresholdBytes,
        patroniUrl,
        error,
        startPolling,
        stopPolling,
        fetchPatroni,
        setPollingInterval,
        setWalAlertThreshold,
        setPatroniUrl,
        fetchOnce,
    } = useReplicationStore(
        useShallow((s) => ({
            snapshots: s.snapshots,
            latest: s.latest,
            patroni: s.patroni,
            patroniError: s.patroniError,
            snapshotWarning: s.snapshotWarning,
            isLoading: s.isLoading,
            pollingIntervalMs: s.pollingIntervalMs,
            walAlertThresholdBytes: s.walAlertThresholdBytes,
            patroniUrl: s.patroniUrl,
            error: s.error,
            startPolling: s.startPolling,
            stopPolling: s.stopPolling,
            fetchPatroni: s.fetchPatroni,
            setPollingInterval: s.setPollingInterval,
            setWalAlertThreshold: s.setWalAlertThreshold,
            setPatroniUrl: s.setPatroniUrl,
            fetchOnce: s.fetchOnce,
        }))
    );

    useEffect(() => {
        if (!desktop || !connectionId || paused) return;
        startPolling(connectionId);
        return () => stopPolling();
    }, [desktop, connectionId, paused, startPolling, stopPolling]);

    const slotAlerts = useMemo(
        () => (latest ? getSlotAlerts(latest.slots, walAlertThresholdBytes) : []),
        [latest, walAlertThresholdBytes]
    );

    const readiness = getFailoverReadiness(latest);

    const streamingCount = useMemo(
        () =>
            latest?.replicas.filter((r) => r.state.toLowerCase() === "streaming").length ?? 0,
        [latest]
    );

    const applyWalThresholdMb = useCallback(() => {
        const n = parseFloat(walMbDraft.replace(",", "."));
        if (Number.isFinite(n) && n >= 0) {
            setWalAlertThreshold(Math.round(n * 1024 * 1024));
            toast.success("WAL alert threshold updated");
        }
    }, [walMbDraft, setWalAlertThreshold]);

    if (!desktop) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-transparent px-6">
                <Card className="max-w-md border-border/40 bg-card/50 shadow-lg animate-in fade-in zoom-in-95 duration-300">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <GitBranch className="h-5 w-5 text-emerald-400" />
                            Replication Monitor
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        This view runs inside the pgStudio desktop app where it can query
                        PostgreSQL and optional Patroni APIs securely.
                    </CardContent>
                    <CardFooter>
                        <Button asChild variant="secondary">
                            <Link href="/">Back to workspace</Link>
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        );
    }

    if (!isConnected || !connectionId) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-transparent px-6">
                <Card className="max-w-md border-border/40 bg-card/40 text-center animate-in fade-in duration-300">
                    <CardHeader>
                        <CardTitle className="text-lg">No active connection</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Connect to a PostgreSQL primary to monitor streaming replicas and
                        replication slots.
                    </CardContent>
                    <CardFooter className="justify-center">
                        <Button asChild>
                            <Link href="/">Back to Connections</Link>
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        );
    }

    const lastUpdated =
        latest != null ? new Date(latest.capturedAtMs).toLocaleString() : null;

    return (
        <div className="min-h-screen bg-transparent text-foreground">
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-28 -right-20 h-72 w-72 rounded-full bg-emerald-500/6 blur-3xl" />
                <div className="absolute bottom-0 -left-16 h-72 w-72 rounded-full bg-cyan-500/6 blur-3xl" />
            </div>

            <header className="sticky top-0 z-20 border-b border-border/35 bg-card/80 backdrop-blur-md">
                <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-3 px-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <Image
                            src="/logo.png"
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 shrink-0 rounded-md object-contain"
                        />
                        <div className="min-w-0">
                            <h1 className="truncate text-sm font-bold tracking-tight sm:text-base">
                                <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                                    {APP_NAME}
                                </span>
                                <span className="text-foreground/90"> · Replication Monitor</span>
                            </h1>
                            <p className="truncate text-[10px] text-muted-foreground/80 sm:text-[11px]">
                                {lastUpdated ? `Updated ${lastUpdated}` : isLoading ? "Loading…" : "—"}
                                {latest?.isInRecovery ? " · standby (recovery)" : " · primary"}
                            </p>
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
                        <Badge variant="outline" className="hidden h-6 border-border/40 font-mono text-[10px] sm:inline-flex">
                            {databaseName}
                        </Badge>
                        {serverVersion && (
                            <Badge variant="outline" className="hidden h-6 border-border/40 font-mono text-[10px] md:inline-flex">
                                {serverVersion}
                            </Badge>
                        )}

                        <div className="flex items-center rounded-lg border border-border/30 bg-muted/20 p-0.5">
                            {([5000, 10000, 30000] as const).map((ms) => (
                                <Button
                                    key={ms}
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                        "h-7 px-2 text-[10px] transition-all",
                                        pollingIntervalMs === ms
                                            ? "bg-background shadow-sm"
                                            : "text-muted-foreground"
                                    )}
                                    onClick={() => setPollingInterval(ms)}
                                >
                                    {ms / 1000}s
                                </Button>
                            ))}
                        </div>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 border-border/40 px-2"
                                    onClick={() => {
                                        setPaused((p) => !p);
                                    }}
                                >
                                    {paused ? (
                                        <Play className="h-3.5 w-3.5" />
                                    ) : (
                                        <Pause className="h-3.5 w-3.5" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>{paused ? "Resume polling" : "Pause polling"}</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 border-border/40 px-2"
                                    disabled={!connectionId || isLoading}
                                    onClick={() => connectionId && void fetchOnce(connectionId)}
                                >
                                    <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Refresh now</TooltipContent>
                        </Tooltip>

                        <Popover
                            open={settingsOpen}
                            onOpenChange={(open) => {
                                setSettingsOpen(open);
                                if (open) {
                                    const mb = walAlertThresholdBytes / (1024 * 1024);
                                    setWalMbDraft(
                                        Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
                                    );
                                }
                            }}
                        >
                            <PopoverTrigger asChild>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 border-border/40 px-2"
                                    aria-label="Replication settings"
                                >
                                    <Settings2 className="h-3.5 w-3.5" />
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80 p-4" align="end">
                                <div className="space-y-3">
                                    <div>
                                        <Label className="text-xs">WAL alert threshold (MB)</Label>
                                        <div className="mt-1 flex gap-2">
                                            <Input
                                                className="h-8 text-xs"
                                                value={walMbDraft}
                                                onChange={(e) => setWalMbDraft(e.target.value)}
                                            />
                                            <Button size="sm" className="h-8 shrink-0" onClick={applyWalThresholdMb}>
                                                Apply
                                            </Button>
                                        </div>
                                    </div>
                                    <div>
                                        <Label className="text-xs">Patroni REST base URL</Label>
                                        <Input
                                            className="mt-1 h-8 text-xs"
                                            placeholder="https://patroni:8008"
                                            value={patroniUrl}
                                            onChange={(e) => setPatroniUrl(e.target.value)}
                                        />
                                    </div>
                                    <Button
                                        size="sm"
                                        className="w-full"
                                        variant="secondary"
                                        onClick={() => void fetchPatroni()}
                                    >
                                        Fetch Patroni cluster
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>

                        <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                            <Link href="/">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Workspace</span>
                            </Link>
                        </Button>
                    </div>
                </div>
            </header>

            <main className="relative mx-auto max-w-7xl space-y-5 px-4 py-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
                {error && (
                    <Alert variant="destructive" className="border-red-500/40">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>Replication snapshot failed</AlertTitle>
                        <AlertDescription className="text-xs">{error}</AlertDescription>
                    </Alert>
                )}

                {(snapshotWarning || latest?.fetchWarning) && (
                    <Alert className="border-amber-500/35 bg-amber-500/5">
                        <AlertTriangle className="h-4 w-4 text-amber-400" />
                        <AlertTitle className="text-amber-200">Permission or capability notice</AlertTitle>
                        <AlertDescription className="text-xs text-muted-foreground">
                            {snapshotWarning || latest?.fetchWarning}
                        </AlertDescription>
                    </Alert>
                )}

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryStat
                        icon={<Server className="h-3.5 w-3.5" />}
                        label="Streaming replicas"
                        value={
                            latest
                                ? `${streamingCount} / ${latest.replicas.length}`
                                : isLoading
                                  ? "…"
                                  : "—"
                        }
                        accent="bg-emerald-500/15 text-emerald-400"
                    />
                    <SummaryStat
                        icon={<Activity className="h-3.5 w-3.5" />}
                        label="Max replay lag"
                        value={formatReplayLagMs(latest?.maxReplayLagMs ?? null)}
                        accent="bg-sky-500/15 text-sky-400"
                    />
                    <SummaryStat
                        icon={<GitBranch className="h-3.5 w-3.5" />}
                        label="WAL retained (slots)"
                        value={
                            latest != null ? formatBytes(latest.walRetainedTotalBytes) : isLoading ? "…" : "—"
                        }
                        accent="bg-violet-500/15 text-violet-300"
                    />
                    <div className="flex items-center gap-2.5 rounded-lg border border-border/20 bg-card/30 px-3.5 py-2.5 transition-colors hover:bg-card/40">
                        <div
                            className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                                readiness === "ready"
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : readiness === "lagging"
                                      ? "bg-amber-500/15 text-amber-400"
                                      : "bg-red-500/15 text-red-400"
                            )}
                        >
                            <Activity className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                            <Badge
                                className={cn(
                                    "text-[10px] font-bold tracking-wide",
                                    readiness === "ready" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                                    readiness === "lagging" && "border-amber-500/40 bg-amber-500/10 text-amber-400",
                                    readiness === "no_replicas" &&
                                        "border-red-500/40 bg-red-500/10 text-red-400"
                                )}
                            >
                                {readiness === "ready" && "FAILOVER READY"}
                                {readiness === "lagging" && "LAGGING"}
                                {readiness === "no_replicas" && "NO REPLICAS"}
                            </Badge>
                            <div className="mt-0.5 text-[10px] text-muted-foreground/70">Failover signal</div>
                        </div>
                    </div>
                </div>

                {slotAlerts.length > 0 && (
                    <Alert className="border-amber-500/40 bg-amber-500/[0.07] animate-in fade-in duration-300">
                        <AlertTriangle className="h-4 w-4 text-amber-400" />
                        <AlertTitle>Replication slot WAL pressure</AlertTitle>
                        <AlertDescription className="text-xs">
                            <ul className="mt-2 list-inside list-disc space-y-1">
                                {slotAlerts.map((sl) => (
                                    <li key={sl.slotName}>
                                        <span className="font-mono">{sl.slotName}</span>
                                        {" — "}
                                        retaining{" "}
                                        {sl.walRetainedBytes != null
                                            ? formatBytes(sl.walRetainedBytes)
                                            : "unknown"}{" "}
                                        of WAL
                                        {!sl.active && (
                                            <span className="text-amber-200/80"> (inactive)</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        className="h-7 gap-1 bg-emerald-600/90 text-[10px] hover:bg-emerald-600"
                        onClick={() => setSetupOpen(true)}
                    >
                        <Rocket className="h-3 w-3" />
                        Replica setup
                    </Button>
                    {latest && (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[10px]"
                                onClick={() => void copyText("primary LSN", latest.primaryLsn)}
                            >
                                <Copy className="h-3 w-3" />
                                Copy primary LSN
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[10px]"
                                onClick={() => downloadSnapshot(latest)}
                            >
                                <Download className="h-3 w-3" />
                                Export JSON
                            </Button>
                        </>
                    )}
                </div>

                {connectionId && (
                    <ReplicationSetupDialog
                        open={setupOpen}
                        onOpenChange={setSetupOpen}
                        connectionId={connectionId}
                        isStandby={latest?.isInRecovery ?? false}
                        onReplicationChanged={() => void fetchOnce(connectionId)}
                    />
                )}

                <details className="group rounded-lg border border-border/25 bg-card/20 transition-colors open:bg-card/30">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
                        Diagnostics &amp; permissions
                    </summary>
                    <div className="space-y-2 border-t border-border/20 px-3 py-3 text-[11px] text-muted-foreground">
                        <p>
                            <code className="rounded bg-muted/50 px-1">pg_stat_replication</code> and{" "}
                            <code className="rounded bg-muted/50 px-1">pg_replication_slots</code> require{" "}
                            <strong className="text-foreground/90">pg_monitor</strong> or superuser. Per-slot WAL
                            size uses <code className="rounded bg-muted/50 px-1">pg_wal_lsn_diff</code> (PostgreSQL
                            10+).
                        </p>
                        {latest && (
                            <p className="font-mono text-[10px] text-foreground/70">
                                pg_is_in_recovery = {String(latest.isInRecovery)} · primary_lsn = {latest.primaryLsn}
                            </p>
                        )}
                    </div>
                </details>

                {isLoading && !latest && (
                    <div className="grid gap-3 md:grid-cols-2">
                        <Skeleton className="h-48 rounded-xl border border-border/20" />
                        <Skeleton className="h-48 rounded-xl border border-border/20" />
                    </div>
                )}

                {latest && latest.replicas.length === 0 && !isLoading && (
                    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/35 bg-muted/5 py-16 text-center animate-in fade-in duration-300">
                        <Server className="mb-3 h-10 w-10 text-muted-foreground/40" />
                        <p className="max-w-md text-sm text-muted-foreground">
                            No replicas found. This instance may be a standalone primary with no active streaming
                            replicas, a standby, or your role may lack access to{" "}
                            <code className="text-xs">pg_stat_replication</code>.
                        </p>
                    </div>
                )}

                {latest && latest.replicas.length > 0 && (
                    <div className="grid gap-4 md:grid-cols-2">
                        {latest.replicas.map((replica) => (
                            <ReplicaCard
                                key={`${replica.pid}-${replica.applicationName}`}
                                replica={replica}
                                snapshots={snapshots}
                            />
                        ))}
                    </div>
                )}

                {patroni && (
                    <Card className="border-border/30 bg-card/40 animate-in fade-in slide-in-from-bottom-1 duration-400">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <GitBranch className="h-4 w-4 text-cyan-400" />
                                Patroni cluster
                                {patroni.scope ? (
                                    <span className="font-mono text-sm font-normal text-muted-foreground">
                                        {patroni.scope}
                                    </span>
                                ) : null}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-border/30 hover:bg-transparent">
                                        <TableHead className="text-xs">Name</TableHead>
                                        <TableHead className="text-xs">Role</TableHead>
                                        <TableHead className="text-xs">State</TableHead>
                                        <TableHead className="text-xs text-right">Lag</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {patroni.nodes.map((n) => (
                                        <TableRow key={n.name} className="border-border/20">
                                            <TableCell className="font-mono text-xs">{n.name}</TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="text-[10px]">
                                                    {n.role}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-xs">{n.state}</TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                {n.lag != null ? formatBytes(n.lag) : "—"}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                        <CardFooter className="text-xs text-muted-foreground">
                            Patroni failover_possible (heuristic):{" "}
                            <span className={patroni.failoverPossible ? "text-emerald-400" : "text-amber-400"}>
                                {patroni.failoverPossible ? "yes" : "no"}
                            </span>
                        </CardFooter>
                    </Card>
                )}

                {patroniError && (
                    <Alert className="border-border/40">
                        <AlertTitle className="text-sm">Patroni</AlertTitle>
                        <AlertDescription className="text-xs">{patroniError}</AlertDescription>
                    </Alert>
                )}
            </main>
        </div>
    );
}

function SummaryStat({
    icon,
    label,
    value,
    accent,
}: {
    icon: ReactNode;
    label: string;
    value: string;
    accent: string;
}) {
    return (
        <div className="flex items-center gap-2.5 rounded-lg border border-border/20 bg-card/30 px-3.5 py-2.5 transition-all duration-200 hover:border-border/35 hover:bg-card/45">
            <div
                className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    accent
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

function ReplicaCard({
    replica,
    snapshots,
}: {
    replica: ReplicationReplicaRow;
    snapshots: ReplicationSnapshot[];
}) {
    const chartData = getLagChartData(snapshots, replica.applicationName);
    const addr =
        replica.clientAddr != null
            ? `${replica.clientAddr}${replica.clientPort != null ? `:${replica.clientPort}` : ""}`
            : "—";

    const line = `${replica.applicationName} pid=${replica.pid} state=${replica.state} replay_lag_ms=${replica.replayLagMs ?? "null"}`;

    return (
        <Card className="overflow-hidden border-border/25 bg-card/35 shadow-sm transition-all duration-300 hover:border-emerald-500/20 hover:shadow-md animate-in fade-in zoom-in-95">
            <CardHeader className="space-y-2 pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <CardTitle className="truncate text-sm font-semibold">
                            {replica.applicationName || "(no app name)"}
                        </CardTitle>
                        <p className="truncate font-mono text-[10px] text-muted-foreground/80">{addr}</p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {replicaStateBadge(replica.state)}
                        {syncBadge(replica.syncState)}
                    </div>
                </div>
                <div className="flex gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[10px]"
                        onClick={() => void copyText("replica summary", line)}
                    >
                        <Copy className="h-3 w-3" />
                        Copy
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                    {(["write", "flush", "replay"] as const).map((k) => {
                        const lsnKey =
                            k === "write"
                                ? replica.writeLsn
                                : k === "flush"
                                  ? replica.flushLsn
                                  : replica.replayLsn;
                        const label = k === "write" ? "Write LSN" : k === "flush" ? "Flush LSN" : "Replay LSN";
                        return (
                            <div key={k} className="rounded-md bg-muted/20 px-1 py-1.5">
                                <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                                    {label}
                                </div>
                                <div className="truncate font-mono text-[10px] text-foreground/90" title={lsnKey ?? ""}>
                                    {lsnKey ?? "—"}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <Separator className="bg-border/30" />
                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                    {[
                        { label: "Write lag", ms: replica.writeLagMs },
                        { label: "Flush lag", ms: replica.flushLagMs },
                        { label: "Replay lag", ms: replica.replayLagMs },
                    ].map(({ label, ms }) => {
                        const { text, cls } = formatLagCell(ms);
                        return (
                            <div key={label}>
                                <div className="text-[9px] text-muted-foreground">{label}</div>
                                <div className={cn("font-semibold", cls)}>{text}</div>
                            </div>
                        );
                    })}
                </div>
                <div>
                    <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        Replay lag (60 samples)
                    </div>
                    <ReplicaLagChart data={chartData} />
                </div>
            </CardContent>
        </Card>
    );
}
