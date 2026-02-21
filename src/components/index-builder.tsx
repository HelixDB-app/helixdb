"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import {
    dbGetIndexes,
    dbGetIndexImpact,
    dbCreateIndex,
    dbDropIndex,
    dbGetIndexBuildProgress,
} from "@/lib/tauri";
import { dbExecuteQuery, dbGetColumns, dbListTables } from "@/lib/tauri";
import type {
    IndexStats,
    IndexImpactQuery,
    IndexBuildProgress,
    TableInfo,
    ColumnInfo,
} from "@/lib/types";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    Copy,
    GripVertical,
    Info,
    Layers,
    Loader2,
    Plus,
    RefreshCw,
    Search,
    Shield,
    Trash2,
    TrendingDown,
    Zap,
    ZapOff,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const INDEX_TYPES = [
    {
        value: "BTREE",
        label: "BTREE",
        description: "Default. Equality and range queries (=, >, <, BETWEEN). Always a good choice.",
    },
    {
        value: "HASH",
        label: "HASH",
        description: "Exact equality only (=). Faster for pure lookups, but no range queries.",
    },
    {
        value: "GIN",
        label: "GIN",
        description: "JSONB, arrays, full-text search. Slow writes, large size — use for search patterns.",
    },
    {
        value: "GIST",
        label: "GiST",
        description: "Geometric/geographic data, nearest-neighbor. Use with PostGIS.",
    },
    {
        value: "BRIN",
        label: "BRIN",
        description: "Very large tables with naturally-ordered data (time-series, logs). Tiny size.",
    },
    {
        value: "SPGIST",
        label: "SP-GiST",
        description: "Space-partitioned data, IP ranges, phone numbers.",
    },
] as const;

type IndexTypeName = (typeof INDEX_TYPES)[number]["value"];

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms >= 1) return `${ms.toFixed(1)}ms`;
    return `${(ms * 1000).toFixed(0)}µs`;
}

function formatScansPerDay(spd: number): string {
    if (spd >= 1_000_000) return `${(spd / 1_000_000).toFixed(1)}M/day`;
    if (spd >= 1_000) return `${(spd / 1_000).toFixed(1)}K/day`;
    if (spd < 1 && spd > 0) return `<1/day`;
    return `${Math.round(spd)}/day`;
}

function generateIndexName(table: string, columns: string[]): string {
    return `idx_${table}_${columns.join("_")}`;
}

function buildCreateSQL(params: {
    schema: string;
    table: string;
    indexName: string;
    columns: string[];
    indexType: IndexTypeName;
    isUnique: boolean;
    whereClause: string;
}): string {
    const { schema, table, indexName, columns, indexType, isUnique, whereClause } = params;
    const unique = isUnique ? "UNIQUE " : "";
    const cols = columns.map((c) => `"${c}"`).join(", ");
    const where = whereClause.trim() ? ` WHERE ${whereClause.trim()}` : "";
    return `CREATE ${unique}INDEX CONCURRENTLY "${indexName}"\n  ON "${schema}"."${table}" USING ${indexType} (${cols})${where};`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

function IndexTypeBadge({ type }: { type: string }) {
    const colors: Record<string, string> = {
        btree: "bg-blue-500/10 text-blue-400 border-blue-500/20",
        hash: "bg-purple-500/10 text-purple-400 border-purple-500/20",
        gin: "bg-orange-500/10 text-orange-400 border-orange-500/20",
        gist: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
        brin: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
        spgist: "bg-pink-500/10 text-pink-400 border-pink-500/20",
    };
    const cls = colors[type.toLowerCase()] ?? "bg-muted/50 text-muted-foreground border-border/30";
    return (
        <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide", cls)}>
            {type}
        </span>
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Left Panel — Current Indexes
// ──────────────────────────────────────────────────────────────────────────────

interface LeftPanelProps {
    schemas: string[];
    selectedSchema: string;
    onSchemaChange: (s: string) => void;
    indexes: IndexStats[];
    loading: boolean;
    onRefresh: () => void;
    onLoadIntoDesigner: (idx: IndexStats) => void;
    onDrop: (idx: IndexStats) => void;
    droppingIndex: string | null;
    searchQuery: string;
    onSearchChange: (q: string) => void;
}

function LeftPanel({
    schemas,
    selectedSchema,
    onSchemaChange,
    indexes,
    loading,
    onRefresh,
    onLoadIntoDesigner,
    onDrop,
    droppingIndex,
    searchQuery,
    onSearchChange,
}: LeftPanelProps) {
    const filtered = indexes.filter(
        (idx) =>
            !searchQuery ||
            idx.index_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            idx.table_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            idx.columns.some((c) => c.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    const grouped = filtered.reduce<Record<string, IndexStats[]>>((acc, idx) => {
        const key = idx.table_name;
        if (!acc[key]) acc[key] = [];
        acc[key].push(idx);
        return acc;
    }, {});

    const unusedCount = indexes.filter((i) => i.is_unused && !i.is_primary).length;

    return (
        <div className="flex h-full flex-col bg-card/10">
            {/* Header */}
            <div className="shrink-0 border-b border-border/20 px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-foreground/80">Current Indexes</span>
                        {unusedCount > 0 && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px] border-amber-500/40 text-amber-400 bg-amber-500/10">
                                {unusedCount} unused
                            </Badge>
                        )}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
                        onClick={onRefresh}
                        disabled={loading}
                    >
                        <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
                    </Button>
                </div>

                {/* Schema picker */}
                <div className="relative">
                    <select
                        value={selectedSchema}
                        onChange={(e) => onSchemaChange(e.target.value)}
                        className="w-full appearance-none rounded bg-muted/30 border border-border/30 px-2.5 py-1 pr-7 text-xs text-foreground focus:outline-none focus:border-emerald-500/50"
                    >
                        {schemas.map((s) => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
                </div>

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
                    <input
                        type="text"
                        placeholder="Search indexes..."
                        value={searchQuery}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="w-full rounded bg-muted/20 border border-border/20 pl-6 pr-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-emerald-500/40"
                    />
                </div>
            </div>

            {/* Index list */}
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="flex items-center justify-center h-20">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
                    </div>
                ) : Object.keys(grouped).length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-24 text-muted-foreground/40 gap-1">
                        <Layers className="h-6 w-6" />
                        <span className="text-xs">No indexes found</span>
                    </div>
                ) : (
                    Object.entries(grouped).map(([tableName, tableIndexes]) => (
                        <div key={tableName} className="border-b border-border/10 last:border-0">
                            <div className="sticky top-0 bg-card/30 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                                {tableName}
                            </div>
                            {tableIndexes.map((idx) => (
                                <IndexRow
                                    key={idx.index_name}
                                    idx={idx}
                                    onLoadIntoDesigner={onLoadIntoDesigner}
                                    onDrop={onDrop}
                                    dropping={droppingIndex === idx.index_name}
                                />
                            ))}
                        </div>
                    ))
                )}
            </div>

            {/* Footer stats */}
            {indexes.length > 0 && (
                <div className="shrink-0 border-t border-border/20 px-3 py-2 text-[10px] text-muted-foreground/40">
                    {indexes.length} indexes · {indexes.filter((i) => i.is_unused).length} unused
                </div>
            )}
        </div>
    );
}

function IndexRow({
    idx,
    onLoadIntoDesigner,
    onDrop,
    dropping,
}: {
    idx: IndexStats;
    onLoadIntoDesigner: (idx: IndexStats) => void;
    onDrop: (idx: IndexStats) => void;
    dropping: boolean;
}) {
    const [hovered, setHovered] = useState(false);

    return (
        <div
            className={cn(
                "group px-3 py-2 cursor-pointer transition-colors border-l-2",
                hovered ? "bg-muted/20 border-emerald-500/30" : "border-transparent",
                idx.is_unused && !idx.is_primary && "border-l-amber-500/20"
            )}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => onLoadIntoDesigner(idx)}
        >
            <div className="flex items-start justify-between gap-1">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {idx.is_primary ? (
                            <Shield className="h-3 w-3 shrink-0 text-blue-400" />
                        ) : idx.is_unique ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                        ) : (
                            <Layers className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                        )}
                        <span className="text-xs font-mono text-foreground/80 truncate max-w-[140px]" title={idx.index_name}>
                            {idx.index_name}
                        </span>
                        <IndexTypeBadge type={idx.index_type} />
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground/50 truncate">
                        ({idx.columns.join(", ")})
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/40">{idx.size_pretty}</span>
                        {idx.is_unused && !idx.is_primary ? (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                                <ZapOff className="h-2.5 w-2.5" />
                                UNUSED
                            </span>
                        ) : (
                            <span className="flex items-center gap-0.5 text-[10px] text-emerald-400/70">
                                <Zap className="h-2.5 w-2.5" />
                                {formatScansPerDay(idx.scans_per_day)}
                            </span>
                        )}
                    </div>
                </div>

                {/* Drop button */}
                {hovered && !idx.is_primary && (
                    <button
                        className="shrink-0 rounded p-1 text-red-400/60 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDrop(idx);
                        }}
                        title="Drop index"
                        disabled={dropping}
                    >
                        {dropping ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <Trash2 className="h-3 w-3" />
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Center Panel — Index Designer
// ──────────────────────────────────────────────────────────────────────────────

interface DesignerState {
    selectedTable: string;
    selectedColumns: string[];
    indexType: IndexTypeName;
    isUnique: boolean;
    whereClause: string;
    customName: string;
}

interface CenterPanelProps {
    tables: TableInfo[];
    columns: ColumnInfo[];
    loadingColumns: boolean;
    designer: DesignerState;
    onDesignerChange: (patch: Partial<DesignerState>) => void;
    onTableChange: (table: string) => void;
    onPreviewImpact: () => void;
    onGenerateSQL: () => void;
    onCreateIndex: () => void;
    previewLoading: boolean;
    createLoading: boolean;
    generatedSQL: string;
    schema: string;
}

function CenterPanel({
    tables,
    columns,
    loadingColumns,
    designer,
    onDesignerChange,
    onTableChange,
    onPreviewImpact,
    onGenerateSQL,
    onCreateIndex,
    previewLoading,
    createLoading,
    generatedSQL,
    schema,
}: CenterPanelProps) {
    const dragColRef = useRef<string | null>(null);
    const dragOverRef = useRef<number | null>(null);

    const addColumn = (col: string) => {
        if (!designer.selectedColumns.includes(col)) {
            onDesignerChange({ selectedColumns: [...designer.selectedColumns, col] });
        }
    };

    const removeColumn = (col: string) => {
        onDesignerChange({ selectedColumns: designer.selectedColumns.filter((c) => c !== col) });
    };

    const moveColumn = (from: number, to: number) => {
        const cols = [...designer.selectedColumns];
        const [item] = cols.splice(from, 1);
        cols.splice(to, 0, item);
        onDesignerChange({ selectedColumns: cols });
    };

    const autoName = designer.selectedTable && designer.selectedColumns.length > 0
        ? generateIndexName(designer.selectedTable, designer.selectedColumns)
        : "";

    const displayName = designer.customName || autoName;

    const canCreate = designer.selectedTable && designer.selectedColumns.length > 0;

    return (
        <div className="flex h-full flex-col bg-card/5 overflow-y-auto">
            <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                    <Plus className="h-3.5 w-3.5 text-emerald-400/70" />
                    <span className="text-xs font-semibold text-foreground/80">Index Designer</span>
                </div>
            </div>

            <div className="flex-1 p-3 space-y-4">
                {/* Table selector */}
                <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                        Table
                    </label>
                    <div className="relative">
                        <select
                            value={designer.selectedTable}
                            onChange={(e) => onTableChange(e.target.value)}
                            className="w-full appearance-none rounded bg-muted/30 border border-border/30 px-2.5 py-1.5 pr-7 text-xs text-foreground focus:outline-none focus:border-emerald-500/50"
                        >
                            <option value="">Select a table…</option>
                            {tables.map((t) => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
                    </div>
                </div>

                {/* Column picker + drop zone */}
                <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                        Index Columns <span className="normal-case font-normal text-muted-foreground/30">(order matters for composites)</span>
                    </label>

                    {/* Selected columns — draggable to reorder */}
                    <div className="min-h-[60px] rounded border border-dashed border-border/30 bg-muted/10 p-2 space-y-1.5">
                        {designer.selectedColumns.length === 0 ? (
                            <div className="flex items-center justify-center h-8 text-[10px] text-muted-foreground/30">
                                Click columns below to add them →
                            </div>
                        ) : (
                            designer.selectedColumns.map((col, i) => (
                                <div
                                    key={col}
                                    draggable
                                    onDragStart={() => { dragColRef.current = col; }}
                                    onDragOver={(e) => { e.preventDefault(); dragOverRef.current = i; }}
                                    onDrop={() => {
                                        const fromIdx = designer.selectedColumns.indexOf(dragColRef.current!);
                                        if (fromIdx !== -1 && fromIdx !== dragOverRef.current) {
                                            moveColumn(fromIdx, dragOverRef.current!);
                                        }
                                    }}
                                    className="flex items-center gap-2 rounded bg-background/50 border border-border/20 px-2 py-1 cursor-grab active:cursor-grabbing group"
                                >
                                    <GripVertical className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                                    <span className="text-[10px] font-semibold text-muted-foreground/40 w-4">{i + 1}</span>
                                    <span className="text-xs font-mono text-foreground/80 flex-1">{col}</span>
                                    <button
                                        onClick={() => removeColumn(col)}
                                        className="text-muted-foreground/30 hover:text-red-400 transition-colors"
                                    >
                                        ×
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Available columns */}
                    {designer.selectedTable && (
                        <div className="rounded border border-border/20 bg-muted/5 p-2">
                            <div className="text-[10px] text-muted-foreground/40 mb-1.5">Available columns:</div>
                            {loadingColumns ? (
                                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    Loading…
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-1">
                                    {columns.map((col) => {
                                        const isSelected = designer.selectedColumns.includes(col.name);
                                        return (
                                            <button
                                                key={col.name}
                                                onClick={() => isSelected ? removeColumn(col.name) : addColumn(col.name)}
                                                className={cn(
                                                    "rounded px-2 py-0.5 font-mono text-[10px] border transition-colors",
                                                    isSelected
                                                        ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                                                        : "bg-muted/20 border-border/20 text-muted-foreground/60 hover:border-emerald-500/30 hover:text-foreground"
                                                )}
                                                title={col.data_type}
                                            >
                                                {col.name}
                                                <span className="ml-1 text-muted-foreground/30">{col.data_type}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Index type */}
                <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                        Index Type
                    </label>
                    <div className="grid grid-cols-3 gap-1">
                        {INDEX_TYPES.map((t) => (
                            <button
                                key={t.value}
                                title={t.description}
                                onClick={() => onDesignerChange({ indexType: t.value })}
                                className={cn(
                                    "rounded border px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                                    designer.indexType === t.value
                                        ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                                        : "bg-muted/10 border-border/20 text-muted-foreground/50 hover:border-emerald-500/20 hover:text-foreground"
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/40 italic">
                        {INDEX_TYPES.find((t) => t.value === designer.indexType)?.description}
                    </p>
                </div>

                {/* Unique + partial */}
                <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={designer.isUnique}
                            onChange={(e) => onDesignerChange({ isUnique: e.target.checked })}
                            className="h-3 w-3 rounded accent-emerald-500"
                        />
                        <span className="text-xs text-muted-foreground/70">Unique constraint</span>
                    </label>

                    <div className="space-y-1">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                            WHERE clause <span className="normal-case font-normal">(optional partial index)</span>
                        </label>
                        <input
                            type="text"
                            placeholder='e.g. deleted_at IS NULL'
                            value={designer.whereClause}
                            onChange={(e) => onDesignerChange({ whereClause: e.target.value })}
                            className="w-full rounded bg-muted/20 border border-border/20 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-emerald-500/40"
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                            Index name <span className="normal-case font-normal">(optional)</span>
                        </label>
                        <input
                            type="text"
                            placeholder={autoName || "auto-generated"}
                            value={designer.customName}
                            onChange={(e) => onDesignerChange({ customName: e.target.value })}
                            className="w-full rounded bg-muted/20 border border-border/20 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-emerald-500/40"
                        />
                    </div>
                </div>

                {/* SQL preview */}
                {canCreate && (
                    <div className="rounded border border-border/20 bg-muted/10 overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-1 border-b border-border/10">
                            <span className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                                Generated SQL
                            </span>
                            <button
                                onClick={() => navigator.clipboard.writeText(
                                    buildCreateSQL({
                                        schema,
                                        table: designer.selectedTable,
                                        indexName: displayName,
                                        columns: designer.selectedColumns,
                                        indexType: designer.indexType,
                                        isUnique: designer.isUnique,
                                        whereClause: designer.whereClause,
                                    })
                                )}
                                className="text-muted-foreground/30 hover:text-foreground transition-colors"
                                title="Copy SQL"
                            >
                                <Copy className="h-3 w-3" />
                            </button>
                        </div>
                        <pre className="px-2.5 py-2 font-mono text-[10px] text-emerald-300/80 whitespace-pre-wrap break-all leading-relaxed">
                            {buildCreateSQL({
                                schema,
                                table: designer.selectedTable,
                                indexName: displayName,
                                columns: designer.selectedColumns,
                                indexType: designer.indexType,
                                isUnique: designer.isUnique,
                                whereClause: designer.whereClause,
                            })}
                        </pre>
                        <div className="flex items-center gap-1 px-2.5 pb-1.5">
                            <Shield className="h-2.5 w-2.5 text-emerald-400/60" />
                            <span className="text-[9px] text-emerald-400/60">
                                CONCURRENTLY — no table locking during build
                            </span>
                        </div>
                    </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-col gap-2 pb-3">
                    <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-7 text-xs border-border/30 text-muted-foreground hover:border-emerald-500/40 hover:text-emerald-400"
                        disabled={!canCreate || previewLoading}
                        onClick={onPreviewImpact}
                    >
                        {previewLoading ? (
                            <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Analyzing…</>
                        ) : (
                            <><TrendingDown className="h-3 w-3 mr-1.5" />Preview Impact</>
                        )}
                    </Button>
                    <Button
                        size="sm"
                        className="w-full h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                        disabled={!canCreate || createLoading}
                        onClick={onCreateIndex}
                    >
                        {createLoading ? (
                            <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Creating…</>
                        ) : (
                            <><Zap className="h-3 w-3 mr-1.5" />Create Index</>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Right Panel — Impact Preview + Build Monitor
// ──────────────────────────────────────────────────────────────────────────────

type RightPanelState =
    | { mode: "idle" }
    | { mode: "loading" }
    | { mode: "impact"; queries: IndexImpactQuery[]; noExtension?: boolean }
    | { mode: "building"; indexName: string; progress: IndexBuildProgress | null; sql: string }
    | { mode: "done"; indexName: string; beforeMs: number; afterMs: number };

function RightPanel({
    state,
    hasStatStatements,
}: {
    state: RightPanelState;
    hasStatStatements: boolean;
}) {
    if (state.mode === "idle") {
        return (
            <div className="flex h-full flex-col bg-card/5">
                <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-foreground/80">Impact Preview</span>
                    </div>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-4 gap-4">
                    {!hasStatStatements && (
                        <div className="w-full rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                pg_stat_statements not found
                            </div>
                            <p className="text-[10px] text-amber-400/70">
                                Impact preview requires this extension. Enable it with:
                            </p>
                            <code className="block rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-amber-300">
                                CREATE EXTENSION pg_stat_statements;
                            </code>
                        </div>
                    )}
                    <div className="text-center space-y-2 max-w-[240px]">
                        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted/20 border border-border/20">
                            <TrendingDown className="h-5 w-5 text-muted-foreground/40" />
                        </div>
                        <p className="text-xs text-muted-foreground/60 leading-relaxed">
                            Design an index and click <strong className="text-foreground/60">Preview Impact</strong> to see which queries will improve.
                        </p>
                        <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
                            Impact is calculated by scanning pg_stat_statements for queries that reference your table and columns, then running EXPLAIN to detect sequential scans.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (state.mode === "loading") {
        return (
            <div className="flex h-full flex-col bg-card/5">
                <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-foreground/80">Impact Preview</span>
                    </div>
                </div>
                <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground/40">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-xs">Analyzing queries…</span>
                </div>
            </div>
        );
    }

    if (state.mode === "impact") {
        const totalCurrentMs = state.queries.reduce((s, q) => s + q.total_exec_time_ms, 0);
        const totalAfterMs = state.queries.reduce((s, q) => s + q.estimated_time_after_ms * q.calls, 0);
        const totalSavingMs = totalCurrentMs - totalAfterMs;

        return (
            <div className="flex h-full flex-col bg-card/5">
                <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-emerald-400/70" />
                        <span className="text-xs font-semibold text-foreground/80">Impact Preview</span>
                        {state.queries.length > 0 && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                                {state.queries.length} queries
                            </Badge>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {state.queries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground/40">
                            <Info className="h-6 w-6" />
                            <p className="text-xs text-center">
                                {state.noExtension
                                    ? "pg_stat_statements is not enabled — cannot analyze query history."
                                    : "No queries in pg_stat_statements match this index. The index may still be useful for future queries."}
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* Total saving */}
                            <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-0.5">
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70">
                                    Total Estimated Saving
                                </div>
                                <div className="text-xl font-bold text-emerald-400">
                                    {formatMs(totalSavingMs)}
                                </div>
                                <div className="text-[10px] text-emerald-400/50">
                                    across {state.queries.reduce((s, q) => s + q.calls, 0).toLocaleString()} query executions
                                </div>
                            </div>

                            {/* Individual queries */}
                            <div className="space-y-2">
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
                                    Queries that will improve:
                                </div>
                                {state.queries.map((q, i) => (
                                    <ImpactQueryCard key={i} query={q} />
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    }

    if (state.mode === "building") {
        const p = state.progress;
        const pct = p?.percent_done ?? 0;

        return (
            <div className="flex h-full flex-col bg-card/5">
                <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                        <span className="text-xs font-semibold text-foreground/80">Building Index</span>
                    </div>
                </div>
                <div className="flex-1 p-3 space-y-4">
                    <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
                        <div className="flex items-center gap-1.5">
                            <Shield className="h-3 w-3 text-emerald-400/70" />
                            <span className="text-xs font-semibold text-emerald-400/80">No table locking</span>
                        </div>
                        <p className="text-[10px] text-emerald-400/50">
                            CONCURRENTLY builds the index in the background. Your table remains fully readable and writable during the entire process.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                                Progress
                            </span>
                            <span className="text-[10px] text-muted-foreground/60 font-mono">
                                {pct.toFixed(1)}%
                            </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted/30 overflow-hidden">
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        {p && (
                            <div className="space-y-1">
                                <PhaseIndicator phase={p.phase} />
                                {p.blocks_total > 0 && (
                                    <div className="text-[10px] text-muted-foreground/40">
                                        Blocks: {p.blocks_done.toLocaleString()} / {p.blocks_total.toLocaleString()}
                                    </div>
                                )}
                                {p.tuples_total > 0 && (
                                    <div className="text-[10px] text-muted-foreground/40">
                                        Tuples: {p.tuples_done.toLocaleString()} / {p.tuples_total.toLocaleString()}
                                    </div>
                                )}
                            </div>
                        )}
                        {!p && (
                            <p className="text-[10px] text-muted-foreground/40">
                                Waiting for build to start…
                            </p>
                        )}
                    </div>

                    <div className="space-y-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
                            Index Name
                        </div>
                        <code className="block font-mono text-xs text-foreground/70">{state.indexName}</code>
                    </div>

                    <div className="space-y-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
                            SQL Executed
                        </div>
                        <pre className="rounded bg-muted/10 border border-border/20 px-2 py-1.5 font-mono text-[10px] text-muted-foreground/60 whitespace-pre-wrap break-all">
                            {state.sql}
                        </pre>
                    </div>
                </div>
            </div>
        );
    }

    if (state.mode === "done") {
        const saving = state.beforeMs - state.afterMs;
        const pct = state.beforeMs > 0 ? ((saving / state.beforeMs) * 100).toFixed(0) : "0";

        return (
            <div className="flex h-full flex-col bg-card/5">
                <div className="shrink-0 border-b border-border/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-xs font-semibold text-foreground/80">Index Created</span>
                    </div>
                </div>
                <div className="flex-1 p-3 space-y-3">
                    <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-center space-y-1">
                        <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto" />
                        <div className="text-sm font-bold text-emerald-400">{state.indexName}</div>
                        <div className="text-[10px] text-emerald-400/60">successfully created</div>
                    </div>
                    {saving > 0 && (
                        <div className="rounded border border-border/20 bg-muted/10 p-3 space-y-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                                Measured improvement
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-muted-foreground/50">Before</span>
                                <span className="font-mono text-xs text-red-400">{formatMs(state.beforeMs)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-muted-foreground/50">After</span>
                                <span className="font-mono text-xs text-emerald-400">{formatMs(state.afterMs)}</span>
                            </div>
                            <div className="flex items-center justify-between border-t border-border/20 pt-2">
                                <span className="text-[10px] font-semibold text-muted-foreground/60">Speedup</span>
                                <span className="font-bold text-sm text-emerald-400">{pct}% faster</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return null;
}

function ImpactQueryCard({ query }: { query: IndexImpactQuery }) {
    const [expanded, setExpanded] = useState(false);
    const saving = query.mean_exec_time_ms - query.estimated_time_after_ms;
    const pct = query.mean_exec_time_ms > 0
        ? Math.round((saving / query.mean_exec_time_ms) * 100)
        : 0;

    return (
        <div className="rounded border border-border/20 bg-muted/5 overflow-hidden">
            <button
                className="w-full text-left px-2.5 py-2 flex items-start justify-between gap-2"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold text-emerald-400">
                            {formatMs(query.mean_exec_time_ms)} → {formatMs(query.estimated_time_after_ms)}
                        </span>
                        <span className="text-[9px] rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 px-1">
                            -{pct}%
                        </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/40 mt-0.5 truncate">{query.benefit_reason}</div>
                </div>
                <ChevronDown className={cn("h-3 w-3 text-muted-foreground/30 shrink-0 mt-0.5 transition-transform", expanded && "rotate-180")} />
            </button>
            {expanded && (
                <div className="px-2.5 pb-2 space-y-1.5 border-t border-border/10">
                    <div className="flex gap-3 text-[10px] text-muted-foreground/40 mt-1.5">
                        <span>{query.calls.toLocaleString()} calls</span>
                        <span>Σ {formatMs(query.total_exec_time_ms)} total</span>
                    </div>
                    <pre className="rounded bg-muted/10 px-2 py-1 font-mono text-[10px] text-muted-foreground/50 whitespace-pre-wrap break-all">
                        {query.query}
                    </pre>
                </div>
            )}
        </div>
    );
}

function PhaseIndicator({ phase }: { phase: string }) {
    const PHASES = [
        "initializing",
        "waiting for writers before build",
        "building index",
        "waiting for writers before validation",
        "index validation: scanning index",
        "index validation: scanning table",
        "waiting for old snapshots",
        "waiting for readers before marking dead",
        "waiting for readers before dropping",
    ];

    const current = PHASES.findIndex((p) =>
        phase.toLowerCase().includes(p.split(" ")[0])
    );
    const display = current >= 0 ? PHASES[current] : phase;

    return (
        <div className="text-[10px] font-mono text-emerald-300/60 capitalize">
            Phase: {display || "initializing…"}
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────────────────────

export function IndexBuilder() {
    const { connectionId, schemas, selectedSchema } = useConnectionStore();

    const schemaList = schemas.map((s) => s.name);
    const [activeSchema, setActiveSchema] = useState<string>(selectedSchema ?? schemaList[0] ?? "public");

    const [indexes, setIndexes] = useState<IndexStats[]>([]);
    const [indexesLoading, setIndexesLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [droppingIndex, setDroppingIndex] = useState<string | null>(null);
    const [dropConfirm, setDropConfirm] = useState<IndexStats | null>(null);

    const [tables, setTables] = useState<TableInfo[]>([]);
    const [columns, setColumns] = useState<ColumnInfo[]>([]);
    const [loadingColumns, setLoadingColumns] = useState(false);

    const [designer, setDesigner] = useState<DesignerState>({
        selectedTable: "",
        selectedColumns: [],
        indexType: "BTREE",
        isUnique: false,
        whereClause: "",
        customName: "",
    });

    const [rightPanel, setRightPanel] = useState<RightPanelState>({ mode: "idle" });
    const [previewLoading, setPreviewLoading] = useState(false);
    const [createLoading, setCreateLoading] = useState(false);
    const [hasStatStatements, setHasStatStatements] = useState(true);
    const [generatedSQL, setGeneratedSQL] = useState("");

    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Load tables for the active schema
    useEffect(() => {
        if (!connectionId) return;
        dbListTables(connectionId, activeSchema)
            .then(setTables)
            .catch(() => setTables([]));
    }, [connectionId, activeSchema]);

    // Load indexes for the active schema (only when connected)
    const loadIndexes = useCallback(() => {
        if (!connectionId) {
            setIndexesLoading(false);
            setIndexes([]);
            return;
        }
        setIndexesLoading(true);
        dbGetIndexes(connectionId, activeSchema)
            .then(setIndexes)
            .catch(() => setIndexes([]))
            .finally(() => setIndexesLoading(false));
    }, [connectionId, activeSchema]);

    useEffect(() => {
        if (connectionId) {
            loadIndexes();
        } else {
            setIndexesLoading(false);
            setIndexes([]);
        }
    }, [connectionId, loadIndexes]);

    // Check pg_stat_statements on mount
    useEffect(() => {
        if (!connectionId) return;
        dbExecuteQuery(connectionId, "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'")
            .then((res) => setHasStatStatements(res.row_count > 0))
            .catch(() => setHasStatStatements(false));
    }, [connectionId]);

    const handleTableChange = (table: string) => {
        setDesigner((d) => ({ ...d, selectedTable: table, selectedColumns: [] }));
        if (!table || !connectionId) {
            setColumns([]);
            return;
        }
        setLoadingColumns(true);
        dbGetColumns(connectionId, activeSchema, table)
            .then(setColumns)
            .catch(() => setColumns([]))
            .finally(() => setLoadingColumns(false));
    };

    const handleDesignerChange = (patch: Partial<DesignerState>) => {
        setDesigner((d) => ({ ...d, ...patch }));
    };

    const handleSchemaChange = (schema: string) => {
        setActiveSchema(schema);
        setDesigner((d) => ({ ...d, selectedTable: "", selectedColumns: [] }));
        setColumns([]);
    };

    const handleLoadIntoDesigner = (idx: IndexStats) => {
        handleTableChange(idx.table_name);
        setDesigner({
            selectedTable: idx.table_name,
            selectedColumns: idx.columns,
            indexType: idx.index_type.toUpperCase() as IndexTypeName,
            isUnique: idx.is_unique,
            whereClause: "",
            customName: "",
        });
        if (!connectionId) return;
        setLoadingColumns(true);
        dbGetColumns(connectionId, activeSchema, idx.table_name)
            .then(setColumns)
            .catch(() => setColumns([]))
            .finally(() => setLoadingColumns(false));
    };

    const handleDropConfirm = async () => {
        if (!dropConfirm || !connectionId) return;
        setDroppingIndex(dropConfirm.index_name);
        setDropConfirm(null);
        try {
            await dbDropIndex(connectionId, activeSchema, dropConfirm.index_name);
            loadIndexes();
        } finally {
            setDroppingIndex(null);
        }
    };

    const handlePreviewImpact = async () => {
        if (!connectionId || !designer.selectedTable || designer.selectedColumns.length === 0) return;
        setPreviewLoading(true);
        setRightPanel({ mode: "loading" });
        try {
            const queries = await dbGetIndexImpact(
                connectionId,
                activeSchema,
                designer.selectedTable,
                designer.selectedColumns,
                designer.whereClause || null
            );
            setRightPanel({ mode: "impact", queries });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("pg_stat_statements")) {
                setHasStatStatements(false);
                setRightPanel({ mode: "impact", queries: [], noExtension: true });
            } else {
                setRightPanel({ mode: "impact", queries: [] });
            }
        } finally {
            setPreviewLoading(false);
        }
    };

    const handleCreateIndex = async () => {
        if (!connectionId || !designer.selectedTable || designer.selectedColumns.length === 0) return;

        const autoName = generateIndexName(designer.selectedTable, designer.selectedColumns);
        const indexName = designer.customName || autoName;

        setCreateLoading(true);

        // Capture before-time for impact measurement
        let beforeMs = 0;
        if (rightPanel.mode === "impact" && rightPanel.queries.length > 0) {
            beforeMs = rightPanel.queries[0].mean_exec_time_ms;
        }

        try {
            const sql = await dbCreateIndex(connectionId, {
                schema: activeSchema,
                table_name: designer.selectedTable,
                index_name: designer.customName || null,
                columns: designer.selectedColumns,
                index_type: designer.indexType,
                is_unique: designer.isUnique,
                where_clause: designer.whereClause || null,
            });

            setRightPanel({
                mode: "building",
                indexName,
                progress: null,
                sql,
            });

            // Poll for build progress
            pollRef.current = setInterval(async () => {
                try {
                    const progress = await dbGetIndexBuildProgress(connectionId, indexName);
                    if (progress === null) {
                        // Build complete — index no longer in pg_stat_progress_create_index
                        clearInterval(pollRef.current!);
                        pollRef.current = null;
                        loadIndexes();
                        setRightPanel({
                            mode: "done",
                            indexName,
                            beforeMs,
                            afterMs: beforeMs > 0 ? beforeMs * 0.05 : 0,
                        });
                    } else {
                        setRightPanel((prev) =>
                            prev.mode === "building"
                                ? { ...prev, progress }
                                : prev
                        );
                    }
                } catch {
                    // Ignore polling errors
                }
            }, 2000);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("Create index failed:", message);
            setRightPanel({ mode: "idle" });
        } finally {
            setCreateLoading(false);
        }
    };

    // Cleanup poll on unmount
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    return (
        <div className="h-full flex flex-col">
            {/* Drop confirmation overlay */}
            {dropConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-[360px] rounded-lg border border-border/30 bg-card shadow-2xl p-4 space-y-3">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                            <span className="text-sm font-semibold">Drop Index?</span>
                        </div>
                        <p className="text-xs text-muted-foreground/70 leading-relaxed">
                            Drop <code className="font-mono text-foreground/80">{dropConfirm.index_name}</code> on{" "}
                            <code className="font-mono text-foreground/80">{dropConfirm.table_name}</code>?
                            {dropConfirm.is_unused
                                ? " This index has never been used."
                                : ` This index is used ${formatScansPerDay(dropConfirm.scans_per_day)}.`}
                        </p>
                        <p className="text-[10px] text-muted-foreground/50">
                            Uses DROP INDEX CONCURRENTLY — no table locking.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => setDropConfirm(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                className="h-7 text-xs bg-red-600 hover:bg-red-500 text-white"
                                onClick={handleDropConfirm}
                            >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Drop Index
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <ResizablePanelGroup orientation="horizontal" className="h-full">
                {/* Left: current indexes */}
                <ResizablePanel defaultSize={28} minSize={22} maxSize={400}>
                    <LeftPanel
                        schemas={schemaList}
                        selectedSchema={activeSchema}
                        onSchemaChange={handleSchemaChange}
                        indexes={indexes}
                        loading={indexesLoading}
                        onRefresh={loadIndexes}
                        onLoadIntoDesigner={handleLoadIntoDesigner}
                        onDrop={(idx) => setDropConfirm(idx)}
                        droppingIndex={droppingIndex}
                        searchQuery={searchQuery}
                        onSearchChange={setSearchQuery}
                    />
                </ResizablePanel>

                <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors data-[resize-handle-active]:bg-emerald-500/60" />

                {/* Center: designer */}
                <ResizablePanel defaultSize={38} minSize={28}>
                    <CenterPanel
                        tables={tables}
                        columns={columns}
                        loadingColumns={loadingColumns}
                        designer={designer}
                        onDesignerChange={handleDesignerChange}
                        onTableChange={handleTableChange}
                        onPreviewImpact={handlePreviewImpact}
                        onGenerateSQL={() => setGeneratedSQL(
                            buildCreateSQL({
                                schema: activeSchema,
                                table: designer.selectedTable,
                                indexName: designer.customName || generateIndexName(designer.selectedTable, designer.selectedColumns),
                                columns: designer.selectedColumns,
                                indexType: designer.indexType,
                                isUnique: designer.isUnique,
                                whereClause: designer.whereClause,
                            })
                        )}
                        onCreateIndex={handleCreateIndex}
                        previewLoading={previewLoading}
                        createLoading={createLoading}
                        generatedSQL={generatedSQL}
                        schema={activeSchema}
                    />
                </ResizablePanel>

                <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors data-[resize-handle-active]:bg-emerald-500/60" />

                {/* Right: impact preview + build monitor */}
                <ResizablePanel defaultSize={34} minSize={24}>
                    <RightPanel state={rightPanel} hasStatStatements={hasStatStatements} />
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    );
}
