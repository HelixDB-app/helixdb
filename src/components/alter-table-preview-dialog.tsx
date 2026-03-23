"use client";

import { useMemo, type ReactNode } from "react";
import ReactFlow, {
    Background,
    Controls,
    MarkerType,
    type Edge,
    type Node,
    type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import {
    AlertTriangle,
    ArrowRightLeft,
    CheckCircle2,
    Copy,
    Database,
    GitBranch,
    Loader2,
    Network,
    Rows3,
    ShieldAlert,
    Sparkles,
    Table2,
} from "lucide-react";
import { toast } from "sonner";

import type {
    AlterTableAlternative,
    AlterTablePreview,
    AlterTablePreviewEdge,
    AlterTablePreviewNode,
    AlterTableRisk,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { writeClipboardText } from "@/lib/clipboard";

type PreviewGraphNodeData = {
    node: AlterTablePreviewNode;
};

const GRAPH_NODE_WIDTH = 320;
const GRAPH_CENTER_GAP = 130;
const GRAPH_SIDE_GAP = 140;
const GRAPH_ROW_STEP = 330;
const GRAPH_RELATED_ROW_Y = 460;
const GRAPH_RELATED_GAP = 120;
const MAX_VISIBLE_COLUMNS = 8;

function formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en", { notation: "compact" }).format(Math.max(0, value));
}

function riskBadgeVariant(level: string): "outline" | "secondary" | "destructive" {
    if (level === "critical") return "destructive";
    if (level === "high") return "secondary";
    return "outline";
}

function riskBadgeClass(level: string) {
    if (level === "critical") return "border-red-500/40 bg-red-500/10 text-red-200";
    if (level === "high") return "border-amber-500/35 bg-amber-500/10 text-amber-100";
    if (level === "medium") return "border-sky-500/35 bg-sky-500/10 text-sky-100";
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
}

function confidenceFromWarnings(warningCount: number) {
    if (warningCount <= 0) {
        return {
            label: "High confidence",
            className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
        };
    }
    if (warningCount <= 2) {
        return {
            label: "Medium confidence",
            className: "border-amber-500/35 bg-amber-500/10 text-amber-100",
        };
    }
    return {
        label: "Review recommended",
        className: "border-red-500/35 bg-red-500/10 text-red-100",
    };
}

function roleLabel(role: string) {
    switch (role) {
        case "current":
            return "Current";
        case "proposed":
            return "Proposed";
        case "dependency":
            return "Referenced";
        case "dependent":
            return "Dependent";
        default:
            return "Related";
    }
}

function statusLabel(status: string) {
    switch (status) {
        case "added":
            return "ADD";
        case "removed":
            return "DROP";
        case "renamed":
            return "RENAME";
        case "modified":
            return "EDIT";
        default:
            return null;
    }
}

function statusClass(status: string) {
    switch (status) {
        case "added":
            return "bg-emerald-500/10 ring-1 ring-emerald-500/20";
        case "removed":
            return "bg-red-500/10 ring-1 ring-red-500/20";
        case "renamed":
            return "bg-amber-500/10 ring-1 ring-amber-500/20";
        case "modified":
            return "bg-sky-500/10 ring-1 ring-sky-500/20";
        default:
            return "";
    }
}

function statusBadgeClass(status: string) {
    switch (status) {
        case "added":
            return "bg-emerald-500/15 text-emerald-100 border-emerald-500/30";
        case "removed":
            return "bg-red-500/15 text-red-100 border-red-500/30";
        case "renamed":
            return "bg-amber-500/15 text-amber-100 border-amber-500/30";
        case "modified":
            return "bg-sky-500/15 text-sky-100 border-sky-500/30";
        default:
            return "";
    }
}

function nodeTone(role: string) {
    switch (role) {
        case "current":
            return {
                border: "border-slate-400/35",
                header: "from-slate-500/20 via-slate-400/10 to-transparent",
                badge: "border-slate-400/35 bg-slate-500/10 text-slate-100",
            };
        case "proposed":
            return {
                border: "border-emerald-500/35 shadow-emerald-500/10",
                header: "from-emerald-500/20 via-emerald-400/8 to-transparent",
                badge: "border-emerald-500/35 bg-emerald-500/12 text-emerald-100",
            };
        case "dependency":
            return {
                border: "border-sky-500/25",
                header: "from-sky-500/16 via-sky-400/6 to-transparent",
                badge: "border-sky-500/30 bg-sky-500/10 text-sky-100",
            };
        case "dependent":
            return {
                border: "border-amber-500/28",
                header: "from-amber-500/18 via-amber-400/8 to-transparent",
                badge: "border-amber-500/32 bg-amber-500/10 text-amber-100",
            };
        default:
            return {
                border: "border-fuchsia-500/20",
                header: "from-fuchsia-500/18 via-fuchsia-400/8 to-transparent",
                badge: "border-fuchsia-500/28 bg-fuchsia-500/10 text-fuchsia-100",
            };
    }
}

function StatCard({
    label,
    value,
    hint,
    icon,
}: {
    label: string;
    value: string;
    hint?: string;
    icon?: ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border/50 bg-background/60 px-3 py-2.5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</p>
                {icon ? <span className="text-muted-foreground/60">{icon}</span> : null}
            </div>
            <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
            {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground/75">{hint}</p> : null}
        </div>
    );
}

function PreviewTableNode({ data }: NodeProps<PreviewGraphNodeData>) {
    const tone = nodeTone(data.node.role);
    const visibleColumns = data.node.columns.slice(0, MAX_VISIBLE_COLUMNS);
    const hiddenCount = Math.max(0, data.node.columns.length - visibleColumns.length);

    return (
        <div
            className={cn(
                "schema-card w-[320px] overflow-hidden border bg-card/95 shadow-xl backdrop-blur-sm",
                tone.border
            )}
        >
            <div
                className={cn(
                    "schema-card-header flex items-center justify-between gap-2 border-b border-border/40 bg-gradient-to-r px-3 py-2",
                    tone.header
                )}
            >
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                        {data.node.schema}.{data.node.table_name}
                    </p>
                    <p className="text-[11px] text-muted-foreground/75">
                        {formatCompactNumber(data.node.row_count)} rows
                    </p>
                </div>
                <span
                    className={cn(
                        "rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                        tone.badge
                    )}
                >
                    {roleLabel(data.node.role)}
                </span>
            </div>
            {data.node.note ? (
                <div className="border-b border-border/30 px-3 py-2 text-[11px] text-muted-foreground/80">
                    {data.node.note}
                </div>
            ) : null}
            <div className="p-2">
                {visibleColumns.map((column) => {
                    const changeTag = statusLabel(column.status);
                    return (
                        <div
                            key={`${data.node.id}:${column.name}`}
                            className={cn("schema-row rounded-md text-xs text-foreground", statusClass(column.status))}
                            title={column.detail ?? undefined}
                        >
                            <span
                                className={cn(
                                    "schema-badge",
                                    column.is_primary_key ? "schema-badge--pk" : changeTag ? "" : "schema-badge--empty",
                                    !column.is_primary_key && changeTag && statusBadgeClass(column.status)
                                )}
                            >
                                {column.is_primary_key ? "PK" : changeTag ?? "NA"}
                            </span>
                            <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="schema-col-name">{column.name}</span>
                                    {changeTag ? (
                                        <span
                                            className={cn(
                                                "hidden rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] md:inline-flex",
                                                statusBadgeClass(column.status)
                                            )}
                                        >
                                            {changeTag}
                                        </span>
                                    ) : null}
                                </div>
                                {column.detail ? (
                                    <p className="truncate text-[10px] text-muted-foreground/70">
                                        {column.detail}
                                    </p>
                                ) : null}
                            </div>
                            <span className="schema-col-type">{column.data_type}</span>
                        </div>
                    );
                })}
                {hiddenCount > 0 ? (
                    <div className="px-2 py-2 text-[11px] text-muted-foreground/65">
                        +{hiddenCount} more column{hiddenCount === 1 ? "" : "s"}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

const PREVIEW_NODE_TYPES = { previewTable: PreviewTableNode };
const PREVIEW_PRO_OPTIONS = { hideAttribution: true };

function buildGraph(preview: AlterTablePreview): { nodes: Node<PreviewGraphNodeData>[]; edges: Edge[] } {
    const currentNode = preview.nodes.find((node) => node.role === "current");
    const proposedNode = preview.nodes.find((node) => node.role === "proposed");
    const dependencyNodes = preview.nodes.filter((node) => node.role === "dependency");
    const dependentNodes = preview.nodes.filter((node) => node.role === "dependent");
    const relatedNodes = preview.nodes.filter((node) => node.role === "related");

    const focusX = GRAPH_NODE_WIDTH + GRAPH_CENTER_GAP;
    const dependencyX = -(GRAPH_NODE_WIDTH + GRAPH_SIDE_GAP);
    const dependentX = focusX + GRAPH_NODE_WIDTH + GRAPH_SIDE_GAP;
    const relatedStepX = GRAPH_NODE_WIDTH + GRAPH_RELATED_GAP;

    const positionedNodes: Node<PreviewGraphNodeData>[] = [];
    const positionColumn = (
        items: AlterTablePreviewNode[],
        x: number,
        centerY = 0
    ) => {
        const total = (items.length - 1) * GRAPH_ROW_STEP;
        items.forEach((node, index) => {
            positionedNodes.push({
                id: node.id,
                type: "previewTable",
                position: {
                    x,
                    y: centerY + index * GRAPH_ROW_STEP - total / 2,
                },
                draggable: false,
                selectable: false,
                data: { node },
            });
        });
    };

    if (currentNode) {
        positionedNodes.push({
            id: currentNode.id,
            type: "previewTable",
            position: { x: 0, y: 0 },
            draggable: false,
            selectable: false,
            data: { node: currentNode },
        });
    }

    if (proposedNode) {
        positionedNodes.push({
            id: proposedNode.id,
            type: "previewTable",
            position: { x: focusX, y: 0 },
            draggable: false,
            selectable: false,
            data: { node: proposedNode },
        });
    }

    positionColumn(dependencyNodes, dependencyX);
    positionColumn(dependentNodes, dependentX);
    if (relatedNodes.length > 0) {
        const totalWidth = (relatedNodes.length - 1) * relatedStepX;
        const startX = focusX / 2 - totalWidth / 2;
        relatedNodes.forEach((node, index) => {
            positionedNodes.push({
                id: node.id,
                type: "previewTable",
                position: {
                    x: startX + index * relatedStepX,
                    y: GRAPH_RELATED_ROW_Y,
                },
                draggable: false,
                selectable: false,
                data: { node },
            });
        });
    }

    const graphEdges: Edge[] = preview.edges.map((edge: AlterTablePreviewEdge) => {
        const isCurrent = edge.phase === "current";
        const impact = edge.impact;
        const stroke =
            impact === "added"
                ? "#10b981"
                : impact === "removed"
                    ? "#ef4444"
                    : impact === "changed"
                        ? "#f59e0b"
                        : isCurrent
                            ? "#64748b"
                            : "#38bdf8";

        return {
            id: edge.id,
            source: edge.from_node_id,
            target: edge.to_node_id,
            type: "smoothstep",
            animated: !isCurrent && impact !== "unchanged",
            selectable: false,
            markerEnd: {
                type: MarkerType.ArrowClosed,
                color: stroke,
            },
            label: impact === "unchanged" ? undefined : impact.toUpperCase(),
            labelStyle: {
                fill: "#e5e7eb",
                fontSize: 10,
                fontWeight: 700,
            },
            labelBgStyle: {
                fill: "rgba(10, 15, 27, 0.86)",
                stroke: "rgba(148, 163, 184, 0.28)",
                strokeWidth: 1,
            },
            style: {
                stroke,
                strokeWidth: impact === "unchanged" ? (isCurrent ? 1.8 : 2.1) : 2.7,
                strokeDasharray: isCurrent ? "7 4" : undefined,
                opacity: impact === "unchanged" ? (isCurrent ? 0.55 : 0.88) : 1,
            },
        };
    });

    return { nodes: positionedNodes, edges: graphEdges };
}

function RiskRow({ risk }: { risk: AlterTableRisk }) {
    const tone =
        risk.severity === "block"
            ? "border-red-500/30 bg-red-500/10"
            : risk.severity === "warn"
                ? "border-amber-500/30 bg-amber-500/10"
                : "border-border/40 bg-background/60";

    return (
        <div className={cn("rounded-xl border p-3", tone)}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-semibold text-foreground">{risk.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{risk.detail}</p>
                </div>
                <Badge
                    variant={risk.severity === "block" ? "destructive" : "outline"}
                    className="shrink-0 uppercase tracking-[0.18em]"
                >
                    {risk.severity}
                </Badge>
            </div>
            {risk.mitigation ? (
                <p className="mt-2 text-[11px] leading-5 text-foreground/80">
                    Mitigation: {risk.mitigation}
                </p>
            ) : null}
        </div>
    );
}

function AlternativeCard({
    alternative,
    recommended = false,
    onLoadAlternative,
    onCopyAlternative,
}: {
    alternative: AlterTableAlternative;
    recommended?: boolean;
    onLoadAlternative?: (sql: string) => void;
    onCopyAlternative?: (sql: string) => void;
}) {
    return (
        <div className="rounded-xl border border-border/40 bg-background/60 p-3">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{alternative.title}</p>
                        {recommended ? (
                            <Badge className="h-5 border-emerald-500/30 bg-emerald-500/12 px-2 text-[10px] text-emerald-100">
                                Recommended
                            </Badge>
                        ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{alternative.summary}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    {onCopyAlternative ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2.5 text-xs"
                            onClick={() => onCopyAlternative(alternative.sql)}
                        >
                            <Copy className="mr-1 h-3.5 w-3.5" />
                            Copy
                        </Button>
                    ) : null}
                    {onLoadAlternative ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => onLoadAlternative(alternative.sql)}
                        >
                            Load SQL
                        </Button>
                    ) : null}
                </div>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-foreground/80">{alternative.reason}</p>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-border/40 bg-black/30 p-3 text-[11px] leading-5 text-slate-200">
                <code>{alternative.sql}</code>
            </pre>
        </div>
    );
}

export function AlterTablePreviewDialog({
    open,
    onOpenChange,
    preview,
    isLoading,
    error,
    onLoadAlternative,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    preview: AlterTablePreview | null;
    isLoading: boolean;
    error: string | null;
    onLoadAlternative?: (sql: string) => void;
}) {
    const graph = useMemo(() => (preview ? buildGraph(preview) : { nodes: [], edges: [] }), [preview]);
    const confidence = useMemo(
        () => confidenceFromWarnings(preview?.warnings.length ?? 0),
        [preview]
    );
    const hasStatsWarning = useMemo(
        () => (preview ? preview.warnings.some((warning) => /statistic|analyze|estimate/i.test(warning)) : false),
        [preview]
    );
    const rowCountLabel = useMemo(() => {
        if (!preview) return "0";
        if (hasStatsWarning && preview.summary.row_count === 0) return "Unknown";
        return formatCompactNumber(preview.summary.row_count);
    }, [hasStatsWarning, preview]);
    const recommendedAlternative = preview?.alternatives[0] ?? null;

    const handleCopyAlternative = async (sql: string) => {
        const copied = await writeClipboardText(sql);
        if (copied) {
            toast.success("Alternative SQL copied to clipboard.", { duration: 1600 });
            return;
        }
        toast.error("Could not copy SQL. Please copy manually.");
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
             <DialogContent
                showCloseButton={false}
                className="h-[90vh] max-h-[92vh] w-full max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border-border/50 bg-background/95 p-0 shadow-2xl backdrop-blur-xl"
            >
                <div className="border-b border-border/40 bg-gradient-to-br from-background via-background to-muted/30 px-6 py-5">
                    <DialogHeader className="gap-3">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                                <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
                                    <GitBranch className="h-4 w-4 text-emerald-300" />
                                    ALTER TABLE Impact Preview
                                </DialogTitle>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {preview
                                        ? `${preview.focus_schema}.${preview.focus_table} → ${preview.focus_schema_after}.${preview.focus_table_after}`
                                        : "Live dependency preview, risk assessment, and safer migration alternatives."}
                                </p>
                            </div>
                            {preview ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge
                                        variant={riskBadgeVariant(preview.summary.risk_level)}
                                        className={cn("capitalize", riskBadgeClass(preview.summary.risk_level))}
                                    >
                                        {preview.summary.risk_level} risk
                                    </Badge>
                                    <Badge variant="outline" className="border-border/40 bg-background/70">
                                        Score {preview.summary.risk_score}
                                    </Badge>
                                    <Badge variant="outline" className={cn("border", confidence.className)}>
                                        {confidence.label}
                                    </Badge>
                                    {preview.warnings.length > 0 ? (
                                        <Badge variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-100">
                                            {preview.warnings.length} note{preview.warnings.length === 1 ? "" : "s"}
                                        </Badge>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </DialogHeader>
                    {preview ? (
                        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                            <StatCard
                                label="Rows"
                                value={rowCountLabel}
                                hint={hasStatsWarning ? "Estimated (run ANALYZE for fresher stats)" : "Estimated row count"}
                                icon={<Rows3 className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Ops"
                                value={String(preview.summary.operation_count)}
                                hint="Detected ALTER steps"
                                icon={<GitBranch className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Incoming"
                                value={String(preview.summary.incoming_relations)}
                                hint="References into table"
                                icon={<Network className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Outgoing"
                                value={String(preview.summary.outgoing_relations)}
                                hint="References from table"
                                icon={<Network className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Indexes"
                                value={String(preview.summary.index_count)}
                                hint="Existing indexes"
                                icon={<Table2 className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Table Size"
                                value={preview.summary.table_size}
                                hint="Relation storage"
                                icon={<Database className="h-3.5 w-3.5" />}
                            />
                            <StatCard
                                label="Total Size"
                                value={preview.summary.total_size}
                                hint="Table + indexes"
                                icon={<Database className="h-3.5 w-3.5" />}
                            />
                        </div>
                    ) : null}
                </div>

                <div className="min-h-0 flex-1">
                    {isLoading ? (
                        <div className="flex h-full items-center justify-center">
                            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                                <Loader2 className="h-8 w-8 animate-spin text-emerald-300" />
                                Building preview, assessing risk, and projecting relationships…
                            </div>
                        </div>
                    ) : error ? (
                        <div className="p-5">
                            <Alert variant="destructive">
                                <AlertTriangle className="h-4 w-4" />
                                <AlertTitle>Preview unavailable</AlertTitle>
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        </div>
                    ) : preview ? (
                        <div className="grid h-full min-h-0 gap-4 p-4 xl:grid-cols-[minmax(0,2.1fr)_minmax(460px,1fr)]">
                            <Card className="flex min-h-0 flex-col gap-0 overflow-hidden border-border/40 py-0">
                                <div className="flex flex-col gap-3 border-b border-border/40 px-4 py-3 md:flex-row md:items-end md:justify-between">
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">Dependency Graph</p>
                                        <p className="text-xs text-muted-foreground">
                                            Dashed edges are current relationships. Solid edges represent the projected post-migration shape.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                        <span className="inline-flex items-center gap-1">
                                            <span className="h-2 w-5 rounded-full bg-slate-400/70" />
                                            Current
                                        </span>
                                        <span className="inline-flex items-center gap-1">
                                            <span className="h-2 w-5 rounded-full bg-sky-400" />
                                            Projected
                                        </span>
                                        <span className="inline-flex items-center gap-1">
                                            <span className="h-2 w-5 rounded-full bg-emerald-400" />
                                            Added
                                        </span>
                                        <span className="inline-flex items-center gap-1">
                                            <span className="h-2 w-5 rounded-full bg-red-400" />
                                            Removed
                                        </span>
                                        <span className="inline-flex items-center gap-1">
                                            <span className="h-2 w-5 rounded-full bg-amber-400" />
                                            Changed
                                        </span>
                                    </div>
                                </div>
                                <div className="schema-flow min-h-[420px] flex-1">
                                    <ReactFlow
                                        nodes={graph.nodes}
                                        edges={graph.edges}
                                        fitView
                                        fitViewOptions={{ padding: 0.18 }}
                                        proOptions={PREVIEW_PRO_OPTIONS}
                                        nodeTypes={PREVIEW_NODE_TYPES}
                                        nodesDraggable={false}
                                        nodesConnectable={false}
                                        elementsSelectable={false}
                                        nodesFocusable={false}
                                        edgesFocusable={false}
                                        onlyRenderVisibleElements
                                        minZoom={0.38}
                                        maxZoom={1.5}
                                    >
                                        <Background gap={20} color="rgba(148, 163, 184, 0.1)" />
                                        <Controls showInteractive={false} />
                                    </ReactFlow>
                                </div>
                            </Card>

                            <Tabs defaultValue="changes" className="flex min-h-0 flex-col">
                                <TabsList className="grid w-full grid-cols-3 rounded-xl border border-border/40 bg-muted/35 p-1">
                                    <TabsTrigger value="changes" className="rounded-lg text-xs data-[state=active]:bg-background">
                                        Changes
                                    </TabsTrigger>
                                    <TabsTrigger value="risks" className="rounded-lg text-xs data-[state=active]:bg-background">
                                        Risks
                                    </TabsTrigger>
                                    <TabsTrigger value="alternatives" className="rounded-lg text-xs data-[state=active]:bg-background">
                                        Alternatives
                                    </TabsTrigger>
                                </TabsList>

                                <TabsContent value="changes" className="mt-3 flex-1 overflow-hidden">
                                    <Card className="h-full gap-0 border-border/40 py-0">
                                        <CardContent className="h-full p-0">
                                            <ScrollArea className="h-full">
                                                <div className="space-y-3 p-4">
                                                    {preview.changes.length === 0 ? (
                                                        <p className="text-sm text-muted-foreground">No parsed ALTER operations were detected.</p>
                                                    ) : null}
                                                    {preview.changes.map((change) => (
                                                        <div
                                                            key={`${change.kind}:${change.title}`}
                                                            className="rounded-xl border border-border/40 bg-background/60 p-3"
                                                        >
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div>
                                                                    <p className="text-sm font-semibold text-foreground">{change.title}</p>
                                                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                                        {change.detail}
                                                                    </p>
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    {change.destructive ? (
                                                                        <Badge variant="destructive">Destructive</Badge>
                                                                    ) : null}
                                                                    {change.impacts_data ? (
                                                                        <Badge variant="outline">Data impact</Badge>
                                                                    ) : null}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        </CardContent>
                                    </Card>
                                </TabsContent>

                                <TabsContent value="risks" className="mt-3 flex-1 overflow-hidden">
                                    <Card className="h-full gap-0 border-border/40 py-0">
                                        <CardContent className="h-full p-0">
                                            <ScrollArea className="h-full">
                                                <div className="space-y-3 p-4">
                                                    {preview.risks.map((risk) => (
                                                        <RiskRow key={`${risk.severity}:${risk.title}`} risk={risk} />
                                                    ))}
                                                    {preview.warnings.length > 0 ? (
                                                        <Alert className="border-amber-500/25 bg-amber-500/10">
                                                            <ShieldAlert className="h-4 w-4 text-amber-200" />
                                                            <AlertTitle>Preview notes</AlertTitle>
                                                            <AlertDescription>
                                                                {preview.warnings.join(" ")}
                                                            </AlertDescription>
                                                        </Alert>
                                                    ) : null}
                                                </div>
                                            </ScrollArea>
                                        </CardContent>
                                    </Card>
                                </TabsContent>

                                <TabsContent value="alternatives" className="mt-3 flex-1 overflow-hidden">
                                    <Card className="h-full gap-0 border-border/40 py-0">
                                        <CardContent className="h-full p-0">
                                            <ScrollArea className="h-full">
                                                <div className="space-y-3 p-4">
                                                    {preview.alternatives.length === 0 ? (
                                                        <p className="text-sm text-muted-foreground">No safer alternatives available for this statement.</p>
                                                    ) : null}
                                                    {preview.alternatives.map((alternative, index) => (
                                                        <AlternativeCard
                                                            key={alternative.title}
                                                            alternative={alternative}
                                                            recommended={index === 0}
                                                            onLoadAlternative={onLoadAlternative}
                                                            onCopyAlternative={handleCopyAlternative}
                                                        />
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        </CardContent>
                                    </Card>
                                </TabsContent>
                            </Tabs>
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center p-5">
                            <div className="max-w-sm text-center">
                                <ArrowRightLeft className="mx-auto h-8 w-8 text-muted-foreground/50" />
                                <p className="mt-3 text-sm font-medium text-foreground">No preview loaded</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Put the cursor inside an `ALTER TABLE` statement in the Monaco editor, then open the preview button.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between border-t border-border/40 px-5 py-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
                        Rust-generated preview + migration risk engine
                    </div>
                    <div className="flex items-center gap-2">
                        {recommendedAlternative && onLoadAlternative ? (
                            <Button
                                size="sm"
                                onClick={() => onLoadAlternative(recommendedAlternative.sql)}
                                className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
                            >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Use Recommended SQL
                            </Button>
                        ) : null}
                        <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                            Close
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
