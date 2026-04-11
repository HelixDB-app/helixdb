"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/tauri-runtime";
import type { InstallProgress, LocalPostgresStatus } from "@/lib/types";
import {
    authOpenBrowser,
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
    BookOpen,
    ChevronDown,
    ChevronUp,
    Download,
    ExternalLink,
    Loader2,
    Monitor,
    Play,
    Power,
    PowerOff,
    RefreshCw,
    RotateCcw,
    Zap,
} from "lucide-react";

const URL_PG_DOWNLOAD = "https://www.postgresql.org/download/";
const URL_PG_MACOS = "https://www.postgresql.org/download/macosx/";
const URL_HOMEBREW = "https://brew.sh";
const URL_POSTGRESAPP = "https://postgresapp.com/";

function formatTauriError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
        return (e as { message: string }).message;
    }
    return String(e);
}

/** When status is unknown (e.g. check never succeeded), do not offer automatic install. */
function effectiveAutoInstallSupported(s: LocalPostgresStatus | null | undefined): boolean {
    if (s == null) return false;
    return s.auto_install_supported ?? true;
}

// ── Types ──────────────────────────────────────────────────────────────────

type CardPhase =
    | { kind: "checking" }
    | { kind: "not_installed"; installMethod: string | null; autoInstallSupported: boolean }
    | { kind: "stopped"; status: LocalPostgresStatus }
    | { kind: "running"; status: LocalPostgresStatus }
    | { kind: "installing"; progress: number; message: string; log: string }
    | { kind: "managing"; action: "starting" | "stopping" | "restarting" }
    | { kind: "error"; message: string; status?: LocalPostgresStatus; recover?: "install" | "check" };

// ── Component ──────────────────────────────────────────────────────────────

/** Same markup on server and first client paint — avoids hydration mismatch (isTauri() is false during SSR). */
function LocalPostgresCardHydrationFallback() {
    return (
        <div className="rounded-xl border border-border/30 bg-card/30 p-4 transition-all">
            <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                <span>Preparing local PostgreSQL…</span>
            </div>
        </div>
    );
}

function PostgresInstallGuide({ defaultOpen }: { defaultOpen: boolean }) {
    const [open, setOpen] = useState(defaultOpen);

    useEffect(() => {
        if (defaultOpen) setOpen(true);
    }, [defaultOpen]);

    return (
        <div className="rounded-lg border border-border/40 bg-muted/15 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-medium text-foreground/85 hover:bg-muted/30 transition-colors"
            >
                <span className="flex items-center gap-1.5">
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    PostgreSQL setup guide
                </span>
                <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                    aria-hidden
                />
            </button>
            {open && (
                <div className="space-y-3 border-t border-border/30 px-3 py-2.5 text-[11px] text-muted-foreground leading-relaxed">
                    <div>
                        <p className="mb-1 font-semibold text-foreground/90">macOS</p>
                        <ol className="list-decimal space-y-1.5 pl-4">
                            <li>
                                Download an installer from the official PostgreSQL site (or use Postgres.app).
                            </li>
                            <li>Run the installer and complete the setup wizard (default port is usually 5432).</li>
                            <li>Start PostgreSQL if the installer does not start it automatically.</li>
                            <li>Return here and tap <span className="text-foreground/80">Check again</span> so pgStudio can detect your server.</li>
                        </ol>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[10px]"
                                onClick={() => void authOpenBrowser(URL_PG_MACOS)}
                            >
                                <ExternalLink className="h-3 w-3" />
                                PostgreSQL.org (macOS)
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[10px]"
                                onClick={() => void authOpenBrowser(URL_POSTGRESAPP)}
                            >
                                <ExternalLink className="h-3 w-3" />
                                Postgres.app
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 text-[10px]"
                                onClick={() => void authOpenBrowser(URL_HOMEBREW)}
                            >
                                <ExternalLink className="h-3 w-3" />
                                Homebrew
                            </Button>
                        </div>
                    </div>
                    <div>
                        <p className="mb-1 font-semibold text-foreground/90">Linux</p>
                        <p className="mb-1">Example on Debian/Ubuntu:</p>
                        <pre className="rounded-md bg-black/35 px-2 py-1.5 font-mono text-[10px] text-muted-foreground/90 whitespace-pre-wrap">
                            sudo apt update{"\n"}
                            sudo apt install -y postgresql postgresql-contrib{"\n"}
                            sudo systemctl start postgresql
                        </pre>
                    </div>
                    <div>
                        <p className="mb-1 font-semibold text-foreground/90">Windows</p>
                        <p>Use the official installer from postgresql.org, then create a database user if prompted.</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 h-7 gap-1 text-[10px]"
                            onClick={() => void authOpenBrowser("https://www.postgresql.org/download/windows/")}
                        >
                            <ExternalLink className="h-3 w-3" />
                            Windows downloads
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

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
    const [guideDefaultOpen, setGuideDefaultOpen] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [isAutoConnecting, setIsAutoConnecting] = useState(false);
    const unlistenRef = useRef<(() => void) | null>(null);
    const lastStatusRef = useRef<LocalPostgresStatus | null>(null);

    const check = async () => {
        setPhase({ kind: "checking" });
        try {
            const s = await localPostgresCheck();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: formatTauriError(e), recover: "check" });
        }
    };

    const applyStatus = (s: LocalPostgresStatus) => {
        lastStatusRef.current = s;
        if (!s.installed) {
            setPhase({
                kind: "not_installed",
                installMethod: s.install_method,
                autoInstallSupported: effectiveAutoInstallSupported(s),
            });
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
        if (!effectiveAutoInstallSupported(lastStatusRef.current)) {
            setGuideDefaultOpen(true);
            setPhase({
                kind: "error",
                message:
                    "Automatic installation is not available in this build. Use the guide below or the official PostgreSQL download page, then tap Check again.",
                recover: "check",
            });
            return;
        }

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
            setGuideDefaultOpen(true);
            setPhase({ kind: "error", message: formatTauriError(e), recover: "install" });
        }
    };

    const handleStart = async () => {
        setPhase({ kind: "managing", action: "starting" });
        try {
            const s = await localPostgresStart();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: formatTauriError(e), recover: "check" });
        }
    };

    const handleStop = async () => {
        setPhase({ kind: "managing", action: "stopping" });
        try {
            const s = await localPostgresStop();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: formatTauriError(e), recover: "check" });
        }
    };

    const handleRestart = async () => {
        setPhase({ kind: "managing", action: "restarting" });
        try {
            const s = await localPostgresRestart();
            applyStatus(s);
        } catch (e) {
            setPhase({ kind: "error", message: formatTauriError(e), recover: "check" });
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
        if (method === "manual") return "Install PostgreSQL";
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
                        <p className="text-xs text-muted-foreground/70 leading-relaxed">
                            {phase.installMethod === "windows" ? (
                                <>PostgreSQL is not installed. Use the official Windows installer, then return here.</>
                            ) : phase.autoInstallSupported ? (
                                <>
                                    PostgreSQL is not installed. You can install it automatically (requires Homebrew on
                                    macOS, or apt/dnf on Linux), or follow the guide for a manual setup.
                                </>
                            ) : (
                                <>
                                    PostgreSQL is not installed. This App Store build cannot run system installers for
                                    you — use the official download or the guide, then tap{" "}
                                    <span className="text-foreground/80 font-medium">Check again</span>.
                                </>
                            )}
                        </p>
                        {phase.installMethod === "windows" ? (
                            <Button
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs bg-blue-600/90 hover:bg-blue-500 text-white"
                                onClick={() => void authOpenBrowser("https://www.postgresql.org/download/windows/")}
                            >
                                <Download className="h-3.5 w-3.5" />
                                Download PostgreSQL Installer
                            </Button>
                        ) : phase.autoInstallSupported ? (
                            <Button
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                                onClick={() => void handleInstall()}
                            >
                                <Download className="h-3.5 w-3.5" />
                                {installLabel(phase.installMethod)}
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white"
                                onClick={() => void authOpenBrowser(URL_PG_MACOS)}
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open official PostgreSQL for macOS
                            </Button>
                        )}
                        <PostgresInstallGuide defaultOpen={!phase.autoInstallSupported} />
                        {phase.autoInstallSupported && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="w-full h-7 text-[10px] text-muted-foreground hover:text-foreground"
                                onClick={() => void authOpenBrowser(URL_PG_DOWNLOAD)}
                            >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                Browse all PostgreSQL downloads
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
                        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-2 text-[10px] text-red-400">
                            <div className="flex items-start gap-1.5">
                                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
                                <div className="min-w-0 space-y-1">
                                    <p className="font-semibold text-red-300/95">
                                        {phase.recover === "install"
                                            ? "Installation could not finish"
                                            : "Something went wrong"}
                                    </p>
                                    <p className="whitespace-pre-wrap break-words text-red-400/95 leading-relaxed">
                                        {phase.message}
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            {phase.recover === "install" && effectiveAutoInstallSupported(lastStatusRef.current) && (
                                    <Button
                                        variant="default"
                                        size="sm"
                                        className="w-full h-8 gap-1.5 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                                        onClick={() => void handleInstall()}
                                    >
                                        <RefreshCw className="h-3.5 w-3.5" />
                                        Try installing again
                                    </Button>
                                )}
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full h-8 gap-1.5 text-xs border-border/40"
                                onClick={() => void authOpenBrowser(URL_PG_DOWNLOAD)}
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open official download page
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full h-7 gap-1.5 text-[10px] border-border/30"
                                onClick={check}
                            >
                                <RefreshCw className="h-3 w-3" />
                                Check again
                            </Button>
                        </div>
                        <PostgresInstallGuide defaultOpen={guideDefaultOpen} />
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
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <LocalPostgresCardHydrationFallback />;
    }
    if (!isTauri()) {
        return <LocalPostgresWebBanner />;
    }
    return <LocalPostgresCardDesktop />;
}
