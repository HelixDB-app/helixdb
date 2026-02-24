"use client";

import { useEffect, useState } from "react";
import type { SavedConnection } from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import { APP_NAME } from "@/lib/app-config";
import { useSavedConnectionsStore } from "@/stores/saved-connections-store";
import { ConnectionDialog } from "@/components/connection-dialog";
import { SaveConnectionDialog } from "@/components/save-connection-dialog";
import { LocalPostgresCard } from "@/components/local-postgres-card";
import { StatusBar } from "@/components/status-bar";
import { Button } from "@/components/ui/button";
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
    Clock,
    ChevronRight,
    Keyboard,
    Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
    const { connections, isLoading, load, remove } = useSavedConnectionsStore();
    const { connect, isConnecting } = useConnectionStore();

    const [showQuickConnect, setShowQuickConnect] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [editConnection, setEditConnection] = useState<SavedConnection | null>(null);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [pendingConnect, setPendingConnect] = useState<SavedConnection | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        load();
        requestAnimationFrame(() => setMounted(true));
    }, [load]);

    useEffect(() => {
        if (pendingConnect) {
            connect(pendingConnect.connection_string, pendingConnect.id);
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
        connect(conn.connection_string, conn.id);
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
                </div>
            </header>

            {/* ── Main ───────────────────────────────────────────────────── */}
            <main className="relative flex-1 overflow-auto">
                <div className="max-w-5xl mx-auto px-6 py-8">
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

                            {/* Schema Designer link */}
                            <a
                                href="/schema-designer/"
                                className="group flex items-center gap-3 rounded-xl border border-border/20 bg-card/30 p-4 transition-all hover:border-emerald-500/30 hover:bg-emerald-500/5 hover:shadow-sm"
                            >
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-cyan-600 text-white shadow-sm">
                                    <Layers className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-foreground/90 group-hover:text-emerald-400 transition-colors">
                                        Schema Designer
                                    </p>
                                    <p className="text-[10px] text-muted-foreground/40">
                                        Design schemas with AI assistance
                                    </p>
                                </div>
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-emerald-500/50 transition-colors shrink-0" />
                            </a>
                        </div>

                        {/* ── Right column: Saved connections ────────────── */}
                        <div
                            className={cn(
                                "space-y-4 transition-all duration-500 delay-[120ms]",
                                mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
                            )}
                        >
                            <div className="flex items-center justify-between">
                                <SectionHeader icon={<Globe className="h-3.5 w-3.5" />} title="Saved connections" count={connections.length} />
                            </div>

                            {isLoading ? (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {[1, 2, 3, 4].map((i) => (
                                        <Skeleton key={i} className="h-[88px] rounded-xl" />
                                    ))}
                                </div>
                            ) : connections.length === 0 ? (
                                <EmptyConnections onAdd={openAddDialog} onQuickConnect={() => setShowQuickConnect(true)} />
                            ) : (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {connections.map((conn, i) => {
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
                                        onClick={openAddDialog}
                                        className="group flex h-[88px] items-center justify-center rounded-xl border border-dashed border-border/25 bg-transparent text-muted-foreground/30 transition-all hover:border-emerald-500/30 hover:text-emerald-400/60 hover:bg-emerald-500/5"
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
                    <p className="font-semibold text-sm text-foreground/90 truncate leading-tight">
                        {conn.name}
                    </p>
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
                </div>

                {/* Actions — visible on hover */}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-all"
                                onClick={onEdit}
                            >
                                <Pencil className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Edit connection</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                                onClick={onDelete}
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
                className={cn(
                    "mt-3 w-full flex items-center justify-center gap-1.5 rounded-lg h-7 text-[11px] font-medium transition-all",
                    "bg-muted/30 text-muted-foreground/60 border border-border/20",
                    "hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30",
                    "disabled:pointer-events-none disabled:opacity-40",
                    isConnectingThis && "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                )}
                onClick={onConnect}
                disabled={isConnecting}
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
