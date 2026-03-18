"use client";

import { Loader2, Plus, Terminal, X } from "lucide-react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { QueryTab } from "@/stores/query-store";

export interface QueryTabBarProps {
    tabs: QueryTab[];
    activeTabId: string | null;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onNewTab: () => void;
    extraActions?: React.ReactNode;
    /** Optional: map from tabId -> fileId to show unsaved dot */
    tabFileMap?: Record<string, string>;
    savedFileSqlMap?: Record<string, string>;
}

export function QueryTabBar({
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    onNewTab,
    extraActions,
    tabFileMap = {},
    savedFileSqlMap = {},
}: QueryTabBarProps) {
    function isUnsaved(tab: QueryTab): boolean {
        const fileId = tabFileMap[tab.id];
        if (!fileId) return false;
        const savedSql = savedFileSqlMap[fileId];
        if (savedSql === undefined) return false;
        return savedSql !== tab.sql;
    }

    return (
        <div className="flex items-center border-b border-border/30 bg-muted/20 shrink-0 min-h-0">
            <ScrollArea className="flex-1 overflow-hidden">
                <div className="flex items-end h-9 px-1">
                    {tabs.map((tab) => {
                        const active = tab.id === activeTabId;
                        const unsaved = isUnsaved(tab);
                        return (
                            <div
                                key={tab.id}
                                className={cn(
                                    "group relative flex items-center gap-1.5 px-3 h-full cursor-pointer select-none transition-all min-w-0 max-w-[160px] mt-[2px] rounded-t-lg mx-0.5",
                                    active
                                        ? "bg-background text-emerald-400 border-t border-t-emerald-500/30 border-x border-x-border/40 shadow-[0_-2px_6px_rgba(0,0,0,0.1)] z-10 before:absolute before:-bottom-[2px] before:left-0 before:right-0 before:h-[2px] before:bg-background"
                                        : "bg-transparent text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground border-transparent border-t border-t-transparent border-x border-x-transparent"
                                )}
                                onClick={() => onSelectTab(tab.id)}
                            >
                                <Terminal className="h-3 w-3 shrink-0 opacity-60" />
                                <span className="text-xs truncate flex-1 min-w-0 leading-none">
                                    {tab.title}
                                </span>

                                {/* Unsaved dot / spinner / close */}
                                <span className="shrink-0 flex items-center">
                                    {tab.isExecuting ? (
                                        <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                                    ) : unsaved ? (
                                        <span className="h-3 w-3 flex items-center justify-center">
                                            <span className="h-1.5 w-1.5 rounded-full bg-foreground/60 group-hover:hidden" />
                                            <button
                                                className="hidden group-hover:flex items-center justify-center h-3 w-3 rounded-sm hover:bg-muted/60 hover:text-destructive transition-colors"
                                                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                                                aria-label="Close tab"
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </button>
                                        </span>
                                    ) : (
                                        <button
                                            className="h-3 w-3 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-muted/60 hover:text-destructive transition-all"
                                            onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                                            aria-label="Close tab"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
                <ScrollBar orientation="horizontal" className="h-1" />
            </ScrollArea>

            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        onClick={() => onNewTab()}
                        className="h-9 px-3 flex items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0 border-l border-border/20"
                        aria-label="New tab"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                </TooltipTrigger>
                <TooltipContent>New query tab</TooltipContent>
            </Tooltip>

            {extraActions}
        </div>
    );
}
