import type { ExplainOutput, PlanNode } from "@/lib/query-plan-types";
import { nodeTime, selfTime } from "@/lib/query-plan-types";

export interface PlanHierarchyNode {
    pathId: string;
    plan: PlanNode;
    children: PlanHierarchyNode[];
    /** Weight used to split horizontal space among siblings (time ms or planner cost). */
    layoutWeight: number;
    /** True when ANALYZE timings are absent and planner cost drives layout. */
    useCostFallback: boolean;
    inclusiveMs: number;
    selfMs: number;
    /** Symmetric max(actual/plan, plan/actual); null when not comparable. */
    rowSkew: number | null;
}

export interface FlameRect {
    pathId: string;
    plan: PlanNode;
    x: number;
    y: number;
    w: number;
    h: number;
    depth: number;
    /** Share of total execution time (or cost at root if no ANALYZE), 0–100. */
    pctOfTotal: number;
    rowSkew: number | null;
    useCostFallback: boolean;
}

function planRootUsesCostOnly(root: PlanNode): boolean {
    return root["Actual Total Time"] === undefined;
}

/** Row estimate skew for coloring; null if ANALYZE rows missing or plan rows invalid. */
export function rowSkewMetric(n: PlanNode): number | null {
    const planned = n["Plan Rows"] ?? 0;
    const actual = n["Actual Rows"];
    if (actual === undefined || planned <= 0) return null;
    return Math.min(100, Math.max(actual / planned, planned / actual));
}

function layoutWeightForNode(n: PlanNode, costFallback: boolean): number {
    if (!costFallback) {
        return Math.max(nodeTime(n), 1e-6);
    }
    return Math.max(n["Total Cost"] ?? 0, 1e-6);
}

function buildNode(
    n: PlanNode,
    path: string,
    costFallback: boolean
): PlanHierarchyNode {
    const childrenRaw = n.Plans ?? [];
    const children = childrenRaw.map((c, i) =>
        buildNode(c, `${path}-${i}`, costFallback)
    );
    return {
        pathId: path,
        plan: n,
        children,
        layoutWeight: layoutWeightForNode(n, costFallback),
        useCostFallback: costFallback,
        inclusiveMs: nodeTime(n),
        selfMs: selfTime(n),
        rowSkew: rowSkewMetric(n),
    };
}

export function buildPlanHierarchy(plan: ExplainOutput): PlanHierarchyNode {
    const costFallback = planRootUsesCostOnly(plan.Plan);
    return buildNode(plan.Plan, "0", costFallback);
}

export function totalExecutionMs(plan: ExplainOutput): number {
    return plan["Execution Time"] ?? nodeTime(plan.Plan);
}

function collectNodes(root: PlanHierarchyNode, out: PlanHierarchyNode[] = []): PlanHierarchyNode[] {
    out.push(root);
    for (const c of root.children) collectNodes(c, out);
    return out;
}

/** Top nodes by inclusive actual time (or by layout weight when cost-only). */
export function topHotspotNodes(root: PlanHierarchyNode, limit = 3): PlanHierarchyNode[] {
    const all = collectNodes(root, []);
    const score = (n: PlanHierarchyNode) =>
        n.useCostFallback ? n.layoutWeight : n.inclusiveMs;
    return [...all]
        .sort((a, b) => {
            const d = score(b) - score(a);
            if (d !== 0) return d;
            return a.pathId.localeCompare(b.pathId, undefined, { numeric: true });
        })
        .slice(0, limit);
}

const MIN_RECT_W = 2;

export function computeFlameLayout(
    root: PlanHierarchyNode,
    totalMs: number,
    width: number,
    rowHeight: number
): { rects: FlameRect[]; totalHeight: number } {
    const rects: FlameRect[] = [];
    let maxDepth = 0;

    function pct(n: PlanHierarchyNode): number {
        const t = totalMs > 0 ? totalMs : 1;
        if (n.useCostFallback) {
            const rootCost = root.layoutWeight;
            return rootCost > 0 ? (n.layoutWeight / rootCost) * 100 : 0;
        }
        return (n.inclusiveMs / t) * 100;
    }

    function walk(n: PlanHierarchyNode, x: number, y: number, w: number, depth: number) {
        maxDepth = Math.max(maxDepth, depth);
        const effW = Math.max(w, MIN_RECT_W);
        rects.push({
            pathId: n.pathId,
            plan: n.plan,
            x,
            y,
            w: effW,
            h: rowHeight,
            depth,
            pctOfTotal: pct(n),
            rowSkew: n.rowSkew,
            useCostFallback: n.useCostFallback,
        });

        const ch = n.children;
        if (ch.length === 0) return;

        let weights = ch.map((c) => Math.max(c.layoutWeight, 1e-9));
        let sum = weights.reduce((a, b) => a + b, 0);
        if (sum <= 0) {
            weights = ch.map(() => 1);
            sum = weights.length;
        }

        // If sibling weights exceed parent weight (parallel / gather quirks), scale down so they fit the row.
        const parentW = n.layoutWeight;
        if (!n.useCostFallback && parentW > 0) {
            const childSum = weights.reduce((a, b) => a + b, 0);
            if (childSum > parentW * 1.02) {
                const scale = parentW / childSum;
                weights = weights.map((wgt) => wgt * scale);
                sum = weights.reduce((a, b) => a + b, 0);
            }
        }

        let cx = x;
        const innerW = Math.max(effW, MIN_RECT_W);
        for (let i = 0; i < ch.length; i++) {
            const cw = sum > 0 ? innerW * (weights[i]! / sum) : innerW / ch.length;
            walk(ch[i]!, cx, y + rowHeight, cw, depth + 1);
            cx += cw;
        }
    }

    walk(root, 0, 0, Math.max(width, MIN_RECT_W), 0);
    return {
        rects,
        totalHeight: rowHeight * (maxDepth + 1),
    };
}

export interface HotspotAiPayload {
    pathId: string;
    nodeType: string;
    relation?: string;
    inclusiveMs: number;
    selfMs: number;
    planRows: number;
    actualRows?: number;
    filter?: string;
    indexName?: string;
    sharedRead?: number;
    sharedHit?: number;
    tempWritten?: number;
}

export function hotspotToAiPayload(n: PlanHierarchyNode): HotspotAiPayload {
    const p = n.plan;
    return {
        pathId: n.pathId,
        nodeType: p["Node Type"] ?? "",
        relation: p["Relation Name"] ?? p["Alias"],
        inclusiveMs: n.inclusiveMs,
        selfMs: n.selfMs,
        planRows: p["Plan Rows"] ?? 0,
        actualRows: p["Actual Rows"],
        filter: p["Filter"] ?? p["Index Cond"],
        indexName: p["Index Name"],
        sharedRead: p["Shared Read Blocks"],
        sharedHit: p["Shared Hit Blocks"],
        tempWritten: p["Temp Written Blocks"],
    };
}

export function buildHotspotsAiJsonBlob(nodes: PlanHierarchyNode[]): string {
    return JSON.stringify(nodes.map(hotspotToAiPayload), null, 0);
}
