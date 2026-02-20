"use client";

import { useEffect, useState } from "react";
import type { SavedConnection } from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import { useSavedConnectionsStore } from "@/stores/saved-connections-store";
import { ConnectionDialog } from "@/components/connection-dialog";
import { SaveConnectionDialog } from "@/components/save-connection-dialog";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

export function LandingConnections() {
    const { connections, isLoading, load, remove, updateDatabaseName } =
        useSavedConnectionsStore();
    const { connect, isConnecting } = useConnectionStore();

    const [showQuickConnect, setShowQuickConnect] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [editConnection, setEditConnection] = useState<SavedConnection | null>(null);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [pendingConnect, setPendingConnect] = useState<SavedConnection | null>(null);

    useEffect(() => {
        load();
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

    const handleConnect = (conn: SavedConnection) => {
        setConnectingId(conn.id);
        connect(conn.connection_string, conn.id);
    };

    const handleSaveAndConnect = (conn: SavedConnection) => {
        setPendingConnect(conn);
    };

    const handleOpenEdit = (e: React.MouseEvent, conn: SavedConnection) => {
        e.stopPropagation();
        setEditConnection(conn);
        setShowSaveDialog(true);
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (confirm("Remove this saved connection?")) {
            await remove(id);
        }
    };

    const openAddDialog = () => {
        setEditConnection(null);
        setShowSaveDialog(true);
    };

    return (
        <div className="flex h-screen flex-col bg-background">
            <div className="flex flex-1 flex-col min-h-0">
                {/* Header */}
                <div className="shrink-0 pt-12 pb-8 px-6 text-center">
                    <div className="inline-flex items-center gap-3">
                        <div className="relative">
                            <div className="absolute -inset-4 rounded-full bg-gradient-to-r from-emerald-500/15 to-cyan-500/15 blur-xl" />
                            <div className="relative flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 shadow-lg shadow-emerald-500/20">
                                <Database className="h-7 w-7 text-white" />
                            </div>
                        </div>
                        <div className="text-left">
                            <h1 className="text-2xl font-bold tracking-tight">
                                <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                                    HelixDB
                                </span>
                            </h1>
                            <p className="text-xs text-muted-foreground/80 mt-0.5">
                                PostgreSQL admin panel
                            </p>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto px-6 pb-8">
                    <div className="max-w-2xl mx-auto space-y-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-foreground/80">
                                Saved connections
                            </h2>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => setShowQuickConnect(true)}
                                >
                                    <Plug className="h-3.5 w-3.5 mr-1.5" />
                                    Quick connect
                                </Button>
                                <Button
                                    size="sm"
                                    className="h-8 gap-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-xs"
                                    onClick={openAddDialog}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    New connection
                                </Button>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton key={i} className="h-24 rounded-xl" />
                                ))}
                            </div>
                        ) : connections.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-border/40 bg-card/20 p-10 text-center">
                                <Server className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                                <p className="text-sm font-medium text-muted-foreground/70">
                                    No saved connections
                                </p>
                                <p className="text-xs text-muted-foreground/50 mt-1">
                                    Add a connection or use quick connect
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="mt-4"
                                    onClick={openAddDialog}
                                >
                                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                                    Add connection
                                </Button>
                            </div>
                        ) : (
                            <div className="grid gap-3 sm:grid-cols-2">
                                {connections.map((conn) => {
                                    const isConnectingThis =
                                        isConnecting && connectingId === conn.id;
                                    return (
                                        <div
                                            key={conn.id}
                                            className={cn(
                                                "group rounded-xl border border-border/30 bg-card/30 p-4 transition-all",
                                                "hover:border-border/50 hover:bg-card/50",
                                                "focus-within:ring-2 focus-within:ring-emerald-500/20"
                                            )}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <p className="font-medium text-sm text-foreground truncate">
                                                        {conn.name}
                                                    </p>
                                                    <p className="text-xs font-mono text-muted-foreground/60 truncate mt-0.5">
                                                        {conn.database_name ?? "Not connected yet"}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                                                onClick={(e) => handleOpenEdit(e, conn)}
                                                            >
                                                                <Pencil className="h-3 w-3" />
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>Edit</TooltipContent>
                                                    </Tooltip>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                                                onClick={(e) => handleDelete(e, conn.id)}
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>Remove</TooltipContent>
                                                    </Tooltip>
                                                </div>
                                            </div>
                                            <Button
                                                size="sm"
                                                className="w-full mt-3 h-8 gap-1.5 bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs"
                                                onClick={() => handleConnect(conn)}
                                                disabled={isConnecting}
                                            >
                                                {isConnectingThis ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <Plug className="h-3.5 w-3.5" />
                                                )}
                                                Connect
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <StatusBar />

            <ConnectionDialog
                open={showQuickConnect}
                onOpenChange={setShowQuickConnect}
            />

            <SaveConnectionDialog
                open={showSaveDialog}
                onOpenChange={setShowSaveDialog}
                editConnection={editConnection}
                onSaveAndConnect={handleSaveAndConnect}
            />
        </div>
    );
}
