"use client";

import type { QueryHistoryEntry } from "@/stores/query-store";
import {
    FolderOpen,
    GitBranch,
    History,
    LayoutTemplate,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { QueryHistorySidebar } from "@/components/query-history-sidebar";
import { QueryTemplates } from "@/components/query-templates";
import { IdeFileTree } from "@/components/ide-file-tree";

export type SidebarPanel = "files" | "templates" | "history" | "git";
export type QueryOpenTarget = "active" | "split-left" | "split-right" | "new-split";

export interface QueryLoadSqlOptions {
    fromFileId?: string;
    fileName?: string;
    openTarget?: QueryOpenTarget;
    sourceGroupId?: string;
}

export interface QuerySidebarProps {
    activePanel: SidebarPanel;
    history: QueryHistoryEntry[];
    onLoadSql: (sql: string, options?: QueryLoadSqlOptions) => void;
    onRerunSql: (sql: string) => void;
    onClearHistory: () => void;
    onDeleteHistoryEntry: (id: string) => void;
    schemaContext?: { tables: string[]; columns: Record<string, string[]> };
    connectionId: string;
    databaseName: string;
}

export function QuerySidebar({
    activePanel,
    history,
    onLoadSql,
    onRerunSql,
    onClearHistory,
    onDeleteHistoryEntry,
    schemaContext,
    connectionId,
    databaseName,
}: QuerySidebarProps) {
    return (
        <div className="flex flex-col h-full border-r border-border/25 bg-card/20 w-full">
            {/* Panel header */}
            <div className="px-3 py-2 border-b border-border/20 shrink-0">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {activePanel === "files" && "Explorer"}
                    {activePanel === "templates" && "Templates"}
                    {activePanel === "history" && "Query History"}
                    {activePanel === "git" && "Source Control"}
                </span>
            </div>

            {/* Panel content */}
            <div className="flex-1 min-h-0 overflow-hidden">
                {activePanel === "files" && (
                    <IdeFileTree
                        connectionId={connectionId}
                        databaseName={databaseName}
                        onOpenFile={(content, nodeId, name, options) =>
                            onLoadSql(content, {
                                fromFileId: nodeId,
                                fileName: name,
                                openTarget: options?.openTarget ?? "active",
                            })
                        }
                    />
                )}
                {activePanel === "templates" && (
                    <QueryTemplates
                        onUseTemplate={(sql) => onLoadSql(sql)}
                        schemaContext={schemaContext}
                    />
                )}
                {activePanel === "history" && (
                    <QueryHistorySidebar
                        history={history}
                        onLoadSql={onLoadSql}
                        onRerunSql={onRerunSql}
                        onClearHistory={onClearHistory}
                        onDeleteEntry={onDeleteHistoryEntry}
                    />
                )}
            </div>
        </div>
    );
}

// ── Activity Bar ────────────────────────────────────────────────────────────

const PANELS: { id: SidebarPanel; Icon: React.FC<{ className?: string }>; label: string; accent?: string }[] = [
    { id: "files", Icon: FolderOpen, label: "SQL Files" },
    { id: "templates", Icon: LayoutTemplate, label: "Templates" },
    { id: "history", Icon: History, label: "Query History" },
    { id: "git", Icon: GitBranch, label: "Source Control", accent: "text-emerald-400" },
];

export interface QueryActivityBarProps {
    activePanel: SidebarPanel | null;
    onToggle: (panel: SidebarPanel) => void;
}

export function QueryActivityBar({ activePanel, onToggle }: QueryActivityBarProps) {
    return (
        <div className="flex flex-col items-center py-2 gap-1 border-r border-border/25 bg-card/30 w-10 shrink-0">
            {PANELS.map(({ id, Icon, label, accent }) => (
                <Tooltip key={id}>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => onToggle(id)}
                            className={cn(
                                "w-8 h-8 flex items-center justify-center rounded-md transition-colors",
                                activePanel === id
                                    ? id === "git"
                                        ? "bg-emerald-500/15 text-emerald-400"
                                        : "bg-primary/15 text-primary"
                                    : cn("text-muted-foreground/50 hover:text-foreground hover:bg-muted/40", accent && `hover:${accent}`)
                            )}
                            aria-label={label}
                        >
                            <Icon className="h-4 w-4" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                </Tooltip>
            ))}
        </div>
    );
}
