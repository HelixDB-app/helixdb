"use client";

import { useEffect, useMemo, useState } from "react";
import { useLayoutStore, LayoutNode, PaneNode, SplitNode, TableTab } from "@/stores/layout-store";
import { useConnectionStore } from "@/stores/connection-store";
import { DataTable } from "@/components/data-table";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { X, LayoutPanelLeft, Columns, Rows, Plus, Database, Table2 } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";

function formatRecentAge(timestamp: number | string) {
    const d = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 0) return "just now";
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export function TableLayoutView() {
    const { root, setSizes } = useLayoutStore();
    const { isConnected } = useConnectionStore();

    if (!isConnected) return null;

    return (
        <div className="flex-1 h-full w-full bg-background overflow-hidden relative">
            <LayoutRenderer node={root} onSizesChange={setSizes} />
        </div>
    );
}

function LayoutRenderer({ node, onSizesChange }: { node: LayoutNode, onSizesChange: (id: string, sizes: number[]) => void }) {
    if (node.type === "pane") {
        return <PaneRenderer pane={node} />;
    }

    const splitNode = node as SplitNode;
    
    return (
        <ResizablePanelGroup 
            {...({ 
                direction: splitNode.direction, 
                onLayout: (sizes: number[]) => onSizesChange(splitNode.id, sizes) 
            } as any)}
            className="h-full w-full"
        >
            {splitNode.children.map((child, i) => (
                <div key={child.id} style={{ display: "contents" }}>
                    <ResizablePanel defaultSize={splitNode.sizes[i] || (100 / splitNode.children.length)}>
                        <LayoutRenderer node={child} onSizesChange={onSizesChange} />
                    </ResizablePanel>
                    {i < splitNode.children.length - 1 && (
                        <ResizableHandle className="w-[2px] transition-colors data-[resize-handle-active]:bg-emerald-500/60" />
                    )}
                </div>
            ))}
        </ResizablePanelGroup>
    );
}

function PaneRenderer({ pane }: { pane: PaneNode }) {
    const { 
        closeTab, 
        closeOtherTabs, 
        closeTabsToRight, 
        closeAllTabs, 
        setActiveTab, 
        splitPane, 
        activePaneId, 
        setActivePane, 
        openTab 
    } = useLayoutStore();
    const { recentTables } = useConnectionStore();
    
    // Drag and drop state
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [splitDirection, setSplitDirection] = useState<"left" | "right" | "top" | "bottom" | null>(null);

    const isActivePane = activePaneId === pane.id;

    const activeTab = useMemo(() => {
        return pane.tabs.find(t => t.id === pane.activeTabId) || null;
    }, [pane.tabs, pane.activeTabId]);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDraggingOver(true);
        
        // Calculate split direction based on mouse position relative to pane
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Use a 20% margin for triggering splits
        const thresholdX = rect.width * 0.2;
        const thresholdY = rect.height * 0.2;
        
        if (x < thresholdX) setSplitDirection("left");
        else if (x > rect.width - thresholdX) setSplitDirection("right");
        else if (y < thresholdY) setSplitDirection("top");
        else if (y > rect.height - thresholdY) setSplitDirection("bottom");
        else setSplitDirection(null);
    };

    const handleDragLeave = () => {
        setIsDraggingOver(false);
        setSplitDirection(null);
    };

    const handleDrop = (e: React.DragEvent) => {
        setIsDraggingOver(false);
        setSplitDirection(null);
        
        try {
            const data = e.dataTransfer.getData("application/json");
            if (!data) return;
            
            const tabData = JSON.parse(data);
            if (tabData.type === "tab") {
                const { tab, sourcePaneId } = tabData;
                
                if (splitDirection) {
                    const direction = splitDirection === "left" || splitDirection === "right" ? "horizontal" : "vertical";
                    // Actually, if we drop on left/top, the new pane needs to be First. Our store currently appends new pane.
                    // To keep it simple, let's just use the store's splitPane which drops it as the 2nd child.
                    splitPane(pane.id, direction, tab);
                    
                    // We should also remove it from the source if it was moved, not duplicated.
                    // For now, let's assume dragging means moving.
                    if (sourcePaneId) closeTab(sourcePaneId, tab.id);
                } else if (sourcePaneId !== pane.id) {
                    // Move to this pane
                    useLayoutStore.getState().moveTab(sourcePaneId, pane.id, tab.id);
                }
            }
        } catch (err) {
            console.error("Drop failed", err);
        }
    };

    if (pane.tabs.length === 0) {
        return (
            <div 
                className={cn(
                    "flex h-full w-full flex-col items-center justify-center px-6 text-muted-foreground select-none bg-background border",
                    isActivePane ? "border-emerald-500/50" : "border-border/30"
                )}
                onClick={() => setActivePane(pane.id)}
            >
                <div className="flex flex-col items-center gap-3">
                    <div className="h-16 w-16 rounded-2xl bg-muted/20 flex items-center justify-center">
                        <Table2 className="h-8 w-8 opacity-20" />
                    </div>
                    <div className="text-center">
                        <p className="text-sm font-medium text-muted-foreground/70">Select an object</p>
                        <p className="text-xs mt-1 text-muted-foreground/40">
                            Choose a table, view, function, type, or event trigger from the sidebar
                        </p>
                    </div>
                </div>
                {recentTables.length > 0 && (
                    <div className="mt-8 w-full max-w-2xl rounded-xl border border-border/60 bg-card/40 p-3">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/55">
                            Recent Tables
                        </p>
                        <div className="grid gap-1 md:grid-cols-2">
                            {recentTables.slice(0, 8).map((item) => (
                                <button
                                    key={`${item.schema}.${item.table}`}
                                    type="button"
                                    onClick={() => openTab(item.schema, item.table)}
                                    className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-muted-foreground/70 hover:border-border hover:bg-muted/40 hover:text-foreground transition-all"
                                >
                                    <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
                                    <span className="truncate flex-1 font-mono text-xs">{item.table}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground/45">{item.schema}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground/45">{formatRecentAge(item.opened_at)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div 
            className={cn(
                "h-full w-full flex flex-col bg-background relative border",
                isActivePane ? "border-emerald-500/20" : "border-border/10"
            )}
            onClickCapture={() => setActivePane(pane.id)}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Tab Bar */}
            <div className="flex h-[38px] min-h-[38px] bg-muted/20 border-b border-border/30 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden shrink-0">
                {pane.tabs.map((tab, idx) => {
                    const isActive = tab.id === pane.activeTabId;
                    const canCloseRight = idx < pane.tabs.length - 1;
                    const isOnlyTab = pane.tabs.length === 1;

                    return (
                        <ContextMenu.Root key={tab.id}>
                            <ContextMenu.Trigger asChild>
                                <div
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData("application/json", JSON.stringify({ type: "tab", tab, sourcePaneId: pane.id }));
                                    }}
                                    onClick={() => setActiveTab(pane.id, tab.id)}
                                    className={cn(
                                        "group flex items-center justify-between min-w-[124px] max-w-[200px] h-full px-3.5 text-[12.5px] font-mono select-none cursor-pointer border-r border-border/30 transition-all relative mt-[2px] rounded-t-lg mx-0.5",
                                        isActive 
                                            ? "bg-background text-emerald-400 border-t border-t-emerald-500/30 border-x border-x-border/40 shadow-[0_-2px_6px_rgba(0,0,0,0.1)] z-10 before:absolute before:-bottom-[2px] before:left-0 before:right-0 before:h-[2px] before:bg-background" 
                                            : "bg-transparent text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground border-transparent border-t border-t-transparent"
                                    )}
                                >
                                    <span className="truncate pr-2 mt-px">{tab.table}</span>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            closeTab(pane.id, tab.id);
                                        }}
                                        className={cn(
                                            "p-0.5 rounded transition-all opacity-0 group-hover:opacity-100 hover:bg-muted/40",
                                            isActive && "opacity-100" // Always show close on active tab
                                        )}
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            </ContextMenu.Trigger>
                            <ContextMenu.Portal>
                                <ContextMenu.Content className="min-w-[160px] bg-background/95 backdrop-blur border border-border/50 rounded-md p-1 shadow-lg text-sm font-mono z-50">
                                    <ContextMenu.Item 
                                        className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-muted focus:bg-muted"
                                        onClick={() => closeTab(pane.id, tab.id)}
                                    >
                                        Close
                                    </ContextMenu.Item>
                                    <ContextMenu.Item 
                                        className={cn(
                                            "flex select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors",
                                            isOnlyTab ? "text-muted-foreground/50 cursor-not-allowed" : "cursor-pointer hover:bg-muted focus:bg-muted"
                                        )}
                                        disabled={isOnlyTab}
                                        onClick={() => {
                                            if (!isOnlyTab) closeOtherTabs(pane.id, tab.id);
                                        }}
                                    >
                                        Close Others
                                    </ContextMenu.Item>
                                    <ContextMenu.Item 
                                        className={cn(
                                            "flex select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors",
                                            !canCloseRight ? "text-muted-foreground/50 cursor-not-allowed" : "cursor-pointer hover:bg-muted focus:bg-muted"
                                        )}
                                        disabled={!canCloseRight}
                                        onClick={() => {
                                            if (canCloseRight) closeTabsToRight(pane.id, tab.id);
                                        }}
                                    >
                                        Close to the Right
                                    </ContextMenu.Item>
                                    <ContextMenu.Separator className="h-px bg-border/40 my-1" />
                                    <ContextMenu.Item 
                                        className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-muted focus:bg-muted"
                                        onClick={() => closeAllTabs(pane.id)}
                                    >
                                        Close All
                                    </ContextMenu.Item>
                                </ContextMenu.Content>
                            </ContextMenu.Portal>
                        </ContextMenu.Root>
                    );
                })}
            </div>
            
            {/* Action Bar (Split options overlay) */}
            {activeTab && (
                <div className="absolute top-10 right-4 z-10 flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity bg-background/80 backdrop-blur rounded p-1 shadow border border-border/50">
                    <button 
                        onClick={() => splitPane(pane.id, "horizontal", activeTab)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="Split Right"
                    >
                        <Columns className="h-3.5 w-3.5" />
                    </button>
                    <button 
                        onClick={() => splitPane(pane.id, "vertical", activeTab)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="Split Down"
                    >
                        <Rows className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {/* Split Drag Overlay */}
            {isDraggingOver && splitDirection && (
                <div className={cn(
                    "absolute pointer-events-none bg-emerald-500/20 border border-emerald-500/50 z-50 transition-all",
                    splitDirection === "left" && "top-0 bottom-0 left-0 w-1/2",
                    splitDirection === "right" && "top-0 bottom-0 right-0 w-1/2",
                    splitDirection === "top" && "top-0 left-0 right-0 h-1/2",
                    splitDirection === "bottom" && "bottom-0 left-0 right-0 h-1/2"
                )} />
            )}

            {/* Content Area */}
            <div className="flex-1 w-full h-full min-h-0 relative">
                {activeTab ? (
                    <DataTable key={activeTab.id} schema={activeTab.schema} table={activeTab.table} />
                ) : (
                    <div className="flex h-full items-center justify-center">
                        <span className="text-muted-foreground font-mono text-sm max-w-sm text-center">
                            Close tab or split pane to continue
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
