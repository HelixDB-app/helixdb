"use client";

import { useMemo, useState } from "react";
import type { QueryHistoryEntry } from "@/stores/query-store";
import { Copy, History, Play, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function timeAgo(ms: number): string {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
}

export interface QueryHistorySidebarProps {
    history: QueryHistoryEntry[];
    onLoadSql: (sql: string) => void;
    onRerunSql: (sql: string) => void;
    onClearHistory: () => void;
    onDeleteEntry: (id: string) => void;
}

export function QueryHistorySidebar({
    history,
    onLoadSql,
    onRerunSql,
    onClearHistory,
    onDeleteEntry,
}: QueryHistorySidebarProps) {
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | "success" | "error">("all");

    const filtered = useMemo(() => {
        return history.filter((e) => {
            const matchesSearch = !search || e.sql.toLowerCase().includes(search.toLowerCase());
            const matchesFilter =
                filter === "all" ||
                (filter === "success" && !e.isError) ||
                (filter === "error" && e.isError);
            return matchesSearch && matchesFilter;
        });
    }, [history, search, filter]);

    return (
        <div className="flex flex-col h-full">
            {/* Search + filter */}
            <div className="p-2 space-y-1.5 border-b border-border/20 shrink-0">
                <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search history…"
                        className="w-full pl-6 pr-2 py-1.5 text-[11px] bg-muted/20 border border-border/20 rounded-md text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus:border-border/50 focus:bg-muted/30 transition-colors"
                    />
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-0.5">
                        {(["all", "success", "error"] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={cn(
                                    "px-2 py-0.5 text-[10px] rounded transition-colors capitalize",
                                    filter === f
                                        ? f === "error"
                                            ? "bg-destructive/15 text-destructive border border-destructive/20"
                                            : f === "success"
                                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                                : "bg-muted/50 text-foreground/70 border border-border/30"
                                        : "text-muted-foreground/50 hover:text-muted-foreground border border-transparent"
                                )}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    {history.length > 0 && (
                        <button
                            onClick={onClearHistory}
                            className="text-[10px] text-muted-foreground/40 hover:text-destructive/70 transition-colors"
                        >
                            Clear all
                        </button>
                    )}
                </div>
            </div>

            <ScrollArea className="flex-1 min-h-0">
                {history.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                        <History className="h-7 w-7 text-muted-foreground/20 mb-2" />
                        <p className="text-xs text-muted-foreground/40">No queries yet</p>
                        <p className="text-[10px] text-muted-foreground/30 mt-0.5">Executed queries appear here</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                        <Search className="h-5 w-5 text-muted-foreground/20 mb-2" />
                        <p className="text-xs text-muted-foreground/40">No matches</p>
                    </div>
                ) : (
                    <div className="divide-y divide-border/10">
                        {filtered.map((entry) => (
                            <div
                                key={entry.id}
                                className="group flex items-start gap-2 px-3 py-2 hover:bg-accent/20 transition-colors cursor-pointer"
                                onClick={() => onLoadSql(entry.sql)}
                                title="Click to load into editor"
                            >
                                <div
                                    className={cn(
                                        "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                                        entry.isError ? "bg-destructive" : "bg-emerald-500"
                                    )}
                                />
                                <div className="flex-1 min-w-0">
                                    <p className="text-[11px] font-mono text-foreground/80 truncate leading-relaxed">
                                        {entry.sql.replace(/\s+/g, " ").slice(0, 80)}
                                        {entry.sql.length > 80 ? "…" : ""}
                                    </p>
                                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                        <span className="text-[10px] text-muted-foreground/40">{timeAgo(entry.executedAt)}</span>
                                        {!entry.isError && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] font-mono text-muted-foreground/40">{entry.executionTimeMs.toFixed(0)}ms</span>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] font-mono text-muted-foreground/40">{entry.rowCount} rows</span>
                                            </>
                                        )}
                                        {entry.isError && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] text-destructive/60">error</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                                                onClick={(e) => { e.stopPropagation(); onRerunSql(entry.sql); }}
                                            >
                                                <Play className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>Re-run</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/60 transition-colors"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    navigator.clipboard.writeText(entry.sql);
                                                    toast.success("Copied", { duration: 1200 });
                                                }}
                                            >
                                                <Copy className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>Copy SQL</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                onClick={(e) => { e.stopPropagation(); onDeleteEntry(entry.id); }}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>Delete</TooltipContent>
                                    </Tooltip>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}
