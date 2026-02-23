"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryStore } from "@/stores/query-store";
import type { QueryHistoryEntry } from "@/stores/query-store";
import { useSandboxStore } from "@/stores/sandbox-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useNotesStore } from "@/stores/notes-store";
import { formatCellValue } from "@/lib/types";
import type { QueryResult } from "@/lib/types";
import { dbGetColumns, dbExplainQuery, dbExecuteQuery } from "@/lib/tauri";
import { NotesPanel } from "@/components/notes-panel";
import { QueryPlanViewer } from "@/components/query-plan-viewer";
import { SandboxDiffViewer } from "@/components/sandbox-diff-viewer";
import { DataCanvas } from "@/components/data-canvas";
import { format as formatSQL } from "sql-formatter";
import { MonacoSqlEditor } from "@/components/monaco-sql-editor";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Play,
    Plus,
    X,
    Loader2,
    Clock,
    AlertCircle,
    CheckCircle2,
    Terminal,
    Copy,
    Lightbulb,
    History,
    Trash2,
    Download,
    FileText,
    Braces,
    ChevronDown,
    RotateCcw,
    XCircle,
    AlignLeft,
    Search,
    Filter,
    GitBranch,
    Shield,
    ShieldCheck,
    ShieldOff,
    LayoutDashboard,
    StickyNote,
    Save,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
}

/** True when backend returned a single "affected_rows" column (INSERT/UPDATE/DELETE). */
function isCommandResult(result: QueryResult): boolean {
    return (
        result.columns.length === 1 &&
        result.columns[0].name === "affected_rows" &&
        result.rows.length === 1
    );
}

/** Display count: for command results use the cell value; for SELECT use row_count. */
function getDisplayCount(result: QueryResult): number {
    if (isCommandResult(result)) {
        const cell = result.rows[0]?.[0];
        if (cell && "value" in cell && typeof cell.value === "number") return cell.value;
    }
    return result.row_count;
}

/** Human-readable row summary: "2 rows affected" vs "3 rows returned". */
function getRowCountLabel(result: QueryResult): string {
    const n = getDisplayCount(result);
    const affected = isCommandResult(result);
    if (n === 1) return affected ? "1 row affected" : "1 row returned";
    return affected ? `${n.toLocaleString()} rows affected` : `${n.toLocaleString()} rows returned`;
}

function exportResultToCSV(result: QueryResult): string {
    const escapeCSV = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = result.columns.map((c) => escapeCSV(c.name)).join(",");
    const body = result.rows
        .map((row) =>
            row
                .map((cell) => (cell.type === "Null" ? "" : escapeCSV(formatCellValue(cell))))
                .join(",")
        )
        .join("\n");
    return header + "\n" + body;
}

function exportResultToJSON(result: QueryResult): string {
    const rows = result.rows.map((row) =>
        Object.fromEntries(
            result.columns.map((col, i) => {
                const cell = row[i] ?? { type: "Null" as const };
                if (cell.type === "Null") return [col.name, null];
                if (["Bool", "Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                    return [col.name, cell.value];
                if (cell.type === "Json") return [col.name, cell.value];
                return [col.name, formatCellValue(cell)];
            })
        )
    );
    return JSON.stringify(rows, null, 2);
}

function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Error panel ────────────────────────────────────────────────────────────

function explainQueryError(raw: string): { summary: string; fix: string } | null {
    const lower = raw.toLowerCase();
    if (lower.includes("does not exist") || (lower.includes("relation") && lower.includes("does not exist"))) {
        return {
            summary: "The table or object you're referring to doesn't exist in this database.",
            fix: "Check the table name (and schema, e.g. public.mytable). Use CREATE TABLE, or fix the typo.",
        };
    }
    if (lower.includes("column") && (lower.includes("does not exist") || lower.includes("undefined"))) {
        return {
            summary: "A column name in your query doesn't exist on the table.",
            fix: "Check spelling and that the column exists. Use the correct column names from the table definition.",
        };
    }
    if (lower.includes("syntax error") || lower.includes("parse error")) {
        return {
            summary: "PostgreSQL couldn't parse your SQL.",
            fix: "Check brackets, commas, quotes, and keywords. Common issues: missing comma, unclosed quote, wrong keyword order.",
        };
    }
    if (lower.includes("permission denied") || lower.includes("access denied")) {
        return {
            summary: "Your database user doesn't have permission for this operation.",
            fix: "Use a user with the right privileges, or GRANT the needed permissions.",
        };
    }
    if (lower.includes("duplicate key") || lower.includes("unique constraint")) {
        return {
            summary: "A unique or primary key constraint would be violated.",
            fix: "Change the value for the unique/PK column so it doesn't match an existing row.",
        };
    }
    if (lower.includes("foreign key") || lower.includes("violates foreign key")) {
        return {
            summary: "A foreign key constraint failed.",
            fix: "Insert the referenced row first, or use a valid foreign key value.",
        };
    }
    if (lower.includes("null value") && lower.includes("violates not-null")) {
        return {
            summary: "A NOT NULL column received a NULL value.",
            fix: "Provide a non-NULL value, or alter the column to allow NULL.",
        };
    }
    if (lower.includes("connection") || lower.includes("pool")) {
        return {
            summary: "The app lost the connection to the database.",
            fix: "Check your network and DB server. Try reconnecting.",
        };
    }
    return null;
}

function QueryErrorPanel({ message }: { message: string }) {
    const [copied, setCopied] = useState(false);
    const explanation = explainQueryError(message);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="p-4 space-y-3">
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-destructive/10">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                            <p className="text-sm font-semibold text-destructive">Query failed</p>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 text-xs"
                            onClick={() => {
                                navigator.clipboard.writeText(message);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                            }}
                        >
                            {copied ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                            {copied ? "Copied" : "Copy error"}
                        </Button>
                    </div>

                    {explanation && (
                        <div className="px-4 py-3 bg-muted/30 border-b border-destructive/10">
                            <div className="flex items-start gap-2">
                                <Lightbulb className="h-4 w-4 text-amber-500/80 mt-0.5 shrink-0" />
                                <div className="text-xs space-y-1.5">
                                    <p>
                                        <span className="font-semibold text-foreground/90">Why: </span>
                                        <span className="text-muted-foreground">{explanation.summary}</span>
                                    </p>
                                    <p>
                                        <span className="font-semibold text-foreground/90">Fix: </span>
                                        <span className="text-muted-foreground">{explanation.fix}</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="p-4">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-2">
                            Full error
                        </p>
                        <ScrollArea className="max-h-52 rounded-lg border border-border/30 bg-background/90 p-3">
                            <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/90">
                                {message}
                            </pre>
                        </ScrollArea>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── History panel ──────────────────────────────────────────────────────────

function HistoryPanel({
    history,
    onLoadSql,
    onClearHistory,
    onDeleteEntry,
    onRerunSql,
}: {
    history: QueryHistoryEntry[];
    onLoadSql: (sql: string) => void;
    onClearHistory: () => void;
    onDeleteEntry: (id: string) => void;
    onRerunSql: (sql: string) => void;
}) {
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | "success" | "error">("all");

    const filtered = useMemo(() => {
        return history.filter((e) => {
            const matchesSearch =
                !search || e.sql.toLowerCase().includes(search.toLowerCase());
            const matchesFilter =
                filter === "all" ||
                (filter === "success" && !e.isError) ||
                (filter === "error" && e.isError);
            return matchesSearch && matchesFilter;
        });
    }, [history, search, filter]);

    return (
        <div className="flex flex-col h-full border-t border-border/20 bg-card/10">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/20 shrink-0">
                <div className="flex items-center gap-2">
                    <History className="h-3.5 w-3.5 text-muted-foreground/60" />
                    <span className="text-xs font-medium text-muted-foreground/80">
                        Query History
                    </span>
                    <span className="text-[10px] text-muted-foreground/40 font-mono">
                        ({filtered.length}/{history.length})
                    </span>
                </div>
                {history.length > 0 && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-destructive"
                                onClick={onClearHistory}
                            >
                                <Trash2 className="h-3 w-3" />
                                Clear all
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear all query history</TooltipContent>
                    </Tooltip>
                )}
            </div>

            {/* Search + filter bar */}
            {history.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/10 shrink-0">
                    <div className="relative flex-1">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search queries…"
                            className="w-full pl-6 pr-2 py-1 text-[11px] bg-muted/20 border border-border/20 rounded text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus:border-border/50 focus:bg-muted/30 transition-colors"
                        />
                    </div>
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
                </div>
            )}

            {/* List — min-h-0 so flex child can shrink and scroll */}
            <ScrollArea className="flex-1 min-h-0 overflow-hidden overscroll-contain">
                {history.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <History className="h-8 w-8 text-muted-foreground/20 mb-2" />
                        <p className="text-xs text-muted-foreground/40">No queries yet</p>
                        <p className="text-[10px] text-muted-foreground/30 mt-0.5">
                            Executed queries appear here
                        </p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Search className="h-6 w-6 text-muted-foreground/20 mb-2" />
                        <p className="text-xs text-muted-foreground/40">No matches</p>
                    </div>
                ) : (
                    <div className="divide-y divide-border/10">
                        {filtered.map((entry) => (
                            <div
                                key={entry.id}
                                className="group flex items-start gap-3 px-4 py-2.5 hover:bg-accent/20 transition-colors cursor-pointer"
                                onClick={() => onLoadSql(entry.sql)}
                                title="Click to load into editor"
                            >
                                {/* Status dot */}
                                <div
                                    className={cn(
                                        "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                                        entry.isError ? "bg-destructive" : "bg-emerald-500"
                                    )}
                                />

                                {/* SQL preview */}
                                <div className="flex-1 min-w-0">
                                    <p className="text-[11px] font-mono text-foreground/80 truncate leading-relaxed">
                                        {entry.sql.replace(/\s+/g, " ").slice(0, 120)}
                                        {entry.sql.length > 120 ? "…" : ""}
                                    </p>
                                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                                        <span className="text-[10px] text-muted-foreground/40">
                                            {timeAgo(entry.executedAt)}
                                        </span>
                                        {entry.databaseName && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] font-mono text-muted-foreground/35">
                                                    {entry.databaseName}
                                                </span>
                                            </>
                                        )}
                                        {!entry.isError && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] font-mono text-muted-foreground/40">
                                                    {entry.executionTimeMs.toFixed(1)}ms
                                                </span>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] font-mono text-muted-foreground/40">
                                                    {entry.rowCount} rows
                                                </span>
                                            </>
                                        )}
                                        {entry.isError && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span className="text-[10px] text-destructive/60">
                                                    error
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Hover actions */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onRerunSql(entry.sql);
                                                }}
                                            >
                                                <Play className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>Re-run query</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/60 transition-colors"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    navigator.clipboard.writeText(entry.sql);
                                                    toast.success("SQL copied", { duration: 1500 });
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
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDeleteEntry(entry.id);
                                                }}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>Delete entry</TooltipContent>
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

// ── Main component ─────────────────────────────────────────────────────────

export function QueryEditor() {
    const { connectionId, databaseName, tables } = useConnectionStore();
    const {
        tabs,
        activeTabId,
        addTab,
        removeTab,
        setActiveTab,
        updateSql,
        executeQuery,
        history,
        clearHistory,
        deleteHistoryEntry,
        loadHistoryFromStorage,
    } = useQueryStore();

    // ── Sandbox integration ────────────────────────────────────────────────
    const {
        status: sandboxStatus,
        result: sandboxResult,
        anomalyWarning,
        elapsedSecs: sandboxElapsed,
        pendingSql: sandboxPendingSql,
        error: sandboxError,
        enableSandbox,
        disableSandbox,
        runInSandbox,
        commitSandbox,
        rollbackSandbox,
        loadHistory: loadSandboxHistory,
        tickElapsed,
    } = useSandboxStore();

    const isSandboxMode = sandboxStatus !== "off";
    const isSandboxReviewing = sandboxStatus === "reviewing";
    const isSandboxCommitting = sandboxStatus === "committing";
    const isSandboxRollingBack = sandboxStatus === "rolling_back";
    const isSandboxBusy = sandboxStatus === "executing" || isSandboxCommitting || isSandboxRollingBack;

    // Tick elapsed timer while sandbox transaction is open
    useEffect(() => {
        if (!isSandboxMode) return;
        const interval = setInterval(tickElapsed, 5000);
        return () => clearInterval(interval);
    }, [isSandboxMode, tickElapsed]);

    // Idle transaction warning (10 min)
    useEffect(() => {
        if (sandboxElapsed > 600 && isSandboxReviewing) {
            toast.warning("Sandbox transaction has been open for over 10 minutes — remember to commit or rollback.", {
                id: "sandbox-idle",
                duration: 10000,
            });
        }
    }, [sandboxElapsed, isSandboxReviewing]);

    // Show sandbox errors as toasts
    useEffect(() => {
        if (sandboxError) {
            toast.error(sandboxError, { duration: 5000 });
        }
    }, [sandboxError]);

    useEffect(() => {
        loadSandboxHistory();
    }, [loadSandboxHistory]);

    const activeTab = tabs.find((t) => t.id === activeTabId);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const [saveNoteOpen, setSaveNoteOpen] = useState(false);
    const [saveNoteTitle, setSaveNoteTitle] = useState("");
    const [saveNoteLoading, setSaveNoteLoading] = useState(false);
    const historyPanelRef = useRef<HTMLDivElement>(null);

    // Notes store
    const { saveNote: storeNoteSave } = useNotesStore();

    // Plan state: keyed by tab id so each tab has its own plan
    const [planData, setPlanData] = useState<Record<string, string>>({});
    const [planLoading, setPlanLoading] = useState<Record<string, boolean>>({});
    const [resultView, setResultView] = useState<Record<string, "results" | "plan" | "canvas">>({});

    const activePlan = activeTabId ? planData[activeTabId] : undefined;
    const isExplaining = activeTabId ? (planLoading[activeTabId] ?? false) : false;
    const activeResultView = activeTabId ? (resultView[activeTabId] ?? "results") : "results";

    // Column cache for schema-aware completions: tableName → column names
    const [columnCache, setColumnCache] = useState<Record<string, string[]>>({});
    // Ref so eager-loader can read current cache without being in its dep array
    const columnCacheRef = useRef<Record<string, string[]>>({});
    useEffect(() => { columnCacheRef.current = columnCache; }, [columnCache]);

    // Build schema context from connection store
    const schemaContext = useMemo(
        () => ({
            tables: tables.map((t) => t.name),
            columns: columnCache,
        }),
        [tables, columnCache]
    );

    // ── Eager column preloading ─────────────────────────────────────────────
    // When the connection or table list changes, batch-fetch columns for every
    // table so the AI always has the real schema instead of guessing.
    useEffect(() => {
        if (!connectionId || tables.length === 0) return;
        let cancelled = false;

        const load = async () => {
            const BATCH = 6;
            for (let i = 0; i < tables.length; i += BATCH) {
                if (cancelled) break;
                const batch = tables.slice(i, i + BATCH);
                await Promise.allSettled(
                    batch
                        .filter((t) => !columnCacheRef.current[t.name])
                        .map(async (tableInfo) => {
                            try {
                                const cols = await dbGetColumns(
                                    connectionId,
                                    tableInfo.schema,
                                    tableInfo.name
                                );
                                if (!cancelled) {
                                    setColumnCache((prev) => ({
                                        ...prev,
                                        [tableInfo.name]: cols.map((c) => c.name),
                                    }));
                                }
                            } catch {
                                // ignore individual failures silently
                            }
                        })
                );
            }
        };

        load();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionId, tables]);

    // Lazily fetch columns on-demand (e.g. "tableName." typed) — keeps cache warm
    const handleFetchColumns = useCallback(
        async (tableName: string): Promise<string[]> => {
            if (!connectionId) return [];
            const cached = columnCacheRef.current[tableName];
            if (cached) return cached;
            const tableInfo = tables.find(
                (t) => t.name.toLowerCase() === tableName.toLowerCase()
            );
            if (!tableInfo) return [];
            try {
                const cols = await dbGetColumns(
                    connectionId,
                    tableInfo.schema,
                    tableInfo.name
                );
                const colNames = cols.map((c) => c.name);
                setColumnCache((prev) => ({ ...prev, [tableName]: colNames }));
                return colNames;
            } catch {
                return [];
            }
        },
        [connectionId, tables]
    );

    const handleFormatSql = useCallback(
        (sql: string) => {
            if (!activeTabId) return;
            try {
                const formatted = formatSQL(sql, {
                    language: "postgresql",
                    tabWidth: 4,
                    keywordCase: "upper",
                });
                updateSql(activeTabId, formatted);
                toast.success("SQL formatted", { duration: 1200 });
            } catch {
                toast.error("Could not format SQL", { duration: 1500 });
            }
        },
        [activeTabId, updateSql]
    );

    // Convert a next-action suggestion (plain-text description) to SQL and apply it
    const handleNextAction = useCallback(
        async (action: string) => {
            if (!activeTabId) return;
            const currentSql = activeTab?.sql ?? "";
            toast.loading("Nova is applying suggestion…", { id: "nova-action" });
            try {
                const ctx = schemaContext;
                const prompt = currentSql
                    ? `Given this existing query:\n${currentSql}\n\nApply the following change and return the updated SQL:\n${action}`
                    : action;
                const newSql = await aiSuggestionEngine.getNaturalLanguageSQL(prompt, ctx);
                if (newSql) {
                    updateSql(activeTabId, newSql);
                    toast.success("Suggestion applied", { id: "nova-action", duration: 1500 });
                } else {
                    toast.dismiss("nova-action");
                }
            } catch {
                toast.error("Nova couldn't apply the suggestion", { id: "nova-action", duration: 2000 });
            }
        },
        [activeTabId, activeTab?.sql, schemaContext, updateSql]
    );

    // Load history from localStorage on mount
    useEffect(() => {
        loadHistoryFromStorage();
    }, [loadHistoryFromStorage]);

    // Add initial tab if none exist
    useEffect(() => {
        if (tabs.length === 0) addTab();
    }, [tabs.length, addTab]);

    // ⌘+Shift+P command palette / ⌘+Shift+H history
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
                e.preventDefault();
                setCommandPaletteOpen((o) => !o);
            }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "H") {
                e.preventDefault();
                setHistoryOpen((o) => !o);
            }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "N") {
                e.preventDefault();
                setNotesOpen((o) => !o);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const handleExecute = useCallback(() => {
        if (!connectionId || !activeTabId) return;
        const sql = activeTab?.sql.trim() ?? "";
        if (!sql) return;

        if (isSandboxMode) {
            // Route to sandbox: open transaction, execute, show diff
            runInSandbox(connectionId, sql);
        } else {
            executeQuery(connectionId, activeTabId, databaseName || undefined);
        }
    }, [connectionId, activeTabId, databaseName, executeQuery, isSandboxMode, activeTab?.sql, runInSandbox]);

    const handleExplain = useCallback(async (tabId?: string, sql?: string) => {
        const tid = tabId ?? activeTabId;
        const query = sql ?? activeTab?.sql.trim();
        if (!connectionId || !tid || !query) return;
        setPlanLoading((prev) => ({ ...prev, [tid]: true }));
        setResultView((prev) => ({ ...prev, [tid]: "plan" }));
        try {
            const json = await dbExplainQuery(connectionId, query);
            setPlanData((prev) => ({ ...prev, [tid]: json }));
        } catch (err) {
            toast.error(String(err), { duration: 4000 });
            setResultView((prev) => ({ ...prev, [tid]: "results" }));
        } finally {
            setPlanLoading((prev) => ({ ...prev, [tid]: false }));
        }
    }, [connectionId, activeTabId, activeTab?.sql]);

    // One-click fix: execute the SQL then automatically re-run the plan
    const handleApplyFix = useCallback(async (fixSql: string) => {
        if (!connectionId || !activeTabId) return;
        try {
            await dbExecuteQuery(connectionId, fixSql);
            toast.success("Fix applied — re-analysing plan…", { duration: 2000 });
            await handleExplain(activeTabId, activeTab?.sql.trim());
        } catch (err) {
            toast.error(`Fix failed: ${String(err)}`, { duration: 4000 });
        }
    }, [connectionId, activeTabId, activeTab?.sql, handleExplain]);

    const runCommand = useCallback(
        (cmd: "run" | "new-tab" | "close-tab") => {
            setCommandPaletteOpen(false);
            if (cmd === "run") handleExecute();
            else if (cmd === "new-tab") addTab();
            else if (cmd === "close-tab" && activeTabId) removeTab(activeTabId);
        },
        [handleExecute, addTab, activeTabId, removeTab]
    );

    const handleLoadFromHistory = useCallback(
        (sql: string) => {
            if (!activeTabId) {
                addTab("History", sql);
            } else {
                updateSql(activeTabId, sql);
            }
            setHistoryOpen(false);
        },
        [activeTabId, addTab, updateSql]
    );

    const handleRerunFromHistory = useCallback(
        (sql: string) => {
            if (!connectionId) return;
            if (!activeTabId) {
                addTab("Re-run", sql);
                // Execute after the tab state updates
                setTimeout(() => {
                    const { activeTabId: newTabId } = useQueryStore.getState();
                    if (newTabId) executeQuery(connectionId, newTabId, databaseName || undefined);
                }, 50);
            } else {
                updateSql(activeTabId, sql);
                setTimeout(() => handleExecute(), 50);
            }
            setHistoryOpen(false);
        },
        [connectionId, activeTabId, addTab, updateSql, executeQuery, databaseName, handleExecute]
    );

    const handleExport = (format: "csv" | "json") => {
        const result = activeTab?.result;
        if (!result || result.is_error || result.columns.length === 0) return;

        const tabTitle = activeTab?.title ?? "query";
        const filename = `${tabTitle.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}`;

        if (format === "csv") {
            downloadBlob(exportResultToCSV(result), `${filename}.csv`, "text/csv;charset=utf-8;");
            toast.success("CSV downloaded", { duration: 1500 });
        } else {
            downloadBlob(exportResultToJSON(result), `${filename}.json`, "application/json");
            toast.success("JSON downloaded", { duration: 1500 });
        }
    };

    const hasResult =
        activeTab?.result && !activeTab.result.is_error && activeTab.result.columns.length > 0;

    return (
        <div className="flex h-full flex-col">
            <Dialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
                <DialogContent className="sm:max-w-md gap-0 p-0">
                    <DialogTitle className="sr-only">Command palette</DialogTitle>
                    <div className="px-3 py-2 border-b border-border/30 text-xs text-muted-foreground font-mono">
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

                {/* Tab actions */}
                <div className="flex items-center gap-0.5 px-2 shrink-0">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => addTab()}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>New query tab</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                    "h-7 w-7 transition-colors",
                                    historyOpen
                                        ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/20"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                                onClick={() => setHistoryOpen((o) => !o)}
                            >
                                <History className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Query history (⌘⇧H)</TooltipContent>
                    </Tooltip>

                    {/* Notes toggle */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                    "h-7 w-7 transition-colors",
                                    notesOpen
                                        ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/20"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                                onClick={() => setNotesOpen((o) => !o)}
                            >
                                <StickyNote className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Notes (⌘⇧N)</TooltipContent>
                    </Tooltip>

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
                                onClick={() => {
                                    if (isSandboxMode) {
                                        disableSandbox();
                                        toast.info("Sandbox mode off", { duration: 1500 });
                                    } else {
                                        enableSandbox();
                                        toast.success("Sandbox mode enabled — queries run inside a transaction", { duration: 2500 });
                                    }
                                }}
                            >
                                {isSandboxMode ? (
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                ) : (
                                    <Shield className="h-3.5 w-3.5" />
                                )}
                                {isSandboxMode ? "Sandbox" : "Sandbox"}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {isSandboxMode
                                ? "Sandbox ON — queries run in a transaction. Click to disable."
                                : "Enable sandbox mode — preview changes before committing"}
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Sandbox active banner */}
            {isSandboxMode && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-emerald-500/6 border-b border-emerald-500/15 shrink-0">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    <span className="text-xs text-emerald-400/90 font-medium">
                        SANDBOX MODE
                    </span>
                    <span className="text-xs text-emerald-400/50 ml-1">
                        {isSandboxReviewing
                            ? "— Review the diff below, then Commit or Rollback"
                            : isSandboxBusy
                                ? "— Processing…"
                                : "— Queries run inside an automatic transaction. Nothing is committed until you approve."}
                    </span>
                    {isSandboxReviewing && sandboxElapsed > 0 && (
                        <span className="ml-auto text-[10px] font-mono text-emerald-400/40">
                            txn open {sandboxElapsed}s
                        </span>
                    )}
                </div>
            )}

            {/* History panel — inline below tab bar, scrollable list */}
            {historyOpen && (
                <div
                    ref={historyPanelRef}
                    className="shrink-0 border-b border-border/20 overflow-hidden flex flex-col"
                    style={{ height: "min(20rem, 40vh)" }}
                >
                    <HistoryPanel
                        history={history}
                        onLoadSql={handleLoadFromHistory}
                        onClearHistory={clearHistory}
                        onDeleteEntry={deleteHistoryEntry}
                        onRerunSql={handleRerunFromHistory}
                    />
                </div>
            )}

            {/* Notes panel */}
            {notesOpen && (
                <div
                    className="shrink-0 border-b border-border/20 overflow-hidden flex flex-col"
                    style={{ height: "min(22rem, 40vh)" }}
                >
                    <NotesPanel
                        onInsertSql={(sql) => {
                            if (activeTabId) {
                                updateSql(activeTabId, sql);
                                setNotesOpen(false);
                            } else {
                                addTab("From Note", sql);
                                setNotesOpen(false);
                            }
                        }}
                        onClose={() => setNotesOpen(false)}
                    />
                </div>
            )}

            {/* Editor area */}
            {activeTab && (
                <>
                    <div className="relative border-b border-border/30">
                        <MonacoSqlEditor
                            value={activeTab.sql}
                            onChange={(v) => updateSql(activeTab.id, v)}
                            onExecute={handleExecute}
                            onFormatSql={handleFormatSql}
                            onFetchColumns={handleFetchColumns}
                            onNextAction={handleNextAction}
                            schemaContext={schemaContext}
                            disabled={activeTab.isExecuting}
                            className="rounded-none border-0"
                        />
                        <div className="absolute bottom-2 right-2 flex items-center gap-2 z-10">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs text-muted-foreground/50 hover:text-amber-400 px-2"
                                        onClick={() => {
                                            setSaveNoteTitle("");
                                            setSaveNoteOpen(true);
                                        }}
                                        disabled={!activeTab.sql.trim() || activeTab.isExecuting}
                                    >
                                        <StickyNote className="h-3 w-3" />
                                        Note
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Save as note</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground px-2"
                                        onClick={() => {
                                            if (activeTab.sql) handleFormatSql(activeTab.sql);
                                        }}
                                        disabled={!activeTab.sql.trim() || activeTab.isExecuting}
                                    >
                                        <AlignLeft className="h-3 w-3" />
                                        Format
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Format SQL (⇧⌥F)</TooltipContent>
                            </Tooltip>
                            <span className="text-[10px] text-muted-foreground/40 font-mono">
                                ⌘+Enter to run
                            </span>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70"
                                        onClick={() => handleExplain()}
                                        disabled={isExplaining || activeTab.isExecuting || !activeTab.sql.trim()}
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
                            <Button
                                size="sm"
                                className={cn(
                                    "h-8 gap-1.5 text-white shadow-md",
                                    isSandboxMode
                                        ? "bg-emerald-700 hover:bg-emerald-600 shadow-emerald-700/20"
                                        : "bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 shadow-emerald-600/20"
                                )}
                                onClick={handleExecute}
                                disabled={
                                    activeTab.isExecuting ||
                                    isSandboxBusy ||
                                    isSandboxReviewing ||
                                    !activeTab.sql.trim()
                                }
                            >
                                {activeTab.isExecuting || isSandboxBusy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : isSandboxMode ? (
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                ) : (
                                    <Play className="h-3.5 w-3.5" />
                                )}
                                {isSandboxMode ? "Run in Sandbox" : "Run"}
                            </Button>
                        </div>

                        {/* Save Note Dialog */}
                        <Dialog open={saveNoteOpen} onOpenChange={setSaveNoteOpen}>
                            <DialogContent className="sm:max-w-md">
                                <DialogHeader>
                                    <DialogTitle className="text-sm font-medium flex items-center gap-2">
                                        <StickyNote className="h-4 w-4 text-amber-400" />
                                        Save Note
                                    </DialogTitle>
                                </DialogHeader>
                                <div className="space-y-3 py-2">
                                    <div>
                                        <label className="text-xs text-muted-foreground mb-1 block">Title</label>
                                        <Input
                                            value={saveNoteTitle}
                                            onChange={(e) => setSaveNoteTitle(e.target.value)}
                                            placeholder="e.g. User activity report…"
                                            className="h-8 text-sm"
                                            autoFocus
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" && saveNoteTitle.trim()) {
                                                    e.preventDefault();
                                                    (async () => {
                                                        setSaveNoteLoading(true);
                                                        try {
                                                            const now = new Date().toISOString();
                                                            await storeNoteSave({
                                                                id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                                                title: saveNoteTitle.trim(),
                                                                sql: activeTab?.sql ?? "",
                                                                created_at: now,
                                                                updated_at: now,
                                                                tags: [],
                                                            });
                                                            setSaveNoteOpen(false);
                                                            toast.success("Note saved", { duration: 1500 });
                                                        } catch {
                                                            toast.error("Failed to save note", { duration: 2000 });
                                                        } finally {
                                                            setSaveNoteLoading(false);
                                                        }
                                                    })();
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className="rounded-md border border-border/30 bg-muted/20 p-2">
                                        <p className="text-[10px] text-muted-foreground/50 mb-1">SQL content</p>
                                        <p className="text-xs font-mono text-foreground/70 truncate">
                                            {(activeTab?.sql ?? "").replace(/\s+/g, " ").slice(0, 200) || "(empty)"}
                                        </p>
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setSaveNoteOpen(false)}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white"
                                        disabled={!saveNoteTitle.trim() || saveNoteLoading}
                                        onClick={async () => {
                                            setSaveNoteLoading(true);
                                            try {
                                                const now = new Date().toISOString();
                                                await storeNoteSave({
                                                    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                                    title: saveNoteTitle.trim(),
                                                    sql: activeTab?.sql ?? "",
                                                    created_at: now,
                                                    updated_at: now,
                                                    tags: [],
                                                });
                                                setSaveNoteOpen(false);
                                                toast.success("Note saved", { duration: 1500 });
                                            } catch {
                                                toast.error("Failed to save note", { duration: 2000 });
                                            } finally {
                                                setSaveNoteLoading(false);
                                            }
                                        }}
                                    >
                                        {saveNoteLoading && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                                        Save Note
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>

                    {/* Results */}
                    <div className="flex-1 overflow-hidden flex flex-col">

                        {/* ── Sandbox diff viewer ── */}
                        {isSandboxReviewing && sandboxResult && (
                            <div className="flex-1 overflow-hidden">
                                <SandboxDiffViewer
                                    result={sandboxResult}
                                    sql={sandboxPendingSql ?? ""}
                                    elapsedSecs={sandboxElapsed}
                                    anomalyWarning={anomalyWarning}
                                    onCommit={commitSandbox}
                                    onRollback={rollbackSandbox}
                                    isCommitting={isSandboxCommitting}
                                    isRollingBack={isSandboxRollingBack}
                                />
                            </div>
                        )}

                        {/* Sandbox executing spinner */}
                        {isSandboxBusy && (
                            <div className="flex-1 flex items-center justify-center">
                                <div className="flex items-center gap-3">
                                    <ShieldCheck className="h-5 w-5 animate-pulse text-emerald-400" />
                                    <span className="text-sm text-muted-foreground">
                                        {sandboxStatus === "executing"
                                            ? "Running in sandbox transaction…"
                                            : sandboxStatus === "committing"
                                                ? "Committing changes…"
                                                : "Rolling back changes…"}
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Sandbox ready (no result yet) */}
                        {isSandboxMode && sandboxStatus === "ready" && !activeTab.result && (
                            <div className="flex-1 flex h-full flex-col items-center justify-center text-muted-foreground">
                                <ShieldCheck className="h-12 w-12 mb-3 opacity-15 text-emerald-400" />
                                <p className="text-sm font-medium">Sandbox mode active</p>
                                <p className="text-xs mt-1 opacity-60">
                                    Write SQL above and press ⌘+Enter — changes won't be committed until you approve
                                </p>
                            </div>
                        )}

                        {/* Results / Plan / Canvas tab switcher */}
                        {!isSandboxMode && (activeTab.result || activePlan) && (
                            <div className="flex items-center gap-0 border-b border-border/20 bg-card/20 px-3 shrink-0">
                                <button
                                    className={cn(
                                        "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                                        activeResultView === "results"
                                            ? "border-emerald-500 text-foreground"
                                            : "border-transparent text-muted-foreground hover:text-foreground"
                                    )}
                                    onClick={() => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: "results" }))}
                                >
                                    Results
                                </button>
                                {activePlan && (
                                    <button
                                        className={cn(
                                            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                                            activeResultView === "plan"
                                                ? "border-blue-500 text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"
                                        )}
                                        onClick={() => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: "plan" }))}
                                    >
                                        <GitBranch className="h-3 w-3" />
                                        Query Plan
                                    </button>
                                )}
                                {activeTab.result && !activeTab.result.is_error && activeTab.result.columns.length > 0 && (
                                    <button
                                        className={cn(
                                            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                                            activeResultView === "canvas"
                                                ? "border-emerald-400 text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"
                                        )}
                                        onClick={() => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: "canvas" }))}
                                    >
                                        <LayoutDashboard className="h-3 w-3" />
                                        Canvas
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Plan view */}
                        {!isSandboxMode && activeResultView === "plan" && activePlan && (
                            <div className="flex-1 overflow-hidden">
                                <QueryPlanViewer rawJson={activePlan} onApplyFix={handleApplyFix} />
                            </div>
                        )}

                        {/* Explain loading */}
                        {!isSandboxMode && activeResultView === "plan" && isExplaining && (
                            <div className="flex-1 flex items-center justify-center">
                                <div className="flex items-center gap-3">
                                    <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                                    <span className="text-sm text-muted-foreground">Analysing query plan…</span>
                                </div>
                            </div>
                        )}

                        {/* Canvas view */}
                        {!isSandboxMode && activeResultView === "canvas" && activeTab.result && !activeTab.result.is_error && (
                            <div className="flex-1 overflow-hidden">
                                <DataCanvas result={activeTab.result} />
                            </div>
                        )}

                        {!isSandboxMode && activeResultView === "results" && activeTab.result ? (
                            activeTab.result.is_error ? (
                                <QueryErrorPanel
                                    message={activeTab.result.error_message ?? "Unknown error"}
                                />
                            ) : (
                                <div className="flex h-full min-h-0 flex-col">
                                    {/* Slow query banner */}
                                    {activeTab.result.execution_time_ms > 500 && activeResultView === "results" && (
                                        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-orange-500/8 border-b border-orange-500/20 shrink-0">
                                            <div className="flex items-center gap-2">
                                                <AlertCircle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                                                <span className="text-xs text-orange-400/90">
                                                    Slow query detected ({activeTab.result.execution_time_ms.toFixed(0)}ms) — Analyze the query plan to find the bottleneck
                                                </span>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-7 px-3 text-xs gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/60 shrink-0"
                                                onClick={() => handleExplain()}
                                                disabled={isExplaining}
                                            >
                                                {isExplaining ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                                                Analyze plan
                                            </Button>
                                        </div>
                                    )}
                                    {/* Result info bar — success message and stats */}
                                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/20 bg-emerald-500/5 shrink-0">
                                        <div className="flex items-center gap-3">
                                            <div className="flex items-center gap-2">
                                                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                                <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                                                    Query succeeded
                                                </span>
                                            </div>
                                            <span className="text-muted-foreground text-xs">
                                                {getRowCountLabel(activeTab.result)}
                                            </span>
                                            <Badge
                                                variant="outline"
                                                className="text-[10px] font-mono gap-1 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                            >
                                                <Clock className="h-3 w-3" />
                                                {activeTab.result.execution_time_ms.toFixed(1)}ms
                                            </Badge>
                                        </div>

                                        {/* Export dropdown — only for result sets with multiple columns */}
                                        <div className="flex items-center gap-1">
                                            {!isCommandResult(activeTab.result) && (
                                                <>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
                                                                onClick={() => {
                                                                    const r = activeTab.result!;
                                                                    const header = r.columns.map((c) => c.name).join("\t");
                                                                    const rows = r.rows.map((row) =>
                                                                        row.map((cell) => formatCellValue(cell)).join("\t")
                                                                    );
                                                                    navigator.clipboard.writeText([header, ...rows].join("\n"));
                                                                    toast.success("Copied as TSV", { duration: 1500 });
                                                                }}
                                                                disabled={!hasResult}
                                                            >
                                                                <Copy className="h-3 w-3" />
                                                                Copy
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>Copy as TSV</TooltipContent>
                                                    </Tooltip>

                                                    <DropdownMenu>
                                                        <DropdownMenuTrigger asChild>
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground px-2"
                                                                disabled={!hasResult}
                                                            >
                                                                <Download className="h-3 w-3" />
                                                                Export
                                                                <ChevronDown className="h-3 w-3 ml-0.5" />
                                                            </Button>
                                                        </DropdownMenuTrigger>
                                                        <DropdownMenuContent align="end" className="w-44">
                                                            <DropdownMenuItem
                                                                onClick={() => handleExport("csv")}
                                                                className="gap-2 text-xs"
                                                            >
                                                                <FileText className="h-3.5 w-3.5" />
                                                                Download as CSV
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem
                                                                onClick={() => handleExport("json")}
                                                                className="gap-2 text-xs"
                                                            >
                                                                <Braces className="h-3.5 w-3.5" />
                                                                Download as JSON
                                                            </DropdownMenuItem>
                                                        </DropdownMenuContent>
                                                    </DropdownMenu>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {/* Result: compact message for INSERT/UPDATE/DELETE, table for SELECT */}
                                    {isCommandResult(activeTab.result) ? (
                                        <div className="flex-1 flex items-center justify-center p-6">
                                            <p className="text-sm text-muted-foreground">
                                                {getDisplayCount(activeTab.result).toLocaleString()} row{getDisplayCount(activeTab.result) !== 1 ? "s" : ""} affected.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="flex-1 min-h-0 overflow-hidden">
                                            <ScrollArea className="h-full w-full">
                                                <Table>
                                                    <TableHeader>
                                                        <TableRow className="hover:bg-transparent border-border/30">
                                                            <TableHead className="w-12 text-center text-[10px] font-mono text-muted-foreground/50 sticky top-0 bg-background z-10">
                                                                #
                                                            </TableHead>
                                                            {activeTab.result.columns.map((col) => (
                                                                <TableHead key={col.name} className="whitespace-nowrap sticky top-0 bg-background z-10">
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
                                                                            "text-xs font-mono max-w-xs truncate cursor-pointer hover:bg-accent/30 transition-colors",
                                                                            cell.type === "Null" &&
                                                                            "text-muted-foreground/30 italic"
                                                                        )}
                                                                        title={formatCellValue(cell)}
                                                                        onClick={() => {
                                                                            if (cell.type !== "Null") {
                                                                                navigator.clipboard.writeText(
                                                                                    formatCellValue(cell)
                                                                                );
                                                                                toast.success("Copied", {
                                                                                    duration: 1200,
                                                                                });
                                                                            }
                                                                        }}
                                                                    >
                                                                        {formatCellValue(cell)}
                                                                    </TableCell>
                                                                ))}
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </Table>
                                                <ScrollBar orientation="horizontal" />
                                                <ScrollBar orientation="vertical" />
                                            </ScrollArea>
                                        </div>
                                    )}
                                </div>
                            )
                        ) : null}

                        {!isSandboxMode && activeResultView === "results" && activeTab.isExecuting && !activeTab.result && (
                            <div className="flex-1 flex items-center justify-center">
                                <div className="flex items-center gap-3">
                                    <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
                                    <span className="text-sm text-muted-foreground">
                                        Executing query…
                                    </span>
                                </div>
                            </div>
                        )}

                        {!isSandboxMode && activeResultView === "results" && !activeTab.result && !activeTab.isExecuting && (
                            <div className="flex-1 flex h-full flex-col items-center justify-center text-muted-foreground">
                                <Terminal className="h-12 w-12 mb-3 opacity-15" />
                                <p className="text-sm font-medium">Run a query</p>
                                <p className="text-xs mt-1 opacity-60">
                                    Write SQL above and press ⌘+Enter
                                </p>
                                {history.length > 0 && (
                                    <button
                                        onClick={() => setHistoryOpen(true)}
                                        className="mt-3 text-xs text-muted-foreground/50 hover:text-muted-foreground flex items-center gap-1.5 transition-colors"
                                    >
                                        <History className="h-3 w-3" />
                                        View query history
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
