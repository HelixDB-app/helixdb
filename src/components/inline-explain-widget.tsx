"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { SqlExplanation, TableFlowStep } from "@/lib/sql-explain-ai";
import {
    X,
    Sparkles,
    Loader2,
    AlertTriangle,
    Copy,
    Check,
    ChevronRight,
    Table2,
    Filter,
    GitMerge,
    BarChart3,
    ArrowDownNarrowWide,
    Slice,
    ArrowRight,
    Zap,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InlineExplainWidgetProps {
    explanation: SqlExplanation | null;
    isLoading: boolean;
    error: string | null;
    anchorRect: DOMRect | null;
    onDismiss: () => void;
}

// ── Flow step config ──────────────────────────────────────────────────────────

const FLOW_ICON: Record<TableFlowStep["type"], React.ElementType> = {
    table: Table2,
    filter: Filter,
    join: GitMerge,
    aggregate: BarChart3,
    sort: ArrowDownNarrowWide,
    limit: Slice,
    output: ArrowRight,
};

const FLOW_COLOR: Record<TableFlowStep["type"], string> = {
    table: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    filter: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    join: "bg-violet-500/15 text-violet-400 border-violet-500/25",
    aggregate: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    sort: "bg-rose-500/15 text-rose-400 border-rose-500/25",
    limit: "bg-orange-500/15 text-orange-400 border-orange-500/25",
    output: "bg-teal-500/15 text-teal-400 border-teal-500/25",
};

const COMPLEXITY_COLOR: Record<SqlExplanation["complexity"], string> = {
    simple: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    moderate: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    complex: "text-orange-400 bg-orange-500/10 border-orange-500/20",
    expert: "text-rose-400 bg-rose-500/10 border-rose-500/20",
};

// ── Main Widget ───────────────────────────────────────────────────────────────

export function InlineExplainWidget({
    explanation,
    isLoading,
    error,
    anchorRect,
    onDismiss,
}: InlineExplainWidgetProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [copied, setCopied] = useState(false);
    const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0, pointerEvents: "none" });

    // ── Positioning ───────────────────────────────────────────────────────
    const reposition = useCallback(() => {
        if (!anchorRect || !panelRef.current) return;
        const W = 340;
        const GAP = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = anchorRect.left;
        if (left + W + GAP > vw) left = Math.max(GAP, vw - W - GAP);

        let top = anchorRect.bottom + GAP;
        const h = panelRef.current.getBoundingClientRect().height || 200;
        if (top + h > vh - GAP) top = Math.max(GAP, anchorRect.top - h - GAP);

        setStyle({ position: "fixed", top, left, width: W, zIndex: 9999, opacity: 1, pointerEvents: "auto" });
    }, [anchorRect]);

    useEffect(() => { reposition(); }, [reposition, explanation, isLoading, error]);

    // ── Keyboard & click-outside dismiss ─────────────────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onDismiss]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) onDismiss();
        };
        const id = setTimeout(() => document.addEventListener("mousedown", handler), 150);
        return () => { clearTimeout(id); document.removeEventListener("mousedown", handler); };
    }, [onDismiss]);

    // ── Copy ──────────────────────────────────────────────────────────────
    const handleCopy = useCallback(() => {
        if (!explanation) return;
        const text = [
            explanation.summary,
            explanation.performanceNotes.length > 0
                ? "\nTips:\n" + explanation.performanceNotes.map(n => `• ${n}`).join("\n")
                : "",
        ].filter(Boolean).join("\n");
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        });
    }, [explanation]);

    if (!anchorRect || (!isLoading && !error && !explanation)) return null;

    return createPortal(
        <div
            ref={panelRef}
            style={style}
            onMouseDown={e => e.stopPropagation()}
            className={cn(
                "rounded-lg border border-border/30 shadow-xl overflow-hidden",
                "bg-popover/95 backdrop-blur-xl text-popover-foreground",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
            )}
        >
            {/* Top accent line */}
            <div className="h-px w-full bg-gradient-to-r from-transparent via-purple-500/50 to-transparent" />

            {/* Header row */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
                <div className="flex items-center gap-1.5 min-w-0">
                    <Sparkles className="h-3 w-3 shrink-0 text-purple-400" />
                    <span className="text-[11px] font-semibold text-foreground/80 truncate">
                        Query Explanation
                    </span>
                    {explanation && (
                        <span className={cn(
                            "ml-1 rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wide shrink-0",
                            COMPLEXITY_COLOR[explanation.complexity]
                        )}>
                            {explanation.complexity}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                    {explanation && (
                        <button
                            onClick={handleCopy}
                            aria-label="Copy"
                            className={cn(
                                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium border transition-colors duration-150",
                                copied
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                    : "border-border/30 bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
                            )}
                        >
                            {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                            {copied ? "Copied" : "Copy"}
                        </button>
                    )}
                    <button
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="flex items-center justify-center h-5 w-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="px-3 py-2.5 space-y-2.5">
                {/* Loading */}
                {isLoading && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin text-purple-400 shrink-0" />
                            Analyzing query…
                        </div>
                        <div className="space-y-1.5">
                            {[85, 70, 78].map((w, i) => (
                                <div key={i} className="h-2.5 rounded bg-muted/40 animate-pulse"
                                    style={{ width: `${w}%`, animationDelay: `${i * 100}ms` }} />
                            ))}
                        </div>
                        <div className="flex gap-1.5 pt-0.5">
                            {[64, 90, 56].map((w, i) => (
                                <div key={i} className="h-5 rounded-full bg-muted/30 animate-pulse"
                                    style={{ width: w, animationDelay: `${i * 120}ms` }} />
                            ))}
                        </div>
                    </div>
                )}

                {/* Error */}
                {!isLoading && error && (
                    <div className="flex items-start gap-2 text-[11px]">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400 mt-px" />
                        <div>
                            <p className="font-medium text-rose-400 mb-0.5">Couldn&apos;t explain query</p>
                            <p className="text-muted-foreground leading-relaxed">{error}</p>
                        </div>
                    </div>
                )}

                {/* Content */}
                {!isLoading && !error && explanation && (
                    <>
                        {/* Summary */}
                        <p className="text-[11px] leading-relaxed text-foreground/80">
                            {explanation.summary}
                        </p>

                        {/* Data flow chips */}
                        {explanation.tableFlow.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                                {explanation.tableFlow.map((step, i) => {
                                    const Icon = FLOW_ICON[step.type] ?? Table2;
                                    return (
                                        <div key={i} className="flex items-center gap-0.5">
                                            <span
                                                title={step.detail}
                                                className={cn(
                                                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-px",
                                                    "text-[9px] font-medium whitespace-nowrap cursor-default",
                                                    FLOW_COLOR[step.type] ?? FLOW_COLOR.table
                                                )}
                                            >
                                                <Icon className="h-2 w-2 shrink-0" />
                                                {step.label}
                                            </span>
                                            {i < explanation.tableFlow.length - 1 && (
                                                <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Performance tips — compact bullet list */}
                        {explanation.performanceNotes.length > 0 && (
                            <div className="rounded-md bg-muted/20 border border-border/20 px-2.5 py-2 space-y-1">
                                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1">
                                    <Zap className="h-2.5 w-2.5 text-amber-400/80" />
                                    Performance
                                </p>
                                {explanation.performanceNotes.slice(0, 2).map((note, i) => (
                                    <p key={i} className="text-[10px] text-muted-foreground leading-snug flex items-start gap-1.5">
                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-amber-400/50" />
                                        {note}
                                    </p>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/15 bg-muted/5">
                <span className="text-[9px] text-muted-foreground/40 flex items-center gap-1">
                    <Sparkles className="h-2 w-2 text-purple-400/40" />
                    Gemini · esc to close
                </span>
                <kbd className="text-[9px] font-mono text-muted-foreground/40 bg-muted/30 border border-border/20 rounded px-1 py-px">
                    ⌘⇧E
                </kbd>
            </div>
        </div>,
        document.body
    );
}
