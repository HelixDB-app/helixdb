/** PostgreSQL EXPLAIN (FORMAT JSON) plan shapes — shared by viewer, flame graph, and AI helpers. */

export interface PlanNode {
    "Node Type": string;
    "Startup Cost": number;
    "Total Cost": number;
    "Plan Rows": number;
    "Plan Width": number;
    "Actual Startup Time"?: number;
    "Actual Total Time"?: number;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    "Relation Name"?: string;
    "Schema"?: string;
    "Alias"?: string;
    "Index Name"?: string;
    "Index Cond"?: string;
    "Filter"?: string;
    "Recheck Cond"?: string;
    "Join Type"?: string;
    "Hash Cond"?: string;
    "Merge Cond"?: string;
    "Sort Key"?: string[];
    "Sort Method"?: string;
    "Rows Removed by Filter"?: number;
    "Rows Removed by Recheck"?: number;
    "Shared Hit Blocks"?: number;
    "Shared Read Blocks"?: number;
    "Local Hit Blocks"?: number;
    "Local Read Blocks"?: number;
    "Temp Read Blocks"?: number;
    "Temp Written Blocks"?: number;
    "Parent Relationship"?: string;
    "Parallel Aware"?: boolean;
    "Workers Planned"?: number;
    "Workers Launched"?: number;
    Plans?: PlanNode[];
}

export interface ExplainOutput {
    Plan: PlanNode;
    "Planning Time"?: number;
    "Execution Time"?: number;
}

export function parseExplainJson(raw: string): ExplainOutput | null {
    try {
        const parsed = JSON.parse(raw);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first && typeof first === "object" && "Plan" in first) return first as ExplainOutput;
        return null;
    } catch {
        return null;
    }
}

export function nodeTime(n: PlanNode): number {
    return (n["Actual Total Time"] ?? 0) * (n["Actual Loops"] ?? 1);
}

export function selfTime(n: PlanNode): number {
    const childSum = (n.Plans ?? []).reduce((s, c) => s + nodeTime(c), 0);
    return Math.max(0, nodeTime(n) - childSum);
}
