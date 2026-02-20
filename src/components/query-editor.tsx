"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryStore } from "@/stores/query-store";
import { useConnectionStore } from "@/stores/connection-store";
import { formatCellValue } from "@/lib/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MonacoSqlEditor } from "@/components/monaco-sql-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Play,
    Plus,
    X,
    Loader2,
    Clock,
    Rows3,
    AlertCircle,
    CheckCircle2,
    Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function QueryEditor() {
    const { connectionId } = useConnectionStore();
    const {
        tabs,
        activeTabId,
        addTab,
        removeTab,
        setActiveTab,
        updateSql,
        executeQuery,
    } = useQueryStore();

    const activeTab = tabs.find((t) => t.id === activeTabId);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

    // Add initial tab if none exist
    useEffect(() => {
        if (tabs.length === 0) {
            addTab();
        }
    }, [tabs.length, addTab]);

    // ⌘+Shift+P / Ctrl+Shift+P command palette
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
                e.preventDefault();
                setCommandPaletteOpen((open) => !open);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const handleExecute = useCallback(() => {
        if (!connectionId || !activeTabId) return;
        executeQuery(connectionId, activeTabId);
    }, [connectionId, activeTabId, executeQuery]);

    const runCommand = useCallback(
        (cmd: "run" | "new-tab" | "close-tab") => {
            setCommandPaletteOpen(false);
            if (cmd === "run") handleExecute();
            else if (cmd === "new-tab") addTab();
            else if (cmd === "close-tab" && activeTabId) removeTab(activeTabId);
        },
        [handleExecute, addTab, activeTabId, removeTab]
    );

    return (
        <div className="flex h-full flex-col">
            <Dialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
                <DialogContent className="sm:max-w-md gap-0 p-0">
                    <DialogTitle className="sr-only">Command palette</DialogTitle>
                    <div className="px-2 py-2 border-b border-border/30 text-xs text-muted-foreground font-mono">
                        Run a command
                    </div>
                    <div className="max-h-[280px] overflow-auto">
                        {[
                            { id: "run" as const, label: "Run Query", shortcut: "⌘+Enter" },
                            { id: "new-tab" as const, label: "New Tab", shortcut: "" },
                            { id: "close-tab" as const, label: "Close Tab", shortcut: "" },
                        ].map(({ id, label, shortcut }) => (
                            <button
                                key={id}
                                type="button"
                                className="w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left text-sm rounded-md hover:bg-accent"
                                onClick={() => runCommand(id)}
                            >
                                <span>{label}</span>
                                {shortcut && (
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                        {shortcut}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>
            {/* Tab bar */}
            <div className="flex items-center border-b border-border/30 bg-card/30">
                <ScrollArea className="flex-1">
                    <div className="flex items-center px-2 py-1.5 gap-1">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                className={cn(
                                    "group flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-all",
                                    "hover:bg-accent/50",
                                    tab.id === activeTabId
                                        ? "bg-accent text-accent-foreground shadow-sm"
                                        : "text-muted-foreground"
                                )}
                                onClick={() => setActiveTab(tab.id)}
                            >
                                <Terminal className="h-3 w-3 shrink-0" />
                                <span className="max-w-24 truncate">{tab.title}</span>
                                {tab.isExecuting && (
                                    <Loader2 className="h-3 w-3 animate-spin text-emerald-400 shrink-0" />
                                )}
                                <button
                                    className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        removeTab(tab.id);
                                    }}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </button>
                        ))}
                    </div>
                    <ScrollBar orientation="horizontal" />
                </ScrollArea>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 mx-2 shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => addTab()}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>New query tab</TooltipContent>
                </Tooltip>
            </div>

            {/* Editor area */}
            {activeTab && (
                <>
                    <div className="relative border-b border-border/30">
                        <MonacoSqlEditor
                            value={activeTab.sql}
                            onChange={(v) => updateSql(activeTab.id, v)}
                            onExecute={handleExecute}
                            disabled={activeTab.isExecuting}
                            className="rounded-none border-0"
                        />
                        <div className="absolute bottom-2 right-2 flex items-center gap-2 z-10">
                            <span className="text-[10px] text-muted-foreground/40 font-mono">
                                ⌘+Enter to run
                            </span>
                            <Button
                                size="sm"
                                className="h-8 gap-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-md shadow-emerald-600/20"
                                onClick={handleExecute}
                                disabled={activeTab.isExecuting || !activeTab.sql.trim()}
                            >
                                {activeTab.isExecuting ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Play className="h-3.5 w-3.5" />
                                )}
                                Run
                            </Button>
                        </div>
                    </div>

                    {/* Results */}
                    <div className="flex-1 overflow-hidden">
                        {activeTab.result ? (
                            activeTab.result.is_error ? (
                                <div className="p-4">
                                    <div className="flex items-start gap-3 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3">
                                        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                                        <div>
                                            <p className="text-sm font-medium text-destructive">
                                                Query Error
                                            </p>
                                            <p className="mt-1 text-xs font-mono text-destructive/80">
                                                {activeTab.result.error_message}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex h-full flex-col">
                                    {/* Result info bar */}
                                    <div className="flex items-center gap-3 px-4 py-2 border-b border-border/20 bg-card/20">
                                        <div className="flex items-center gap-1.5">
                                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                            <span className="text-xs font-medium text-emerald-400">
                                                Success
                                            </span>
                                        </div>
                                        <Badge variant="secondary" className="text-[10px] font-mono gap-1">
                                            <Rows3 className="h-3 w-3" />
                                            {activeTab.result.row_count} rows
                                        </Badge>
                                        <Badge variant="outline" className="text-[10px] font-mono gap-1 border-emerald-500/20 text-emerald-400">
                                            <Clock className="h-3 w-3" />
                                            {activeTab.result.execution_time_ms.toFixed(1)}ms
                                        </Badge>
                                    </div>

                                    {/* Result table */}
                                    <ScrollArea className="flex-1">
                                        <Table>
                                            <TableHeader>
                                                <TableRow className="hover:bg-transparent border-border/30">
                                                    <TableHead className="w-12 text-center text-[10px] font-mono text-muted-foreground/50">
                                                        #
                                                    </TableHead>
                                                    {activeTab.result.columns.map((col) => (
                                                        <TableHead
                                                            key={col.name}
                                                            className="whitespace-nowrap"
                                                        >
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="text-xs font-semibold">
                                                                    {col.name}
                                                                </span>
                                                                <span className="text-[10px] font-mono text-muted-foreground/40">
                                                                    {col.data_type}
                                                                </span>
                                                            </div>
                                                        </TableHead>
                                                    ))}
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {activeTab.result.rows.map((row, rowIdx) => (
                                                    <TableRow
                                                        key={rowIdx}
                                                        className="border-border/20 hover:bg-accent/30 transition-colors"
                                                    >
                                                        <TableCell className="text-center text-[10px] font-mono text-muted-foreground/40">
                                                            {rowIdx + 1}
                                                        </TableCell>
                                                        {row.map((cell, colIdx) => (
                                                            <TableCell
                                                                key={colIdx}
                                                                className={cn(
                                                                    "text-xs font-mono max-w-xs truncate",
                                                                    cell.type === "Null" &&
                                                                    "text-muted-foreground/30 italic"
                                                                )}
                                                            >
                                                                {formatCellValue(cell)}
                                                            </TableCell>
                                                        ))}
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                        <ScrollBar orientation="horizontal" />
                                    </ScrollArea>
                                </div>
                            )
                        ) : activeTab.isExecuting ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="flex items-center gap-3">
                                    <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
                                    <span className="text-sm text-muted-foreground">
                                        Executing query...
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                                <Terminal className="h-12 w-12 mb-3 opacity-15" />
                                <p className="text-sm font-medium">Run a query</p>
                                <p className="text-xs mt-1 opacity-60">
                                    Write SQL above and press ⌘+Enter
                                </p>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
