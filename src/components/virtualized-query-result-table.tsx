"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useMemo, useRef } from "react";
import type { QueryResult } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import type { CellValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ROW_HEIGHT = 36;

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
}: {
    cell: CellValue;
    formatted: string;
    compact: boolean;
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
                "w-full text-left px-3 py-1.5 font-mono truncate cursor-pointer hover:bg-accent/30 border-r border-border/20 last:border-r-0",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                compact ? "text-xs max-w-[200px]" : "text-xs max-w-xs",
                cell.type === "Null" && "text-muted-foreground/30 italic"
            )}
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
    });

    const totalSize = virtualizer.getTotalSize();
    const virtualRows = virtualizer.getVirtualItems();

    const gridCols = useMemo(() => {
        if (showRowIndex) return "auto " + columns.map(() => "1fr").join(" ");
        return columns.map(() => "1fr").join(" ");
    }, [showRowIndex, columns.length]);

    if (!result || columns.length === 0) return null;

    return (
        <div
            role="grid"
            aria-label="Query result"
            aria-rowcount={count}
            aria-colcount={columns.length + (showRowIndex ? 1 : 0)}
            className={cn("flex flex-col rounded-lg border border-border/30 bg-background overflow-hidden", className)}
            style={maxHeight ? { maxHeight } : { minHeight: 0, height: "100%" }}
        >
            <div
                role="row"
                className="sticky top-0 z-10 grid bg-muted/60 border-b border-border/30 shrink-0 text-xs font-semibold"
                style={{ gridTemplateColumns: gridCols }}
            >
                {showRowIndex && (
                    <div role="columnheader" className="px-3 py-2 text-center text-[10px] font-mono text-muted-foreground/50 border-r border-border/20">
                        #
                    </div>
                )}
                {columns.map((col) => (
                    <div
                        key={col.name}
                        role="columnheader"
                        className="px-3 py-2 whitespace-nowrap border-r border-border/20 last:border-r-0"
                    >
                        <span>{col.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/40 ml-1.5">
                            {col.data_type}
                        </span>
                    </div>
                ))}
            </div>

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
                <div
                    style={{
                        height: `${totalSize}px`,
                        width: "100%",
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
                                className="grid absolute left-0 w-full border-b border-border/20 hover:bg-accent/30 transition-colors"
                                style={{
                                    height: `${virtualRow.size}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    gridTemplateColumns: gridCols,
                                }}
                            >
                                {showRowIndex && (
                                    <div className="px-3 py-1.5 text-center text-[10px] font-mono text-muted-foreground/40 border-r border-border/20 flex items-center justify-center">
                                        {virtualRow.index + 1}
                                    </div>
                                )}
                                {row.map((cell, colIdx) => (
                                    <MemoizedResultCell
                                        key={colIdx}
                                        cell={cell}
                                        formatted={formatCellValue(cell)}
                                        compact={compact}
                                    />
                                ))}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

export const VirtualizedQueryResultTable = memo(VirtualizedQueryResultTableInner);
