"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PgStatStatementsSetupGuideDialog } from "@/components/pg-stat-statements-setup-guide-dialog";
import type { PgStatStatementsStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertCircle, BookOpen, ChevronDown, Copy, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";

function statusIssues(status: PgStatStatementsStatus): string[] {
    if (status.issues && status.issues.length > 0) return status.issues;
    if (status.message?.trim()) return [status.message];
    return [];
}

export type PgStatStatementsSetupCalloutProps = {
    status: PgStatStatementsStatus;
    onSetup: () => void;
    isSettingUp: boolean;
};

export function PgStatStatementsSetupCallout({
    status,
    onSetup,
    isSettingUp,
}: PgStatStatementsSetupCalloutProps) {
    const [guideOpen, setGuideOpen] = useState(false);
    const issues = statusIssues(status);

    const copySuggestedLine = () => {
        const line = status.suggested_shared_preload_line?.trim();
        if (!line) {
            toast.error("No suggested line available.");
            return;
        }
        void navigator.clipboard.writeText(line).then(
            () => toast.success("Config line copied"),
            () => toast.error("Could not copy to clipboard")
        );
    };

    return (
        <>
            <PgStatStatementsSetupGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
            <div
                className={cn(
                    "shrink-0 border-b px-4 py-3.5",
                    "border-amber-400/30 bg-gradient-to-b from-amber-500/[0.12] via-amber-500/[0.06] to-transparent"
                )}
            >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-200">
                                <AlertCircle className="h-4 w-4" />
                            </div>
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold tracking-tight text-amber-50">
                                    pg_stat_statements is not ready
                                </p>
                                {!status.preload_enabled ? (
                                    <Badge
                                        variant="outline"
                                        className="h-5 border-amber-400/35 bg-amber-950/40 text-[10px] font-medium text-amber-100/90"
                                    >
                                        Server preload required
                                    </Badge>
                                ) : !status.extension_installed ? (
                                    <Badge
                                        variant="outline"
                                        className="h-5 border-amber-400/35 bg-amber-950/40 text-[10px] font-medium text-amber-100/90"
                                    >
                                        Extension missing
                                    </Badge>
                                ) : (
                                    <Badge
                                        variant="outline"
                                        className="h-5 border-amber-400/35 bg-amber-950/40 text-[10px] font-medium text-amber-100/90"
                                    >
                                        Check permissions / restart
                                    </Badge>
                                )}
                            </div>
                        </div>
                        <p className="text-xs leading-relaxed text-amber-100/80">
                            Query statistics need the module in{" "}
                            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px] text-emerald-200/90">
                                shared_preload_libraries
                            </code>{" "}
                            at <span className="font-medium text-amber-50/95">server start</span>, then{" "}
                            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px] text-emerald-200/90">
                                CREATE EXTENSION
                            </code>{" "}
                            in this database. Open the setup guide for Azure, Docker, and local PostgreSQL.
                        </p>
                        <details className="group rounded-lg border border-amber-500/20 bg-black/20">
                            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-100/90 outline-none [&::-webkit-details-marker]:hidden">
                                <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
                                Why this failed (diagnostics)
                            </summary>
                            <div className="border-t border-amber-500/15 px-3 py-2 text-[11px] leading-relaxed text-amber-100/70">
                                {issues.length > 0 ? (
                                    <ul className="list-disc space-y-1 pl-4">
                                        {issues.map((line, i) => (
                                            <li key={`${i}-${line.slice(0, 48)}`} className="[overflow-wrap:anywhere]">
                                                {line}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p>See the numbered steps below or the full setup guide for your hosting provider.</p>
                                )}
                            </div>
                        </details>
                    <ol className="list-decimal space-y-1.5 pl-4 text-xs text-amber-100/85">
                        {!status.preload_enabled && (
                            <li>
                                Add <code className="rounded bg-black/25 px-1 font-mono text-[11px]">pg_stat_statements</code>{" "}
                                to <code className="rounded bg-black/25 px-1 font-mono text-[11px]">shared_preload_libraries</code>{" "}
                                (merge with existing entries, comma-separated), then restart PostgreSQL.
                                {status.suggested_shared_preload_line ? (
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <code className="max-w-full break-all rounded border border-amber-500/20 bg-black/30 px-2 py-1 font-mono text-[11px] text-emerald-200/90">
                                            {status.suggested_shared_preload_line}
                                        </code>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-7 gap-1.5 border-amber-500/30 text-amber-100 hover:bg-amber-500/10"
                                            onClick={copySuggestedLine}
                                        >
                                            <Copy className="h-3.5 w-3.5" />
                                            Copy line
                                        </Button>
                                    </div>
                                ) : null}
                            </li>
                        )}
                        {status.preload_enabled && (
                            <li>PostgreSQL reported preload for pg_stat_statements; if problems persist, restart the server.</li>
                        )}
                        <li>
                            In this database run{" "}
                            <code className="rounded bg-black/25 px-1 font-mono text-[11px]">
                                CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
                            </code>{" "}
                            (or use the button below).
                        </li>
                    </ol>
                    <div className="flex flex-col gap-1 text-[11px] text-amber-100/60">
                        {status.shared_preload_libraries != null && (
                            <p>
                                <span className="text-amber-100/50">Current shared_preload_libraries:</span>{" "}
                                <span className="font-mono text-amber-100/80">
                                    {status.shared_preload_libraries.trim() || "(empty)"}
                                </span>
                            </p>
                        )}
                        {status.config_file ? (
                            <p>
                                <span className="text-amber-100/50">Config file (from server):</span>{" "}
                                <span className="break-all font-mono text-amber-100/80">{status.config_file}</span>
                            </p>
                        ) : null}
                    </div>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:items-end sm:pt-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-full gap-1.5 border-cyan-500/35 bg-cyan-950/30 text-cyan-100 hover:bg-cyan-950/50 sm:w-auto"
                        onClick={() => setGuideOpen(true)}
                    >
                        <BookOpen className="h-3.5 w-3.5" />
                        Setup guide
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-full gap-1.5 border-amber-500/40 text-amber-100 hover:bg-amber-500/15 sm:w-auto"
                        onClick={onSetup}
                        disabled={isSettingUp}
                    >
                        {isSettingUp ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run CREATE EXTENSION
                    </Button>
                </div>
            </div>
        </div>
        </>
    );
}
