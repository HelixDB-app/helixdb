"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createElement, useEffect, useMemo, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShortcutsStore, type ShortcutActionId } from "@/stores/shortcuts-store";
import { useAuthStore } from "@/stores/auth-store";
import { useTrialStore } from "@/stores/trial-store";
import { useCollaborationStore } from "@/stores/collaboration-store";
import { runtimeAuthFetchProfile, runtimeAuthGetToken } from "@/lib/auth-runtime";
import { eventMatchesCombo, formatShortcut, isEditableTarget } from "@/lib/shortcut-keys";
import { APP_NAME } from "@/lib/app-config";
import { useLayoutStore } from "@/stores/layout-store";
import { listenCollabJoin, openNewAppWindow } from "@/lib/desktop-shell";
import dynamic from "next/dynamic";
import { LandingConnections } from "@/components/landing-connections";
import { WelcomeScreen } from "@/components/welcome-screen";
import { ConnectionDialog } from "@/components/connection-dialog";
import { StatusBar } from "@/components/status-bar";
import { CommandPalette } from "@/components/command-palette";
import { SettingsDialog } from "@/components/settings-dialog";
import { ProfilePanel } from "@/components/profile-panel";
import { LoginPrompt } from "@/components/login-prompt";
import { SurveyModal } from "@/components/survey-modal";
import { BetaFeedbackDialog } from "@/components/beta-feedback-dialog";
import { getSurveyStatus } from "@/lib/survey";
import { useBetaFeedbackScheduler } from "@/hooks/use-beta-feedback-scheduler";
import type { SettingsSection } from "@/components/settings-dialog";

function parseMenuSettingsSection(raw: string | null): SettingsSection | null {
    if (!raw) return null;
    const allowed: SettingsSection[] = [
        "appearance",
        "editor",
        "data",
        "query",
        "ai",
        "shortcuts",
        "about",
    ];
    return allowed.includes(raw as SettingsSection) ? (raw as SettingsSection) : null;
}
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { cn } from "@/lib/utils";
import {
    Activity,
    AppWindowMac,
    Check,
    ChevronDown,
    Layers,
    MoreHorizontal,
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
import type { LucideIcon } from "lucide-react";

type HeaderPrimaryView = "data" | "query" | "sessions" | "indexes" | "topology" | "ai";

type HeaderViewShortcutId = Extract<
    ShortcutActionId,
    "view_data" | "view_query" | "view_sessions" | "view_indexes" | "view_topology" | "view_ai"
>;

const HEADER_PRIMARY_VIEWS: {
    id: HeaderPrimaryView;
    label: string;
    Icon: LucideIcon;
    shortcutKey: HeaderViewShortcutId;
    labelClassName: string;
}[] = [
    { id: "data", label: "Data", Icon: Table2, shortcutKey: "view_data", labelClassName: "" },
    { id: "query", label: "Query", Icon: Terminal, shortcutKey: "view_query", labelClassName: "" },
    {
        id: "sessions",
        label: "Sessions",
        Icon: Activity,
        shortcutKey: "view_sessions",
        labelClassName: "hidden sm:inline",
    },
    {
        id: "indexes",
        label: "Indexes",
        Icon: Layers,
        shortcutKey: "view_indexes",
        labelClassName: "hidden sm:inline",
    },
    {
        id: "topology",
        label: "Topology",
        Icon: Network,
        shortcutKey: "view_topology",
        labelClassName: "hidden md:inline",
    },
    { id: "ai", label: "AI", Icon: Sparkles, shortcutKey: "view_ai", labelClassName: "" },
];

export default function Home() {
    const router = useRouter();
    const pathname = usePathname();
    const {
        isConnected,
        connectionId,
        disconnect,
        databaseName,
        serverVersion,
        refreshAll,
        isRefreshingAll,
        connections,
        activeConnectionId,
    } = useConnectionStore();
    const { openTab } = useLayoutStore();
    const getCombo = useShortcutsStore((s) => s.getCombo);
    const { user, isAuthenticated, setUser, setLoading: setAuthLoading } = useAuthStore();
    const { associateUser } = useTrialStore();
    const handleCollabDeepLink = useCollaborationStore((s) => s.handleDeepLinkUrl);
    const [showConnectionDialog, setShowConnectionDialog] = useState(false);
    const [activeView, setActiveView] = useState<"data" | "query" | "tests" | "sessions" | "indexes" | "topology" | "ai" | "git">("data");
    const [searchOpen, setSearchOpen] = useState(false);
    const [showWelcome, setShowWelcome] = useState(false);
    const [showSurveyModal, setShowSurveyModal] = useState(false);
    const [showBetaFeedback, setShowBetaFeedback] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSeed, setSettingsSeed] = useState<SettingsSection | null>(null);
    const [showProfile, setShowProfile] = useState(false);

    /** Native app menu (Tauri) signals via query params on `/` so this works from any route. */
    useEffect(() => {
        if (typeof window === "undefined" || pathname !== "/") return;
        const sp = new URLSearchParams(window.location.search);
        const d = sp.get("pgstudio_desktop");
        if (!d) return;
        const sectionRaw = sp.get("pgstudio_section");
        router.replace("/", { scroll: false });
        if (d === "settings") {
            setSettingsSeed(parseMenuSettingsSection(sectionRaw));
            setSettingsOpen(true);
        } else if (d === "palette") {
            if (!isConnected) setShowConnectionDialog(true);
            else setSearchOpen(true);
        }
    }, [pathname, router, isConnected]);

    useEffect(() => {
        if (!settingsOpen) setSettingsSeed(null);
    }, [settingsOpen]);

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
            getSurveyStatus({ getToken: runtimeAuthGetToken }).then(({ completed }) => {
                if (!cancelled && !completed) setShowSurveyModal(true);
            });
        }, 500);
        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [user, showWelcome]);

    useBetaFeedbackScheduler({
        userId: user?.id ?? null,
        enabled: Boolean(user) && !showWelcome,
        paused: showSurveyModal,
        onEligible: () => setShowBetaFeedback(true),
    });

    // Restore session on startup — try to load an existing cached profile from the keychain.
    // - null return means "not logged in" (normal, no error)
    // - thrown error means a transient network/parse issue — surface a subtle warning
    useEffect(() => {
        let cancelled = false;
        async function restoreSession() {
            setAuthLoading(true);
            try {
                const profile = await runtimeAuthFetchProfile();
                if (!cancelled) {
                    if (profile) {
                        setUser(profile);
                        void associateUser(profile.id);
                    }
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
            unlisten = await listenCollabJoin((url) => {
                handleCollabDeepLink(url);
                setActiveView("query");
            });
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
                        void openNewAppWindow();
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

    const headerMobileView = useMemo(() => {
        const cur = HEADER_PRIMARY_VIEWS.find((v) => v.id === activeView);
        return { icon: cur?.Icon ?? Table2, label: cur?.label ?? "View" };
    }, [activeView]);

    // Landing: saved connections list + quick connect
    if (!isConnected) {
        return (
            <>
                {showWelcome && <WelcomeScreen onDismiss={handleWelcomeDismiss} />}
                <LandingConnections />
                {showSurveyModal && (
                    <SurveyModal
                        open={showSurveyModal}
                        onClose={() => setShowSurveyModal(false)}
                        onSubmitted={() => setShowSurveyModal(false)}
                        getToken={runtimeAuthGetToken}
                    />
                )}
                <BetaFeedbackDialog
                    open={showBetaFeedback}
                    onOpenChange={setShowBetaFeedback}
                    getToken={runtimeAuthGetToken}
                />
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
                    onOpenBetaFeedback={user ? () => { setSettingsOpen(false); setShowBetaFeedback(true); } : undefined}
                    seedSection={settingsSeed}
                />
            </>
        );
    }

    return (
        <div className="flex h-screen flex-col bg-transparent">
            {showSurveyModal && (
                <SurveyModal
                    open={showSurveyModal}
                    onClose={() => setShowSurveyModal(false)}
                    onSubmitted={() => setShowSurveyModal(false)}
                    getToken={runtimeAuthGetToken}
                />
            )}
            <BetaFeedbackDialog
                open={showBetaFeedback}
                onOpenChange={setShowBetaFeedback}
                getToken={runtimeAuthGetToken}
            />
            {/* Top bar — compact flex: brand | views | actions; scroll/menus on narrow widths */}
            <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/35 bg-card/75 dark:bg-background/95 px-2 pt-[max(0px,env(safe-area-inset-top))] sm:px-3 backdrop-blur-md shadow-[0_1px_0_oklch(0_0_0_/0.03)] dark:shadow-none">
                {/* Left: Logo + connection indicator */}
                <div className="flex min-w-0 max-w-[min(42vw,14rem)] sm:max-w-[min(50vw,20rem)] items-center gap-2 shrink-0">
                    <button
                        onClick={() => !isConnected && setShowConnectionDialog(true)}
                        className="flex min-w-0 items-center gap-1.5 rounded-md group focus-ring shrink-0"
                        aria-label={isConnected ? `${APP_NAME} home` : "Connect to database"}
                    >
                        <Image
                            src="/logo.png"
                            alt=""
                            width={20}
                            height={20}
                            className="h-5 w-5 rounded-md object-contain shrink-0"
                        />
                        <span className="truncate font-semibold text-xs bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent max-[360px]:hidden">
                            {APP_NAME}
                        </span>
                    </button>

                    {isConnected && (
                        <>
                            <div className="h-3 w-px bg-border/40 shrink-0" />
                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80 sm:text-[11px]">
                                    {databaseName}
                                </span>
                                <ConnectionEnvBadge environment={activeConnectionEnvironment} compact />
                                {pgVersion && (
                                    <Badge
                                        variant="outline"
                                        className="hidden h-4 shrink-0 border-border/30 px-1.5 font-mono text-[9px] text-muted-foreground/45 sm:inline-flex"
                                    >
                                        PG {pgVersion}
                                    </Badge>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Center: view switcher — dropdown on small screens, tabs on md+ */}
                <div className="flex min-w-0 flex-1 items-center justify-center">
                    {isConnected && (
                        <>
                            <div className="flex w-full min-w-0 justify-center md:hidden">
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 max-w-[min(100%,11rem)] gap-1 border-border/25 bg-muted/30 px-2 text-[10px] font-medium shadow-none"
                                            aria-label={`Current view: ${headerMobileView.label}. Open view menu.`}
                                        >
                                            {createElement(headerMobileView.icon, {
                                                className: "h-3 w-3 shrink-0 opacity-80",
                                            })}
                                            <span className="truncate">{headerMobileView.label}</span>
                                            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="center" className="z-[8500] w-52">
                                        {HEADER_PRIMARY_VIEWS.map(({ id, label, Icon }) => (
                                            <DropdownMenuItem
                                                key={id}
                                                className="gap-2 text-xs"
                                                onClick={() => setActiveView(id)}
                                            >
                                                <Icon className="h-3.5 w-3.5 opacity-70" />
                                                {label}
                                                {activeView === id && (
                                                    <Check className="ml-auto h-3.5 w-3.5 opacity-70" />
                                                )}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>

                            <div className="hidden min-w-0 max-w-full justify-center overflow-x-auto py-0.5 [scrollbar-width:none] md:flex md:justify-center [&::-webkit-scrollbar]:hidden">
                                <Tabs value={activeView} onValueChange={(v) => setActiveView(v as typeof activeView)}>
                                    <TabsList
                                        aria-label="View tabs"
                                        className="h-8 gap-0.5 rounded-lg border border-border/10 bg-muted/35 p-0.5 shadow-none backdrop-blur-sm"
                                    >
                                        {HEADER_PRIMARY_VIEWS.map(({ id, label, Icon, shortcutKey, labelClassName }) => (
                                            <TabsTrigger
                                                key={id}
                                                value={id}
                                                className={cn(
                                                    "h-7 shrink-0 gap-1 rounded-md px-2 text-[10px] font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm sm:px-2.5 sm:text-[11px]",
                                                )}
                                                title={
                                                    sc(shortcutKey) ? `${label} (${sc(shortcutKey)})` : label
                                                }
                                            >
                                                <Icon className="h-3 w-3 shrink-0" />
                                                <span className={labelClassName}>{label}</span>
                                            </TabsTrigger>
                                        ))}
                                    </TabsList>
                                </Tabs>
                            </div>
                        </>
                    )}
                </div>

                {/* Right: Action buttons — grouped with dividers */}
                <div className="flex shrink-0 items-center justify-end gap-0.5 sm:gap-1">
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
                                <TooltipContent side="bottom" sideOffset={6}>
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
                                <TooltipContent side="bottom" sideOffset={6}>
                                    Search tables & columns{sc("search") && ` (${sc("search")})`}
                                </TooltipContent>
                            </Tooltip>

                            <div className="h-4 w-px bg-border/30 mx-0.5" />
                        </>
                    )}

                    {/* Nav links: History, Extensions, Bug, Migrate — inline from lg; overflow menu on narrow */}
                    <div className="hidden lg:contents">
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
                                        <span className="hidden 2xl:inline">Hist</span>
                                    </Link>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
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
                                        <span className="hidden 2xl:inline">Ext</span>
                                    </Link>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
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
                                        <span className="hidden 2xl:inline">Bug</span>
                                    </Link>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
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
                                        <span className="hidden 2xl:inline">Migrate</span>
                                    </Link>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
                                Migration Studio
                            </TooltipContent>
                        </Tooltip>
                    </div>

                    <div className="lg:hidden">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-muted-foreground/55 hover:text-foreground hover:bg-muted/55"
                                    aria-label="More tools"
                                >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="z-[8500] w-52">
                                <DropdownMenuItem asChild className="gap-2 text-xs">
                                    <Link href="/query-history">
                                        <Clock3 className="h-3.5 w-3.5" />
                                        Query History
                                    </Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild className="gap-2 text-xs">
                                    <Link href="/extensions-management">
                                        <ShieldCheck className="h-3.5 w-3.5" />
                                        Extensions & Users
                                    </Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild className="gap-2 text-xs">
                                    <Link href="/bug-report">
                                        <Bug className="h-3.5 w-3.5" />
                                        Report a bug
                                    </Link>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem asChild className="gap-2 text-xs">
                                    <Link href="/migration-studio">
                                        <GitCompare className="h-3.5 w-3.5" />
                                        Migration Studio
                                    </Link>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

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
                        <TooltipContent side="bottom" sideOffset={6}>
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
                                    <span className="hidden sm:inline">Disconnect</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
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
                            <TooltipContent side="bottom" sideOffset={6}>
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
                        <TooltipContent side="bottom" sideOffset={6}>
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
                            <TooltipContent side="bottom" sideOffset={6}>
                                {user.name}
                            </TooltipContent>
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
                            <div className="h-full min-h-0 bg-card/40 dark:bg-transparent border-l border-border/25 dark:border-transparent" role="tabpanel" tabIndex={0} aria-label="Active view content">
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
                onOpenBetaFeedback={user ? () => { setSettingsOpen(false); setShowBetaFeedback(true); } : undefined}
                seedSection={settingsSeed}
            />

            <ProfilePanel open={showProfile} onClose={() => setShowProfile(false)} />
        </div>
    );
}
