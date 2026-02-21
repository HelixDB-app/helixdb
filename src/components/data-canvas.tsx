"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import type { QueryResult } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    BarChart,
    Bar,
    LineChart,
    Line,
    AreaChart,
    Area,
    ScatterChart,
    Scatter,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as ReTooltip,
    Legend,
    ResponsiveContainer,
} from "recharts";
import {
    Table2,
    BarChart2,
    Grid3X3,
    FileText,
    ArrowUp,
    ArrowDown,
    ArrowUpDown,
    Search,
    X,
    ChevronDown,
    Plus,
    Trash2,
    GripVertical,
    Printer,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

type CanvasMode = "grid" | "pivot" | "chart" | "report";
type AggFn =
    | "SUM"
    | "COUNT"
    | "COUNT_DISTINCT"
    | "AVG"
    | "MIN"
    | "MAX"
    | "MEDIAN"
    | "P90"
    | "P95"
    | "P99"
    | "FIRST"
    | "LAST";
type SortDir = "asc" | "desc" | null;
type ChartType = "bar" | "line" | "area" | "scatter";

interface ValueField {
    field: string;
    fn: AggFn;
}

interface PivotConfig {
    rowFields: string[];
    colFields: string[];
    valueFields: ValueField[];
}

interface ChartConfig {
    type: ChartType;
    xField: string;
    yFields: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractNumeric(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number(v);
    return isNaN(n) ? null : n;
}

function normalizeRows(result: QueryResult): Record<string, unknown>[] {
    return result.rows.map((row) =>
        Object.fromEntries(
            result.columns.map((col, i) => {
                const cell = row[i];
                if (!cell || cell.type === "Null") return [col.name, null];
                if (
                    ["Int16", "Int32", "Int64", "Float32", "Float64"].includes(
                        cell.type
                    )
                )
                    return [col.name, cell.value as number];
                if (cell.type === "Bool") return [col.name, cell.value ? 1 : 0];
                return [col.name, formatCellValue(cell)];
            })
        )
    );
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function aggregate(values: unknown[], fn: AggFn): string {
    const nums = values
        .map(extractNumeric)
        .filter((v): v is number => v !== null);

    switch (fn) {
        case "COUNT":
            return String(values.length);
        case "COUNT_DISTINCT":
            return String(new Set(values.map(String)).size);
        case "SUM":
            return nums.length === 0
                ? "–"
                : fmtNum(nums.reduce((a, b) => a + b, 0));
        case "AVG":
            return nums.length === 0
                ? "–"
                : fmtNum(nums.reduce((a, b) => a + b, 0) / nums.length);
        case "MIN":
            return nums.length === 0 ? "–" : fmtNum(Math.min(...nums));
        case "MAX":
            return nums.length === 0 ? "–" : fmtNum(Math.max(...nums));
        case "MEDIAN": {
            const s = [...nums].sort((a, b) => a - b);
            return s.length === 0 ? "–" : fmtNum(percentile(s, 50));
        }
        case "P90": {
            const s = [...nums].sort((a, b) => a - b);
            return s.length === 0 ? "–" : fmtNum(percentile(s, 90));
        }
        case "P95": {
            const s = [...nums].sort((a, b) => a - b);
            return s.length === 0 ? "–" : fmtNum(percentile(s, 95));
        }
        case "P99": {
            const s = [...nums].sort((a, b) => a - b);
            return s.length === 0 ? "–" : fmtNum(percentile(s, 99));
        }
        case "FIRST":
            return values.length === 0 ? "–" : String(values[0] ?? "–");
        case "LAST":
            return values.length === 0
                ? "–"
                : String(values[values.length - 1] ?? "–");
        default:
            return "–";
    }
}

function fmtNum(n: number): string {
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function computePivot(
    data: Record<string, unknown>[],
    config: PivotConfig
): {
    rowKeys: string[][];
    colKeys: string[][];
    cell: (rk: string, ck: string, field: string, fn: AggFn) => string;
    total: (axis: "row" | "col", key: string, field: string, fn: AggFn) => string;
    grandTotal: (field: string, fn: AggFn) => string;
} {
    const SEP = "\x00";
    const { rowFields, colFields, valueFields } = config;

    const rowKeySet = new Map<string, unknown[]>();
    const colKeySet = new Map<string, unknown[]>();

    for (const row of data) {
        const rk = rowFields.map((f) => String(row[f] ?? "")).join(SEP);
        if (!rowKeySet.has(rk))
            rowKeySet.set(rk, rowFields.map((f) => row[f]));

        if (colFields.length > 0) {
            const ck = colFields.map((f) => String(row[f] ?? "")).join(SEP);
            if (!colKeySet.has(ck))
                colKeySet.set(ck, colFields.map((f) => row[f]));
        }
    }

    const rowKeys = [...rowKeySet.keys()]
        .sort()
        .map((k) => k.split(SEP));
    const colKeys =
        colFields.length > 0
            ? [...colKeySet.keys()].sort().map((k) => k.split(SEP))
            : [["(total)"]];

    // Build groups: `rowKey|colKey|field` -> values[]
    const groups = new Map<string, unknown[]>();

    for (const row of data) {
        const rk = rowFields.map((f) => String(row[f] ?? "")).join(SEP);
        const ck =
            colFields.length > 0
                ? colFields.map((f) => String(row[f] ?? "")).join(SEP)
                : "(total)";
        for (const { field } of valueFields) {
            const gk = `${rk}|||${ck}|||${field}`;
            if (!groups.has(gk)) groups.set(gk, []);
            groups.get(gk)!.push(row[field]);
        }
    }

    const cell = (rk: string, ck: string, field: string, fn: AggFn) => {
        const vals = groups.get(`${rk}|||${ck}|||${field}`) ?? [];
        return aggregate(vals, fn);
    };

    const total = (
        axis: "row" | "col",
        key: string,
        field: string,
        fn: AggFn
    ) => {
        const allVals: unknown[] = [];
        if (axis === "row") {
            // sum across all col keys for this row key
            for (const ck of colKeys) {
                const ckStr = ck.join(SEP);
                const gk = `${key}|||${ckStr}|||${field}`;
                allVals.push(...(groups.get(gk) ?? []));
            }
        } else {
            for (const rk of rowKeys) {
                const rkStr = rk.join(SEP);
                const gk = `${rkStr}|||${key}|||${field}`;
                allVals.push(...(groups.get(gk) ?? []));
            }
        }
        return aggregate(allVals, fn);
    };

    const grandTotal = (field: string, fn: AggFn) => {
        const allVals: unknown[] = [];
        for (const [gk, vals] of groups) {
            if (gk.endsWith(`|||${field}`)) allVals.push(...vals);
        }
        return aggregate(allVals, fn);
    };

    return { rowKeys, colKeys, cell, total, grandTotal };
}

const CHART_COLORS = [
    "#10b981",
    "#06b6d4",
    "#8b5cf6",
    "#f59e0b",
    "#ef4444",
    "#ec4899",
    "#3b82f6",
    "#84cc16",
];

const AGG_OPTIONS: AggFn[] = [
    "SUM",
    "COUNT",
    "COUNT_DISTINCT",
    "AVG",
    "MIN",
    "MAX",
    "MEDIAN",
    "P90",
    "P95",
    "P99",
    "FIRST",
    "LAST",
];

// ── Grid Mode ─────────────────────────────────────────────────────────────

function GridMode({ result }: { result: QueryResult }) {
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>(null);
    const [search, setSearch] = useState("");
    const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());

    const data = useMemo(() => normalizeRows(result), [result]);

    // Compute min/max per numeric column for sparkline bars
    const colStats = useMemo(() => {
        const stats: Record<string, { min: number; max: number }> = {};
        for (const col of result.columns) {
            const nums = data
                .map((r) => extractNumeric(r[col.name]))
                .filter((v): v is number => v !== null);
            if (nums.length > 0) {
                stats[col.name] = {
                    min: Math.min(...nums),
                    max: Math.max(...nums),
                };
            }
        }
        return stats;
    }, [data, result.columns]);

    const filtered = useMemo(() => {
        let rows = data;
        if (search.trim()) {
            const q = search.toLowerCase();
            rows = rows.filter((r) =>
                Object.values(r).some((v) =>
                    String(v ?? "").toLowerCase().includes(q)
                )
            );
        }
        if (sortCol && sortDir) {
            rows = [...rows].sort((a, b) => {
                const av = a[sortCol];
                const bv = b[sortCol];
                const an = extractNumeric(av);
                const bn = extractNumeric(bv);
                const cmp =
                    an !== null && bn !== null
                        ? an - bn
                        : String(av ?? "").localeCompare(String(bv ?? ""));
                return sortDir === "asc" ? cmp : -cmp;
            });
        }
        return rows;
    }, [data, search, sortCol, sortDir]);

    const handleSort = (col: string) => {
        if (sortCol !== col) {
            setSortCol(col);
            setSortDir("asc");
        } else if (sortDir === "asc") {
            setSortDir("desc");
        } else {
            setSortCol(null);
            setSortDir(null);
        }
    };

    const togglePin = (col: string) => {
        setPinnedCols((prev) => {
            const n = new Set(prev);
            if (n.has(col)) n.delete(col);
            else n.add(col);
            return n;
        });
    };

    const orderedCols = useMemo(() => {
        const pinned = result.columns.filter((c) => pinnedCols.has(c.name));
        const rest = result.columns.filter((c) => !pinnedCols.has(c.name));
        return [...pinned, ...rest];
    }, [result.columns, pinnedCols]);

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 shrink-0">
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter rows…"
                        className="w-full h-7 pl-7 pr-2 text-xs bg-muted/30 border border-border/30 rounded-md focus:outline-none focus:border-emerald-500/50 placeholder:text-muted-foreground/40"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2"
                        >
                            <X className="h-3 w-3 text-muted-foreground/50" />
                        </button>
                    )}
                </div>
                <span className="text-[10px] text-muted-foreground/40 font-mono ml-auto">
                    {filtered.length}/{data.length} rows
                    {pinnedCols.size > 0 && (
                        <> · {pinnedCols.size} pinned</>
                    )}
                </span>
            </div>

            <ScrollArea className="flex-1">
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent border-border/30">
                            <TableHead className="w-10 text-center text-[10px] font-mono text-muted-foreground/40 sticky left-0 bg-background">
                                #
                            </TableHead>
                            {orderedCols.map((col) => (
                                <TableHead
                                    key={col.name}
                                    className={cn(
                                        "whitespace-nowrap select-none",
                                        pinnedCols.has(col.name) &&
                                            "bg-emerald-500/5 border-r border-emerald-500/10"
                                    )}
                                >
                                    <div className="flex items-center gap-1">
                                        <button
                                            className="flex items-center gap-1 hover:text-foreground transition-colors"
                                            onClick={() => handleSort(col.name)}
                                        >
                                            <span className="text-xs font-semibold">
                                                {col.name}
                                            </span>
                                            {sortCol === col.name ? (
                                                sortDir === "asc" ? (
                                                    <ArrowUp className="h-3 w-3 text-emerald-400" />
                                                ) : (
                                                    <ArrowDown className="h-3 w-3 text-emerald-400" />
                                                )
                                            ) : (
                                                <ArrowUpDown className="h-3 w-3 text-muted-foreground/20 group-hover:text-muted-foreground/50" />
                                            )}
                                        </button>
                                        <button
                                            onClick={() => togglePin(col.name)}
                                            className={cn(
                                                "ml-0.5 text-[9px] px-1 rounded border transition-colors",
                                                pinnedCols.has(col.name)
                                                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                                                    : "border-border/20 text-muted-foreground/30 hover:border-border/50 hover:text-muted-foreground/60"
                                            )}
                                            title={
                                                pinnedCols.has(col.name)
                                                    ? "Unpin column"
                                                    : "Pin column"
                                            }
                                        >
                                            pin
                                        </button>
                                    </div>
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filtered.map((row, ri) => (
                            <TableRow
                                key={ri}
                                className="border-border/20 hover:bg-accent/30"
                            >
                                <TableCell className="text-center text-[10px] font-mono text-muted-foreground/40 sticky left-0 bg-background">
                                    {ri + 1}
                                </TableCell>
                                {orderedCols.map((col) => {
                                    const v = row[col.name];
                                    const num = extractNumeric(v);
                                    const stats = colStats[col.name];
                                    const pct =
                                        num !== null && stats
                                            ? stats.max === stats.min
                                                ? 100
                                                : ((num - stats.min) /
                                                      (stats.max - stats.min)) *
                                                  100
                                            : null;
                                    return (
                                        <TableCell
                                            key={col.name}
                                            className={cn(
                                                "relative text-xs font-mono max-w-xs truncate",
                                                pinnedCols.has(col.name) &&
                                                    "border-r border-emerald-500/10",
                                                v === null &&
                                                    "text-muted-foreground/30 italic"
                                            )}
                                        >
                                            {pct !== null && (
                                                <span
                                                    className="absolute inset-y-0 left-0 bg-emerald-500/8 rounded-sm pointer-events-none"
                                                    style={{
                                                        width: `${pct}%`,
                                                    }}
                                                />
                                            )}
                                            <span className="relative">
                                                {v === null
                                                    ? "NULL"
                                                    : String(v)}
                                            </span>
                                        </TableCell>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <ScrollBar orientation="horizontal" />
            </ScrollArea>
        </div>
    );
}

// ── Pivot Mode ────────────────────────────────────────────────────────────

function DropZone({
    label,
    fields,
    onDrop,
    onRemove,
    isValue,
    onChangeAgg,
}: {
    label: string;
    fields: (string | ValueField)[];
    onDrop: (field: string) => void;
    onRemove: (idx: number) => void;
    isValue?: boolean;
    onChangeAgg?: (idx: number, fn: AggFn) => void;
}) {
    const [over, setOver] = useState(false);

    return (
        <div
            className={cn(
                "rounded-lg border-2 border-dashed p-2 min-h-[60px] transition-colors",
                over
                    ? "border-emerald-500/60 bg-emerald-500/5"
                    : "border-border/30 bg-muted/10"
            )}
            onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const f = e.dataTransfer.getData("field");
                if (f) onDrop(f);
            }}
        >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">
                {label}
            </p>
            <div className="flex flex-wrap gap-1">
                {fields.map((f, i) => {
                    const fieldName = isValue
                        ? (f as ValueField).field
                        : (f as string);
                    const fn = isValue ? (f as ValueField).fn : null;
                    return (
                        <div
                            key={i}
                            className="flex items-center gap-1 rounded-md bg-muted/50 border border-border/30 px-1.5 py-0.5 text-[11px]"
                        >
                            <GripVertical className="h-3 w-3 text-muted-foreground/30" />
                            <span className="font-mono text-foreground/80">
                                {fieldName}
                            </span>
                            {isValue && fn && onChangeAgg && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button className="flex items-center gap-0.5 text-emerald-400 font-semibold ml-0.5 hover:text-emerald-300 transition-colors">
                                            {fn}
                                            <ChevronDown className="h-2.5 w-2.5" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="start"
                                        className="w-36"
                                    >
                                        {AGG_OPTIONS.map((a) => (
                                            <DropdownMenuItem
                                                key={a}
                                                className="text-xs font-mono"
                                                onClick={() =>
                                                    onChangeAgg(i, a)
                                                }
                                            >
                                                {a}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                            <button
                                onClick={() => onRemove(i)}
                                className="ml-0.5 text-muted-foreground/40 hover:text-destructive transition-colors"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    );
                })}
                {fields.length === 0 && (
                    <span className="text-[10px] text-muted-foreground/30 italic">
                        Drop fields here
                    </span>
                )}
            </div>
        </div>
    );
}

function PivotMode({
    result,
    config,
    onConfigChange,
}: {
    result: QueryResult;
    config: PivotConfig;
    onConfigChange: (c: PivotConfig) => void;
}) {
    const data = useMemo(() => normalizeRows(result), [result]);

    const pivot = useMemo(() => {
        if (config.valueFields.length === 0 || config.rowFields.length === 0)
            return null;
        return computePivot(data, config);
    }, [data, config]);

    const addField = (zone: "row" | "col" | "value", field: string) => {
        if (zone === "row") {
            if (config.rowFields.includes(field)) return;
            onConfigChange({
                ...config,
                rowFields: [...config.rowFields, field],
            });
        } else if (zone === "col") {
            if (config.colFields.includes(field)) return;
            onConfigChange({
                ...config,
                colFields: [...config.colFields, field],
            });
        } else {
            if (config.valueFields.some((v) => v.field === field)) return;
            onConfigChange({
                ...config,
                valueFields: [
                    ...config.valueFields,
                    { field, fn: "SUM" as AggFn },
                ],
            });
        }
    };

    const SEP = "\x00";

    return (
        <div className="flex h-full overflow-hidden">
            {/* Config panel */}
            <div className="w-56 shrink-0 border-r border-border/20 flex flex-col overflow-hidden bg-card/20">
                <div className="px-3 py-2 border-b border-border/20 shrink-0">
                    <p className="text-xs font-semibold text-muted-foreground/70">
                        Fields
                    </p>
                    <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                        Drag to configure
                    </p>
                </div>
                <ScrollArea className="flex-1 px-2 py-2">
                    <div className="space-y-0.5 mb-4">
                        {result.columns.map((col) => (
                            <div
                                key={col.name}
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData("field", col.name);
                                }}
                                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-mono cursor-grab hover:bg-accent/50 active:cursor-grabbing border border-transparent hover:border-border/30 transition-colors"
                            >
                                <GripVertical className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                                <span className="truncate text-foreground/80">
                                    {col.name}
                                </span>
                                <span className="ml-auto text-[9px] text-muted-foreground/40">
                                    {col.data_type}
                                </span>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-2">
                        <DropZone
                            label="Rows"
                            fields={config.rowFields}
                            onDrop={(f) => addField("row", f)}
                            onRemove={(i) =>
                                onConfigChange({
                                    ...config,
                                    rowFields: config.rowFields.filter(
                                        (_, idx) => idx !== i
                                    ),
                                })
                            }
                        />
                        <DropZone
                            label="Columns"
                            fields={config.colFields}
                            onDrop={(f) => addField("col", f)}
                            onRemove={(i) =>
                                onConfigChange({
                                    ...config,
                                    colFields: config.colFields.filter(
                                        (_, idx) => idx !== i
                                    ),
                                })
                            }
                        />
                        <DropZone
                            label="Values"
                            fields={config.valueFields}
                            onDrop={(f) => addField("value", f)}
                            onRemove={(i) =>
                                onConfigChange({
                                    ...config,
                                    valueFields: config.valueFields.filter(
                                        (_, idx) => idx !== i
                                    ),
                                })
                            }
                            isValue
                            onChangeAgg={(i, fn) =>
                                onConfigChange({
                                    ...config,
                                    valueFields: config.valueFields.map(
                                        (v, idx) =>
                                            idx === i ? { ...v, fn } : v
                                    ),
                                })
                            }
                        />
                    </div>
                </ScrollArea>
            </div>

            {/* Pivot table */}
            <div className="flex-1 overflow-hidden">
                {!pivot ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                        <div className="text-center">
                            <Grid3X3 className="h-10 w-10 mx-auto mb-3 opacity-10" />
                            <p className="text-sm font-medium">
                                Configure your pivot
                            </p>
                            <p className="text-xs mt-1 opacity-50">
                                Add at least one Row field and one Value field
                            </p>
                        </div>
                    </div>
                ) : (
                    <ScrollArea className="h-full">
                        <div className="p-3">
                            <table className="border-collapse text-xs min-w-full">
                                <thead>
                                    {/* Multi-value header: one column per value field per col key */}
                                    <tr>
                                        {/* Row dimension headers */}
                                        {config.rowFields.map((rf) => (
                                            <th
                                                key={rf}
                                                className="bg-muted/30 border border-border/30 px-3 py-1.5 text-left font-semibold text-foreground/80 whitespace-nowrap"
                                            >
                                                {rf}
                                            </th>
                                        ))}
                                        {/* Col dimension headers */}
                                        {pivot.colKeys.map((ck) => (
                                            <th
                                                key={ck.join(SEP)}
                                                colSpan={
                                                    config.valueFields.length ||
                                                    1
                                                }
                                                className="bg-muted/40 border border-border/30 px-3 py-1.5 text-center font-semibold text-foreground/80 whitespace-nowrap"
                                            >
                                                {ck.join(" / ")}
                                            </th>
                                        ))}
                                        {config.colFields.length > 0 && (
                                            <th
                                                colSpan={
                                                    config.valueFields.length ||
                                                    1
                                                }
                                                className="bg-emerald-500/10 border border-border/30 px-3 py-1.5 text-center font-semibold text-emerald-400 whitespace-nowrap"
                                            >
                                                Total
                                            </th>
                                        )}
                                    </tr>
                                    {config.valueFields.length > 1 && (
                                        <tr>
                                            {config.rowFields.map((rf) => (
                                                <th
                                                    key={rf}
                                                    className="bg-muted/20 border border-border/30 px-3 py-1"
                                                />
                                            ))}
                                            {pivot.colKeys.map((ck) =>
                                                config.valueFields.map(
                                                    (vf) => (
                                                        <th
                                                            key={`${ck.join(SEP)}_${vf.field}`}
                                                            className="bg-muted/20 border border-border/30 px-3 py-1 text-center font-mono text-[10px] text-muted-foreground/60 whitespace-nowrap"
                                                        >
                                                            {vf.fn}({vf.field})
                                                        </th>
                                                    )
                                                )
                                            )}
                                            {config.colFields.length > 0 &&
                                                config.valueFields.map(
                                                    (vf) => (
                                                        <th
                                                            key={`total_${vf.field}`}
                                                            className="bg-emerald-500/5 border border-border/30 px-3 py-1 text-center font-mono text-[10px] text-muted-foreground/60"
                                                        >
                                                            {vf.fn}(
                                                            {vf.field})
                                                        </th>
                                                    )
                                                )}
                                        </tr>
                                    )}
                                </thead>
                                <tbody>
                                    {pivot.rowKeys.map((rk, ri) => {
                                        const rkStr = rk.join(SEP);
                                        return (
                                            <tr
                                                key={rkStr}
                                                className={cn(
                                                    "hover:bg-accent/20 transition-colors",
                                                    ri % 2 === 0
                                                        ? "bg-background"
                                                        : "bg-muted/10"
                                                )}
                                            >
                                                {rk.map((rv, rfi) => (
                                                    <td
                                                        key={rfi}
                                                        className="border border-border/20 px-3 py-1.5 font-medium text-foreground/80 whitespace-nowrap"
                                                    >
                                                        {String(rv ?? "")}
                                                    </td>
                                                ))}
                                                {pivot.colKeys.map((ck) => {
                                                    const ckStr = ck.join(SEP);
                                                    return config.valueFields.map(
                                                        (vf) => (
                                                            <td
                                                                key={`${ckStr}_${vf.field}`}
                                                                className="border border-border/20 px-3 py-1.5 text-right font-mono text-foreground/70 whitespace-nowrap tabular-nums"
                                                            >
                                                                {pivot.cell(
                                                                    rkStr,
                                                                    ckStr,
                                                                    vf.field,
                                                                    vf.fn
                                                                )}
                                                            </td>
                                                        )
                                                    );
                                                })}
                                                {config.colFields.length > 0 &&
                                                    config.valueFields.map(
                                                        (vf) => (
                                                            <td
                                                                key={`total_${vf.field}`}
                                                                className="border border-border/20 px-3 py-1.5 text-right font-mono text-emerald-400 font-semibold whitespace-nowrap tabular-nums bg-emerald-500/5"
                                                            >
                                                                {pivot.total(
                                                                    "row",
                                                                    rkStr,
                                                                    vf.field,
                                                                    vf.fn
                                                                )}
                                                            </td>
                                                        )
                                                    )}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="bg-emerald-500/5 font-semibold">
                                        <td
                                            colSpan={config.rowFields.length}
                                            className="border border-border/20 px-3 py-1.5 text-emerald-400"
                                        >
                                            TOTAL
                                        </td>
                                        {pivot.colKeys.map((ck) => {
                                            const ckStr = ck.join(SEP);
                                            return config.valueFields.map(
                                                (vf) => (
                                                    <td
                                                        key={`${ckStr}_${vf.field}_total`}
                                                        className="border border-border/20 px-3 py-1.5 text-right font-mono text-emerald-400 tabular-nums"
                                                    >
                                                        {pivot.total(
                                                            "col",
                                                            ckStr,
                                                            vf.field,
                                                            vf.fn
                                                        )}
                                                    </td>
                                                )
                                            );
                                        })}
                                        {config.colFields.length > 0 &&
                                            config.valueFields.map((vf) => (
                                                <td
                                                    key={`grand_${vf.field}`}
                                                    className="border border-border/20 px-3 py-1.5 text-right font-mono text-emerald-400 font-bold tabular-nums"
                                                >
                                                    {pivot.grandTotal(
                                                        vf.field,
                                                        vf.fn
                                                    )}
                                                </td>
                                            ))}
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        <ScrollBar orientation="horizontal" />
                    </ScrollArea>
                )}
            </div>
        </div>
    );
}

// ── Chart Mode ────────────────────────────────────────────────────────────

function ChartMode({
    result,
    config,
    onConfigChange,
}: {
    result: QueryResult;
    config: ChartConfig;
    onConfigChange: (c: ChartConfig) => void;
}) {
    const data = useMemo(() => normalizeRows(result), [result]);

    const numericCols = result.columns.filter((c) => {
        const sample = data.find((r) => r[c.name] !== null)?.[c.name];
        return extractNumeric(sample) !== null;
    });

    // Aggregate: group by xField, sum yFields
    const chartData = useMemo(() => {
        if (!config.xField) return [];
        const groups = new Map<string, Record<string, number>>();
        for (const row of data) {
            const xv = String(row[config.xField] ?? "");
            if (!groups.has(xv)) groups.set(xv, {});
            const g = groups.get(xv)!;
            for (const yf of config.yFields) {
                const n = extractNumeric(row[yf]);
                if (n !== null) g[yf] = (g[yf] ?? 0) + n;
            }
        }
        return [...groups.entries()].map(([x, ys]) => ({ x, ...ys }));
    }, [data, config.xField, config.yFields]);

    const ChartWrapper =
        config.type === "bar"
            ? BarChart
            : config.type === "line"
              ? LineChart
              : config.type === "area"
                ? AreaChart
                : ScatterChart;

    const renderSeries = () => {
        if (config.type === "scatter") {
            return config.yFields.map((yf, i) => (
                <Scatter
                    key={yf}
                    name={yf}
                    dataKey={yf}
                    fill={CHART_COLORS[i % CHART_COLORS.length]}
                />
            ));
        }
        return config.yFields.map((yf, i) => {
            const color = CHART_COLORS[i % CHART_COLORS.length];
            if (config.type === "bar")
                return (
                    <Bar
                        key={yf}
                        dataKey={yf}
                        fill={color}
                        radius={[3, 3, 0, 0]}
                        maxBarSize={48}
                    />
                );
            if (config.type === "area")
                return (
                    <Area
                        key={yf}
                        type="monotone"
                        dataKey={yf}
                        stroke={color}
                        fill={color}
                        fillOpacity={0.15}
                        strokeWidth={2}
                        dot={false}
                    />
                );
            return (
                <Line
                    key={yf}
                    type="monotone"
                    dataKey={yf}
                    stroke={color}
                    strokeWidth={2}
                    dot={false}
                />
            );
        });
    };

    const CHART_TYPES: { id: ChartType; label: string }[] = [
        { id: "bar", label: "Bar" },
        { id: "line", label: "Line" },
        { id: "area", label: "Area" },
        { id: "scatter", label: "Scatter" },
    ];

    return (
        <div className="flex h-full overflow-hidden">
            {/* Config panel */}
            <div className="w-52 shrink-0 border-r border-border/20 flex flex-col overflow-hidden bg-card/20">
                <div className="px-3 py-2 border-b border-border/20 shrink-0">
                    <p className="text-xs font-semibold text-muted-foreground/70">
                        Chart Config
                    </p>
                </div>
                <ScrollArea className="flex-1 px-3 py-3">
                    {/* Chart type */}
                    <div className="mb-4">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 block mb-1.5">
                            Type
                        </label>
                        <div className="grid grid-cols-2 gap-1">
                            {CHART_TYPES.map((t) => (
                                <button
                                    key={t.id}
                                    onClick={() =>
                                        onConfigChange({
                                            ...config,
                                            type: t.id,
                                        })
                                    }
                                    className={cn(
                                        "text-xs py-1.5 rounded-md border transition-colors",
                                        config.type === t.id
                                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-400"
                                            : "border-border/30 text-muted-foreground hover:border-border/60"
                                    )}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* X axis */}
                    <div className="mb-4">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 block mb-1.5">
                            X Axis
                        </label>
                        <select
                            value={config.xField}
                            onChange={(e) =>
                                onConfigChange({
                                    ...config,
                                    xField: e.target.value,
                                })
                            }
                            className="w-full h-7 px-2 text-xs bg-muted/30 border border-border/30 rounded-md focus:outline-none focus:border-emerald-500/50"
                        >
                            <option value="">— select —</option>
                            {result.columns.map((c) => (
                                <option key={c.name} value={c.name}>
                                    {c.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Y axis */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                                Y Axis
                            </label>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 px-1.5 gap-1 text-[10px] text-emerald-400 hover:text-emerald-300"
                                    >
                                        <Plus className="h-2.5 w-2.5" />
                                        Add
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className="w-44"
                                >
                                    {numericCols
                                        .filter(
                                            (c) =>
                                                !config.yFields.includes(
                                                    c.name
                                                )
                                        )
                                        .map((c) => (
                                            <DropdownMenuItem
                                                key={c.name}
                                                className="text-xs font-mono"
                                                onClick={() =>
                                                    onConfigChange({
                                                        ...config,
                                                        yFields: [
                                                            ...config.yFields,
                                                            c.name,
                                                        ],
                                                    })
                                                }
                                            >
                                                {c.name}
                                            </DropdownMenuItem>
                                        ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                        <div className="space-y-1">
                            {config.yFields.map((yf, i) => (
                                <div
                                    key={yf}
                                    className="flex items-center gap-1.5 rounded-md bg-muted/30 border border-border/20 px-2 py-1"
                                >
                                    <span
                                        className="h-2 w-2 rounded-full shrink-0"
                                        style={{
                                            background:
                                                CHART_COLORS[
                                                    i % CHART_COLORS.length
                                                ],
                                        }}
                                    />
                                    <span className="text-xs font-mono flex-1 truncate text-foreground/80">
                                        {yf}
                                    </span>
                                    <button
                                        onClick={() =>
                                            onConfigChange({
                                                ...config,
                                                yFields: config.yFields.filter(
                                                    (_, idx) => idx !== i
                                                ),
                                            })
                                        }
                                        className="text-muted-foreground/30 hover:text-destructive"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            ))}
                            {config.yFields.length === 0 && (
                                <p className="text-[10px] text-muted-foreground/30 italic px-1">
                                    Add numeric columns
                                </p>
                            )}
                        </div>
                    </div>
                </ScrollArea>
            </div>

            {/* Chart */}
            <div className="flex-1 p-4 flex flex-col overflow-hidden">
                {!config.xField || config.yFields.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <div className="text-center">
                            <BarChart2 className="h-10 w-10 mx-auto mb-3 opacity-10" />
                            <p className="text-sm font-medium">
                                Configure the chart
                            </p>
                            <p className="text-xs mt-1 opacity-50">
                                Select an X axis and at least one Y axis
                            </p>
                        </div>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        {config.type === "bar" ? (
                            <BarChart
                                data={chartData}
                                margin={{
                                    top: 8,
                                    right: 16,
                                    bottom: 40,
                                    left: 8,
                                }}
                            >
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="rgba(255,255,255,0.05)"
                                />
                                <XAxis
                                    dataKey="x"
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    angle={-30}
                                    textAnchor="end"
                                    interval="preserveStartEnd"
                                />
                                <YAxis
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    tickFormatter={fmtNum}
                                />
                                <ReTooltip
                                    contentStyle={{
                                        background: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "6px",
                                        fontSize: 11,
                                    }}
                                />
                                {config.yFields.length > 1 && (
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                )}
                                {config.yFields.map((yf, i) => (
                                    <Bar
                                        key={yf}
                                        dataKey={yf}
                                        fill={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                        radius={[3, 3, 0, 0]}
                                        maxBarSize={48}
                                    />
                                ))}
                            </BarChart>
                        ) : config.type === "line" ? (
                            <LineChart
                                data={chartData}
                                margin={{
                                    top: 8,
                                    right: 16,
                                    bottom: 40,
                                    left: 8,
                                }}
                            >
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="rgba(255,255,255,0.05)"
                                />
                                <XAxis
                                    dataKey="x"
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    angle={-30}
                                    textAnchor="end"
                                    interval="preserveStartEnd"
                                />
                                <YAxis
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    tickFormatter={fmtNum}
                                />
                                <ReTooltip
                                    contentStyle={{
                                        background: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "6px",
                                        fontSize: 11,
                                    }}
                                />
                                {config.yFields.length > 1 && (
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                )}
                                {config.yFields.map((yf, i) => (
                                    <Line
                                        key={yf}
                                        type="monotone"
                                        dataKey={yf}
                                        stroke={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                        strokeWidth={2}
                                        dot={false}
                                    />
                                ))}
                            </LineChart>
                        ) : config.type === "area" ? (
                            <AreaChart
                                data={chartData}
                                margin={{
                                    top: 8,
                                    right: 16,
                                    bottom: 40,
                                    left: 8,
                                }}
                            >
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="rgba(255,255,255,0.05)"
                                />
                                <XAxis
                                    dataKey="x"
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    angle={-30}
                                    textAnchor="end"
                                    interval="preserveStartEnd"
                                />
                                <YAxis
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    tickFormatter={fmtNum}
                                />
                                <ReTooltip
                                    contentStyle={{
                                        background: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "6px",
                                        fontSize: 11,
                                    }}
                                />
                                {config.yFields.length > 1 && (
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                )}
                                {config.yFields.map((yf, i) => (
                                    <Area
                                        key={yf}
                                        type="monotone"
                                        dataKey={yf}
                                        stroke={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                        fill={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                        fillOpacity={0.15}
                                        strokeWidth={2}
                                        dot={false}
                                    />
                                ))}
                            </AreaChart>
                        ) : (
                            <ScatterChart
                                margin={{
                                    top: 8,
                                    right: 16,
                                    bottom: 40,
                                    left: 8,
                                }}
                            >
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="rgba(255,255,255,0.05)"
                                />
                                <XAxis
                                    dataKey="x"
                                    name={config.xField}
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                />
                                <YAxis
                                    tick={{
                                        fontSize: 10,
                                        fill: "rgb(148,163,184,0.6)",
                                    }}
                                    tickFormatter={fmtNum}
                                />
                                <ReTooltip
                                    contentStyle={{
                                        background: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "6px",
                                        fontSize: 11,
                                    }}
                                />
                                {config.yFields.map((yf, i) => (
                                    <Scatter
                                        key={yf}
                                        name={yf}
                                        data={chartData}
                                        fill={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                    />
                                ))}
                            </ScatterChart>
                        )}
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}

// ── Report Mode ───────────────────────────────────────────────────────────

function ReportMode({ result }: { result: QueryResult }) {
    const data = useMemo(() => normalizeRows(result), [result]);

    const numericCols = result.columns.filter((c) =>
        data.some((r) => extractNumeric(r[c.name]) !== null)
    );
    const textCols = result.columns.filter(
        (c) => !numericCols.find((n) => n.name === c.name)
    );

    const xField = textCols[0]?.name ?? result.columns[0]?.name ?? "";
    const yField = numericCols[0]?.name ?? "";

    const chartData = useMemo(() => {
        if (!xField || !yField) return [];
        const groups = new Map<string, number>();
        for (const row of data) {
            const xv = String(row[xField] ?? "");
            const n = extractNumeric(row[yField]) ?? 0;
            groups.set(xv, (groups.get(xv) ?? 0) + n);
        }
        return [...groups.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([x, y]) => ({ x, [yField]: y }));
    }, [data, xField, yField]);

    const preview = data.slice(0, 25);

    return (
        <ScrollArea className="h-full">
            <div className="max-w-4xl mx-auto p-8 space-y-8 print:p-4">
                {/* Header */}
                <div className="border-b border-border/30 pb-6">
                    <div className="flex items-center justify-between mb-1">
                        <h1 className="text-xl font-bold text-foreground">
                            Query Report
                        </h1>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 text-xs print:hidden"
                            onClick={() => window.print()}
                        >
                            <Printer className="h-3.5 w-3.5" />
                            Print / Export PDF
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Generated{" "}
                        {new Date().toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                        })}
                    </p>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-4">
                    {[
                        {
                            label: "Rows returned",
                            value: result.row_count.toLocaleString(),
                        },
                        {
                            label: "Columns",
                            value: result.columns.length.toString(),
                        },
                        {
                            label: "Execution time",
                            value: `${result.execution_time_ms.toFixed(1)} ms`,
                        },
                    ].map((s) => (
                        <div
                            key={s.label}
                            className="rounded-lg border border-border/30 bg-muted/10 p-4"
                        >
                            <p className="text-xs text-muted-foreground/60 mb-1">
                                {s.label}
                            </p>
                            <p className="text-xl font-bold font-mono text-foreground">
                                {s.value}
                            </p>
                        </div>
                    ))}
                </div>

                {/* Chart */}
                {xField && yField && chartData.length > 0 && (
                    <div>
                        <h2 className="text-sm font-semibold mb-3 text-foreground/80">
                            {yField} by {xField}
                        </h2>
                        <div className="h-64 rounded-lg border border-border/20 bg-card/20 p-4">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                    data={chartData}
                                    margin={{
                                        top: 4,
                                        right: 8,
                                        bottom: 32,
                                        left: 8,
                                    }}
                                >
                                    <CartesianGrid
                                        strokeDasharray="3 3"
                                        stroke="rgba(255,255,255,0.05)"
                                    />
                                    <XAxis
                                        dataKey="x"
                                        tick={{
                                            fontSize: 10,
                                            fill: "rgb(148,163,184,0.6)",
                                        }}
                                        angle={-30}
                                        textAnchor="end"
                                        interval={0}
                                    />
                                    <YAxis
                                        tick={{
                                            fontSize: 10,
                                            fill: "rgb(148,163,184,0.6)",
                                        }}
                                        tickFormatter={fmtNum}
                                    />
                                    <ReTooltip
                                        contentStyle={{
                                            background: "hsl(var(--card))",
                                            border: "1px solid hsl(var(--border))",
                                            borderRadius: "6px",
                                            fontSize: 11,
                                        }}
                                    />
                                    <Bar
                                        dataKey={yField}
                                        fill={CHART_COLORS[0]}
                                        radius={[3, 3, 0, 0]}
                                    />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                )}

                {/* Data table */}
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-sm font-semibold text-foreground/80">
                            Data Preview
                        </h2>
                        {data.length > 25 && (
                            <span className="text-xs text-muted-foreground/50">
                                Showing 25 of {data.length} rows
                            </span>
                        )}
                    </div>
                    <div className="rounded-lg border border-border/30 overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent border-border/30 bg-muted/20">
                                    {result.columns.map((col) => (
                                        <TableHead
                                            key={col.name}
                                            className="text-xs font-semibold whitespace-nowrap"
                                        >
                                            {col.name}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {preview.map((row, ri) => (
                                    <TableRow
                                        key={ri}
                                        className="border-border/20"
                                    >
                                        {result.columns.map((col) => (
                                            <TableCell
                                                key={col.name}
                                                className={cn(
                                                    "text-xs font-mono max-w-[160px] truncate",
                                                    row[col.name] === null &&
                                                        "text-muted-foreground/30 italic"
                                                )}
                                            >
                                                {row[col.name] === null
                                                    ? "NULL"
                                                    : String(
                                                          row[col.name] ?? ""
                                                      )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </div>

                {/* Query */}
                <div>
                    <h2 className="text-sm font-semibold mb-3 text-foreground/80">
                        SQL Query
                    </h2>
                    <pre className="text-xs font-mono bg-muted/20 border border-border/30 rounded-lg p-4 whitespace-pre-wrap break-all text-foreground/70">
                        {result.query}
                    </pre>
                </div>
            </div>
        </ScrollArea>
    );
}

// ── Main DataCanvas ────────────────────────────────────────────────────────

interface DataCanvasProps {
    result: QueryResult;
}

export function DataCanvas({ result }: DataCanvasProps) {
    const [mode, setMode] = useState<CanvasMode>("grid");

    const [pivotConfig, setPivotConfig] = useState<PivotConfig>({
        rowFields: [],
        colFields: [],
        valueFields: [],
    });

    const defaultXField = result.columns[0]?.name ?? "";
    const defaultYField =
        result.columns.find((c) => {
            const sample = result.rows[0]?.[result.columns.indexOf(c)];
            return (
                sample &&
                ["Int16", "Int32", "Int64", "Float32", "Float64"].includes(
                    sample.type
                )
            );
        })?.name ?? "";

    const [chartConfig, setChartConfig] = useState<ChartConfig>({
        type: "bar",
        xField: defaultXField,
        yFields: defaultYField ? [defaultYField] : [],
    });

    const MODES: { id: CanvasMode; label: string; icon: React.ReactNode }[] = [
        {
            id: "grid",
            label: "Grid",
            icon: <Table2 className="h-3 w-3" />,
        },
        {
            id: "pivot",
            label: "Pivot",
            icon: <Grid3X3 className="h-3 w-3" />,
        },
        {
            id: "chart",
            label: "Chart",
            icon: <BarChart2 className="h-3 w-3" />,
        },
        {
            id: "report",
            label: "Report",
            icon: <FileText className="h-3 w-3" />,
        },
    ];

    return (
        <div className="flex h-full flex-col">
            {/* Mode bar */}
            <div className="flex items-center gap-0 border-b border-border/20 bg-card/10 px-3 shrink-0">
                {MODES.map((m) => (
                    <button
                        key={m.id}
                        onClick={() => setMode(m.id)}
                        className={cn(
                            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors",
                            mode === m.id
                                ? "border-emerald-500 text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {m.icon}
                        {m.label}
                    </button>
                ))}
                <span className="ml-auto text-[10px] font-mono text-muted-foreground/30 pr-2">
                    {result.row_count} rows · {result.columns.length} cols
                </span>
            </div>

            {/* Mode content */}
            <div className="flex-1 overflow-hidden">
                {mode === "grid" && <GridMode result={result} />}
                {mode === "pivot" && (
                    <PivotMode
                        result={result}
                        config={pivotConfig}
                        onConfigChange={setPivotConfig}
                    />
                )}
                {mode === "chart" && (
                    <ChartMode
                        result={result}
                        config={chartConfig}
                        onConfigChange={setChartConfig}
                    />
                )}
                {mode === "report" && <ReportMode result={result} />}
            </div>
        </div>
    );
}
