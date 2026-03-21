"use client";

import * as React from "react";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShallow } from "zustand/react/shallow";
import { getSavedConnections } from "@/lib/saved-connections-api";
import type { SavedConnection } from "@/lib/types";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { normalizeConnectionMetadata } from "@/lib/connection-metadata";
import {
    ChevronDown,
    Plus,
    Server,
    CircleDot,
    Unplug,
    Loader2,
    AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MAX_SHORTCUT = 9;
const SHORTCUT_KEYS = Array.from({ length: MAX_SHORTCUT }, (_, i) => `${i + 1}`);

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute?.("role") ?? "").toLowerCase();
    const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        (el as HTMLElement).isContentEditable ||
        role === "textbox" ||
        role === "searchbox" ||
        role === "combobox";
    return isEditable;
}

export interface ConnectionSwitcherProps {
    onOpenConnectionDialog?: () => void;
    className?: string;
    /** @deprecated UI is now a single compact style. */
    size?: "default" | "lg";
}

export function ConnectionSwitcher({
    onOpenConnectionDialog,
    className,
}: ConnectionSwitcherProps) {
    const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
    const [savedConnectionsLoading, setSavedConnectionsLoading] = useState(true);
    const [savedConnectionsError, setSavedConnectionsError] = useState<string | null>(null);
    const [dropdownOpen, setDropdownOpen] = useState(false);

    const {
        connections,
        activeConnectionId,
        setActiveConnection,
        connect,
        isConnecting,
        connectionError,
        clearError,
        databaseName,
    } = useConnectionStore(
        useShallow((s) => ({
            connections: s.connections,
            activeConnectionId: s.activeConnectionId,
            setActiveConnection: s.setActiveConnection,
            connect: s.connect,
            isConnecting: s.isConnecting,
            connectionError: s.connectionError,
            clearError: s.clearError,
            databaseName: s.databaseName,
        }))
    );

    const activeConn = useMemo(
        () => connections.find((c) => c.connectionId === activeConnectionId),
        [connections, activeConnectionId]
    );

    const openConnectionsOrdered = useMemo(() => {
        const saved = savedConnections
            .map((s) => connections.find((c) => c.savedConnectionId === s.id))
            .filter((c): c is NonNullable<typeof c> => !!c);
        const unsaved = connections.filter((c) => !c.savedConnectionId);
        return [...saved, ...unsaved];
    }, [savedConnections, connections]);

    const savedDisconnected = useMemo(
        () =>
            savedConnections.filter(
                (s) => !connections.some((c) => c.savedConnectionId === s.id)
            ),
        [savedConnections, connections]
    );

    useEffect(() => {
        let cancelled = false;
        setSavedConnectionsLoading(true);
        setSavedConnectionsError(null);
        getSavedConnections()
            .then((list) => {
                if (!cancelled) setSavedConnections(list ?? []);
            })
            .catch((err) => {
                if (!cancelled) {
                    setSavedConnections([]);
                    setSavedConnectionsError(err instanceof Error ? err.message : "Failed to load connections");
                }
            })
            .finally(() => {
                if (!cancelled) setSavedConnectionsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [connections.length]);

    const handleConnect = useCallback(
        (saved: SavedConnection) => {
            const sshTunnel = saved.ssh_tunnel?.use_ssh_tunneling ? saved.ssh_tunnel : undefined;
            connect(
                saved.connection_string,
                saved.id,
                saved.name,
                normalizeConnectionMetadata(saved),
                sshTunnel
            );
        },
        [connect]
    );

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (dropdownOpen) return;
            if (!e.metaKey && !e.ctrlKey) return;
            const key = e.key;
            if (!SHORTCUT_KEYS.includes(key)) return;
            if (isInputFocused()) return;

            const index = parseInt(key, 10) - 1;
            const conn = openConnectionsOrdered[index];
            if (conn) {
                e.preventDefault();
                setActiveConnection(conn.connectionId);
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [dropdownOpen, openConnectionsOrdered, setActiveConnection]);

    const handleOpenChange = useCallback(
        (open: boolean) => {
            setDropdownOpen(open);
            if (!open && connectionError) clearError?.();
        },
        [connectionError, clearError]
    );

    const displayLabel = activeConn
        ? activeConn.label
        : isConnecting
          ? "Connecting…"
          : "Connections";
    const subtitle = activeConn
        ? activeConn.databaseName || databaseName || ""
        : isConnecting
          ? ""
          : "Select a connection";

    return (
        <div className={cn("shrink-0", className)}>
            <DropdownMenu open={dropdownOpen} onOpenChange={handleOpenChange}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={savedConnectionsLoading && savedConnections.length === 0}
                        aria-busy={isConnecting}
                        aria-label={activeConn ? `Switch connection (${activeConn.label})` : "Open connections"}
                        className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent disabled:opacity-60 disabled:pointer-events-none"
                    >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                            {isConnecting ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Server className="size-4" />
                            )}
                        </div>
                        <div className="grid min-w-0 flex-1 text-left">
                            <span className="truncate block text-[13px] font-medium text-sidebar-foreground">
                                {displayLabel}
                            </span>
                            {subtitle ? (
                                <span className="truncate block text-[11px] text-sidebar-foreground/55">
                                    {subtitle}
                                </span>
                            ) : null}
                        </div>
                        <ChevronDown className="size-4 shrink-0 text-sidebar-foreground/45" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-64 rounded-lg bg-sidebar border-sidebar-border"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                >
                    <DropdownMenuLabel className="text-xs text-sidebar-foreground/60 flex items-center justify-between">
                        <span>Connections</span>
                        <span className="text-[10px]">⌘1–9</span>
                    </DropdownMenuLabel>

                    {(connectionError || savedConnectionsError) && (
                        <>
                            <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-destructive bg-destructive/10 border border-destructive/20">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate flex-1">
                                    {connectionError ?? savedConnectionsError}
                                </span>
                            </div>
                            <DropdownMenuSeparator />
                        </>
                    )}

                    {openConnectionsOrdered.length === 0 &&
                        !savedConnectionsLoading &&
                        savedDisconnected.length === 0 && (
                            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                                No connections yet. Add one below.
                            </div>
                        )}

                    {openConnectionsOrdered.map((conn, idx) => {
                        const isActive = conn.connectionId === activeConnectionId;
                        const shortcut = idx < MAX_SHORTCUT ? `⌘${idx + 1}` : null;
                        return (
                            <DropdownMenuItem
                                key={conn.connectionId}
                                onClick={() => setActiveConnection(conn.connectionId)}
                                className={cn(
                                    "gap-2 p-2 cursor-pointer rounded-md",
                                    isActive && "bg-sidebar-accent text-sidebar-accent-foreground"
                                )}
                            >
                                <div className="flex size-6 shrink-0 items-center justify-center rounded-[4px] bg-sidebar-accent text-sidebar-foreground/80">
                                    <CircleDot className="size-3.5" />
                                </div>
                                <span className="truncate text-sm font-medium flex-1">{conn.label}</span>
                                <ConnectionEnvBadge
                                    environment={conn.environment}
                                    compact
                                    className="shrink-0"
                                />
                                {shortcut && (
                                    <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
                                )}
                            </DropdownMenuItem>
                        );
                    })}

                    {savedDisconnected.map((saved) => (
                        <DropdownMenuItem
                            key={saved.id}
                            onClick={() => handleConnect(saved)}
                            disabled={isConnecting}
                            className="gap-2 p-2 cursor-pointer rounded-md text-muted-foreground"
                        >
                            <div className="flex size-6 shrink-0 items-center justify-center rounded-[4px] border border-sidebar-border text-sidebar-foreground/50">
                                <Unplug className="size-3.5" />
                            </div>
                            <span className="truncate text-sm font-medium">{saved.name}</span>
                            <ConnectionEnvBadge
                                environment={saved.environment}
                                compact
                                className="shrink-0"
                            />
                            <span className="text-[10px]">Connect</span>
                        </DropdownMenuItem>
                    ))}

                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onClick={() => {
                            setDropdownOpen(false);
                            onOpenConnectionDialog?.();
                        }}
                        className="gap-2 p-2 cursor-pointer rounded-md font-medium text-sidebar-foreground focus:text-sidebar-foreground"
                    >
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-[4px] border border-sidebar-border text-sidebar-foreground/60">
                            <Plus className="size-3.5" />
                        </div>
                        <span>New connection</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
