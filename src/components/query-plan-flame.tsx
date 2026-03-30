"use client";

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scaleSequential } from "d3-scale";
import { interpolateRgbBasis } from "d3-interpolate";
import type { PlanNode } from "@/lib/query-plan-types";
import {
    computeFlameLayout,
    type FlameRect,
    type PlanHierarchyNode,
} from "@/lib/query-plan-hierarchy";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ROW_H = 24;

function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(1)}ms`;
    return `${(ms * 1000).toFixed(0)}µs`;
}

function fmtCost(n: number): string {
    return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(2);
}

const rowSkewColor = scaleSequential(
    interpolateRgbBasis(["#0d9488", "#84cc16", "#eab308", "#ea580c", "#dc2626"])
).domain([1, 24]);

function rectFill(r: FlameRect): string {
    if (r.rowSkew == null) return "rgba(63, 63, 70, 0.85)";
    return rowSkewColor(Math.min(24, Math.max(1, r.rowSkew)));
}

export interface QueryPlanFlameProps {
    hierarchy: PlanHierarchyNode;
    totalMs: number;
    insightsByPath?: Record<string, string>;
    onSelectNode: (node: PlanNode) => void;
}

function FlameRectCell({
    r,
    insight,
    onSelectNode,
}: {
    r: FlameRect;
    insight?: string;
    onSelectNode: (node: PlanNode) => void;
}) {
    const p = r.plan;
    const label =
        p["Relation Name"] || p["Alias"]
            ? `${p["Node Type"]} · ${p["Relation Name"] ?? p["Alias"]}`
            : p["Node Type"];
    const shortLabel =
        r.w < 56
            ? (p["Node Type"]?.slice(0, 3) ?? "?")
            : label.length > 28
              ? `${label.slice(0, 26)}…`
              : label;

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title={label}
                    className={cn(
                        "absolute m-0 box-border overflow-hidden rounded-sm border border-border/50 px-1 text-left font-mono text-[10px] leading-[22px] text-foreground/90 shadow-sm outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                    style={{
                        left: r.x,
                        top: r.y,
                        width: Math.max(r.w - 1, 1),
                        height: r.h - 1,
                        backgroundColor: rectFill(r),
                    }}
                >
                    <span className="pointer-events-none block truncate">{shortLabel}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="start" side="right">
                <div className="space-y-2">
                    <div>
                        <p className="text-xs font-semibold text-foreground">{p["Node Type"]}</p>
                        {(p["Relation Name"] || p["Alias"]) && (
                            <p className="font-mono text-[11px] text-muted-foreground">
                                {p["Relation Name"] ?? p["Alias"]}
                            </p>
                        )}
                    </div>
                    <div className="space-y-1 font-mono text-[10px] text-muted-foreground">
                        <p>
                            {r.useCostFallback ? (
                                <>
                                    Planner cost share ~{r.pctOfTotal.toFixed(1)}% (cost-based layout)
                                </>
                            ) : (
                                <>
                                    ~{r.pctOfTotal.toFixed(1)}% of query time ({fmtMs(p["Actual Total Time"] ?? 0)}{" "}
                                    × {p["Actual Loops"] ?? 1} loop(s))
                                </>
                            )}
                        </p>
                        <p>
                            cost {fmtCost(p["Startup Cost"])}..{fmtCost(p["Total Cost"])}
                        </p>
                        {p["Actual Rows"] !== undefined ? (
                            <p>
                                rows {p["Actual Rows"]?.toLocaleString()} (est{" "}
                                {p["Plan Rows"]?.toLocaleString()})
                                {r.rowSkew != null && r.rowSkew >= 1.5 && (
                                    <span className="text-orange-400"> — {r.rowSkew.toFixed(1)}× skew</span>
                                )}
                            </p>
                        ) : (
                            <p>est rows {p["Plan Rows"]?.toLocaleString()}</p>
                        )}
                        {p["Filter"] && (
                            <p className="break-all text-[9px] opacity-80">filter {p["Filter"]}</p>
                        )}
                    </div>
                    {insight && (
                        <p className="border-t border-border/30 pt-2 text-xs leading-snug text-foreground/85">
                            <span className="font-medium text-violet-400/90">Gemini: </span>
                            {insight}
                        </p>
                    )}
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 w-full text-xs"
                        onClick={() => onSelectNode(p)}
                    >
                        Open full details
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

export function QueryPlanFlameLegend({ useCostFallback }: { useCostFallback: boolean }) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/15 px-3 py-2 text-[10px] text-muted-foreground">
            <span>
                <span className="font-medium text-foreground/80">Width: </span>
                {useCostFallback
                    ? "planner cost share (no ANALYZE timings in this plan)"
                    : "inclusive execution time share"}
            </span>
            <span className="flex items-center gap-2">
                <span className="font-medium text-foreground/80">Fill: </span>
                <span className="h-3 w-16 rounded-sm bg-gradient-to-r from-teal-600 via-yellow-500 to-red-600" />
                <span>row estimate (cool = accurate, warm = stale stats)</span>
            </span>
        </div>
    );
}

export function QueryPlanFlame({
    hierarchy,
    totalMs,
    insightsByPath,
    onSelectNode,
}: QueryPlanFlameProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(400);
    const rafRef = useRef<number | null>(null);
    const lastWRef = useRef(0);

    const measure = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const w = el.getBoundingClientRect().width;
        if (w > 0 && Math.abs(w - lastWRef.current) > 0.5) {
            lastWRef.current = w;
            setWidth(w);
        }
    }, []);

    useLayoutEffect(() => {
        measure();
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                measure();
            });
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [measure]);

    const { rects, totalHeight } = useMemo(
        () => computeFlameLayout(hierarchy, totalMs, width, ROW_H),
        [hierarchy, totalMs, width]
    );

    return (
        <div
            ref={containerRef}
            className="relative w-full min-h-[120px] min-w-0 flex-1 overflow-x-auto overflow-y-auto"
            role="img"
            aria-label="Query execution plan flame graph: block width shows time or cost share; color shows row-estimate quality."
        >
            <div className="relative" style={{ width, height: totalHeight, minHeight: totalHeight }}>
                {rects.map((r) => (
                    <FlameRectCell
                        key={r.pathId}
                        r={r}
                        insight={insightsByPath?.[r.pathId]}
                        onSelectNode={onSelectNode}
                    />
                ))}
            </div>
        </div>
    );
}
