"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SqlReviewReport, SqlReviewIssue } from "@/lib/sql-review";
import { cn } from "@/lib/utils";
import {
    AlertCircle,
    CheckCircle2,
    Info,
    Shield,
    ShieldAlert,
    XCircle,
} from "lucide-react";

interface QueryReviewPanelProps {
    report: SqlReviewReport | null;
    isLoading: boolean;
    isStale?: boolean;
    onRecheck?: () => void;
    onClose?: () => void;
    pendingApproval?: boolean;
    onRunPending?: () => void;
    onCancelPending?: () => void;
}

function severityLabel(severity: SqlReviewIssue["severity"]): string {
    if (severity === "block") return "Block";
    if (severity === "warn") return "Warn";
    return "Info";
}

function severityClass(severity: SqlReviewIssue["severity"]): string {
    if (severity === "block") return "border-red-500/35 bg-red-500/7";
    if (severity === "warn") return "border-amber-500/35 bg-amber-500/8";
    return "border-sky-500/30 bg-sky-500/8";
}

function severityIcon(severity: SqlReviewIssue["severity"]) {
    if (severity === "block") return <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />;
    if (severity === "warn") return <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />;
    return <Info className="h-3.5 w-3.5 text-sky-400 shrink-0 mt-0.5" />;
}

export function QueryReviewPanel({
    report,
    isLoading,
    isStale = false,
    onRecheck,
    onClose,
    pendingApproval = false,
    onRunPending,
    onCancelPending,
}: QueryReviewPanelProps) {
    if (!isLoading && !report) return null;

    const blockCount = report?.issues.filter((i) => i.severity === "block").length ?? 0;
    const warnCount = report?.issues.filter((i) => i.severity === "warn").length ?? 0;
    const infoCount = report?.issues.filter((i) => i.severity === "info").length ?? 0;

    return (
        <div className="border-b border-border/25 bg-card/20 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    {pendingApproval ? (
                        <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
                    ) : (
                        <Shield className="h-4 w-4 text-emerald-400 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-foreground/90">AI Review Mode</span>
                    {isLoading ? (
                        <Badge variant="outline" className="text-[10px]">Reviewing...</Badge>
                    ) : (
                        <>
                            <Badge
                                variant="outline"
                                className={cn(
                                    "text-[10px]",
                                    blockCount > 0
                                        ? "border-red-500/40 text-red-400"
                                        : warnCount > 0
                                            ? "border-amber-500/40 text-amber-400"
                                            : "border-emerald-500/40 text-emerald-400"
                                )}
                            >
                                {blockCount > 0 ? "Blocked" : warnCount > 0 ? "Warnings" : "Passed"}
                            </Badge>
                            {report?.aiUsed && report.aiModel && (
                                <Badge variant="secondary" className="text-[10px] font-mono">
                                    {report.aiModel}
                                </Badge>
                            )}
                            {isStale && (
                                <Badge variant="outline" className="text-[10px] border-border/40">
                                    SQL changed
                                </Badge>
                            )}
                        </>
                    )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {onRecheck && (
                        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={onRecheck}>
                            Recheck
                        </Button>
                    )}
                    {onClose && (
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={onClose}>
                            Hide
                        </Button>
                    )}
                </div>
            </div>

            {!isLoading && report && (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px] border-red-500/35 text-red-400">
                            {blockCount} block
                        </Badge>
                        <Badge variant="outline" className="text-[10px] border-amber-500/35 text-amber-400">
                            {warnCount} warn
                        </Badge>
                        <Badge variant="outline" className="text-[10px] border-sky-500/35 text-sky-400">
                            {infoCount} info
                        </Badge>
                        <Badge variant="secondary" className="text-[10px] font-mono">
                            local {report.localDurationMs}ms
                        </Badge>
                        {report.aiDurationMs != null && (
                            <Badge variant="secondary" className="text-[10px] font-mono">
                                ai {report.aiDurationMs}ms
                            </Badge>
                        )}
                    </div>

                    {report.aiError && (
                        <p className="text-xs text-muted-foreground/70">
                            Gemini note: {report.aiError}
                        </p>
                    )}

                    {report.issues.length === 0 ? (
                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            No safety issues detected by the local rule checks.
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-56 overflow-auto pr-1">
                            {report.issues.map((issue, idx) => (
                                <div
                                    key={`${issue.id}-${idx}`}
                                    className={cn("rounded-lg border px-3 py-2", severityClass(issue.severity))}
                                >
                                    <div className="flex items-start gap-2">
                                        {severityIcon(issue.severity)}
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="text-xs font-medium text-foreground/90">{issue.title}</span>
                                                <Badge variant="outline" className="text-[9px]">
                                                    {severityLabel(issue.severity)}
                                                </Badge>
                                                {issue.line && (
                                                    <Badge variant="secondary" className="text-[9px] font-mono">
                                                        L{issue.line}
                                                    </Badge>
                                                )}
                                                {issue.source === "gemini" && (
                                                    <Badge variant="secondary" className="text-[9px] font-mono">
                                                        gemini
                                                    </Badge>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                                {issue.message}
                                            </p>
                                            {issue.suggestion && (
                                                <p className="text-xs text-foreground/80 mt-1.5">
                                                    Suggested fix: {issue.suggestion}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {pendingApproval && (
                        <div className="flex items-center justify-end gap-2 border-t border-border/20 pt-2">
                            {onCancelPending && (
                                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onCancelPending}>
                                    Cancel
                                </Button>
                            )}
                            {onRunPending && (
                                <Button
                                    size="sm"
                                    className="h-8 text-xs bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white"
                                    onClick={onRunPending}
                                >
                                    Looks Good - Run Anyway
                                </Button>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

