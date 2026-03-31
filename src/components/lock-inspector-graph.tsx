"use client";

import { memo, useEffect, useMemo } from "react";
import ReactFlow, {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MarkerType,
    MiniMap,
    NodeProps,
    NodeTypes,
    Position,
    ReactFlowProvider,
    useEdgesState,
    useNodesState,
    useReactFlow,
    type Edge,
    type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { cn } from "@/lib/utils";
import type { LockWaitEdge } from "@/lib/types";

function computeLevels(edges: LockWaitEdge[]): Map<number, number> {
    const pids = new Set<number>();
    for (const e of edges) {
        pids.add(e.blocked_pid);
        pids.add(e.blocking_pid);
    }
    const level = new Map<number, number>();
    for (const p of pids) level.set(p, 0);
    const maxIter = Math.max(pids.size + 2, 8);
    for (let i = 0; i < maxIter; i++) {
        let changed = false;
        for (const e of edges) {
            const b = e.blocking_pid;
            const d = e.blocked_pid;
            const nv = (level.get(b) ?? 0) + 1;
            if (nv > (level.get(d) ?? 0)) {
                level.set(d, nv);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return level;
}

function buildNodeData(pid: number, edges: LockWaitEdge[]) {
    const asBlocked = edges.find((e) => e.blocked_pid === pid);
    const asBlocking = edges.find((e) => e.blocking_pid === pid);
    const user = asBlocked?.blocked_usename ?? asBlocking?.blocking_usename ?? null;
    const state = asBlocked?.blocked_state ?? asBlocking?.blocking_state ?? null;
    const rawQ = asBlocked?.blocked_query ?? asBlocking?.blocking_query;
    const snippet = (rawQ ?? "").replace(/\s+/g, " ").trim();
    const variant =
        asBlocked && asBlocking ? "both" : asBlocked ? "blocked" : asBlocking ? "blocker" : "both";
    return { pid, user, state, snippet, variant };
}

function buildLockFlowGraph(edges: LockWaitEdge[]): { nodes: Node[]; edges: Edge[] } {
    if (edges.length === 0) return { nodes: [], edges: [] };

    const pids = new Set<number>();
    for (const e of edges) {
        pids.add(e.blocked_pid);
        pids.add(e.blocking_pid);
    }

    const level = computeLevels(edges);
    const byLevel = new Map<number, number[]>();
    for (const pid of pids) {
        const lv = level.get(pid) ?? 0;
        if (!byLevel.has(lv)) byLevel.set(lv, []);
        byLevel.get(lv)!.push(pid);
    }
    for (const arr of byLevel.values()) arr.sort((a, b) => a - b);

    const COL = 260;
    const ROW_H = 108;
    const nodes: Node[] = [];
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    for (const lv of sortedLevels) {
        const row = byLevel.get(lv)!;
        row.forEach((pid, i) => {
            nodes.push({
                id: `p-${pid}`,
                type: "lockPid",
                position: { x: lv * COL, y: i * ROW_H },
                data: buildNodeData(pid, edges),
            });
        });
    }

    const flowEdges: Edge[] = edges.map((e, i) => ({
        id: `e-${i}-${e.blocking_pid}-${e.blocked_pid}`,
        source: `p-${e.blocking_pid}`,
        target: `p-${e.blocked_pid}`,
        label: `${e.locktype}`,
        type: "smoothstep",
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: { stroke: "hsl(var(--border))", strokeWidth: 1.5 },
        labelStyle: { fontSize: 9, fontWeight: 600 },
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.95 },
    }));

    return { nodes, edges: flowEdges };
}

type LockPidData = {
    pid: number;
    user: string | null;
    state: string | null;
    snippet: string;
    variant: "blocked" | "blocker" | "both";
};

const LockPidNode = memo(function LockPidNode({ data }: NodeProps<LockPidData>) {
    const border =
        data.variant === "blocked"
            ? "border-orange-500/50 shadow-orange-500/10"
            : data.variant === "blocker"
              ? "border-emerald-500/45 shadow-emerald-500/10"
              : "border-violet-500/45 shadow-violet-500/10";

    return (
        <>
            <Handle
                type="target"
                position={Position.Left}
                className="!h-2 !w-2 !border-0 !bg-orange-400"
            />
            <div
                className={cn(
                    "min-w-[158px] max-w-[200px] rounded-xl border-2 bg-card/95 px-3 py-2 shadow-md backdrop-blur-sm",
                    border
                )}
            >
                <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Backend PID
                </div>
                <div className="font-mono text-base font-bold tabular-nums leading-tight">{data.pid}</div>
                {data.user ? (
                    <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                        {data.user}
                    </div>
                ) : null}
                {data.state ? (
                    <div className="mt-0.5 truncate text-[10px] text-amber-600/90 dark:text-amber-400/90">
                        {data.state}
                    </div>
                ) : null}
                {data.snippet ? (
                    <div
                        className="mt-1 line-clamp-2 font-mono text-[9px] leading-snug text-muted-foreground/80"
                        title={data.snippet}
                    >
                        {data.snippet}
                    </div>
                ) : null}
            </div>
            <Handle
                type="source"
                position={Position.Right}
                className="!h-2 !w-2 !border-0 !bg-emerald-400"
            />
        </>
    );
});

const nodeTypes: NodeTypes = { lockPid: LockPidNode };

function FitViewOnChange({ sig }: { sig: string }) {
    const { fitView } = useReactFlow();
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            fitView({ padding: 0.18, duration: 220 });
        });
        return () => cancelAnimationFrame(id);
    }, [sig, fitView]);
    return null;
}

function LockWaitGraphInner({ edges }: { edges: LockWaitEdge[] }) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

    useEffect(() => {
        const built = buildLockFlowGraph(edges);
        setNodes(built.nodes);
        setRfEdges(built.edges);
    }, [edges, setNodes, setRfEdges]);

    const sig = useMemo(
        () => `${edges.length}:${edges.map((e) => `${e.blocking_pid}-${e.blocked_pid}`).join("|")}`,
        [edges]
    );

    if (edges.length === 0) {
        return (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-border/40 bg-muted/10 px-6 text-center">
                <p className="text-sm font-medium text-foreground/80">No lock waits</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    No sessions are waiting on another backend&apos;s lock right now. When blocking
                    occurs, the graph will show holder → waiter relationships from{" "}
                    <span className="font-mono">pg_locks</span>.
                </p>
            </div>
        );
    }

    return (
        <div className="h-[min(52vh,560px)] min-h-[360px] w-full rounded-xl border border-border/30 bg-muted/5">
            <ReactFlow
                nodes={nodes}
                edges={rfEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                className="rounded-xl"
            >
                <Background variant={BackgroundVariant.Dots} gap={16} size={0.6} />
                <Controls className="!border-border/40 !bg-card/90 !shadow-md" />
                <MiniMap
                    className="!border-border/40 !bg-card/80"
                    nodeStrokeWidth={2}
                    zoomable
                    pannable
                />
                <FitViewOnChange sig={sig} />
            </ReactFlow>
        </div>
    );
}

export function LockWaitGraphView({ edges }: { edges: LockWaitEdge[] }) {
    return (
        <ReactFlowProvider>
            <LockWaitGraphInner edges={edges} />
        </ReactFlowProvider>
    );
}
