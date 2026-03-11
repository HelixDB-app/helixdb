"use client";

import { useState, useCallback, useEffect, useMemo, memo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConnectionStore } from "@/stores/connection-store";
import { useSavedConnectionsStore } from "@/stores/saved-connections-store";
import { useMigrationStudioStore } from "@/stores/migration-studio-store";
import type { MigrationHistoryEntry, MigrationMode, MigrationIncludeOptions, LargeDbOptions } from "@/stores/migration-studio-store";
import type { SavedConnection } from "@/lib/types";
import {
    fetchSchemaSnapshot,
    computeMigrationDiff,
    generateForwardSQL,
    generateRollbackSQL,
    splitSqlStatements,
    severityBg,
    opLabel,
    opColor,
} from "@/lib/migration-diff";
import type { DiffSeverity, DiffOp, TableDiff, FunctionDiff, EnumDiff } from "@/lib/migration-diff";
import {
    dbListSchemas,
    dbListTables,
    dbListDatabases,
    dbConnect,
    dbSandboxBegin,
    dbSandboxExecute,
    dbSandboxRollback,
    dbExecuteQuery,
    dbCreateDatabase,
    dbExportSql,
} from "@/lib/tauri";
import { playNotificationSound } from "@/lib/notification-sound";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    ArrowLeft,
    ArrowRight,
    ArrowLeftRight,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Circle,
    Clock,
    Copy,
    Database,
    Download,
    FileText,
    GitCompare,
    History,
    Layers,
    Loader2,
    Minus,
    Package,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    Shield,
    ShieldAlert,
    Sparkles,
    Table2,
    Trash2,
    TriangleAlert,
    Wifi,
    X,
    Zap,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";

// ─── Types ───────────────────────────────────────────────────────────────────

type SeverityFilter = "all" | DiffSeverity;
type DiffTab = "tables" | "functions" | "enums";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
    return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function statusBadgeClass(status: MigrationHistoryEntry["status"]) {
    switch (status) {
        case "success": return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
        case "failed": return "bg-red-500/10 text-red-400 border-red-500/20";
        case "reverted": return "bg-violet-500/10 text-violet-400 border-violet-500/20";
        case "dry-run": return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    }
}

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
    const steps = [
        { n: 1, label: "Configure" },
        { n: 2, label: "Analyze" },
        { n: 3, label: "Execute" },
    ] as const;

    return (
        <div className="flex items-center gap-0 px-6 py-3 border-b border-border/20 bg-card/20">
            {steps.map((s, i) => (
                <div key={s.n} className="flex items-center gap-0">
                    <div className="flex items-center gap-2">
                        <div className={cn(
                            "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all",
                            current === s.n && "bg-emerald-500 text-white",
                            current > s.n && "bg-emerald-500/20 text-emerald-400",
                            current < s.n && "bg-muted/40 text-muted-foreground/40"
                        )}>
                            {current > s.n ? <Check className="h-3 w-3" /> : s.n}
                        </div>
                        <span className={cn(
                            "text-xs font-medium transition-all",
                            current === s.n && "text-foreground",
                            current !== s.n && "text-muted-foreground/40"
                        )}>
                            {s.label}
                        </span>
                    </div>
                    {i < 2 && (
                        <div className={cn(
                            "mx-4 h-px w-12 transition-all",
                            current > s.n ? "bg-emerald-500/40" : "bg-border/30"
                        )} />
                    )}
                </div>
            ))}
        </div>
    );
}

// ─── Connection Picker ────────────────────────────────────────────────────────

interface PickerState {
    savedId: string | null;
    liveId: string | null;
    connecting: boolean;
    error: string | null;
    /** User-overridden database name on the cluster */
    selectedDatabase: string | null;
}

const EMPTY_PICKER: PickerState = { savedId: null, liveId: null, connecting: false, error: null, selectedDatabase: null };

function envBadgeClass(env?: string | null) {
    if (env === "prod") return "bg-red-500/10 text-red-400 border-red-500/20";
    if (env === "staging") return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
}

function ConnectionPicker({
    role,
    pickerState,
    savedConnections,
    savedLoading,
    savedError,
    activeConnections,
    onPick,
    onRetryLoad,
}: {
    role: "source" | "target";
    pickerState: PickerState;
    savedConnections: SavedConnection[];
    savedLoading: boolean;
    savedError: string | null;
    activeConnections: import("@/stores/connection-store").ConnectionEntry[];
    onPick: (state: PickerState) => void;
    onRetryLoad: () => void;
}) {
    const isSource = role === "source";
    const accentSelected = isSource ? "border-blue-500/30 bg-blue-500/5" : "border-emerald-500/30 bg-emerald-500/5";
    const accentIcon = isSource ? "bg-blue-500/15 text-blue-400" : "bg-emerald-500/15 text-emerald-400";
    const accentCheck = isSource ? "text-blue-400" : "text-emerald-400";

    const [search, setSearch] = useState("");

    const liveByMaybeSavedId = (savedId: string) =>
        activeConnections.find(c => c.savedConnectionId === savedId);

    const filtered = savedConnections.filter(c =>
        !search ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.database_name ?? "").toLowerCase().includes(search.toLowerCase())
    );

    const handleSelect = async (saved: SavedConnection) => {
        if (pickerState.connecting) return;

        const existing = liveByMaybeSavedId(saved.id);
        if (existing) {
            onPick({ savedId: saved.id, liveId: existing.connectionId, connecting: false, error: null, selectedDatabase: pickerState.selectedDatabase });
            return;
        }

        onPick({ savedId: saved.id, liveId: null, connecting: true, error: null, selectedDatabase: null });
        try {
            const resp = await dbConnect(saved.connection_string, saved.id);
            onPick({ savedId: saved.id, liveId: resp.connection_id, connecting: false, error: null, selectedDatabase: null });
        } catch (e) {
            onPick({ savedId: saved.id, liveId: null, connecting: false, error: String(e), selectedDatabase: null });
        }
    };

    const handleRetry = async () => {
        if (!pickerState.savedId) return;
        const saved = savedConnections.find(c => c.id === pickerState.savedId);
        if (saved) handleSelect(saved);
    };

    const selectedSaved = savedConnections.find(c => c.id === pickerState.savedId);

    return (
        <div className={cn(
            "rounded-xl border bg-card/30 flex flex-col flex-1 min-w-0 overflow-hidden",
            isSource ? "border-blue-500/20" : "border-emerald-500/20"
        )}>
            {/* Header */}
            <div className={cn(
                "flex items-center gap-2 px-4 py-3 border-b",
                isSource ? "border-blue-500/10" : "border-emerald-500/10"
            )}>
                <div className={cn("flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold shrink-0", accentIcon)}>
                    {isSource ? "S" : "T"}
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 flex-1">
                    {isSource ? "Source Database" : "Target Database"}
                </span>
                {/* Selected summary */}
                {pickerState.liveId && selectedSaved && (
                    <div className="flex items-center gap-1">
                        <Wifi className={cn("h-3 w-3", accentCheck)} />
                        <span className={cn("text-[10px] font-medium", accentCheck)}>Connected</span>
                    </div>
                )}
                {pickerState.connecting && (
                    <div className="flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
                        <span className="text-[10px] text-muted-foreground/50">Connecting…</span>
                    </div>
                )}
            </div>

            {/* Search */}
            {savedConnections.length > 3 && (
                <div className="px-3 pt-2.5 pb-1">
                    <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                        <Search className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Filter connections…"
                            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/30 text-foreground"
                        />
                        {search && (
                            <button onClick={() => setSearch("")}>
                                <X className="h-3 w-3 text-muted-foreground/30 hover:text-foreground" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* List */}
            <ScrollArea className="flex-1 max-h-56">
                <div className="flex flex-col gap-1 p-2">
                    {savedLoading ? (
                        [1, 2, 3].map(i => (
                            <div key={i} className="flex items-center gap-2.5 rounded-lg border border-border/10 px-3 py-2.5">
                                <Skeleton className="h-7 w-7 rounded-md shrink-0" />
                                <div className="flex flex-col gap-1 flex-1">
                                    <Skeleton className="h-3 w-24" />
                                    <Skeleton className="h-2.5 w-16" />
                                </div>
                            </div>
                        ))
                    ) : savedError ? (
                        <div className="flex flex-col items-center gap-2 p-4 text-center">
                            <TriangleAlert className="h-6 w-6 text-red-400/50" />
                            <p className="text-[11px] text-red-400/70">{savedError}</p>
                            <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1" onClick={onRetryLoad}>
                                <RefreshCw className="h-2.5 w-2.5" /> Retry
                            </Button>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 py-6 text-center">
                            <Database className="h-7 w-7 text-muted-foreground/15" />
                            <p className="text-xs text-muted-foreground/40">
                                {search ? "No connections match" : "No saved connections"}
                            </p>
                            {!search && (
                                <Link href="/" className="text-[11px] text-muted-foreground/40 underline underline-offset-2 hover:text-foreground">
                                    Add a connection
                                </Link>
                            )}
                        </div>
                    ) : (
                        filtered.map(c => {
                            const live = liveByMaybeSavedId(c.id);
                            const isSelected = pickerState.savedId === c.id;
                            const isConnectingThis = isSelected && pickerState.connecting;
                            const hasError = isSelected && !!pickerState.error;

                            return (
                                <div key={c.id} className="flex flex-col gap-0">
                                    <button
                                        onClick={() => handleSelect(c)}
                                        disabled={isConnectingThis}
                                        className={cn(
                                            "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all w-full",
                                            isSelected && pickerState.liveId
                                                ? accentSelected
                                                : isSelected
                                                    ? "border-border/40 bg-muted/15"
                                                    : "border-border/15 bg-muted/5 hover:bg-muted/15 hover:border-border/30",
                                            isConnectingThis && "opacity-70 cursor-wait"
                                        )}
                                    >
                                        {/* Avatar */}
                                        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/30 text-[10px] font-bold text-muted-foreground/70 shrink-0">
                                            {c.name.slice(0, 2).toUpperCase()}
                                        </div>

                                        {/* Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="text-xs font-medium truncate">{c.name}</span>
                                                {c.environment && (
                                                    <Badge className={cn("h-3.5 px-1 text-[9px] border shrink-0", envBadgeClass(c.environment))}>
                                                        {c.environment}
                                                    </Badge>
                                                )}
                                                {live && (
                                                    <Badge className="h-3.5 px-1 text-[9px] border shrink-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                                                        live
                                                    </Badge>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-muted-foreground/50 font-mono truncate">
                                                {c.database_name ?? "default"}
                                            </p>
                                        </div>

                                        {/* State indicators */}
                                        {isConnectingThis && (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/40 shrink-0" />
                                        )}
                                        {isSelected && pickerState.liveId && (
                                            <Check className={cn("h-3.5 w-3.5 shrink-0", accentCheck)} />
                                        )}
                                        {!isSelected && !live && (
                                            <Circle className="h-2 w-2 text-muted-foreground/15 shrink-0" />
                                        )}
                                    </button>

                                    {/* Inline error for this connection */}
                                    {hasError && (
                                        <div className="mt-1 mx-1 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 flex items-start gap-2">
                                            <TriangleAlert className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[11px] text-red-400/80 leading-snug break-words">{pickerState.error}</p>
                                            </div>
                                            <button
                                                onClick={handleRetry}
                                                className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 shrink-0 mt-0.5 font-medium"
                                            >
                                                <RefreshCw className="h-2.5 w-2.5" /> Retry
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </ScrollArea>

            {/* Database selector — shown once a live connection is available */}
            {pickerState.liveId && (
                <DbSelector
                    connectionId={pickerState.liveId}
                    defaultDatabase={selectedSaved?.database_name ?? null}
                    selectedDatabase={pickerState.selectedDatabase}
                    onSelect={(db) => onPick({ ...pickerState, selectedDatabase: db })}
                    isSource={isSource}
                />
            )}
        </div>
    );
}

// ─── Database Selector ───────────────────────────────────────────────────────

function DbSelector({
    connectionId,
    defaultDatabase,
    selectedDatabase,
    onSelect,
    isSource,
}: {
    connectionId: string;
    defaultDatabase: string | null;
    selectedDatabase: string | null;
    onSelect: (db: string | null) => void;
    isSource: boolean;
}) {
    const [databases, setDatabases] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    useEffect(() => {
        setLoading(true);
        dbListDatabases(connectionId)
            .then(dbs => setDatabases(dbs))
            .catch(() => setDatabases([]))
            .finally(() => setLoading(false));
    }, [connectionId]);

    const accentBorder = isSource ? "border-blue-500/20" : "border-emerald-500/20";
    const accentText = isSource ? "text-blue-400" : "text-emerald-400";
    const accentBg = isSource ? "bg-blue-500/5" : "bg-emerald-500/5";

    const displayName = selectedDatabase ?? defaultDatabase ?? "default";
    const filtered = databases.filter(d => !search || d.toLowerCase().includes(search.toLowerCase()));

    return (
        <div className={cn("border-t px-3 py-2.5 flex flex-col gap-2", isSource ? "border-blue-500/10" : "border-emerald-500/10")}>
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-semibold">Database</span>
                {selectedDatabase && (
                    <button
                        onClick={() => onSelect(null)}
                        className="text-[10px] text-muted-foreground/40 hover:text-foreground/60"
                    >
                        Reset to default
                    </button>
                )}
            </div>

            {/* Trigger */}
            <button
                onClick={() => setOpen(o => !o)}
                className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all hover:border-opacity-60",
                    accentBorder, accentBg
                )}
            >
                <Database className={cn("h-3 w-3 shrink-0", accentText)} />
                <span className={cn("flex-1 text-xs font-mono font-medium truncate", accentText)}>{displayName}</span>
                {loading
                    ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/30 shrink-0" />
                    : <ChevronDown className={cn("h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform", open && "rotate-180")} />
                }
            </button>

            {/* Dropdown */}
            {open && !loading && (
                <div className="flex flex-col rounded-xl border border-border/15 bg-card/80 shadow-lg overflow-hidden">
                    {databases.length > 5 && (
                        <div className="px-2 pt-2 pb-1 border-b border-border/10">
                            <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/10 px-2 py-1.5">
                                <Search className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                                <input
                                    autoFocus
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Search databases…"
                                    className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/30"
                                />
                            </div>
                        </div>
                    )}
                    <div className="max-h-36 overflow-y-auto">
                        {filtered.map(db => {
                            const isDefault = db === (defaultDatabase ?? "");
                            const isSel = (selectedDatabase ?? defaultDatabase) === db;
                            return (
                                <button
                                    key={db}
                                    onClick={() => { onSelect(db); setOpen(false); setSearch(""); }}
                                    className={cn(
                                        "flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-muted/15 transition-colors",
                                        isSel && "bg-muted/10"
                                    )}
                                >
                                    <Database className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                                    <span className="text-xs font-mono text-foreground/70 flex-1">{db}</span>
                                    {isDefault && (
                                        <span className="text-[9px] text-muted-foreground/30 shrink-0">default</span>
                                    )}
                                    {isSel && <Check className={cn("h-3 w-3 shrink-0", accentText)} />}
                                </button>
                            );
                        })}
                        {filtered.length === 0 && (
                            <p className="text-[11px] text-muted-foreground/30 text-center py-3">No databases found</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Migration Mode Panel ────────────────────────────────────────────────────

function MigrationModePanel({
    mode,
    onChange,
}: {
    mode: MigrationMode;
    onChange: (m: MigrationMode) => void;
}) {
    const options: { value: MigrationMode; label: string; desc: string; icon: React.ReactNode; badge?: string }[] = [
        {
            value: "schema_only",
            label: "Schema Only",
            desc: "Tables, indexes, constraints, functions, triggers — no row data",
            icon: <FileText className="h-4 w-4" />,
        },
        {
            value: "schema_and_data",
            label: "Schema + Data",
            desc: "Full DDL changes plus copy row data from selected tables",
            icon: <Package className="h-4 w-4" />,
            badge: "Includes data",
        },
    ];
    return (
        <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">Migration Mode</span>
            <div className="grid grid-cols-2 gap-2">
                {options.map(opt => {
                    const active = mode === opt.value;
                    return (
                        <button
                            key={opt.value}
                            onClick={() => onChange(opt.value)}
                            className={cn(
                                "flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-all",
                                active
                                    ? "border-emerald-500/40 bg-emerald-500/6 ring-1 ring-emerald-500/20"
                                    : "border-border/20 bg-muted/5 hover:border-border/40 hover:bg-muted/10"
                            )}
                        >
                            <div className="flex items-center justify-between w-full">
                                <div className={cn("flex items-center gap-2", active ? "text-emerald-400" : "text-muted-foreground/60")}>
                                    {opt.icon}
                                    <span className="text-xs font-semibold">{opt.label}</span>
                                </div>
                                <div className={cn(
                                    "h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 transition-all",
                                    active ? "border-emerald-500 bg-emerald-500" : "border-border/40"
                                )} />
                            </div>
                            <p className="text-[11px] text-muted-foreground/50 leading-relaxed">{opt.desc}</p>
                            {opt.badge && (
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                    {opt.badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Include Options Panel ───────────────────────────────────────────────────

function IncludeOptionsPanel({
    options,
    onChange,
}: {
    options: MigrationIncludeOptions;
    onChange: (key: keyof MigrationIncludeOptions, value: boolean) => void;
}) {
    const items: { key: keyof MigrationIncludeOptions; label: string }[] = [
        { key: "functions", label: "Functions" },
        { key: "triggers", label: "Triggers" },
        { key: "indexes", label: "Indexes" },
        { key: "sequences", label: "Sequences" },
        { key: "views", label: "Views" },
    ];
    return (
        <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">Include in Migration</span>
            <div className="flex flex-wrap gap-2">
                {items.map(item => (
                    <button
                        key={item.key}
                        onClick={() => onChange(item.key, !options[item.key])}
                        className={cn(
                            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                            options[item.key]
                                ? "border-blue-500/30 bg-blue-500/8 text-blue-300"
                                : "border-border/20 bg-muted/10 text-muted-foreground/40 hover:border-border/40"
                        )}
                    >
                        <div className={cn(
                            "h-3 w-3 rounded-sm border flex items-center justify-center",
                            options[item.key] ? "border-blue-500 bg-blue-500" : "border-border/40"
                        )}>
                            {options[item.key] && <Check className="h-2 w-2 text-white" />}
                        </div>
                        {item.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Large DB Panel ──────────────────────────────────────────────────────────

function LargeDbPanel({
    options,
    onChange,
}: {
    options: LargeDbOptions;
    onChange: (patch: Partial<LargeDbOptions>) => void;
}) {
    return (
        <div className={cn(
            "rounded-xl border p-4 flex flex-col gap-3 transition-all",
            options.enabled ? "border-violet-500/30 bg-violet-500/5" : "border-border/15 bg-card/10"
        )}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Zap className={cn("h-4 w-4", options.enabled ? "text-violet-400" : "text-muted-foreground/40")} />
                    <div>
                        <p className={cn("text-xs font-semibold", options.enabled ? "text-violet-300" : "text-foreground/60")}>
                            Large DB Mode
                        </p>
                        <p className="text-[10px] text-muted-foreground/40">Optimized for databases &gt;1 GB / millions of tables</p>
                    </div>
                </div>
                <button
                    onClick={() => onChange({ enabled: !options.enabled })}
                    className={cn(
                        "relative h-5 w-9 rounded-full border transition-all shrink-0",
                        options.enabled ? "border-violet-500/60 bg-violet-500/30" : "border-border/30 bg-muted/20"
                    )}
                >
                    <div className={cn(
                        "absolute top-0.5 h-4 w-4 rounded-full border transition-all",
                        options.enabled ? "left-4 border-violet-400 bg-violet-400" : "left-0.5 border-border/40 bg-muted/40"
                    )} />
                </button>
            </div>

            {options.enabled && (
                <div className="flex flex-col gap-2.5 pt-1 border-t border-violet-500/10">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] text-foreground/60 font-medium">Skip indexes for tables &gt;</span>
                            <span className="text-[10px] text-muted-foreground/40">Rows threshold to skip heavy index metadata</span>
                        </div>
                        <select
                            value={options.skipIndexesAboveRows}
                            onChange={e => onChange({ skipIndexesAboveRows: Number(e.target.value) })}
                            className="h-7 rounded-lg border border-violet-500/20 bg-card/60 px-2 text-xs text-foreground/70 outline-none"
                        >
                            <option value={0}>Never skip</option>
                            <option value={100_000}>100K rows</option>
                            <option value={500_000}>500K rows</option>
                            <option value={1_000_000}>1M rows</option>
                            <option value={5_000_000}>5M rows</option>
                            <option value={10_000_000}>10M rows</option>
                        </select>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] text-foreground/60 font-medium">Fetch concurrency</span>
                            <span className="text-[10px] text-muted-foreground/40">Parallel table detail requests (lower = less load)</span>
                        </div>
                        <select
                            value={options.concurrency}
                            onChange={e => onChange({ concurrency: Number(e.target.value) })}
                            className="h-7 rounded-lg border border-violet-500/20 bg-card/60 px-2 text-xs text-foreground/70 outline-none"
                        >
                            <option value={2}>2 (gentle)</option>
                            <option value={4}>4 (balanced)</option>
                            <option value={8}>8 (default)</option>
                            <option value={16}>16 (fast)</option>
                        </select>
                    </div>
                    <div className="rounded-lg border border-violet-500/15 bg-violet-500/5 px-3 py-2 flex items-start gap-2">
                        <Sparkles className="h-3 w-3 text-violet-400 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-violet-300/80 leading-relaxed">
                            Large DB Mode reduces analysis time significantly for 1GB+ databases by skipping non-critical metadata for heavy tables. Schema diffs remain accurate.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Scope Panel (Schema + Table Selection) ──────────────────────────────────

interface TableEntry { name: string; schema: string; rowCount: number }

function ScopePanel({
    connectionId,
    selectedSchemas,
    selectedTables,
    onToggleSchema,
    onToggleTable,
    onSelectAllTables,
}: {
    connectionId: string | null;
    selectedSchemas: string[];
    selectedTables: string[];
    onToggleSchema: (schema: string) => void;
    onToggleTable: (key: string) => void;
    onSelectAllTables: (schema: string, keys: string[]) => void;
}) {
    const [schemas, setSchemas] = useState<string[]>([]);
    const [tablesBySchema, setTablesBySchema] = useState<Map<string, TableEntry[]>>(new Map());
    const [loading, setLoading] = useState(false);
    const [loadingTables, setLoadingTables] = useState<string | null>(null);
    const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

    useEffect(() => {
        if (!connectionId) { setSchemas([]); setTablesBySchema(new Map()); return; }
        setLoading(true);
        dbListSchemas(connectionId)
            .then(s => setSchemas(
                s.map(x => x.name).filter(n => !["pg_catalog", "information_schema", "pg_toast"].includes(n))
            ))
            .catch(() => setSchemas([]))
            .finally(() => setLoading(false));
    }, [connectionId]);

    const loadTablesForSchema = async (schema: string) => {
        if (!connectionId || tablesBySchema.has(schema)) return;
        setLoadingTables(schema);
        try {
            const rows = await dbListTables(connectionId, schema);
            setTablesBySchema(prev => new Map(prev).set(schema, rows.map(r => ({
                name: r.name,
                schema,
                rowCount: r.row_count ?? 0,
            }))));
        } catch {
            setTablesBySchema(prev => new Map(prev).set(schema, []));
        } finally {
            setLoadingTables(null);
        }
    };

    const toggleExpand = (schema: string) => {
        const next = expandedSchema === schema ? null : schema;
        setExpandedSchema(next);
        if (next) loadTablesForSchema(next);
    };

    if (!connectionId) return null;

    const effectiveSchemas = selectedSchemas.length === 0 ? schemas : schemas.filter(s => selectedSchemas.includes(s));
    const totalSelectedTables = selectedTables.length;

    return (
        <div className="flex flex-col gap-3">
            {/* Schema pills */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">Schemas</span>
                    {totalSelectedTables > 0 && (
                        <span className="text-[10px] text-blue-400 font-medium">{totalSelectedTables} tables selected</span>
                    )}
                </div>
                {loading ? (
                    <div className="flex gap-1.5">{[1, 2, 3].map(i => <Skeleton key={i} className="h-6 w-16 rounded-full" />)}</div>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {schemas.map(s => {
                            const checked = selectedSchemas.length === 0 || selectedSchemas.includes(s);
                            return (
                                <button
                                    key={s}
                                    onClick={() => onToggleSchema(s)}
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all",
                                        checked
                                            ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-300"
                                            : "border-border/20 bg-muted/10 text-muted-foreground/40 hover:border-border/40"
                                    )}
                                >
                                    {checked && <Check className="h-2.5 w-2.5" />}
                                    {s}
                                </button>
                            );
                        })}
                        {schemas.length === 0 && (
                            <span className="text-xs text-muted-foreground/40">No user schemas found</span>
                        )}
                    </div>
                )}
                <p className="text-[11px] text-muted-foreground/40">
                    No schema selected = compare all user schemas
                </p>
            </div>

            {/* Table drill-down */}
            {effectiveSchemas.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">Table Filter</span>
                        <span className="text-[10px] text-muted-foreground/40">No selection = all tables</span>
                    </div>
                    <div className="flex flex-col gap-1 rounded-xl border border-border/10 overflow-hidden">
                        {effectiveSchemas.map(schema => {
                            const expanded = expandedSchema === schema;
                            const tables = tablesBySchema.get(schema);
                            const schemaTableKeys = (tables ?? []).map(t => `${schema}.${t.name}`);
                            const selectedInSchema = schemaTableKeys.filter(k => selectedTables.includes(k));
                            const allSelected = tables && tables.length > 0 && selectedInSchema.length === tables.length;
                            const someSelected = selectedInSchema.length > 0 && !allSelected;
                            return (
                                <div key={schema} className="border-b border-border/8 last:border-0">
                                    <button
                                        className="flex items-center gap-2.5 w-full px-3 py-2.5 hover:bg-muted/10 transition-colors text-left"
                                        onClick={() => toggleExpand(schema)}
                                    >
                                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground/40 transition-transform flex-shrink-0", expanded && "rotate-180")} />
                                        <Database className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
                                        <span className="text-xs font-medium text-foreground/70 flex-1">{schema}</span>
                                        {tables && (
                                            <span className="text-[10px] text-muted-foreground/40">{tables.length} tables</span>
                                        )}
                                        {someSelected && (
                                            <span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-full">
                                                {selectedInSchema.length} selected
                                            </span>
                                        )}
                                        {allSelected && (
                                            <span className="text-[10px] font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                                                All selected
                                            </span>
                                        )}
                                    </button>
                                    {expanded && (
                                        <div className="px-3 pb-2 flex flex-col gap-1">
                                            {loadingTables === schema ? (
                                                <div className="flex gap-1.5 py-1">
                                                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
                                                    <span className="text-[11px] text-muted-foreground/40">Loading tables…</span>
                                                </div>
                                            ) : tables && tables.length > 0 ? (
                                                <>
                                                    {/* Select all / none */}
                                                    <div className="flex items-center gap-2 py-1 border-b border-border/10 mb-1">
                                                        <button
                                                            className="text-[10px] text-emerald-400 hover:underline"
                                                            onClick={() => onSelectAllTables(schema, schemaTableKeys)}
                                                        >
                                                            {allSelected ? "Deselect all" : "Select all"}
                                                        </button>
                                                        <span className="text-muted-foreground/20">·</span>
                                                        <span className="text-[10px] text-muted-foreground/40">{tables.length} tables</span>
                                                    </div>
                                                    <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                                                        {tables.map(t => {
                                                            const key = `${schema}.${t.name}`;
                                                            const sel = selectedTables.includes(key);
                                                            return (
                                                                <button
                                                                    key={key}
                                                                    onClick={() => onToggleTable(key)}
                                                                    className={cn(
                                                                        "flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors",
                                                                        sel ? "bg-blue-500/8 hover:bg-blue-500/12" : "hover:bg-muted/10"
                                                                    )}
                                                                >
                                                                    <div className={cn(
                                                                        "h-3 w-3 rounded border flex items-center justify-center flex-shrink-0 transition-all",
                                                                        sel ? "border-blue-500 bg-blue-500" : "border-border/40"
                                                                    )}>
                                                                        {sel && <Check className="h-2 w-2 text-white" />}
                                                                    </div>
                                                                    <Table2 className="h-3 w-3 text-muted-foreground/30 flex-shrink-0" />
                                                                    <span className="text-[11px] text-foreground/70 flex-1 font-mono">{t.name}</span>
                                                                    {t.rowCount > 0 && (
                                                                        <span className="text-[10px] text-muted-foreground/30 tabular-nums">
                                                                            {t.rowCount.toLocaleString()} rows
                                                                        </span>
                                                                    )}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </>
                                            ) : (
                                                <span className="text-[11px] text-muted-foreground/30 py-1">No tables found</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Create DB Dialog ─────────────────────────────────────────────────────────

function CreateDbDialog({
    open,
    onClose,
    targetConnectionId,
    onCreated,
}: {
    open: boolean;
    onClose: () => void;
    targetConnectionId: string | null;
    onCreated: (name: string) => void;
}) {
    const [dbName, setDbName] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCreate = async () => {
        if (!targetConnectionId || !dbName.trim()) return;
        setCreating(true);
        setError(null);
        try {
            await dbCreateDatabase(targetConnectionId, dbName.trim());
            toast.success(`Database "${dbName.trim()}" created`);
            onCreated(dbName.trim());
            onClose();
            setDbName("");
        } catch (e) {
            setError(String(e));
        } finally {
            setCreating(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={v => !v && onClose()}>
            <DialogContent className="sm:max-w-sm bg-card border-border/30">
                <DialogHeader>
                    <DialogTitle className="text-sm flex items-center gap-2">
                        <Database className="h-4 w-4 text-emerald-400" />
                        Create New Database
                    </DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    <Input
                        placeholder="database_name"
                        value={dbName}
                        onChange={e => setDbName(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleCreate()}
                        className="font-mono text-xs"
                        autoFocus
                    />
                    {error && (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                            {error}
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8">Cancel</Button>
                    <Button
                        size="sm"
                        onClick={handleCreate}
                        disabled={!dbName.trim() || creating || !targetConnectionId}
                        className="text-xs h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                        Create
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Diff Row ────────────────────────────────────────────────────────────────

function DiffRow({
    op,
    severity,
    label,
    sublabel,
    rowCount,
    rowsAtRisk,
    children,
}: {
    op: DiffOp;
    severity: DiffSeverity;
    label: string;
    sublabel?: string;
    rowCount?: number;
    rowsAtRisk?: number;
    children?: React.ReactNode;
}) {
    const [expanded, setExpanded] = useState(false);
    const hasChildren = !!children;

    return (
        <div className="rounded-lg border border-border/15 bg-card/20 overflow-hidden">
            <button
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/10 transition-colors"
                onClick={() => hasChildren && setExpanded(v => !v)}
            >
                <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide shrink-0", opColor(op))}>
                    {opLabel(op)}
                </span>
                <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide shrink-0", severityBg(severity))}>
                    {severity.toUpperCase()}
                </span>
                <span className="flex-1 text-xs font-medium text-foreground/90 font-mono truncate">{label}</span>
                {sublabel && <span className="text-[11px] text-muted-foreground/40 shrink-0">{sublabel}</span>}
                {rowsAtRisk !== undefined && rowsAtRisk > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-red-400/70 shrink-0">
                        <TriangleAlert className="h-2.5 w-2.5" />
                        {rowsAtRisk.toLocaleString()} rows at risk
                    </span>
                )}
                {rowCount !== undefined && rowCount > 0 && (rowsAtRisk === undefined || rowsAtRisk === 0) && (
                    <span className="text-[11px] text-muted-foreground/40 shrink-0">{rowCount.toLocaleString()} rows</span>
                )}
                {hasChildren && (
                    <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition-transform shrink-0", expanded && "rotate-90")} />
                )}
            </button>
            {expanded && children && (
                <div className="border-t border-border/10 bg-muted/5 px-4 py-3">
                    {children}
                </div>
            )}
        </div>
    );
}

function ColumnDiffRow({ op, name, before, after }: {
    op: DiffOp;
    name: string;
    before?: { data_type?: string; is_nullable?: boolean; column_default?: string | null };
    after?: { data_type?: string; is_nullable?: boolean; column_default?: string | null };
}) {
    return (
        <div className="flex items-start gap-2 text-[11px]">
            <span className={cn(
                "inline-flex items-center rounded border px-1 py-0 text-[9px] font-bold shrink-0 mt-0.5",
                opColor(op)
            )}>{opLabel(op)}</span>
            <span className="font-mono text-foreground/70">{name}</span>
            {op === "modify" && before && after && (
                <div className="flex items-center gap-1.5 text-muted-foreground/50">
                    {before.data_type !== after.data_type && (
                        <span>{before.data_type} <ArrowRight className="inline h-2.5 w-2.5" /> {after.data_type}</span>
                    )}
                    {before.is_nullable !== after.is_nullable && (
                        <span className="text-amber-400/70">
                            {after.is_nullable ? "nullable" : "NOT NULL"}
                        </span>
                    )}
                </div>
            )}
            {op === "add" && after?.data_type && (
                <span className="text-muted-foreground/40 font-mono">{after.data_type}</span>
            )}
        </div>
    );
}

// ─── Diff Viewer ─────────────────────────────────────────────────────────────

const MemoTableDiffRow = memo(function TableDiffRow({ t }: { t: TableDiff }) {
    const changeCount = t.columns.length + t.constraints.length + t.indexes.length;
    const rowsAtRisk = (t.op === "drop" || t.columns.some(c => c.op === "drop")) ? t.rowCount : 0;

    return (
        <DiffRow
            op={t.op}
            severity={t.severity}
            label={`${t.schema}.${t.table}`}
            rowCount={t.rowCount}
            sublabel={t.op === "modify" ? `${changeCount} change${changeCount !== 1 ? "s" : ""}` : undefined}
            rowsAtRisk={rowsAtRisk}
        >
            {t.op === "modify" && changeCount > 0 && (
                <div className="flex flex-col gap-3">
                    {t.columns.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Table2 className="h-3 w-3 text-muted-foreground/30" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-semibold">
                                    Columns ({t.columns.length})
                                </span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                                {t.columns.map((c, ci) => (
                                    <ColumnDiffRow
                                        key={ci}
                                        op={c.op}
                                        name={c.column}
                                        before={c.before}
                                        after={c.op === "add" ? c.info : c.after}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                    {t.constraints.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Shield className="h-3 w-3 text-muted-foreground/30" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-semibold">
                                    Constraints ({t.constraints.length})
                                </span>
                            </div>
                            {t.constraints.map((c, ci) => (
                                <div key={ci} className="flex items-center gap-2 text-[11px]">
                                    <span className={cn("inline-flex items-center rounded border px-1 py-0 text-[9px] font-bold shrink-0", opColor(c.op))}>
                                        {opLabel(c.op)}
                                    </span>
                                    <span className="font-mono text-foreground/60 truncate">{c.name}</span>
                                    {c.before?.constraint_type && (
                                        <span className="text-muted-foreground/30 text-[10px] uppercase">{c.before.constraint_type === "p" ? "PK" : c.before.constraint_type === "f" ? "FK" : c.before.constraint_type === "u" ? "UQ" : "CK"}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {t.indexes.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Layers className="h-3 w-3 text-muted-foreground/30" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-semibold">
                                    Indexes ({t.indexes.length})
                                </span>
                            </div>
                            {t.indexes.map((ix, ii) => (
                                <div key={ii} className="flex items-center gap-2 text-[11px]">
                                    <span className={cn("inline-flex items-center rounded border px-1 py-0 text-[9px] font-bold shrink-0", opColor(ix.op))}>
                                        {opLabel(ix.op)}
                                    </span>
                                    <span className="font-mono text-foreground/60 truncate">{ix.name}</span>
                                    {ix.before?.is_unique && <span className="text-[10px] text-violet-400/60">UNIQUE</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {t.op === "add" && t.sourceDetails && (
                <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground/50">
                    <span>{t.sourceDetails.columns.length} column{t.sourceDetails.columns.length !== 1 ? "s" : ""}</span>
                    {t.sourceDetails.constraints.filter(c => c.constraint_type === "f").length > 0 && (
                        <span>{t.sourceDetails.constraints.filter(c => c.constraint_type === "f").length} FK{t.sourceDetails.constraints.filter(c => c.constraint_type === "f").length !== 1 ? "s" : ""}</span>
                    )}
                    {t.sourceDetails.indexes.filter(i => !i.is_primary).length > 0 && (
                        <span>{t.sourceDetails.indexes.filter(i => !i.is_primary).length} index{t.sourceDetails.indexes.filter(i => !i.is_primary).length !== 1 ? "es" : ""}</span>
                    )}
                </div>
            )}
        </DiffRow>
    );
});

function DiffViewer({ onGenerateSql }: { onGenerateSql: () => void }) {
    const { diffResult } = useMigrationStudioStore();
    const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
    const [activeTab, setActiveTab] = useState<DiffTab>("tables");
    const [search, setSearch] = useState("");

    const filteredTables = useMemo(() => {
        let items = diffResult?.tables ?? [];
        if (severityFilter !== "all") items = items.filter(i => i.severity === severityFilter);
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(t => `${t.schema}.${t.table}`.toLowerCase().includes(q));
        }
        return items;
    }, [diffResult?.tables, severityFilter, search]);

    const filteredFunctions = useMemo(() => {
        let items = diffResult?.functions ?? [];
        if (severityFilter !== "all") items = items.filter(i => i.severity === severityFilter);
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(f => `${f.schema}.${f.name}`.toLowerCase().includes(q));
        }
        return items;
    }, [diffResult?.functions, severityFilter, search]);

    const filteredEnums = useMemo(() => {
        let items = diffResult?.enums ?? [];
        if (severityFilter !== "all") items = items.filter(i => i.severity === severityFilter);
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(e => `${e.schema}.${e.name}`.toLowerCase().includes(q));
        }
        return items;
    }, [diffResult?.enums, severityFilter, search]);

    if (!diffResult) return null;

    const addedTables   = diffResult.tables.filter(t => t.op === "add").length;
    const modifiedTables = diffResult.tables.filter(t => t.op === "modify").length;
    const droppedTables  = diffResult.tables.filter(t => t.op === "drop").length;
    const rowsAtRisk = diffResult.tables
        .filter(t => t.op === "drop" || t.columns.some(c => c.op === "drop"))
        .reduce((s, t) => s + t.rowCount, 0);

    const tabs: { key: DiffTab; label: string; icon: React.ReactNode; count: number }[] = [
        { key: "tables", label: "Tables", icon: <Table2 className="h-3.5 w-3.5" />, count: diffResult.tables.length },
        { key: "functions", label: "Functions", icon: <FileText className="h-3.5 w-3.5" />, count: diffResult.functions.length },
        { key: "enums", label: "Enums / Types", icon: <Layers className="h-3.5 w-3.5" />, count: diffResult.enums.length },
    ];

    const severities: { key: SeverityFilter; label: string; count: number }[] = (
        [
            { key: "all" as SeverityFilter, label: "All", count: diffResult.totalChanges },
            { key: "critical" as SeverityFilter, label: "Critical", count: diffResult.criticalCount },
            { key: "high" as SeverityFilter, label: "High", count: diffResult.highCount },
            { key: "medium" as SeverityFilter, label: "Medium", count: diffResult.mediumCount },
            { key: "low" as SeverityFilter, label: "Low", count: diffResult.lowCount },
            { key: "info" as SeverityFilter, label: "Info", count: diffResult.infoCount },
        ] as { key: SeverityFilter; label: string; count: number }[]
    ).filter(s => s.key === "all" || s.count > 0);

    if (diffResult.totalChanges === 0) {
        return (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/5">
                    <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                </div>
                <div>
                    <p className="text-sm font-semibold text-emerald-300">Schemas are identical</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">No differences were found between source and target</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {/* Stats cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {addedTables > 0 && (
                    <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-4 py-3 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-widest text-emerald-400/60 font-semibold">Tables Added</span>
                        <span className="text-2xl font-bold text-emerald-300">{addedTables}</span>
                    </div>
                )}
                {modifiedTables > 0 && (
                    <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 px-4 py-3 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-widest text-amber-400/60 font-semibold">Tables Modified</span>
                        <span className="text-2xl font-bold text-amber-300">{modifiedTables}</span>
                    </div>
                )}
                {droppedTables > 0 && (
                    <div className="rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-widest text-red-400/60 font-semibold">Tables Dropped</span>
                        <span className="text-2xl font-bold text-red-300">{droppedTables}</span>
                    </div>
                )}
                {rowsAtRisk > 0 ? (
                    <div className="rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-widest text-red-400/60 font-semibold">Rows at Risk</span>
                        <span className="text-2xl font-bold text-red-300">{rowsAtRisk.toLocaleString()}</span>
                    </div>
                ) : (
                    <div className="rounded-xl border border-border/15 bg-muted/5 px-4 py-3 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-semibold">Total Changes</span>
                        <span className="text-2xl font-bold text-foreground/70">{diffResult.totalChanges}</span>
                    </div>
                )}
            </div>

            {/* Severity filter + search row */}
            <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5 flex-1 min-w-40">
                    <Search className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search tables, functions…"
                        className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/30"
                    />
                    {search && (
                        <button onClick={() => setSearch("")}>
                            <X className="h-3 w-3 text-muted-foreground/30 hover:text-foreground" />
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                    {severities.map(s => (
                        <button
                            key={s.key}
                            onClick={() => setSeverityFilter(s.key)}
                            className={cn(
                                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all",
                                severityFilter === s.key
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                    : "border-border/20 bg-muted/10 text-muted-foreground/50 hover:border-border/40"
                            )}
                        >
                            {s.label}
                            <span className={cn(
                                "rounded-full px-1 text-[10px] font-semibold",
                                severityFilter === s.key ? "text-emerald-400" : "text-muted-foreground/30"
                            )}>{s.count}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-0 border-b border-border/20">
                {tabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={cn(
                            "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-all -mb-px",
                            activeTab === tab.key
                                ? "border-emerald-500 text-foreground"
                                : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
                        )}
                    >
                        {tab.icon}
                        {tab.label}
                        {tab.count > 0 && (
                            <Badge className="h-4 px-1.5 text-[10px] bg-muted/30 text-muted-foreground/60 border-0">
                                {tab.count}
                            </Badge>
                        )}
                    </button>
                ))}
                <div className="flex-1" />
                <Button
                    size="sm"
                    onClick={onGenerateSql}
                    className="h-7 text-xs gap-1.5 mb-1 mr-0 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                    Generate SQL <ArrowRight className="h-3 w-3" />
                </Button>
            </div>

            {/* Diff list */}
            <div className="flex flex-col gap-2">
                {activeTab === "tables" && (
                    filteredTables.length === 0 ? (
                        <EmptyState label={search ? `No tables match "${search}"` : "No table changes match this filter"} />
                    ) : (
                        filteredTables.map((t: TableDiff) => (
                            <MemoTableDiffRow key={`${t.schema}.${t.table}`} t={t} />
                        ))
                    )
                )}

                {activeTab === "functions" && (
                    filteredFunctions.length === 0 ? (
                        <EmptyState label={search ? `No functions match "${search}"` : "No function changes match this filter"} />
                    ) : (
                        filteredFunctions.map((f: FunctionDiff) => (
                            <DiffRow
                                key={`${f.schema}.${f.name}(${f.arguments})`}
                                op={f.op}
                                severity={f.severity}
                                label={`${f.schema}.${f.name}`}
                                sublabel={f.arguments || "(no args)"}
                            />
                        ))
                    )
                )}

                {activeTab === "enums" && (
                    filteredEnums.length === 0 ? (
                        <EmptyState label={search ? `No types match "${search}"` : "No enum/type changes match this filter"} />
                    ) : (
                        filteredEnums.map((e: EnumDiff) => (
                            <DiffRow
                                key={`${e.schema}.${e.name}`}
                                op={e.op}
                                severity={e.severity}
                                label={`${e.schema}.${e.name}`}
                                sublabel={e.kind}
                            >
                                {e.op === "modify" && e.before?.enum_labels && e.after?.enum_labels && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {e.after.enum_labels
                                            .filter(l => !e.before!.enum_labels!.includes(l))
                                            .map((l, li) => (
                                                <span key={li} className="rounded border border-emerald-500/20 bg-emerald-500/5 px-1.5 py-0.5 text-[11px] font-mono text-emerald-400">
                                                    + {l}
                                                </span>
                                            ))}
                                        {e.before.enum_labels
                                            .filter(l => !e.after!.enum_labels!.includes(l))
                                            .map((l, li) => (
                                                <span key={li} className="rounded border border-red-500/20 bg-red-500/5 px-1.5 py-0.5 text-[11px] font-mono text-red-400">
                                                    − {l}
                                                </span>
                                            ))}
                                    </div>
                                )}
                                {e.op === "add" && e.after?.kind === "enum" && e.after.enum_labels && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {e.after.enum_labels.map((l, li) => (
                                            <span key={li} className="rounded border border-muted/30 bg-muted/10 px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground/60">
                                                {l}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </DiffRow>
                        ))
                    )
                )}
            </div>
        </div>
    );
}

// ─── SQL Block with line numbers ─────────────────────────────────────────────

function SqlBlock({ sql }: { sql: string }) {
    const lines = useMemo(() => sql.split("\n"), [sql]);

    return (
        <ScrollArea className="h-96 rounded-lg border border-border/20 bg-[#0a0a0c]">
            <div className="flex min-w-0">
                {/* Line numbers */}
                <div className="select-none shrink-0 border-r border-border/10 bg-muted/5 px-3 py-4 text-right">
                    {lines.map((_, i) => (
                        <div key={i} className="text-[11px] font-mono leading-relaxed text-muted-foreground/20">{i + 1}</div>
                    ))}
                </div>
                {/* Code */}
                <pre className="flex-1 p-4 text-[11px] font-mono leading-relaxed text-emerald-300/80 whitespace-pre overflow-x-auto">
                    {sql || "-- No SQL generated"}
                </pre>
            </div>
        </ScrollArea>
    );
}

// ─── Success Dialog ───────────────────────────────────────────────────────────

function SuccessDialog({
    open,
    totalChanges,
    targetDb,
    sourceDb,
    elapsedMs,
    rollbackSQL,
    onClose,
    onNewMigration,
}: {
    open: boolean;
    totalChanges: number;
    targetDb: string;
    sourceDb: string;
    elapsedMs: number;
    rollbackSQL: string;
    onClose: () => void;
    onNewMigration: () => void;
}) {
    const [showRollback, setShowRollback] = useState(false);

    useEffect(() => { if (!open) setShowRollback(false); }, [open]);

    const copyRollback = () => {
        navigator.clipboard.writeText(rollbackSQL).then(() =>
            toast.success("Rollback SQL copied — keep it safe!")
        );
    };

    return (
        <Dialog open={open} onOpenChange={v => !v && onClose()}>
            <DialogContent className="sm:max-w-lg bg-card border-border/30">
                {!showRollback ? (
                    <>
                        <div className="flex flex-col items-center gap-5 py-4 text-center">
                            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
                                <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <h2 className="text-base font-bold text-foreground">Migration Applied</h2>
                                <p className="text-xs text-muted-foreground/60">
                                    Successfully migrated <span className="text-foreground/80 font-mono">{sourceDb}</span> → <span className="text-foreground/80 font-mono">{targetDb}</span>
                                </p>
                            </div>

                            {/* Stats row */}
                            <div className="grid grid-cols-3 gap-2 w-full">
                                <div className="rounded-xl border border-border/15 bg-muted/5 py-3 flex flex-col items-center gap-1">
                                    <span className="text-xl font-bold text-emerald-300">{totalChanges}</span>
                                    <span className="text-[10px] text-muted-foreground/50">changes applied</span>
                                </div>
                                <div className="rounded-xl border border-border/15 bg-muted/5 py-3 flex flex-col items-center gap-1">
                                    <span className="text-xl font-bold text-blue-300">{(elapsedMs / 1000).toFixed(1)}s</span>
                                    <span className="text-[10px] text-muted-foreground/50">elapsed time</span>
                                </div>
                                <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 py-3 flex flex-col items-center gap-1">
                                    <Check className="h-5 w-5 text-emerald-400" />
                                    <span className="text-[10px] text-emerald-400/70">success</span>
                                </div>
                            </div>

                            {/* Rollback notice */}
                            <div className="w-full rounded-xl border border-amber-500/15 bg-amber-500/5 px-4 py-3 flex items-start gap-2.5">
                                <RotateCcw className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                                <div className="flex-1 text-left">
                                    <p className="text-xs font-semibold text-amber-300 mb-0.5">Rollback SQL is ready</p>
                                    <p className="text-[11px] text-amber-400/60">Save the rollback SQL before closing to be able to revert this migration.</p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-[11px] gap-1 border-amber-500/20 text-amber-400 hover:text-amber-300 shrink-0"
                                    onClick={() => setShowRollback(true)}
                                >
                                    View
                                </Button>
                            </div>
                        </div>
                        <DialogFooter className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 h-9 text-xs gap-1.5 border-border/20"
                                onClick={copyRollback}
                            >
                                <Copy className="h-3.5 w-3.5" /> Copy Rollback SQL
                            </Button>
                            <Button
                                size="sm"
                                className="flex-1 h-9 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                onClick={onNewMigration}
                            >
                                <Sparkles className="h-3.5 w-3.5" /> New Migration
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle className="text-sm flex items-center gap-2">
                                <RotateCcw className="h-4 w-4 text-amber-400" />
                                Rollback SQL
                            </DialogTitle>
                        </DialogHeader>
                        <SqlBlock sql={rollbackSQL} />
                        <DialogFooter>
                            <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setShowRollback(false)}>← Back</Button>
                            <Button size="sm" className="text-xs h-8 gap-1.5" onClick={copyRollback}>
                                <Copy className="h-3.5 w-3.5" /> Copy
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

// ─── Dry Run Dialog ──────────────────────────────────────────────────────────

interface DryRunStmtResult {
    index: number;
    sql: string;
    ok: boolean;
    error?: string;
}

function DryRunDialog({
    open,
    onClose,
    targetConnectionId,
    forwardSQL,
    targetConn,
}: {
    open: boolean;
    onClose: () => void;
    targetConnectionId: string;
    forwardSQL: string;
    targetConn?: import("@/stores/connection-store").ConnectionEntry | undefined;
}) {
    const { setDryRunning, setDryRunResult } = useMigrationStudioStore();
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; mode: "sandbox" | "fallback" } | null>(null);
    const [results, setResults] = useState<DryRunStmtResult[]>([]);
    const [failedStmt, setFailedStmt] = useState<DryRunStmtResult | null>(null);
    const [elapsed, setElapsed] = useState<number | null>(null);
    const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle");
    const [usingFallback, setUsingFallback] = useState(false);
    const abortRef = useRef(false);

    /** Fallback: wrap all SQL in a single BEGIN/ROLLBACK via dbExecuteQuery */
    const runFallback = useCallback(async (stmts: string[], t0: number) => {
        setUsingFallback(true);
        setProgress({ current: 0, total: stmts.length, mode: "fallback" });

        // Build a single transaction string: BEGIN; stmt1; stmt2; ... ROLLBACK;
        const txSql = ["BEGIN;", ...stmts, "ROLLBACK;"].join("\n");
        try {
            const result = await dbExecuteQuery(targetConnectionId, txSql, {
                environment: targetConn?.environment ?? null,
            });
            if (result.is_error) throw new Error(result.error_message ?? "Unknown error");

            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setResults(stmts.map((s, i) => ({ index: i + 1, sql: s, ok: true })));
            setDryRunResult({ success: true, statementCount: stmts.length, elapsedMs });
            setPhase("success");
            setProgress({ current: stmts.length, total: stmts.length, mode: "fallback" });
            toast.success(`Dry run passed (fallback mode) — ${stmts.length} statements rolled back`);
            playNotificationSound();
        } catch (e) {
            const msg = String(e);
            // Try to extract which statement failed from the message
            const stmtMatch = msg.match(/statement (\d+)/i);
            const failIdx = stmtMatch ? parseInt(stmtMatch[1]) - 1 : 0;
            const failed: DryRunStmtResult = {
                index: failIdx + 1,
                sql: stmts[failIdx] ?? "",
                ok: false,
                error: msg,
            };
            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setFailedStmt(failed);
            setDryRunResult({ success: false, statementCount: stmts.length, elapsedMs, errorMessage: msg });
            setPhase("error");
            // Ensure ROLLBACK on failure
            await dbExecuteQuery(targetConnectionId, "ROLLBACK;", {
                environment: targetConn?.environment ?? null,
            }).catch(() => { });
            toast.error("Dry run failed", { description: msg });
        }
    }, [targetConnectionId, targetConn, setDryRunResult]);

    const run = useCallback(async () => {
        abortRef.current = false;
        setRunning(true);
        setPhase("running");
        setResults([]);
        setFailedStmt(null);
        setElapsed(null);
        setUsingFallback(false);
        const t0 = Date.now();
        let sandboxId: string | null = null;

        const stmts = splitSqlStatements(forwardSQL).filter(s =>
            s.replace(/--[^\n]*/g, "").trim().length > 0
        );

        setProgress({ current: 0, total: stmts.length, mode: "sandbox" });

        try {
            // Try to open a sandbox connection
            sandboxId = await dbSandboxBegin(targetConnectionId);
        } catch (sandboxErr) {
            // Sandbox connection failed (TLS / network issue) — fall back to transaction mode
            const sandboxMsg = String(sandboxErr);
            const isTlsOrNetwork = /tls|ssl|handshake|connect|network/i.test(sandboxMsg);
            if (isTlsOrNetwork || true) {
                // Always try fallback
                toast.warning("Sandbox unavailable — using transaction fallback", {
                    description: sandboxMsg,
                });
                try {
                    await runFallback(stmts, t0);
                } finally {
                    setRunning(false);
                    setDryRunning(false);
                }
                return;
            }
            // Non-network error — report directly
            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setFailedStmt({ index: 0, sql: "", ok: false, error: sandboxMsg });
            setDryRunResult({ success: false, statementCount: 0, elapsedMs, errorMessage: sandboxMsg });
            setPhase("error");
            setRunning(false);
            setDryRunning(false);
            return;
        }

        // Sandbox available — execute statement by statement
        try {
            const stmtResults: DryRunStmtResult[] = [];

            for (let i = 0; i < stmts.length; i++) {
                if (abortRef.current) break;
                setProgress({ current: i + 1, total: stmts.length, mode: "sandbox" });
                try {
                    await dbSandboxExecute(sandboxId!, stmts[i]);
                    stmtResults.push({ index: i + 1, sql: stmts[i], ok: true });
                } catch (e) {
                    const errMsg = String(e);
                    const failed: DryRunStmtResult = { index: i + 1, sql: stmts[i], ok: false, error: errMsg };
                    stmtResults.push(failed);
                    setResults([...stmtResults]);
                    setFailedStmt(failed);
                    const elapsedMs = Date.now() - t0;
                    setElapsed(elapsedMs);
                    setDryRunResult({ success: false, statementCount: i + 1, elapsedMs, errorMessage: errMsg });
                    setPhase("error");
                    toast.error(`Dry run failed at statement ${i + 1}/${stmts.length}`, { description: errMsg });
                    return;
                }
            }

            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setResults(stmtResults);
            setDryRunResult({ success: true, statementCount: stmts.length, elapsedMs });
            setPhase("success");
            toast.success(`Dry run passed — ${stmts.length} statements, all rolled back`);
            playNotificationSound();
        } catch (e) {
            const msg = String(e);
            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setFailedStmt({ index: 0, sql: "", ok: false, error: msg });
            setDryRunResult({ success: false, statementCount: 0, elapsedMs, errorMessage: msg });
            setPhase("error");
            toast.error("Dry run failed", { description: msg });
        } finally {
            if (sandboxId) await dbSandboxRollback(sandboxId).catch(() => { });
            setRunning(false);
            setDryRunning(false);
        }
    }, [targetConnectionId, forwardSQL, runFallback, setDryRunResult, setDryRunning]);

    useEffect(() => {
        if (open) { setPhase("idle"); run(); }
        if (!open) { abortRef.current = true; }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const passedCount = results.filter(r => r.ok).length;
    const totalCount = progress?.total ?? 0;
    const pct = totalCount > 0 ? Math.round((progress!.current / totalCount) * 100) : 0;

    return (
        <Dialog open={open} onOpenChange={v => !v && onClose()}>
            <DialogContent className="sm:max-w-lg bg-card border-border/30">
                <DialogHeader>
                    <DialogTitle className="text-sm flex items-center gap-2">
                        <Play className="h-4 w-4 text-blue-400" />
                        Dry Run
                        {phase === "running" && progress && (
                            <span className="text-[11px] text-muted-foreground/50 font-normal ml-1">
                                {progress.current}/{progress.total} statements
                            </span>
                        )}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-3 py-1">
                    {/* Fallback mode badge */}
                    {usingFallback && (
                        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                            <TriangleAlert className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <p className="text-[11px] text-amber-300">
                                <span className="font-semibold">Fallback mode</span> — Sandbox unavailable (TLS). Using transaction rollback via existing connection.
                            </p>
                        </div>
                    )}

                    {/* Progress bar */}
                    {phase === "running" && progress && (
                        <div className="flex flex-col gap-2">
                            <div className="h-1.5 rounded-full bg-muted/20 overflow-hidden">
                                <div
                                    className={cn("h-full transition-all duration-200 rounded-full", usingFallback ? "bg-amber-500" : "bg-blue-500")}
                                    style={{ width: usingFallback ? "100%" : `${pct}%` }}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <Loader2 className={cn("h-3 w-3 animate-spin shrink-0", usingFallback ? "text-amber-400" : "text-blue-400")} />
                                <p className={cn("text-[11px]", usingFallback ? "text-amber-300" : "text-blue-300")}>
                                    {usingFallback
                                        ? "Executing all statements in a single transaction…"
                                        : `Executing statement ${progress.current} of ${progress.total}…`}
                                </p>
                                {!usingFallback && <span className="text-[11px] text-muted-foreground/40 ml-auto">{pct}%</span>}
                            </div>
                            <p className="text-[10px] text-muted-foreground/40">All changes are wrapped in a transaction and will be rolled back automatically</p>
                        </div>
                    )}

                    {/* Success */}
                    {phase === "success" && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-start gap-3">
                            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
                            <div className="flex flex-col gap-0.5">
                                <p className="text-xs font-semibold text-emerald-300">
                                    All {usingFallback ? (progress?.total ?? passedCount) : passedCount} statements passed
                                    {usingFallback && <span className="font-normal text-emerald-400/60"> (fallback mode)</span>}
                                </p>
                                <p className="text-[11px] text-emerald-400/60">
                                    Completed in {elapsed}ms — no changes were applied to the database
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Failure */}
                    {phase === "error" && failedStmt && (
                        <div className="flex flex-col gap-2">
                            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 flex items-start gap-3">
                                <TriangleAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                                <div className="flex flex-col gap-1 min-w-0">
                                    <p className="text-xs font-semibold text-red-300">
                                        {failedStmt.index === 0 ? "Connection failed" : `Failed at statement ${failedStmt.index}`}
                                        {totalCount > 0 && failedStmt.index > 0 && <span className="text-red-400/60 font-normal"> of {totalCount}</span>}
                                        {passedCount > 0 && <span className="text-red-400/60 font-normal"> ({passedCount} passed)</span>}
                                    </p>
                                    <p className="text-[11px] text-red-400/80 font-mono break-all">{failedStmt.error}</p>
                                </div>
                            </div>
                            {failedStmt.sql && (
                                <div className="rounded-lg border border-border/15 bg-muted/5 px-3 py-2.5">
                                    <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-1.5">Failed statement</p>
                                    <pre className="text-[10px] text-orange-300/80 font-mono whitespace-pre-wrap break-all max-h-28 overflow-y-auto leading-relaxed">
                                        {failedStmt.sql.trim().slice(0, 600)}{failedStmt.sql.length > 600 ? "…" : ""}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Statement summary when done */}
                    {(phase === "success" || phase === "error") && (results.length > 0 || usingFallback) && (
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/50">
                            {!usingFallback && <span className="text-emerald-400">{results.filter(r => r.ok).length} passed</span>}
                            {!usingFallback && results.some(r => !r.ok) && <span className="text-red-400">{results.filter(r => !r.ok).length} failed</span>}
                            {usingFallback && phase === "success" && <span className="text-emerald-400">{progress?.total} statements passed</span>}
                            {elapsed && <span className="ml-auto">{elapsed}ms</span>}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} disabled={running} className="text-xs h-8">
                        {running ? "Running…" : "Close"}
                    </Button>
                    {phase === "error" && (
                        <Button size="sm" onClick={run} disabled={running} className="text-xs h-8">
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Run SQL File Dialog ──────────────────────────────────────────────────────

interface RunSqlFileStmtResult {
    index: number;
    sql: string;
    ok: boolean;
    error?: string;
}

function RunSqlFileDialog({
    open,
    onClose,
    targetConnectionId,
    targetConn,
}: {
    open: boolean;
    onClose: () => void;
    targetConnectionId: string;
    targetConn?: import("@/stores/connection-store").ConnectionEntry | undefined;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [stmts, setStmts] = useState<string[]>([]);
    const [running, setRunning] = useState(false);
    const [dryRun, setDryRun] = useState(true);
    const [progress, setProgress] = useState<{ current: number; total: number; mode: "sandbox" | "fallback" | "commit" } | null>(null);
    const [results, setResults] = useState<RunSqlFileStmtResult[]>([]);
    const [failedStmt, setFailedStmt] = useState<RunSqlFileStmtResult | null>(null);
    const [elapsed, setElapsed] = useState<number | null>(null);
    const [phase, setPhase] = useState<"idle" | "select" | "running" | "success" | "error">("idle");
    const [usingFallback, setUsingFallback] = useState(false);
    const abortRef = useRef(false);

    const resetForNewFile = useCallback(() => {
        setFileName(null);
        setStmts([]);
        setResults([]);
        setFailedStmt(null);
        setElapsed(null);
        setProgress(null);
        setPhase("idle");
    }, []);

    const loadFile = useCallback((file: File) => {
        if (!file.name.toLowerCase().endsWith(".sql")) {
            toast.error("Please select a .sql file");
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const sql = String(reader.result ?? "");
            const parsed = splitSqlStatements(sql).filter(s =>
                s.replace(/--[^\n]*/g, "").trim().length > 0
            );
            setFileName(file.name);
            setStmts(parsed);
            setPhase(parsed.length > 0 ? "select" : "idle");
            if (parsed.length === 0) toast.warning("No executable statements found in file");
        };
        reader.readAsText(file, "UTF-8");
    }, []);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) loadFile(file);
    }, [loadFile]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer.files?.[0];
        if (file) loadFile(file);
    }, [loadFile]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const runFallback = useCallback(async (statements: string[], rollback: boolean, t0: number) => {
        setUsingFallback(true);
        setProgress({ current: 0, total: statements.length, mode: "fallback" });
        const endCmd = rollback ? "ROLLBACK;" : "COMMIT;";
        const txSql = ["BEGIN;", ...statements, endCmd].join("\n");
        try {
            const result = await dbExecuteQuery(targetConnectionId, txSql, {
                environment: targetConn?.environment ?? null,
            });
            if (result.is_error) throw new Error(result.error_message ?? "Unknown error");
            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setResults(statements.map((s, i) => ({ index: i + 1, sql: s, ok: true })));
            setPhase("success");
            setProgress({ current: statements.length, total: statements.length, mode: "fallback" });
            toast.success(
                rollback
                    ? `Dry run passed — ${statements.length} statements rolled back`
                    : `${statements.length} statements executed successfully`
            );
            if (rollback) playNotificationSound();
        } catch (e) {
            const msg = String(e);
            const stmtMatch = msg.match(/statement (\d+)/i);
            const failIdx = stmtMatch ? parseInt(stmtMatch[1]) - 1 : 0;
            const failed: RunSqlFileStmtResult = {
                index: failIdx + 1,
                sql: statements[failIdx] ?? "",
                ok: false,
                error: msg,
            };
            setElapsed(Date.now() - t0);
            setFailedStmt(failed);
            setPhase("error");
            await dbExecuteQuery(targetConnectionId, "ROLLBACK;", {
                environment: targetConn?.environment ?? null,
            }).catch(() => {});
            toast.error(rollback ? "Dry run failed" : "Execution failed", { description: msg });
        }
    }, [targetConnectionId, targetConn]);

    const run = useCallback(async () => {
        if (stmts.length === 0) return;
        abortRef.current = false;
        setRunning(true);
        setPhase("running");
        setResults([]);
        setFailedStmt(null);
        setElapsed(null);
        setUsingFallback(false);
        const t0 = Date.now();
        const rollback = dryRun;

        // Commit path: single transaction with COMMIT (no sandbox)
        if (!rollback) {
            try {
                await runFallback(stmts, false, t0);
            } finally {
                setRunning(false);
            }
            return;
        }

        // Dry run: try sandbox first, then fallback to BEGIN/ROLLBACK
        let sandboxId: string | null = null;
        try {
            sandboxId = await dbSandboxBegin(targetConnectionId);
        } catch (sandboxErr) {
            const sandboxMsg = String(sandboxErr);
            toast.warning("Sandbox unavailable — using transaction fallback", { description: sandboxMsg });
            try {
                await runFallback(stmts, true, t0);
            } finally {
                setRunning(false);
            }
            return;
        }

        try {
            const stmtResults: RunSqlFileStmtResult[] = [];
            setProgress({ current: 0, total: stmts.length, mode: "sandbox" });

            for (let i = 0; i < stmts.length; i++) {
                if (abortRef.current) break;
                setProgress({ current: i + 1, total: stmts.length, mode: "sandbox" });
                try {
                    await dbSandboxExecute(sandboxId!, stmts[i]);
                    stmtResults.push({ index: i + 1, sql: stmts[i], ok: true });
                } catch (e) {
                    const errMsg = String(e);
                    const failed: RunSqlFileStmtResult = { index: i + 1, sql: stmts[i], ok: false, error: errMsg };
                    stmtResults.push(failed);
                    setResults([...stmtResults]);
                    setFailedStmt(failed);
                    setElapsed(Date.now() - t0);
                    setPhase("error");
                    toast.error(`Failed at statement ${i + 1}/${stmts.length}`, { description: errMsg });
                    return;
                }
            }

            const elapsedMs = Date.now() - t0;
            setElapsed(elapsedMs);
            setResults(stmtResults);
            setPhase("success");
            playNotificationSound();
            toast.success(`Dry run passed — ${stmts.length} statements rolled back`);
        } catch (e) {
            const msg = String(e);
            setElapsed(Date.now() - t0);
            setFailedStmt({ index: 0, sql: "", ok: false, error: msg });
            setPhase("error");
            toast.error("Dry run failed", { description: msg });
        } finally {
            if (sandboxId) await dbSandboxRollback(sandboxId).catch(() => {});
            setRunning(false);
        }
    }, [targetConnectionId, targetConn, stmts, dryRun, runFallback]);

    useEffect(() => {
        if (!open) {
            abortRef.current = true;
        } else {
            resetForNewFile();
        }
    }, [open, resetForNewFile]);

    const passedCount = results.filter((r) => r.ok).length;
    const totalCount = progress?.total ?? 0;
    const pct = totalCount > 0 ? Math.round(((progress?.current ?? 0) / totalCount) * 100) : 0;

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-lg bg-card border-border/30">
                <DialogHeader>
                    <DialogTitle className="text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4 text-sky-400" />
                        Run SQL file
                        {phase === "running" && progress && (
                            <span className="text-[11px] text-muted-foreground/50 font-normal ml-1">
                                {progress.current}/{progress.total}
                            </span>
                        )}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-3 py-1">
                    {phase === "idle" && (
                        <div
                            className={cn(
                                "rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
                                "border-border/40 hover:border-sky-500/40 hover:bg-sky-500/5"
                            )}
                            onClick={() => fileInputRef.current?.click()}
                            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            role="button"
                            tabIndex={0}
                        >
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".sql"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                            <FileText className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                            <p className="text-xs font-medium text-foreground">Choose a .sql file</p>
                            <p className="text-[11px] text-muted-foreground/50 mt-0.5">or drag and drop (when supported)</p>
                        </div>
                    )}

                    {(phase === "select" || phase === "running" || phase === "success" || phase === "error") && fileName && (
                        <>
                            <div className="flex items-center justify-between rounded-lg border border-border/20 bg-muted/5 px-3 py-2">
                                <span className="text-xs font-medium truncate max-w-[200px]" title={fileName}>
                                    {fileName}
                                </span>
                                <span className="text-[11px] text-muted-foreground/50">{stmts.length} statements</span>
                            </div>
                            {phase === "select" && (
                                <div className="flex flex-col gap-2">
                                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                                        <Checkbox checked={dryRun} onCheckedChange={(c) => setDryRun(c === true)} />
                                        Dry run (rollback — no changes applied)
                                    </label>
                                    <Button size="sm" className="w-full gap-2 h-8 text-xs" onClick={run} disabled={running}>
                                        <Play className="h-3.5 w-3.5" />
                                        Run {dryRun ? "dry run" : "and commit"}
                                    </Button>
                                </div>
                            )}
                        </>
                    )}

                    {usingFallback && phase !== "idle" && (
                        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                            <TriangleAlert className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <p className="text-[11px] text-amber-300">Fallback mode — single transaction</p>
                        </div>
                    )}

                    {phase === "running" && progress && (
                        <div className="flex flex-col gap-2">
                            <div className="h-1.5 rounded-full bg-muted/20 overflow-hidden">
                                <div
                                    className={cn(
                                        "h-full transition-all duration-200 rounded-full",
                                        usingFallback ? "bg-amber-500" : "bg-sky-500"
                                    )}
                                    style={{ width: usingFallback ? "100%" : `${pct}%` }}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <Loader2 className="h-3 w-3 animate-spin shrink-0 text-sky-400" />
                                <p className="text-[11px] text-muted-foreground">
                                    Executing statement {progress.current} of {progress.total}…
                                </p>
                            </div>
                        </div>
                    )}

                    {phase === "success" && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-start gap-3">
                            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-xs font-semibold text-emerald-300">
                                    {dryRun ? "Dry run passed" : "Execution complete"} — {passedCount || totalCount} statements
                                </p>
                                <p className="text-[11px] text-emerald-400/60 mt-0.5">
                                    {elapsed}ms {dryRun ? "(no changes applied)" : ""}
                                </p>
                            </div>
                        </div>
                    )}

                    {phase === "error" && failedStmt && (
                        <div className="flex flex-col gap-2">
                            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                                <p className="text-xs font-semibold text-red-300">
                                    Failed at statement {failedStmt.index}
                                    {totalCount > 0 && ` of ${totalCount}`}
                                </p>
                                <p className="text-[11px] text-red-400/80 font-mono break-all mt-1">{failedStmt.error}</p>
                            </div>
                            {failedStmt.sql && (
                                <div className="rounded-lg border border-border/15 bg-muted/5 px-3 py-2.5">
                                    <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-1.5">Failed statement</p>
                                    <pre className="text-[10px] text-orange-300/80 font-mono whitespace-pre-wrap break-all max-h-28 overflow-y-auto">
                                        {failedStmt.sql.trim().slice(0, 600)}{failedStmt.sql.length > 600 ? "…" : ""}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    {(phase === "success" || phase === "error") && (
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/50">
                            <span className="text-emerald-400">{results.filter((r) => r.ok).length} passed</span>
                            {results.some((r) => !r.ok) && <span className="text-red-400">{results.filter((r) => !r.ok).length} failed</span>}
                            {elapsed != null && <span className="ml-auto">{elapsed}ms</span>}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} disabled={running} className="text-xs h-8">
                        {running ? "Running…" : "Close"}
                    </Button>
                    {(phase === "select" || phase === "success" || phase === "error") && (
                        <Button variant="ghost" size="sm" onClick={resetForNewFile} disabled={running} className="text-xs h-8">
                            Choose another file
                        </Button>
                    )}
                    {phase === "error" && (
                        <Button size="sm" onClick={run} disabled={running} className="text-xs h-8">
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Apply Confirmation Dialog ────────────────────────────────────────────────

function ApplyDialog({
    open,
    onClose,
    onConfirm,
    criticalCount,
    highCount,
    totalChanges,
    targetDb,
}: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    criticalCount: number;
    highCount: number;
    totalChanges: number;
    targetDb: string;
}) {
    const [checked, setChecked] = useState(false);

    useEffect(() => { if (!open) setChecked(false); }, [open]);

    return (
        <Dialog open={open} onOpenChange={v => !v && onClose()}>
            <DialogContent className="sm:max-w-md bg-card border-border/30">
                <DialogHeader>
                    <DialogTitle className="text-sm flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-red-400" />
                        Apply Migration
                    </DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4 py-2">
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300/80">
                        <p className="font-semibold mb-2">You are about to apply {totalChanges} schema changes to:</p>
                        <p className="font-mono text-amber-300 text-[11px]">{targetDb}</p>
                    </div>
                    {(criticalCount > 0 || highCount > 0) && (
                        <div className="flex flex-col gap-1.5">
                            {criticalCount > 0 && (
                                <div className="flex items-center gap-2 text-xs text-red-400">
                                    <ShieldAlert className="h-3.5 w-3.5" />
                                    <span>{criticalCount} critical change{criticalCount > 1 ? "s" : ""} — potential data loss</span>
                                </div>
                            )}
                            {highCount > 0 && (
                                <div className="flex items-center gap-2 text-xs text-orange-400">
                                    <TriangleAlert className="h-3.5 w-3.5" />
                                    <span>{highCount} high-severity change{highCount > 1 ? "s" : ""}</span>
                                </div>
                            )}
                        </div>
                    )}
                    <label className="flex items-start gap-2.5 cursor-pointer">
                        <Checkbox
                            checked={checked}
                            onCheckedChange={v => setChecked(v === true)}
                            className="mt-0.5"
                        />
                        <span className="text-xs text-muted-foreground/70 leading-relaxed">
                            I understand this operation will modify the target database schema and may be irreversible without the rollback SQL.
                        </span>
                    </label>
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8">Cancel</Button>
                    <Button
                        size="sm"
                        onClick={onConfirm}
                        disabled={!checked}
                        className="text-xs h-8 bg-red-600 hover:bg-red-700 text-white"
                    >
                        <Zap className="h-3.5 w-3.5 mr-1.5" />
                        Apply Migration
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Backup Dialog ────────────────────────────────────────────────────────────

function BackupDialog({
    open,
    onClose,
    targetConnectionId,
    selectedSchemas,
}: {
    open: boolean;
    onClose: () => void;
    targetConnectionId: string;
    selectedSchemas: string[];
}) {
    const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
    const [outputPath, setOutputPath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(async () => {
        setStatus("running");
        setError(null);
        try {
            const result = await dbExportSql({
                connection_id: targetConnectionId,
                schemas: selectedSchemas,
                tables: [],
                content_type: "structure_and_data",
                compress: false,
            });
            setOutputPath(result.output_path);
            setStatus("done");
            toast.success("Backup created", { description: result.output_path });
            playNotificationSound();
        } catch (e) {
            setError(String(e));
            setStatus("error");
        }
    }, [targetConnectionId, selectedSchemas]);

    useEffect(() => {
        if (open && status === "idle") run();
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!open) { setStatus("idle"); setOutputPath(null); setError(null); }
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={v => !v && onClose()}>
            <DialogContent className="sm:max-w-md bg-card border-border/30">
                <DialogHeader>
                    <DialogTitle className="text-sm flex items-center gap-2">
                        <Shield className="h-4 w-4 text-emerald-400" />
                        Backup Target Database
                    </DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    {status === "running" && (
                        <div className="flex items-center gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                            <Loader2 className="h-4 w-4 text-blue-400 animate-spin shrink-0" />
                            <p className="text-xs text-blue-300">Exporting schema and data…</p>
                        </div>
                    )}
                    {status === "done" && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                            <p className="text-xs font-semibold text-emerald-300 mb-1.5">Backup complete</p>
                            <p className="text-[11px] text-emerald-400/60 font-mono break-words">{outputPath}</p>
                        </div>
                    )}
                    {status === "error" && (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                            <p className="text-xs font-semibold text-red-400 mb-1">Backup failed</p>
                            <p className="text-[11px] text-red-400/70 font-mono">{error}</p>
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8">Close</Button>
                    {status === "error" && (
                        <Button size="sm" onClick={run} className="text-xs h-8">
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── History Panel ────────────────────────────────────────────────────────────

function HistoryPanel() {
    const {
        migrationHistory,
        removeHistoryEntry,
        clearHistory,
        setHistoryPanelOpen,
        setActiveSqlView,
        forwardSQL,
        rollbackSQL,
    } = useMigrationStudioStore();

    const loadRollback = (entry: MigrationHistoryEntry) => {
        // In a real revert, we load the rollback SQL into the editor
        // Here we just copy it and notify
        navigator.clipboard.writeText(entry.rollbackSQL).then(() => {
            toast.success("Rollback SQL copied to clipboard", {
                description: "Paste it into the SQL editor to apply",
            });
        });
    };

    return (
        <div className="flex w-80 shrink-0 flex-col border-l border-border/20 bg-card/10">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
                <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground/60" />
                    <span className="text-xs font-semibold text-foreground/80">Migration History</span>
                    {migrationHistory.length > 0 && (
                        <Badge className="h-4 px-1.5 text-[10px] bg-muted/30 border-0 text-muted-foreground/50">
                            {migrationHistory.length}
                        </Badge>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {migrationHistory.length > 0 && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-red-400"
                                    onClick={clearHistory}
                                >
                                    <Trash2 className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Clear history</TooltipContent>
                        </Tooltip>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground/40"
                        onClick={() => setHistoryPanelOpen(false)}
                    >
                        <X className="h-3 w-3" />
                    </Button>
                </div>
            </div>
            <ScrollArea className="flex-1">
                {migrationHistory.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                        <Clock className="h-8 w-8 text-muted-foreground/15" />
                        <p className="text-xs text-muted-foreground/40">No migration history yet</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1 p-3">
                        {migrationHistory.map(entry => (
                            <div
                                key={entry.id}
                                className="rounded-lg border border-border/15 bg-card/20 p-3 flex flex-col gap-2"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex flex-col gap-0.5 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[11px] font-mono text-foreground/70 truncate">{entry.sourceDb}</span>
                                            <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
                                            <span className="text-[11px] font-mono text-foreground/70 truncate">{entry.targetDb}</span>
                                        </div>
                                        <span className="text-[10px] text-muted-foreground/40">{formatTime(entry.timestamp)}</span>
                                    </div>
                                    <Badge className={cn("h-4 px-1.5 text-[9px] border shrink-0", statusBadgeClass(entry.status))}>
                                        {entry.status}
                                    </Badge>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-muted-foreground/40">{entry.totalChanges} changes</span>
                                    <div className="flex items-center gap-1">
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-violet-400"
                                                    onClick={() => loadRollback(entry)}
                                                >
                                                    <RotateCcw className="h-2.5 w-2.5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>Copy rollback SQL</TooltipContent>
                                        </Tooltip>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-red-400"
                                                    onClick={() => removeHistoryEntry(entry.id)}
                                                >
                                                    <X className="h-2.5 w-2.5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>Remove</TooltipContent>
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
    return (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground/40">
            {label}
        </div>
    );
}

// ─── Apply Overlay ────────────────────────────────────────────────────────────

function ApplyOverlay() {
    return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-border/20 bg-card/90 px-8 py-8 shadow-2xl">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
                <div className="text-center">
                    <p className="text-sm font-semibold">Applying migration…</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Please do not close this window</p>
                </div>
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MigrationStudioPage() {
    const router = useRouter();
    const { connections: activeConnections } = useConnectionStore();
    const {
        connections: savedConnections,
        isLoading: savedLoading,
        error: savedError,
        load: loadSaved,
    } = useSavedConnectionsStore();
    const store = useMigrationStudioStore();

    const {
        sourceConnectionId,
        targetConnectionId,
        selectedSchemas,
        selectedTables,
        migrationMode,
        includeOptions,
        largeDbOptions,
        diffResult,
        forwardSQL,
        rollbackSQL,
        isAnalyzing,
        analyzeProgress,
        analyzeError,
        applyError,
        isApplying,
        isDryRunning,
        isBackingUp,
        activeSqlView,
        historyPanelOpen,
        currentStep,
    } = store;

    // Picker state for each role — tracks selected saved conn + live conn ID
    const [srcPicker, setSrcPicker] = useState<PickerState>(EMPTY_PICKER);
    const [tgtPicker, setTgtPicker] = useState<PickerState>(EMPTY_PICKER);

    const [showCreateDb, setShowCreateDb] = useState(false);
    const [showDryRun, setShowDryRun] = useState(false);
    const [showRunSqlFile, setShowRunSqlFile] = useState(false);
    const [showApplyConfirm, setShowApplyConfirm] = useState(false);
    const [showBackup, setShowBackup] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);
    const [applyElapsedMs, setApplyElapsedMs] = useState(0);

    // Load saved connections on mount
    useEffect(() => { loadSaved(); }, [loadSaved]);

    // Sync picker live IDs → store
    useEffect(() => { store.setSourceConnection(srcPicker.liveId); }, [srcPicker.liveId]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { store.setTargetConnection(tgtPicker.liveId); }, [tgtPicker.liveId]); // eslint-disable-line react-hooks/exhaustive-deps

    // When a new live connection appears (from a previous session), auto-link pickers
    useEffect(() => {
        if (srcPicker.liveId && !srcPicker.savedId) {
            const entry = activeConnections.find(c => c.connectionId === srcPicker.liveId);
            if (entry?.savedConnectionId) setSrcPicker(p => ({ ...p, savedId: entry.savedConnectionId! }));
        }
    }, [activeConnections, srcPicker.liveId, srcPicker.savedId]);

    const sourceConn = activeConnections.find(c => c.connectionId === sourceConnectionId);
    const targetConn = activeConnections.find(c => c.connectionId === targetConnectionId);

    // Resolve display names from saved connections when live conn not yet available
    const srcSaved = savedConnections.find(c => c.id === srcPicker.savedId);
    const tgtSaved = savedConnections.find(c => c.id === tgtPicker.savedId);
    const sourceDbName = srcPicker.selectedDatabase ?? sourceConn?.databaseName ?? srcSaved?.database_name ?? "source";
    const targetDbName = tgtPicker.selectedDatabase ?? targetConn?.databaseName ?? tgtSaved?.database_name ?? "target";

    const handleSwap = () => {
        setSrcPicker(tgtPicker);
        setTgtPicker(srcPicker);
    };

    const toggleSchema = (schema: string) => {
        const current = store.selectedSchemas;
        if (current.includes(schema)) {
            store.setSelectedSchemas(current.filter(s => s !== schema));
        } else {
            store.setSelectedSchemas([...current, schema]);
        }
    };

    const handleSelectAllTables = (schema: string, keys: string[]) => {
        const currentInSchema = selectedTables.filter(k => k.startsWith(`${schema}.`));
        const allSelected = keys.length > 0 && currentInSchema.length === keys.length;
        if (allSelected) {
            store.setSelectedTables(selectedTables.filter(k => !k.startsWith(`${schema}.`)));
        } else {
            const outside = selectedTables.filter(k => !k.startsWith(`${schema}.`));
            store.setSelectedTables([...outside, ...keys]);
        }
    };

    // ── Analyze ───────────────────────────────────────────────────────────
    const handleAnalyze = useCallback(async () => {
        if (!sourceConnectionId || !targetConnectionId) return;
        store.setAnalyzing(true);
        store.setAnalyzeError(null);
        const snapshotOpts = {
            filterTables: selectedTables,
            includeFunctions: includeOptions.functions,
            includeIndexes: includeOptions.indexes,
            skipIndexesAboveRows: largeDbOptions.enabled ? largeDbOptions.skipIndexesAboveRows : 0,
            concurrency: largeDbOptions.enabled ? largeDbOptions.concurrency : 8,
        };
        try {
            const [srcSnap, tgtSnap] = await Promise.all([
                fetchSchemaSnapshot(
                    sourceConnectionId,
                    sourceDbName,
                    selectedSchemas,
                    (p) => store.setAnalyzeProgress(p),
                    snapshotOpts
                ),
                fetchSchemaSnapshot(
                    targetConnectionId,
                    targetDbName,
                    selectedSchemas,
                    () => { },
                    snapshotOpts
                ),
            ]);

            const diff = computeMigrationDiff(srcSnap, tgtSnap);
            const fwd = generateForwardSQL(diff);
            const roll = generateRollbackSQL(diff);
            store.setDiffResult(diff, fwd, roll, srcSnap, tgtSnap);
            store.setCurrentStep(2);
        } catch (e) {
            const msg = String(e);
            store.setAnalyzeError(msg);
            toast.error("Analysis failed", { description: msg });
        } finally {
            store.setAnalyzing(false);
            store.setAnalyzeProgress(null);
        }
    }, [sourceConnectionId, targetConnectionId, selectedSchemas, selectedTables, includeOptions, largeDbOptions, sourceConn, targetConn, store]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Apply ─────────────────────────────────────────────────────────────
    const handleApply = useCallback(async () => {
        if (!targetConnectionId || !forwardSQL) return;
        setShowApplyConfirm(false);
        store.setApplying(true);
        store.setApplyError(null);
        const entryId = uuidv4();
        const t0 = Date.now();
        try {
            const result = await dbExecuteQuery(targetConnectionId, forwardSQL, {
                environment: targetConn?.environment ?? null,
            });
            if (result.is_error) throw new Error(result.error_message ?? "Unknown error");

            const elapsed = Date.now() - t0;
            setApplyElapsedMs(elapsed);

            store.addHistoryEntry({
                id: entryId,
                timestamp: Date.now(),
                sourceDb: sourceDbName,
                targetDb: targetDbName,
                sourceConnectionId: sourceConnectionId!,
                targetConnectionId,
                forwardSQL,
                rollbackSQL,
                status: "success",
                appliedAt: Date.now(),
                schemasIncluded: selectedSchemas,
                tablesIncluded: selectedTables,
                migrationMode,
                totalChanges: diffResult?.totalChanges ?? 0,
                criticalCount: diffResult?.criticalCount ?? 0,
            });
            playNotificationSound();
            setShowSuccess(true);
        } catch (e) {
            const msg = String(e);
            store.setApplyError(msg);
            store.addHistoryEntry({
                id: entryId,
                timestamp: Date.now(),
                sourceDb: sourceDbName,
                targetDb: targetDbName,
                sourceConnectionId: sourceConnectionId!,
                targetConnectionId,
                forwardSQL,
                rollbackSQL,
                status: "failed",
                errorMessage: msg,
                schemasIncluded: selectedSchemas,
                tablesIncluded: selectedTables,
                migrationMode,
                totalChanges: diffResult?.totalChanges ?? 0,
                criticalCount: diffResult?.criticalCount ?? 0,
            });
            toast.error("Migration failed", { description: msg });
        } finally {
            store.setApplying(false);
        }
    }, [targetConnectionId, forwardSQL, rollbackSQL, targetDbName, sourceDbName, sourceConnectionId, diffResult, selectedSchemas, store, targetConn]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── New migration (reset) ─────────────────────────────────────────────
    const handleNewMigration = useCallback(() => {
        setShowSuccess(false);
        setSrcPicker(EMPTY_PICKER);
        setTgtPicker(EMPTY_PICKER);
        store.reset();
        store.setCurrentStep(1);
    }, [store]);

    // ── Export SQL ────────────────────────────────────────────────────────
    const handleExportSql = (which: "forward" | "rollback") => {
        const sql = which === "forward" ? forwardSQL : rollbackSQL;
        const blob = new Blob([sql], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `migration_${which}_${Date.now()}.sql`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`${which === "forward" ? "Forward" : "Rollback"} SQL exported`);
    };

    const handleCopySql = (which: "forward" | "rollback") => {
        const sql = which === "forward" ? forwardSQL : rollbackSQL;
        navigator.clipboard.writeText(sql).then(() => {
            toast.success("SQL copied to clipboard");
        });
    };

    const canAnalyze = !!(
        sourceConnectionId &&
        targetConnectionId &&
        sourceConnectionId !== targetConnectionId &&
        !srcPicker.connecting &&
        !tgtPicker.connecting
    );

    return (
        <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
            {/* Header */}
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/20 bg-card/20 px-4">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => router.back()}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 transition-all text-xs"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        <span>Back</span>
                    </button>
                    {/* <Separator orientation="vertical" className="h-4 bg-border/30" /> */}
                    <div className="flex items-center gap-2">
                        <GitCompare className="h-4 w-4 text-emerald-400" />
                        <span className="text-sm font-semibold">Migration Studio</span>
                        <Badge className="h-4 px-1.5 text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                            Pro
                        </Badge>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {currentStep > 1 && diffResult && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs gap-1.5 border-border/30"
                            onClick={() => store.setCurrentStep(Math.max(1, currentStep - 1) as 1 | 2 | 3)}
                        >
                            <ArrowLeft className="h-3 w-3" /> Back
                        </Button>
                    )}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "h-7 gap-1.5 px-2 text-xs",
                                    historyPanelOpen
                                        ? "text-foreground bg-muted/20"
                                        : "text-muted-foreground/50 hover:text-foreground"
                                )}
                                onClick={() => store.setHistoryPanelOpen(!historyPanelOpen)}
                            >
                                <History className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">History</span>
                                {store.migrationHistory.length > 0 && (
                                    <Badge className="h-4 px-1 text-[10px] bg-muted/30 border-0">
                                        {store.migrationHistory.length}
                                    </Badge>
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Migration History</TooltipContent>
                    </Tooltip>
                </div>
            </header>

            {/* Step Indicator */}
            <StepIndicator current={currentStep} />

            {/* Main content + history panel */}
            <div className="flex flex-1 overflow-hidden">
                <main className="flex-1 overflow-y-auto">
                    <div className="mx-auto max-w-4xl px-6 py-6 flex flex-col gap-6">

                        {/* ── STEP 1: Configure ──────────────────────────────────── */}
                        {currentStep === 1 && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <h2 className="text-base font-semibold">Configure Migration</h2>
                                    <p className="text-xs text-muted-foreground/60">
                                        Select source and target database connections, then choose which schemas to compare.
                                    </p>
                                </div>

                                {/* Connection selector */}
                                <div className="flex items-stretch gap-3">
                                    <ConnectionPicker
                                        role="source"
                                        pickerState={srcPicker}
                                        savedConnections={savedConnections}
                                        savedLoading={savedLoading}
                                        savedError={savedError}
                                        activeConnections={activeConnections}
                                        onPick={setSrcPicker}
                                        onRetryLoad={loadSaved}
                                    />

                                    {/* Swap button */}
                                    <div className="flex items-center">
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-9 w-9 p-0 rounded-full border-border/30 hover:border-emerald-500/30"
                                                    onClick={handleSwap}
                                                >
                                                    <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>Swap source and target</TooltipContent>
                                        </Tooltip>
                                    </div>

                                    <ConnectionPicker
                                        role="target"
                                        pickerState={tgtPicker}
                                        savedConnections={savedConnections}
                                        savedLoading={savedLoading}
                                        savedError={savedError}
                                        activeConnections={activeConnections}
                                        onPick={setTgtPicker}
                                        onRetryLoad={loadSaved}
                                    />
                                </div>

                                {/* Create new DB option */}
                                {targetConnectionId && (
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 text-xs gap-1.5 border-border/20 hover:border-emerald-500/30"
                                            onClick={() => setShowCreateDb(true)}
                                        >
                                            <Plus className="h-3 w-3" /> Create new database on target
                                        </Button>
                                    </div>
                                )}

                                {/* Migration mode */}
                                <MigrationModePanel
                                    mode={migrationMode}
                                    onChange={(m) => store.setMigrationMode(m)}
                                />

                                {/* Scope: schemas + tables */}
                                {sourceConnectionId && (
                                    <div className="rounded-xl border border-border/15 bg-card/20 p-4 flex flex-col gap-4">
                                        <ScopePanel
                                            connectionId={sourceConnectionId}
                                            selectedSchemas={selectedSchemas}
                                            selectedTables={selectedTables}
                                            onToggleSchema={toggleSchema}
                                            onToggleTable={(key) => store.toggleTable(key)}
                                            onSelectAllTables={handleSelectAllTables}
                                        />
                                    </div>
                                )}

                                {/* Include options */}
                                {sourceConnectionId && (
                                    <IncludeOptionsPanel
                                        options={includeOptions}
                                        onChange={(key, value) => store.setIncludeOption(key, value)}
                                    />
                                )}

                                {/* Large DB mode */}
                                <LargeDbPanel
                                    options={largeDbOptions}
                                    onChange={(patch) => store.setLargeDbOptions(patch)}
                                />

                                {analyzeError && (
                                    <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-400">
                                        {analyzeError}
                                    </div>
                                )}

                                {/* Analyze button */}
                                <Button
                                    size="sm"
                                    onClick={handleAnalyze}
                                    disabled={!canAnalyze || isAnalyzing}
                                    className="h-9 text-xs self-start bg-emerald-600 hover:bg-emerald-700 text-white px-6 gap-2"
                                >
                                    {isAnalyzing ? (
                                        <>
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            {analyzeProgress?.stage ?? "Analyzing…"}
                                        </>
                                    ) : (
                                        <>
                                            <GitCompare className="h-3.5 w-3.5" />
                                            Analyze Differences
                                        </>
                                    )}
                                </Button>

                                {/* Progress bar */}
                                {isAnalyzing && analyzeProgress && analyzeProgress.total > 0 && (
                                    <div className="flex flex-col gap-2">
                                        <div className="h-1.5 rounded-full bg-muted/20 overflow-hidden">
                                            <div
                                                className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                                                style={{ width: `${Math.round((analyzeProgress.current / analyzeProgress.total) * 100)}%` }}
                                            />
                                        </div>
                                        <p className="text-[11px] text-muted-foreground/50">{analyzeProgress.stage}</p>
                                    </div>
                                )}
                            </>
                        )}

                        {/* ── STEP 2: Analyze ────────────────────────────────────── */}
                        {currentStep === 2 && diffResult && (
                            <>
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h2 className="text-base font-semibold">Schema Differences</h2>
                                            <Badge className={cn(
                                                "text-[10px] h-4 px-1.5 border font-medium",
                                                migrationMode === "schema_and_data"
                                                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                                    : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                            )}>
                                                {migrationMode === "schema_and_data" ? "Schema + Data" : "Schema Only"}
                                            </Badge>
                                            {selectedTables.length > 0 && (
                                                <Badge className="text-[10px] h-4 px-1.5 border bg-muted/20 text-muted-foreground/60 border-border/20">
                                                    {selectedTables.length} tables
                                                </Badge>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
                                            <span className="font-mono">{sourceDbName}</span>
                                            <ArrowRight className="h-3 w-3" />
                                            <span className="font-mono">{targetDbName}</span>
                                        </p>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleAnalyze}
                                        disabled={isAnalyzing}
                                        className="h-7 text-xs gap-1.5 shrink-0 border-border/20"
                                    >
                                        {isAnalyzing
                                            ? <><Loader2 className="h-3 w-3 animate-spin" /> Re-analyzing…</>
                                            : <><RefreshCw className="h-3 w-3" /> Re-analyze</>
                                        }
                                    </Button>
                                </div>

                                <DiffViewer onGenerateSql={() => store.setCurrentStep(3)} />
                            </>
                        )}

                        {/* ── STEP 3: Execute ─────────────────────────────────────── */}
                        {currentStep === 3 && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <h2 className="text-base font-semibold">Execute Migration</h2>
                                    <p className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
                                        <span className="font-mono">{sourceDbName}</span>
                                        <ArrowRight className="h-3 w-3" />
                                        <span className="font-mono">{targetDbName}</span>
                                        <span className="mx-1 text-muted-foreground/20">·</span>
                                        <span>{diffResult?.totalChanges ?? 0} changes</span>
                                    </p>
                                </div>

                                {/* Migration checklist + SQL side by side on wide, stacked on narrow */}
                                <div className="flex flex-col lg:flex-row gap-4">
                                    {/* Left: Checklist */}
                                    <div className="flex flex-col gap-2 w-full lg:w-52 shrink-0">
                                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-semibold mb-1">Migration Checklist</p>
                                        {[
                                            {
                                                icon: <Shield className="h-3.5 w-3.5" />,
                                                label: "Backup target",
                                                desc: "Save a snapshot before applying",
                                                action: () => setShowBackup(true),
                                                actionLabel: "Run",
                                                done: false,
                                                color: "text-emerald-400",
                                            },
                                            {
                                                icon: <Play className="h-3.5 w-3.5" />,
                                                label: "Dry run",
                                                desc: "Validate SQL in a safe sandbox",
                                                action: () => setShowDryRun(true),
                                                actionLabel: store.dryRunResult?.success ? "✓ Passed" : "Run",
                                                done: store.dryRunResult?.success === true,
                                                color: store.dryRunResult?.success ? "text-emerald-400" : "text-blue-400",
                                            },
                                            {
                                                icon: <RotateCcw className="h-3.5 w-3.5" />,
                                                label: "Rollback SQL ready",
                                                desc: "Inverse SQL is generated",
                                                action: () => { store.setActiveSqlView("rollback"); },
                                                actionLabel: "View",
                                                done: !!rollbackSQL,
                                                color: "text-violet-400",
                                            },
                                        ].map((item, i) => (
                                            <div
                                                key={i}
                                                className={cn(
                                                    "rounded-lg border px-3 py-2.5 flex flex-col gap-1 transition-all",
                                                    item.done
                                                        ? "border-emerald-500/20 bg-emerald-500/5"
                                                        : "border-border/15 bg-card/20"
                                                )}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <div className={cn("flex items-center gap-1.5", item.done ? "text-emerald-400" : item.color)}>
                                                        {item.done ? <Check className="h-3.5 w-3.5" /> : item.icon}
                                                        <span className="text-[11px] font-semibold">{item.label}</span>
                                                    </div>
                                                    <button
                                                        onClick={item.action}
                                                        disabled={!targetConnectionId}
                                                        className={cn(
                                                            "text-[10px] font-medium rounded px-1.5 py-0.5 transition-all",
                                                            item.done
                                                                ? "text-emerald-400/60"
                                                                : "text-muted-foreground/50 hover:text-foreground hover:bg-muted/20"
                                                        )}
                                                    >
                                                        {item.actionLabel}
                                                    </button>
                                                </div>
                                                <p className="text-[10px] text-muted-foreground/40 leading-snug">{item.desc}</p>
                                            </div>
                                        ))}

                                        {/* Schema + Data notice */}
                                        {migrationMode === "schema_and_data" && (
                                            <div className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 flex flex-col gap-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <Package className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                                                    <p className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider">Data Migration</p>
                                                </div>
                                                <p className="text-[10px] text-amber-400/70 leading-snug">
                                                    {selectedTables.length > 0
                                                        ? `${selectedTables.length} tables selected for data copy.`
                                                        : "All tables will be included for data copy."}
                                                </p>
                                                {sourceConnectionId && targetConnectionId && (
                                                    <button
                                                        className="text-[10px] font-medium text-amber-400 hover:underline text-left mt-0.5"
                                                        onClick={() => {
                                                            dbExportSql({
                                                                connection_id: sourceConnectionId!,
                                                                schemas: selectedSchemas.length > 0 ? selectedSchemas : ["public"],
                                                                tables: selectedTables.map(k => {
                                                                    const [schema, table] = k.split(".");
                                                                    return { schema, table };
                                                                }),
                                                                content_type: "data_only",
                                                                compress: false,
                                                            }).then(() => toast.success("Data export started"))
                                                              .catch(e => toast.error("Export failed", { description: String(e) }));
                                                        }}
                                                    >
                                                        Export source data →
                                                    </button>
                                                )}
                                            </div>
                                        )}

                                        {/* Severity summary */}
                                        {diffResult && (diffResult.criticalCount > 0 || diffResult.highCount > 0) && (
                                            <div className="mt-1 rounded-lg border border-red-500/15 bg-red-500/5 px-3 py-2.5 flex flex-col gap-1.5">
                                                <p className="text-[10px] text-red-400/80 font-semibold uppercase tracking-wider">Risks</p>
                                                {diffResult.criticalCount > 0 && (
                                                    <div className="flex items-center gap-1.5 text-[11px] text-red-400">
                                                        <ShieldAlert className="h-3 w-3 shrink-0" />
                                                        <span>{diffResult.criticalCount} critical — data loss possible</span>
                                                    </div>
                                                )}
                                                {diffResult.highCount > 0 && (
                                                    <div className="flex items-center gap-1.5 text-[11px] text-orange-400">
                                                        <TriangleAlert className="h-3 w-3 shrink-0" />
                                                        <span>{diffResult.highCount} high severity</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Right: SQL */}
                                    <div className="flex flex-col gap-3 flex-1 rounded-xl border border-border/20 bg-card/20 p-4">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-0 border-b border-border/20 w-fit">
                                                {(["forward", "rollback"] as const).map(v => (
                                                    <button
                                                        key={v}
                                                        onClick={() => store.setActiveSqlView(v)}
                                                        className={cn(
                                                            "flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-all",
                                                            activeSqlView === v
                                                                ? "border-emerald-500 text-foreground"
                                                                : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
                                                        )}
                                                    >
                                                        {v === "forward"
                                                            ? <><Zap className="h-3 w-3 text-emerald-400" /> Forward</>
                                                            : <><RotateCcw className="h-3 w-3 text-violet-400" /> Rollback</>
                                                        }
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px] border-border/20" onClick={() => handleCopySql(activeSqlView)}>
                                                            <Copy className="h-3 w-3" /> Copy
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Copy to clipboard</TooltipContent>
                                                </Tooltip>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px] border-border/20" onClick={() => handleExportSql(activeSqlView)}>
                                                            <Download className="h-3 w-3" /> Export
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Download .sql file</TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>
                                        <SqlBlock sql={activeSqlView === "forward" ? forwardSQL : rollbackSQL} />
                                    </div>
                                </div>

                                {/* Action bar */}
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 border-border/20 hover:border-blue-500/30 hover:text-blue-400"
                                        onClick={() => setShowDryRun(true)}
                                        disabled={!targetConnectionId || isDryRunning}
                                    >
                                        <Play className="h-3.5 w-3.5" />
                                        {isDryRunning ? "Running…" : "Dry Run"}
                                    </Button>

                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 text-xs gap-1.5 border-border/20 hover:border-sky-500/30 hover:text-sky-400"
                                                onClick={() => setShowRunSqlFile(true)}
                                                disabled={!targetConnectionId}
                                            >
                                                <FileText className="h-3.5 w-3.5" />
                                                Run SQL file
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Execute statements from a .sql file</TooltipContent>
                                    </Tooltip>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 border-border/20 hover:border-emerald-500/30 hover:text-emerald-400"
                                        onClick={() => setShowBackup(true)}
                                        disabled={!targetConnectionId || isBackingUp}
                                    >
                                        <Shield className="h-3.5 w-3.5" />
                                        Backup Target
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 border-border/20 hover:border-violet-500/30 hover:text-violet-400"
                                        onClick={() => store.setCurrentStep(2)}
                                    >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                        Back to Diff
                                    </Button>

                                    <div className="flex-1" />

                                    <Button
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-5"
                                        onClick={() => setShowApplyConfirm(true)}
                                        disabled={!targetConnectionId || isApplying || !forwardSQL}
                                    >
                                        {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                        Apply Migration
                                    </Button>
                                </div>

                                {/* Apply error */}
                                {applyError && (
                                    <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                                        <p className="text-xs font-semibold text-red-400 mb-1">Migration failed</p>
                                        <p className="text-[11px] text-red-400/70 font-mono">{applyError}</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </main>

                {/* History panel */}
                {historyPanelOpen && <HistoryPanel />}
            </div>

            {/* Overlays / Dialogs */}
            {isApplying && <ApplyOverlay />}

            <CreateDbDialog
                open={showCreateDb}
                onClose={() => setShowCreateDb(false)}
                targetConnectionId={targetConnectionId}
                onCreated={() => { }}
            />

            {targetConnectionId && (
                <>
                    <DryRunDialog
                        open={showDryRun}
                        onClose={() => setShowDryRun(false)}
                        targetConnectionId={targetConnectionId}
                        forwardSQL={forwardSQL}
                        targetConn={targetConn}
                    />
                    <RunSqlFileDialog
                        open={showRunSqlFile}
                        onClose={() => setShowRunSqlFile(false)}
                        targetConnectionId={targetConnectionId}
                        targetConn={targetConn}
                    />
                    <BackupDialog
                        open={showBackup}
                        onClose={() => setShowBackup(false)}
                        targetConnectionId={targetConnectionId}
                        selectedSchemas={selectedSchemas}
                    />
                </>
            )}

            <ApplyDialog
                open={showApplyConfirm}
                onClose={() => setShowApplyConfirm(false)}
                onConfirm={handleApply}
                criticalCount={diffResult?.criticalCount ?? 0}
                highCount={diffResult?.highCount ?? 0}
                totalChanges={diffResult?.totalChanges ?? 0}
                targetDb={targetDbName}
            />

            <SuccessDialog
                open={showSuccess}
                totalChanges={diffResult?.totalChanges ?? 0}
                targetDb={targetDbName}
                sourceDb={sourceDbName}
                elapsedMs={applyElapsedMs}
                rollbackSQL={rollbackSQL}
                onClose={() => setShowSuccess(false)}
                onNewMigration={handleNewMigration}
            />
        </div>
    );
}
