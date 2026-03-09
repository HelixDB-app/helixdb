"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ZoomIn, ZoomOut, Maximize2, LayoutGrid, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ForeignKeyAction, SchemaDesignerTable } from "@/lib/types";

interface SchemaDiagramProps {
    onSelectTable: (id: string | null) => void;
    /** Call with runAutoLayout so parent can trigger layout (e.g. toolbar button). */
    onRequestLayout?: (run: () => void) => void;
}

type RelationMode = "many_to_one" | "one_to_one" | "one_to_many";

interface ColumnAnchor {
    tableId: string;
    tableName: string;
    tableX: number;
    tableY: number;
    columnId: string;
    columnName: string;
    columnIndex: number;
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isUnique: boolean;
    rowX: number;
    rowY: number;
    cy: number;
    leftX: number;
    rightX: number;
}

interface ConnectorHit extends ColumnAnchor {
    side: "left" | "right";
    connectorX: number;
}

interface FkEdge {
    id: string;
    referencingTableId: string;
    referencingColumnId: string;
    referencingTableName: string;
    referencingColName: string;
    referencedTableId: string;
    referencedColumnId: string;
    referencedTableName: string;
    referencedColName: string;
    onDelete: ForeignKeyAction;
    onUpdate: ForeignKeyAction;
    cardinality: "N:1" | "1:1";
    sx: number;
    sy: number;
    tx: number;
    ty: number;
    midX: number;
    midY: number;
}

interface LinkDraft {
    start: ConnectorHit;
    pointerX: number;
    pointerY: number;
    target: ColumnAnchor | null;
}

interface PendingRelation {
    source: ColumnAnchor;
    target: ColumnAnchor;
    mode: RelationMode;
    onDelete: ForeignKeyAction;
    onUpdate: ForeignKeyAction;
}

interface ResolvedRelation {
    owner: ColumnAnchor;
    referenced: ColumnAnchor;
    makeUnique: boolean;
    cardinalityLabel: "N:1" | "1:1" | "1:N";
}

// ── Drawing constants (aligned, ref-style) ─────────────────────────────────────

const NODE_W = 240;
const ROW_H = 24;
const HEADER_H = 36;
const PADDING = 14;
const CORNER_R = 8;
const MIN_NODE_H = HEADER_H + 24;
const FK_HIT_THRESHOLD = 14;
/** Right column width for data type (right-aligned). */
const TYPE_COLUMN_WIDTH = 80;
const NAME_LEFT = 10;
const BADGE_GAP = 6;
const CONNECTOR_R = 4;
const LAYOUT_GAP_X = 56;
const LAYOUT_GAP_Y = 40;
const ORTHO_STEP = 48;

const FK_ACTION_OPTIONS: ForeignKeyAction[] = [
    "CASCADE",
    "RESTRICT",
    "NO ACTION",
    "SET NULL",
    "SET DEFAULT",
];

const FK_ACTION_SET = new Set<ForeignKeyAction>(FK_ACTION_OPTIONS);

const COLORS = {
    bg: "#0d0d12",
    nodeBg: "#16161e",
    nodeBorder: "#252532",
    nodeHeaderBg: "#0f172a",
    headerText: "#e2e8f0",
    colText: "#cbd5e1",
    typeText: "#64748b",
    pkBadge: "#f59e0b",
    fkBadge: "#3b82f6",
    fkLine: "#475569",
    fkLineHover: "#10b981",
    fkLineDefault: "rgba(71,85,105,0.85)",
    fkLineSelected: "#f59e0b",
    selectedBorder: "#10b981",
    gridDot: "rgba(255,255,255,0.025)",
    connectorDot: "#3b82f6",
};

/** Orthogonal path: (sx,sy) → (sx+step,sy) → (sx+step,midY) → (tx-step,midY) → (tx-step,ty) → (tx,ty). */
function distanceToOrtho(wx: number, wy: number, sx: number, sy: number, tx: number, ty: number, step: number): number {
    const midY = (sy + ty) / 2;
    const p1x = sx + step;
    const p2x = tx - step;
    const segments: Array<[number, number, number, number]> = [
        [sx, sy, p1x, sy],
        [p1x, sy, p1x, midY],
        [p1x, midY, p2x, midY],
        [p2x, midY, p2x, ty],
        [p2x, ty, tx, ty],
    ];
    let min = Infinity;
    for (const [x0, y0, x1, y1] of segments) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const t = Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / (len * len)));
        const px = x0 + t * dx;
        const py = y0 + t * dy;
        const d = Math.hypot(wx - px, wy - py);
        if (d < min) min = d;
    }
    return min;
}

function normalizeForeignKeyAction(action: string | null | undefined): ForeignKeyAction {
    const normalized = (action ?? "").toUpperCase().replace(/\s+/g, " ").trim() as ForeignKeyAction;
    return FK_ACTION_SET.has(normalized) ? normalized : "CASCADE";
}

function normalizeTypeForComparison(raw: string): string {
    let t = raw.toUpperCase().replace(/\s+/g, " ").trim();
    const isArray = t.endsWith("[]");
    if (isArray) t = t.slice(0, -2).trim();
    t = t.replace(/\([^)]*\)/g, "").trim();

    const aliases: Record<string, string> = {
        INT: "INTEGER",
        INT4: "INTEGER",
        SERIAL: "INTEGER",
        BIGSERIAL: "BIGINT",
        INT8: "BIGINT",
        SMALLSERIAL: "SMALLINT",
        INT2: "SMALLINT",
        DECIMAL: "NUMERIC",
        CHARACTER: "TEXT",
        CHAR: "TEXT",
        VARCHAR: "TEXT",
        "CHARACTER VARYING": "TEXT",
        "DOUBLE PRECISION": "FLOAT8",
        REAL: "FLOAT4",
        BOOL: "BOOLEAN",
    };

    const base = aliases[t] ?? t;
    return isArray ? `${base}[]` : base;
}

function areTypesCompatible(sourceType: string, targetType: string): boolean {
    return normalizeTypeForComparison(sourceType) === normalizeTypeForComparison(targetType);
}

function inferDefaultRelationMode(source: ColumnAnchor, target: ColumnAnchor): RelationMode {
    const sourceLooksLikeFk = /_id$/i.test(source.columnName) && !source.isPrimaryKey;
    const targetLooksLikeKey = target.isPrimaryKey || target.isUnique || target.columnName.toLowerCase() === "id";
    const reverseLooksLikeFk = /_id$/i.test(target.columnName) && !target.isPrimaryKey;

    if (sourceLooksLikeFk && targetLooksLikeKey) return "many_to_one";
    if (source.isPrimaryKey && reverseLooksLikeFk) return "one_to_many";
    return "many_to_one";
}

function resolvePendingRelation(relation: PendingRelation): ResolvedRelation {
    if (relation.mode === "one_to_many") {
        return {
            owner: relation.target,
            referenced: relation.source,
            makeUnique: false,
            cardinalityLabel: "1:N",
        };
    }
    if (relation.mode === "one_to_one") {
        return {
            owner: relation.source,
            referenced: relation.target,
            makeUnique: true,
            cardinalityLabel: "1:1",
        };
    }
    return {
        owner: relation.source,
        referenced: relation.target,
        makeUnique: false,
        cardinalityLabel: "N:1",
    };
}

function validatePendingRelation(relation: PendingRelation): string | null {
    const resolved = resolvePendingRelation(relation);
    const { owner, referenced } = resolved;

    if (owner.tableId === referenced.tableId && owner.columnId === referenced.columnId) {
        return "A column cannot reference itself.";
    }
    if (!areTypesCompatible(owner.dataType, referenced.dataType)) {
        return `Type mismatch: ${owner.tableName}.${owner.columnName} (${owner.dataType}) is not compatible with ${referenced.tableName}.${referenced.columnName} (${referenced.dataType}).`;
    }
    if (!referenced.isPrimaryKey && !referenced.isUnique) {
        return `Referenced column must be PRIMARY KEY or UNIQUE: ${referenced.tableName}.${referenced.columnName}.`;
    }
    if ((relation.onDelete === "SET NULL" || relation.onUpdate === "SET NULL") && !owner.nullable) {
        return `SET NULL requires nullable FK column: ${owner.tableName}.${owner.columnName}.`;
    }
    return null;
}

function sanitizeConstraintName(input: string): string {
    const cleaned = input
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const normalized = cleaned || "fk_relation";
    return normalized.length > 63 ? normalized.slice(0, 63) : normalized;
}

function buildRelationSqlPreview(relation: PendingRelation): string {
    const resolved = resolvePendingRelation(relation);
    const fkName = sanitizeConstraintName(`fk_${resolved.owner.tableName}_${resolved.owner.columnName}`);
    const uqName = sanitizeConstraintName(`uq_${resolved.owner.tableName}_${resolved.owner.columnName}`);

    const fkSql =
        `ALTER TABLE "${resolved.owner.tableName}"\n` +
        `  ADD CONSTRAINT "${fkName}"\n` +
        `  FOREIGN KEY ("${resolved.owner.columnName}")\n` +
        `  REFERENCES "${resolved.referenced.tableName}" ("${resolved.referenced.columnName}")\n` +
        `  ON DELETE ${relation.onDelete}\n` +
        `  ON UPDATE ${relation.onUpdate};`;

    if (!resolved.makeUnique) return fkSql;

    const uniqueSql =
        `ALTER TABLE "${resolved.owner.tableName}"\n` +
        `  ADD CONSTRAINT "${uqName}" UNIQUE ("${resolved.owner.columnName}");`;

    return `${fkSql}\n\n${uniqueSql}`;
}

function relationModeLabel(mode: RelationMode, source: ColumnAnchor, target: ColumnAnchor): string {
    switch (mode) {
        case "many_to_one":
            return `${source.tableName} (many) -> ${target.tableName} (one)`;
        case "one_to_one":
            return `${source.tableName} (one) <-> ${target.tableName} (one)`;
        case "one_to_many":
            return `${source.tableName} (one) -> ${target.tableName} (many)`;
        default:
            return mode;
    }
}

/** Hierarchical layout: referenced tables left (col 0), dependents to the right. */
function computeAutoLayout(
    tables: SchemaDesignerTable[],
    getNodeHeight: (t: SchemaDesignerTable) => number
): { tableId: string; x: number; y: number }[] {
    const refs = new Map<string, Set<string>>();
    for (const t of tables) {
        const set = new Set<string>();
        for (const col of t.columns) {
            const tid = col.foreign_key?.target_table_id;
            if (tid && tid !== t.id) set.add(tid);
        }
        refs.set(t.id, set);
    }
    const level = new Map<string, number>();
    const stack = [...tables];
    let iters = 0;
    const maxIters = tables.length * 2;
    while (stack.length && iters++ < maxIters) {
        const t = stack.pop()!;
        const deps = refs.get(t.id)!;
        if (deps.size === 0) {
            level.set(t.id, 0);
            continue;
        }
        const depLevels = [...deps].map(id => level.get(id));
        if (depLevels.some(l => l === undefined)) {
            stack.unshift(t);
            continue;
        }
        level.set(t.id, 1 + Math.max(...(depLevels as number[])));
    }
    for (const t of tables) if (level.get(t.id) === undefined) level.set(t.id, 0);
    const byLevel = new Map<number, SchemaDesignerTable[]>();
    for (const t of tables) {
        const L = level.get(t.id) ?? 0;
        if (!byLevel.has(L)) byLevel.set(L, []);
        byLevel.get(L)!.push(t);
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const positions: { tableId: string; x: number; y: number }[] = [];
    let y = 40;
    for (const L of levels) {
        const group = byLevel.get(L)!;
        let maxH = 0;
        let x = 40;
        for (const t of group) {
            const h = getNodeHeight(t);
            positions.push({ tableId: t.id, x, y });
            maxH = Math.max(maxH, h);
            x += NODE_W + LAYOUT_GAP_X;
        }
        y += maxH + LAYOUT_GAP_Y;
    }
    return positions;
}

export function SchemaDiagram({ onSelectTable, onRequestLayout }: SchemaDiagramProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { getActiveProject, updateTablePosition, updateTablePositions, updateColumn, pushUndo } = useSchemaDesignerStore();
    const project = getActiveProject();

    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState<{
        type: "pan" | "node";
        startX: number;
        startY: number;
        nodeId?: string;
        nodeStartX?: number;
        nodeStartY?: number;
    } | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
    const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
    const [pendingRelation, setPendingRelation] = useState<PendingRelation | null>(null);

    const dragRafRef = useRef<number | null>(null);
    const dragPendingRef = useRef<{ nodeId: string; x: number; y: number } | null>(null);
    const defaultLayoutDoneRef = useRef<string | null>(null);

    const tables = useMemo(() => project?.tables ?? [], [project?.tables]);

    const columnAnchors = useMemo((): ColumnAnchor[] => {
        const anchors: ColumnAnchor[] = [];
        for (const table of tables) {
            const tableX = table.position?.x ?? 0;
            const tableY = table.position?.y ?? 0;
            for (let i = 0; i < table.columns.length; i++) {
                const col = table.columns[i];
                const rowY = tableY + HEADER_H + i * ROW_H;
                const cy = rowY + ROW_H / 2;
                anchors.push({
                    tableId: table.id,
                    tableName: table.name,
                    tableX,
                    tableY,
                    columnId: col.id,
                    columnName: col.name,
                    columnIndex: i,
                    dataType: col.data_type,
                    nullable: col.nullable,
                    isPrimaryKey: col.is_primary_key,
                    isUnique: !!col.unique,
                    rowX: tableX,
                    rowY,
                    cy,
                    leftX: tableX + CONNECTOR_R,
                    rightX: tableX + NODE_W - CONNECTOR_R,
                });
            }
        }
        return anchors;
    }, [tables]);

    const edges = useMemo((): FkEdge[] => {
        const out: FkEdge[] = [];
        for (const table of tables) {
            for (const col of table.columns) {
                if (!col.foreign_key) continue;
                const targetTable = tables.find(t => t.id === col.foreign_key!.target_table_id);
                if (!targetTable) continue;
                const targetCol = targetTable.columns.find(c => c.id === col.foreign_key!.target_column_id);
                if (!targetCol) continue;

                const colIdx = table.columns.indexOf(col);
                const targetColIdx = targetTable.columns.indexOf(targetCol);
                const sx = (table.position?.x ?? 0) + NODE_W;
                const sy = (table.position?.y ?? 0) + HEADER_H + colIdx * ROW_H + ROW_H / 2;
                const tx = targetTable.position?.x ?? 0;
                const ty = (targetTable.position?.y ?? 0) + HEADER_H + targetColIdx * ROW_H + ROW_H / 2;
                const midX = (sx + tx) / 2;
                const midY = (sy + ty) / 2;

                out.push({
                    id: `${table.id}:${col.id}->${targetTable.id}:${targetCol.id}`,
                    referencingTableId: table.id,
                    referencingColumnId: col.id,
                    referencingTableName: table.name,
                    referencingColName: col.name,
                    referencedTableId: targetTable.id,
                    referencedColumnId: targetCol.id,
                    referencedTableName: targetTable.name,
                    referencedColName: targetCol.name,
                    onDelete: normalizeForeignKeyAction(col.foreign_key.on_delete),
                    onUpdate: normalizeForeignKeyAction(col.foreign_key.on_update),
                    cardinality: col.unique || col.is_primary_key ? "1:1" : "N:1",
                    sx,
                    sy,
                    tx,
                    ty,
                    midX,
                    midY,
                });
            }
        }
        return out;
    }, [tables]);

    const hoveredEdge = useMemo(
        () => edges.find((edge) => edge.id === hoveredEdgeId) ?? null,
        [edges, hoveredEdgeId]
    );

    const selectedEdge = useMemo(
        () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
        [edges, selectedEdgeId]
    );

    const relationValidationError = useMemo(
        () => (pendingRelation ? validatePendingRelation(pendingRelation) : null),
        [pendingRelation]
    );

    const relationPreviewSql = useMemo(
        () => (pendingRelation ? buildRelationSqlPreview(pendingRelation) : ""),
        [pendingRelation]
    );

    // ── Hit test ─────────────────────────────────────────────────────────────

    const getNodeHeight = useCallback((table: SchemaDesignerTable) => {
        return Math.max(MIN_NODE_H, HEADER_H + table.columns.length * ROW_H + PADDING);
    }, []);

    const hitTest = useCallback((mx: number, my: number): SchemaDesignerTable | null => {
        const wx = (mx - pan.x) / zoom;
        const wy = (my - pan.y) / zoom;

        for (let i = tables.length - 1; i >= 0; i--) {
            const t = tables[i];
            const x = t.position?.x ?? 0;
            const y = t.position?.y ?? 0;
            const h = getNodeHeight(t);
            if (wx >= x && wx <= x + NODE_W && wy >= y && wy <= y + h) {
                return t;
            }
        }
        return null;
    }, [tables, pan, zoom, getNodeHeight]);

    const hitColumnAt = useCallback((wx: number, wy: number): ColumnAnchor | null => {
        for (let i = columnAnchors.length - 1; i >= 0; i--) {
            const anchor = columnAnchors[i];
            if (
                wx >= anchor.rowX &&
                wx <= anchor.rowX + NODE_W &&
                wy >= anchor.rowY &&
                wy <= anchor.rowY + ROW_H
            ) {
                return anchor;
            }
        }
        return null;
    }, [columnAnchors]);

    const hitConnectorAt = useCallback((wx: number, wy: number): ConnectorHit | null => {
        const radius = (CONNECTOR_R + 5) / zoom;
        for (let i = columnAnchors.length - 1; i >= 0; i--) {
            const anchor = columnAnchors[i];
            const leftDist = Math.hypot(wx - anchor.leftX, wy - anchor.cy);
            const rightDist = Math.hypot(wx - anchor.rightX, wy - anchor.cy);
            if (leftDist <= radius || rightDist <= radius) {
                if (leftDist <= rightDist) {
                    return { ...anchor, side: "left", connectorX: anchor.leftX };
                }
                return { ...anchor, side: "right", connectorX: anchor.rightX };
            }
        }
        return null;
    }, [columnAnchors, zoom]);

    const hitEdgeAt = useCallback((wx: number, wy: number): FkEdge | null => {
        const threshold = FK_HIT_THRESHOLD / zoom;
        for (let i = edges.length - 1; i >= 0; i--) {
            const edge = edges[i];
            if (distanceToOrtho(wx, wy, edge.sx, edge.sy, edge.tx, edge.ty, ORTHO_STEP) < threshold) {
                return edge;
            }
        }
        return null;
    }, [edges, zoom]);

    // ── Draw ─────────────────────────────────────────────────────────────────

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, rect.width, rect.height);

        // Grid dots
        ctx.fillStyle = COLORS.gridDot;
        const gridSize = 20 * zoom;
        const offsetX = pan.x % gridSize;
        const offsetY = pan.y % gridSize;
        for (let x = offsetX; x < rect.width; x += gridSize) {
            for (let y = offsetY; y < rect.height; y += gridSize) {
                ctx.fillRect(x, y, 1, 1);
            }
        }

        ctx.save();
        ctx.translate(pan.x, pan.y);
        ctx.scale(zoom, zoom);

        // Draw nodes first so FK lines render on top and stay visible
        for (const table of tables) {
            const x = table.position?.x ?? 0;
            const y = table.position?.y ?? 0;
            const h = getNodeHeight(table);
            const isSelected = table.id === selectedId;

            // Shadow
            ctx.shadowColor = "rgba(0,0,0,0.3)";
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 4;

            // Node body
            ctx.beginPath();
            ctx.roundRect(x, y, NODE_W, h, CORNER_R);
            ctx.fillStyle = COLORS.nodeBg;
            ctx.fill();

            // Border
            ctx.shadowBlur = 0;
            ctx.shadowColor = "transparent";
            ctx.strokeStyle = isSelected ? COLORS.selectedBorder : COLORS.nodeBorder;
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();

            // Header
            ctx.beginPath();
            ctx.roundRect(x, y, NODE_W, HEADER_H, [CORNER_R, CORNER_R, 0, 0]);
            ctx.fillStyle = COLORS.nodeHeaderBg;
            ctx.fill();

            // Table name
            ctx.fillStyle = COLORS.headerText;
            ctx.font = "bold 12px Inter, sans-serif";
            ctx.textBaseline = "middle";
            ctx.fillText(table.name, x + 10, y + HEADER_H / 2, NODE_W - 20);

            // Columns: line-by-line alignment — name left, type right (ref-style)
            const typeLeft = x + NODE_W - TYPE_COLUMN_WIDTH;
            for (let i = 0; i < table.columns.length; i++) {
                const col = table.columns[i];
                const rowY = y + HEADER_H + i * ROW_H;
                const cy = rowY + ROW_H / 2;
                let nameX = x + NAME_LEFT;

                const isLinkStart =
                    !!linkDraft &&
                    linkDraft.start.tableId === table.id &&
                    linkDraft.start.columnId === col.id;
                const isLinkTarget =
                    !!linkDraft?.target &&
                    linkDraft.target.tableId === table.id &&
                    linkDraft.target.columnId === col.id;

                if (isLinkStart || isLinkTarget) {
                    ctx.fillStyle = isLinkTarget ? "rgba(16,185,129,0.18)" : "rgba(59,130,246,0.2)";
                    ctx.fillRect(x + 1, rowY, NODE_W - 2, ROW_H);
                }

                // PK badge
                if (col.is_primary_key) {
                    ctx.fillStyle = COLORS.pkBadge;
                    ctx.font = "600 9px Inter, sans-serif";
                    ctx.fillText("PK", nameX, cy);
                    nameX += 18 + BADGE_GAP;
                }
                // FK badge
                if (col.foreign_key) {
                    ctx.fillStyle = COLORS.fkBadge;
                    ctx.font = "600 9px Inter, sans-serif";
                    ctx.fillText("FK", nameX, cy);
                    nameX += 18 + BADGE_GAP;
                }
                // Column name (left-aligned, clip to type column)
                ctx.fillStyle = COLORS.colText;
                ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
                const maxNameW = typeLeft - nameX - CONNECTOR_R * 2;
                ctx.fillText(col.name, nameX, cy, Math.max(40, maxNameW));

                // Data type right-aligned in type column
                ctx.fillStyle = COLORS.typeText;
                ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
                const typeW = ctx.measureText(col.data_type).width;
                ctx.fillText(col.data_type, x + NODE_W - TYPE_COLUMN_WIDTH - typeW - CONNECTOR_R * 2, cy);

                // Connection points (left + right)
                ctx.fillStyle = isLinkStart || isLinkTarget ? "#10b981" : COLORS.connectorDot;
                ctx.beginPath();
                ctx.arc(x + CONNECTOR_R, cy, CONNECTOR_R, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(x + NODE_W - CONNECTOR_R, cy, CONNECTOR_R, 0, Math.PI * 2);
                ctx.fill();

                if (!col.nullable) {
                    ctx.fillStyle = "#ef4444";
                    ctx.beginPath();
                    ctx.arc(x + NODE_W - TYPE_COLUMN_WIDTH - typeW - CONNECTOR_R * 2 - 6, cy, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        const drawEdgeList = (
            edgeList: FkEdge[],
            options: { lineWidth: number; strokeStyle: string; fillStyle: string; dashed?: boolean }
        ) => {
            if (edgeList.length === 0) return;
            ctx.lineWidth = options.lineWidth;
            ctx.strokeStyle = options.strokeStyle;
            ctx.setLineDash(options.dashed ? [4, 3] : []);
            for (const e of edgeList) {
                const midY = (e.sy + e.ty) / 2;
                const p1x = e.sx + ORTHO_STEP;
                const p2x = e.tx - ORTHO_STEP;
                ctx.beginPath();
                ctx.moveTo(e.sx, e.sy);
                ctx.lineTo(p1x, e.sy);
                ctx.lineTo(p1x, midY);
                ctx.lineTo(p2x, midY);
                ctx.lineTo(p2x, e.ty);
                ctx.lineTo(e.tx, e.ty);
                ctx.stroke();
                ctx.fillStyle = options.fillStyle;
                ctx.beginPath();
                ctx.moveTo(e.tx, e.ty);
                ctx.lineTo(e.tx - 6, e.ty - 4);
                ctx.lineTo(e.tx - 6, e.ty + 4);
                ctx.closePath();
                ctx.fill();
            }
            ctx.setLineDash([]);
        };

        const baseEdges = edges.filter(
            (edge) => edge.id !== hoveredEdge?.id && edge.id !== selectedEdge?.id
        );
        drawEdgeList(baseEdges, {
            lineWidth: 1.5,
            strokeStyle: COLORS.fkLineDefault,
            fillStyle: COLORS.fkLine,
        });

        if (hoveredEdge && hoveredEdge.id !== selectedEdge?.id) {
            drawEdgeList([hoveredEdge], {
                lineWidth: 2.5,
                strokeStyle: COLORS.fkLineHover,
                fillStyle: COLORS.fkLineHover,
            });
        }

        if (selectedEdge) {
            drawEdgeList([selectedEdge], {
                lineWidth: 2.8,
                strokeStyle: COLORS.fkLineSelected,
                fillStyle: COLORS.fkLineSelected,
            });
        }

        // Relationship drag preview line
        if (linkDraft) {
            const sx = linkDraft.start.connectorX;
            const sy = linkDraft.start.cy;
            const endX = linkDraft.target
                ? (Math.abs(sx - linkDraft.target.leftX) <= Math.abs(sx - linkDraft.target.rightX)
                    ? linkDraft.target.leftX
                    : linkDraft.target.rightX)
                : linkDraft.pointerX;
            const endY = linkDraft.target ? linkDraft.target.cy : linkDraft.pointerY;
            const targetCompatible =
                !linkDraft.target || areTypesCompatible(linkDraft.start.dataType, linkDraft.target.dataType);

            ctx.lineWidth = 2;
            ctx.strokeStyle = linkDraft.target
                ? (targetCompatible ? "#10b981" : "#ef4444")
                : "#3b82f6";
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(endX, endY);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore();
    }, [
        tables,
        pan,
        zoom,
        selectedId,
        hoveredEdge,
        selectedEdge,
        edges,
        getNodeHeight,
        linkDraft,
    ]);

    // ── Resize & redraw ──────────────────────────────────────────────────────

    useEffect(() => {
        const observer = new ResizeObserver(() => draw());
        const container = containerRef.current;
        if (container) observer.observe(container);
        draw();
        return () => observer.disconnect();
    }, [draw]);

    // ── Drag helpers ───────────────────────────────────────────────────────────
    const flushDragPosition = useCallback(() => {
        const p = dragPendingRef.current;
        if (p) {
            updateTablePosition(p.nodeId, p.x, p.y);
            dragPendingRef.current = null;
        }
        if (dragRafRef.current) {
            cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = null;
        }
    }, [updateTablePosition]);

    const applyDragMove = useCallback((mx: number, my: number) => {
        if (!dragging) return;
        if (dragging.type === "pan") {
            setPan({ x: mx - dragging.startX, y: my - dragging.startY });
        } else if (dragging.type === "node" && dragging.nodeId) {
            const dx = (mx - dragging.startX) / zoom;
            const dy = (my - dragging.startY) / zoom;
            const x = (dragging.nodeStartX ?? 0) + dx;
            const y = (dragging.nodeStartY ?? 0) + dy;
            dragPendingRef.current = { nodeId: dragging.nodeId, x, y };
            if (dragRafRef.current === null) {
                dragRafRef.current = requestAnimationFrame(() => {
                    const p = dragPendingRef.current;
                    if (p) {
                        updateTablePosition(p.nodeId, p.x, p.y);
                        dragPendingRef.current = null;
                    }
                    dragRafRef.current = null;
                });
            }
        }
    }, [dragging, zoom, updateTablePosition]);

    const endDrag = useCallback(() => {
        flushDragPosition();
        setDragging(null);
    }, [flushDragPosition]);

    // Window-level mouse up/move so drag works when pointer leaves canvas
    useEffect(() => {
        if (!dragging) return;
        const onWindowMove = (e: MouseEvent) => {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            applyDragMove(mx, my);
        };
        const onWindowUp = () => endDrag();
        window.addEventListener("mousemove", onWindowMove, { capture: true });
        window.addEventListener("mouseup", onWindowUp, { capture: true });
        return () => {
            window.removeEventListener("mousemove", onWindowMove, { capture: true });
            window.removeEventListener("mouseup", onWindowUp, { capture: true });
        };
    }, [dragging, applyDragMove, endDrag]);

    const clearEdgeHover = useCallback(() => {
        setHoveredEdgeId(null);
        setTooltipPos(null);
    }, []);

    // ── Mouse handlers ───────────────────────────────────────────────────────

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - pan.x) / zoom;
        const wy = (my - pan.y) / zoom;

        const connectorHit = hitConnectorAt(wx, wy);
        if (connectorHit) {
            setSelectedEdgeId(null);
            setSelectedId(connectorHit.tableId);
            onSelectTable(connectorHit.tableId);
            setLinkDraft({
                start: connectorHit,
                pointerX: wx,
                pointerY: wy,
                target: null,
            });
            clearEdgeHover();
            return;
        }

        const edgeHit = hitEdgeAt(wx, wy);
        if (edgeHit) {
            setSelectedEdgeId(edgeHit.id);
            setSelectedId(null);
            onSelectTable(null);
            setHoveredEdgeId(edgeHit.id);
            setTooltipPos({
                x: rect.left + pan.x + edgeHit.midX * zoom,
                y: rect.top + pan.y + edgeHit.midY * zoom,
            });
            return;
        }

        setSelectedEdgeId(null);
        const hit = hitTest(mx, my);
        if (hit) {
            setSelectedId(hit.id);
            onSelectTable(hit.id);
            setDragging({
                type: "node",
                startX: mx,
                startY: my,
                nodeId: hit.id,
                nodeStartX: hit.position?.x ?? 0,
                nodeStartY: hit.position?.y ?? 0,
            });
        } else {
            setSelectedId(null);
            onSelectTable(null);
            setDragging({ type: "pan", startX: mx - pan.x, startY: my - pan.y });
        }
        clearEdgeHover();
    }, [hitTest, pan, onSelectTable, zoom, hitConnectorAt, hitEdgeAt, clearEdgeHover]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - pan.x) / zoom;
        const wy = (my - pan.y) / zoom;

        if (linkDraft) {
            const maybeTarget = hitColumnAt(wx, wy);
            const validTarget =
                maybeTarget &&
                !(
                    maybeTarget.tableId === linkDraft.start.tableId &&
                    maybeTarget.columnId === linkDraft.start.columnId
                )
                    ? maybeTarget
                    : null;

            setLinkDraft((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    pointerX: wx,
                    pointerY: wy,
                    target: validTarget,
                };
            });
            clearEdgeHover();
            return;
        }

        if (dragging) {
            applyDragMove(mx, my);
            clearEdgeHover();
            return;
        }

        const found = hitEdgeAt(wx, wy);
        if (found?.id !== hoveredEdgeId) {
            if (found) {
                setHoveredEdgeId(found.id);
                setTooltipPos({
                    x: rect.left + pan.x + found.midX * zoom,
                    y: rect.top + pan.y + found.midY * zoom,
                });
            } else {
                clearEdgeHover();
            }
        }
    }, [
        dragging,
        zoom,
        pan,
        hoveredEdgeId,
        linkDraft,
        hitColumnAt,
        hitEdgeAt,
        clearEdgeHover,
        applyDragMove,
    ]);

    const handleMouseUp = useCallback(() => {
        if (linkDraft) {
            if (linkDraft.target) {
                setPendingRelation({
                    source: linkDraft.start,
                    target: linkDraft.target,
                    mode: inferDefaultRelationMode(linkDraft.start, linkDraft.target),
                    onDelete: "CASCADE",
                    onUpdate: "CASCADE",
                });
            }
            setLinkDraft(null);
            return;
        }
        endDrag();
    }, [endDrag, linkDraft]);

    const handleMouseLeave = useCallback(() => {
        if (!dragging && !linkDraft) {
            clearEdgeHover();
        }
    }, [dragging, linkDraft, clearEdgeHover]);

    const handleDeleteSelectedEdge = useCallback(() => {
        if (!selectedEdge) return;
        pushUndo("Remove relationship");
        updateColumn(selectedEdge.referencingTableId, selectedEdge.referencingColumnId, { foreign_key: null });
        setSelectedEdgeId(null);
        toast.success("Relationship removed.");
    }, [selectedEdge, pushUndo, updateColumn]);

    useEffect(() => {
        if (!selectedEdge) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (pendingRelation) return;
            if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                handleDeleteSelectedEdge();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectedEdge, pendingRelation, handleDeleteSelectedEdge]);

    const applyPendingRelation = useCallback(() => {
        if (!pendingRelation) return;
        const validationError = validatePendingRelation(pendingRelation);
        if (validationError) {
            toast.error(validationError);
            return;
        }

        const resolved = resolvePendingRelation(pendingRelation);
        const updates: {
            foreign_key: {
                target_table_id: string;
                target_column_id: string;
                on_delete: ForeignKeyAction;
                on_update: ForeignKeyAction;
            };
            unique?: boolean;
        } = {
            foreign_key: {
                target_table_id: resolved.referenced.tableId,
                target_column_id: resolved.referenced.columnId,
                on_delete: pendingRelation.onDelete,
                on_update: pendingRelation.onUpdate,
            },
        };

        if (resolved.makeUnique) {
            updates.unique = true;
        }

        pushUndo("Create relationship");
        updateColumn(resolved.owner.tableId, resolved.owner.columnId, updates);

        setPendingRelation(null);
        setSelectedEdgeId(
            `${resolved.owner.tableId}:${resolved.owner.columnId}->${resolved.referenced.tableId}:${resolved.referenced.columnId}`
        );
        toast.success(
            `Relationship created: ${resolved.owner.tableName}.${resolved.owner.columnName} -> ${resolved.referenced.tableName}.${resolved.referenced.columnName}`
        );
    }, [pendingRelation, pushUndo, updateColumn]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.2, Math.min(3, zoom * factor));

        setPan({
            x: mx - (mx - pan.x) * (newZoom / zoom),
            y: my - (my - pan.y) * (newZoom / zoom),
        });
        setZoom(newZoom);
    }, [zoom, pan]);

    const fitToView = useCallback(() => {
        if (tables.length === 0) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const t of tables) {
            const tx = t.position?.x ?? 0;
            const ty = t.position?.y ?? 0;
            const h = getNodeHeight(t);
            minX = Math.min(minX, tx);
            minY = Math.min(minY, ty);
            maxX = Math.max(maxX, tx + NODE_W);
            maxY = Math.max(maxY, ty + h);
        }

        const contentW = maxX - minX + 80;
        const contentH = maxY - minY + 80;
        const newZoom = Math.min(1.5, Math.min(rect.width / contentW, rect.height / contentH));

        setPan({
            x: (rect.width - contentW * newZoom) / 2 - minX * newZoom + 40 * newZoom,
            y: (rect.height - contentH * newZoom) / 2 - minY * newZoom + 40 * newZoom,
        });
        setZoom(newZoom);
    }, [tables, getNodeHeight]);

    const runAutoLayout = useCallback(() => {
        if (!project || tables.length === 0) return;
        const positions = computeAutoLayout(tables, getNodeHeight);
        updateTablePositions(positions);
        setTimeout(fitToView, 80);
    }, [project, tables, getNodeHeight, updateTablePositions, fitToView]);

    useEffect(() => {
        onRequestLayout?.(runAutoLayout);
        return () => onRequestLayout?.(() => {});
    }, [onRequestLayout, runAutoLayout]);

    // One-time default layout when diagram has overlapping or many tables
    useEffect(() => {
        if (!project || tables.length < 2) return;
        if (defaultLayoutDoneRef.current === project.id) return;
        const key = (t: SchemaDesignerTable) => `${t.position?.x ?? 0},${t.position?.y ?? 0}`;
        const count = new Map<string, number>();
        for (const t of tables) {
            const k = key(t);
            count.set(k, (count.get(k) ?? 0) + 1);
        }
        const overlapping = [...count.values()].some(c => c > 1);
        if (overlapping || tables.length > 6) {
            defaultLayoutDoneRef.current = project.id;
            const positions = computeAutoLayout(tables, getNodeHeight);
            updateTablePositions(positions);
        }
    }, [project, tables, getNodeHeight, updateTablePositions]);

    return (
        <div ref={containerRef} className="h-full relative overflow-hidden">
            <canvas
                ref={canvasRef}
                className="w-full h-full select-none"
                style={{ cursor: linkDraft ? "crosshair" : dragging ? "grabbing" : "grab" }}
                title="Drag column connectors to create relationships · Drag tables to move · Drag background to pan · Scroll to zoom"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => { handleMouseUp(); handleMouseLeave(); }}
                onWheel={handleWheel}
            />

            {/* Diagram hint */}
            <div className="absolute top-3 left-3 px-2 py-1 rounded-md border border-border/30 bg-card/70 backdrop-blur text-[10px] text-muted-foreground">
                Drag a blue connector from one column to another to create FK
            </div>

            {/* Selected edge quick actions */}
            {selectedEdge && !pendingRelation && (
                <div className="absolute top-3 right-3 max-w-[360px] rounded-md border border-amber-500/30 bg-card/90 backdrop-blur px-2.5 py-2 shadow-lg">
                    <div className="text-[11px] font-mono text-foreground leading-snug">
                        {selectedEdge.referencingTableName}.{selectedEdge.referencingColName}
                        <span className="mx-1 text-amber-400">-&gt;</span>
                        {selectedEdge.referencedTableName}.{selectedEdge.referencedColName}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-muted-foreground font-mono">
                            {selectedEdge.cardinality} · DELETE {selectedEdge.onDelete} · UPDATE {selectedEdge.onUpdate}
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300"
                            onClick={handleDeleteSelectedEdge}
                        >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Remove
                        </Button>
                    </div>
                </div>
            )}

            {/* Zoom + layout controls */}
            <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-card/80 backdrop-blur-sm rounded-lg border border-border/20 p-1">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={runAutoLayout}
                    title="Auto layout"
                >
                    <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
                <div className="w-px h-4 bg-border/30" />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.min(3, z * 1.2))}>
                    <ZoomIn className="h-3 w-3" />
                </Button>
                <span className="text-[10px] text-muted-foreground font-mono w-10 text-center">
                    {Math.round(zoom * 100)}%
                </span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.max(0.2, z * 0.8))}>
                    <ZoomOut className="h-3 w-3" />
                </Button>
                <div className="w-px h-4 bg-border/30" />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fitToView} title="Fit to view">
                    <Maximize2 className="h-3 w-3" />
                </Button>
            </div>

            {/* FK relationship tooltip on hover */}
            {hoveredEdge && tooltipPos && (
                <div
                    className="fixed z-50 px-2.5 py-1.5 rounded-md bg-emerald-500/95 text-white text-xs font-medium shadow-lg border border-emerald-400/30 pointer-events-none"
                    style={{
                        left: tooltipPos.x,
                        top: tooltipPos.y,
                        transform: "translate(-50%, -100%) translateY(-8px)",
                    }}
                >
                    <span className="font-mono">
                        {hoveredEdge.referencingTableName}.{hoveredEdge.referencingColName}
                    </span>
                    <span className="mx-1.5 text-emerald-200">→</span>
                    <span className="font-mono">
                        {hoveredEdge.referencedTableName}.{hoveredEdge.referencedColName}
                    </span>
                    <div className="text-[10px] text-emerald-100/90 mt-0.5 font-mono">
                        {hoveredEdge.cardinality} · DELETE {hoveredEdge.onDelete} · UPDATE {hoveredEdge.onUpdate}
                    </div>
                </div>
            )}

            {/* Relationship creation dialog */}
            <Dialog open={!!pendingRelation} onOpenChange={(open) => { if (!open) setPendingRelation(null); }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Create relationship</DialogTitle>
                    </DialogHeader>

                    {pendingRelation && (
                        <div className="space-y-3">
                            <div className="rounded-md border border-border/30 bg-muted/20 px-3 py-2 text-xs font-mono">
                                {pendingRelation.source.tableName}.{pendingRelation.source.columnName}
                                <span className="mx-1.5 text-emerald-500">→</span>
                                {pendingRelation.target.tableName}.{pendingRelation.target.columnName}
                            </div>

                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                                    Relationship
                                </label>
                                <Select
                                    value={pendingRelation.mode}
                                    onValueChange={(value) =>
                                        setPendingRelation((prev) =>
                                            prev
                                                ? { ...prev, mode: value as RelationMode }
                                                : prev
                                        )
                                    }
                                >
                                    <SelectTrigger className="text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="many_to_one" className="text-xs">
                                            {relationModeLabel("many_to_one", pendingRelation.source, pendingRelation.target)}
                                        </SelectItem>
                                        <SelectItem value="one_to_one" className="text-xs">
                                            {relationModeLabel("one_to_one", pendingRelation.source, pendingRelation.target)}
                                        </SelectItem>
                                        <SelectItem value="one_to_many" className="text-xs">
                                            {relationModeLabel("one_to_many", pendingRelation.source, pendingRelation.target)}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                                        ON DELETE
                                    </label>
                                    <Select
                                        value={pendingRelation.onDelete}
                                        onValueChange={(value) =>
                                            setPendingRelation((prev) =>
                                                prev
                                                    ? { ...prev, onDelete: value as ForeignKeyAction }
                                                    : prev
                                            )
                                        }
                                    >
                                        <SelectTrigger className="text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {FK_ACTION_OPTIONS.map((action) => (
                                                <SelectItem key={`delete-${action}`} value={action} className="text-xs">
                                                    {action}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                                        ON UPDATE
                                    </label>
                                    <Select
                                        value={pendingRelation.onUpdate}
                                        onValueChange={(value) =>
                                            setPendingRelation((prev) =>
                                                prev
                                                    ? { ...prev, onUpdate: value as ForeignKeyAction }
                                                    : prev
                                            )
                                        }
                                    >
                                        <SelectTrigger className="text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {FK_ACTION_OPTIONS.map((action) => (
                                                <SelectItem key={`update-${action}`} value={action} className="text-xs">
                                                    {action}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            {relationValidationError ? (
                                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
                                    {relationValidationError}
                                </div>
                            ) : (
                                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-200">
                                    Relation is valid.
                                </div>
                            )}

                            <div>
                                <div className="text-[11px] font-medium text-muted-foreground mb-1">SQL preview</div>
                                <pre className="rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">
                                    {relationPreviewSql}
                                </pre>
                            </div>
                        </div>
                    )}

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingRelation(null)}>Cancel</Button>
                        <Button
                            onClick={applyPendingRelation}
                            disabled={!!relationValidationError}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            Create relationship
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Empty state */}
            {tables.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-muted-foreground/40">Add tables to see the ER diagram</p>
                </div>
            )}
        </div>
    );
}
