"use client";

import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { useIdeFsStore, type FsNode, type NodeType, getExtension } from "@/stores/ide-fs-store";
import {
    ChevronDown,
    ChevronRight,
    Copy,
    Database,
    Download,
    FilePlus,
    FolderPlus,
    RefreshCw,
    Search,
    X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { SchemaImporter } from "@/components/schema-importer";

// ── File-type icon system (Cursor-style, memoized, fast lookup) ─────────────────
const ICON_CLS = "h-4 w-4 shrink-0";

type IconProps = { className?: string };
const SqlIcon = React.memo(function SqlIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="1" y="3.5" width="14" height="9" rx="1.2" fill="#0ea5e9" opacity="0.2" />
            <ellipse cx="8" cy="5.8" rx="5.2" ry="1.6" fill="#0ea5e9" />
            <path d="M3 5.8v5.2c0 .95 2.2 1.7 5 1.7s5-.75 5-1.7V5.8" stroke="#0ea5e9" strokeWidth="1" strokeLinecap="round" fill="none" />
            <path d="M3 7.8c0 .95 2.2 1.7 5 1.7s5-.75 5-1.7" stroke="#0ea5e9" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.85" />
        </svg>
    );
});
const MdIcon = React.memo(function MdIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2" y="2" width="12" height="12" rx="1.5" fill="#94a3b8" opacity="0.12" />
            <path d="M4 11V5l2.5 3L9 5v6" stroke="#94a3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11 5v6M11 11l-1.5-1.5M11 11l1.5-1.5" stroke="#94a3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
});
const DocIcon = React.memo(function DocIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2.2" y="1.8" width="11.6" height="12.4" rx="1.6" fill="#38bdf8" opacity="0.15" />
            <path d="M5 5h6M5 7.8h6M5 10.6h4.2" stroke="#38bdf8" strokeWidth="1.15" strokeLinecap="round" />
            <path d="M10.5 1.8v2.8h3.3" stroke="#38bdf8" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
        </svg>
    );
});
const JsonIcon = React.memo(function JsonIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <path d="M4.5 3C3.5 3 3 3.5 3 4.5v1C3 6.3 2.5 6.8 2 7c.5.2 1 .7 1 1.5v1c0 1 .5 1.5 1.5 1.5" stroke="#eab308" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M11.5 3c1 0 1.5.5 1.5 1.5v1c0 .8.5 1.3 1 1.5-.5.2-1 .7-1 1.5v1c0 1-.5 1.5-1.5 1.5" stroke="#eab308" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="8" cy="7" r=".9" fill="#eab308" />
        </svg>
    );
});
const TsIcon = React.memo(function TsIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2" y="2" width="12" height="12" rx="2" fill="#3b82f6" opacity="0.9" />
            <path d="M4.5 6.5H8M6.25 6.5V11" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M9.5 9c0-.6.4-1 1-.1.3.5.5.8 1 .8s.8-.3.8-.7c0-.5-.4-.7-1.2-1C10.2 7.6 9.5 7 9.5 6.2S10.1 5 11 5s1.4.4 1.5 1" stroke="white" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
    );
});
const JsIcon = React.memo(function JsIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2" y="2" width="12" height="12" rx="2" fill="#eab308" opacity="0.9" />
            <path d="M5 5v4.5c0 1-.5 1.5-1.5 1.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M8.5 9c0-.6.4-1 1-.1.3.5.5.8 1 .8s.8-.3.8-.7c0-.5-.4-.7-1.2-1C9.2 7.6 8.5 7 8.5 6.2S9.1 5 10 5s1.4.4 1.5 1" stroke="white" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
    );
});
const EnvIcon = React.memo(function EnvIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <circle cx="8" cy="8" r="5.5" stroke="#f59e0b" strokeWidth="1.2" />
            <circle cx="8" cy="8" r="2" fill="#f59e0b" opacity="0.8" />
            <path d="M8 2.5v1.3M8 12.2v1.3M2.5 8h1.3M12.2 8h1.3" stroke="#f59e0b" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
    );
});
const ShIcon = React.memo(function ShIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2" y="2" width="12" height="12" rx="2" fill="#22c55e" opacity="0.15" />
            <path d="M4.5 6l2.5 2-2.5 2" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8.5 10h3" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
});
const CsvIcon = React.memo(function CsvIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="2" y="2" width="12" height="12" rx="1.5" fill="#10b981" opacity="0.12" />
            <path d="M4 5h8M4 8h8M4 11h8" stroke="#10b981" strokeWidth="1.1" strokeLinecap="round" />
            <path d="M6.5 3.5v9M9.5 3.5v9" stroke="#10b981" strokeWidth="1.1" strokeLinecap="round" opacity="0.6" />
        </svg>
    );
});
const DefaultFileIcon = React.memo(function DefaultFileIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <path d="M4 2h6l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" fill="currentColor" opacity="0.08" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
        </svg>
    );
});

const FolderIcon = React.memo(function FolderIcon({ isOpen, className }: { isOpen: boolean; className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <path
                d="M1.5 5.2a1 1 0 011-1h4.2l1.2 1.8h6.1a1 1 0 011 1v5a1 1 0 01-1 1H2.5a1 1 0 01-1-1V5.2z"
                fill="#eab308"
                fillOpacity={isOpen ? 0.5 : 0.85}
                stroke="#ca8a04"
                strokeWidth={0.6}
                strokeOpacity={isOpen ? 0.4 : 0.6}
            />
        </svg>
    );
});

const FILE_ICON_MAP: Record<string, React.ComponentType<IconProps>> = {
    sql: SqlIcon,
    md: MdIcon,
    doc: DocIcon,
    json: JsonIcon,
    tsbuildinfo: JsonIcon,
    ts: TsIcon,
    tsx: TsIcon,
    js: JsIcon,
    jsx: JsIcon,
    env: EnvIcon,
    sh: ShIcon,
    csv: CsvIcon,
};

const FileTypeIcon = React.memo(function FileTypeIcon({ name, type, isOpen }: { name: string; type: NodeType; isOpen?: boolean }) {
    if (type === "folder") return <FolderIcon isOpen={!!isOpen} className={ICON_CLS} />;
    const ext = getExtension(name);
    const Icon = (ext && FILE_ICON_MAP[ext]) || DefaultFileIcon;
    // eslint-disable-next-line react-hooks/static-components
    return <Icon className={ext ? ICON_CLS : `${ICON_CLS} text-muted-foreground/40`} />;
});

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuState { x: number; y: number; nodeId: string | null }

interface ContextMenuItem {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    separator?: boolean;
}

export type FileOpenTarget = "active" | "split-right";

function ContextMenu({
    state,
    onClose,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
    onDuplicate,
    onOpen,
    canEditFiles,
    canDeleteFiles,
}: {
    state: ContextMenuState;
    onClose: () => void;
    onNewFile: (parentId: string | null) => void;
    onNewFolder: (parentId: string | null) => void;
    onRename: (id: string) => void;
    onDelete: (id: string) => void;
    onDuplicate: (id: string) => void;
    onOpen: (node: FsNode, target?: FileOpenTarget) => void;
    canEditFiles: boolean;
    canDeleteFiles: boolean;
}) {
    const { nodes } = useIdeFsStore();
    const node = state.nodeId ? nodes[state.nodeId] : null;
    const menuRef = useRef<HTMLDivElement>(null);
    const parentId = node?.type === "folder" ? state.nodeId : (node?.parentId ?? null);

    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    const items: ContextMenuItem[] = [];

    if (canEditFiles) {
        items.push({
            label: "New File",
            icon: <FilePlus className="h-3.5 w-3.5" />,
            onClick: () => { onNewFile(parentId); onClose(); },
        });
        items.push({
            label: "New Folder",
            icon: <FolderPlus className="h-3.5 w-3.5" />,
            onClick: () => { onNewFolder(parentId); onClose(); },
        });
    }

    if (node) {
        if (items.length > 0) {
            items.push({ label: "", icon: null, onClick: () => {}, separator: true });
        }
        if (node.type === "file") {
            items.push({
                label: "Open",
                icon: <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
                onClick: () => { onOpen(node, "active"); onClose(); },
            });
            items.push({
                label: "Open to Side",
                icon: <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none"><path d="M2.75 3.25h10.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.15" /><path d="M8 3.25v9.5" stroke="currentColor" strokeWidth="1.15" /><path d="M10 8h2.75" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" /></svg>,
                onClick: () => { onOpen(node, "split-right"); onClose(); },
            });
        }
        if (canEditFiles) {
            items.push({
                label: "Rename",
                icon: <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none"><path d="M2 12.5h4M4 2l8 8-3 1-1-3L4 2zM10 4l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
                onClick: () => { onRename(node.id); onClose(); },
            });
            items.push({
                label: "Duplicate",
                icon: <Copy className="h-3.5 w-3.5" />,
                onClick: () => { onDuplicate(node.id); onClose(); },
            });
        }
        if (canDeleteFiles) {
            items.push({ label: "", icon: null, onClick: () => {}, separator: true });
            items.push({
                label: "Delete",
                icon: <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M5 4v8a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
                onClick: () => { onDelete(node.id); onClose(); },
                danger: true,
            });
        }
    }

    if (typeof document === "undefined") return null;

    return createPortal(
        <div
            ref={menuRef}
            style={{ position: "fixed", top: state.y, left: state.x, zIndex: 9999 }}
            className="min-w-[172px] rounded-lg border border-border/40 bg-card/95 backdrop-blur-sm shadow-2xl py-1 overflow-hidden"
        >
            {items.map((item, i) => {
                if (item.separator) return <div key={i} className="my-1 h-px bg-border/25 mx-2" />;
                return (
                    <button
                        key={i}
                        className={cn(
                            "w-full flex items-center gap-2.5 px-3 py-[5px] text-[11.5px] text-left transition-colors",
                            item.danger
                                ? "text-destructive/80 hover:text-destructive hover:bg-destructive/10"
                                : "text-foreground/75 hover:text-foreground hover:bg-accent/60"
                        )}
                        onClick={item.onClick}
                    >
                        <span className="shrink-0 opacity-60">{item.icon}</span>
                        {item.label}
                    </button>
                );
            })}
        </div>,
        document.body
    );
}

// ── Inline rename input ───────────────────────────────────────────────────────

function RenameInput({ defaultValue, onCommit, onCancel }: {
    defaultValue: string; onCommit: (v: string) => void; onCancel: () => void;
}) {
    const [value, setValue] = useState(defaultValue);
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
    const commit = () => {
        const t = value.trim();
        if (t && t !== defaultValue) onCommit(t); else onCancel();
    };
    return (
        <input
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 text-[11.5px] bg-background border border-primary/60 rounded-[3px] px-1.5 py-[1px] focus:outline-none focus:border-primary text-foreground"
        />
    );
}

// ── New node input ─────────────────────────────────────────────────────────────

function NewNodeInput({ type, depth, onCommit, onCancel }: {
    type: NodeType; depth: number; onCommit: (v: string) => void; onCancel: () => void;
}) {
    const defaultName = type === "file" ? "untitled.sql" : "new-folder";
    const [value, setValue] = useState(defaultName);
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
        // Select name without extension
        const dot = defaultName.lastIndexOf(".");
        ref.current?.setSelectionRange(0, dot > 0 ? dot : defaultName.length);
    }, [defaultName]);

    const commit = () => { const t = value.trim(); if (t) onCommit(t); else onCancel(); };

    return (
        <div
            className="flex items-center gap-1.5 py-[2px]"
            style={{ paddingLeft: `${6 + depth * 12}px`, paddingRight: "6px" }}
        >
            <span className="w-4 shrink-0" />
            <FileTypeIcon name={value} type={type} />
            <input
                ref={ref}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={onCancel}
                onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commit(); }
                    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
                }}
                className="flex-1 min-w-0 text-[11.5px] bg-background border border-primary/60 rounded-[3px] px-1.5 py-[1px] focus:outline-none focus:border-primary text-foreground"
            />
        </div>
    );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

interface TreeNodeProps {
    node: FsNode;
    depth: number;
    connectionId: string;
    activeFileId: string | null;
    selectedNodeId: string | null;
    expandedIds: Record<string, boolean>;
    renamingId: string | null;
    dragOverId: string | null;
    newNodeState: { parentId: string | null; type: NodeType } | null;
    searchQuery: string;
    onActivate: (node: FsNode) => void;
    onSelect: (nodeId: string) => void;
    onToggle: (id: string) => void;
    onContextMenu: (e: React.MouseEvent, nodeId: string) => void;
    onRenameCommit: (id: string, name: string) => void;
    onRenameCancel: () => void;
    onDragStart: (e: React.DragEvent, nodeId: string) => void;
    onDragOver: (e: React.DragEvent, nodeId: string) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent, targetId: string | null) => void;
    onNewNodeCommit: (name: string) => void;
    onNewNodeCancel: () => void;
}

function TreeNode({
    node, depth, connectionId, activeFileId, selectedNodeId, expandedIds,
    renamingId, dragOverId, newNodeState, searchQuery,
    onActivate, onSelect, onToggle, onContextMenu,
    onRenameCommit, onRenameCancel,
    onDragStart, onDragOver, onDragLeave, onDrop,
    onNewNodeCommit, onNewNodeCancel,
}: TreeNodeProps) {
    const { getChildren } = useIdeFsStore();
    const isFolder = node.type === "folder";
    const isExpanded = isFolder && expandedIds[node.id];
    const isActive = node.id === activeFileId;
    const isSelected = node.id === selectedNodeId;
    const isDragOver = dragOverId === node.id;
    const isRenaming = renamingId === node.id;
    const indentPx = 6 + depth * 12;

    const children = useMemo(() => {
        return isFolder ? getChildren(connectionId, node.id) : [];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionId, node.id, isFolder, getChildren, useIdeFsStore.getState().nodes]);

    // Visibility: show if name matches or any descendant matches
    const visible = useMemo(() => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        if (node.name.toLowerCase().includes(q)) return true;
        if (!isFolder) return false;
        const { nodes } = useIdeFsStore.getState();
        function hasMatch(pid: string): boolean {
            for (const n of Object.values(nodes)) {
                if (n.parentId === pid && n.connectionId === connectionId) {
                    if (n.name.toLowerCase().includes(q)) return true;
                    if (n.type === "folder" && hasMatch(n.id)) return true;
                }
            }
            return false;
        }
        return hasMatch(node.id);
    }, [searchQuery, node, isFolder, connectionId]);

    if (!visible) return null;

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onSelect(node.id);
        if (isFolder) onToggle(node.id);
        else onActivate(node);
    };

    return (
        <div>
            <div
                className={cn(
                    "group flex items-center gap-0 h-[22px] select-none relative cursor-pointer transition-none",
                    isActive
                        ? "bg-primary/20 text-foreground"
                        : isSelected
                            ? "bg-accent/60 text-foreground"
                            : "text-[#cdd6f4]/70 hover:text-[#cdd6f4] hover:bg-[#313244]/60",
                    isDragOver && "outline outline-1 outline-primary/50 bg-primary/10 rounded-[2px]"
                )}
                style={{ paddingLeft: `${indentPx}px`, paddingRight: "4px" }}
                onClick={handleClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node.id); }}
                draggable
                onDragStart={(e) => onDragStart(e, node.id)}
                onDragOver={(e) => { e.preventDefault(); onDragOver(e, node.id); }}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, node.id)}
            >
                {/* Expand arrow */}
                <span className="w-4 flex items-center justify-center shrink-0 opacity-50">
                    {isFolder ? (
                        isExpanded
                            ? <ChevronDown className="h-3 w-3" />
                            : <ChevronRight className="h-3 w-3" />
                    ) : null}
                </span>

                <FileTypeIcon name={node.name} type={node.type} isOpen={isExpanded} />

                <span className="ml-1.5 flex-1 min-w-0 flex items-center">
                    {isRenaming ? (
                        <RenameInput
                            defaultValue={node.name}
                            onCommit={(name) => onRenameCommit(node.id, name)}
                            onCancel={onRenameCancel}
                        />
                    ) : (
                        <span className="text-[11.5px] truncate leading-none">{node.name}</span>
                    )}
                </span>

                {!isRenaming && (
                    <span className="opacity-0 group-hover:opacity-100 flex items-center shrink-0 mr-0.5">
                        <button
                            className="h-[18px] w-[18px] flex items-center justify-center rounded-[3px] hover:bg-muted/60 text-muted-foreground/40 hover:text-foreground transition-colors"
                            onClick={(e) => {
                                e.stopPropagation();
                                onContextMenu(e as unknown as React.MouseEvent, node.id);
                            }}
                        >
                            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                                <circle cx="8" cy="3.5" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="8" cy="12.5" r="1.2" />
                            </svg>
                        </button>
                    </span>
                )}
            </div>

            {/* Children */}
            {isFolder && isExpanded && (
                <div>
                    {newNodeState?.parentId === node.id && (
                        <NewNodeInput
                            type={newNodeState.type}
                            depth={depth + 1}
                            onCommit={onNewNodeCommit}
                            onCancel={onNewNodeCancel}
                        />
                    )}
                    {children.map((child) => (
                        <TreeNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            connectionId={connectionId}
                            activeFileId={activeFileId}
                            selectedNodeId={selectedNodeId}
                            expandedIds={expandedIds}
                            renamingId={renamingId}
                            dragOverId={dragOverId}
                            newNodeState={newNodeState}
                            searchQuery={searchQuery}
                            onActivate={onActivate}
                            onSelect={onSelect}
                            onToggle={onToggle}
                            onContextMenu={onContextMenu}
                            onRenameCommit={onRenameCommit}
                            onRenameCancel={onRenameCancel}
                            onDragStart={onDragStart}
                            onDragOver={onDragOver}
                            onDragLeave={onDragLeave}
                            onDrop={onDrop}
                            onNewNodeCommit={onNewNodeCommit}
                            onNewNodeCancel={onNewNodeCancel}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Main IdeFileTree ───────────────────────────────────────────────────────────

export interface IdeFileTreeProps {
    connectionId: string;
    databaseName: string;
    canEditFiles?: boolean;
    canDeleteFiles?: boolean;
    onOpenFile: (content: string, nodeId: string, name: string, options?: { openTarget?: FileOpenTarget }) => void;
}

export function IdeFileTree({
    connectionId,
    databaseName,
    canEditFiles = true,
    canDeleteFiles = true,
    onOpenFile,
}: IdeFileTreeProps) {
    const {
        nodes, expandedIds,
        getRootNodes, createNode, deleteNode, renameNode,
        moveNode, toggleFolder, setExpanded, setActiveFile, getActiveFile,
        collapseAll, ensureConnectionProject, duplicateNode,
    } = useIdeFsStore();

    const activeFileId = getActiveFile(connectionId);

    useEffect(() => {
        ensureConnectionProject(connectionId, databaseName);
    }, [connectionId, databaseName, ensureConnectionProject]);

    const rootNodes = useMemo(
        () => getRootNodes(connectionId),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [connectionId, nodes, getRootNodes]
    );

    // ── State ──────────────────────────────────────────────────────────────────
    /** Currently focused/highlighted node (VS Code "selected" concept) */
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [newNodeState, setNewNodeState] = useState<{ parentId: string | null; type: NodeType } | null>(null);
    const [dragNodeId, setDragNodeId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [showSearch, setShowSearch] = useState(false);
    const [showImporter, setShowImporter] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (showSearch) setTimeout(() => searchRef.current?.focus(), 30);
    }, [showSearch]);

    // ── Get effective parent for new node (VS Code behavior) ───────────────────
    // If a folder is selected → create inside it
    // If a file is selected → create beside it (same parent)
    // If nothing → create at root
    const getNewNodeParent = useCallback((): string | null => {
        if (!selectedNodeId) return null;
        const node = nodes[selectedNodeId];
        if (!node) return null;
        if (node.type === "folder") return node.id;
        return node.parentId;
    }, [selectedNodeId, nodes]);

    // ── Context menu ───────────────────────────────────────────────────────────
    const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string | null) => {
        e.preventDefault();
        e.stopPropagation();
        const x = Math.min(e.clientX, window.innerWidth - 180);
        const y = Math.min(e.clientY, window.innerHeight - 240);
        setContextMenu({ x, y, nodeId });
        if (nodeId) setSelectedNodeId(nodeId);
    }, []);

    // ── New node ───────────────────────────────────────────────────────────────
    const startNewNode = useCallback((parentId: string | null, type: NodeType) => {
        if (!canEditFiles) return;
        if (parentId) setExpanded(parentId, true);
        setNewNodeState({ parentId, type });
        setContextMenu(null);
    }, [canEditFiles, setExpanded]);

    const commitNewNode = useCallback((name: string) => {
        if (!canEditFiles) return;
        if (!newNodeState) return;
        const node = createNode(connectionId, name, newNodeState.type, newNodeState.parentId);
        setNewNodeState(null);
        setSelectedNodeId(node.id);
        if (newNodeState.type === "file") {
            setActiveFile(connectionId, node.id);
            onOpenFile(node.content, node.id, node.name, { openTarget: "active" });
        }
    }, [canEditFiles, newNodeState, connectionId, createNode, setActiveFile, onOpenFile]);

    // ── Select + activate ──────────────────────────────────────────────────────
    const handleSelect = useCallback((nodeId: string) => {
        setSelectedNodeId(nodeId);
    }, []);

    const handleActivate = useCallback((node: FsNode, target: FileOpenTarget = "active") => {
        setActiveFile(connectionId, node.id);
        onOpenFile(node.content, node.id, node.name, { openTarget: target });
    }, [connectionId, setActiveFile, onOpenFile]);

    // ── Rename ─────────────────────────────────────────────────────────────────
    const handleRenameCommit = useCallback((id: string, name: string) => {
        if (!canEditFiles) return;
        renameNode(id, name);
        setRenamingId(null);
    }, [canEditFiles, renameNode]);

    // ── Delete ─────────────────────────────────────────────────────────────────
    const handleDelete = useCallback((id: string) => {
        if (!canDeleteFiles) return;
        const node = nodes[id];
        if (!node) return;
        deleteNode(id);
        if (selectedNodeId === id) setSelectedNodeId(null);
        toast.success(`Deleted "${node.name}"`, { duration: 1200 });
    }, [canDeleteFiles, nodes, deleteNode, selectedNodeId]);

    // ── Drag & drop ────────────────────────────────────────────────────────────
    const handleDragStart = useCallback((e: React.DragEvent, nodeId: string) => {
        if (!canEditFiles) return;
        setDragNodeId(nodeId);
        const node = nodes[nodeId];
        if (node?.type === "file") {
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("application/x-helix-file-node", node.id);
        } else {
            e.dataTransfer.effectAllowed = "move";
        }
    }, [canEditFiles, nodes]);

    const handleDragOver = useCallback((e: React.DragEvent, nodeId: string) => {
        if (!canEditFiles) return;
        e.preventDefault();
        setDragOverId(nodeId);
    }, [canEditFiles]);

    const handleDrop = useCallback((e: React.DragEvent, targetId: string | null) => {
        if (!canEditFiles) return;
        e.preventDefault();
        const sourceId = dragNodeId;
        setDragNodeId(null);
        setDragOverId(null);
        if (!sourceId || sourceId === targetId) return;
        const target = targetId ? nodes[targetId] : null;
        const newParentId = target?.type === "folder" ? targetId : target?.parentId ?? null;
        moveNode(sourceId, newParentId);
    }, [canEditFiles, dragNodeId, nodes, moveNode]);

    // F2 to rename selected, Delete to delete selected
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
            if (canEditFiles && e.key === "F2" && selectedNodeId) setRenamingId(selectedNodeId);
            if (canDeleteFiles && e.key === "Delete" && selectedNodeId && !renamingId) {
                e.preventDefault();
                handleDelete(selectedNodeId);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selectedNodeId, renamingId, handleDelete, canEditFiles, canDeleteFiles]);

    const fileCount = useMemo(
        () => Object.values(nodes).filter((n) => n.connectionId === connectionId && n.type === "file").length,
        [nodes, connectionId]
    );

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center gap-0.5 px-2 h-8 border-b border-border/10 shrink-0">
                <span className="text-[10px] text-muted-foreground/30 font-mono flex-1 select-none">
                    {fileCount} file{fileCount !== 1 ? "s" : ""}
                </span>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => setShowSearch((v) => !v)}
                            className={cn(
                                "h-5 w-5 flex items-center justify-center rounded-[3px] transition-colors",
                                showSearch
                                    ? "text-primary bg-primary/15"
                                    : "text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
                            )}
                        >
                            <Search className="h-3 w-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[10px]">Search (F)</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => startNewNode(getNewNodeParent(), "file")}
                            disabled={!canEditFiles}
                            className={cn(
                                "h-5 w-5 flex items-center justify-center rounded-[3px] transition-colors",
                                canEditFiles
                                    ? "text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
                                    : "text-muted-foreground/20 cursor-not-allowed"
                            )}
                        >
                            <FilePlus className="h-3 w-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[10px]">New file</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => startNewNode(getNewNodeParent(), "folder")}
                            disabled={!canEditFiles}
                            className={cn(
                                "h-5 w-5 flex items-center justify-center rounded-[3px] transition-colors",
                                canEditFiles
                                    ? "text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
                                    : "text-muted-foreground/20 cursor-not-allowed"
                            )}
                        >
                            <FolderPlus className="h-3 w-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[10px]">New folder</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => collapseAll(connectionId)}
                            className="h-5 w-5 flex items-center justify-center rounded-[3px] text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
                        >
                            <RefreshCw className="h-3 w-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[10px]">Collapse all</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => setShowImporter(true)}
                            disabled={!canEditFiles}
                            className={cn(
                                "h-5 w-5 flex items-center justify-center rounded-[3px] transition-colors",
                                canEditFiles
                                    ? "text-muted-foreground/40 hover:text-primary hover:bg-primary/10"
                                    : "text-muted-foreground/20 cursor-not-allowed"
                            )}
                        >
                            <Download className="h-3 w-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[10px]">Import schema from database</TooltipContent>
                </Tooltip>
            </div>

            {/* Search bar */}
            {showSearch && (
                <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/10 shrink-0 bg-background/30">
                    <Search className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                    <input
                        ref={searchRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Filter files…"
                        className="flex-1 min-w-0 text-[11px] bg-transparent text-foreground/80 placeholder:text-muted-foreground/25 focus:outline-none"
                    />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery("")} className="text-muted-foreground/30 hover:text-foreground">
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            )}

            {/* DB breadcrumb */}
            <div className="flex items-center gap-1.5 px-3 h-7 border-b border-border/10 shrink-0 bg-background/20">
                <Database className="h-2.5 w-2.5 text-muted-foreground/25 shrink-0" />
                <span className="text-[10px] text-muted-foreground/30 truncate font-mono select-none">{databaseName}</span>
            </div>

            {/* Tree */}
            <ScrollArea className="flex-1 min-h-0">
                <div
                    className="py-0.5 min-h-full"
                    onClick={() => setSelectedNodeId(null)}
                    onContextMenu={(e) => {
                        if (e.target === e.currentTarget) handleContextMenu(e, null);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                        if (!canEditFiles) return;
                        e.preventDefault();
                        const sourceId = dragNodeId;
                        setDragNodeId(null);
                        setDragOverId(null);
                        if (sourceId) moveNode(sourceId, null);
                    }}
                >
                    {/* Root-level new node */}
                    {newNodeState?.parentId === null && (
                        <NewNodeInput
                            type={newNodeState.type}
                            depth={0}
                            onCommit={commitNewNode}
                            onCancel={() => setNewNodeState(null)}
                        />
                    )}

                    {rootNodes.length === 0 && !newNodeState ? (
                        <div className="flex flex-col items-center justify-center py-10 text-center px-4 gap-3">
                            <FolderPlus className="h-8 w-8 text-muted-foreground/15" />
                            <p className="text-[11px] text-muted-foreground/35">No files yet</p>
                            <div className="flex gap-1.5">
                                <Button size="sm" variant="outline"
                                    className="h-6 text-[10px] gap-1 border-border/20 hover:bg-accent/40"
                                    disabled={!canEditFiles}
                                    onClick={() => startNewNode(null, "file")}>
                                    <FilePlus className="h-3 w-3" /> New file
                                </Button>
                                <Button size="sm" variant="outline"
                                    className="h-6 text-[10px] gap-1 border-border/20 hover:bg-accent/40"
                                    disabled={!canEditFiles}
                                    onClick={() => startNewNode(null, "folder")}>
                                    <FolderPlus className="h-3 w-3" /> New folder
                                </Button>
                            </div>
                        </div>
                    ) : (
                        rootNodes.map((node) => (
                            <TreeNode
                                key={node.id}
                                node={node}
                                depth={0}
                                connectionId={connectionId}
                                activeFileId={activeFileId}
                                selectedNodeId={selectedNodeId}
                                expandedIds={expandedIds}
                                renamingId={renamingId}
                                dragOverId={dragOverId}
                                newNodeState={newNodeState}
                                searchQuery={searchQuery}
                                onActivate={handleActivate}
                                onSelect={handleSelect}
                                onToggle={toggleFolder}
                                onContextMenu={handleContextMenu}
                                onRenameCommit={handleRenameCommit}
                                onRenameCancel={() => setRenamingId(null)}
                                onDragStart={handleDragStart}
                                onDragOver={handleDragOver}
                                onDragLeave={() => setDragOverId(null)}
                                onDrop={handleDrop}
                                onNewNodeCommit={commitNewNode}
                                onNewNodeCancel={() => setNewNodeState(null)}
                            />
                        ))
                    )}
                </div>
            </ScrollArea>

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    state={contextMenu}
                    onClose={() => setContextMenu(null)}
                    onNewFile={(parentId) => startNewNode(parentId, "file")}
                    onNewFolder={(parentId) => startNewNode(parentId, "folder")}
                    onRename={(id) => setRenamingId(id)}
                    onDelete={handleDelete}
                    onDuplicate={(id) => {
                        if (!canEditFiles) return;
                        duplicateNode(id);
                        toast.success("Duplicated", { duration: 900 });
                    }}
                    onOpen={handleActivate}
                    canEditFiles={canEditFiles}
                    canDeleteFiles={canDeleteFiles}
                />
            )}

            {/* Schema importer dialog */}
            <SchemaImporter
                open={showImporter}
                onClose={() => setShowImporter(false)}
                connectionId={connectionId}
                databaseName={databaseName}
            />
        </div>
    );
}
