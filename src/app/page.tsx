"use client";

import { useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { LandingConnections } from "@/components/landing-connections";
import { ConnectionDialog } from "@/components/connection-dialog";
import { Sidebar } from "@/components/sidebar";
import { DataTable } from "@/components/data-table";
import { QueryEditor } from "@/components/query-editor";
import { StatusBar } from "@/components/status-bar";
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
import {
    Database,
    PlugZap,
    Table2,
    Terminal,
    Unplug,
} from "lucide-react";

export default function Home() {
    const { isConnected, disconnect, databaseName, serverVersion } = useConnectionStore();
    const [showConnectionDialog, setShowConnectionDialog] = useState(false);
    const [activeView, setActiveView] = useState<"data" | "query">("data");

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";

    // Landing: saved connections list + quick connect
    if (!isConnected) {
        return <LandingConnections />;
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
                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-500 to-cyan-500 shadow-sm shadow-emerald-500/20">
                            <Database className="h-3.5 w-3.5 text-white" />
                        </div>
                        <span className="font-bold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            HelixDB
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
                </div>
            </header>

            {/* Main content */}
            <div className="flex-1 overflow-hidden">
                {isConnected ? (
                    <ResizablePanelGroup orientation="horizontal">
                        <ResizablePanel defaultSize={20} minSize={14} maxSize={300}>
                            <Sidebar />
                        </ResizablePanel>

                        <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors data-[resize-handle-active]:bg-emerald-500/60" />

                        <ResizablePanel defaultSize={80}>
                            <div className="h-full">
                                {activeView === "data" ? <DataTable /> : <QueryEditor />}
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
        </div>
    );
}
