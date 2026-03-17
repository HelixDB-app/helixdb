"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShortcutsStore } from "@/stores/shortcuts-store";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";
import { useCollaborationStore } from "@/stores/collaboration-store";
import { authFetchProfile, authGetToken } from "@/lib/tauri";
import { eventMatchesCombo, formatShortcut, isEditableTarget } from "@/lib/shortcut-keys";
import { APP_NAME } from "@/lib/app-config";
import { useLayoutStore } from "@/stores/layout-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import dynamic from "next/dynamic";
import { LandingConnections } from "@/components/landing-connections";
import { WelcomeScreen } from "@/components/welcome-screen";
import { TrialExpiredGate } from "@/components/trial-banner";
import { ConnectionDialog } from "@/components/connection-dialog";
import { StatusBar } from "@/components/status-bar";
import { CommandPalette } from "@/components/command-palette";
import { SettingsDialog } from "@/components/settings-dialog";
import { ProfilePanel } from "@/components/profile-panel";
import { LoginPrompt } from "@/components/login-prompt";
import { SurveyModal } from "@/components/survey-modal";
import { getSurveyStatus } from "@/lib/survey";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

// Heavy components loaded lazily to reduce initial bundle size
const Sidebar = dynamic(() => import("@/components/sidebar").then((m) => ({ default: m.Sidebar })), { ssr: false });
const TableLayoutView = dynamic(() => import("@/components/table-layout-view").then((m) => ({ default: m.TableLayoutView })), { ssr: false });
const QueryEditor = dynamic(() => import("@/components/query-editor").then((m) => ({ default: m.QueryEditor })), { ssr: false });
const SessionMonitor = dynamic(() => import("@/components/session-monitor").then((m) => ({ default: m.SessionMonitor })), { ssr: false });
const IndexBuilder = dynamic(() => import("@/components/index-builder").then((m) => ({ default: m.IndexBuilder })), { ssr: false });
const SchemaTopology = dynamic(() => import("@/components/schema-topology").then((m) => ({ default: m.SchemaTopology })), { ssr: false });
const SqlUnitTestRunner = dynamic(() => import("@/components/sql-unit-test-runner").then((m) => ({ default: m.SqlUnitTestRunner })), { ssr: false });
const AIChatPanel = dynamic(() => import("@/components/ai-chat-panel").then((m) => ({ default: m.AIChatPanel })), { ssr: false });
const GitPanel = dynamic(() => import("@/components/git-panel").then((m) => ({ default: m.GitPanel })), { ssr: false });
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
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { cn } from "@/lib/utils";
import {
    Activity,
    AppWindowMac,
    Layers,
    Network,
    PlugZap,
    RefreshCw,
    Clock3,
    GitCompare,
    GitBranch,
    Search,
    Settings,
    ShieldCheck,
    Bug,
    Sparkles,
    Table2,
    Terminal,
    Unplug,
    FlaskConical,
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
        connections,
        activeConnectionId,
    } = useConnectionStore();
    const { openTab } = useLayoutStore();
    const getCombo = useShortcutsStore((s) => s.getCombo);
    const { user, isAuthenticated, setUser, setLoading: setAuthLoading } = useAuthStore();
    const handleCollabDeepLink = useCollaborationStore((s) => s.handleDeepLinkUrl);
    const { result: trialResult, loadState: trialLoadState, isTrialActive } = useTrialStore();
    const trialExpired = !isAuthenticated
        && trialLoadState === "ready"
        && trialResult !== null
        && !isTrialActive();
    const [showConnectionDialog, setShowConnectionDialog] = useState(false);
    const [activeView, setActiveView] = useState<"data" | "query" | "tests" | "sessions" | "indexes" | "topology" | "ai" | "git">("data");
    const [searchOpen, setSearchOpen] = useState(false);
    const [showWelcome, setShowWelcome] = useState(false);
    const [showSurveyModal, setShowSurveyModal] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [showProfile, setShowProfile] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || localStorage.getItem("helix_welcomed")) return;
        const rafId = window.requestAnimationFrame(() => setShowWelcome(true));
        return () => window.cancelAnimationFrame(rafId);
    }, []);

    // Survey: after welcome is dismissed and user is logged in, check if survey is completed; if not, show modal after short delay
    useEffect(() => {
        if (showWelcome || !user) return;
        let cancelled = false;
        const timeoutId = setTimeout(() => {
            getSurveyStatus({ getToken: authGetToken }).then(({ completed }) => {
                if (!cancelled && !completed) setShowSurveyModal(true);
            });
        }, 500);
        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [user, showWelcome]);

    // Restore session on startup — try to load an existing cached profile from the keychain.
    // - null return means "not logged in" (normal, no error)
    // - thrown error means a transient network/parse issue — surface a subtle warning
    useEffect(() => {
        let cancelled = false;
        async function restoreSession() {
            setAuthLoading(true);
            try {
                const profile = await authFetchProfile();
                if (!cancelled) {
                    if (profile) setUser(profile);
                    // null just means the user hasn't logged in yet — this is normal
                }
            } catch (err) {
                // Only log; don't crash. The user can sign in manually.
                // This happens when the web server is unreachable or the token is corrupt.
                if (!cancelled) {
                    console.warn("[restoreSession] could not restore profile:", err);
                }
            } finally {
                if (!cancelled) setAuthLoading(false);
            }
        }
        restoreSession();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleWelcomeDismiss = () => {
        localStorage.setItem("helix_welcomed", "1");
        setShowWelcome(false);
    };

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        void (async () => {
            try {
                unlisten = await listen<string>("pgstudio-collab-join", (event) => {
                    handleCollabDeepLink(event.payload);
                    setActiveView("query");
                });
            } catch {
                // Ignore listener setup failures outside desktop runtime.
            }
        })();
        return () => {
            unlisten?.();
        };
    }, [handleCollabDeepLink]);

    // Global keyboard shortcuts (configurable via Settings → Shortcuts)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (isEditableTarget(e.target)) return;
            const actions: Array<{ id: string; combo: string }> = [
                { id: "search", combo: getCombo("search") },
                { id: "settings", combo: getCombo("settings") },
                { id: "refresh", combo: getCombo("refresh") },
                { id: "view_data", combo: getCombo("view_data") },
                { id: "view_query", combo: getCombo("view_query") },
                { id: "view_sessions", combo: getCombo("view_sessions") },
                { id: "view_indexes", combo: getCombo("view_indexes") },
                { id: "view_topology", combo: getCombo("view_topology") },
                { id: "view_git", combo: getCombo("view_git") },
                { id: "view_ai", combo: getCombo("view_ai") },
                { id: "disconnect", combo: getCombo("disconnect") },
                { id: "query_history", combo: getCombo("query_history") },
                { id: "extensions", combo: getCombo("extensions") },
                { id: "bug_report", combo: getCombo("bug_report") },
                { id: "connect", combo: getCombo("connect") },
                { id: "new_window", combo: getCombo("new_window") },
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
                    case "view_git":
                        if (isConnected) setActiveView("git");
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
                    case "new_window":
                        invoke("open_new_window");
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
    const activeConnectionEnvironment = useMemo(
        () => connections.find((entry) => entry.connectionId === activeConnectionId)?.environment,
        [connections, activeConnectionId]
    );
    const sc = (id: Parameters<typeof getCombo>[0]) => formatShortcut(getCombo(id));

    // Landing: saved connections list + quick connect
    if (!isConnected) {
        return (
            <>
                {/* Block access when trial has expired and user isn't logged in */}
                {trialExpired && <TrialExpiredGate />}
                {showWelcome && <WelcomeScreen onDismiss={handleWelcomeDismiss} />}
                <LandingConnections />
                {showSurveyModal && (
                    <SurveyModal
                        open={showSurveyModal}
                        onClose={() => setShowSurveyModal(false)}
                        onSubmitted={() => setShowSurveyModal(false)}
                        getToken={authGetToken}
                    />
                )}
            </>
        );
    }

    return (
        <div className="flex h-screen flex-col bg-background">
            {/* Block access when trial has expired and user isn't logged in */}
            {trialExpired && <TrialExpiredGate />}
            {showSurveyModal && (
                <SurveyModal
                    open={showSurveyModal}
                    onClose={() => setShowSurveyModal(false)}
                    onSubmitted={() => setShowSurveyModal(false)}
                    getToken={authGetToken}
                />
            )}
            {/* Top bar — 3-zone grid: left | center | right */}
            <header className="grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-border/30 bg-card/70 px-3 backdrop-blur-sm shrink-0">
                {/* Left: Logo + connection indicator */}
                <div className="flex items-center gap-2.5 min-w-0">
                    <button
                        onClick={() => !isConnected && setShowConnectionDialog(true)}
                        className="flex items-center gap-2 group focus-ring rounded-md shrink-0"
                        aria-label={isConnected ? `${APP_NAME} home` : "Connect to database"}
                    >
                        <Image
                            src="/logo.png"
                            alt=""
                            width={22}
                            height={22}
                            className="h-[22px] w-[22px] rounded-md object-contain shrink-0"
                        />
                        <span className="font-bold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            {APP_NAME}
                        </span>
                    </button>

                    {isConnected && (
                        <>
                            <div className="h-3.5 w-px bg-border/40 shrink-0" />
                            <div className="flex items-center gap-1.5 min-w-0">
                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                                <span className="text-xs font-mono text-muted-foreground/80 truncate">
                                    {databaseName}
                                </span>
                                <ConnectionEnvBadge environment={activeConnectionEnvironment} compact />
                                {pgVersion && (
                                    <Badge
                                        variant="outline"
                                        className="h-4 px-1.5 text-[9px] font-mono border-border/30 text-muted-foreground/45 shrink-0"
                                    >
                                        PG {pgVersion}
                                    </Badge>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Center: Primary view tabs */}
                <div className="flex min-w-0 items-center justify-center">
                    {isConnected && (
                        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as typeof activeView)}>
                            <TabsList aria-label="View tabs" className="h-8 gap-0.5 rounded-xl border border-border/40 bg-muted/55 p-1 shadow-sm">
                                <TabsTrigger
                                    value="data"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_data") ? `Data (${sc("view_data")})` : "Data"}
                                >
                                    <Table2 className="h-3 w-3" />
                                    <span>Data</span>
                                </TabsTrigger>
                                <TabsTrigger
                                    value="query"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_query") ? `Query (${sc("view_query")})` : "Query"}
                                >
                                    <Terminal className="h-3 w-3" />
                                    <span>Query</span>
                                </TabsTrigger>
                                <TabsTrigger
                                    value="sessions"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_sessions") ? `Sessions (${sc("view_sessions")})` : "Sessions"}
                                >
                                    <Activity className="h-3 w-3" />
                                    <span className="hidden sm:inline">Sessions</span>
                                </TabsTrigger>
                                <TabsTrigger
                                    value="indexes"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_indexes") ? `Indexes (${sc("view_indexes")})` : "Indexes"}
                                >
                                    <Layers className="h-3 w-3" />
                                    <span className="hidden sm:inline">Indexes</span>
                                </TabsTrigger>
                                <TabsTrigger
                                    value="topology"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_topology") ? `Topology (${sc("view_topology")})` : "Topology"}
                                >
                                    <Network className="h-3 w-3" />
                                    <span className="hidden md:inline">Topology</span>
                                </TabsTrigger>
                                <TabsTrigger
                                    value="ai"
                                    className="h-6 gap-1.5 px-2 text-[10.5px]"
                                    title={sc("view_ai") ? `AI (${sc("view_ai")})` : "AI"}
                                >
                                    <Sparkles className="h-3 w-3" />
                                    <span>AI</span>
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                    )}
                </div>

                {/* Right: Action buttons — grouped with dividers */}
                <div className="flex min-w-0 items-center justify-end gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {/* Primary actions: Refresh + Search */}
                    {isConnected && (
                        <>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 w-7 p-0 shrink-0 text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                                        onClick={() => refreshAll()}
                                        disabled={isRefreshingAll}
                                        aria-label={isRefreshingAll ? "Refreshing" : "Refresh"}
                                    >
                                        <RefreshCw className={cn("h-3.5 w-3.5", isRefreshingAll && "animate-spin")} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    Refresh{sc("refresh") && ` (${sc("refresh")})`}
                                </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                                        onClick={() => setSearchOpen(true)}
                                        aria-label="Open search"
                                    >
                                        <Search className="h-3.5 w-3.5" />
                                        <span className="hidden lg:inline">Find</span>
                                        {sc("search") && (
                                            <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/40 px-1 font-mono text-[9px] text-muted-foreground/40">
                                                {sc("search")}
                                            </kbd>
                                        )}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    Search tables & columns{sc("search") && ` (${sc("search")})`}
                                </TooltipContent>
                            </Tooltip>

                            <div className="h-4 w-px bg-border/30 mx-0.5" />
                        </>
                    )}

                    {/* Nav links: History, Extensions, Bug */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                            >
                                <Link href="/query-history">
                                    <Clock3 className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Hist</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Query History{sc("query_history") && ` (${sc("query_history")})`}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                            >
                                <Link href="/extensions-management">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Ext</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Extensions & Users{sc("extensions") && ` (${sc("extensions")})`}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                            >
                                <Link href="/bug-report">
                                    <Bug className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Bug</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Submit feedback & bug reports{sc("bug_report") && ` (${sc("bug_report")})`}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                            >
                                <Link href="/migration-studio">
                                    <GitCompare className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Migrate</span>
                                </Link>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Migration Studio
                        </TooltipContent>
                    </Tooltip>

                    {/* <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
                                onClick={() => invoke("open_new_window")}
                                aria-label="Open new window"
                            >
                                <AppWindowMac className="h-3.5 w-3.5" />
                                <span className="hidden lg:inline">New</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            New Window{sc("new_window") && ` (${sc("new_window")})`}
                        </TooltipContent>
                    </Tooltip> */}

                    <div className="h-4 w-px bg-border/30 mx-0.5" />

                    {/* Connection + Settings */}
                    {isConnected ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground/55 hover:text-destructive/80 hover:bg-destructive/10 transition-all"
                                    onClick={() => connectionId && disconnect(connectionId)}
                                    aria-label="Disconnect from database"
                                >
                                    <Unplug className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Disconnect</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Disconnect{sc("disconnect") && ` (${sc("disconnect")})`}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 shrink-0 gap-1 px-1.5 text-[10px] text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
                                    onClick={() => setShowConnectionDialog(true)}
                                    aria-label="Connect to database"
                                >
                                    <PlugZap className="h-3.5 w-3.5" />
                                    <span className="hidden lg:inline">Connect</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Connect{sc("connect") && ` (${sc("connect")})`}
                            </TooltipContent>
                        </Tooltip>
                    )}

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground/55 hover:text-foreground hover:bg-muted/55 transition-all"
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

                    {/* Profile / Login */}
                    <div className="h-4 w-px bg-border/30 mx-0.5" />
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
                                            {user.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("")}
                                        </AvatarFallback>
                                    </Avatar>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{user.name}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <LoginPrompt compact onLoginSuccess={() => {}} />
                    )}
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
                            <div className="h-full min-h-0" role="tabpanel" tabIndex={0} aria-label="Active view content">
                                {activeView === "data" && <TableLayoutView />}
                                {activeView === "query" && <QueryEditor />}
                                {activeView === "tests" && <SqlUnitTestRunner />}
                                {activeView === "sessions" && <SessionMonitor />}
                                {activeView === "indexes" && <IndexBuilder />}
                                {activeView === "topology" && (
                                    <SchemaTopology onNavigateToTable={() => setActiveView("data")} />
                                )}
                                {activeView === "ai" && <AIChatPanel />}
                                {activeView === "git" && <GitPanel />}
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
                onNavigateToData={() => setActiveView("data")}
                onNavigateToTable={(schema, table) => {
                    setActiveView("data");
                    openTab(schema, table);
                }}
            />

            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                onOpenSurvey={user ? () => { setSettingsOpen(false); setShowSurveyModal(true); } : undefined}
            />

            <ProfilePanel open={showProfile} onClose={() => setShowProfile(false)} />
        </div>
    );
}
