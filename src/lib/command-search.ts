"use client";

import type { TableInfo } from "@/lib/types";

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
    { label: "<=", description: "Less or equal" },
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
    | { type: "raw_sql"; sql: string }
    | { type: "ai_nl"; query: string };

const SQL_KEYWORDS = [
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
    "CREATE", "DROP", "ALTER", "EXPLAIN", "TABLE", "SHOW",
];

function schemaMatchesCatalog(schema: string, t: TableInfo): boolean {
    return t.schema === schema || t.schema.toLowerCase() === schema.toLowerCase();
}

export function parseCommandSearchInput(
    input: string,
    tables: TableInfo[]
): CommandSearchStage {
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

    const dotIdx = trimmed.indexOf(".");
    if (dotIdx === -1) return { type: "table", filter: trimmed };

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

export function tokenizeCommandSearchInput(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8);
}
