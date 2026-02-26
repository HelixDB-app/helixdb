"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { APP_NAME } from "@/lib/app-config";
import { LandingConnections } from "@/components/landing-connections";
import { WelcomeScreen } from "@/components/welcome-screen";
import { ConnectionDialog } from "@/components/connection-dialog";
import { Sidebar } from "@/components/sidebar";
import { DataTable } from "@/components/data-table";
import { QueryEditor } from "@/components/query-editor";
import { SessionMonitor } from "@/components/session-monitor";
import { IndexBuilder } from "@/components/index-builder";
import { SchemaTopology } from "@/components/schema-topology";
import { AIChatPanel } from "@/components/ai-chat-panel";
import { StatusBar } from "@/components/status-bar";
import { CommandPalette } from "@/components/command-palette";
import { SettingsDialog } from "@/components/settings-dialog";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    Activity,
    Layers,
    Network,
    PlugZap,
    RefreshCw,
    Clock3,
    Search,
    Settings,
    Bug,
    Sparkles,
    Table2,
    Terminal,
    Unplug,
} from "lucide-react";

export default function Home() {
    const {
        isConnected,
        disconnect,
        databaseName,
        serverVersion,
        selectTable,
        refreshAll,
        isRefreshingAll,
    } = useConnectionStore();
    const [showConnectionDialog, setShowConnectionDialog] = useState(false);
    const [activeView, setActiveView] = useState<"data" | "query" | "sessions" | "indexes" | "topology" | "ai">("data");
    const [searchOpen, setSearchOpen] = useState(false);
    const [showWelcome, setShowWelcome] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || localStorage.getItem("helix_welcomed")) return;
        const rafId = window.requestAnimationFrame(() => setShowWelcome(true));
        return () => window.cancelAnimationFrame(rafId);
    }, []);

    const handleWelcomeDismiss = () => {
        localStorage.setItem("helix_welcomed", "1");
        setShowWelcome(false);
    };

    // Global ⌘K / Ctrl+K shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    // Global ⌘, / Ctrl+, shortcut for settings
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === ",") {
                e.preventDefault();
                setSettingsOpen(true);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    // Global ⌘⇧R / Ctrl+Shift+R — refresh all (schemas, databases, current table)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "r") {
                e.preventDefault();
                if (isConnected) refreshAll();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isConnected, refreshAll]);

    // Global ⌘J / Ctrl+J — switch to AI tab
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "j") {
                e.preventDefault();
                if (isConnected) setActiveView("ai");
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isConnected]);

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";

    // Landing: saved connections list + quick connect
    if (!isConnected) {
        return (
            <>
                {showWelcome && <WelcomeScreen onDismiss={handleWelcomeDismiss} />}
                <LandingConnections />
            </>
        );
    }

    return (
        <div className="flex h-screen flex-col bg-background">
            {/* Top bar */}
            <header className="flex h-11 items-center justify-between border-b border-border/20 bg-card/20 px-3 shrink-0">
                {/* Left: Logo + DB name */}
                <div className="flex items-center gap-2.5">
                    <button
                        onClick={() => !isConnected && setShowConnectionDialog(true)}
                        className="flex items-center gap-2 group"
                    >
                        <img src="/logo.png" alt="" className="h-6 w-6 rounded-md object-contain shrink-0" />
                        <span className="font-bold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            {APP_NAME}
                        </span>
                    </button>

                    {isConnected && (
                        <>
                            <div className="h-4 w-px bg-border/40" />
                            <div className="flex items-center gap-1.5">
                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-xs font-mono text-muted-foreground/80">
                                    {databaseName}
                                </span>
                                {pgVersion && (
                                    <Badge
                                        variant="outline"
                                        className="h-4 px-1 text-[9px] font-mono border-border/30 text-muted-foreground/50"
                                    >
                                        PG {pgVersion}
                                    </Badge>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Right: View tabs + actions */}
                <div className="flex items-center gap-1.5">
                    {/* Refresh */}
                    {isConnected && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40 transition-all"
                                    onClick={() => refreshAll()}
                                    disabled={isRefreshingAll}
                                >
                                    <RefreshCw
                                        className={cn("h-3 w-3", isRefreshingAll && "animate-spin")}
                                    />
                                    <span className="hidden sm:inline">
                                        {isRefreshingAll ? "Refreshing…" : "Refresh"}
                                    </span>
                                    <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40 ml-0.5">
                                        ⌘⇧R
                                    </kbd>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Refresh current table and metadata (⌘⇧R)
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {/* Search button */}
                    {isConnected && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40 transition-all"
                                    onClick={() => setSearchOpen(true)}
                                >
                                    <Search className="h-3 w-3" />
                                    <span className="hidden sm:inline">Search</span>
                                    <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40 ml-0.5">
                                        ⌘K
                                    </kbd>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Search tables, columns, run SQL (⌘K)
                            </TooltipContent>
                        </Tooltip>
                    )}

                    {isConnected && (
                        <div className="flex items-center rounded-md bg-muted/40 p-0.5">
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "data"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("data")}
                            >
                                <Table2 className="h-3 w-3" />
                                Data
                            </button>
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "query"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("query")}
                            >
                                <Terminal className="h-3 w-3" />
                                Query
                            </button>
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "sessions"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("sessions")}
                            >
                                <Activity className="h-3 w-3" />
                                Sessions
                            </button>
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "indexes"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("indexes")}
                            >
                                <Layers className="h-3 w-3" />
                                Indexes
                            </button>
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "topology"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("topology")}
                            >
                                <Network className="h-3 w-3" />
                                Topology
                            </button>
                            <button
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${activeView === "ai"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setActiveView("ai")}
                            >
                                <Sparkles className="h-3 w-3" />
                                AI
                            </button>
                        </div>
                    )}

                    {isConnected ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 gap-1.5 text-muted-foreground hover:text-foreground text-xs"
                                    onClick={() => disconnect()}
                                >
                                    <Unplug className="h-3.5 w-3.5" />
                                    Disconnect
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Disconnect from database</TooltipContent>
                        </Tooltip>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => setShowConnectionDialog(true)}
                                >
                                    <PlugZap className="h-4 w-4 text-emerald-400" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Connect to database</TooltipContent>
                        </Tooltip>
                    )}

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40 transition-all"
                            >
                                <Link href="/query-history">
                                    <Clock3 className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">Query History</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Open Query History & Performance Intelligence</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40 transition-all"
                            >
                                <Link href="/bug-report">
                                    <Bug className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">Report Bug</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Submit feedback and bug reports</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
                                onClick={() => setSettingsOpen(true)}
                            >
                                <Settings className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Settings (⌘,)</TooltipContent>
                    </Tooltip>
                </div>
            </header>

            {/* Main content */}
            <div className="flex-1 overflow-hidden">
                {isConnected ? (
                    <ResizablePanelGroup orientation="horizontal">
                        <ResizablePanel defaultSize={20} minSize={14} maxSize={300}>
                            <Sidebar
                                onSelectObject={() => setActiveView("data")}
                            />
                        </ResizablePanel>

                        <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors data-[resize-handle-active]:bg-emerald-500/60" />

                        <ResizablePanel defaultSize={80}>
                            <div className="h-full">
                                {activeView === "data" && <DataTable />}
                                {activeView === "query" && <QueryEditor />}
                                {activeView === "sessions" && <SessionMonitor />}
                                {activeView === "indexes" && <IndexBuilder />}
                                {activeView === "topology" && (
                                    <SchemaTopology onNavigateToTable={() => setActiveView("data")} />
                                )}
                                {activeView === "ai" && <AIChatPanel />}
                            </div>
                        </ResizablePanel>
                    </ResizablePanelGroup>
                ) : null}
            </div>

            <StatusBar />

            <ConnectionDialog
                open={showConnectionDialog}
                onOpenChange={setShowConnectionDialog}
            />

            <CommandPalette
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onNavigateToQuery={() => setActiveView("query")}
                onNavigateToTable={(schema, table) => {
                    setActiveView("data");
                    selectTable(schema, table);
                }}
            />

            <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </div>
    );
}
