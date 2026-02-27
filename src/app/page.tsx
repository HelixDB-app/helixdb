"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShortcutsStore } from "@/stores/shortcuts-store";
import { eventMatchesCombo, formatShortcut } from "@/lib/shortcut-keys";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    ShieldCheck,
    Bug,
    Sparkles,
    Table2,
    Terminal,
    Unplug,
} from "lucide-react";

export default function Home() {
    const router = useRouter();
    const {
        isConnected,
        connectionId,
        disconnect,
        databaseName,
        serverVersion,
        selectTable,
        refreshAll,
        isRefreshingAll,
    } = useConnectionStore();
    const getCombo = useShortcutsStore((s) => s.getCombo);
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

    // Global keyboard shortcuts (configurable via Settings → Shortcuts)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable) return;
            const actions: Array<{ id: string; combo: string }> = [
                { id: "search", combo: getCombo("search") },
                { id: "settings", combo: getCombo("settings") },
                { id: "refresh", combo: getCombo("refresh") },
                { id: "view_data", combo: getCombo("view_data") },
                { id: "view_query", combo: getCombo("view_query") },
                { id: "view_sessions", combo: getCombo("view_sessions") },
                { id: "view_indexes", combo: getCombo("view_indexes") },
                { id: "view_topology", combo: getCombo("view_topology") },
                { id: "view_ai", combo: getCombo("view_ai") },
                { id: "disconnect", combo: getCombo("disconnect") },
                { id: "query_history", combo: getCombo("query_history") },
                { id: "extensions", combo: getCombo("extensions") },
                { id: "bug_report", combo: getCombo("bug_report") },
                { id: "connect", combo: getCombo("connect") },
            ];
            for (const { id, combo } of actions) {
                if (!combo || !eventMatchesCombo(e, combo)) continue;
                e.preventDefault();
                e.stopPropagation();
                switch (id) {
                    case "search":
                        if (isConnected) setSearchOpen(true);
                        else setShowConnectionDialog(true);
                        break;
                    case "settings":
                        setSettingsOpen(true);
                        break;
                    case "refresh":
                        if (isConnected) refreshAll();
                        break;
                    case "view_data":
                        if (isConnected) setActiveView("data");
                        break;
                    case "view_query":
                        if (isConnected) setActiveView("query");
                        break;
                    case "view_sessions":
                        if (isConnected) setActiveView("sessions");
                        break;
                    case "view_indexes":
                        if (isConnected) setActiveView("indexes");
                        break;
                    case "view_topology":
                        if (isConnected) setActiveView("topology");
                        break;
                    case "view_ai":
                        if (isConnected) setActiveView("ai");
                        break;
                    case "disconnect":
                        if (isConnected && connectionId) disconnect(connectionId);
                        break;
                    case "query_history":
                        router.push("/query-history");
                        break;
                    case "extensions":
                        router.push("/extensions-management");
                        break;
                    case "bug_report":
                        router.push("/bug-report");
                        break;
                    case "connect":
                        if (!isConnected) setShowConnectionDialog(true);
                        break;
                    default:
                        break;
                }
                break;
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isConnected, connectionId, disconnect, refreshAll, getCombo, router]);

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";
    const sc = (id: Parameters<typeof getCombo>[0]) => formatShortcut(getCombo(id));

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
                        className="flex items-center gap-2 group focus-ring rounded-md"
                        aria-label={isConnected ? `${APP_NAME} home` : "Connect to database"}
                    >
                        <Image
                            src="/logo.png"
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded-md object-contain shrink-0"
                        />
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
                                    aria-label={isRefreshingAll ? "Refreshing" : "Refresh"}
                                >
                                    <RefreshCw
                                        className={cn("h-3 w-3", isRefreshingAll && "animate-spin")}
                                    />
                                    {/* <span className="hidden sm:inline">
                                        {isRefreshingAll ? "Refreshing…" : "Refresh"}
                                    </span>
                                    <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40 ml-0.5">
                                        ⌘⇧R
                                    </kbd> */}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Refresh current table and metadata{sc("refresh") && ` (${sc("refresh")})`}
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
                                    aria-label="Open search"
                                >
                                    <Search className="h-3 w-3" />
                                    <span className="hidden sm:inline">Search</span>
                                    {sc("search") && (
                                        <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40 ml-0.5">
                                            {sc("search")}
                                        </kbd>
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Search tables, columns, run SQL{sc("search") && ` (${sc("search")})`}
                            </TooltipContent>
                        </Tooltip>
                    )}

                    {isConnected && (
                        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as typeof activeView)}>
                            <TabsList aria-label="View tabs" className="h-8 rounded-md bg-muted/40 p-0.5">
                                <TabsTrigger value="data" title={sc("view_data") ? `Data (${sc("view_data")})` : "Data"}>
                                    <Table2 className="h-3 w-3" />
                                    Data
                                </TabsTrigger>
                                <TabsTrigger value="query" title={sc("view_query") ? `Query (${sc("view_query")})` : "Query"}>
                                    <Terminal className="h-3 w-3" />
                                    Query
                                </TabsTrigger>
                                <TabsTrigger value="sessions" title={sc("view_sessions") ? `Sessions (${sc("view_sessions")})` : "Sessions"}>
                                    <Activity className="h-3 w-3" />
                                    Sessions
                                </TabsTrigger>
                                <TabsTrigger value="indexes" title={sc("view_indexes") ? `Indexes (${sc("view_indexes")})` : "Indexes"}>
                                    <Layers className="h-3 w-3" />
                                    Indexes
                                </TabsTrigger>
                                <TabsTrigger value="topology" title={sc("view_topology") ? `Topology (${sc("view_topology")})` : "Topology"}>
                                    <Network className="h-3 w-3" />
                                    Topology
                                </TabsTrigger>
                                <TabsTrigger value="ai" title={sc("view_ai") ? `AI chat (${sc("view_ai")})` : "AI"}>
                                    <Sparkles className="h-3 w-3" />
                                    AI
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                    )}

                    {isConnected ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 gap-1.5 text-muted-foreground hover:text-foreground text-xs"
                                    onClick={() => connectionId && disconnect(connectionId)}
                                    aria-label="Disconnect from database"
                                >
                                    <Unplug className="h-3.5 w-3.5" />
                                    Disconnect
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Disconnect from database{sc("disconnect") && ` (${sc("disconnect")})`}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => setShowConnectionDialog(true)}
                                    aria-label="Connect to database"
                                >
                                    <PlugZap className="h-4 w-4 text-emerald-400" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Connect to database{sc("connect") && ` (${sc("connect")})`}
                            </TooltipContent>
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
                                    {/* <span className="hidden sm:inline">Query History</span> */}
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Open Query History & Performance Intelligence{sc("query_history") && ` (${sc("query_history")})`}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground/60 hover:text-foreground border border-border/20 hover:border-border/40 bg-muted/20 hover:bg-muted/40 transition-all"
                            >
                                <Link href="/extensions-management">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    {/* <span className="hidden sm:inline">Extensions</span> */}
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Open Extensions & User Management{sc("extensions") && ` (${sc("extensions")})`}
                        </TooltipContent>
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
                                        {/* <span className="hidden sm:inline">Report Bug</span> */}
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Submit feedback and bug reports{sc("bug_report") && ` (${sc("bug_report")})`}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
                                onClick={() => setSettingsOpen(true)}
                                aria-label="Open settings"
                            >
                                <Settings className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Settings{sc("settings") && ` (${sc("settings")})`}
                        </TooltipContent>
                    </Tooltip>
                </div>
            </header>

            {/* Main content */}
            <main id="main" className="flex-1 overflow-hidden" tabIndex={-1} aria-label="Main content">
                {isConnected ? (
                    <ResizablePanelGroup orientation="horizontal">
                        <ResizablePanel defaultSize={20} minSize={14} maxSize={300}>
                            <Sidebar
                                onSelectObject={() => setActiveView("data")}
                                onOpenConnectionDialog={() => setShowConnectionDialog(true)}
                            />
                        </ResizablePanel>

                        <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors data-[resize-handle-active]:bg-emerald-500/60" />

                        <ResizablePanel defaultSize={80}>
                            <div className="h-full" role="tabpanel" tabIndex={0} aria-label="Active view content">
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
            </main>

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
