"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/tauri-runtime";
import type { InstallProgress, LocalPostgresStatus } from "@/lib/types";
import {
    localPostgresCheck,
    localPostgresInstall,
    localPostgresRestart,
    localPostgresStart,
    localPostgresStop,
} from "@/lib/tauri";
import { useConnectionStore } from "@/stores/connection-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Download,
    Loader2,
    Monitor,
    Play,
    Power,
    PowerOff,
    RefreshCw,
    RotateCcw,
    Zap,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

type CardPhase =
    | { kind: "checking" }
    | { kind: "not_installed"; installMethod: string | null }
    | { kind: "stopped"; status: LocalPostgresStatus }
    | { kind: "running"; status: LocalPostgresStatus }
    | { kind: "installing"; progress: number; message: string; log: string }
    | { kind: "managing"; action: "starting" | "stopping" | "restarting" }
    | { kind: "error"; message: string; status?: LocalPostgresStatus };

// ── Component ──────────────────────────────────────────────────────────────

function LocalPostgresWebBanner() {
    return (
        <div className="rounded-xl border border-border/50 bg-card/80 p-4 shadow-sm">
            <div className="flex items-start gap-3">
                <Monitor className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">Local PostgreSQL</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        Bundled local Postgres controls are available in the{" "}
                        <span className="text-foreground font-medium">desktop app</span> only. In the
                        browser, connect with your URI and run the{" "}
                        <span className="text-foreground font-medium">Helix data plane</span> (
                        <code className="text-[10px] bg-muted px-1 rounded">make data-plane</code> defaults to{" "}
                        <code className="text-[10px] bg-muted px-1 rounded">127.0.0.1:9847</code>).
                    </p>
                </div>
            </div>
        </div>
    );
}

function LocalPostgresCardDesktop() {
    const { connect, isConnecting } = useConnectionStore();
    const [phase, setPhase] = useState<CardPhase>({ kind: "checking" });
    const [showLog, setShowLog] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [isAutoConnecting, setIsAutoConnecting] = useState(false);
    const unlistenRef = useRef<(() => void) | null>(null);

    const check = async () => {
        setPhase({ kind: "checking" });
        try {
            const s = await localPostgresCheck();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: String(e) });
        }
    };

    const applyStatus = (s: LocalPostgresStatus) => {
        if (!s.installed) {
            setPhase({ kind: "not_installed", installMethod: s.install_method });
        } else if (s.running) {
            setPhase({ kind: "running", status: s });
        } else {
            setPhase({ kind: "stopped", status: s });
        }
    };

    useEffect(() => {
        check();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Cleanup event listener on unmount
    useEffect(() => {
        return () => {
            unlistenRef.current?.();
        };
    }, []);

    const handleInstall = async () => {
        setShowLog(false);
        setPhase({ kind: "installing", progress: 0, message: "Starting installation...", log: "" });

        // Listen for progress events
        const unlisten = await listen<InstallProgress>(
            "local-postgres-install-progress",
            (event) => {
                setPhase((prev) => {
                    if (prev.kind !== "installing") return prev;
                    return {
                        kind: "installing",
                        progress: event.payload.percent,
                        message: event.payload.message,
                        log: prev.log + (event.payload.log ? `\n${event.payload.log}` : ""),
                    };
                });
            }
        );
        unlistenRef.current = unlisten;

        try {
            const s = await localPostgresInstall();
            unlisten();
            unlistenRef.current = null;
            applyStatus(s);
        } catch (e) {
            unlisten();
            unlistenRef.current = null;
            setPhase({ kind: "error", message: String(e) });
        }
    };

    const handleStart = async () => {
        setPhase({ kind: "managing", action: "starting" });
        try {
            const s = await localPostgresStart();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: String(e) });
        }
    };

    const handleStop = async () => {
        setPhase({ kind: "managing", action: "stopping" });
        try {
            const s = await localPostgresStop();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: String(e) });
        }
    };

    const handleRestart = async () => {
        setPhase({ kind: "managing", action: "restarting" });
        try {
            const s = await localPostgresRestart();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: String(e) });
        }
    };

    const handleConnect = async (connString: string) => {
        setConnectError(null);
        setIsAutoConnecting(true);
        try {
            await connect(connString);
        } catch (e) {
            setConnectError(String(e));
        } finally {
            setIsAutoConnecting(false);
        }
    };

    const installLabel = (method: string | null) => {
        if (method === "brew") return "Install via Homebrew";
        if (method === "apt") return "Install via apt";
        if (method === "dnf" || method === "yum") return "Install via dnf";
        return "Install PostgreSQL";
    };

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <div
            className={cn(
                "rounded-xl border bg-card/30 p-4 transition-all",
                phase.kind === "running"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : phase.kind === "error"
                        ? "border-red-500/30 bg-red-500/5"
                        : "border-border/30"
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div
                        className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-lg",
                            phase.kind === "running"
                                ? "bg-emerald-500/15"
                                : phase.kind === "error"
                                    ? "bg-red-500/15"
                                    : "bg-muted/40"
                        )}
                    >
                        <Monitor
                            className={cn(
                                "h-3.5 w-3.5",
                                phase.kind === "running"
                                    ? "text-emerald-400"
                                    : phase.kind === "error"
                                        ? "text-red-400"
                                        : "text-muted-foreground/60"
                            )}
                        />
                    </div>
                    <div>
                        <p className="text-sm font-semibold text-foreground/90">
                            Local PostgreSQL
                        </p>
                        <p className="text-[10px] text-muted-foreground/50 leading-none mt-0.5">
                            {phase.kind === "checking" && "Detecting…"}
                            {phase.kind === "not_installed" && "Not installed"}
                            {phase.kind === "stopped" && (
                                phase.status.version
                                    ? `Installed · ${phase.status.version.replace("psql (", "").replace(")", "")}`
                                    : "Installed · Stopped"
                            )}
                            {phase.kind === "running" && (
                                phase.status.version
                                    ? `${phase.status.version.replace("psql (", "").replace(")", "")} · localhost:${phase.status.port}`
                                    : `Running · localhost:${phase.status.port}`
                            )}
                            {phase.kind === "installing" && "Installing…"}
                            {phase.kind === "managing" && `${phase.action.charAt(0).toUpperCase() + phase.action.slice(1)}…`}
                            {phase.kind === "error" && "Error"}
                        </p>
                    </div>
                </div>

                {/* Status badge */}
                <StatusBadge phase={phase} />
            </div>

            {/* Body */}
            <div className="space-y-2">
                {phase.kind === "checking" && (
                    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground/60">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Detecting local PostgreSQL installation…
                    </div>
                )}

                {phase.kind === "not_installed" && (
                    <div className="space-y-2">
                        <p className="text-xs text-muted-foreground/60">
                            PostgreSQL is not installed on this machine.
                        </p>
                        {phase.installMethod === "windows" ? (
                            <Button
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs bg-blue-600/90 hover:bg-blue-500 text-white"
                                onClick={() =>
                                    window.open(
                                        "https://www.postgresql.org/download/windows/",
                                        "_blank"
                                    )
                                }
                            >
                                <Download className="h-3.5 w-3.5" />
                                Download PostgreSQL Installer
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                                onClick={handleInstall}
                            >
                                <Download className="h-3.5 w-3.5" />
                                {installLabel(phase.installMethod)}
                            </Button>
                        )}
                    </div>
                )}

                {phase.kind === "installing" && (
                    <div className="space-y-2">
                        {/* Progress bar */}
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                                <span>{phase.message}</span>
                                <span>{phase.progress}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 transition-all duration-500"
                                    style={{ width: `${phase.progress}%` }}
                                />
                            </div>
                        </div>

                        {/* Log toggle */}
                        {phase.log && (
                            <button
                                onClick={() => setShowLog((v) => !v)}
                                className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors"
                            >
                                {showLog ? (
                                    <ChevronUp className="h-3 w-3" />
                                ) : (
                                    <ChevronDown className="h-3 w-3" />
                                )}
                                {showLog ? "Hide" : "Show"} logs
                            </button>
                        )}

                        {showLog && phase.log && (
                            <pre className="max-h-28 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] font-mono text-muted-foreground/70 whitespace-pre-wrap">
                                {phase.log.trim()}
                            </pre>
                        )}
                    </div>
                )}

                {phase.kind === "stopped" && (
                    <div className="space-y-2">
                        <Button
                            size="sm"
                            className="w-full h-8 gap-1.5 text-xs bg-emerald-600/90 hover:bg-emerald-500 text-white"
                            onClick={handleStart}
                        >
                            <Play className="h-3.5 w-3.5" />
                            Start PostgreSQL
                        </Button>
                    </div>
                )}

                {phase.kind === "running" && (
                    <div className="space-y-2">
                        {connectError && (
                            <div className="flex items-start gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-2 text-[10px] text-red-400">
                                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                                <span>{connectError}</span>
                            </div>
                        )}

                        <Button
                            size="sm"
                            className="w-full h-8 gap-1.5 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                            onClick={() =>
                                handleConnect(
                                    phase.status.connection_string ?? "postgresql://localhost:5432/postgres"
                                )
                            }
                            disabled={isAutoConnecting || isConnecting}
                        >
                            {isAutoConnecting || isConnecting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Zap className="h-3.5 w-3.5" />
                            )}
                            Connect to Local DB
                        </Button>

                        {/* Service controls */}
                        <div className="flex gap-1.5">
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 h-7 gap-1 text-[10px] border-border/30 text-muted-foreground hover:text-foreground"
                                onClick={handleStop}
                            >
                                <PowerOff className="h-3 w-3" />
                                Stop
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 h-7 gap-1 text-[10px] border-border/30 text-muted-foreground hover:text-foreground"
                                onClick={handleRestart}
                            >
                                <RotateCcw className="h-3 w-3" />
                                Restart
                            </Button>
                        </div>
                    </div>
                )}

                {phase.kind === "managing" && (
                    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground/60">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {phase.action === "starting" && "Starting PostgreSQL…"}
                        {phase.action === "stopping" && "Stopping PostgreSQL…"}
                        {phase.action === "restarting" && "Restarting PostgreSQL…"}
                    </div>
                )}

                {phase.kind === "error" && (
                    <div className="space-y-2">
                        <div className="flex items-start gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-2 text-[10px] text-red-400">
                            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                            <span className="break-all">{phase.message}</span>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-7 gap-1.5 text-[10px] border-border/30"
                            onClick={check}
                        >
                            <RefreshCw className="h-3 w-3" />
                            Retry Detection
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Status Badge ───────────────────────────────────────────────────────────

function StatusBadge({ phase }: { phase: CardPhase }) {
    if (phase.kind === "checking" || phase.kind === "managing") {
        return (
            <span className="flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground/60">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {phase.kind === "managing" ? phase.action : "Checking"}
            </span>
        );
    }
    if (phase.kind === "not_installed") {
        return (
            <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground/50">
                Not installed
            </span>
        );
    }
    if (phase.kind === "installing") {
        return (
            <span className="flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-400">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Installing
            </span>
        );
    }
    if (phase.kind === "running") {
        return (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Running
            </span>
        );
    }
    if (phase.kind === "stopped") {
        return (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
                <Power className="h-2.5 w-2.5" />
                Stopped
            </span>
        );
    }
    if (phase.kind === "error") {
        return (
            <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400">
                <AlertCircle className="h-2.5 w-2.5" />
                Error
            </span>
        );
    }
    return null;
}

export function LocalPostgresCard() {
    if (!isTauri()) {
        return <LocalPostgresWebBanner />;
    }
    return <LocalPostgresCardDesktop />;
}
