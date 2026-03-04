"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryStore } from "@/stores/query-store";
import type { QueryHistoryEntry } from "@/stores/query-store";
import { useSandboxStore } from "@/stores/sandbox-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useNotesStore } from "@/stores/notes-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useShallow } from "zustand/react/shallow";
import { formatCellValue } from "@/lib/types";
import type { QueryResult } from "@/lib/types";
import { dbGetColumns, dbExplainQuery, dbExecuteQuery } from "@/lib/tauri";
import { NotesPanel } from "@/components/notes-panel";
import { QueryPlanViewer } from "@/components/query-plan-viewer";
import { SandboxDiffViewer } from "@/components/sandbox-diff-viewer";
import { DataCanvas } from "@/components/data-canvas";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { VirtualizedQueryResultTable } from "@/components/virtualized-query-result-table";
import { QueryReviewPanel } from "@/components/query-review-panel";
import { format as formatSQL } from "sql-formatter";
import { MonacoSqlEditor } from "@/components/monaco-sql-editor";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import { getSqlReviewIntent, runSqlSafetyReview, type SqlReviewReport } from "@/lib/sql-review";
import {
    formatEnvironmentLabel,
    normalizeConnectionEnvironment,
} from "@/lib/connection-metadata";
import {
    STRICT_PRODUCTION_CONFIRMATION,
    shouldRequireProductionGuard,
    type SqlRiskClassification,
} from "@/lib/sql-risk-guard";
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
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
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
    AlignLeft,
    Search,
    GitBranch,
    Shield,
    ShieldCheck,
    LayoutDashboard,
    StickyNote,
    Maximize2,
    Minimize2,
    Sparkles,
} from "lucide-react";
import { explainQueryErrorWithAI } from "@/lib/query-error-ai";
import { AIError } from "@/lib/ai-chat-engine";
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

/** True when backend ran multiple statements (DDL script); column name "statements". */
function isMultiStatementResult(result: QueryResult): boolean {
    return (
        result.columns.length === 1 &&
        result.columns[0].name === "statements" &&
        result.rows.length === 1
    );
}

/** Display count: for command results use the cell value; for SELECT use row_count. */
function getDisplayCount(result: QueryResult): number {
    if (isCommandResult(result) || isMultiStatementResult(result)) {
        const cell = result.rows[0]?.[0];
        if (cell && "value" in cell && typeof cell.value === "number") return cell.value;
    }
    return result.row_count;
}

/** Human-readable row summary: "2 rows affected" vs "3 rows returned" vs "4 statements executed". */
function getRowCountLabel(result: QueryResult): string {
    const n = getDisplayCount(result);
    if (isMultiStatementResult(result)) {
        return n === 1 ? "1 statement executed" : `${n} statements executed`;
    }
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

function normalizeSqlForCompare(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function getReviewIssueCounts(report: SqlReviewReport) {
    return report.issues.reduce(
        (acc, issue) => {
            if (issue.severity === "block") acc.block += 1;
            if (issue.severity === "warn") acc.warn += 1;
            if (issue.severity === "info") acc.info += 1;
            return acc;
        },
        { block: 0, warn: 0, info: 0 }
    );
}

function columnCacheKey(schema: string, table: string): string {
    return `${schema}.${table}`.toLowerCase();
}

function getCachedColumns(cache: Record<string, string[]>, schema: string, table: string): string[] {
    const scoped = cache[columnCacheKey(schema, table)];
    if (scoped) return scoped;
    return cache[table.toLowerCase()] ?? [];
}

// ── Error panel ────────────────────────────────────────────────────────────

/** Extract quoted or parenthesized name from messages like: function "foo"(date) or function foo(integer) */
function extractObjectName(raw: string, prefix: string): string | null {
    const lower = raw.toLowerCase();
    const i = lower.indexOf(prefix);
    if (i === -1) return null;
    const after = raw.slice(i + prefix.length).trim();
    const match = after.match(/^["']?([a-z_][a-z0-9_]*)/i) || after.match(/^([a-z_][a-z0-9_]*)\s*\(/i);
    return match ? match[1] : null;
}

function explainQueryError(raw: string): { summary: string; fix: string } | null {
    const lower = raw.toLowerCase();
    // Function missing (check before generic "does not exist")
    if (lower.includes("function") && (lower.includes("does not exist") || lower.includes("no function matches"))) {
        const name = extractObjectName(raw, "function");
        const withName = name ? ` The function \`${name}\` is not defined or has different argument types.` : "";
        let fix = "Create the function with CREATE FUNCTION, fix the name/schema, or call an existing overload.";
        if (lower.includes("argument type") || lower.includes("type cast") || lower.includes("explicit type")) {
            fix = "No function matches the name and argument types. Create the function with the right signature, or add explicit casts (e.g. mycol::date).";
        }
        return {
            summary: `A function you're calling doesn't exist in this database.${withName}`,
            fix,
        };
    }
    if (lower.includes("column") && (lower.includes("does not exist") || lower.includes("undefined"))) {
        return {
            summary: "A column in your query doesn't exist on the table.",
            fix: "Check spelling and that the column exists. Use the correct column names from the table definition.",
        };
    }
    if (lower.includes("relation") && lower.includes("does not exist") || (lower.includes("does not exist") && !lower.includes("schema"))) {
        return {
            summary: "The table or view you're referring to doesn't exist.",
            fix: "Check the table name and schema (e.g. public.mytable). Use CREATE TABLE or fix the typo.",
        };
    }
    if (lower.includes("schema") && lower.includes("does not exist")) {
        return {
            summary: "The schema doesn't exist.",
            fix: "Check the schema name (e.g. public). Use CREATE SCHEMA or fix the typo.",
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
            summary: "The connection to the database was lost.",
            fix: "Check your network and DB server. Try reconnecting.",
        };
    }
    return null;
}

interface QueryErrorPanelProps {
    message: string;
    sql?: string;
    schemaContextForAi?: string;
}

function QueryErrorPanel({ message, sql, schemaContextForAi }: QueryErrorPanelProps) {
    const [copied, setCopied] = useState(false);
    const [showTechnical, setShowTechnical] = useState(false);
    const [aiExplanation, setAiExplanation] = useState<string | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const explanation = explainQueryError(message);
    const shortMessage = message.split(/\n/)[0]?.trim() || message;
    const canUseAi = Boolean(sql?.trim() && schemaContextForAi?.trim());

    const handleAiExplain = useCallback(async () => {
        if (!sql?.trim() || !schemaContextForAi?.trim()) return;
        setAiLoading(true);
        setAiError(null);
        setAiExplanation(null);
        try {
            const result = await explainQueryErrorWithAI(sql, message, schemaContextForAi);
            setAiExplanation(result);
        } catch (err) {
            const msg = err instanceof AIError ? err.userMessage : err instanceof Error ? err.message : "Could not get AI explanation.";
            setAiError(msg);
        } finally {
            setAiLoading(false);
        }
    }, [sql, message, schemaContextForAi]);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="p-4 space-y-3">
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-destructive/10">
                        <div className="flex items-center gap-2 min-w-0">
                            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-destructive">Query failed</p>
                                {!explanation && (
                                    <p className="text-xs text-muted-foreground truncate mt-0.5" title={shortMessage}>
                                        {shortMessage}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            {canUseAi && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs border-primary/30 text-primary hover:bg-primary/10"
                                    onClick={handleAiExplain}
                                    disabled={aiLoading}
                                >
                                    {aiLoading ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-3.5 w-3.5" />
                                    )}
                                    AI Explain
                                </Button>
                            )}
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
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                    </div>

                    {explanation ? (
                        <div className="px-4 py-3 space-y-3">
                            <p className="text-sm text-foreground/95">{explanation.summary}</p>
                            <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-2.5">
                                <Lightbulb className="h-4 w-4 text-amber-500/80 mt-0.5 shrink-0" />
                                <div className="text-xs">
                                    <span className="font-medium text-foreground/90">How to fix: </span>
                                    <span className="text-muted-foreground">{explanation.fix}</span>
                                </div>
                            </div>
                        </div>
                    ) : null}

                    {(aiExplanation || aiError) && (
                        <div className="px-4 py-3 border-t border-destructive/10 space-y-2">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                                AI analysis
                            </p>
                            {aiError && (
                                <p className="text-xs text-destructive/90">{aiError}</p>
                            )}
                            {aiExplanation && (
                                <ScrollArea className="max-h-56 rounded-lg border border-border/30 bg-background/90 p-3">
                                    <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-words font-sans">
                                        {aiExplanation}
                                    </pre>
                                </ScrollArea>
                            )}
                        </div>
                    )}

                    <div className="border-t border-destructive/10">
                        <button
                            type="button"
                            onClick={() => setShowTechnical((v) => !v)}
                            className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                        >
                            <ChevronDown
                                className={`h-3.5 w-3.5 shrink-0 transition-transform ${showTechnical ? "rotate-180" : ""}`}
                            />
                            {showTechnical ? "Hide" : "Show"} technical details
                        </button>
                        {showTechnical && (
                            <div className="px-4 pb-4 pt-0">
                                <ScrollArea className="max-h-48 rounded-lg border border-border/30 bg-background/90 p-3">
                                    <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/80">
                                        {message}
                                    </pre>
                                </ScrollArea>
                            </div>
                        )}
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
                                        {entry.aiReview && (
                                            <>
                                                <span className="text-muted-foreground/20">·</span>
                                                <span
                                                    className={cn(
                                                        "text-[10px] font-medium",
                                                        entry.aiReview.overridden
                                                            ? "text-amber-400/80"
                                                            : "text-emerald-400/70"
                                                    )}
                                                >
                                                    {entry.aiReview.overridden ? "AI override" : "AI reviewed"}
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

interface PendingProductionGuardExecution {
    connectionId: string;
    tabId: string;
    sqlSnapshot: string;
    mode: "direct" | "sandbox";
    reviewAudit?: QueryHistoryEntry["aiReview"];
    classification: SqlRiskClassification;
}

export function QueryEditor() {
    const {
        connectionId,
        databaseName,
        tables,
        selectedSchema,
        schemaFunctions,
        connections,
        activeConnectionId,
    } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            databaseName: state.databaseName,
            tables: state.tables,
            selectedSchema: state.selectedSchema,
            schemaFunctions: state.schemaFunctions,
            connections: state.connections,
            activeConnectionId: state.activeConnectionId,
        }))
    );
    const {
        aiReviewEnabled,
        aiReviewAutoOnDml,
        aiReviewUseGemini,
        aiReviewModel,
        aiReviewComplexLineThreshold,
        geminiApiKey,
        strictProductionGuard,
    } = useSettingsStore();
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
    const activeConnectionEntry = useMemo(
        () => connections.find((entry) => entry.connectionId === activeConnectionId) ?? null,
        [connections, activeConnectionId]
    );
    const activeEnvironment = normalizeConnectionEnvironment(activeConnectionEntry?.environment);
    const [reviewReport, setReviewReport] = useState<SqlReviewReport | null>(null);
    const [reviewLoading, setReviewLoading] = useState(false);
    const [reviewPendingApproval, setReviewPendingApproval] = useState<{
        sql: string;
        mode: "direct" | "sandbox";
        trigger: "auto" | "manual";
    } | null>(null);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const [saveNoteOpen, setSaveNoteOpen] = useState(false);
    const [saveNoteTitle, setSaveNoteTitle] = useState("");
    const [saveNoteLoading, setSaveNoteLoading] = useState(false);
    const [editorFullScreen, setEditorFullScreen] = useState(false);
    const [prodGuardPending, setProdGuardPending] = useState<PendingProductionGuardExecution | null>(null);
    const [prodGuardTypedText, setProdGuardTypedText] = useState("");
    const [prodGuardReason, setProdGuardReason] = useState("");
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

    // Column cache for schema-aware completions.
    const [columnCache, setColumnCache] = useState<Record<string, string[]>>({});
    const columnCacheRef = useRef<Record<string, string[]>>({});
    const pendingColumnLoadsRef = useRef<Record<string, Promise<string[]>>>({});

    useEffect(() => { columnCacheRef.current = columnCache; }, [columnCache]);
    useEffect(() => {
        setColumnCache({});
        columnCacheRef.current = {};
        pendingColumnLoadsRef.current = {};
    }, [connectionId]);

    const tablesByPriority = useMemo(() => {
        if (!selectedSchema) return tables;
        return [
            ...tables.filter((table) => table.schema === selectedSchema),
            ...tables.filter((table) => table.schema !== selectedSchema),
        ];
    }, [tables, selectedSchema]);

    // Build schema context from connection store
    const schemaContext = useMemo(
        () => ({
            tables: tablesByPriority.map((t) => t.name),
            columns: tablesByPriority.reduce<Record<string, string[]>>((acc, table) => {
                const tableName = table.name.toLowerCase();
                if (acc[tableName]) return acc;
                acc[tableName] = getCachedColumns(columnCache, table.schema, table.name);
                return acc;
            }, {}),
        }),
        [tablesByPriority, columnCache]
    );

    const tableRowCounts = useMemo(() => {
        const out: Record<string, number> = {};
        for (const table of tables) {
            out[table.name.toLowerCase()] = table.row_count ?? 0;
        }
        return out;
    }, [tables]);

    const tableColumnsForReview = useMemo(() => {
        const out: Record<string, string[]> = {};
        for (const table of tables) {
            const cols = getCachedColumns(columnCache, table.schema, table.name);
            const tableName = table.name.toLowerCase();
            if (!out[tableName] || table.schema === selectedSchema) {
                out[tableName] = cols.map((c) => c.toLowerCase());
            }
        }
        return out;
    }, [tables, columnCache, selectedSchema]);

    const reviewIsStale = useMemo(() => {
        if (!reviewReport || !activeTab?.sql) return false;
        return normalizeSqlForCompare(reviewReport.sql) !== normalizeSqlForCompare(activeTab.sql);
    }, [reviewReport, activeTab?.sql]);

    // Schema summary for AI error explanation (tables + columns, functions in current schema)
    const schemaContextForAi = useMemo(() => {
        const schema = selectedSchema ?? "public";
        const tableLines = tables
            .filter((t) => t.schema === schema)
            .map((t) => `  ${t.schema}.${t.name}: ${getCachedColumns(columnCache, t.schema, t.name).join(", ") || "(columns not loaded)"}`);
        const funcs = schemaFunctions[schema] ?? [];
        const funcLines = funcs
            .filter((f) => !f.is_trigger_function)
            .map((f) => `  ${f.name}(${f.arguments}) -> ${f.return_type}`);
        return [
            "Tables:",
            ...tableLines,
            "",
            "Functions:",
            ...(funcLines.length ? funcLines : ["  (none listed)"]),
        ].join("\n");
    }, [tables, columnCache, selectedSchema, schemaFunctions]);

    // Lazily fetch columns on-demand (e.g. "tableName." typed), with request dedupe.
    const handleFetchColumns = useCallback(
        async (tableName: string): Promise<string[]> => {
            if (!connectionId) return [];
            const normalized = tableName.toLowerCase();
            const tableInfo = tables.find(
                (table) =>
                    table.name.toLowerCase() === normalized &&
                    (!selectedSchema || table.schema === selectedSchema)
            ) ?? tables.find((table) => table.name.toLowerCase() === normalized);
            if (!tableInfo) return [];

            const cacheKey = columnCacheKey(tableInfo.schema, tableInfo.name);
            const cached = getCachedColumns(columnCacheRef.current, tableInfo.schema, tableInfo.name);
            if (cached.length > 0) return cached;

            const requestKey = `${connectionId}:${cacheKey}`;
            const existingRequest = pendingColumnLoadsRef.current[requestKey];
            if (existingRequest) return existingRequest;

            try {
                const request = dbGetColumns(
                    connectionId,
                    tableInfo.schema,
                    tableInfo.name
                ).then((cols) => {
                    if (useConnectionStore.getState().connectionId !== connectionId) return [];
                    const colNames = cols.map((c) => c.name);
                    setColumnCache((prev) => {
                        const next = { ...prev, [cacheKey]: colNames };
                        const unscoped = tableInfo.name.toLowerCase();
                        if (!prev[unscoped] || tableInfo.schema === selectedSchema) {
                            next[unscoped] = colNames;
                        }
                        return next;
                    });
                    return colNames;
                });
                pendingColumnLoadsRef.current[requestKey] = request;
                return await request;
            } catch {
                return [];
            } finally {
                delete pendingColumnLoadsRef.current[`${connectionId}:${cacheKey}`];
            }
        },
        [connectionId, selectedSchema, tables]
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

    // If SQL changed after an auto-review gate, require a fresh review.
    useEffect(() => {
        if (!reviewPendingApproval || !activeTab?.sql) return;
        if (normalizeSqlForCompare(reviewPendingApproval.sql) !== normalizeSqlForCompare(activeTab.sql)) {
            setReviewPendingApproval(null);
        }
    }, [reviewPendingApproval, activeTab?.sql]);

    useEffect(() => {
        if (!prodGuardPending) return;
        const sql = activeTab?.sql.trim() ?? "";
        const guardExpired =
            prodGuardPending.connectionId !== connectionId ||
            prodGuardPending.tabId !== activeTabId ||
            normalizeSqlForCompare(prodGuardPending.sqlSnapshot) !== normalizeSqlForCompare(sql);
        if (!guardExpired) return;
        setProdGuardPending(null);
        setProdGuardTypedText("");
        setProdGuardReason("");
    }, [prodGuardPending, connectionId, activeTabId, activeTab?.sql]);

    // ⌘+Shift+P command palette / ⌘+Shift+H history / Esc exit full-screen
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setEditorFullScreen((v) => (v ? false : v));
                return;
            }
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

    const buildReviewAudit = useCallback(
        (mode: "manual" | "auto", report?: SqlReviewReport): QueryHistoryEntry["aiReview"] | undefined => {
            if (!report) return undefined;
            return {
                mode,
                overridden: report.issues.some(
                    (issue) => issue.severity === "block" || issue.severity === "warn"
                ),
                aiModel: report.aiModel,
                issueCounts: getReviewIssueCounts(report),
            };
        },
        []
    );

    const executeCurrentSql = useCallback(
        (mode: "direct" | "sandbox", reviewAudit?: QueryHistoryEntry["aiReview"], guardReason?: string) => {
            if (!connectionId || !activeTabId) return;
            const sql = activeTab?.sql.trim() ?? "";
            if (!sql) return;

            const guardDecision = shouldRequireProductionGuard({
                strictProductionGuard,
                environment: activeEnvironment,
                sql,
            });
            if (guardDecision.required && !guardReason) {
                setProdGuardPending({
                    connectionId,
                    tabId: activeTabId,
                    sqlSnapshot: sql,
                    mode,
                    reviewAudit,
                    classification: guardDecision.classification,
                });
                setProdGuardTypedText("");
                setProdGuardReason("");
                return;
            }

            if (mode === "sandbox") {
                runInSandbox(connectionId, sql);
                return;
            }

            executeQuery(connectionId, activeTabId, databaseName || undefined, {
                aiReview: reviewAudit,
                environment: activeEnvironment,
                productionGuardReason: guardReason?.trim() || undefined,
            });
        },
        [
            connectionId,
            activeTabId,
            activeTab?.sql,
            strictProductionGuard,
            activeEnvironment,
            databaseName,
            executeQuery,
            runInSandbox,
        ]
    );

    const runQueryReview = useCallback(
        async (trigger: "manual" | "auto"): Promise<SqlReviewReport | null> => {
            if (!activeTab?.sql.trim()) return null;
            const sql = activeTab.sql.trim();

            setReviewLoading(true);
            setReviewPendingApproval(null);
            try {
                const report = await runSqlSafetyReview(
                    sql,
                    {
                        tableColumns: tableColumnsForReview,
                        tableRowCounts,
                        schemaSummary: schemaContextForAi,
                    },
                    {
                        enableGemini: aiReviewUseGemini,
                        geminiApiKey: geminiApiKey.trim(),
                        geminiModel: aiReviewModel,
                        complexLineThreshold: aiReviewComplexLineThreshold,
                    }
                );

                setReviewReport(report);

                if (trigger === "manual") {
                    const counts = getReviewIssueCounts(report);
                    if (counts.block > 0) {
                        toast.error(`AI Review: ${counts.block} blocking issue(s) found.`, { duration: 2600 });
                    } else if (counts.warn > 0) {
                        toast.warning(`AI Review: ${counts.warn} warning(s) found.`, { duration: 2600 });
                    } else {
                        toast.success("AI Review passed.", { duration: 1800 });
                    }
                }

                return report;
            } catch (error) {
                const msg = error instanceof Error ? error.message : "Review failed.";
                toast.error(`AI review failed: ${msg}`, { duration: 3500 });
                return null;
            } finally {
                setReviewLoading(false);
            }
        },
        [
            activeTab?.sql,
            aiReviewUseGemini,
            geminiApiKey,
            aiReviewModel,
            aiReviewComplexLineThreshold,
            tableColumnsForReview,
            tableRowCounts,
            schemaContextForAi,
        ]
    );

    const handleManualReview = useCallback(async () => {
        if (!aiReviewEnabled) {
            toast.info("AI Review Mode is disabled. Enable it in Settings > Query.");
            return;
        }
        await runQueryReview("manual");
    }, [aiReviewEnabled, runQueryReview]);

    const handleRunAfterReview = useCallback(() => {
        if (!reviewPendingApproval || !activeTab?.sql) return;
        const currentSql = activeTab.sql.trim();
        if (normalizeSqlForCompare(reviewPendingApproval.sql) !== normalizeSqlForCompare(currentSql)) {
            setReviewPendingApproval(null);
            toast.info("SQL changed after review. Run review again before executing.");
            return;
        }

        const reviewAudit = buildReviewAudit(reviewPendingApproval.trigger, reviewReport ?? undefined);
        executeCurrentSql(reviewPendingApproval.mode, reviewAudit);
        setReviewPendingApproval(null);
    }, [reviewPendingApproval, activeTab?.sql, executeCurrentSql, reviewReport, buildReviewAudit]);

    const handleCancelPendingReview = useCallback(() => {
        setReviewPendingApproval(null);
    }, []);

    const closeProdGuardDialog = useCallback(() => {
        setProdGuardPending(null);
        setProdGuardTypedText("");
        setProdGuardReason("");
    }, []);

    const handleConfirmProdGuard = useCallback(() => {
        if (!prodGuardPending) return;

        const typedToken = prodGuardTypedText.trim();
        if (typedToken !== STRICT_PRODUCTION_CONFIRMATION) {
            toast.error(`Type exactly "${STRICT_PRODUCTION_CONFIRMATION}" to continue.`);
            return;
        }

        const reason = prodGuardReason.trim();
        if (!reason) {
            toast.error("Please enter a reason before executing on production.");
            return;
        }

        const sql = activeTab?.sql.trim() ?? "";
        const isStillValid =
            prodGuardPending.connectionId === connectionId &&
            prodGuardPending.tabId === activeTabId &&
            normalizeSqlForCompare(prodGuardPending.sqlSnapshot) === normalizeSqlForCompare(sql);
        if (!isStillValid) {
            closeProdGuardDialog();
            toast.info("Query changed. Re-run to review production guard again.");
            return;
        }

        executeCurrentSql(prodGuardPending.mode, prodGuardPending.reviewAudit, reason);
        closeProdGuardDialog();
    }, [
        prodGuardPending,
        prodGuardTypedText,
        prodGuardReason,
        activeTab?.sql,
        connectionId,
        activeTabId,
        closeProdGuardDialog,
        executeCurrentSql,
    ]);

    const handleExecute = useCallback(async () => {
        if (!connectionId || !activeTabId) return;
        const sql = activeTab?.sql.trim() ?? "";
        if (!sql) return;

        const mode: "direct" | "sandbox" = isSandboxMode ? "sandbox" : "direct";
        const intent = getSqlReviewIntent(sql);
        const shouldAutoReview = aiReviewEnabled && aiReviewAutoOnDml && intent.autoReviewCandidate;

        if (!shouldAutoReview) {
            if (reviewPendingApproval) setReviewPendingApproval(null);
            const reviewedForCurrentSql =
                reviewReport && !reviewIsStale ? reviewReport : undefined;
            const reviewAudit = buildReviewAudit("manual", reviewedForCurrentSql);
            executeCurrentSql(mode, reviewAudit);
            return;
        }

        const report = await runQueryReview("auto");
        if (!report) return;

        setReviewPendingApproval({
            sql,
            mode,
            trigger: "auto",
        });
        toast.info("AI review complete. Confirm in the review panel to execute.", { duration: 2600 });
    }, [
        connectionId,
        activeTabId,
        activeTab?.sql,
        isSandboxMode,
        aiReviewEnabled,
        aiReviewAutoOnDml,
        reviewPendingApproval,
        reviewReport,
        reviewIsStale,
        buildReviewAudit,
        executeCurrentSql,
        runQueryReview,
    ]);

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
            await dbExecuteQuery(connectionId, fixSql, { environment: activeEnvironment });
            toast.success("Fix applied — re-analysing plan…", { duration: 2000 });
            await handleExplain(activeTabId, activeTab?.sql.trim());
        } catch (err) {
            toast.error(`Fix failed: ${String(err)}`, { duration: 4000 });
        }
    }, [connectionId, activeTabId, activeTab?.sql, activeEnvironment, handleExplain]);

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
                    if (newTabId) {
                        executeQuery(connectionId, newTabId, databaseName || undefined, {
                            environment: activeEnvironment,
                        });
                    }
                }, 50);
            } else {
                updateSql(activeTabId, sql);
                setTimeout(() => handleExecute(), 50);
            }
            setHistoryOpen(false);
        },
        [connectionId, activeTabId, addTab, updateSql, executeQuery, databaseName, activeEnvironment, handleExecute]
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

            <Dialog open={Boolean(prodGuardPending)} onOpenChange={(open) => { if (!open) closeProdGuardDialog(); }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-base">
                            <ShieldCheck className="h-4.5 w-4.5 text-red-300" />
                            Production guard required
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-100/85">
                            This connection is tagged as{" "}
                            <span className="font-semibold">{formatEnvironmentLabel(activeEnvironment)}</span>.
                            Confirm before executing risky SQL.
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">Detected risky statements:</span>
                            {(prodGuardPending?.classification.riskyStatements ?? []).map((statement) => (
                                <Badge
                                    key={statement}
                                    variant="outline"
                                    className="h-5 px-1.5 text-[10px] border-red-500/30 text-red-300 bg-red-500/10"
                                >
                                    {statement}
                                </Badge>
                            ))}
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">
                                Type <span className="font-mono text-foreground">{STRICT_PRODUCTION_CONFIRMATION}</span>
                            </label>
                            <Input
                                value={prodGuardTypedText}
                                onChange={(event) => setProdGuardTypedText(event.target.value)}
                                placeholder={STRICT_PRODUCTION_CONFIRMATION}
                                className="h-9 font-mono text-xs"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">Reason for this production query</label>
                            <Textarea
                                value={prodGuardReason}
                                onChange={(event) => setProdGuardReason(event.target.value)}
                                placeholder="Describe why this change is needed and what scope it impacts."
                                className="min-h-24 text-sm resize-none"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={closeProdGuardDialog}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className="bg-red-600 hover:bg-red-500 text-white"
                            onClick={handleConfirmProdGuard}
                            disabled={
                                prodGuardTypedText.trim() !== STRICT_PRODUCTION_CONFIRMATION ||
                                !prodGuardReason.trim()
                            }
                        >
                            Continue on production
                        </Button>
                    </DialogFooter>
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
                    <div className="mr-1 flex items-center gap-1.5">
                        <ConnectionEnvBadge environment={activeEnvironment} compact />
                        {strictProductionGuard && activeEnvironment === "prod" && (
                            <Badge
                                variant="outline"
                                className="h-4 px-1.5 text-[9px] border-red-500/30 text-red-300 bg-red-500/10"
                            >
                                Guard
                            </Badge>
                        )}
                    </div>
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

            {/* AI review panel */}
            {aiReviewEnabled && (
                <QueryReviewPanel
                    report={reviewReport}
                    isLoading={reviewLoading}
                    isStale={reviewIsStale}
                    onRecheck={handleManualReview}
                    onClose={() => {
                        setReviewReport(null);
                        setReviewPendingApproval(null);
                    }}
                    pendingApproval={Boolean(reviewPendingApproval)}
                    onRunPending={handleRunAfterReview}
                    onCancelPending={handleCancelPendingReview}
                />
            )}

            {/* Editor area */}
            {activeTab && (
                <>
                    {/* Full-screen editor overlay */}
                    {editorFullScreen && (
                        <div className="fixed inset-0 z-50 bg-background flex flex-col">
                            <header className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-card/50 shrink-0">
                                <span className="text-sm font-medium text-muted-foreground">Query editor</span>
                                <div className="flex items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-1.5"
                                        onClick={handleManualReview}
                                        disabled={!activeTab.sql.trim() || activeTab.isExecuting || reviewLoading || !aiReviewEnabled}
                                    >
                                        {reviewLoading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Shield className="h-3.5 w-3.5" />
                                        )}
                                        Review
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-1.5"
                                        onClick={handleExecute}
                                        disabled={
                                            activeTab.isExecuting ||
                                            reviewLoading ||
                                            isSandboxBusy ||
                                            isSandboxReviewing ||
                                            !activeTab.sql.trim()
                                        }
                                    >
                                        {activeTab.isExecuting || isSandboxBusy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play className="h-3.5 w-3.5" />
                                        )}
                                        Run
                                    </Button>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 gap-1.5"
                                                onClick={() => setEditorFullScreen(false)}
                                            >
                                                <Minimize2 className="h-3.5 w-3.5" />
                                                Exit full screen
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Exit full screen (Esc)</TooltipContent>
                                    </Tooltip>
                                </div>
                            </header>
                            <div className="flex-1 min-h-0 flex flex-col">
                                <div className="shrink-0 border-b border-border/30">
                                    <MonacoSqlEditor
                                        value={activeTab.sql}
                                        onChange={(v) => updateSql(activeTab.id, v)}
                                        onExecute={handleExecute}
                                        onReview={handleManualReview}
                                        onFormatSql={handleFormatSql}
                                        onFetchColumns={handleFetchColumns}
                                        onNextAction={handleNextAction}
                                        reviewIssues={reviewReport?.issues ?? []}
                                        schemaContext={schemaContext}
                                        disabled={activeTab.isExecuting}
                                        className="rounded-none border-0"
                                        editorHeight={380}
                                        hideNextActionSuggestions
                                    />
                                </div>
                                <div className="flex-1 min-h-0 overflow-auto flex flex-col p-4">
                                    {activeTab.result ? (
                                        activeTab.result.is_error ? (
                                            <QueryErrorPanel
                                                message={activeTab.result.error_message ?? "Unknown error"}
                                                sql={activeTab.sql}
                                                schemaContextForAi={schemaContextForAi}
                                            />
                                        ) : (
                                            <div className="space-y-3">
                                                <div className="flex items-center gap-3 text-sm">
                                                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                                                        {getRowCountLabel(activeTab.result)}
                                                    </span>
                                                    <Badge variant="outline" className="text-xs font-mono">
                                                        {activeTab.result.execution_time_ms.toFixed(1)}ms
                                                    </Badge>
                                                </div>
                                                {!isCommandResult(activeTab.result) && !isMultiStatementResult(activeTab.result) && activeTab.result.columns.length > 0 && (
                                                    <VirtualizedQueryResultTable
                                                        result={activeTab.result}
                                                        showRowIndex={false}
                                                        maxHeight="40vh"
                                                        compact
                                                    />
                                                )}
                                                {(isCommandResult(activeTab.result) || isMultiStatementResult(activeTab.result)) && (
                                                    <p className="text-sm text-muted-foreground">
                                                        {isMultiStatementResult(activeTab.result)
                                                            ? `${getDisplayCount(activeTab.result)} statement(s) executed successfully.`
                                                            : `${getDisplayCount(activeTab.result).toLocaleString()} row(s) affected.`}
                                                    </p>
                                                )}
                                            </div>
                                        )
                                    ) : (
                                        <p className="text-sm text-muted-foreground">Run a query to see results.</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <ResizablePanelGroup
                        id="query-editor-resize-group"
                        orientation="vertical"
                        className="flex-1 min-h-0"
                    >
                        <ResizablePanel
                            id="query-editor-sql-panel"
                            defaultSize={42}
                            minSize={20}
                            maxSize={75}
                            className="flex flex-col min-h-0"
                        >
                            <div className="relative border-b border-border/30 flex flex-col min-h-0">
                                <MonacoSqlEditor
                                    value={activeTab.sql}
                                    onChange={(v) => updateSql(activeTab.id, v)}
                                    onExecute={handleExecute}
                                    onReview={handleManualReview}
                                    onFormatSql={handleFormatSql}
                                    onFetchColumns={handleFetchColumns}
                                    onNextAction={handleNextAction}
                                    reviewIssues={reviewReport?.issues ?? []}
                                    schemaContext={schemaContext}
                                    disabled={activeTab.isExecuting}
                                    className="rounded-none border-0"
                                    hideNextActionSuggestions
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
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70"
                                        onClick={handleManualReview}
                                        disabled={!activeTab.sql.trim() || activeTab.isExecuting || reviewLoading || !aiReviewEnabled}
                                    >
                                        {reviewLoading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Shield className="h-3.5 w-3.5" />
                                        )}
                                        Review
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>AI Review Mode (⌘R)</TooltipContent>
                            </Tooltip>
                            <span className="text-[10px] text-muted-foreground/40 font-mono">
                                ⌘+Enter to run
                            </span>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs text-muted-foreground/50 hover:text-foreground px-2"
                                        onClick={() => setEditorFullScreen((v) => !v)}
                                    >
                                        <Maximize2 className="h-3.5 w-3.5" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Full-screen editor</TooltipContent>
                            </Tooltip>
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
                                    reviewLoading ||
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
                        </ResizablePanel>

                        <ResizableHandle
                            withHandle
                            className="shrink-0 min-h-2 py-1 bg-border/20 hover:bg-border/50 data-[resize-handle-active]:bg-emerald-500/40 transition-colors"
                        />

                        <ResizablePanel
                            id="query-editor-results-panel"
                            defaultSize={58}
                            minSize={28}
                            maxSize={80}
                            className="flex flex-col min-h-0 overflow-hidden"
                        >
                    {/* Results */}
                    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">

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
                                    Write SQL above and press ⌘+Enter. Changes will not be committed until you approve.
                                </p>
                            </div>
                        )}

                        {/* Results / Plan / Canvas tab switcher */}
                        {!isSandboxMode && (activeTab.result || activePlan) && (
                            <div className="flex items-center gap-0.5 border-b border-border/20 bg-muted/20 px-2 shrink-0">
                                <button
                                    className={cn(
                                        "px-3 py-2 text-[11px] font-medium border-b-2 transition-colors -mb-px",
                                        activeResultView === "results"
                                            ? "border-primary text-foreground"
                                            : "border-transparent text-muted-foreground hover:text-foreground/80"
                                    )}
                                    onClick={() => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: "results" }))}
                                >
                                    Results
                                </button>
                                {activePlan && (
                                    <button
                                        className={cn(
                                            "flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium border-b-2 transition-colors -mb-px",
                                            activeResultView === "plan"
                                                ? "border-primary text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground/80"
                                        )}
                                        onClick={() => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: "plan" }))}
                                    >
                                        <GitBranch className="h-3 w-3" />
                                        Plan
                                    </button>
                                )}
                                {activeTab.result &&
                                    !activeTab.result.is_error &&
                                    activeTab.result.columns.length > 0 &&
                                    !isCommandResult(activeTab.result) &&
                                    !isMultiStatementResult(activeTab.result) && (
                                        <button
                                            className={cn(
                                                "flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium border-b-2 transition-colors -mb-px",
                                                activeResultView === "canvas"
                                                    ? "border-primary text-foreground"
                                                    : "border-transparent text-muted-foreground hover:text-foreground/80"
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
                                    sql={activeTab.sql}
                                    schemaContextForAi={schemaContextForAi}
                                />
                            ) : (
                                <div className="flex h-full min-h-0 flex-col">
                                    {/* Slow query banner */}
                                    {activeTab.result.execution_time_ms > 500 && activeResultView === "results" && (
                                        <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-amber-500/5 border-b border-amber-500/15 shrink-0">
                                            <div className="flex items-center gap-2">
                                                <AlertCircle className="h-3 w-3 text-amber-500 shrink-0" />
                                                <span className="text-[11px] text-muted-foreground">
                                                    Slow query ({activeTab.result.execution_time_ms.toFixed(0)}ms)
                                                </span>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-6 px-2 text-[11px] gap-1 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shrink-0"
                                                onClick={() => handleExplain()}
                                                disabled={isExplaining}
                                            >
                                                {isExplaining ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                                                Explain
                                            </Button>
                                        </div>
                                    )}
                                    {/* Result info bar — success message and stats */}
                                    <div className="flex items-center justify-between gap-4 px-4 py-2 border-b border-border/20 bg-muted/30 shrink-0">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <div className="flex items-center gap-2">
                                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                                <span className="text-xs font-medium text-foreground/90">
                                                    {getRowCountLabel(activeTab.result)}
                                                </span>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="text-[10px] font-mono gap-1 border-border/40 text-muted-foreground"
                                            >
                                                <Clock className="h-2.5 w-2.5" />
                                                {activeTab.result.execution_time_ms.toFixed(1)}ms
                                            </Badge>
                                        </div>

                                        {/* Export dropdown — only for result sets with multiple columns */}
                                        <div className="flex items-center gap-1">
                                            {!isCommandResult(activeTab.result) && !isMultiStatementResult(activeTab.result) && (
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

                                    {/* Result: compact message for INSERT/UPDATE/DELETE/multi-statement, table for SELECT */}
                                    {isCommandResult(activeTab.result) || isMultiStatementResult(activeTab.result) ? (
                                        <div className="flex-1 flex items-center justify-center p-6">
                                            <p className="text-sm text-muted-foreground">
                                                {isMultiStatementResult(activeTab.result)
                                                    ? `${getDisplayCount(activeTab.result)} statement${getDisplayCount(activeTab.result) !== 1 ? "s" : ""} executed successfully.`
                                                    : `${getDisplayCount(activeTab.result).toLocaleString()} row${getDisplayCount(activeTab.result) !== 1 ? "s" : ""} affected.`}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="flex-1 min-h-0 overflow-hidden">
                                            <VirtualizedQueryResultTable
                                                result={activeTab.result}
                                                showRowIndex
                                                className="h-full"
                                            />
                                        </div>
                                    )}
                                </div>
                            )
                        ) : null}

                        {!isSandboxMode && activeResultView === "results" && activeTab.isExecuting && !activeTab.result && (
                            <div className="flex-1 flex items-center justify-center min-h-[200px]">
                                <div className="flex flex-col items-center gap-4">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                                        <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
                                    </div>
                                    <p className="text-sm font-medium text-foreground/80">Executing query…</p>
                                    <p className="text-xs text-muted-foreground/60">Results will appear here</p>
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
                        </ResizablePanel>
                    </ResizablePanelGroup>
                </>
            )}
        </div>
    );
}
