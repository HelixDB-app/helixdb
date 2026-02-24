"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize2, LayoutGrid } from "lucide-react";
import type { SchemaDesignerTable } from "@/lib/types";

interface SchemaDiagramProps {
    onSelectTable: (id: string | null) => void;
    /** Call with runAutoLayout so parent can trigger layout (e.g. toolbar button). */
    onRequestLayout?: (run: () => void) => void;
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

interface FkEdge {
    fromTableName: string;
    fromColName: string;
    toTableName: string;
    toColName: string;
    sx: number;
    sy: number;
    tx: number;
    ty: number;
    midX: number;
    midY: number;
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
    const { getActiveProject, updateTablePosition, updateTablePositions } = useSchemaDesignerStore();
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
    const [hoveredEdge, setHoveredEdge] = useState<FkEdge | null>(null);
    const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

    const dragRafRef = useRef<number | null>(null);
    const dragPendingRef = useRef<{ nodeId: string; x: number; y: number } | null>(null);
    const defaultLayoutDoneRef = useRef<string | null>(null);

    const tables = project?.tables ?? [];

    const edges = useMemo((): FkEdge[] => {
        const out: FkEdge[] = [];
        for (const table of tables) {
            for (const col of table.columns) {
                if (!col.foreign_key) continue;
                const targetTable = tables.find(t => t.id === col.foreign_key!.target_table_id);
                if (!targetTable) continue;
                const targetCol = targetTable.columns.find(c => c.id === col.foreign_key!.target_column_id);
                const colIdx = table.columns.indexOf(col);
                const targetColIdx = targetCol ? targetTable.columns.indexOf(targetCol) : 0;
                const sx = (table.position?.x ?? 0) + NODE_W;
                const sy = (table.position?.y ?? 0) + HEADER_H + colIdx * ROW_H + ROW_H / 2;
                const tx = targetTable.position?.x ?? 0;
                const ty = (targetTable.position?.y ?? 0) + HEADER_H + targetColIdx * ROW_H + ROW_H / 2;
                const midX = (sx + tx) / 2;
                const midY = (sy + ty) / 2;
                out.push({
                    fromTableName: targetTable.name,
                    fromColName: targetCol?.name ?? "id",
                    toTableName: table.name,
                    toColName: col.name,
                    sx, sy, tx, ty, midX, midY,
                });
            }
        }
        return out;
    }, [tables]);

    // ── Hit test ─────────────────────────────────────────────────────────────

    const getNodeHeight = useCallback((table: SchemaDesignerTable) => {
        return Math.max(MIN_NODE_H, HEADER_H + table.columns.length * ROW_H + PADDING);
    }, []);

    const hitTest = useCallback((mx: number, my: number): SchemaDesignerTable | null => {
        // Convert screen coords to world coords
        const wx = (mx - pan.x) / zoom;
        const wy = (my - pan.y) / zoom;

        // Iterate in reverse so top-rendered nodes are hit first
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
                const cy = y + HEADER_H + i * ROW_H + ROW_H / 2;
                let nameX = x + NAME_LEFT;

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

                // Connection point (blue dot on right edge)
                ctx.fillStyle = COLORS.connectorDot;
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

        // Orthogonal FK lines (ref-style); hovered edge last
        const toDraw = hoveredEdge
            ? [edges.filter(e => e !== hoveredEdge), [hoveredEdge]]
            : [edges];
        const step = ORTHO_STEP;
        for (const edgeList of toDraw) {
            const isHovered = edgeList === toDraw[1];
            ctx.lineWidth = isHovered ? 2.5 : 1.5;
            ctx.strokeStyle = isHovered ? COLORS.fkLineHover : COLORS.fkLineDefault;
            ctx.setLineDash([]);
            for (const e of edgeList) {
                const midY = (e.sy + e.ty) / 2;
                const p1x = e.sx + step;
                const p2x = e.tx - step;
                ctx.beginPath();
                ctx.moveTo(e.sx, e.sy);
                ctx.lineTo(p1x, e.sy);
                ctx.lineTo(p1x, midY);
                ctx.lineTo(p2x, midY);
                ctx.lineTo(p2x, e.ty);
                ctx.lineTo(e.tx, e.ty);
                ctx.stroke();
                ctx.fillStyle = isHovered ? COLORS.fkLineHover : COLORS.fkLine;
                ctx.beginPath();
                ctx.moveTo(e.tx, e.ty);
                ctx.lineTo(e.tx - 6, e.ty - 4);
                ctx.lineTo(e.tx - 6, e.ty + 4);
                ctx.closePath();
                ctx.fill();
            }
        }

        ctx.restore();
    }, [tables, pan, zoom, selectedId, hoveredEdge, edges, getNodeHeight]);

    // ── Resize & redraw ──────────────────────────────────────────────────────

    useEffect(() => {
        const observer = new ResizeObserver(() => draw());
        const container = containerRef.current;
        if (container) observer.observe(container);
        draw();
        return () => observer.disconnect();
    }, [draw]);

    // ── Refs for window listeners (avoid stale closure) ────────────────────────

    const updateTablePositionRef = useRef(updateTablePosition);
    updateTablePositionRef.current = updateTablePosition;

    const flushDragPosition = useCallback(() => {
        const p = dragPendingRef.current;
        if (p) {
            updateTablePositionRef.current(p.nodeId, p.x, p.y);
            dragPendingRef.current = null;
        }
        if (dragRafRef.current) {
            cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = null;
        }
    }, []);

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
                        updateTablePositionRef.current(p.nodeId, p.x, p.y);
                        dragPendingRef.current = null;
                    }
                    dragRafRef.current = null;
                });
            }
        }
    }, [dragging, zoom, flushDragPosition]);

    const onDragMoveRef = useRef(applyDragMove);
    onDragMoveRef.current = applyDragMove;

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
            onDragMoveRef.current(mx, my);
        };
        const onWindowUp = () => endDrag();
        window.addEventListener("mousemove", onWindowMove, { capture: true });
        window.addEventListener("mouseup", onWindowUp, { capture: true });
        return () => {
            window.removeEventListener("mousemove", onWindowMove, { capture: true });
            window.removeEventListener("mouseup", onWindowUp, { capture: true });
        };
    }, [dragging, endDrag]);

    // ── Mouse handlers ───────────────────────────────────────────────────────

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

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
    }, [hitTest, pan, onSelectTable]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (dragging) {
            onDragMoveRef.current(mx, my);
            setHoveredEdge(null);
            setTooltipPos(null);
            return;
        }

        const wx = (mx - pan.x) / zoom;
        const wy = (my - pan.y) / zoom;
        const threshold = FK_HIT_THRESHOLD / zoom;
        let found: FkEdge | null = null;
        for (const edge of edges) {
            if (distanceToOrtho(wx, wy, edge.sx, edge.sy, edge.tx, edge.ty, ORTHO_STEP) < threshold) {
                found = edge;
                break;
            }
        }
        if (found !== hoveredEdge) {
            setHoveredEdge(found);
            setTooltipPos(found
                ? {
                    x: rect.left + pan.x + found.midX * zoom,
                    y: rect.top + pan.y + found.midY * zoom,
                }
                : null);
        }
    }, [dragging, zoom, pan, edges, hoveredEdge]);

    const handleMouseUp = useCallback(() => endDrag(), [endDrag]);

    const handleMouseLeave = useCallback(() => {
        if (!dragging) {
            setHoveredEdge(null);
            setTooltipPos(null);
        }
    }, [dragging]);


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
    }, [project?.id, tables, getNodeHeight, updateTablePositions]);

    return (
        <div ref={containerRef} className="h-full relative overflow-hidden">
            <canvas
                ref={canvasRef}
                className="w-full h-full select-none"
                style={{ cursor: dragging ? "grabbing" : "grab" }}
                title="Drag tables to move · Drag background to pan · Scroll to zoom"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => { handleMouseUp(); handleMouseLeave(); }}
                onWheel={handleWheel}
            />

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
                        {hoveredEdge.fromTableName}.{hoveredEdge.fromColName}
                    </span>
                    <span className="mx-1.5 text-emerald-200">→</span>
                    <span className="font-mono">
                        {hoveredEdge.toTableName}.{hoveredEdge.toColName}
                    </span>
                    <div className="text-[10px] text-emerald-100/90 mt-0.5 font-mono">
                        {hoveredEdge.fromColName} &rarr; {hoveredEdge.toColName}
                    </div>
                </div>
            )}

            {/* Empty state */}
            {tables.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-muted-foreground/40">Add tables to see the ER diagram</p>
                </div>
            )}
        </div>
    );
}
