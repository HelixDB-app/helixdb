import type { SchemaTableMeta } from "@/lib/ai-chat-engine";
import { buildCompressedSchema } from "@/lib/ai-chat-engine";
import type { ColumnInfo, TableInfo, TopologyData } from "@/lib/types";
import { topologyToFkSummary } from "@/lib/command-search-join";

const DEFAULT_MAX_TABLES = 48;

function tokenizeNlQuery(q: string): string[] {
    const lower = q.toLowerCase();
    return lower
        .split(/[^a-z0-9_]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
}

/** Align with command palette / connection UI (`schema::table`). */
function tableKey(schema: string, table: string): string {
    return `${schema}::${table}`;
}

/** Outgoing FKs per table for SchemaTableMeta.constraints */
export function buildFkConstraintsByTable(topology: TopologyData | null): Map<
    string,
    { column: string; refTable: string; refColumn: string }[]
> {
    const map = new Map<string, { column: string; refTable: string; refColumn: string }[]>();
    if (!topology?.edges?.length) return map;

    for (const e of topology.edges) {
        const k = tableKey(e.from_schema, e.from_table);
        const list = map.get(k) ?? [];
        list.push({
            column: e.from_column,
            refTable: `${e.to_schema}.${e.to_table}`,
            refColumn: e.to_column,
        });
        map.set(k, list);
    }
    return map;
}

/**
 * Pick tables most relevant to the NL query, then build compressed schema text.
 */
export function rankTablesForNlSearch(nlQuery: string, tables: TableInfo[], maxTables = DEFAULT_MAX_TABLES): TableInfo[] {
    if (tables.length <= maxTables) return tables;

    const tokens = tokenizeNlQuery(nlQuery);
    const schemaNames = new Set(tables.map((t) => t.schema.toLowerCase()));

    if (tokens.length === 0) {
        return [...tables]
            .sort((a, b) => Number(b.row_count ?? 0) - Number(a.row_count ?? 0))
            .slice(0, maxTables);
    }

    const scored = tables.map((t) => {
        const text = `${t.schema} ${t.name} ${t.table_comment ?? ""}`.toLowerCase();
        let score = 0;
        for (const tok of tokens) {
            if (tok.length < 2) continue;
            if (text.includes(tok)) score += 4;
            if (t.name.toLowerCase() === tok) score += 14;
            if (`${t.schema}.${t.name}`.toLowerCase().includes(tok)) score += 6;
        }
        if (schemaNames.has(tokens[0] ?? "") && t.schema.toLowerCase() === tokens[0]) {
            score += 8;
        }
        score += Math.min(22, Math.log10(Number(t.row_count ?? 0) + 1) * 2.8);
        return { t, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxTables).map((s) => s.t);
}

export function buildSchemaTableMetaList(
    selected: TableInfo[],
    columnCache: Record<string, ColumnInfo[]>,
    fkByTable: Map<string, { column: string; refTable: string; refColumn: string }[]>
): SchemaTableMeta[] {
    const out: SchemaTableMeta[] = [];

    for (const t of selected) {
        const key = tableKey(t.schema, t.name);
        const cols = columnCache[key] ?? [];

        const fks = fkByTable.get(key) ?? [];

        out.push({
            schema: t.schema,
            name: t.name,
            columns: cols,
            constraints: fks.length ? { foreignKeys: fks } : undefined,
        });
    }

    return out;
}

export interface NlSearchSchemaBundle {
    compressedSchema: string;
    fkSummaryBlock: string;
    schemaFingerprint: string;
}

export function buildNlSearchSchemaBundle(
    nlQuery: string,
    visibleTables: TableInfo[],
    columnCache: Record<string, ColumnInfo[]>,
    topology: TopologyData | null,
    maxTables = DEFAULT_MAX_TABLES
): NlSearchSchemaBundle {
    const ranked = rankTablesForNlSearch(nlQuery, visibleTables, maxTables);
    const fkByTable = buildFkConstraintsByTable(topology);
    const meta = buildSchemaTableMetaList(ranked, columnCache, fkByTable);
    const compressedSchema = buildCompressedSchema(meta);

    const fkLines = topology ? topologyToFkSummary(topology, 40) : "";
    const fkSummaryBlock = fkLines.trim()
        ? `\nFOREIGN_KEY_EDGES (join hints)\n${fkLines}\n`
        : "";

    const fpParts = ranked.map((t) => `${t.schema}.${t.name}:${(columnCache[tableKey(t.schema, t.name)] ?? []).length}`);
    const schemaFingerprint = fpParts.join("|").slice(0, 2000);

    return {
        compressedSchema,
        fkSummaryBlock,
        schemaFingerprint,
    };
}
