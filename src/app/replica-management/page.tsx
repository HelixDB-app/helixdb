"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type {
    ReplicaInfo,
    ReplicaStatus,
    ReplicaHealth,
    ReplicationMode,
    ReplicaPermissions,
    ReplicaSummary,
    ReplicaHealthEvent,
    CreateReplicaRequest,
    FailoverConfig,
    ReplicationSchedule,
    ReplicaAlertConfig,
    AutoRecoveryConfig,
    ReplicaMetrics,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
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
    ArrowLeft,
    Bell,
    BellOff,
    CheckCircle2,
    ChevronRight,
    CircleSlash,
    Clock,
    Copy,
    Database,
    Eye,
    EyeOff,
    Flame,
    Globe,
    Heart,
    Loader2,
    Pause,
    Play,
    Plus,
    RefreshCw,
    Server,
    Settings,
    Shield,
    ShieldCheck,
    Skull,
    Sparkles,
    Timer,
    Trash2,
    TrendingUp,
    Wifi,
    WifiOff,
    Wrench,
    Zap,
    ZapOff,
} from "lucide-react";
import {
    Area,
    AreaChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
} from "recharts";
import { APP_NAME } from "@/lib/app-config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLag(secs: number | null): string {
    if (secs === null) return "—";
    if (secs < 1) return `${Math.round(secs * 1000)}ms`;
    if (secs < 60) return `${secs.toFixed(1)}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.floor(secs % 60)}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function formatBytes(bytes: number | null): string {
    if (bytes === null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function timeAgo(epochMs: number | null): string {
    if (!epochMs) return "Never";
    const diff = Date.now() - epochMs;
    if (diff < 60000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(epochMs).toLocaleDateString();
}

function formatTime(epochMs: number | null): string {
    if (!epochMs) return "—";
    return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Status / Health config ───────────────────────────────────────────────────

const STATUS_CONFIG: Record<ReplicaStatus, { label: string; cls: string; dot: string }> = {
    active:   { label: "Active",   cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", dot: "bg-emerald-500" },
    syncing:  { label: "Syncing",  cls: "bg-blue-500/15 text-blue-400 border-blue-500/30",          dot: "bg-blue-500 animate-pulse" },
    failed:   { label: "Failed",   cls: "bg-red-500/15 text-red-400 border-red-500/30",             dot: "bg-red-500" },
    lagging:  { label: "Lagging",  cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",       dot: "bg-amber-500 animate-pulse" },
    paused:   { label: "Paused",   cls: "bg-muted/40 text-muted-foreground border-border/30",       dot: "bg-muted-foreground/40" },
    unknown:  { label: "Unknown",  cls: "bg-muted/30 text-muted-foreground/60 border-border/20",    dot: "bg-muted-foreground/30" },
};

const HEALTH_CONFIG: Record<ReplicaHealth, { label: string; icon: React.ElementType; cls: string }> = {
    healthy:  { label: "Healthy",  icon: CheckCircle2, cls: "text-emerald-400" },
    degraded: { label: "Degraded", icon: AlertTriangle, cls: "text-amber-400" },
    critical: { label: "Critical", icon: Flame,        cls: "text-red-400" },
    offline:  { label: "Offline",  icon: WifiOff,      cls: "text-muted-foreground/50" },
};

const MODE_CONFIG: Record<ReplicationMode, { label: string; desc: string; icon: React.ElementType }> = {
    streaming:  { label: "Streaming",  desc: "Real-time WAL streaming replication", icon: Zap },
    logical:    { label: "Logical",    desc: "Logical decoding (table-level control)", icon: Database },
    cascading:  { label: "Cascading",  desc: "Replica replicating from another replica", icon: Server },
};

// ─── Mock data factory ────────────────────────────────────────────────────────

function makeLagHistory(points = 30, baseLag = 0.8): [number, number][] {
    const now = Date.now();
    return Array.from({ length: points }, (_, i) => [
        now - (points - i) * 60000,
        Math.max(0, baseLag + (Math.random() - 0.5) * baseLag),
    ]);
}

const DEFAULT_FAILOVER: FailoverConfig = { enabled: false, lag_threshold_secs: 30, cooldown_secs: 60, notify_only: true };
const DEFAULT_SCHEDULE: ReplicationSchedule = { enabled: true, interval: "5m", last_check_at: Date.now() - 180000, next_check_at: Date.now() + 120000 };
const DEFAULT_ALERTS: ReplicaAlertConfig = { lag_alert_threshold_secs: 10, offline_alert_threshold_secs: 30, email_alerts: false, in_app_alerts: true };
const DEFAULT_RECOVERY: AutoRecoveryConfig = { enabled: true, max_retries: 3, retry_interval_secs: 15 };

const MOCK_REPLICAS: ReplicaInfo[] = [
    {
        id: "rep-001", name: "replica-primary-us-east", host: "pg-replica-01.us-east.internal", port: 5433,
        database_name: "production", replication_slot: "replica_slot_01", mode: "streaming",
        status: "active", health: "healthy",
        metrics: { lag_secs: 0.3, lag_bytes: 4096, last_sync_at: Date.now() - 2000, bytes_per_sec: 102400, avg_query_latency_ms: 1.2, queries_per_sec: 42, connection_health_score: 98, lag_history: makeLagHistory(30, 0.3) },
        failover: { enabled: true, lag_threshold_secs: 30, cooldown_secs: 60, notify_only: false },
        schedule: { enabled: true, interval: "1m", last_check_at: Date.now() - 30000, next_check_at: Date.now() + 30000 },
        alerts: { lag_alert_threshold_secs: 5, offline_alert_threshold_secs: 15, email_alerts: true, in_app_alerts: true },
        auto_recovery: { enabled: true, max_retries: 5, retry_interval_secs: 10 },
        is_read_replica: true, created_at: "2025-09-01T00:00:00Z", updated_at: "2026-02-20T10:00:00Z", notes: "Primary read replica for US East region.",
    },
    {
        id: "rep-002", name: "replica-eu-west-standby", host: "pg-replica-02.eu-west.internal", port: 5433,
        database_name: "production", replication_slot: "replica_slot_02", mode: "streaming",
        status: "lagging", health: "degraded",
        metrics: { lag_secs: 18.7, lag_bytes: 2097152, last_sync_at: Date.now() - 25000, bytes_per_sec: 51200, avg_query_latency_ms: 4.8, queries_per_sec: 11, connection_health_score: 61, lag_history: makeLagHistory(30, 18) },
        failover: { enabled: true, lag_threshold_secs: 30, cooldown_secs: 120, notify_only: true },
        schedule: DEFAULT_SCHEDULE,
        alerts: { lag_alert_threshold_secs: 10, offline_alert_threshold_secs: 30, email_alerts: true, in_app_alerts: true },
        auto_recovery: { enabled: true, max_retries: 3, retry_interval_secs: 20 },
        is_read_replica: false, created_at: "2025-10-15T00:00:00Z", updated_at: "2026-02-22T08:00:00Z", notes: "EU West standby — currently experiencing elevated lag.",
    },
    {
        id: "rep-003", name: "replica-analytics-logical", host: "pg-replica-03.analytics.internal", port: 5434,
        database_name: "analytics", replication_slot: "logical_slot_analytics", mode: "logical",
        status: "active", health: "healthy",
        metrics: { lag_secs: 1.1, lag_bytes: 8192, last_sync_at: Date.now() - 5000, bytes_per_sec: 20480, avg_query_latency_ms: 8.3, queries_per_sec: 3, connection_health_score: 91, lag_history: makeLagHistory(30, 1) },
        failover: DEFAULT_FAILOVER,
        schedule: { enabled: true, interval: "15m", last_check_at: Date.now() - 600000, next_check_at: Date.now() + 300000 },
        alerts: DEFAULT_ALERTS,
        auto_recovery: DEFAULT_RECOVERY,
        is_read_replica: false, created_at: "2025-11-01T00:00:00Z", updated_at: "2026-01-10T00:00:00Z", notes: "Logical replica feeding the analytics warehouse.",
    },
    {
        id: "rep-004", name: "replica-dr-cascading", host: "pg-replica-04.dr.internal", port: 5433,
        database_name: "production", replication_slot: null, mode: "cascading",
        status: "failed", health: "critical",
        metrics: { lag_secs: null, lag_bytes: null, last_sync_at: Date.now() - 7200000, bytes_per_sec: null, avg_query_latency_ms: null, queries_per_sec: null, connection_health_score: 0, lag_history: [] },
        failover: DEFAULT_FAILOVER,
        schedule: { enabled: false, interval: "30m", last_check_at: Date.now() - 7200000, next_check_at: null },
        alerts: DEFAULT_ALERTS,
        auto_recovery: { enabled: false, max_retries: 3, retry_interval_secs: 30 },
        is_read_replica: false, created_at: "2025-12-01T00:00:00Z", updated_at: "2026-02-26T02:00:00Z", notes: "DR replica — connection lost 2h ago. Investigating network issue.",
    },
    {
        id: "rep-005", name: "replica-staging-read", host: "pg-replica-05.staging.internal", port: 5433,
        database_name: "staging", replication_slot: "replica_slot_staging", mode: "streaming",
        status: "paused", health: "degraded",
        metrics: { lag_secs: 0, lag_bytes: 0, last_sync_at: Date.now() - 3600000, bytes_per_sec: 0, avg_query_latency_ms: null, queries_per_sec: 0, connection_health_score: 72, lag_history: makeLagHistory(30, 0) },
        failover: { ...DEFAULT_FAILOVER, enabled: false },
        schedule: { enabled: false, interval: "30m", last_check_at: Date.now() - 3600000, next_check_at: null },
        alerts: DEFAULT_ALERTS,
        auto_recovery: DEFAULT_RECOVERY,
        is_read_replica: true, created_at: "2026-01-05T00:00:00Z", updated_at: "2026-02-26T06:00:00Z", notes: "Paused for staging maintenance window.",
    },
];

const MOCK_EVENTS: ReplicaHealthEvent[] = [
    { id: "e1", replica_id: "rep-002", replica_name: "replica-eu-west-standby", event_type: "alert", status: "warning", message: "Replication lag exceeded 15s threshold (current: 18.7s)", occurred_at: Date.now() - 120000 },
    { id: "e2", replica_id: "rep-004", replica_name: "replica-dr-cascading", event_type: "recovery", status: "error", message: "Auto-recovery failed after 3 attempts — connection refused", occurred_at: Date.now() - 900000 },
    { id: "e3", replica_id: "rep-004", replica_name: "replica-dr-cascading", event_type: "check", status: "error", message: "Health check failed: host unreachable (pg-replica-04.dr.internal:5433)", occurred_at: Date.now() - 1800000 },
    { id: "e4", replica_id: "rep-001", replica_name: "replica-primary-us-east", event_type: "check", status: "ok", message: "Health check passed — lag 0.3s, score 98/100", occurred_at: Date.now() - 30000 },
    { id: "e5", replica_id: "rep-005", replica_name: "replica-staging-read", event_type: "pause", status: "info", message: "Replication paused by admin for maintenance window", occurred_at: Date.now() - 3600000 },
    { id: "e6", replica_id: "rep-003", replica_name: "replica-analytics-logical", event_type: "check", status: "ok", message: "Health check passed — logical replication active, lag 1.1s", occurred_at: Date.now() - 600000 },
    { id: "e7", replica_id: "rep-002", replica_name: "replica-eu-west-standby", event_type: "alert", status: "warning", message: "Lag spike detected: 22s at 14:18 UTC", occurred_at: Date.now() - 480000 },
    { id: "e8", replica_id: "rep-001", replica_name: "replica-primary-us-east", event_type: "check", status: "ok", message: "Scheduled check passed — all metrics nominal", occurred_at: Date.now() - 90000 },
];

const MOCK_PERMISSIONS: ReplicaPermissions = {
    can_create: true, can_delete: true, can_promote: true,
    can_pause: true, can_resume: true, can_configure: true, reason: null,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ReplicaStatus }) {
    const { label, cls, dot } = STATUS_CONFIG[status];
    return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide", cls)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
            {label}
        </span>
    );
}

function HealthIcon({ health }: { health: ReplicaHealth }) {
    const { icon: Icon, cls, label } = HEALTH_CONFIG[health];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="cursor-default">
                    <Icon className={cn("h-3.5 w-3.5", cls)} />
                </span>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

function LagSparkline({ data }: { data: [number, number][] }) {
    if (!data.length) return <span className="text-[10px] text-muted-foreground/40">no data</span>;
    const chartData = data.map(([t, v]) => ({ t, v }));
    return (
        <ResponsiveContainer width="100%" height={32}>
            <AreaChart data={chartData} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
                <defs>
                    <linearGradient id="lagGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <Area type="monotone" dataKey="v" stroke="#3b82f6" strokeWidth={1.5} fill="url(#lagGrad)" dot={false} />
            </AreaChart>
        </ResponsiveContainer>
    );
}

function HealthScoreBar({ score }: { score: number }) {
    const color = score >= 80 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
    return (
        <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-muted/30 overflow-hidden">
                <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${score}%` }} />
            </div>
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground/60 w-8 shrink-0">{score}%</span>
        </div>
    );
}

interface MetricCardProps { label: string; value: string; sub?: string; icon: React.ElementType; accent?: string; }
function MetricCard({ label, value, sub, icon: Icon, accent = "text-muted-foreground/50" }: MetricCardProps) {
    return (
        <div className="flex items-start gap-2.5 rounded-lg border border-border/20 bg-card/30 px-3.5 py-3">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/40">
                <Icon className={cn("h-3.5 w-3.5", accent)} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-[10px] text-muted-foreground/50 mb-0.5">{label}</div>
                <div className="text-sm font-bold tabular-nums leading-none">{value}</div>
                {sub && <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>}
            </div>
        </div>
    );
}


// ─── Replica Card ─────────────────────────────────────────────────────────────

interface ReplicaCardProps {
    replica: ReplicaInfo;
    isSelected: boolean;
    onSelect: () => void;
    onAction: (id: string, action: "pause" | "resume" | "delete" | "promote" | "check") => void;
    permissions: ReplicaPermissions;
}

function ReplicaCard({ replica, isSelected, onSelect, onAction, permissions }: ReplicaCardProps) {
    const ModeIcon = MODE_CONFIG[replica.mode].icon;
    const lagColor = replica.metrics.lag_secs === null ? "text-muted-foreground/40"
        : replica.metrics.lag_secs > 10 ? "text-red-400"
        : replica.metrics.lag_secs > 3 ? "text-amber-400"
        : "text-emerald-400";

    return (
        <div
            onClick={onSelect}
            className={cn(
                "group relative cursor-pointer rounded-xl border bg-card/40 p-4 transition-all duration-150",
                "hover:bg-card/60 hover:border-border/60",
                isSelected
                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                    : "border-border/25"
            )}
        >
            {/* Top row */}
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/30">
                        <ModeIcon className="h-4 w-4 text-muted-foreground/60" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-[12px] truncate max-w-[160px]">{replica.name}</span>
                            <HealthIcon health={replica.health} />
                        </div>
                        <div className="text-[10px] text-muted-foreground/45 font-mono truncate">
                            {replica.host}:{replica.port}
                        </div>
                    </div>
                </div>
                <StatusBadge status={replica.status} />
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-md bg-muted/20 px-2 py-1.5 text-center">
                    <div className={cn("text-sm font-bold tabular-nums", lagColor)}>
                        {formatLag(replica.metrics.lag_secs)}
                    </div>
                    <div className="text-[9px] text-muted-foreground/40 mt-0.5">Lag</div>
                </div>
                <div className="rounded-md bg-muted/20 px-2 py-1.5 text-center">
                    <div className="text-sm font-bold tabular-nums">
                        {formatBytes(replica.metrics.lag_bytes)}
                    </div>
                    <div className="text-[9px] text-muted-foreground/40 mt-0.5">Lag Bytes</div>
                </div>
                <div className="rounded-md bg-muted/20 px-2 py-1.5 text-center">
                    <div className="text-sm font-bold tabular-nums">
                        {replica.metrics.connection_health_score}%
                    </div>
                    <div className="text-[9px] text-muted-foreground/40 mt-0.5">Health</div>
                </div>
            </div>

            {/* Sparkline */}
            <div className="mb-3 h-8">
                <LagSparkline data={replica.metrics.lag_history} />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground/50 font-mono">
                        {MODE_CONFIG[replica.mode].label}
                    </span>
                    {replica.is_read_replica && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400/70 font-mono">
                            Read
                        </span>
                    )}
                    {replica.failover.enabled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400/70 font-mono">
                            Auto-FO
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {replica.status === "paused" ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    disabled={!permissions.can_resume}
                                    onClick={(e) => { e.stopPropagation(); onAction(replica.id, "resume"); }}
                                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-emerald-500/15 text-muted-foreground/50 hover:text-emerald-400 disabled:opacity-30"
                                >
                                    <Play className="h-3 w-3" />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Resume</TooltipContent>
                        </Tooltip>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    disabled={!permissions.can_pause || replica.status === "failed"}
                                    onClick={(e) => { e.stopPropagation(); onAction(replica.id, "pause"); }}
                                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-amber-500/15 text-muted-foreground/50 hover:text-amber-400 disabled:opacity-30"
                                >
                                    <Pause className="h-3 w-3" />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Pause</TooltipContent>
                        </Tooltip>
                    )}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onAction(replica.id, "check"); }}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-500/15 text-muted-foreground/50 hover:text-blue-400"
                            >
                                <RefreshCw className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Run Health Check</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                disabled={!permissions.can_delete}
                                onClick={(e) => { e.stopPropagation(); onAction(replica.id, "delete"); }}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-500/15 text-muted-foreground/50 hover:text-red-400 disabled:opacity-30"
                            >
                                <Trash2 className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Delete Replica</TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <div className="mt-2 text-[9px] text-muted-foreground/35">
                Last sync: {timeAgo(replica.metrics.last_sync_at)}
            </div>
        </div>
    );
}
