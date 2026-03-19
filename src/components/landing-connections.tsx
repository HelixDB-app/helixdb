"use client";

import { useEffect, useState } from "react";
import type { SavedConnection } from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";
import { APP_NAME } from "@/lib/app-config";
import { useSavedConnectionsStore } from "@/stores/saved-connections-store";
import { ConnectionDialog } from "@/components/connection-dialog";
import { SaveConnectionDialog } from "@/components/save-connection-dialog";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { LocalPostgresCard } from "@/components/local-postgres-card";
import { StatusBar } from "@/components/status-bar";
import { ProfilePanel } from "@/components/profile-panel";
import { LoginPrompt } from "@/components/login-prompt";
import { authOpenBrowser } from "@/lib/tauri";
import { useCountdown } from "@/lib/use-countdown";
import {
    formatCriticalityLabel,
    normalizeConnectionCriticality,
    normalizeConnectionEnvironment,
    normalizeConnectionMetadata,
    formatEnvironmentLabel,
} from "@/lib/connection-metadata";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Database,
    Plug,
    Plus,
    Pencil,
    Trash2,
    Loader2,
    Server,
    Globe,
    Search,
    AlertCircle,
    Clock,
    ChevronRight,
    Keyboard,
    Layers,
} from "lucide-react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import Link from "next/link";

// ── Helpers ────────────────────────────────────────────────────────────────

function parseHost(connectionString: string): string {
    try {
        const url = new URL(connectionString);
        return url.hostname || "localhost";
    } catch {
        return "remote";
    }
}

function parseDb(connectionString: string): string {
    try {
        const url = new URL(connectionString);
        return url.pathname.replace(/^\//, "") || "postgres";
    } catch {
        return "unknown";
    }
}

function getInitials(name: string) {
    return name
        .split(/[\s_-]+/)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("");
}

const ACCENT_PALETTE = [
    "from-emerald-500 to-cyan-500",
    "from-violet-500 to-purple-500",
    "from-orange-500 to-amber-500",
    "from-sky-500 to-blue-500",
    "from-rose-500 to-pink-500",
    "from-teal-500 to-green-500",
];

function accentFor(id: string) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return ACCENT_PALETTE[hash % ACCENT_PALETTE.length];
}

// ── Component ──────────────────────────────────────────────────────────────

export function LandingConnections() {
    const {
        connections,
        isLoading,
        load,
        remove,
        error: savedConnectionsError,
        clearError: clearSavedConnectionsError,
    } = useSavedConnectionsStore();
    const {
        connect,
        isConnecting,
        connectionError,
        clearError: clearConnectionError,
    } = useConnectionStore();
    const { user, isAuthenticated } = useAuthStore();
    const { result: trialResult, loadState: trialLoadState, isTrialActive } = useTrialStore();

    const [showQuickConnect, setShowQuickConnect] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [editConnection, setEditConnection] = useState<SavedConnection | null>(null);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [pendingConnect, setPendingConnect] = useState<SavedConnection | null>(null);
    const [mounted, setMounted] = useState(false);
    const [showProfile, setShowProfile] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [environmentFilter, setEnvironmentFilter] = useState<"all" | "dev" | "staging" | "prod">("all");
    const [criticalityFilter, setCriticalityFilter] = useState<"all" | "low" | "medium" | "high">("all");

    const trialCountdown = useCountdown(trialResult?.trial?.trialExpiryDate);
    const showTrialCountdown =
        !isAuthenticated &&
        trialLoadState === "ready" &&
        trialResult !== null &&
        isTrialActive() &&
        !trialCountdown.expired;

    const pad = (value: number) => String(value).padStart(2, "0");
    const trialCountdownLabel = trialCountdown.days > 0
        ? `${trialCountdown.days}d ${pad(trialCountdown.hours)}h ${pad(trialCountdown.minutes)}m`
        : `${pad(trialCountdown.hours)}:${pad(trialCountdown.minutes)}:${pad(trialCountdown.seconds)}`;

    useEffect(() => {
        load();
        requestAnimationFrame(() => setMounted(true));
    }, [load]);

    useEffect(() => {
        if (pendingConnect) {
            const metadata = normalizeConnectionMetadata(pendingConnect);
            connect(
                pendingConnect.connection_string,
                pendingConnect.id,
                pendingConnect.name,
                metadata
            );
            setPendingConnect(null);
        }
    }, [pendingConnect, connect]);

    useEffect(() => {
        if (!isConnecting) setConnectingId(null);
    }, [isConnecting]);

    // ⌘K opens quick connect
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                setShowQuickConnect(true);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    const handleConnect = (conn: SavedConnection) => {
        setConnectingId(conn.id);
        const metadata = normalizeConnectionMetadata(conn);
        connect(conn.connection_string, conn.id, conn.name, metadata);
    };

    const handleSaveAndConnect = (conn: SavedConnection) => setPendingConnect(conn);

    const handleOpenEdit = (e: React.MouseEvent, conn: SavedConnection) => {
        e.stopPropagation();
        setEditConnection(conn);
        setShowSaveDialog(true);
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (confirm("Remove this saved connection?")) await remove(id);
    };

    const openAddDialog = () => {
        setEditConnection(null);
        setShowSaveDialog(true);
    };

    const handleClearFilters = () => {
        setSearchQuery("");
        setEnvironmentFilter("all");
        setCriticalityFilter("all");
    };

    const normalizedConnections = connections.map((conn) => ({
        ...conn,
        environment: normalizeConnectionEnvironment(conn.environment),
        criticality: normalizeConnectionCriticality(conn.criticality),
    }));

    const query = searchQuery.trim().toLowerCase();

    const filteredConnections = normalizedConnections.filter((conn) => {
        const matchesEnv =
            environmentFilter === "all" ||
            normalizeConnectionEnvironment(conn.environment) === environmentFilter;
        const matchesCriticality =
            criticalityFilter === "all" ||
            normalizeConnectionCriticality(conn.criticality) === criticalityFilter;

        if (!matchesEnv || !matchesCriticality) return false;

        if (!query) return true;

        const host = parseHost(conn.connection_string);
        const db = conn.database_name ?? parseDb(conn.connection_string);
        const tokens = [
            conn.name,
            host,
            db,
            conn.owner ?? "",
            formatEnvironmentLabel(conn.environment),
            formatCriticalityLabel(conn.criticality),
        ]
            .join(" ")
            .toLowerCase();

        return tokens.includes(query);
    });

    const hasConnections = connections.length > 0;

    return (
        <div className="flex h-screen flex-col bg-background overflow-hidden">
            {/* Ambient background */}
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-emerald-500/4 blur-3xl" />
                <div className="absolute -bottom-32 -right-32 h-80 w-80 rounded-full bg-cyan-500/4 blur-3xl" />
            </div>

            {/* ── Header ─────────────────────────────────────────────────── */}
            <header
                className={cn(
                    "relative flex h-12 shrink-0 items-center justify-between border-b border-border/20 bg-card/20 px-5 transition-all duration-500",
                    mounted ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
                )}
            >
                {/* Logo */}
                <div className="flex items-center gap-2.5">
                    <img src="/logo.png" alt="" className="h-7 w-7 rounded-lg object-contain shrink-0" />
                    <span className="font-bold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent tracking-tight">
                        {APP_NAME}
                    </span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/10 hover:bg-muted/30 transition-all"
                                onClick={() => setShowQuickConnect(true)}
                            >
                                <Plug className="h-3 w-3" />
                                Quick connect
                                <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40 ml-0.5">
                                    ⌘K
                                </kbd>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Connect with a connection string</TooltipContent>
                    </Tooltip>

                    <Button
                        size="sm"
                        className="h-7 gap-1.5 px-3 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-sm shadow-emerald-500/20 transition-all"
                        onClick={openAddDialog}
                    >
                        <Plus className="h-3 w-3" />
                        New connection
                    </Button>

                    <div className="h-4 w-px bg-border/30" />

                    {/* Profile / Login */}
                    {isAuthenticated && user ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={() => setShowProfile(true)}
                                    className="flex h-7 w-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    aria-label="Open profile"
                                >
                                    <Avatar className="h-6 w-6">
                                        <AvatarImage src={user.image ?? undefined} alt={user.name} />
                                        <AvatarFallback className="text-[9px] font-semibold bg-primary/10 text-primary">
                                            {user.name.split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() ?? "").join("")}
                                        </AvatarFallback>
                                    </Avatar>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{user.name}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <LoginPrompt compact />
                    )}
                </div>
            </header>

            <ProfilePanel open={showProfile} onClose={() => setShowProfile(false)} />

            {/* ── Main ───────────────────────────────────────────────────── */}
            <main id="main" className="relative flex-1 overflow-auto" tabIndex={-1} aria-label="Main content">
                <div className="max-w-5xl mx-auto px-6 py-8">
                    {showTrialCountdown && (
                        <div
                            className={cn(
                                "mb-6 rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-500/10 via-cyan-500/5 to-transparent px-4 py-3 shadow-sm",
                                mounted ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
                            )}
                        >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/60">
                                        <Clock className="h-3.5 w-3.5 text-emerald-400" />
                                        Free Trial Active
                                    </div>
                                    <p className="text-sm font-semibold text-foreground">
                                        All Pro features are unlocked for your device
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        Ends in{" "}
                                        <span className="font-mono text-foreground">{trialCountdownLabel}</span>
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    className="h-8 gap-1.5 px-3 text-xs bg-emerald-500 hover:bg-emerald-400 text-black"
                                    onClick={() =>
                                        authOpenBrowser(
                                            `${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app"}/pricing`
                                        )
                                    }
                                >
                                    Upgrade
                                    <ChevronRight className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>
                    )}
                    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">

                        {/* ── Left column: Local ─────────────────────────── */}
                        <div
                            className={cn(
                                "space-y-4 transition-all duration-500 delay-[50ms]",
                                mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
                            )}
                        >
                            <SectionHeader icon={<Server className="h-3.5 w-3.5" />} title="Local machine" />
                            <LocalPostgresCard />

                            {/* Keyboard shortcut hint */}
                            <div className="flex items-center gap-2 rounded-lg border border-border/15 bg-card/20 px-3 py-2.5">
                                <Keyboard className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
                                <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
                                    Press{" "}
                                    <kbd className="inline-flex items-center rounded border border-border/30 bg-muted/30 px-1 font-mono text-[9px] text-muted-foreground/50">
                                        ⌘K
                                    </kbd>{" "}
                                    anywhere to quick connect with a URL
                                </p>
                            </div>

                            {/* Schema projects */}
                            <SectionHeader icon={<Layers className="h-3.5 w-3.5" />} title="Schema projects" />
                            {/* Link to schema projects page */}
                            <Link href="/schema-projects" className="text-[10px] text-muted-foreground/40 hover:text-foreground hover:underline">
                                View all schema projects
                            </Link>

                        </div>

                        {/* ── Right column: Saved connections ────────────── */}
                        <div
                            className={cn(
                                "space-y-4 transition-all duration-500 delay-[120ms]",
                                mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
                            )}
                        >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <SectionHeader
                                    icon={<Globe className="h-3.5 w-3.5" />}
                                    title="Saved connections"
                                    count={connections.length}
                                />
                                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                                    <div className="relative flex-1 min-w-0 max-w-xs">
                                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
                                        <Input
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            placeholder="Search connections…"
                                            className="h-8 w-full pl-7 text-xs bg-background/40 border-border/30 focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                                        />
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Select
                                            value={environmentFilter}
                                            onValueChange={(value: "all" | "dev" | "staging" | "prod") =>
                                                setEnvironmentFilter(value)
                                            }
                                        >
                                            <SelectTrigger className="h-8 w-[120px] text-xs bg-background/40 border-border/30">
                                                <SelectValue placeholder="Environment" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="all">All envs</SelectItem>
                                                <SelectItem value="dev">Dev</SelectItem>
                                                <SelectItem value="staging">Staging</SelectItem>
                                                <SelectItem value="prod">Prod</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <Select
                                            value={criticalityFilter}
                                            onValueChange={(value: "all" | "low" | "medium" | "high") =>
                                                setCriticalityFilter(value)
                                            }
                                        >
                                            <SelectTrigger className="h-8 w-[120px] text-xs bg-background/40 border-border/30">
                                                <SelectValue placeholder="Criticality" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="all">All tiers</SelectItem>
                                                <SelectItem value="low">Low</SelectItem>
                                                <SelectItem value="medium">Medium</SelectItem>
                                                <SelectItem value="high">High</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            </div>

                            {(connectionError || savedConnectionsError) && (
                                <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <div className="flex-1 min-w-0 space-y-0.5">
                                        <p className="font-medium">
                                            {connectionError
                                                ? "Couldn’t connect to database."
                                                : "Couldn’t load saved connections."}
                                        </p>
                                        <p className="text-[11px] text-destructive/90 break-words">
                                            {connectionError ?? savedConnectionsError}
                                        </p>
                                        {connectionError && (
                                            <p className="text-[10px] text-destructive/80">
                                                Check your connection string, credentials, and network, then try
                                                again.
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (connectionError) clearConnectionError();
                                            if (savedConnectionsError) clearSavedConnectionsError();
                                        }}
                                        className="ml-2 text-[10px] font-medium text-destructive underline-offset-2 hover:underline"
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            )}

                            {isConnecting && (
                                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300/95">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                                    <div className="flex-1">
                                        <p className="font-medium">Connecting to database…</p>
                                        <p className="text-[10px] text-emerald-200/80">
                                            This can take a few seconds. You can keep browsing while we connect.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {isLoading ? (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {[1, 2, 3, 4].map((i) => (
                                        <Skeleton key={i} className="h-[88px] rounded-xl" />
                                    ))}
                                </div>
                            ) : !hasConnections ? (
                                <EmptyConnections onAdd={openAddDialog} onQuickConnect={() => setShowQuickConnect(true)} />
                            ) : filteredConnections.length === 0 ? (
                                <FilteredEmptyState onClearFilters={handleClearFilters} />
                            ) : (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {filteredConnections.map((conn, i) => {
                                        const isConnectingThis = isConnecting && connectingId === conn.id;
                                        return (
                                            <ConnectionCard
                                                key={conn.id}
                                                conn={conn}
                                                index={i}
                                                mounted={mounted}
                                                isConnecting={isConnecting}
                                                isConnectingThis={isConnectingThis}
                                                onConnect={() => handleConnect(conn)}
                                                onEdit={(e) => handleOpenEdit(e, conn)}
                                                onDelete={(e) => handleDelete(e, conn.id)}
                                            />
                                        );
                                    })}

                                    {/* Add new card */}
                                    <button
                                        type="button"
                                        onClick={openAddDialog}
                                        className="group flex h-[88px] items-center justify-center rounded-xl border border-dashed border-border/25 bg-transparent text-muted-foreground/30 transition-all hover:border-emerald-500/30 hover:text-emerald-400/60 hover:bg-emerald-500/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                        aria-label="Add new connection"
                                    >
                                        <div className="flex flex-col items-center gap-1.5">
                                            <Plus className="h-5 w-5 transition-transform group-hover:scale-110" />
                                            <span className="text-[10px] font-medium">Add connection</span>
                                        </div>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </main>

            <StatusBar />

            <ConnectionDialog open={showQuickConnect} onOpenChange={setShowQuickConnect} />

            <SaveConnectionDialog
                open={showSaveDialog}
                onOpenChange={setShowSaveDialog}
                editConnection={editConnection}
                onSaveAndConnect={handleSaveAndConnect}
            />
        </div>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SectionHeader({
    icon,
    title,
    count,
}: {
    icon: React.ReactNode;
    title: string;
    count?: number;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-muted-foreground/40">{icon}</span>
            <h2 className="text-xs font-semibold text-muted-foreground/70 tracking-wide uppercase">
                {title}
            </h2>
            {count !== undefined && count > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted/50 px-1.5 text-[9px] font-medium text-muted-foreground/50">
                    {count}
                </span>
            )}
        </div>
    );
}

function ConnectionCard({
    conn,
    index,
    mounted,
    isConnecting,
    isConnectingThis,
    onConnect,
    onEdit,
    onDelete,
}: {
    conn: SavedConnection;
    index: number;
    mounted: boolean;
    isConnecting: boolean;
    isConnectingThis: boolean;
    onConnect: () => void;
    onEdit: (e: React.MouseEvent) => void;
    onDelete: (e: React.MouseEvent) => void;
}) {
    const accent = accentFor(conn.id);
    const host = parseHost(conn.connection_string);
    const db = conn.database_name ?? parseDb(conn.connection_string);
    const initials = getInitials(conn.name);
    const criticality = normalizeConnectionCriticality(conn.criticality);

    return (
        <div
            className={cn(
                "group relative rounded-xl border border-border/20 bg-card/30 p-4 transition-all duration-300",
                "hover:border-border/40 hover:bg-card/50 hover:shadow-sm",
                "focus-within:ring-1 focus-within:ring-emerald-500/30",
                "duration-500",
                mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
            style={{ transitionDelay: `${180 + index * 50}ms` }}
        >
            {/* Top row */}
            <div className="flex items-start gap-3">
                {/* Avatar */}
                <div
                    className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white text-[11px] font-bold shadow-sm",
                        accent
                    )}
                >
                    {initials || <Database className="h-3.5 w-3.5" />}
                </div>

                {/* Name + meta */}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <p className="font-semibold text-sm text-foreground/90 truncate leading-tight">
                            {conn.name}
                        </p>
                        <ConnectionEnvBadge environment={conn.environment} compact className="shrink-0" />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <Globe className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
                        <p className="text-[10px] font-mono text-muted-foreground/50 truncate">
                            {host}
                        </p>
                        {db && (
                            <>
                                <span className="text-muted-foreground/20">·</span>
                                <p className="text-[10px] font-mono text-muted-foreground/50 truncate">
                                    {db}
                                </p>
                            </>
                        )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/55">
                        <span>Criticality: {formatCriticalityLabel(criticality)}</span>
                        {conn.owner && <span className="truncate">Owner: {conn.owner}</span>}
                    </div>
                </div>

                {/* Actions — visible on hover */}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={onEdit}
                                aria-label="Edit connection"
                            >
                                <Pencil className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Edit connection</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={onDelete}
                                aria-label="Remove connection"
                            >
                                <Trash2 className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Remove connection</TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Connect button */}
            <button
                type="button"
                className={cn(
                    "mt-3 w-full flex items-center justify-center gap-1.5 rounded-lg h-7 text-[11px] font-medium transition-all",
                    "bg-muted/30 text-muted-foreground/60 border border-border/20",
                    "hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30",
                    "disabled:pointer-events-none disabled:opacity-40",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    isConnectingThis && "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                )}
                onClick={onConnect}
                disabled={isConnecting}
                aria-label={`Connect to ${conn.name}`}
            >
                {isConnectingThis ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                    <ChevronRight className="h-3 w-3" />
                )}
                {isConnectingThis ? "Connecting…" : "Connect"}
            </button>
        </div>
    );
}

function EmptyConnections({
    onAdd,
    onQuickConnect,
}: {
    onAdd: () => void;
    onQuickConnect: () => void;
}) {
    return (
        <div className="rounded-xl border border-dashed border-border/25 bg-card/10 p-10 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/30">
                <Server className="h-6 w-6 text-muted-foreground/30" />
            </div>
            <p className="text-sm font-medium text-muted-foreground/60 mb-1">
                No saved connections
            </p>
            <p className="text-xs text-muted-foreground/40 mb-5">
                Save a connection to quickly reconnect later
            </p>
            <div className="flex items-center justify-center gap-2">
                <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                    onClick={onAdd}
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add connection
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs border-border/30"
                    onClick={onQuickConnect}
                >
                    <Plug className="h-3.5 w-3.5" />
                    Quick connect
                </Button>
            </div>
        </div>
    );
}

function FilteredEmptyState({ onClearFilters }: { onClearFilters: () => void }) {
    return (
        <div className="rounded-xl border border-dashed border-border/25 bg-card/10 p-8 text-center space-y-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-muted/30">
                <Search className="h-5 w-5 text-muted-foreground/35" />
            </div>
            <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground/70">
                    No connections match your filters
                </p>
                <p className="text-xs text-muted-foreground/45">
                    Try adjusting your search terms or clearing the filters to see all saved connections.
                </p>
            </div>
            <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs border-border/30"
                onClick={onClearFilters}
            >
                Clear filters
            </Button>
        </div>
    );
}
