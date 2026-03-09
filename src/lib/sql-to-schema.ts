/**
 * Parse PostgreSQL DDL (CREATE TABLE) into Schema Designer table/column model.
 * Handles typical CREATE TABLE forms: columns, PRIMARY KEY, REFERENCES, CONSTRAINT FKs.
 */

import type { ForeignKeyAction, SchemaDesignerTable, SchemaDesignerColumn } from "./types";

function genId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Normalize PG type to uppercase shorthand we use in the designer
const TYPE_ALIASES: Record<string, string> = {
    uuid: "UUID",
    serial: "SERIAL",
    bigserial: "BIGSERIAL",
    smallserial: "SMALLSERIAL",
    int: "INTEGER",
    int4: "INTEGER",
    int8: "BIGINT",
    int2: "SMALLINT",
    smallint: "SMALLINT",
    bigint: "BIGINT",
    integer: "INTEGER",
    real: "REAL",
    float4: "REAL",
    float8: "DOUBLE PRECISION",
    "double precision": "DOUBLE PRECISION",
    "character varying": "VARCHAR",
    "timestamp with time zone": "TIMESTAMPTZ",
    "timestamp without time zone": "TIMESTAMP",
    varchar: "VARCHAR",
    char: "CHAR",
    "character": "CHAR",
    text: "TEXT",
    bool: "BOOLEAN",
    boolean: "BOOLEAN",
    date: "DATE",
    time: "TIME",
    timestamp: "TIMESTAMP",
    timestamptz: "TIMESTAMPTZ",
    json: "JSON",
    jsonb: "JSONB",
    numeric: "NUMERIC",
    decimal: "NUMERIC",
};

function normalizeType(raw: string): string {
    const lower = raw.toLowerCase().trim();
    return TYPE_ALIASES[lower] ?? raw.toUpperCase();
}

/** Normalize table/column name for FK resolution: strip quotes, lowercase. */
function normalizeIdentifier(name: string): string {
    return name.replace(/^["']|["']$/g, "").trim().toLowerCase();
}

/** Strip surrounding double quotes from identifier and trim. */
function stripQuotes(s: string): string {
    return s.replace(/^["']|["']$/g, "").trim();
}

const FK_ACTIONS = new Set<ForeignKeyAction>([
    "NO ACTION",
    "RESTRICT",
    "CASCADE",
    "SET NULL",
    "SET DEFAULT",
]);

function normalizeFkAction(raw: string | undefined): ForeignKeyAction | undefined {
    const normalized = (raw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    return FK_ACTIONS.has(normalized as ForeignKeyAction) ? (normalized as ForeignKeyAction) : undefined;
}

function parseForeignKeyActions(line: string): { on_delete?: ForeignKeyAction; on_update?: ForeignKeyAction } {
    const onDeleteMatch = line.match(/\bON\s+DELETE\s+(NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)\b/i);
    const onUpdateMatch = line.match(/\bON\s+UPDATE\s+(NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)\b/i);
    return {
        on_delete: normalizeFkAction(onDeleteMatch?.[1]),
        on_update: normalizeFkAction(onUpdateMatch?.[1]),
    };
}

interface ParsedReference {
    table: string;
    column: string;
    on_delete?: ForeignKeyAction;
    on_update?: ForeignKeyAction;
}

/** Parse REFERENCES table(col) or REFERENCES table from line; returns null if not found. */
function parseReferences(line: string): ParsedReference | null {
    const refIdx = line.toUpperCase().indexOf("REFERENCES");
    if (refIdx === -1) return null;
    const afterRef = line.slice(refIdx + 10).trim();
    const actions = parseForeignKeyActions(line);
    // REFERENCES "tbl" ("col") or REFERENCES "tbl"(col) or REFERENCES tbl (id) or REFERENCES tbl(id) [ON DELETE ...]
    const quotedTbl = afterRef.match(/^"([^"]+)"\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (quotedTbl) return { table: stripQuotes(quotedTbl[1]), column: stripQuotes(quotedTbl[2]), ...actions };
    const unquotedTbl = afterRef.match(/^(\w+)\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (unquotedTbl) return { table: stripQuotes(unquotedTbl[1]), column: stripQuotes(unquotedTbl[2]), ...actions };
    // REFERENCES "tbl" or REFERENCES tbl (no column — default "id")
    const quotedOnly = afterRef.match(/^"([^"]+)"/i);
    if (quotedOnly) return { table: stripQuotes(quotedOnly[1]), column: "id", ...actions };
    const unquotedOnly = afterRef.match(/^(\w+)/);
    if (unquotedOnly) return { table: stripQuotes(unquotedOnly[1]), column: "id", ...actions };
    return null;
}

/** Parse FOREIGN KEY (col) REFERENCES table (col) from line. */
function parseFkConstraint(line: string): { col: string; refTable: string; refCol: string; on_delete?: ForeignKeyAction; on_update?: ForeignKeyAction } | null {
    const fkIdx = line.toUpperCase().indexOf("FOREIGN");
    if (fkIdx === -1) return null;
    const fromFk = line.slice(fkIdx);
    const match =
        fromFk.match(/FOREIGN\s+KEY\s*\(\s*["']?([^"')]+)["']?\s*\)\s*REFERENCES\s+"([^"]+)"\s*\(\s*["']?([^"')]+)["']?\s*\)/i) ??
        fromFk.match(/FOREIGN\s+KEY\s*\(\s*["']?([^"')]+)["']?\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (match) {
        const actions = parseForeignKeyActions(fromFk);
        return {
            col: stripQuotes(match[1]),
            refTable: stripQuotes(match[2]),
            refCol: stripQuotes(match[3]),
            ...actions,
        };
    }
    return null;
}

export interface ParsedTable {
    name: string;
    columns: {
        name: string;
        data_type: string;
        nullable: boolean;
        default_value: string | null;
        is_primary_key: boolean;
        references: ParsedReference | null;
        unique: boolean;
    }[];
}

/**
 * Parse SQL script into a list of table definitions (names + column defs).
 * Does not assign IDs; caller converts to full SchemaDesignerTable[] with genId.
 */
export function parseSqlToTables(sql: string): ParsedTable[] {
    const tables: ParsedTable[] = [];
    const normalized = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // Find all CREATE TABLE ... ( positions (matchAll avoids regex state issues across multiple tables)
    const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))\s*\(/gi;
    const matches = [...normalized.matchAll(createRegex)];

    for (const match of matches) {
        const tableName = (match[1] ?? match[2] ?? "").trim();
        if (!tableName) continue;
        const openParen = match.index + match[0].length - 1;
        let depth = 1;
        let i = openParen + 1;
        while (i < normalized.length && depth > 0) {
            const c = normalized[i];
            if (c === "(") depth++;
            else if (c === ")") depth--;
            i++;
        }
        const body = normalized.slice(openParen + 1, i - 1);
        const parsed = parseTableBody(tableName, body);
        if (parsed.columns.length > 0) tables.push(parsed);
    }

    // Fallback: single CREATE TABLE when no matches (e.g. non-standard spacing)
    if (tables.length === 0) {
        const simpleMatch = normalized.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(/i);
        if (simpleMatch) {
            const openIdx = normalized.indexOf("(", simpleMatch.index!);
            let depth = 1;
            let closeIdx = openIdx + 1;
            while (closeIdx < normalized.length && depth > 0) {
                const c = normalized[closeIdx];
                if (c === "(") depth++;
                else if (c === ")") depth--;
                closeIdx++;
            }
            const body = normalized.slice(openIdx + 1, closeIdx - 1);
            const parsed = parseTableBody(simpleMatch[1], body);
            if (parsed.columns.length > 0) tables.push(parsed);
        }
    }

    return tables;
}

/** Split body into logical lines; one per column/constraint. Handles missing commas (e.g. "col TYPE\n  col2 TYPE"). */
function tableBodyToLines(body: string): string[] {
    const byComma = body.split(",").map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const segment of byComma) {
        // If segment has newline and looks like multiple columns (identifier TYPE ...), split on newline before next column
        const parts = segment.split(/\n\s*(?=[a-zA-Z_][a-zA-Z0-9_]*\s+\w)/).map((p) => p.trim()).filter(Boolean);
        out.push(...parts);
    }
    return out;
}

function parseTableBody(tableName: string, body: string): ParsedTable {
    const columns: ParsedTable["columns"] = [];
    const pkColumns = new Set<string>();
    const fkColumns: { col: string; refTable: string; refCol: string; on_delete?: ForeignKeyAction; on_update?: ForeignKeyAction }[] = [];

    const lines = tableBodyToLines(body);

    for (const line of lines) {
        const upper = line.toUpperCase();

        // PRIMARY KEY (...) — standalone or CONSTRAINT "name" PRIMARY KEY (...)
        const pkMatch = line.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
        if (pkMatch) {
            pkMatch[1].split(",").map((c) => stripQuotes(c.trim())).filter(Boolean).forEach((c) => pkColumns.add(c));
            continue;
        }

        // FOREIGN KEY (col) REFERENCES table (col) — anywhere in line (CONSTRAINT ... or standalone)
        const fkConstraintMatch = parseFkConstraint(line);
        if (fkConstraintMatch) {
            fkColumns.push({
                col: fkConstraintMatch.col,
                refTable: fkConstraintMatch.refTable,
                refCol: fkConstraintMatch.refCol,
                on_delete: fkConstraintMatch.on_delete,
                on_update: fkConstraintMatch.on_update,
            });
            continue;
        }

        if (upper.startsWith("CONSTRAINT") || upper.startsWith("UNIQUE") || upper.startsWith("CHECK")) {
            continue;
        }

        // Column: "name" TYPE ... or name TYPE ...
        const colMatch = line.match(/^["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s+([a-zA-Z][a-zA-Z0-9_\s()]*?)(?=\s+(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY|REFERENCES|CHECK|,|$))/i)
            ?? line.match(/^["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s+(\S+)/);
        if (!colMatch) continue;

        const colName = stripQuotes(colMatch[1]);
        let dataType = colMatch[2].trim();
        // Type may include (size): VARCHAR(255), NUMERIC(10,2) — keep one word + optional (..)
        const typeWithParen = dataType.match(/^(\w+)(?:\s*\([^)]*\))?/);
        if (typeWithParen) dataType = typeWithParen[1];

        const notNull = /\bNOT\s+NULL\b/i.test(line);
        const isPk = /\bPRIMARY\s+KEY\b/i.test(line);
        const unique = /\bUNIQUE\b/i.test(line);
        let defaultVal: string | null = null;
        const defaultMatch = line.match(/\bDEFAULT\s+([^,\n]+?)(?=\s*(?:NOT\s+NULL|NULL|PRIMARY|REFERENCES|UNIQUE|,|$))/i);
        if (defaultMatch) defaultVal = defaultMatch[1].trim();

        const references = parseReferences(line);

        columns.push({
            name: colName,
            data_type: normalizeType(dataType),
            nullable: !notNull,
            default_value: defaultVal,
            is_primary_key: isPk,
            references,
            unique,
        });

        if (isPk) pkColumns.add(colName);
        if (references) {
            fkColumns.push({
                col: colName,
                refTable: references.table,
                refCol: references.column,
                on_delete: references.on_delete,
                on_update: references.on_update,
            });
        }
    }

    // Apply every table-level PRIMARY KEY (CONSTRAINT "pk_..." PRIMARY KEY ("col") or PRIMARY KEY (...))
    const pkDecls = [...body.matchAll(/PRIMARY\s+KEY\s*\(([^)]+)\)/gi)];
    for (const pkDecl of pkDecls) {
        pkDecl[1].split(",").map((c) => stripQuotes(c.trim())).filter(Boolean).forEach((c) => pkColumns.add(c));
    }
    columns.forEach((c) => {
        if (pkColumns.has(c.name)) c.is_primary_key = true;
    });

    // Apply table-level FOREIGN KEY (CONSTRAINT ... FOREIGN KEY (col) REFERENCES ...) to columns
    for (const fk of fkColumns) {
        const col = columns.find((c) => c.name === fk.col);
        if (col) {
            col.references = {
                table: fk.refTable,
                column: fk.refCol,
                on_delete: fk.on_delete,
                on_update: fk.on_update,
            };
        }
    }

    return { name: stripQuotes(tableName), columns };
}

/**
 * Convert parsed tables into full SchemaDesignerTable[] with IDs and FK refs by name.
 */
export function parsedTablesToDesigner(parsed: ParsedTable[]): SchemaDesignerTable[] {
    const tableByName = new Map<string, SchemaDesignerTable>();
    const tables: SchemaDesignerTable[] = [];

    for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const tableId = genId();
        const columns: SchemaDesignerColumn[] = p.columns.map((col) => ({
            id: genId(),
            name: col.name,
            data_type: col.data_type,
            nullable: col.nullable,
            default_value: col.default_value,
            is_primary_key: col.is_primary_key,
            foreign_key: null,
            unique: col.unique || undefined,
        }));
        const table: SchemaDesignerTable = {
            id: tableId,
            name: p.name,
            columns,
            indexes: [],
            position: { x: 50 + (i % 4) * 280, y: 50 + Math.floor(i / 4) * 300 },
        };
        tableByName.set(normalizeIdentifier(p.name), table);
        tables.push(table);
    }

    for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const table = tables[i];
        for (let j = 0; j < p.columns.length; j++) {
            const ref = p.columns[j].references;
            if (!ref) continue;
            const targetTable = tableByName.get(normalizeIdentifier(ref.table));
            const targetCol = targetTable?.columns.find(
                (c) => normalizeIdentifier(c.name) === normalizeIdentifier(ref.column)
            );
            if (targetTable && targetCol) {
                table.columns[j].foreign_key = {
                    target_table_id: targetTable.id,
                    target_column_id: targetCol.id,
                    on_delete: ref.on_delete,
                    on_update: ref.on_update,
                };
            }
        }
    }

    return tables;
}

/**
 * Parse SQL script and return SchemaDesignerTable[] ready for the store.
 */
export function sqlToSchemaDesignerTables(sql: string): SchemaDesignerTable[] {
    const parsed = parseSqlToTables(sql);
    return parsedTablesToDesigner(parsed);
}

/**
 * Returns true if the script parses to the same logical schema (table and column names) as the given tables.
 * Uses normalized names (case-insensitive, quote-tolerant) so switching tabs does not overwrite script when only casing/quotes differ.
 */
export function scriptMatchesSchema(script: string, tables: SchemaDesignerTable[]): boolean {
    const trimmed = script.trim();
    if (!trimmed) return false;
    try {
        const parsed = parseSqlToTables(trimmed);
        if (parsed.length !== tables.length) return false;
        for (let i = 0; i < tables.length; i++) {
            const p = parsed[i];
            const t = tables[i];
            if (
                normalizeIdentifier(p.name) !== normalizeIdentifier(t.name) ||
                p.columns.length !== t.columns.length
            )
                return false;
            for (let j = 0; j < t.columns.length; j++) {
                if (normalizeIdentifier(p.columns[j].name) !== normalizeIdentifier(t.columns[j].name))
                    return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}
