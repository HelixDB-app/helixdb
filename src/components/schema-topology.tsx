"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    memo,
} from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { dbGetSchemaTopology } from "@/lib/tauri";
import type { TopologyData, TopologyNode, TopologyEdge, TopologyColumn } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Popover,
    PopoverAnchor,
    PopoverContent,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { Loader2, Network, RefreshCw, Search, Table2, Maximize2, Download, FileImage, FileType, FileText, List, Key, Link2, AlertTriangle, XCircle } from "lucide-react";

// ── Layout Constants ─────────────────────────────────────────────────────────

const NODE_WIDTH = 260;
const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 24;
const MAX_VISIBLE_COLUMNS = 12;
const NODE_PADDING_BOTTOM = 8;
const LAYER_GAP = 180;
const NODE_GAP = 40;
const PADDING = 80;
const EDGE_HIT_WIDTH = 14;

/** Compute dynamic card height based on column count */
function nodeHeight(node: TopologyNode): number {
    const visibleCols = Math.min(node.columns.length, MAX_VISIBLE_COLUMNS);
    const moreRow = node.columns.length > MAX_VISIBLE_COLUMNS ? ROW_HEIGHT : 0;
    return HEADER_HEIGHT + visibleCols * ROW_HEIGHT + moreRow + NODE_PADDING_BOTTOM;
}

/** Y offset from top of card to center of a column row (by index). */
function getColumnYOffset(node: TopologyNode, columnName: string): number {
    const i = node.columns.findIndex((c) => c.name === columnName);
    return i >= 0 && i < MAX_VISIBLE_COLUMNS
        ? HEADER_HEIGHT + ROW_HEIGHT / 2 + i * ROW_HEIGHT
        : nodeHeight(node) / 2;
}

/** Horizontal inset so edge starts/ends just outside card stroke. */
const EDGE_INSET = 2;
/** Radius for FK (filled) and PK (hollow) markers. */
const EDGE_MARKER_R = 4;

// ── Export Theme ──────────────────────────────────────────────────────────────

const EXPORT_THEME = {
    bg: "#09090b",
    cardFill: "#18181b",
    cardStroke: "#3f3f46",
    headerBg: "#1e1e24",
    text: "#fafafa",
    textMuted: "#a1a1aa",
    textDim: "#71717a",
    edgeStroke: "#525252",
    pkColor: "#eab308",
    fkColor: "#3b82f6",
    divider: "#27272a",
} as const;

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function truncateForExport(s: string, maxChars: number): string {
    return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + "…";
}

const EXPORT_MAX_TABLE = 20;
const EXPORT_MAX_COLUMN = 16;
const EXPORT_MAX_TYPE = 10;
const EXPORT_VISIBLE_COLUMNS = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nodeId(schema: string, table: string): string {
    return `${schema}.${table}`;
}

function formatRowCount(n: number): string {
    if (n < 0) return "—";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
}

function shortType(dt: string): string {
    const t = dt.toLowerCase();
    if (t === "character varying") return "varchar";
    if (t === "timestamp without time zone") return "timestamp";
    if (t === "timestamp with time zone") return "timestamptz";
    if (t === "double precision") return "float8";
    if (t === "boolean") return "bool";
    if (t === "integer") return "int4";
    if (t === "bigint") return "int8";
    if (t === "smallint") return "int2";
    if (t === "real") return "float4";
    if (t === "character") return "char";
    if (t.startsWith("array")) return "array";
    return dt.length > 12 ? dt.slice(0, 11) + "…" : dt;
}

// ── Layout Algorithm ─────────────────────────────────────────────────────────

/**
 * Layered ERD layout: left-to-right by FK dependency.
 * Referenced tables go left, FK holders go right.
 */
function runLayeredLayout(
    nodes: TopologyNode[],
    edges: TopologyEdge[]
): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();
    if (nodes.length === 0) return positions;

    const nodeMap = new Map(nodes.map((n) => [nodeId(n.schema, n.table_name), n]));
    const ids = Array.from(nodeMap.keys());
    const layer = new Map<string, number>();
    ids.forEach((id) => layer.set(id, 0));

    const edgeList = edges.map((e) => ({
        from: nodeId(e.from_schema, e.from_table),
        to: nodeId(e.to_schema, e.to_table),
    }));

    let changed = true;
    const maxIterations = Math.max(nodes.length * edges.length, nodes.length * 2) + 1;
    let iterations = 0;
    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;
        for (const { from, to } of edgeList) {
            const lTo = layer.get(to) ?? 0;
            const lFrom = layer.get(from) ?? 0;
            if (lFrom < lTo + 1) {
                layer.set(from, lTo + 1);
                changed = true;
            }
        }
    }

    const layers = new Map<number, string[]>();
    ids.forEach((id) => {
        const L = layer.get(id)!;
        if (!layers.has(L)) layers.set(L, []);
        layers.get(L)!.push(id);
    });
    const sortedLayers = Array.from(layers.entries()).sort((a, b) => a[0] - b[0]);

    let x = PADDING + NODE_WIDTH / 2;
    for (const [, layerIds] of sortedLayers) {
        const sorted = [...layerIds].sort();
        let y = PADDING;
        for (const id of sorted) {
            const node = nodeMap.get(id);
            const h = node ? nodeHeight(node) : 100;
            positions.set(id, { x, y: y + h / 2 });
            y += h + NODE_GAP;
        }
        x += NODE_WIDTH + LAYER_GAP;
    }

    return positions;
}

// ── Orthogonal Edge Path ─────────────────────────────────────────────────────

/** Build an orthogonal (right-angle) SVG path from FK column to PK column. */
function orthogonalPath(
    x1: number, y1: number,
    x2: number, y2: number
): string {
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
}

/** ERD edge from FK column (right of fromNode) to PK column (left of toNode). */
function edgeColumnToColumn(
    fromPos: { x: number; y: number },
    toPos: { x: number; y: number },
    fromNode: TopologyNode,
    toNode: TopologyNode,
    fromColumn: string,
    toColumn: string
): { d: string; startX: number; startY: number; endX: number; endY: number } {
    const fromH = nodeHeight(fromNode);
    const toH = nodeHeight(toNode);
    const fromY = fromPos.y - fromH / 2 + getColumnYOffset(fromNode, fromColumn);
    const toY = toPos.y - toH / 2 + getColumnYOffset(toNode, toColumn);
    const startX = fromPos.x + NODE_WIDTH / 2 + EDGE_INSET;
    const endX = toPos.x - NODE_WIDTH / 2 - EDGE_INSET;
    const d = orthogonalPath(startX, fromY, endX, toY);
    return { d, startX, startY: fromY, endX, endY: toY };
}

// ── Bounding Box ─────────────────────────────────────────────────────────────

function computeBbox(
    positions: Map<string, { x: number; y: number }>,
    nodeMap: Map<string, TopologyNode>
): { minX: number; minY: number; width: number; height: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    positions.forEach((p, id) => {
        const node = nodeMap.get(id);
        const h = node ? nodeHeight(node) : 100;
        minX = Math.min(minX, p.x - NODE_WIDTH / 2);
        maxX = Math.max(maxX, p.x + NODE_WIDTH / 2);
        minY = Math.min(minY, p.y - h / 2);
        maxY = Math.max(maxY, p.y + h / 2);
    });
    const pad = 40;
    return {
        minX: minX - pad,
        minY: minY - pad,
        width: maxX - minX + 2 * pad,
        height: maxY - minY + 2 * pad,
    };
}

// ── Export SVG Builder ────────────────────────────────────────────────────────

function buildExportSvg(
    topology: TopologyData,
    positions: Map<string, { x: number; y: number }>,
    bbox: { minX: number; minY: number; width: number; height: number }
): string {
    const { minX, minY, width, height } = bbox;
    const nodeMap = new Map(topology.nodes.map((n) => [nodeId(n.schema, n.table_name), n]));

    // Build FK column set for highlighting
    const fkColumns = new Set<string>();
    topology.edges.forEach((e) => {
        fkColumns.add(`${e.from_schema}.${e.from_table}.${e.from_column}`);
    });

    const paths: string[] = [];
    topology.edges.forEach((e) => {
        const fromId = nodeId(e.from_schema, e.from_table);
        const toId = nodeId(e.to_schema, e.to_table);
        const from = positions.get(fromId);
        const to = positions.get(toId);
        const fromNode = nodeMap.get(fromId);
        const toNode = nodeMap.get(toId);
        if (!from || !to || !fromNode || !toNode) return;
        const { d, startX, startY, endX, endY } = edgeColumnToColumn(
            from, to, fromNode, toNode, e.from_column, e.to_column
        );
        paths.push(
            `<path fill="none" stroke="${EXPORT_THEME.edgeStroke}" stroke-width="1.5" d="${d}"/>`,
            `<circle cx="${startX}" cy="${startY}" r="${EDGE_MARKER_R}" fill="${EXPORT_THEME.edgeStroke}"/>`,
            `<circle cx="${endX}" cy="${endY}" r="${EDGE_MARKER_R}" fill="none" stroke="${EXPORT_THEME.edgeStroke}" stroke-width="1.5"/>`
        );
    });

    const nodes: string[] = [];
    topology.nodes.forEach((node: TopologyNode) => {
        const id = nodeId(node.schema, node.table_name);
        const pos = positions.get(id);
        if (!pos) return;
        const h = nodeHeight(node);
        const x = pos.x - NODE_WIDTH / 2;
        const y = pos.y - h / 2;
        const rowLabel = formatRowCount(node.row_count);
        const visibleCols = node.columns.slice(0, EXPORT_VISIBLE_COLUMNS);
        const tableText = escapeXml(truncateForExport(node.table_name, EXPORT_MAX_TABLE));

        const columnRows = visibleCols
            .map((col: TopologyColumn, i: number) => {
                const rowY = HEADER_HEIGHT + i * ROW_HEIGHT;
                const textY = rowY + ROW_HEIGHT / 2;
                const colName = escapeXml(truncateForExport(col.name, EXPORT_MAX_COLUMN));
                const colType = escapeXml(truncateForExport(shortType(col.data_type), EXPORT_MAX_TYPE));
                const isFk = fkColumns.has(`${node.schema}.${node.table_name}.${col.name}`);
                let icon = "";
                if (col.is_primary_key) {
                    icon = `<text x="12" y="${textY}" font-size="10" fill="${EXPORT_THEME.pkColor}" dominant-baseline="central">🔑</text>`;
                } else if (isFk) {
                    icon = `<text x="12" y="${textY}" font-size="10" fill="${EXPORT_THEME.fkColor}" dominant-baseline="central">🔗</text>`;
                }
                // Row background for alternating
                const rowBg = i % 2 === 0 ? "" : `<rect x="0" y="${rowY}" width="${NODE_WIDTH}" height="${ROW_HEIGHT}" fill="${EXPORT_THEME.bg}" opacity="0.3"/>`;
                return `${rowBg}${icon}<text x="28" y="${textY}" font-size="11" font-family="monospace" fill="${EXPORT_THEME.text}" dominant-baseline="central">${colName}</text><text x="${NODE_WIDTH - 12}" y="${textY}" font-size="10" font-family="monospace" fill="${EXPORT_THEME.textDim}" text-anchor="end" dominant-baseline="central">${colType}</text>`;
            })
            .join("");

        const moreCount = node.columns.length - EXPORT_VISIBLE_COLUMNS;
        const moreY = HEADER_HEIGHT + EXPORT_VISIBLE_COLUMNS * ROW_HEIGHT + ROW_HEIGHT / 2;
        const moreText = moreCount > 0
            ? `<text x="${NODE_WIDTH / 2}" y="${moreY}" font-size="10" fill="${EXPORT_THEME.textDim}" text-anchor="middle" dominant-baseline="central">+${moreCount} more columns</text>`
            : "";

        const clipId = `clip-${id.replace(/\./g, "-")}`;
        nodes.push(`
  <g transform="translate(${x},${y})">
    <defs><clipPath id="${clipId}"><rect width="${NODE_WIDTH}" height="${h}" rx="4" ry="4"/></clipPath></defs>
    <g clip-path="url(#${clipId})">
      <rect width="${NODE_WIDTH}" height="${h}" rx="4" ry="4" fill="${EXPORT_THEME.cardFill}" stroke="${EXPORT_THEME.cardStroke}" stroke-width="1.5"/>
      <rect width="${NODE_WIDTH}" height="${HEADER_HEIGHT}" rx="4" ry="4" fill="${EXPORT_THEME.headerBg}"/>
      <rect y="${HEADER_HEIGHT - 4}" width="${NODE_WIDTH}" height="4" fill="${EXPORT_THEME.headerBg}"/>
      <text x="12" y="16" font-size="10" fill="${EXPORT_THEME.textMuted}">${escapeXml(node.schema)}</text>
      <text x="12" y="38" font-size="14" font-weight="600" fill="${EXPORT_THEME.text}">${tableText}</text>
      <text x="${NODE_WIDTH - 12}" y="38" font-size="10" fill="${EXPORT_THEME.textMuted}" text-anchor="end">${escapeXml(rowLabel)} rows</text>
      <line x1="0" y1="${HEADER_HEIGHT}" x2="${NODE_WIDTH}" y2="${HEADER_HEIGHT}" stroke="${EXPORT_THEME.divider}" stroke-width="1"/>
      ${columnRows}
      ${moreText}
    </g>
  </g>`);
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">
  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${EXPORT_THEME.bg}"/>
  <g>${paths.join("")}</g>
  <g>${nodes.join("")}</g>
</svg>`;
}

// ── NodeCard Component ───────────────────────────────────────────────────────

const NodeCard = memo(function NodeCard({
    node,
    x,
    y,
    isHighlighted,
    isEdgeSelected,
    fkColumns,
    highlightedColumns,
}: {
    node: TopologyNode;
    x: number;
    y: number;
    isHighlighted: boolean;
    isEdgeSelected: boolean;
    fkColumns: Set<string>;
    highlightedColumns: Set<string>;
}) {
    const h = nodeHeight(node);
    const visibleCols = node.columns.slice(0, MAX_VISIBLE_COLUMNS);
    const moreCount = node.columns.length - MAX_VISIBLE_COLUMNS;

    return (
        <g
            className="cursor-context-menu select-none"
            transform={`translate(${x - NODE_WIDTH / 2}, ${y - h / 2})`}
        >
            {/* Edge selection glow */}
            {isEdgeSelected && (
                <rect
                    width={NODE_WIDTH + 4}
                    height={h + 4}
                    x={-2}
                    y={-2}
                    rx={6}
                    ry={6}
                    className="fill-none stroke-2 stroke-emerald-500/50"
                />
            )}

            {/* Card background */}
            <rect
                width={NODE_WIDTH}
                height={h}
                rx={4}
                ry={4}
                className={cn(
                    "fill-card stroke-[1.5] transition-colors",
                    isEdgeSelected
                        ? "stroke-emerald-500"
                        : isHighlighted
                            ? "stroke-emerald-500/90"
                            : "stroke-border/70 hover:stroke-muted-foreground/50"
                )}
            />

            {/* Header background */}
            <rect
                width={NODE_WIDTH}
                height={HEADER_HEIGHT}
                rx={4}
                ry={4}
                className="fill-muted/30"
            />
            {/* Bottom fill for header (covers bottom rounding) */}
            <rect
                y={HEADER_HEIGHT - 4}
                width={NODE_WIDTH}
                height={4}
                className="fill-muted/30"
            />

            {/* Schema tag */}
            <text
                x={12}
                y={18}
                className="fill-muted-foreground text-[10px] font-medium"
                style={{ dominantBaseline: "middle" }}
            >
                {node.schema}
            </text>

            {/* Table name */}
            <text
                x={12}
                y={38}
                className="fill-foreground text-sm font-semibold"
                style={{ dominantBaseline: "middle" }}
            >
                {node.table_name.length > 24
                    ? node.table_name.slice(0, 23) + "…"
                    : node.table_name}
            </text>

            {/* Row count badge */}
            <text
                x={NODE_WIDTH - 12}
                y={38}
                className="fill-muted-foreground text-[10px]"
                style={{ dominantBaseline: "middle", textAnchor: "end" }}
            >
                {formatRowCount(node.row_count)} rows
            </text>

            {/* Header divider */}
            <line
                x1={0}
                y1={HEADER_HEIGHT}
                x2={NODE_WIDTH}
                y2={HEADER_HEIGHT}
                className="stroke-border/40"
                strokeWidth={1}
            />

            {/* Column rows */}
            {visibleCols.map((col, i) => {
                const rowY = HEADER_HEIGHT + i * ROW_HEIGHT;
                const textY = rowY + ROW_HEIGHT / 2;
                const isFk = fkColumns.has(`${node.schema}.${node.table_name}.${col.name}`);
                const isColHighlighted = highlightedColumns.has(col.name);

                return (
                    <g key={col.name}>
                        {/* Alternating row background */}
                        {i % 2 === 1 && (
                            <rect
                                x={0}
                                y={rowY}
                                width={NODE_WIDTH}
                                height={ROW_HEIGHT}
                                className="fill-muted/15"
                            />
                        )}
                        {/* Search highlight */}
                        {isColHighlighted && (
                            <rect
                                x={0}
                                y={rowY}
                                width={NODE_WIDTH}
                                height={ROW_HEIGHT}
                                className="fill-emerald-500/10"
                            />
                        )}
                        {/* PK / FK icon */}
                        {col.is_primary_key ? (
                            <g transform={`translate(10, ${textY})`}>
                                <Key
                                    width={12}
                                    height={12}
                                    x={-6}
                                    y={-6}
                                    className="text-yellow-500"
                                />
                            </g>
                        ) : isFk ? (
                            <g transform={`translate(10, ${textY})`}>
                                <Link2
                                    width={12}
                                    height={12}
                                    x={-6}
                                    y={-6}
                                    className="text-blue-400"
                                />
                            </g>
                        ) : null}
                        {/* Column name */}
                        <text
                            x={col.is_primary_key || isFk ? 24 : 12}
                            y={textY}
                            className={cn(
                                "text-[11px] font-mono",
                                col.is_primary_key
                                    ? "fill-yellow-400"
                                    : isFk
                                        ? "fill-blue-300"
                                        : "fill-foreground/90"
                            )}
                            style={{ dominantBaseline: "central" }}
                        >
                            {col.name.length > 22
                                ? col.name.slice(0, 21) + "…"
                                : col.name}
                        </text>
                        {/* Data type (right-aligned) */}
                        <text
                            x={NODE_WIDTH - 12}
                            y={textY}
                            className="fill-muted-foreground/60 text-[10px] font-mono"
                            style={{ dominantBaseline: "central", textAnchor: "end" }}
                        >
                            {shortType(col.data_type)}
                        </text>
                        {/* Row separator */}
                        {i < visibleCols.length - 1 && (
                            <line
                                x1={8}
                                y1={rowY + ROW_HEIGHT}
                                x2={NODE_WIDTH - 8}
                                y2={rowY + ROW_HEIGHT}
                                className="stroke-border/15"
                                strokeWidth={0.5}
                            />
                        )}
                    </g>
                );
            })}

            {/* "+N more" indicator */}
            {moreCount > 0 && (
                <text
                    x={NODE_WIDTH / 2}
                    y={HEADER_HEIGHT + MAX_VISIBLE_COLUMNS * ROW_HEIGHT + ROW_HEIGHT / 2}
                    className="fill-muted-foreground/50 text-[10px] italic"
                    style={{ dominantBaseline: "central", textAnchor: "middle" }}
                >
                    +{moreCount} more columns
                </text>
            )}
        </g>
    );
});

// ── Main Component ───────────────────────────────────────────────────────────

export function SchemaTopology({
    onNavigateToTable,
}: {
    onNavigateToTable: (schema: string, table: string) => void;
}) {
    const { connectionId, selectedSchema, schemas, selectTable } =
        useConnectionStore();
    const containerRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const [topologySchema, setTopologySchema] = useState<string | null>(null);
    const [topology, setTopology] = useState<TopologyData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
    const [scale, setScale] = useState(1);
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [dragNode, setDragNode] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        schema: string;
        table: string;
    } | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<{
        fromId: string;
        toId: string;
    } | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<{
        fromId: string;
        toId: string;
    } | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [columnPopoverNode, setColumnPopoverNode] = useState<TopologyNode | null>(null);
    const [columnPopoverAnchor, setColumnPopoverAnchor] = useState<{ x: number; y: number } | null>(null);
    const panStart = useRef({ x: 0, y: 0 });
    const dragStart = useRef({ x: 0, y: 0 });
    const clickStartRef = useRef<{ id: string; x: number; y: number } | null>(null);

    const schema = topologySchema ?? selectedSchema ?? schemas[0]?.name ?? null;

    // ── Data Fetching ────────────────────────────────────────────────────────

    const abortRef = useRef<AbortController | null>(null);

    const fetchTopology = useCallback(
        (signal?: AbortSignal) => {
            if (!connectionId || !schema) {
                setTopology(null);
                setPositions(new Map());
                return;
            }
            setLoading(true);
            setError(null);
            dbGetSchemaTopology(connectionId, schema)
                .then((data) => {
                    if (signal?.aborted) return;
                    setTopology(data);
                })
                .catch((err) => {
                    if (signal?.aborted) return;
                    setError(String(err));
                    setTopology(null);
                })
                .finally(() => {
                    if (signal?.aborted) return;
                    setLoading(false);
                });
        },
        [connectionId, schema]
    );

    useEffect(() => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        fetchTopology(controller.signal);
        return () => {
            controller.abort();
        };
    }, [fetchTopology]);

    // ── Layout Computation ───────────────────────────────────────────────────

    useEffect(() => {
        if (!topology?.nodes.length || !containerRef.current) return;
        const raw = runLayeredLayout(topology.nodes, topology.edges);
        const { width: w, height: h } = containerRef.current.getBoundingClientRect();
        const W = Math.max(400, w);
        const H = Math.max(300, h);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const nodeMap = new Map(topology.nodes.map((n) => [nodeId(n.schema, n.table_name), n]));
        raw.forEach(({ x, y }, id) => {
            const node = nodeMap.get(id);
            const nh = node ? nodeHeight(node) : 100;
            minX = Math.min(minX, x - NODE_WIDTH / 2);
            maxX = Math.max(maxX, x + NODE_WIDTH / 2);
            minY = Math.min(minY, y - nh / 2);
            maxY = Math.max(maxY, y + nh / 2);
        });
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const offsetX = W / 2 - cx;
        const offsetY = H / 2 - cy;
        const next = new Map<string, { x: number; y: number }>();
        raw.forEach((pos, id) =>
            next.set(id, { x: pos.x + offsetX, y: pos.y + offsetY })
        );
        setPositions(next);
        const bw = maxX - minX + 40;
        const bh = maxY - minY + 40;
        const s = Math.max(0.2, Math.min(1.5, (W - 40) / bw, (H - 40) / bh));
        setScale(s);
        setTranslate({ x: 0, y: 0 });
    }, [topology?.nodes, topology?.edges]);

    // ── Search & Highlight ───────────────────────────────────────────────────

    const searchLower = search.trim().toLowerCase();
    const highlightedIds = useMemo(() => {
        if (!searchLower || !topology) return new Set<string>();
        const s = new Set<string>();
        topology.nodes.forEach((nd) => {
            const id = nodeId(nd.schema, nd.table_name);
            if (
                nd.table_name.toLowerCase().includes(searchLower) ||
                nd.schema.toLowerCase().includes(searchLower) ||
                nd.columns.some((c) => c.name.toLowerCase().includes(searchLower))
            ) {
                s.add(id);
            }
        });
        return s;
    }, [searchLower, topology]);

    /** Set of column names that match the search (for intra-card highlighting) */
    const highlightedColumns = useMemo(() => {
        if (!searchLower) return new Set<string>();
        const s = new Set<string>();
        topology?.nodes.forEach((nd) => {
            nd.columns.forEach((col) => {
                if (col.name.toLowerCase().includes(searchLower)) {
                    s.add(col.name);
                }
            });
        });
        return s;
    }, [searchLower, topology]);

    // ── FK column set ────────────────────────────────────────────────────────

    const fkColumns = useMemo(() => {
        const s = new Set<string>();
        topology?.edges.forEach((e) => {
            s.add(`${e.from_schema}.${e.from_table}.${e.from_column}`);
        });
        return s;
    }, [topology?.edges]);

    // ── Node & Edge Memos ────────────────────────────────────────────────────

    const nodeMap = useMemo(
        () => topology ? new Map(topology.nodes.map((n) => [nodeId(n.schema, n.table_name), n])) : new Map<string, TopologyNode>(),
        [topology]
    );

    const edgePaths = useMemo(() => {
        if (!topology || positions.size === 0) return [];
        return topology.edges.map((e) => {
            const fromId = nodeId(e.from_schema, e.from_table);
            const toId = nodeId(e.to_schema, e.to_table);
            const from = positions.get(fromId);
            const to = positions.get(toId);
            const fromNode = nodeMap.get(fromId);
            const toNode = nodeMap.get(toId);
            if (!from || !to || !fromNode || !toNode) return null;
            const { d, startX, startY, endX, endY } = edgeColumnToColumn(
                from, to, fromNode, toNode, e.from_column, e.to_column
            );
            return {
                key: e.constraint_name,
                d,
                startX,
                startY,
                endX,
                endY,
                fromId,
                toId,
                label: `${e.from_column} → ${e.to_column}`,
            };
        }).filter(Boolean) as {
            key: string;
            d: string;
            startX: number;
            startY: number;
            endX: number;
            endY: number;
            fromId: string;
            toId: string;
            label: string;
        }[];
    }, [topology?.edges, topology?.nodes, positions, nodeMap]);

    // ── Event Handlers ───────────────────────────────────────────────────────

    const handleWheel = useCallback(
        (e: React.WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                setScale((s) => Math.max(0.2, Math.min(3, s + delta)));
            }
        },
        []
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (e.button !== 0) return;
            const target = e.target as SVGElement;
            const edgeEl = target.closest("[data-edge-from]");
            if (edgeEl) {
                const fromId = (edgeEl as HTMLElement).getAttribute("data-edge-from");
                const toId = (edgeEl as HTMLElement).getAttribute("data-edge-to");
                if (fromId && toId) {
                    e.stopPropagation();
                    setSelectedEdge({ fromId, toId });
                }
                return;
            }
            const nodeEl = target.closest("[data-node-id]");
            if (nodeEl) {
                setSelectedEdge(null);
                const id = (nodeEl as HTMLElement).getAttribute("data-node-id");
                if (id) {
                    setDragNode(id);
                    dragStart.current = { x: e.clientX, y: e.clientY };
                    clickStartRef.current = { id, x: e.clientX, y: e.clientY };
                }
            } else {
                setSelectedEdge(null);
                setIsPanning(true);
                panStart.current = { x: e.clientX - translate.x, y: e.clientY - translate.y };
            }
        },
        [translate]
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (dragNode) {
                if (clickStartRef.current) {
                    const d = Math.hypot(e.clientX - clickStartRef.current.x, e.clientY - clickStartRef.current.y);
                    if (d > 8) clickStartRef.current = null;
                }
                const dx = (e.clientX - dragStart.current.x) / scale;
                const dy = (e.clientY - dragStart.current.y) / scale;
                dragStart.current = { x: e.clientX, y: e.clientY };
                setPositions((prev) => {
                    const next = new Map(prev);
                    const p = next.get(dragNode!);
                    if (p) next.set(dragNode!, { x: p.x + dx, y: p.y + dy });
                    return next;
                });
            } else if (isPanning) {
                setTranslate({
                    x: e.clientX - panStart.current.x,
                    y: e.clientY - panStart.current.y,
                });
            }
        },
        [dragNode, isPanning, scale]
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent) => {
            if (clickStartRef.current && topology && containerRef.current) {
                const { id, x: cx, y: cy } = clickStartRef.current;
                const d = Math.hypot(e.clientX - cx, e.clientY - cy);
                if (d <= 8) {
                    const pos = positions.get(id);
                    const rect = containerRef.current.getBoundingClientRect();
                    const w = Math.max(400, rect.width);
                    const h = Math.max(300, rect.height);
                    if (pos) {
                        const anchorX = rect.left + (pos.x - w / 2) * scale + w / 2 + translate.x;
                        const anchorY = rect.top + (pos.y - h / 2) * scale + h / 2 + translate.y;
                        const node = topology.nodes.find((n) => nodeId(n.schema, n.table_name) === id);
                        if (node) {
                            setColumnPopoverAnchor({ x: anchorX, y: anchorY });
                            setColumnPopoverNode(node);
                        }
                    }
                }
            }
            clickStartRef.current = null;
            setDragNode(null);
            setIsPanning(false);
        },
        [topology, positions, scale, translate]
    );

    const handleSvgPointerLeave = useCallback(() => {
        setDragNode(null);
        setIsPanning(false);
        setHoveredEdge(null);
    }, []);

    const handleViewTable = useCallback(
        (schemaName: string, tableName: string) => {
            setContextMenu(null);
            selectTable(schemaName, tableName);
            onNavigateToTable(schemaName, tableName);
        },
        [selectTable, onNavigateToTable]
    );

    useEffect(() => {
        if (!contextMenu) return;
        const close = () => setContextMenu(null);
        const t = setTimeout(() => window.addEventListener("click", close, { once: true }), 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener("click", close);
        };
    }, [contextMenu]);

    const fitView = useCallback(() => {
        if (positions.size === 0 || !containerRef.current) return;
        const { width: w, height: h } = containerRef.current.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        positions.forEach((p, id) => {
            const node = nodeMap.get(id);
            const nh = node ? nodeHeight(node) : 100;
            minX = Math.min(minX, p.x - NODE_WIDTH / 2);
            maxX = Math.max(maxX, p.x + NODE_WIDTH / 2);
            minY = Math.min(minY, p.y - nh / 2);
            maxY = Math.max(maxY, p.y + nh / 2);
        });
        const bw = maxX - minX + 40;
        const bh = maxY - minY + 40;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const s = Math.max(0.2, Math.min(1.5, (w - 40) / bw, (h - 40) / bh));
        setScale(s);
        setTranslate({ x: -(cx - w / 2) * s, y: -(cy - h / 2) * s });
    }, [positions, nodeMap]);

    // ── Export ────────────────────────────────────────────────────────────────

    const exportDiagram = useCallback(
        async (format: "svg" | "png" | "pdf") => {
            if (!topology || positions.size === 0) {
                toast.error("No diagram to export", { id: "export-toast" });
                return;
            }
            setIsExporting(true);
            const label = format === "svg" ? "SVG" : format === "png" ? "PNG" : "PDF";
            toast.loading(`Exporting ${label}…`, { id: "export-toast" });
            const bbox = computeBbox(positions, nodeMap);
            const svgString = buildExportSvg(topology, positions, bbox);
            const baseName = `schema-topology-${schema ?? "public"}`;

            try {
                if (format === "svg") {
                    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${baseName}.svg`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success("Exported as SVG", { id: "export-toast" });
                    return;
                }

                const scaleFactor = 2;
                const w = Math.round(bbox.width * scaleFactor);
                const h = Math.round(bbox.height * scaleFactor);
                const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
                const svgUrl = URL.createObjectURL(svgBlob);
                const img = new Image();
                await new Promise<void>((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject(new Error("Image load failed"));
                    img.src = svgUrl;
                });
                URL.revokeObjectURL(svgUrl);

                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    toast.error("Export failed", { id: "export-toast" });
                    return;
                }
                ctx.fillStyle = EXPORT_THEME.bg;
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                const pngBlob = await new Promise<Blob | null>((res) =>
                    canvas.toBlob(res, "image/png", 1)
                );
                if (!pngBlob) {
                    toast.error("Export failed", { id: "export-toast" });
                    return;
                }

                if (format === "png") {
                    const url = URL.createObjectURL(pngBlob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${baseName}.png`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success("Exported as PNG", { id: "export-toast" });
                    return;
                }

                const { jsPDF } = await import("jspdf");
                const pdf = new jsPDF({
                    orientation: w > h ? "landscape" : "portrait",
                    unit: "px",
                    format: [w, h],
                });
                const dataUrl = URL.createObjectURL(pngBlob);
                pdf.addImage(dataUrl, "PNG", 0, 0, w, h);
                URL.revokeObjectURL(dataUrl);
                pdf.save(`${baseName}.pdf`);
                toast.success("Exported as PDF", { id: "export-toast" });
            } catch (err) {
                console.error(err);
                toast.error(`${label} export failed`, { id: "export-toast" });
            } finally {
                setIsExporting(false);
            }
        },
        [topology, positions, schema, nodeMap]
    );

    // ── Guard Renders ────────────────────────────────────────────────────────

    if (!connectionId) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                Connect to a database first.
            </div>
        );
    }

    if (!schema) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                Select a schema in the sidebar.
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Loading topology…</span>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => {
                        abortRef.current?.abort();
                        setLoading(false);
                        setError("Topology loading was cancelled.");
                    }}
                >
                    <XCircle className="h-3.5 w-3.5" />
                    Cancel
                </Button>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
                <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-8 py-6 max-w-md text-center">
                    <AlertTriangle className="h-8 w-8 text-destructive/80" />
                    <p className="text-sm font-medium text-destructive">
                        Failed to load topology
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        {error}
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 gap-1.5 text-xs"
                        onClick={() => fetchTopology()}
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                    </Button>
                </div>
            </div>
        );
    }

    if (!topology || topology.nodes.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
                <Network className="h-10 w-10 opacity-50" />
                <span>No tables in this schema.</span>
            </div>
        );
    }

    const { width, height } = containerRef.current?.getBoundingClientRect() ?? {
        width: 800,
        height: 600,
    };
    const w = Math.max(400, width);
    const h = Math.max(300, height);

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border/20 px-3 py-2">
                <Select
                    value={schema ?? ""}
                    onValueChange={(v) => setTopologySchema(v)}
                >
                    <SelectTrigger className="h-8 w-[140px] text-xs" size="sm">
                        <SelectValue placeholder="Schema" />
                    </SelectTrigger>
                    <SelectContent>
                        {schemas.map((s) => (
                            <SelectItem key={s.name} value={s.name} className="text-xs">
                                {s.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder="Search tables or columns…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-8 h-8 text-xs"
                    />
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs shrink-0"
                    onClick={fitView}
                    title="Fit graph in view"
                >
                    <Maximize2 className="h-3 w-3" />
                    Fit view
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs shrink-0"
                    onClick={() => fetchTopology()}
                >
                    <RefreshCw className="h-3 w-3" />
                    Refresh
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 text-xs shrink-0"
                            disabled={!topology || positions.size === 0 || isExporting}
                            title="Export diagram"
                        >
                            {isExporting ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Download className="h-3 w-3" />
                            )}
                            Export
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[10rem]">
                        <DropdownMenuItem
                            onClick={() => exportDiagram("png")}
                            className="gap-2 cursor-pointer"
                        >
                            <FileImage className="h-3.5 w-3.5" />
                            PNG image
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => exportDiagram("svg")}
                            className="gap-2 cursor-pointer"
                        >
                            <FileType className="h-3.5 w-3.5" />
                            SVG vector
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => exportDiagram("pdf")}
                            className="gap-2 cursor-pointer"
                        >
                            <FileText className="h-3.5 w-3.5" />
                            PDF document
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Canvas */}
            <div
                ref={containerRef}
                className="flex-1 overflow-hidden bg-muted/10"
                onWheel={handleWheel}
                style={{ touchAction: "none" }}
            >
                <svg
                    ref={svgRef}
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${w} ${h}`}
                    className="overflow-visible"
                    style={{
                        cursor: isPanning ? "grabbing" : dragNode ? "grabbing" : "grab",
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handleSvgPointerLeave}
                >
                    <g
                        transform={`translate(${w / 2 + translate.x}, ${h / 2 + translate.y}) scale(${scale}) translate(${-w / 2}, ${-h / 2})`}
                    >
                        {/* Edges */}
                        {edgePaths.map(({ key, d, startX, startY, endX, endY, fromId, toId, label }) => {
                            const isSelected =
                                selectedEdge?.fromId === fromId && selectedEdge?.toId === toId;
                            const isHovered =
                                hoveredEdge?.fromId === fromId && hoveredEdge?.toId === toId;
                            const isActive = isSelected || isHovered;
                            const strokeClass = isActive
                                ? "stroke-emerald-500 stroke-[2] transition-colors"
                                : "stroke-muted-foreground/30 stroke-[1.5] transition-colors";
                            const markerFill = isActive ? "fill-emerald-500" : "fill-muted-foreground/30";
                            const markerStroke = isActive ? "stroke-emerald-500" : "stroke-muted-foreground/30";
                            return (
                                <g
                                    key={key}
                                    data-edge-from={fromId}
                                    data-edge-to={toId}
                                    className="cursor-pointer"
                                    onPointerEnter={() => setHoveredEdge({ fromId, toId })}
                                    onPointerLeave={() => setHoveredEdge(null)}
                                >
                                    {/* Invisible hit area */}
                                    <path
                                        d={d}
                                        fill="none"
                                        strokeWidth={EDGE_HIT_WIDTH}
                                        stroke="transparent"
                                        strokeLinecap="round"
                                    />
                                    {/* Visible edge */}
                                    <path
                                        d={d}
                                        fill="none"
                                        className={strokeClass}
                                    />
                                    {/* FK (many) side: filled dot */}
                                    <circle
                                        cx={startX}
                                        cy={startY}
                                        r={EDGE_MARKER_R}
                                        className={markerFill}
                                    />
                                    {/* PK (one) side: hollow circle */}
                                    <circle
                                        cx={endX}
                                        cy={endY}
                                        r={EDGE_MARKER_R}
                                        fill="none"
                                        strokeWidth={1.5}
                                        className={markerStroke}
                                    />
                                    {/* Edge tooltip on hover */}
                                    {isActive && (
                                        <text
                                            x={(startX + endX) / 2}
                                            y={(startY + endY) / 2 - 8}
                                            className="fill-emerald-400 text-[9px] font-mono"
                                            style={{ textAnchor: "middle", dominantBaseline: "auto" }}
                                        >
                                            {label}
                                        </text>
                                    )}
                                </g>
                            );
                        })}

                        {/* Nodes */}
                        {topology.nodes.map((node) => {
                            const id = nodeId(node.schema, node.table_name);
                            const pos = positions.get(id);
                            if (!pos) return null;
                            return (
                                <g
                                    key={id}
                                    data-node-id={id}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setContextMenu({
                                            x: e.clientX,
                                            y: e.clientY,
                                            schema: node.schema,
                                            table: node.table_name,
                                        });
                                    }}
                                >
                                    <NodeCard
                                        node={node}
                                        x={pos.x}
                                        y={pos.y}
                                        isHighlighted={highlightedIds.has(id)}
                                        isEdgeSelected={(() => {
                                            const edge = selectedEdge ?? hoveredEdge;
                                            return (
                                                edge !== null &&
                                                (id === edge.fromId || id === edge.toId)
                                            );
                                        })()}
                                        fkColumns={fkColumns}
                                        highlightedColumns={highlightedColumns}
                                    />
                                </g>
                            );
                        })}
                    </g>
                </svg>
            </div>

            {/* Context Menu */}
            {contextMenu && (
                <div
                    className="fixed z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border/40 bg-card/95 px-1 py-1 shadow-xl backdrop-blur-sm"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <button
                        type="button"
                        className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                        onClick={() =>
                            handleViewTable(contextMenu.schema, contextMenu.table)
                        }
                    >
                        <Table2 className="h-3.5 w-3.5 shrink-0" />
                        View table
                    </button>
                </div>
            )}

            {/* Column Popover */}
            <Popover
                open={!!columnPopoverNode}
                onOpenChange={(open) => {
                    if (!open) {
                        setColumnPopoverNode(null);
                        setColumnPopoverAnchor(null);
                    }
                }}
            >
                {columnPopoverAnchor && (
                    <PopoverAnchor asChild>
                        <div
                            className="fixed w-0 h-0"
                            style={{ left: columnPopoverAnchor.x, top: columnPopoverAnchor.y }}
                        />
                    </PopoverAnchor>
                )}
                <PopoverContent
                    align="start"
                    side="right"
                    sideOffset={8}
                    className="max-h-[min(70vh,420px)] w-80 flex flex-col p-0"
                >
                    {columnPopoverNode && (
                        <>
                            <div className="shrink-0 flex items-center gap-2 border-b border-border px-3 py-2">
                                <List className="h-4 w-4 text-muted-foreground" />
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold truncate">
                                        {columnPopoverNode.schema}.{columnPopoverNode.table_name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {columnPopoverNode.columns.length} columns · {formatRowCount(columnPopoverNode.row_count)} rows
                                    </p>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-2">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="text-muted-foreground border-b border-border/30">
                                            <th className="text-left py-1 px-2 font-medium">Column</th>
                                            <th className="text-left py-1 px-2 font-medium">Type</th>
                                            <th className="text-center py-1 px-1 font-medium w-8">Key</th>
                                        </tr>
                                    </thead>
                                    <tbody className="font-mono">
                                        {columnPopoverNode.columns.map((col) => {
                                            const isFk = fkColumns.has(`${columnPopoverNode.schema}.${columnPopoverNode.table_name}.${col.name}`);
                                            return (
                                                <tr
                                                    key={col.name}
                                                    className="hover:bg-muted/60 border-b border-border/10"
                                                    title={`${col.name}: ${col.data_type}${col.is_nullable ? " (nullable)" : ""}`}
                                                >
                                                    <td className="py-1 px-2 break-all text-foreground">
                                                        {col.name}
                                                    </td>
                                                    <td className="py-1 px-2 text-muted-foreground">
                                                        {shortType(col.data_type)}
                                                    </td>
                                                    <td className="py-1 px-1 text-center">
                                                        {col.is_primary_key && (
                                                            <Key className="h-3 w-3 text-yellow-500 inline-block" />
                                                        )}
                                                        {isFk && !col.is_primary_key && (
                                                            <Link2 className="h-3 w-3 text-blue-400 inline-block" />
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    );
}
