"use client";

import type { FilterCondition, TableInfo } from "@/lib/types";

export interface CommandSearchOperator {
    label: string;
    description: string;
    noValue?: boolean;
}

export const COMMAND_SEARCH_OPERATORS: CommandSearchOperator[] = [
    { label: "=", description: "Equals" },
    { label: "!=", description: "Not equals" },
    { label: ">", description: "Greater than" },
    { label: "<", description: "Less than" },
    { label: ">=", description: "Greater or equal" },
    { label: "<=", description: "Less than or equal" },
    { label: "LIKE", description: "Pattern match - use % as wildcard" },
    { label: "NOT LIKE", description: "Inverse pattern match" },
    { label: "ILIKE", description: "Case-insensitive pattern match" },
    { label: "IS NULL", description: "Value is null", noValue: true },
    { label: "IS NOT NULL", description: "Value is not null", noValue: true },
];

export type CommandSearchStage =
    | { type: "init" }
    | { type: "table"; filter: string }
    | { type: "column"; schema: string; table: string; filter: string }
    | { type: "operator"; schema: string; table: string; col: string; opFilter: string }
    | { type: "value"; schema: string; table: string; col: string; op: string; value: string }
    | { type: "multi_value"; schema: string; table: string; conditions: FilterCondition[] }
    | {
          type: "multi_build";
          schema: string;
          table: string;
          prior: FilterCondition[];
          tailRest: string;
      }
    | {
          type: "join_value";
          schema: string;
          table: string;
          conditions: FilterCondition[];
          targetTable: string;
      }
    | {
          type: "join_build";
          schema: string;
          table: string;
          prior: FilterCondition[];
          tailRest: string;
          targetTable: string;
      }
    | { type: "raw_sql"; sql: string }
    | { type: "ai_nl"; query: string };

const SQL_KEYWORDS = [
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
    "CREATE", "DROP", "ALTER", "EXPLAIN", "TABLE", "SHOW",
];

const JOIN_ARROW = /\s+=>\s+/i;

function schemaMatchesCatalog(schema: string, t: TableInfo): boolean {
    return t.schema === schema || t.schema.toLowerCase() === schema.toLowerCase();
}

/** Split on top-level AND/OR, respecting single-quoted strings. */
export function splitTopLevelLogical(input: string): { clauses: string[]; between: ("AND" | "OR")[] } {
    const clauses: string[] = [];
    const between: ("AND" | "OR")[] = [];
    let start = 0;
    let i = 0;

    while (i < input.length) {
        const ch = input[i];
        if (ch === "'") {
            i += 1;
            while (i < input.length && input[i] !== "'") i += 1;
            if (i < input.length) i += 1;
            continue;
        }

        const slice = input.slice(i);
        const andMatch = /^\s+AND\s+/i.exec(slice);
        const orMatch = /^\s+OR\s+/i.exec(slice);
        let match: RegExpExecArray | null = null;
        let kind: "AND" | "OR" | null = null;
        if (andMatch && orMatch) {
            const ai = andMatch.index;
            const oi = orMatch.index;
            match = ai <= oi ? andMatch : orMatch;
            kind = ai <= oi ? "AND" : "OR";
        } else if (andMatch) {
            match = andMatch;
            kind = "AND";
        } else if (orMatch) {
            match = orMatch;
            kind = "OR";
        }

        if (kind && match) {
            clauses.push(input.slice(start, i + match.index).trim());
            between.push(kind);
            i += match.index + match[0].length;
            start = i;
        } else {
            i += 1;
        }
    }
    clauses.push(input.slice(start).trim());
    return { clauses, between };
}

function parseSingleConditionClause(clause: string): { col: string; op: string; value: string } | null {
    const rest = clause.trim();
    if (!rest) return null;

    const sortedOps = [...COMMAND_SEARCH_OPERATORS].sort((a, b) => b.label.length - a.label.length);
    for (const op of sortedOps) {
        const needle = ` ${op.label.toUpperCase()}`;
        const idx = rest.toUpperCase().indexOf(needle);
        if (idx !== -1) {
            const col = rest.substring(0, idx).trim();
            if (!col) continue;
            const afterOp = rest.substring(idx + needle.length);
            if (afterOp === "" || afterOp.startsWith(" ")) {
                return {
                    col,
                    op: op.label,
                    value: afterOp.trimStart(),
                };
            }
        }
    }
    return null;
}

/** Build FilterCondition[] from parsed clauses; between[i] joins clauses[i] and clauses[i+1]. */
export function conditionsFromParsedClauses(
    parsed: { col: string; op: string; value: string }[],
    between: ("AND" | "OR")[]
): FilterCondition[] {
    const out: FilterCondition[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
        const p = parsed[i];
        const noValue = p.op === "IS NULL" || p.op === "IS NOT NULL";
        const logical_op = i === 0 ? "AND" : between[i - 1] ?? "AND";
        out.push({
            column: p.col,
            operator: p.op,
            value: noValue ? null : p.value || null,
            logical_op,
        });
    }
    return out;
}

/** Try multi-clause + optional incomplete tail. Returns null if only single-clause (use legacy path). */
function tryParseMultiRest(
    schema: string,
    table: string,
    rest: string
): CommandSearchStage | null {
    const { clauses, between } = splitTopLevelLogical(rest);
    if (clauses.length <= 1) return null;

    const complete: { col: string; op: string; value: string }[] = [];
    for (let i = 0; i < clauses.length - 1; i += 1) {
        const c = parseSingleConditionClause(clauses[i]);
        if (!c) {
            return null;
        }
        complete.push(c);
    }

    const last = clauses[clauses.length - 1];
    const lastParsed = parseSingleConditionClause(last);

    if (lastParsed) {
        complete.push(lastParsed);
        return {
            type: "multi_value",
            schema,
            table,
            conditions: conditionsFromParsedClauses(complete, between),
        };
    }

    const priorBetween = between.slice(0, Math.max(0, complete.length - 1));
    const prior = conditionsFromParsedClauses(complete, priorBetween);
    return {
        type: "multi_build",
        schema,
        table,
        prior,
        tailRest: last,
    };
}

function resolveTablePrefix(trimmed: string, tables: TableInfo[]): { schema: string; table: string; rest: string } | null {
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx === -1) return null;

    const head = trimmed.substring(0, dotIdx);
    const tail = trimmed.substring(dotIdx + 1);
    const tailDotIdx = tail.indexOf(".");
    const tableSegment = tailDotIdx === -1 ? tail : tail.substring(0, tailDotIdx);
    const afterTable = tailDotIdx === -1 ? "" : tail.substring(tailDotIdx + 1);

    const qualifiedMatches = tables.filter(
        (t) =>
            schemaMatchesCatalog(head, t) && t.name.toLowerCase() === tableSegment.toLowerCase()
    );

    let schema: string;
    let table: string;
    let rest: string;

    if (qualifiedMatches.length === 1) {
        schema = qualifiedMatches[0].schema;
        table = qualifiedMatches[0].name;
        rest = afterTable;
    } else {
        const tablePart = head.toLowerCase();
        const matchedTable = tables.find((t) => t.name.toLowerCase() === tablePart);
        schema = matchedTable?.schema ?? "public";
        table = tablePart;
        rest = tail;
    }

    return { schema, table, rest };
}

/** Column / operator / value autocomplete for the fragment after `table.` */
export function parseSingleTableSearchRest(schema: string, table: string, rest: string): CommandSearchStage {
    const sortedOps = [...COMMAND_SEARCH_OPERATORS].sort((a, b) => b.label.length - a.label.length);
    for (const op of sortedOps) {
        const needle = ` ${op.label.toUpperCase()}`;
        const idx = rest.toUpperCase().indexOf(needle);
        if (idx !== -1) {
            const col = rest.substring(0, idx);
            const afterOp = rest.substring(idx + needle.length);
            if (afterOp === "" || afterOp.startsWith(" ")) {
                return {
                    type: "value",
                    schema,
                    table,
                    col,
                    op: op.label,
                    value: afterOp.trimStart(),
                };
            }
        }
    }

    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx !== -1) {
        const col = rest.substring(0, spaceIdx);
        const opFilter = rest.substring(spaceIdx + 1);
        return { type: "operator", schema, table, col, opFilter };
    }

    return { type: "column", schema, table, filter: rest };
}

function tryJoinSplit(trimmed: string): { left: string; targetTable: string } | null {
    const m = JOIN_ARROW.exec(trimmed);
    if (!m || m.index === undefined) return null;
    const left = trimmed.slice(0, m.index).trim();
    const right = trimmed.slice(m.index + m[0].length).trim().split(/\s+/)[0] ?? "";
    if (!left || !right) return null;
    return { left, targetTable: right };
}

export function parseCommandSearchInput(input: string, tables: TableInfo[]): CommandSearchStage {
    const trimmed = input.trim();
    if (!trimmed) return { type: "init" };

    if (trimmed.startsWith("?")) {
        const query = trimmed.slice(1).trim();
        return { type: "ai_nl", query };
    }

    const upper = trimmed.toUpperCase();
    if (SQL_KEYWORDS.some((kw) => upper.startsWith(kw)) || trimmed.includes(";")) {
        return { type: "raw_sql", sql: trimmed };
    }

    const joinParts = tryJoinSplit(trimmed);
    const work = joinParts?.left ?? trimmed;

    const resolved = resolveTablePrefix(work, tables);
    if (!resolved) return { type: "table", filter: trimmed };

    const { schema, table, rest } = resolved;

    const multi = tryParseMultiRest(schema, table, rest);
    if (multi) {
        if (!joinParts) return multi;
        if (multi.type === "multi_value") {
            return {
                type: "join_value",
                schema,
                table,
                conditions: multi.conditions,
                targetTable: joinParts.targetTable,
            };
        }
        if (multi.type === "multi_build") {
            return {
                type: "join_build",
                schema,
                table,
                prior: multi.prior,
                tailRest: multi.tailRest,
                targetTable: joinParts.targetTable,
            };
        }
    }

    if (joinParts) {
        const legacy = parseSingleTableSearchRest(schema, table, rest);
        if (legacy.type === "value") {
            const noValue = legacy.op === "IS NULL" || legacy.op === "IS NOT NULL";
            const conditions: FilterCondition[] = [
                {
                    column: legacy.col,
                    operator: legacy.op,
                    value: noValue ? null : legacy.value || null,
                    logical_op: "AND",
                },
            ];
            return {
                type: "join_value",
                schema,
                table,
                conditions,
                targetTable: joinParts.targetTable,
            };
        }
        if (legacy.type === "operator" || legacy.type === "column") {
            return {
                type: "join_build",
                schema,
                table,
                prior: [],
                tailRest: rest,
                targetTable: joinParts.targetTable,
            };
        }
    }

    return parseSingleTableSearchRest(schema, table, rest);
}

export function buildStructuredCommandSearchSQL(
    schema: string,
    table: string,
    col: string,
    op: string,
    value: string
): string {
    const noValue = op === "IS NULL" || op === "IS NOT NULL";
    if (noValue) {
        return `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} LIMIT 200`;
    }

    const escaped = value.replace(/'/g, "''");
    return `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} '${escaped}' LIMIT 200`;
}

/** Fallback SQL when multi search API fails — matches Rust predicate shape. */
export function buildMultiConditionSQL(schema: string, table: string, conditions: FilterCondition[]): string {
    if (conditions.length === 0) {
        return `SELECT * FROM "${schema}"."${table}" LIMIT 200`;
    }
    const parts: string[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
        const c = conditions[i];
        const col = c.column.replace(/"/g, '""');
        const op = c.operator.toUpperCase();
        const noValue = op === "IS NULL" || op === "IS NOT NULL";
        const pred = noValue
            ? `"${col}" ${op}`
            : `"${col}" ${c.operator} '${(c.value ?? "").replace(/'/g, "''")}'`;
        if (i === 0) {
            parts.push(pred);
        } else {
            const join = (c.logical_op || "AND").toUpperCase() === "OR" ? "OR" : "AND";
            parts.push(`${join} ${pred}`);
        }
    }
    return `SELECT * FROM "${schema}"."${table}" WHERE ${parts.join(" ")} LIMIT 200`;
}

/** Rebuild quick-search text after autocomplete (multi-build / join-build). */
export function serializeTableSearchInput(
    table: string,
    conditions: FilterCondition[],
    tail: string,
    joinTarget?: string
): string {
    const chunks: string[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
        const c = conditions[i];
        const colRef = i === 0 ? `${table}.${c.column}` : c.column;
        const noV = c.operator === "IS NULL" || c.operator === "IS NOT NULL";
        const valPart = noV ? "" : ` ${c.value ?? ""}`;
        chunks.push(`${colRef} ${c.operator}${valPart}`);
    }
    let body = chunks[0] ?? "";
    for (let i = 1; i < chunks.length; i += 1) {
        const join = conditions[i].logical_op.toUpperCase() === "OR" ? " OR " : " AND ";
        body += join + chunks[i];
    }
    if (tail.trim()) {
        body += (conditions.length > 0 ? " AND " : "") + tail;
    }
    let out = body;
    if (joinTarget?.trim()) {
        out += ` => ${joinTarget.trim()}`;
    }
    return out;
}

export function tokenizeCommandSearchInput(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8);
}
