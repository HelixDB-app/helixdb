"use client";

import React, { useState, useMemo, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    ChevronRight,
    ChevronDown,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Copy,
    Activity,
    Database,
    Zap,
    TrendingUp,
    Loader2,
    Table2,
    Hash,
    Timer,
    Layers,
    Eye,
    ArrowRight,
} from "lucide-react";

// ─── PostgreSQL EXPLAIN JSON types ─────────────────────────────────────────

export interface PlanNode {
    "Node Type": string;
    "Startup Cost": number;
    "Total Cost": number;
    "Plan Rows": number;
    "Plan Width": number;
    "Actual Startup Time"?: number;
    "Actual Total Time"?: number;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    "Relation Name"?: string;
    "Schema"?: string;
    "Alias"?: string;
    "Index Name"?: string;
    "Index Cond"?: string;
    "Filter"?: string;
    "Recheck Cond"?: string;
    "Join Type"?: string;
    "Hash Cond"?: string;
    "Merge Cond"?: string;
    "Sort Key"?: string[];
    "Sort Method"?: string;
    "Rows Removed by Filter"?: number;
    "Rows Removed by Recheck"?: number;
    "Shared Hit Blocks"?: number;
    "Shared Read Blocks"?: number;
    "Local Hit Blocks"?: number;
    "Local Read Blocks"?: number;
    "Temp Read Blocks"?: number;
    "Temp Written Blocks"?: number;
    "Parent Relationship"?: string;
    "Parallel Aware"?: boolean;
    "Workers Planned"?: number;
    "Workers Launched"?: number;
    Plans?: PlanNode[];
}

export interface ExplainOutput {
    Plan: PlanNode;
    "Planning Time"?: number;
    "Execution Time"?: number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export function parseExplainJson(raw: string): ExplainOutput | null {
    try {
        const parsed = JSON.parse(raw);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first && typeof first === "object" && "Plan" in first) return first as ExplainOutput;
        return null;
    } catch {
        return null;
    }
}

// ─── Metric helpers ──────────────────────────────────────────────────────────

function nodeTime(n: PlanNode): number {
    return (n["Actual Total Time"] ?? 0) * (n["Actual Loops"] ?? 1);
}

function selfTime(n: PlanNode): number {
    const childSum = (n.Plans ?? []).reduce((s, c) => s + nodeTime(c), 0);
    return Math.max(0, nodeTime(n) - childSum);
}

type NodeColor = "red" | "orange" | "green" | "neutral";

function nodeColor(n: PlanNode, totalMs: number): NodeColor {
    if (!n["Actual Total Time"]) return "neutral";
    const absMs = nodeTime(n);
    const pct = totalMs > 0 ? absMs / totalMs : 0;
    // Red: >1000ms absolute OR >50% of total
    if (absMs >= 1000 || pct >= 0.5) return "red";
    // Orange: >200ms absolute OR >15% of total
    if (absMs >= 200 || pct >= 0.15) return "orange";
    return "green";
}

function rowEstimateError(n: PlanNode): number | null {
    const planned = n["Plan Rows"] ?? 0;
    const actual = n["Actual Rows"] ?? 0;
    if (planned <= 0) return null;
    const ratio = actual === 0 ? planned : Math.max(actual / planned, planned / actual);
    return ratio >= 1.5 ? ratio : null;
}

function fmt(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(1)}ms`;
    return `${(ms * 1000).toFixed(0)}µs`;
}

function fmtCost(n: number): string {
    return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(2);
}

// ─── AI Suggestions ─────────────────────────────────────────────────────────

export interface Suggestion {
    severity: "high" | "medium" | "low";
    type: "index" | "analyze" | "rewrite" | "info";
    table?: string;
    message: string;
    fix?: string;
    fixLabel?: string;
}

export function buildSuggestions(plan: ExplainOutput): Suggestion[] {
    const suggs: Suggestion[] = [];
    const totalMs = plan["Execution Time"] ?? nodeTime(plan.Plan);
    const seenIndex = new Set<string>();
    const seenAnalyze = new Set<string>();

    function walk(n: PlanNode) {
        const type = n["Node Type"] ?? "";
        const relation = n["Relation Name"];
        const actual = n["Actual Rows"] ?? 0;
        const planned = n["Plan Rows"] ?? 1;
        const err = rowEstimateError(n);
        const pct = totalMs > 0 ? nodeTime(n) / totalMs : 0;
        const filter = n["Filter"] ?? n["Index Cond"] ?? n["Recheck Cond"];

        // Seq scan on non-trivial table
        if (type === "Seq Scan" && relation && actual > 500 && pct > 0.05) {
            const key = `${relation}:index`;
            if (!seenIndex.has(key)) {
                seenIndex.add(key);
                suggs.push({
                    severity: pct >= 0.3 ? "high" : "medium",
                    type: "index",
                    table: relation,
                    message: `Sequential scan on "${relation}" read ${actual.toLocaleString()} rows (${(pct * 100).toFixed(1)}% of query time). PostgreSQL is reading the entire table instead of using an index.${filter ? ` Filter condition: ${filter}` : ""}`,
                    fix: `CREATE INDEX CONCURRENTLY ON "${relation}" (<column>);`,
                    fixLabel: "Create Index",
                });
            }
        }

        // Row estimate wildly off
        if (err !== null && err > 5 && relation) {
            const key = `${relation}:analyze`;
            if (!seenAnalyze.has(key)) {
                seenAnalyze.add(key);
                suggs.push({
                    severity: err > 50 ? "high" : "medium",
                    type: "analyze",
                    table: relation,
                    message: `Row estimate for "${relation}" is ${err.toFixed(0)}× off — PostgreSQL expected ${planned.toLocaleString()} rows but got ${actual.toLocaleString()}. Stale statistics are forcing the planner to choose an inefficient strategy.`,
                    fix: `ANALYZE "${relation}";`,
                    fixLabel: "Run ANALYZE",
                });
            }
        }

        // Hash join spilling to disk
        if ((n["Temp Written Blocks"] ?? 0) > 0) {
            suggs.push({
                severity: "high",
                type: "rewrite",
                message: `Hash join spilled ${n["Temp Written Blocks"]} blocks to disk. The hash table doesn't fit in memory.`,
                fix: `SET work_mem = '256MB';`,
                fixLabel: "Copy setting",
            });
        }

        // Nested loop over large set
        if (type === "Nested Loop" && actual > 10_000 && pct > 0.3) {
            suggs.push({
                severity: "medium",
                type: "rewrite",
                message: `Nested Loop join processed ${actual.toLocaleString()} rows (${(pct * 100).toFixed(1)}% of time). For large datasets a Hash Join is typically faster — ensure join columns are indexed.`,
            });
        }

        (n.Plans ?? []).forEach(walk);
    }

    walk(plan.Plan);

    // Dedup
    const seen = new Set<string>();
    return suggs.filter((s) => {
        const key = s.message.slice(0, 70);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Node type icons & styles ────────────────────────────────────────────────

const NODE_ICONS: Record<string, string> = {
    "Seq Scan": "⟹", "Index Scan": "⌖", "Index Only Scan": "⌖",
    "Bitmap Heap Scan": "⊞", "Bitmap Index Scan": "⊟",
    "Hash Join": "⊕", "Merge Join": "⊗", "Nested Loop": "↻",
    Hash: "⋕", Sort: "↕", Aggregate: "∑", Limit: "⊤",
    Append: "⊎", "Gather Merge": "⊼", Gather: "⊼",
    Materialize: "◫", Memoize: "◈", Result: "◉",
    "Function Scan": "ƒ", "Values Scan": "≡", "CTE Scan": "⊡",
};

const COLOR = {
    red:     { card: "border-red-500/50 bg-red-500/8",     badge: "bg-red-500/20 text-red-400 border-red-500/30",        dot: "bg-red-500",       bar: "bg-red-500/70",     ring: "ring-red-500/30" },
    orange:  { card: "border-orange-500/40 bg-orange-500/6", badge: "bg-orange-500/20 text-orange-400 border-orange-500/30", dot: "bg-orange-500",    bar: "bg-orange-500/60",  ring: "ring-orange-500/20" },
    green:   { card: "border-emerald-500/30 bg-emerald-500/5", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", dot: "bg-emerald-500", bar: "bg-emerald-500/40", ring: "" },
    neutral: { card: "border-border/40 bg-card/40",         badge: "bg-muted/40 text-muted-foreground border-border/30",  dot: "bg-muted-foreground/40", bar: "bg-muted/40",   ring: "" },
} as const;

// ─── Node card ───────────────────────────────────────────────────────────────

interface NodeCardProps {
    node: PlanNode;
    totalMs: number;
    depth: number;
    selected: boolean;
    onSelect: (node: PlanNode) => void;
}

function NodeCard({ node, totalMs, depth, selected, onSelect }: NodeCardProps) {
    const [expanded, setExpanded] = useState(true);
    const children = node.Plans ?? [];
    const color = nodeColor(node, totalMs);
    const styles = COLOR[color];
    const err = rowEstimateError(node);
    const incTime = nodeTime(node);
    const pct = totalMs > 0 ? (incTime / totalMs) * 100 : 0;
    const icon = NODE_ICONS[node["Node Type"]] ?? "•";
    const relation = node["Relation Name"] ?? node["Alias"];
    const absMs = node["Actual Total Time"] ?? 0;

    return (
        <div className="flex flex-col">
            <div className="flex items-start gap-0">
                {/* Tree indent guides */}
                {depth > 0 && (
                    <div className="flex shrink-0" style={{ width: depth * 20 }}>
                        {Array.from({ length: depth }).map((_, i) => (
                            <div key={i} className="w-5 shrink-0 border-l border-border/20 ml-2" />
                        ))}
                    </div>
                )}

                {/* Card */}
                <div
                    className={cn(
                        "flex-1 rounded-lg border mb-1.5 overflow-hidden cursor-pointer transition-all",
                        styles.card,
                        selected && `ring-2 ${styles.ring || "ring-border/50"}`,
                        // Red glow for very slow nodes
                        color === "red" && "shadow-sm shadow-red-500/20"
                    )}
                    onClick={() => onSelect(node)}
                >
                    {/* Header */}
                    <div className="flex items-center gap-2 px-3 py-2.5">
                        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", styles.dot)} />

                        <span className="text-base leading-none shrink-0 text-muted-foreground/50 font-mono w-4 text-center">
                            {icon}
                        </span>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold text-foreground/90 leading-none">
                                    {node["Node Type"]}
                                </span>
                                {relation && (
                                    <span className="text-xs font-mono text-muted-foreground/60 truncate max-w-[160px]">
                                        {relation}
                                    </span>
                                )}
                                {node["Index Name"] && (
                                    <span className="text-[10px] font-mono text-blue-400/70">
                                        via {node["Index Name"]}
                                    </span>
                                )}
                                {node["Join Type"] && node["Join Type"] !== "Inner" && (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1 border-border/30 text-muted-foreground/50">
                                        {node["Join Type"]}
                                    </Badge>
                                )}
                                {/* Row estimate error badge */}
                                {err !== null && err >= 5 && (
                                    <span className={cn(
                                        "text-[9px] font-mono px-1 py-0.5 rounded border leading-none",
                                        err >= 50
                                            ? "bg-red-500/15 text-red-400 border-red-500/20"
                                            : "bg-orange-500/15 text-orange-400 border-orange-500/20"
                                    )}>
                                        ⚠ {err.toFixed(0)}× off
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Timing */}
                        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                            {node["Actual Total Time"] !== undefined && (
                                <span className={cn("text-[11px] font-mono px-1.5 py-0.5 rounded border", styles.badge)}>
                                    {fmt(absMs)}
                                </span>
                            )}
                            {pct > 0 && (
                                <span className="text-[10px] font-mono text-muted-foreground/40 w-10 text-right">
                                    {pct.toFixed(1)}%
                                </span>
                            )}
                            {children.length > 0 && (
                                <button
                                    type="button"
                                    className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                    onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                                >
                                    {expanded
                                        ? <ChevronDown className="h-3.5 w-3.5" />
                                        : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Detail sub-row */}
                    <div className="px-3 pb-2 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span className="text-[10px] font-mono text-muted-foreground/40">
                            cost {fmtCost(node["Startup Cost"])}..{fmtCost(node["Total Cost"])}
                        </span>
                        {node["Actual Rows"] !== undefined ? (
                            <span className="text-[10px] font-mono text-muted-foreground/50">
                                {node["Actual Rows"].toLocaleString()} rows
                                <span className="text-muted-foreground/30"> (est {node["Plan Rows"].toLocaleString()})</span>
                            </span>
                        ) : (
                            <span className="text-[10px] font-mono text-muted-foreground/40">
                                est {node["Plan Rows"].toLocaleString()} rows
                            </span>
                        )}
                        {node["Filter"] && (
                            <span className="text-[10px] font-mono text-muted-foreground/35 truncate max-w-[220px]" title={node["Filter"]}>
                                filter {node["Filter"]}
                            </span>
                        )}
                    </div>

                    {/* Time progress bar */}
                    {pct > 0 && (
                        <div className="h-0.5 bg-border/10">
                            <div className={cn("h-full transition-all", styles.bar)} style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                    )}
                </div>
            </div>

            {/* Children */}
            {children.length > 0 && expanded && (
                <div className="flex flex-col">
                    {children.map((child, i) => (
                        <NodeCard
                            key={i}
                            node={child}
                            totalMs={totalMs}
                            depth={depth + 1}
                            selected={selected && false}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Node details panel ──────────────────────────────────────────────────────

function DetailRow({ label, value, mono = true, highlight }: {
    label: string; value: React.ReactNode; mono?: boolean; highlight?: "red" | "orange" | "green";
}) {
    return (
        <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/10 last:border-0">
            <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wide shrink-0 mt-0.5 w-28">
                {label}
            </span>
            <span className={cn(
                "text-xs text-right flex-1",
                mono && "font-mono",
                highlight === "red" && "text-red-400",
                highlight === "orange" && "text-orange-400",
                highlight === "green" && "text-emerald-400",
                !highlight && "text-foreground/80"
            )}>
                {value}
            </span>
        </div>
    );
}

function NodeDetailsPanel({ node, totalMs }: { node: PlanNode; totalMs: number }) {
    const err = rowEstimateError(node);
    const incTime = nodeTime(node);
    const self = selfTime(node);
    const pct = totalMs > 0 ? (incTime / totalMs) * 100 : 0;
    const color = nodeColor(node, totalMs);

    const errHighlight = err === null ? undefined : err >= 50 ? "red" as const : err >= 5 ? "orange" as const : undefined;

    return (
        <div className="flex flex-col h-full">
            {/* Title */}
            <div className={cn(
                "px-4 py-3 border-b border-border/20 shrink-0",
                color === "red" ? "bg-red-500/8" : color === "orange" ? "bg-orange-500/6" : "bg-card/30"
            )}>
                <div className="flex items-center gap-2 mb-0.5">
                    <div className={cn("w-2 h-2 rounded-full", COLOR[color].dot)} />
                    <span className="text-sm font-bold text-foreground/90">{node["Node Type"]}</span>
                </div>
                {(node["Relation Name"] || node["Alias"]) && (
                    <span className="text-xs font-mono text-muted-foreground/60 ml-4">
                        {node["Relation Name"] ?? node["Alias"]}
                    </span>
                )}
            </div>

            <ScrollArea className="flex-1 min-h-0">
                <div className="px-4 py-3 space-y-0">
                    {/* Timing */}
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5">Timing</p>
                    <DetailRow label="Total time" value={fmt(incTime)} highlight={color === "red" ? "red" : color === "orange" ? "orange" : "green"} />
                    <DetailRow label="Self time" value={fmt(self)} />
                    <DetailRow label="% of query" value={`${pct.toFixed(2)}%`} highlight={pct >= 50 ? "red" : pct >= 15 ? "orange" : "green"} />
                    {node["Actual Startup Time"] !== undefined && (
                        <DetailRow label="Startup" value={fmt(node["Actual Startup Time"])} />
                    )}
                    {node["Actual Loops"] !== undefined && node["Actual Loops"] > 1 && (
                        <DetailRow label="Loops" value={node["Actual Loops"].toLocaleString()} highlight="orange" />
                    )}

                    {/* Rows */}
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Rows</p>
                    {node["Actual Rows"] !== undefined && (
                        <DetailRow label="Actual rows" value={node["Actual Rows"].toLocaleString()} />
                    )}
                    <DetailRow label="Estimated rows" value={node["Plan Rows"].toLocaleString()} />
                    {err !== null && (
                        <DetailRow label="Estimate error" value={`${err.toFixed(0)}× off`} highlight={errHighlight} />
                    )}
                    {node["Rows Removed by Filter"] !== undefined && (
                        <DetailRow label="Filtered out" value={node["Rows Removed by Filter"].toLocaleString()} highlight="orange" />
                    )}

                    {/* Cost */}
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Planner Cost</p>
                    <DetailRow label="Startup cost" value={fmtCost(node["Startup Cost"])} />
                    <DetailRow label="Total cost" value={fmtCost(node["Total Cost"])} />
                    <DetailRow label="Row width" value={`${node["Plan Width"]} bytes`} />

                    {/* Index / Filter */}
                    {(node["Index Name"] || node["Index Cond"] || node["Filter"] || node["Hash Cond"] || node["Merge Cond"]) && (
                        <>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Conditions</p>
                            {node["Index Name"] && <DetailRow label="Index" value={node["Index Name"]} highlight="green" />}
                            {node["Index Cond"] && <DetailRow label="Index cond" value={<span className="break-all">{node["Index Cond"]}</span>} />}
                            {node["Filter"] && <DetailRow label="Filter" value={<span className="break-all">{node["Filter"]}</span>} />}
                            {node["Hash Cond"] && <DetailRow label="Hash cond" value={<span className="break-all">{node["Hash Cond"]}</span>} />}
                            {node["Merge Cond"] && <DetailRow label="Merge cond" value={<span className="break-all">{node["Merge Cond"]}</span>} />}
                        </>
                    )}

                    {/* Buffers */}
                    {((node["Shared Hit Blocks"] ?? 0) > 0 || (node["Shared Read Blocks"] ?? 0) > 0) && (
                        <>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Buffers</p>
                            <DetailRow label="Shared hit" value={(node["Shared Hit Blocks"] ?? 0).toLocaleString()} highlight="green" />
                            <DetailRow label="Shared read" value={(node["Shared Read Blocks"] ?? 0).toLocaleString()} highlight={(node["Shared Read Blocks"] ?? 0) > 100 ? "orange" : undefined} />
                            {(node["Temp Written Blocks"] ?? 0) > 0 && (
                                <DetailRow label="Temp written" value={node["Temp Written Blocks"]!.toLocaleString()} highlight="red" />
                            )}
                        </>
                    )}

                    {/* Sort info */}
                    {node["Sort Key"] && (
                        <>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Sort</p>
                            <DetailRow label="Sort key" value={node["Sort Key"].join(", ")} />
                            {node["Sort Method"] && <DetailRow label="Method" value={node["Sort Method"]} />}
                        </>
                    )}

                    {/* Parallel */}
                    {node["Parallel Aware"] && (
                        <>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1.5 mt-3">Parallel</p>
                            <DetailRow label="Workers planned" value={(node["Workers Planned"] ?? 0).toString()} />
                            {node["Workers Launched"] !== undefined && (
                                <DetailRow label="Workers launched" value={node["Workers Launched"].toString()} />
                            )}
                        </>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}

// ─── Stats bar ───────────────────────────────────────────────────────────────

function StatsBar({ plan }: { plan: ExplainOutput }) {
    const execMs = plan["Execution Time"] ?? nodeTime(plan.Plan);
    const planMs = plan["Planning Time"] ?? 0;

    const counts: Record<string, number> = {};
    function countNodes(n: PlanNode) {
        counts[n["Node Type"]] = (counts[n["Node Type"]] ?? 0) + 1;
        (n.Plans ?? []).forEach(countNodes);
    }
    countNodes(plan.Plan);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const seqScans = counts["Seq Scan"] ?? 0;
    const indexScans = (counts["Index Scan"] ?? 0) + (counts["Index Only Scan"] ?? 0);

    return (
        <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 bg-card/20 text-xs shrink-0 flex-wrap">
            <div className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-emerald-400" />
                <span className="font-mono font-semibold text-foreground/80">{fmt(execMs)}</span>
                <span className="text-muted-foreground/50">total</span>
            </div>
            {planMs > 0 && (
                <div className="flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-blue-400" />
                    <span className="font-mono text-foreground/70">{fmt(planMs)}</span>
                    <span className="text-muted-foreground/50">planning</span>
                </div>
            )}
            <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-muted-foreground/50" />
                <span className="font-mono text-foreground/70">{total}</span>
                <span className="text-muted-foreground/50">nodes</span>
            </div>
            {seqScans > 0 && (
                <div className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-orange-400" />
                    <span className="font-mono text-orange-400">{seqScans}</span>
                    <span className="text-muted-foreground/50">seq scan{seqScans > 1 ? "s" : ""}</span>
                </div>
            )}
            {indexScans > 0 && (
                <div className="flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-emerald-400/70" />
                    <span className="font-mono text-emerald-400/80">{indexScans}</span>
                    <span className="text-muted-foreground/50">index scan{indexScans > 1 ? "s" : ""}</span>
                </div>
            )}
            <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/40">
                <Eye className="h-3 w-3" />
                Click a node for details
            </div>
        </div>
    );
}

// ─── Suggestions panel ───────────────────────────────────────────────────────

interface SuggestionsPanelProps {
    suggestions: Suggestion[];
    onApplyFix?: (sql: string) => Promise<void>;
}

function SuggestionsPanel({ suggestions, onApplyFix }: SuggestionsPanelProps) {
    const [applying, setApplying] = useState<number | null>(null);
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

    const handleApply = useCallback(async (sql: string, idx: number) => {
        if (!onApplyFix) return;
        setApplying(idx);
        try {
            await onApplyFix(sql);
        } finally {
            setApplying(null);
        }
    }, [onApplyFix]);

    const handleCopy = useCallback((text: string, idx: number) => {
        navigator.clipboard.writeText(text);
        setCopiedIdx(idx);
        toast.success("Copied to clipboard", { duration: 1500 });
        setTimeout(() => setCopiedIdx(null), 2000);
    }, []);

    if (suggestions.length === 0) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-500/5 border-t border-emerald-500/20 shrink-0">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <p className="text-xs text-emerald-400/90 font-medium">
                    No obvious performance issues detected. Query plan looks healthy.
                </p>
            </div>
        );
    }

    const SEV = {
        high:   { border: "border-l-red-500/60",    icon: <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" /> },
        medium: { border: "border-l-orange-500/50", icon: <AlertTriangle className="h-4 w-4 text-orange-400 shrink-0 mt-0.5" /> },
        low:    { border: "border-l-blue-500/40",   icon: <Timer className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" /> },
    };

    return (
        <div className="border-t border-border/20 shrink-0 flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border/10 bg-card/20 shrink-0">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground/60" />
                <span className="text-xs font-semibold text-foreground/80">AI Analysis</span>
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                    {suggestions.length} fix{suggestions.length > 1 ? "es" : ""}
                </Badge>
            </div>
            <div className="overflow-y-auto max-h-52">
                {suggestions.map((s, i) => {
                    const sc = SEV[s.severity];
                    return (
                        <div key={i} className={cn("flex gap-3 px-4 py-3 border-b border-border/10 last:border-0 border-l-2", sc.border)}>
                            {sc.icon}
                            <div className="flex-1 min-w-0 space-y-2">
                                <p className="text-xs text-foreground/85 leading-relaxed">{s.message}</p>
                                {s.fix && (
                                    <div className="flex items-center gap-2">
                                        <pre className="text-[11px] font-mono text-muted-foreground/70 bg-muted/30 border border-border/20 rounded px-2 py-1.5 flex-1 min-w-0 overflow-x-auto whitespace-pre">
                                            {s.fix}
                                        </pre>
                                        <div className="flex flex-col gap-1 shrink-0">
                                            {onApplyFix && (
                                                <Button
                                                    size="sm"
                                                    className="h-7 px-2 text-[10px] gap-1 bg-emerald-600 hover:bg-emerald-500 text-white"
                                                    onClick={() => handleApply(s.fix!, i)}
                                                    disabled={applying !== null}
                                                >
                                                    {applying === i ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    ) : (
                                                        <ArrowRight className="h-3 w-3" />
                                                    )}
                                                    {s.fixLabel ?? "Apply"}
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-2 text-[10px] gap-1"
                                                onClick={() => handleCopy(s.fix!, i)}
                                            >
                                                {copiedIdx === i
                                                    ? <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                                                    : <Copy className="h-3 w-3" />}
                                                Copy
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Main viewer ─────────────────────────────────────────────────────────────

export interface QueryPlanViewerProps {
    rawJson: string;
    onApplyFix?: (sql: string) => Promise<void>;
}

export function QueryPlanViewer({ rawJson, onApplyFix }: QueryPlanViewerProps) {
    const plan = useMemo(() => parseExplainJson(rawJson), [rawJson]);
    const suggestions = useMemo(() => (plan ? buildSuggestions(plan) : []), [plan]);
    const [selectedNode, setSelectedNode] = useState<PlanNode | null>(null);

    if (!plan) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                <div className="text-center">
                    <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">Could not parse the query plan output.</p>
                    <p className="text-xs mt-1 opacity-60">Ensure the query is a valid SELECT or DML statement.</p>
                </div>
            </div>
        );
    }

    const totalMs = plan["Execution Time"] ?? nodeTime(plan.Plan);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <StatsBar plan={plan} />

            {/* Main body: tree + details panel */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Tree */}
                <ScrollArea className={cn("flex-1 min-h-0 border-r border-border/20", selectedNode ? "w-[58%]" : "w-full")}>
                    <div className="p-4">
                        <NodeCard
                            node={plan.Plan}
                            totalMs={totalMs}
                            depth={0}
                            selected={selectedNode === plan.Plan}
                            onSelect={setSelectedNode}
                        />
                    </div>
                </ScrollArea>

                {/* Details panel */}
                {selectedNode && (
                    <div className="w-[42%] shrink-0 border-l border-border/20 flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-border/20 bg-card/20 shrink-0">
                            <div className="flex items-center gap-1.5">
                                <Hash className="h-3.5 w-3.5 text-muted-foreground/50" />
                                <span className="text-xs font-medium text-muted-foreground/70">Node Details</span>
                            </div>
                            <button
                                className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                onClick={() => setSelectedNode(null)}
                            >
                                <XCircle className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <NodeDetailsPanel node={selectedNode} totalMs={totalMs} />
                    </div>
                )}
            </div>

            {/* AI Analysis */}
            <SuggestionsPanel suggestions={suggestions} onApplyFix={onApplyFix} />
        </div>
    );
}
