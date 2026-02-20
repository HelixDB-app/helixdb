"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useConnectionStore, parseConnectionError } from "@/stores/connection-store";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
    Database,
    Loader2,
    Plug,
    AlertCircle,
    Zap,
    CheckCircle2,
    Eye,
    EyeOff,
    ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ConnectionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type ConnectionMode = "uri" | "fields";

const RECENT_CONNECTIONS_KEY = "helixdb_recent_connections";
const MAX_RECENT = 5;

function getRecentConnections(): string[] {
    try {
        const stored = localStorage.getItem(RECENT_CONNECTIONS_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function saveRecentConnection(uri: string) {
    try {
        const recent = getRecentConnections().filter((c) => c !== uri);
        recent.unshift(uri);
        localStorage.setItem(
            RECENT_CONNECTIONS_KEY,
            JSON.stringify(recent.slice(0, MAX_RECENT))
        );
    } catch {}
}

function maskUri(uri: string): string {
    try {
        const url = new URL(uri);
        if (url.password) {
            url.password = "••••••";
        }
        return url.toString();
    } catch {
        return uri;
    }
}

export function ConnectionDialog({ open, onOpenChange }: ConnectionDialogProps) {
    const {
        connectionString,
        connect,
        isConnecting,
        connectionError,
        isConnected,
        databaseName,
        serverVersion,
        clearError,
    } = useConnectionStore();

    const [mode, setMode] = useState<ConnectionMode>("uri");
    const [uriValue, setUriValue] = useState(
        connectionString || "postgres://user:password@localhost:5432/database"
    );
    const [host, setHost] = useState("localhost");
    const [port, setPort] = useState("5432");
    const [database, setDatabase] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showRecent, setShowRecent] = useState(false);
    const [recentConnections, setRecentConnections] = useState<string[]>([]);
    const [justConnected, setJustConnected] = useState(false);

    const wasConnecting = useRef(false);

    // Load recent connections on open
    useEffect(() => {
        if (open) {
            setRecentConnections(getRecentConnections());
            clearError();
        }
    }, [open, clearError]);

    // Auto-close after successful connection
    useEffect(() => {
        if (wasConnecting.current && !isConnecting && isConnected) {
            setJustConnected(true);
            const timer = setTimeout(() => {
                onOpenChange(false);
                setJustConnected(false);
            }, 700);
            return () => clearTimeout(timer);
        }
        wasConnecting.current = isConnecting;
    }, [isConnecting, isConnected, onOpenChange]);

    // Compute URI from fields
    const computedUri = useMemo(() => {
        if (!username || !host || !database) return "";
        const passStr = password ? `:${encodeURIComponent(password)}` : "";
        return `postgres://${encodeURIComponent(username)}${passStr}@${host}:${port}/${encodeURIComponent(database)}`;
    }, [host, port, database, username, password]);

    // Parse fields from URI when switching to fields mode
    const switchToFields = () => {
        try {
            const url = new URL(uriValue);
            setHost(url.hostname || "localhost");
            setPort(url.port || "5432");
            setDatabase(decodeURIComponent(url.pathname.slice(1)) || "");
            setUsername(decodeURIComponent(url.username) || "");
            setPassword(url.password ? decodeURIComponent(url.password) : "");
        } catch {}
        setMode("fields");
    };

    const getConnectionString = () => {
        return mode === "uri" ? uriValue : computedUri;
    };

    const handleConnect = async () => {
        const cs = getConnectionString();
        if (!cs.trim()) return;
        await connect(cs);
        if (!connectionError) {
            saveRecentConnection(cs);
            setRecentConnections(getRecentConnections());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isConnecting) {
            handleConnect();
        }
    };

    const handleUseRecent = (uri: string) => {
        setUriValue(uri);
        setMode("uri");
        setShowRecent(false);
    };

    const isValid = getConnectionString().trim().length > 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md border-border/50 bg-card shadow-2xl p-0 overflow-hidden">
                {/* Header */}
                <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/30">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 shadow-md shadow-emerald-500/20 shrink-0">
                            <Database className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div>
                            <DialogTitle className="text-base font-semibold">
                                Connect to PostgreSQL
                            </DialogTitle>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Enter your connection details to get started
                            </p>
                        </div>
                    </div>
                </DialogHeader>

                <div className="px-6 py-4 space-y-4">
                    {/* Connection mode toggle */}
                    <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
                        <button
                            onClick={() => setMode("uri")}
                            className={cn(
                                "flex-1 rounded-md py-1.5 text-xs font-medium transition-all",
                                mode === "uri"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            Connection URI
                        </button>
                        <button
                            onClick={switchToFields}
                            className={cn(
                                "flex-1 rounded-md py-1.5 text-xs font-medium transition-all",
                                mode === "fields"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            Connection Fields
                        </button>
                    </div>

                    {/* Success state */}
                    {(justConnected || (isConnected && !isConnecting)) && isConnected && (
                        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-3 border border-emerald-500/20">
                            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-emerald-400">
                                    Connected to{" "}
                                    <span className="font-mono">{databaseName}</span>
                                </p>
                            </div>
                            <Badge
                                variant="outline"
                                className="text-[10px] font-mono border-emerald-500/30 text-emerald-400 shrink-0"
                            >
                                {serverVersion.split(" ").slice(0, 2).join(" ")}
                            </Badge>
                        </div>
                    )}

                    {/* URI mode */}
                    {mode === "uri" && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    Connection String
                                </label>
                                {recentConnections.length > 0 && (
                                    <button
                                        onClick={() => setShowRecent(!showRecent)}
                                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        Recent
                                        <ChevronDown
                                            className={cn(
                                                "h-3 w-3 transition-transform",
                                                showRecent && "rotate-180"
                                            )}
                                        />
                                    </button>
                                )}
                            </div>

                            {showRecent && recentConnections.length > 0 && (
                                <div className="rounded-lg border border-border/40 bg-background/50 overflow-hidden">
                                    {recentConnections.map((uri, i) => (
                                        <button
                                            key={i}
                                            onClick={() => handleUseRecent(uri)}
                                            className="w-full flex items-center px-3 py-2 text-xs text-left hover:bg-accent/50 transition-colors border-b border-border/20 last:border-0 font-mono text-muted-foreground hover:text-foreground truncate"
                                        >
                                            {maskUri(uri)}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <Input
                                value={uriValue}
                                onChange={(e) => setUriValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="postgres://user:password@host:5432/dbname"
                                className="font-mono text-xs h-10 bg-background/50 border-border/50 focus:border-emerald-500/50 transition-colors"
                                disabled={isConnecting}
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>
                    )}

                    {/* Fields mode */}
                    {mode === "fields" && (
                        <div className="space-y-3">
                            <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-2 space-y-1.5">
                                    <label className="text-xs text-muted-foreground">Host</label>
                                    <Input
                                        value={host}
                                        onChange={(e) => setHost(e.target.value)}
                                        placeholder="localhost"
                                        className="h-9 text-sm bg-background/50 border-border/50 focus:border-emerald-500/50"
                                        disabled={isConnecting}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs text-muted-foreground">Port</label>
                                    <Input
                                        value={port}
                                        onChange={(e) => setPort(e.target.value)}
                                        placeholder="5432"
                                        className="h-9 text-sm bg-background/50 border-border/50 focus:border-emerald-500/50"
                                        disabled={isConnecting}
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-xs text-muted-foreground">Database</label>
                                <Input
                                    value={database}
                                    onChange={(e) => setDatabase(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="database_name"
                                    className="h-9 text-sm bg-background/50 border-border/50 focus:border-emerald-500/50"
                                    disabled={isConnecting}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1.5">
                                    <label className="text-xs text-muted-foreground">Username</label>
                                    <Input
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value)}
                                        placeholder="postgres"
                                        className="h-9 text-sm bg-background/50 border-border/50 focus:border-emerald-500/50"
                                        disabled={isConnecting}
                                        autoComplete="off"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs text-muted-foreground">Password</label>
                                    <div className="relative">
                                        <Input
                                            type={showPassword ? "text" : "password"}
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            onKeyDown={handleKeyDown}
                                            placeholder="••••••••"
                                            className="h-9 text-sm pr-9 bg-background/50 border-border/50 focus:border-emerald-500/50"
                                            disabled={isConnecting}
                                            autoComplete="off"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {showPassword ? (
                                                <EyeOff className="h-3.5 w-3.5" />
                                            ) : (
                                                <Eye className="h-3.5 w-3.5" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Preview URI */}
                            {computedUri && (
                                <div className="rounded-md bg-muted/30 px-3 py-2 border border-border/20">
                                    <p className="text-[10px] text-muted-foreground mb-1">
                                        Connection URI preview
                                    </p>
                                    <p className="text-[10px] font-mono text-muted-foreground/70 break-all">
                                        {maskUri(computedUri)}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Error display */}
                    {connectionError && !justConnected && (
                        <div className="flex items-start gap-2.5 rounded-lg bg-destructive/10 px-4 py-3 border border-destructive/20">
                            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                            <p className="text-sm text-destructive leading-relaxed">
                                {connectionError}
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 pb-6 pt-2 space-y-3">
                    <Button
                        onClick={handleConnect}
                        disabled={isConnecting || !isValid}
                        className="w-full h-10 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-lg shadow-emerald-600/20 transition-all duration-200 font-medium"
                    >
                        {isConnecting ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Connecting...
                            </>
                        ) : justConnected ? (
                            <>
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                Connected!
                            </>
                        ) : isConnected ? (
                            <>
                                <Zap className="mr-2 h-4 w-4" />
                                Reconnect
                            </>
                        ) : (
                            <>
                                <Plug className="mr-2 h-4 w-4" />
                                Connect
                            </>
                        )}
                    </Button>

                    <Separator className="opacity-30" />

                    <p className="text-[11px] text-muted-foreground/50 text-center">
                        Press{" "}
                        <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
                            Enter
                        </kbd>{" "}
                        to connect quickly
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
