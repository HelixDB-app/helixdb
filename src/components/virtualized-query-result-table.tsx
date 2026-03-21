"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useMemo, useRef } from "react";
import type { QueryResult } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import type { CellValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ROW_HEIGHT = 36;
const ROW_INDEX_WIDTH = 52;
const COL_MIN_WIDTH = 150;
const STICKY_COLUMNS = 1; // first data column stays visible when scrolling right

const NUMERIC_CELL_TYPES = new Set<CellValue["type"]>([
    "Int16",
    "Int32",
    "Int64",
    "Float32",
    "Float64",
]);

function isNumericCell(cell: CellValue): boolean {
    return NUMERIC_CELL_TYPES.has(cell.type);
}

/** Derive if column is numeric from data_type string (for headers when no rows) */
function isNumericDataType(dataType: string): boolean {
    const t = dataType.toLowerCase();
    return (
        t.includes("int") ||
        t.includes("serial") ||
        t.includes("float") ||
        t.includes("double") ||
        t.includes("real") ||
        t.includes("numeric") ||
        t.includes("decimal")
    );
}

interface VirtualizedQueryResultTableProps {
    result: QueryResult;
    showRowIndex?: boolean;
    maxHeight?: string;
    compact?: boolean;
    className?: string;
}

function ResultCell({
    cell,
    formatted,
    compact,
    isNumeric,
    isSticky,
    stickyLeft,
    minWidth,
}: {
    cell: CellValue;
    formatted: string;
    compact: boolean;
    isNumeric: boolean;
    isSticky?: boolean;
    stickyLeft?: number;
    minWidth?: number;
}) {
    const handleCopy = useCallback(() => {
        if (cell.type === "Null") return;
        try {
            navigator.clipboard.writeText(formatted);
            toast.success("Copied", { duration: 1200 });
        } catch {
            toast.error("Copy failed");
        }
    }, [cell.type, formatted]);

    return (
        <button
            type="button"
            role="gridcell"
            className={cn(
                "min-w-0 px-3 py-1.5 font-mono truncate cursor-pointer hover:bg-accent/30 border-r border-border/40 last:border-r-0",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isNumeric ? "text-right tabular-nums" : "text-left",
                compact ? "text-xs" : "text-xs",
                cell.type === "Null" && "text-muted-foreground/30 italic",
                isSticky && "sticky z-[1] bg-background shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]"
            )}
            style={{
                ...(minWidth != null ? { minWidth } : {}),
                ...(isSticky && stickyLeft != null ? { left: stickyLeft } : {}),
            }}
            title={formatted}
            onClick={handleCopy}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleCopy();
                }
            }}
            aria-label={cell.type === "Null" ? "Null" : `Copy value: ${formatted}`}
        >
            {formatted}
        </button>
    );
}

const MemoizedResultCell = memo(ResultCell);

/**
 * Virtualized result table: only visible rows are rendered for O(1) DOM size
 * and smooth scrolling with large result sets.
 */
function VirtualizedQueryResultTableInner({
    result,
    showRowIndex = false,
    maxHeight,
    compact = false,
    className,
}: VirtualizedQueryResultTableProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const rows = result?.rows ?? [];
    const columns = result?.columns ?? [];
    const count = rows.length;

    const virtualizer = useVirtualizer({
        count,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
        getItemKey: (index) => index,
    });

    const totalSize = virtualizer.getTotalSize();
    const virtualRows = virtualizer.getVirtualItems();

    const { gridTemplateColumns, totalWidth, columnWidths } = useMemo(() => {
        const widths = columns.map(() => COL_MIN_WIDTH);
        const parts: string[] = [];
        if (showRowIndex) parts.push(`${ROW_INDEX_WIDTH}px`);
        parts.push(...widths.map((w) => `${w}px`));
        const total =
            (showRowIndex ? ROW_INDEX_WIDTH : 0) + widths.reduce((a, b) => a + b, 0);
        return {
            gridTemplateColumns: parts.join(" "),
            totalWidth: total,
            columnWidths: widths,
        };
    }, [showRowIndex, columns.length]);

    const stickyLefts = useMemo(() => {
        const lefts: number[] = [];
        let acc = 0;
        if (showRowIndex) {
            lefts.push(acc);
            acc += ROW_INDEX_WIDTH;
        }
        for (let i = 0; i < Math.min(STICKY_COLUMNS, columns.length); i++) {
            lefts.push(acc);
            acc += columnWidths[i] ?? COL_MIN_WIDTH;
        }
        return lefts;
    }, [showRowIndex, columns.length, columnWidths]);

    if (!result || columns.length === 0) return null;

    return (
        <div
            role="grid"
            aria-label="Query result"
            aria-rowcount={count}
            aria-colcount={columns.length + (showRowIndex ? 1 : 0)}
            className={cn("flex flex-col rounded-lg border border-border bg-background overflow-hidden", className)}
            style={maxHeight ? { maxHeight } : { minHeight: 0, height: "100%" }}
        >
            <div
                ref={scrollRef}
                className="flex-1 min-h-0 overflow-auto overflow-x-auto"
                style={{ contain: "layout paint" }}
            >
                <div
                    style={{
                        width: totalWidth,
                        minWidth: "100%",
                    }}
                >
                    {/* Header row: sticky top, solid bg, aligned with body cells */}
                    <div
                        role="row"
                        className="sticky top-0 z-10 grid border-b border-border text-xs font-semibold bg-muted"
                        style={{ gridTemplateColumns }}
                    >
                        {showRowIndex && (
                            <div
                                role="columnheader"
                                className="sticky left-0 z-20 px-3 py-1.5 text-center text-[10px] font-mono text-muted-foreground/60 border-r border-border/40 bg-muted shrink-0 flex items-center justify-center"
                                style={{ minWidth: ROW_INDEX_WIDTH }}
                            >
                                #
                            </div>
                        )}
                        {columns.map((col, colIdx) => {
                            const firstCell = rows[0]?.[colIdx];
                            const colIsNumeric =
                                firstCell != null
                                    ? isNumericCell(firstCell)
                                    : isNumericDataType(col.data_type);
                            const isSticky = colIdx < STICKY_COLUMNS;
                            const left = stickyLefts[showRowIndex ? colIdx + 1 : colIdx];
                            return (
                                <div
                                    key={col.name}
                                    role="columnheader"
                                    className={cn(
                                        "px-3 py-1.5 whitespace-nowrap border-r border-border/40 last:border-r-0 shrink-0 flex items-center min-h-[36px]",
                                        colIsNumeric ? "text-right tabular-nums justify-end" : "text-left",
                                        isSticky &&
                                            "sticky z-[11] bg-muted shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]"
                                    )}
                                    style={{
                                        minWidth: columnWidths[colIdx],
                                        ...(isSticky && left != null ? { left } : {}),
                                    }}
                                    title={`${col.name} (${col.data_type})`}
                                >
                                    <span className="truncate">{col.name}</span>
                                    <span className="text-[10px] font-mono text-muted-foreground/50 ml-1.5 shrink-0">
                                        ({col.data_type})
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            height: `${totalSize}px`,
                            width: totalWidth,
                            position: "relative",
                        }}
                    >
                        {virtualRows.map((virtualRow) => {
                            const row = rows[virtualRow.index];
                            if (!row) return null;
                            return (
                                <div
                                    key={virtualRow.key}
                                    role="row"
                                    aria-rowindex={virtualRow.index + 1}
                                    className="grid absolute left-0 border-b border-border/40 hover:bg-accent/30 transition-colors"
                                    style={{
                                        width: totalWidth,
                                        height: `${virtualRow.size}px`,
                                        transform: `translateY(${virtualRow.start}px)`,
                                        gridTemplateColumns,
                                    }}
                                >
                                    {showRowIndex && (
                                        <div
                                            className="sticky left-0 z-[1] px-3 py-1.5 text-center text-[10px] font-mono text-muted-foreground/50 border-r border-border/40 flex items-center justify-center bg-background shrink-0"
                                            style={{
                                                minWidth: ROW_INDEX_WIDTH,
                                                boxShadow: "2px 0 4px -2px rgba(0,0,0,0.08)",
                                            }}
                                        >
                                            {virtualRow.index + 1}
                                        </div>
                                    )}
                                    {row.map((cell, colIdx) => (
                                        <MemoizedResultCell
                                            key={colIdx}
                                            cell={cell}
                                            formatted={formatCellValue(cell)}
                                            compact={compact}
                                            isNumeric={isNumericCell(cell)}
                                            isSticky={colIdx < STICKY_COLUMNS}
                                            stickyLeft={colIdx < STICKY_COLUMNS ? stickyLefts[showRowIndex ? colIdx + 1 : colIdx] : undefined}
                                            minWidth={columnWidths[colIdx]}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

export const VirtualizedQueryResultTable = memo(VirtualizedQueryResultTableInner);
