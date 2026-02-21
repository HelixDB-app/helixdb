"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
    CheckCircle2,
    XCircle,
    AlertTriangle,
    AlertCircle,
    Loader2,
    ChevronDown,
    ChevronRight,
    Shield,
    Rows3,
    Columns3,
    Trash2,
    Plus,
    RefreshCcw,
} from "lucide-react";
import type { SandboxExecuteResult, SandboxDiffRow } from "@/lib/tauri";
import type { SandboxHistoryEntry } from "@/stores/sandbox-store";

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
}

function countChangedColumns(result: SandboxExecuteResult): number {
    if (result.query_type === "INSERT" || result.query_type === "DELETE") {
        return result.columns.length;
    }
    const changed = new Set<number>();
    for (const row of result.diff_rows) {
        if (row.before && row.after) {
            for (let i = 0; i < result.columns.length; i++) {
                if ((row.before[i] ?? null) !== (row.after[i] ?? null)) {
                    changed.add(i);
                }
            }
        }
    }
    return changed.size;
}

function countDeletedRows(result: SandboxExecuteResult): number {
    return result.diff_rows.filter((r) => r.after === null).length;
}

// ── Query type badge ───────────────────────────────────────────────────────

function QueryTypeBadge({ type }: { type: string }) {
    const config: Record<string, { label: string; className: string }> = {
        UPDATE: { label: "UPDATE", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
        DELETE: { label: "DELETE", className: "bg-red-500/15 text-red-400 border-red-500/30" },
        INSERT: { label: "INSERT", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
        TRUNCATE: { label: "TRUNCATE", className: "bg-red-600/15 text-red-400 border-red-600/30" },
        DROP: { label: "DROP", className: "bg-red-600/15 text-red-400 border-red-600/30" },
        SELECT: { label: "SELECT", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    };
    const c = config[type.toUpperCase()] ?? { label: type, className: "bg-muted/30 text-muted-foreground border-border/30" };
    return (
        <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold border", c.className)}>
            {c.label}
        </span>
    );
}

// ── Warning banner ─────────────────────────────────────────────────────────

function WarningBanner({ level, message }: { level: "error" | "warn"; message: string }) {
    return (
        <div
            className={cn(
                "flex items-start gap-2.5 px-4 py-3 text-xs rounded-lg border",
                level === "error"
                    ? "bg-red-500/8 border-red-500/20 text-red-400"
                    : "bg-amber-500/8 border-amber-500/20 text-amber-400"
            )}
        >
            {level === "error" ? (
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            ) : (
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            )}
            <span className="leading-relaxed">{message}</span>
        </div>
    );
}

// ── Missing WHERE confirmation ─────────────────────────────────────────────

function MissingWhereBlock({
    onConfirm,
    isConfirmed,
}: {
    onConfirm: () => void;
    isConfirmed: boolean;
}) {
    const [text, setText] = useState("");
    const ready = text.trim().toUpperCase() === "I UNDERSTAND";
    return (
        <div className="space-y-2 p-3 rounded-lg border border-red-500/25 bg-red-500/5">
            <p className="text-[11px] text-red-400 font-medium">
                This will affect ALL rows in the table. Type <span className="font-mono font-bold">I UNDERSTAND</span> to enable the Commit button.
            </p>
            {!isConfirmed && (
                <div className="flex gap-2 items-center">
                    <input
                        type="text"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="I UNDERSTAND"
                        className="flex-1 px-2 py-1 text-xs font-mono bg-background border border-red-500/30 rounded text-red-300 placeholder:text-red-900/50 focus:outline-none focus:border-red-500/60"
                    />
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10"
                        disabled={!ready}
                        onClick={onConfirm}
                    >
                        Confirm
                    </Button>
                </div>
            )}
            {isConfirmed && (
                <p className="text-[11px] text-red-300 font-medium">
                    ✓ Confirmed — Commit is now enabled.
                </p>
            )}
        </div>
    );
}

// ── Summary bar ────────────────────────────────────────────────────────────

function SummaryBar({
    result,
    elapsedSecs,
}: {
    result: SandboxExecuteResult;
    elapsedSecs: number;
}) {
    const changedCols = countChangedColumns(result);
    const deletedRows = countDeletedRows(result);

    return (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-card/30 border-b border-border/20">
            <div className="flex items-center gap-1.5">
                <Rows3 className="h-3.5 w-3.5 text-muted-foreground/60" />
                <span className="text-xs font-semibold text-foreground/90">
                    {result.rows_affected.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground/60">rows affected</span>
            </div>
            {changedCols > 0 && (
                <>
                    <span className="text-muted-foreground/20">·</span>
                    <div className="flex items-center gap-1.5">
                        <Columns3 className="h-3.5 w-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-foreground/90">{changedCols}</span>
                        <span className="text-xs text-muted-foreground/60">columns changed</span>
                    </div>
                </>
            )}
            {deletedRows > 0 && result.query_type === "DELETE" && (
                <>
                    <span className="text-muted-foreground/20">·</span>
                    <div className="flex items-center gap-1.5">
                        <Trash2 className="h-3.5 w-3.5 text-red-400/70" />
                        <span className="text-xs font-semibold text-red-400">
                            {deletedRows.toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground/60">rows deleted</span>
                    </div>
                </>
            )}
            {elapsedSecs > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground/40 font-mono">
                    txn open {elapsedSecs}s
                </span>
            )}
        </div>
    );
}

// ── Diff table ─────────────────────────────────────────────────────────────

function DiffTable({ result }: { result: SandboxExecuteResult }) {
    const { columns, diff_rows, query_type } = result;
    const MAX_VISIBLE = 100;
    const [showAll, setShowAll] = useState(false);
    const visible = showAll ? diff_rows : diff_rows.slice(0, MAX_VISIBLE);
    const hidden = diff_rows.length - MAX_VISIBLE;

    if (diff_rows.length === 0) return null;

    const isBefore = (row: SandboxDiffRow) => row.before !== null;
    const isAfter = (row: SandboxDiffRow) => row.after !== null;
    const showBefore = diff_rows.some(isBefore);
    const showAfter = diff_rows.some(isAfter);

    return (
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <ScrollArea className="flex-1 min-h-0">
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent border-border/30">
                            <TableHead className="w-10 text-center text-[10px] font-mono text-muted-foreground/40 sticky left-0 bg-card/80">
                                #
                            </TableHead>
                            {columns.map((col, ci) => (
                                <TableHead key={ci} className="whitespace-nowrap min-w-[120px]">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-xs font-semibold">{col}</span>
                                    </div>
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {visible.map((row, ri) => {
                            const isInsert = row.before === null && row.after !== null;
                            const isDelete = row.before !== null && row.after === null;

                            if (isInsert) {
                                return (
                                    <TableRow key={ri} className="border-border/20 bg-emerald-500/4 hover:bg-emerald-500/8">
                                        <TableCell className="text-center text-[10px] font-mono text-emerald-400/60 sticky left-0 bg-emerald-500/4">
                                            <Plus className="h-3 w-3 mx-auto" />
                                        </TableCell>
                                        {columns.map((_, ci) => (
                                            <TableCell
                                                key={ci}
                                                className="text-xs font-mono text-emerald-300 max-w-xs truncate"
                                            >
                                                {row.after?.[ci] ?? <span className="text-muted-foreground/30 italic">null</span>}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                );
                            }

                            if (isDelete) {
                                return (
                                    <TableRow key={ri} className="border-border/20 bg-red-500/4 hover:bg-red-500/8">
                                        <TableCell className="text-center text-[10px] font-mono text-red-400/60 sticky left-0 bg-red-500/4">
                                            <Trash2 className="h-3 w-3 mx-auto" />
                                        </TableCell>
                                        {columns.map((_, ci) => (
                                            <TableCell
                                                key={ci}
                                                className="text-xs font-mono text-red-300/80 max-w-xs truncate line-through decoration-red-500/40"
                                            >
                                                {row.before?.[ci] ?? <span className="text-muted-foreground/30 italic">null</span>}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                );
                            }

                            // UPDATE: show before → after inline, highlight changed cells
                            const changedCols = new Set<number>();
                            if (row.before && row.after) {
                                for (let ci = 0; ci < columns.length; ci++) {
                                    if ((row.before[ci] ?? null) !== (row.after[ci] ?? null)) {
                                        changedCols.add(ci);
                                    }
                                }
                            }

                            return (
                                <TableRow key={ri} className="border-border/20 hover:bg-accent/20">
                                    <TableCell className="text-center text-[10px] font-mono text-muted-foreground/40 sticky left-0 bg-card/80">
                                        {ri + 1}
                                    </TableCell>
                                    {columns.map((_, ci) => {
                                        const changed = changedCols.has(ci);
                                        const before = row.before?.[ci] ?? null;
                                        const after = row.after?.[ci] ?? null;
                                        return (
                                            <TableCell
                                                key={ci}
                                                className={cn(
                                                    "text-xs font-mono max-w-xs",
                                                    changed && "bg-amber-500/8 rounded"
                                                )}
                                            >
                                                {changed ? (
                                                    <div className="flex flex-col gap-0.5">
                                                        <span className="text-red-400/70 line-through decoration-red-500/40 truncate">
                                                            {before ?? <span className="italic">null</span>}
                                                        </span>
                                                        <span className="text-emerald-400 truncate">
                                                            {after ?? <span className="italic">null</span>}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="text-muted-foreground/70 truncate">
                                                        {after ?? before ?? <span className="text-muted-foreground/30 italic">null</span>}
                                                    </span>
                                                )}
                                            </TableCell>
                                        );
                                    })}
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
                <ScrollBar orientation="horizontal" />
            </ScrollArea>

            {!showAll && hidden > 0 && (
                <div className="border-t border-border/20 px-4 py-2 bg-card/20 shrink-0">
                    <button
                        className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
                        onClick={() => setShowAll(true)}
                    >
                        <ChevronDown className="h-3 w-3" />
                        Show {hidden.toLocaleString()} more rows…
                    </button>
                </div>
            )}
        </div>
    );
}

// ── Select result (for SELECT in sandbox) ─────────────────────────────────

function SelectResultTable({ result }: { result: SandboxExecuteResult }) {
    return (
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <ScrollArea className="flex-1 min-h-0">
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent border-border/30">
                            <TableHead className="w-10 text-center text-[10px] font-mono text-muted-foreground/40">
                                #
                            </TableHead>
                            {result.select_columns.map((col, i) => (
                                <TableHead key={i} className="whitespace-nowrap">
                                    <span className="text-xs font-semibold">{col}</span>
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {result.select_rows.map((row, ri) => (
                            <TableRow key={ri} className="border-border/20 hover:bg-accent/20">
                                <TableCell className="text-center text-[10px] font-mono text-muted-foreground/40">
                                    {ri + 1}
                                </TableCell>
                                {row.map((cell, ci) => (
                                    <TableCell
                                        key={ci}
                                        className={cn(
                                            "text-xs font-mono max-w-xs truncate",
                                            cell === null && "text-muted-foreground/30 italic"
                                        )}
                                    >
                                        {cell ?? "null"}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <ScrollBar orientation="horizontal" />
            </ScrollArea>
        </div>
    );
}

// ── Sandbox History ────────────────────────────────────────────────────────

export function SandboxHistory({
    history,
    onClear,
    onReview,
}: {
    history: SandboxHistoryEntry[];
    onClear: () => void;
    onReview?: (entry: SandboxHistoryEntry) => void;
}) {
    const [expanded, setExpanded] = useState<string | null>(null);

    if (history.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-8 text-center">
                <Shield className="h-7 w-7 text-muted-foreground/20 mb-2" />
                <p className="text-xs text-muted-foreground/40">No sandbox sessions yet</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/20 shrink-0">
                <span className="text-xs font-medium text-muted-foreground/70">
                    Sandbox History ({history.length})
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive gap-1"
                    onClick={onClear}
                >
                    <Trash2 className="h-3 w-3" />
                    Clear
                </Button>
            </div>
            <ScrollArea className="flex-1 min-h-0">
                <div className="divide-y divide-border/10">
                    {history.map((entry) => (
                        <div key={entry.id} className="px-4 py-2.5">
                            <div className="flex items-center gap-2 mb-1">
                                <QueryTypeBadge type={entry.query_type} />
                                <Badge
                                    variant="outline"
                                    className={cn(
                                        "text-[9px] px-1.5 py-0",
                                        entry.outcome === "committed"
                                            ? "border-emerald-500/30 text-emerald-400"
                                            : "border-red-500/30 text-red-400"
                                    )}
                                >
                                    {entry.outcome === "committed" ? "COMMITTED" : "ROLLED BACK"}
                                </Badge>
                                <span className="ml-auto text-[10px] text-muted-foreground/40">
                                    {timeAgo(entry.timestamp)}
                                </span>
                            </div>
                            <p className="text-[11px] font-mono text-foreground/70 truncate">
                                {entry.sql.replace(/\s+/g, " ").slice(0, 120)}
                            </p>
                            <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                                {entry.rows_affected.toLocaleString()} rows affected
                            </p>
                        </div>
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}

// ── Main diff viewer ───────────────────────────────────────────────────────

interface SandboxDiffViewerProps {
    result: SandboxExecuteResult;
    sql: string;
    elapsedSecs: number;
    anomalyWarning: string | null;
    onCommit: () => void;
    onRollback: () => void;
    isCommitting: boolean;
    isRollingBack: boolean;
}

export function SandboxDiffViewer({
    result,
    sql,
    elapsedSecs,
    anomalyWarning,
    onCommit,
    onRollback,
    isCommitting,
    isRollingBack,
}: SandboxDiffViewerProps) {
    const [missingWhereConfirmed, setMissingWhereConfirmed] = useState(false);
    const isSelect = result.query_type === "SELECT";
    const isBusy = isCommitting || isRollingBack;
    const commitDisabled = isBusy || (result.missing_where && !missingWhereConfirmed);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/20 bg-card/30 shrink-0">
                <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-emerald-400" />
                    <span className="text-xs font-semibold text-foreground/90">Sandbox Preview</span>
                    <QueryTypeBadge type={result.query_type} />
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {!isSelect && (
                        <>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                                onClick={onRollback}
                                disabled={isBusy}
                            >
                                {isRollingBack ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <XCircle className="h-3.5 w-3.5" />
                                )}
                                Rollback
                            </Button>
                            <Button
                                size="sm"
                                className={cn(
                                    "h-8 gap-1.5 text-xs",
                                    commitDisabled
                                        ? "bg-muted text-muted-foreground cursor-not-allowed"
                                        : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-600/20"
                                )}
                                onClick={onCommit}
                                disabled={commitDisabled}
                            >
                                {isCommitting ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                )}
                                Commit
                            </Button>
                        </>
                    )}
                    {isSelect && (
                        <Badge variant="secondary" className="text-[10px]">
                            Read-only — no changes to commit
                        </Badge>
                    )}
                </div>
            </div>

            {/* Warnings */}
            {(result.warnings.length > 0 || anomalyWarning) && (
                <div className="px-4 py-2 space-y-2 border-b border-border/20 bg-card/10 shrink-0">
                    {result.missing_where && (
                        <WarningBanner
                            level="error"
                            message={result.warnings.find((w) => w.includes("WHERE")) ?? "No WHERE clause detected!"}
                        />
                    )}
                    {result.warnings
                        .filter((w) => !w.includes("WHERE"))
                        .map((w, i) => (
                            <WarningBanner key={i} level="warn" message={w} />
                        ))}
                    {anomalyWarning && (
                        <WarningBanner level="warn" message={anomalyWarning} />
                    )}
                    {result.missing_where && !isSelect && (
                        <MissingWhereBlock
                            onConfirm={() => setMissingWhereConfirmed(true)}
                            isConfirmed={missingWhereConfirmed}
                        />
                    )}
                </div>
            )}

            {/* Summary */}
            {!isSelect && <SummaryBar result={result} elapsedSecs={elapsedSecs} />}

            {/* Diff table or SELECT result */}
            {isSelect ? (
                <SelectResultTable result={result} />
            ) : result.diff_rows.length > 0 ? (
                <DiffTable result={result} />
            ) : (
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center space-y-1">
                        <RefreshCcw className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground/60">
                            {result.rows_affected > 0
                                ? `${result.rows_affected.toLocaleString()} rows affected`
                                : "Query executed — no rows to preview"}
                        </p>
                        <p className="text-xs text-muted-foreground/40">
                            {result.query_type === "TRUNCATE" || result.query_type === "DROP"
                                ? "Review carefully before committing."
                                : "Commit or rollback to finalize."}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
