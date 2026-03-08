"use client";

import {
    AlignLeft,
    FileText,
    GitBranch,
    Loader2,
    Maximize2,
    Minimize2,
    Play,
    Shield,
    ShieldCheck,
    StickyNote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface QueryToolbarProps {
    isExecuting: boolean;
    isReviewLoading: boolean;
    isExplaining: boolean;
    hasSql: boolean;
    isSandboxMode: boolean;
    isSandboxBusy: boolean;
    isSandboxReviewing: boolean;
    aiReviewEnabled: boolean;
    isFullScreen: boolean;
    onRun: () => void;
    onReview: () => void;
    onFormat: () => void;
    onExplain: () => void;
    onRunFile: () => void;
    onSaveNote: () => void;
    onToggleFullScreen: () => void;
    onToggleSandbox: () => void;
}

export function QueryToolbar({
    isExecuting,
    isReviewLoading,
    isExplaining,
    hasSql,
    isSandboxMode,
    isSandboxBusy,
    isSandboxReviewing,
    aiReviewEnabled,
    isFullScreen,
    onRun,
    onReview,
    onFormat,
    onExplain,
    onRunFile,
    onSaveNote,
    onToggleFullScreen,
    onToggleSandbox,
}: QueryToolbarProps) {
    const isBusy = isExecuting || isSandboxBusy || isSandboxReviewing;

    return (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/20 bg-card/20 shrink-0">
            {/* Left actions */}
            <div className="flex items-center gap-0.5">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-xs px-2 text-muted-foreground hover:text-foreground"
                            onClick={onFormat}
                            disabled={!hasSql || isExecuting}
                        >
                            <AlignLeft className="h-3.5 w-3.5" />
                            Format
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Format SQL (⇧⌥F)</TooltipContent>
                </Tooltip>

                <Separator orientation="vertical" className="h-4 mx-0.5" />

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "h-7 gap-1.5 text-xs px-2",
                                aiReviewEnabled
                                    ? "text-muted-foreground hover:text-foreground"
                                    : "text-muted-foreground/40 cursor-not-allowed"
                            )}
                            onClick={onReview}
                            disabled={!hasSql || isExecuting || isReviewLoading || !aiReviewEnabled}
                        >
                            {isReviewLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Shield className="h-3.5 w-3.5" />
                            )}
                            Review
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {aiReviewEnabled ? "AI Review (⌘R)" : "AI Review disabled — enable in Settings"}
                    </TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-xs px-2 text-muted-foreground hover:text-foreground"
                            onClick={onExplain}
                            disabled={isExplaining || isExecuting || !hasSql}
                        >
                            {isExplaining ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <GitBranch className="h-3.5 w-3.5" />
                            )}
                            Explain
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>EXPLAIN ANALYZE — visualise query plan</TooltipContent>
                </Tooltip>

                <Separator orientation="vertical" className="h-4 mx-0.5" />

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-xs px-2 text-muted-foreground hover:text-sky-400"
                            onClick={onRunFile}
                            disabled={isExecuting}
                        >
                            <FileText className="h-3.5 w-3.5" />
                            Run file
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Load a .sql file and run</TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-xs px-2 text-muted-foreground hover:text-amber-400"
                            onClick={onSaveNote}
                            disabled={!hasSql || isExecuting}
                        >
                            <StickyNote className="h-3.5 w-3.5" />
                            Note
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Save as note</TooltipContent>
                </Tooltip>
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-1.5">
                {/* Sandbox toggle */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "h-7 gap-1.5 px-2 text-[11px] font-medium transition-all",
                                isSandboxMode
                                    ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30"
                                    : "text-muted-foreground hover:text-foreground border border-transparent"
                            )}
                            onClick={onToggleSandbox}
                        >
                            {isSandboxMode ? <ShieldCheck className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                            Sandbox
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {isSandboxMode
                            ? "Sandbox ON — queries run in a transaction. Click to disable."
                            : "Enable sandbox mode — preview changes before committing"}
                    </TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground"
                            onClick={onToggleFullScreen}
                        >
                            {isFullScreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{isFullScreen ? "Exit full screen (Esc)" : "Full-screen editor"}</TooltipContent>
                </Tooltip>

                <Separator orientation="vertical" className="h-4" />

                {/* Run button */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="sm"
                            className={cn(
                                "h-7 gap-1.5 text-xs text-white font-medium shadow-sm",
                                isSandboxMode
                                    ? "bg-emerald-700 hover:bg-emerald-600 shadow-emerald-700/20"
                                    : "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/20"
                            )}
                            onClick={onRun}
                            disabled={isBusy || isReviewLoading || !hasSql}
                        >
                            {isExecuting || isSandboxBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : isSandboxMode ? (
                                <ShieldCheck className="h-3.5 w-3.5" />
                            ) : (
                                <Play className="h-3.5 w-3.5" />
                            )}
                            {isSandboxMode ? "Run in Sandbox" : "Run"}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {isSandboxMode ? "Run in sandbox (⌘+Enter)" : "Run query (⌘+Enter)"}
                    </TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
}
