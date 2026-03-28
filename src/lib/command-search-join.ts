"use client";

import type { FilterCondition, TopologyData, TopologyEdge } from "@/lib/types";

const MAX_HOPS = 8;

const VALID_OPS = new Set([
    "=",
    "!=",
    "<>",
    ">",
    "<",
    ">=",
    "<=",
    "LIKE",
    "NOT LIKE",
    "ILIKE",
    "NOT ILIKE",
    "IS NULL",
    "IS NOT NULL",
]); // keep aligned with `search_table_data_multi` in `src-tauri/src/db/queries.rs`

function qIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
}

function qTable(schema: string, table: string): string {
    return `${qIdent(schema)}.${qIdent(table)}`;
}

export type TopologyNodeRef = { schema: string; table: string };

function nodeKey(n: TopologyNodeRef): string {
    return `${n.schema}\0${n.table}`;
}

function findNodeExact(topology: TopologyData, schema: string, table: string): TopologyNodeRef | null {
    const n = topology.nodes.find(
        (x) => x.schema === schema && x.table_name.toLowerCase() === table.toLowerCase()
    );
    return n ? { schema: n.schema, table: n.table_name } : null;
}

/** Resolve `trips` or `public.trips` against topology nodes. */
export function resolveTargetNode(
    topology: TopologyData,
    targetToken: string,
    preferSchema: string
): TopologyNodeRef | null {
    const t = targetToken.trim();
    if (!t) return null;
    const dot = t.indexOf(".");
    if (dot !== -1) {
        const schema = t.slice(0, dot);
        const table = t.slice(dot + 1);
        return findNodeExact(topology, schema, table);
    }
    const inPreferred = findNodeExact(topology, preferSchema, t);
    if (inPreferred) return inPreferred;
    const hit = topology.nodes.find((n) => n.table_name.toLowerCase() === t.toLowerCase());
    return hit ? { schema: hit.schema, table: hit.table_name } : null;
}

function neighbors(
    topology: TopologyData,
    node: TopologyNodeRef
): Array<{ edge: TopologyEdge; other: TopologyNodeRef }> {
    const out: Array<{ edge: TopologyEdge; other: TopologyNodeRef }> = [];
    const k = nodeKey(node);
    for (const e of topology.edges) {
        const from: TopologyNodeRef = { schema: e.from_schema, table: e.from_table };
        const to: TopologyNodeRef = { schema: e.to_schema, table: e.to_table };
        if (nodeKey(from) === k) out.push({ edge: e, other: to });
        else if (nodeKey(to) === k) out.push({ edge: e, other: from });
    }
    return out;
}

/** Shortest FK path as ordered edges from `from` to `to` (empty if same table). */
export function findJoinPath(
    topology: TopologyData,
    from: TopologyNodeRef,
    to: TopologyNodeRef
): TopologyEdge[] | null {
    if (nodeKey(from) === nodeKey(to)) return [];

    const visited = new Set<string>([nodeKey(from)]);
    const queue: TopologyNodeRef[] = [from];
    const parent = new Map<string, { prev: TopologyNodeRef; edge: TopologyEdge }>();

    let hops = 0;
    while (queue.length && hops <= MAX_HOPS) {
        const levelCount = queue.length;
        hops += 1;
        for (let i = 0; i < levelCount; i += 1) {
            const cur = queue.shift()!;
            for (const { edge, other } of neighbors(topology, cur)) {
                const ok = nodeKey(other);
                if (visited.has(ok)) continue;
                visited.add(ok);
                parent.set(ok, { prev: cur, edge });
                if (ok === nodeKey(to)) {
                    const edges: TopologyEdge[] = [];
                    let ptr: TopologyNodeRef = other;
                    while (nodeKey(ptr) !== nodeKey(from)) {
                        const p = parent.get(nodeKey(ptr));
                        if (!p) return null;
                        edges.push(p.edge);
                        ptr = p.prev;
                    }
                    edges.reverse();
                    return edges;
                }
                queue.push(other);
            }
        }
    }
    return null;
}

function validateConditionsForTable(
    topology: TopologyData,
    base: TopologyNodeRef,
    conditions: FilterCondition[]
): string | null {
    const node = topology.nodes.find(
        (n) => n.schema === base.schema && n.table_name === base.table
    );
    if (!node) return `Table ${base.schema}.${base.table} not in topology`;
    const colSet = new Set(node.columns.map((c) => c.name.toLowerCase()));
    for (const c of conditions) {
        if (!colSet.has(c.column.toLowerCase())) {
            return `Column "${c.column}" is not on ${base.schema}.${base.table}`;
        }
        const op = c.operator.toUpperCase().trim();
        if (!VALID_OPS.has(op)) {
            return `Unsupported operator "${c.operator}" for join search`;
        }
    }
    return null;
}

function whereClauseWithAlias(baseAlias: string, conditions: FilterCondition[]): string {
    const parts: string[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
        const c = conditions[i];
        const col = qIdent(c.column);
        const opU = c.operator.toUpperCase().trim();
        const pred =
            opU === "IS NULL" || opU === "IS NOT NULL"
                ? `${baseAlias}.${col} ${c.operator}`
                : `${baseAlias}.${col} ${c.operator} '${(c.value ?? "").replace(/'/g, "''")}'`;
        if (i === 0) {
            parts.push(pred);
        } else {
            const join = (c.logical_op || "AND").toUpperCase() === "OR" ? "OR" : "AND";
            parts.push(`${join} ${pred}`);
        }
    }
    return parts.join(" ");
}

/**
 * SELECT target.* FROM base … JOINs … WHERE base predicates LIMIT 200
 */
export function buildJoinSearchSQL(
    topology: TopologyData,
    baseSchema: string,
    baseTable: string,
    conditions: FilterCondition[],
    targetToken: string
): { sql: string } | { error: string } {
    const base: TopologyNodeRef | null = findNodeExact(topology, baseSchema, baseTable);
    if (!base) {
        return { error: `Unknown table ${baseSchema}.${baseTable} in schema graph` };
    }

    const target = resolveTargetNode(topology, targetToken, base.schema);
    if (!target) {
        return { error: `Could not resolve table "${targetToken}"` };
    }

    const condErr = validateConditionsForTable(topology, base, conditions);
    if (condErr) return { error: condErr };

    const path = findJoinPath(topology, base, target);
    if (path === null) {
        return {
            error: `No foreign-key path (≤${MAX_HOPS} hops) from ${base.table} to ${target.table}`,
        };
    }

    const aliasByNode = new Map<string, string>();
    let aliasIdx = 0;
    function aliasFor(n: TopologyNodeRef): string {
        const k = nodeKey(n);
        let a = aliasByNode.get(k);
        if (!a) {
            a = `t${aliasIdx}`;
            aliasIdx += 1;
            aliasByNode.set(k, a);
        }
        return a;
    }

    const baseAlias = aliasFor(base);
    const joinParts: string[] = [];
    let current = base;
    let currentAlias = baseAlias;

    for (const edge of path) {
        const from: TopologyNodeRef = { schema: edge.from_schema, table: edge.from_table };
        const to: TopologyNodeRef = { schema: edge.to_schema, table: edge.to_table };
        const fromMatch = nodeKey(from) === nodeKey(current);
        const next = fromMatch ? to : from;
        const nextAlias = aliasFor(next);

        if (fromMatch) {
            joinParts.push(
                `JOIN ${qTable(to.schema, to.table)} AS ${nextAlias} ON ${currentAlias}.${qIdent(edge.from_column)} = ${nextAlias}.${qIdent(edge.to_column)}`
            );
        } else {
            joinParts.push(
                `JOIN ${qTable(from.schema, from.table)} AS ${nextAlias} ON ${currentAlias}.${qIdent(edge.to_column)} = ${nextAlias}.${qIdent(edge.from_column)}`
            );
        }
        current = next;
        currentAlias = nextAlias;
    }

    const targetAlias = aliasFor(target);
    const whereSql =
        conditions.length > 0 ? whereClauseWithAlias(baseAlias, conditions) : "TRUE";
    const joinSql = joinParts.length ? ` ${joinParts.join(" ")}` : "";
    const sql = `SELECT ${targetAlias}.* FROM ${qTable(base.schema, base.table)} AS ${baseAlias}${joinSql} WHERE ${whereSql} LIMIT 200`;

    return { sql };
}

/** Compact FK lines for AI prompts (cap edges). */
export function topologyToFkSummary(topology: TopologyData, maxEdges: number): string {
    const lines: string[] = [];
    for (let i = 0; i < topology.edges.length && i < maxEdges; i += 1) {
        const e = topology.edges[i];
        lines.push(
            `${e.from_table}.${e.from_column} -> ${e.to_table}.${e.to_column}`
        );
    }
    if (topology.edges.length > maxEdges) {
        lines.push(`… (+${topology.edges.length - maxEdges} more)`);
    }
    return lines.length ? lines.join("\n") : "";
}
