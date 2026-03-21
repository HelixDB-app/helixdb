/**
 * Migration Diff Engine
 * Computes schema diffs between two PostgreSQL databases and generates
 * forward + rollback SQL migration scripts.
 */

import { dbListSchemas, dbListTables, dbGetTableDetails } from "./db-platform";
import {
    dbListFunctions,
    dbListTypes,
    dbGetTypeDefinition,
} from "./tauri";
import type {
    SchemaInfo,
    TableInfo,
    TableDetails,
    ColumnInfo,
    TableConstraint,
    TableIndex,
    FunctionInfo,
    TypeInfo,
    TypeDefinitionDetail,
} from "./types";

// ─── Severity & Operation Types ────────────────────────────────────────────

export type DiffSeverity = "critical" | "high" | "medium" | "low" | "info";
export type DiffOp = "add" | "drop" | "modify";

// ─── Diff Item Types ────────────────────────────────────────────────────────

export interface ColumnDiff {
    op: DiffOp;
    column: string;
    severity: DiffSeverity;
    /** Populated for modify ops */
    before?: Partial<ColumnInfo>;
    after?: Partial<ColumnInfo>;
    /** For add/drop */
    info?: ColumnInfo;
}

export interface ConstraintDiff {
    op: DiffOp;
    name: string;
    severity: DiffSeverity;
    before?: TableConstraint;
    after?: TableConstraint;
}

export interface IndexDiff {
    op: DiffOp;
    name: string;
    severity: DiffSeverity;
    before?: TableIndex;
    after?: TableIndex;
}

export interface TableDiff {
    op: DiffOp;
    schema: string;
    table: string;
    severity: DiffSeverity;
    rowCount: number;
    columns: ColumnDiff[];
    constraints: ConstraintDiff[];
    indexes: IndexDiff[];
    /** Source details (for drop ops) */
    sourceDetails?: TableDetails;
    /** Target details (for add ops) */
    targetDetails?: TableDetails;
}

export interface FunctionDiff {
    op: DiffOp;
    schema: string;
    name: string;
    arguments: string;
    severity: DiffSeverity;
    before?: FunctionInfo;
    after?: FunctionInfo;
}

export interface EnumDiff {
    op: DiffOp;
    schema: string;
    name: string;
    kind: string;
    severity: DiffSeverity;
    before?: TypeDefinitionDetail | null;
    after?: TypeDefinitionDetail | null;
}

export interface MigrationDiff {
    tables: TableDiff[];
    functions: FunctionDiff[];
    enums: EnumDiff[];
    totalChanges: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    infoCount: number;
}

// ─── Schema Snapshot ────────────────────────────────────────────────────────

export interface SchemaTableSnapshot {
    info: TableInfo;
    details: TableDetails;
}

export interface SchemaSnapshot {
    connectionId: string;
    databaseName: string;
    schemas: SchemaInfo[];
    tables: Map<string, SchemaTableSnapshot>; // key: "schema.table"
    functions: Map<string, FunctionInfo>;      // key: "schema.name(args)"
    types: Map<string, TypeDefinitionDetail | null>; // key: "schema.name"
}

export interface SnapshotProgress {
    stage: string;
    current: number;
    total: number;
}

export interface SnapshotOptions {
    /** Only include tables matching these "schema.table" keys; empty = all */
    filterTables?: string[];
    includeFunctions?: boolean;
    includeIndexes?: boolean;
    includeSequences?: boolean;
    includeViews?: boolean;
    /** Large DB: skip detailed index metadata for tables with estimated rows > this value (0 = off) */
    skipIndexesAboveRows?: number;
    /** Max concurrent table-detail fetches per schema chunk */
    concurrency?: number;
}

/** Fetch full schema metadata for a connection, optionally filtered by schema names */
export async function fetchSchemaSnapshot(
    connectionId: string,
    databaseName: string,
    filterSchemas: string[],
    onProgress?: (p: SnapshotProgress) => void,
    options?: SnapshotOptions
): Promise<SchemaSnapshot> {
    const {
        filterTables = [],
        includeFunctions = true,
        includeIndexes = true,
        skipIndexesAboveRows = 0,
        concurrency = 8,
    } = options ?? {};
    const snapshot: SchemaSnapshot = {
        connectionId,
        databaseName,
        schemas: [],
        tables: new Map(),
        functions: new Map(),
        types: new Map(),
    };

    // 1. List schemas
    onProgress?.({ stage: "Listing schemas…", current: 0, total: 1 });
    const allSchemas = await dbListSchemas(connectionId);
    const schemas = filterSchemas.length > 0
        ? allSchemas.filter(s => filterSchemas.includes(s.name))
        : allSchemas.filter(s => !["pg_catalog", "information_schema", "pg_toast"].includes(s.name));
    snapshot.schemas = schemas;

    // 2. For each schema, fetch tables + functions + types in parallel
    let processed = 0;
    const schemaCount = schemas.length;

    for (const schema of schemas) {
        onProgress?.({
            stage: `Loading schema "${schema.name}"…`,
            current: processed,
            total: schemaCount,
        });

        const [allTables, functions, types] = await Promise.all([
            dbListTables(connectionId, schema.name).catch(() => [] as TableInfo[]),
            includeFunctions
                ? dbListFunctions(connectionId, schema.name).catch(() => [] as FunctionInfo[])
                : Promise.resolve([] as FunctionInfo[]),
            dbListTypes(connectionId, schema.name).catch(() => [] as TypeInfo[]),
        ]);

        // Filter tables by selection
        const tables = filterTables.length > 0
            ? allTables.filter(t => filterTables.includes(`${schema.name}.${t.name}`))
            : allTables;

        // 3. Fetch table details in parallel with configurable concurrency
        for (let i = 0; i < tables.length; i += concurrency) {
            const chunk = tables.slice(i, i + concurrency);
            const details = await Promise.all(
                chunk.map(t =>
                    dbGetTableDetails(connectionId, schema.name, t.name)
                        .catch(() => null)
                )
            );
            chunk.forEach((t, idx) => {
                if (details[idx]) {
                    const detail = details[idx]!;
                    const rowEst = t.row_count ?? 0;
                    // Skip indexes when not included or when table is very large
                    if (!includeIndexes || (skipIndexesAboveRows > 0 && rowEst > skipIndexesAboveRows)) {
                        detail.indexes = [];
                    }
                    snapshot.tables.set(`${schema.name}.${t.name}`, {
                        info: t,
                        details: detail,
                    });
                }
            });
        }

        // 4. Store functions
        for (const fn of functions) {
            snapshot.functions.set(`${schema.name}.${fn.name}(${fn.arguments})`, fn);
        }

        // 5. Fetch type definitions (enums/composites)
        const typeDetails = await Promise.all(
            types.map(t =>
                dbGetTypeDefinition(connectionId, schema.name, t.name).catch(() => null)
            )
        );
        types.forEach((t, idx) => {
            snapshot.types.set(`${schema.name}.${t.name}`, typeDetails[idx]);
        });

        processed++;
    }

    return snapshot;
}

// ─── Diff Computation ───────────────────────────────────────────────────────

function severityForDroppedTable(rowCount: number): DiffSeverity {
    return rowCount > 0 ? "critical" : "medium";
}

function severityForColumnDiff(col: ColumnDiff): DiffSeverity {
    if (col.op === "drop") return "critical";
    if (col.op === "add") {
        return col.info?.is_nullable === false ? "high" : "low";
    }
    // modify
    if (col.before?.data_type !== col.after?.data_type) return "high";
    if (col.before?.is_nullable === true && col.after?.is_nullable === false) return "high";
    if (col.before?.column_default !== col.after?.column_default) return "medium";
    return "low";
}

function worstSeverity(severities: DiffSeverity[]): DiffSeverity {
    const order: DiffSeverity[] = ["critical", "high", "medium", "low", "info"];
    for (const s of order) {
        if (severities.includes(s)) return s;
    }
    return "info";
}

export function computeMigrationDiff(
    source: SchemaSnapshot,
    target: SchemaSnapshot
): MigrationDiff {
    const diff: MigrationDiff = {
        tables: [],
        functions: [],
        enums: [],
        totalChanges: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        infoCount: 0,
    };

    // ── Tables ────────────────────────────────────────────────────────────
    const sourceTableKeys = new Set(source.tables.keys());
    const targetTableKeys = new Set(target.tables.keys());

    // Tables in source but not in target → ADD to target
    for (const key of sourceTableKeys) {
        if (!targetTableKeys.has(key)) {
            const snap = source.tables.get(key)!;
            diff.tables.push({
                op: "add",
                schema: snap.details.schema,
                table: snap.details.name,
                severity: "low",
                rowCount: snap.info.row_count,
                columns: [],
                constraints: [],
                indexes: [],
                sourceDetails: snap.details,
            });
        }
    }

    // Tables in target but not in source → DROP from target
    for (const key of targetTableKeys) {
        if (!sourceTableKeys.has(key)) {
            const snap = target.tables.get(key)!;
            const sev = severityForDroppedTable(snap.info.row_count);
            diff.tables.push({
                op: "drop",
                schema: snap.details.schema,
                table: snap.details.name,
                severity: sev,
                rowCount: snap.info.row_count,
                columns: [],
                constraints: [],
                indexes: [],
                targetDetails: snap.details,
            });
        }
    }

    // Tables in both → compare structure
    for (const key of sourceTableKeys) {
        if (!targetTableKeys.has(key)) continue;
        const srcSnap = source.tables.get(key)!;
        const tgtSnap = target.tables.get(key)!;
        const srcDetails = srcSnap.details;
        const tgtDetails = tgtSnap.details;

        const columnDiffs: ColumnDiff[] = [];
        const constraintDiffs: ConstraintDiff[] = [];
        const indexDiffs: IndexDiff[] = [];

        // Columns
        const srcCols = new Map(srcDetails.columns.map(c => [c.name, c]));
        const tgtCols = new Map(tgtDetails.columns.map(c => [c.name, c]));

        for (const [name, srcCol] of srcCols) {
            if (!tgtCols.has(name)) {
                const d: ColumnDiff = { op: "add", column: name, severity: "low", info: srcCol };
                d.severity = severityForColumnDiff(d);
                columnDiffs.push(d);
            } else {
                const tgtCol = tgtCols.get(name)!;
                const changed =
                    srcCol.data_type !== tgtCol.data_type ||
                    srcCol.is_nullable !== tgtCol.is_nullable ||
                    srcCol.column_default !== tgtCol.column_default;
                if (changed) {
                    const d: ColumnDiff = {
                        op: "modify",
                        column: name,
                        severity: "low",
                        before: tgtCol,
                        after: srcCol,
                    };
                    d.severity = severityForColumnDiff(d);
                    columnDiffs.push(d);
                }
            }
        }
        for (const [name, tgtCol] of tgtCols) {
            if (!srcCols.has(name)) {
                const d: ColumnDiff = { op: "drop", column: name, severity: "critical", info: tgtCol };
                columnDiffs.push(d);
            }
        }

        // Constraints
        const srcConstraints = new Map(srcDetails.constraints.map(c => [c.name, c]));
        const tgtConstraints = new Map(tgtDetails.constraints.map(c => [c.name, c]));
        for (const [name, c] of srcConstraints) {
            if (!tgtConstraints.has(name)) {
                constraintDiffs.push({ op: "add", name, severity: "medium", after: c });
            }
        }
        for (const [name, c] of tgtConstraints) {
            if (!srcConstraints.has(name)) {
                constraintDiffs.push({ op: "drop", name, severity: "medium", before: c });
            }
        }

        // Indexes
        const srcIndexes = new Map(srcDetails.indexes.map(i => [i.name, i]));
        const tgtIndexes = new Map(tgtDetails.indexes.map(i => [i.name, i]));
        for (const [name, ix] of srcIndexes) {
            if (!tgtIndexes.has(name)) {
                indexDiffs.push({ op: "add", name, severity: "low", after: ix });
            }
        }
        for (const [name, ix] of tgtIndexes) {
            if (!srcIndexes.has(name)) {
                indexDiffs.push({ op: "drop", name, severity: "medium", before: ix });
            }
        }

        if (columnDiffs.length + constraintDiffs.length + indexDiffs.length > 0) {
            const allSeverities: DiffSeverity[] = [
                ...columnDiffs.map(c => c.severity),
                ...constraintDiffs.map(c => c.severity),
                ...indexDiffs.map(i => i.severity),
            ];
            diff.tables.push({
                op: "modify",
                schema: srcDetails.schema,
                table: srcDetails.name,
                severity: worstSeverity(allSeverities),
                rowCount: tgtSnap.info.row_count,
                columns: columnDiffs,
                constraints: constraintDiffs,
                indexes: indexDiffs,
                sourceDetails: srcDetails,
                targetDetails: tgtDetails,
            });
        }
    }

    // ── Functions ─────────────────────────────────────────────────────────
    for (const [key, srcFn] of source.functions) {
        if (!target.functions.has(key)) {
            diff.functions.push({
                op: "add",
                schema: extractSchema(key),
                name: srcFn.name,
                arguments: srcFn.arguments,
                severity: "info",
                after: srcFn,
            });
        }
    }
    for (const [key, tgtFn] of target.functions) {
        if (!source.functions.has(key)) {
            diff.functions.push({
                op: "drop",
                schema: extractSchema(key),
                name: tgtFn.name,
                arguments: tgtFn.arguments,
                severity: "medium",
                before: tgtFn,
            });
        }
    }

    // ── Enums / Types ─────────────────────────────────────────────────────
    for (const [key, srcType] of source.types) {
        if (!target.types.has(key)) {
            diff.enums.push({
                op: "add",
                schema: extractSchema(key),
                name: extractName(key),
                kind: srcType?.kind ?? "unknown",
                severity: "info",
                after: srcType,
            });
        } else {
            const tgtType = target.types.get(key);
            // Compare enum values for changes
            const srcLabels = srcType?.enum_labels?.join(",") ?? "";
            const tgtLabels = tgtType?.enum_labels?.join(",") ?? "";
            if (srcLabels !== tgtLabels) {
                diff.enums.push({
                    op: "modify",
                    schema: extractSchema(key),
                    name: extractName(key),
                    kind: srcType?.kind ?? "enum",
                    severity: "medium",
                    before: tgtType,
                    after: srcType,
                });
            }
        }
    }
    for (const [key, tgtType] of target.types) {
        if (!source.types.has(key)) {
            diff.enums.push({
                op: "drop",
                schema: extractSchema(key),
                name: extractName(key),
                kind: tgtType?.kind ?? "unknown",
                severity: "high",
                before: tgtType,
            });
        }
    }

    // ── Counts ────────────────────────────────────────────────────────────
    const allItems = [
        ...diff.tables,
        ...diff.functions,
        ...diff.enums,
    ] as Array<{ severity: DiffSeverity }>;

    diff.totalChanges = allItems.length;
    diff.criticalCount = allItems.filter(i => i.severity === "critical").length;
    diff.highCount = allItems.filter(i => i.severity === "high").length;
    diff.mediumCount = allItems.filter(i => i.severity === "medium").length;
    diff.lowCount = allItems.filter(i => i.severity === "low").length;
    diff.infoCount = allItems.filter(i => i.severity === "info").length;

    return diff;
}

// ─── SQL Generation ─────────────────────────────────────────────────────────

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function colDef(col: ColumnInfo): string {
    let def = `${quoteIdent(col.name)} ${col.data_type}`;
    if (!col.is_nullable) def += " NOT NULL";
    if (col.column_default !== null) def += ` DEFAULT ${col.column_default}`;
    return def;
}

/**
 * Extract sequence name from a column default expression like
 * nextval('schema.seq_name'::regclass) or nextval('seq_name'::regclass)
 */
function extractSequenceName(defaultExpr: string | null): string | null {
    if (!defaultExpr) return null;
    const m = defaultExpr.match(/nextval\('([^']+)'(?:::regclass)?\)/i);
    return m ? m[1] : null;
}

/**
 * Collect all sequences referenced by table column defaults and generate
 * CREATE SEQUENCE IF NOT EXISTS statements.
 */
function generateSequenceStatements(tables: TableDiff[]): string[] {
    const seen = new Set<string>();
    const stmts: string[] = [];
    for (const t of tables) {
        const details = t.sourceDetails ?? t.targetDetails;
        if (!details) continue;
        for (const col of details.columns) {
            const seq = extractSequenceName(col.column_default);
            if (!seq || seen.has(seq)) continue;
            seen.add(seq);
            const parts = seq.split(".");
            const quoted = parts.length === 2
                ? `${quoteIdent(parts[0])}.${quoteIdent(parts[1])}`
                : quoteIdent(seq);
            stmts.push(`CREATE SEQUENCE IF NOT EXISTS ${quoted};`);
        }
    }
    return stmts;
}

/**
 * Strip CONCURRENTLY from index DDL — required when running inside a transaction
 * (sandbox/dry-run uses BEGIN…ROLLBACK).
 */
function stripConcurrently(def: string): string {
    return def.replace(/\bCONCURRENTLY\b\s*/gi, "");
}

function generateCreateTable(details: TableDetails): string {
    const lines: string[] = [];
    const schema = quoteIdent(details.schema);
    const table = quoteIdent(details.name);

    const colLines = details.columns.map(c => `    ${colDef(c)}`);

    const pk = details.constraints.find(c => c.constraint_type === "p");
    if (pk) {
        colLines.push(`    CONSTRAINT ${quoteIdent(pk.name)} PRIMARY KEY (${pk.columns.map(quoteIdent).join(", ")})`);
    }
    for (const c of details.constraints.filter(c => c.constraint_type === "u")) {
        colLines.push(`    CONSTRAINT ${quoteIdent(c.name)} UNIQUE (${c.columns.map(quoteIdent).join(", ")})`);
    }
    for (const c of details.constraints.filter(c => c.constraint_type === "c" && c.check_clause)) {
        colLines.push(`    CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.check_clause})`);
    }

    lines.push(`CREATE TABLE IF NOT EXISTS ${schema}.${table} (`);
    lines.push(colLines.join(",\n"));
    lines.push(`);`);

    for (const c of details.constraints.filter(c => c.constraint_type === "f")) {
        const fkCols = c.columns.map(quoteIdent).join(", ");
        const ftParts = (c.foreign_table ?? "").split(".");
        const fkRef = ftParts.length === 2
            ? `${quoteIdent(ftParts[0])}.${quoteIdent(ftParts[1])}`
            : quoteIdent(c.foreign_table ?? "");
        const fkRefCols = (c.foreign_columns ?? []).map(quoteIdent).join(", ");
        lines.push(`ALTER TABLE ${schema}.${table} ADD CONSTRAINT ${quoteIdent(c.name)} FOREIGN KEY (${fkCols}) REFERENCES ${fkRef} (${fkRefCols});`);
    }

    for (const ix of details.indexes.filter(i => !i.is_primary)) {
        if (ix.definition) {
            // Strip CONCURRENTLY — can't be used inside a transaction
            lines.push(`${stripConcurrently(ix.definition)};`);
        }
    }

    return lines.join("\n");
}

export function generateForwardSQL(diff: MigrationDiff): string {
    const sections: string[] = [];

    const addedTables = diff.tables.filter(t => t.op === "add" && t.sourceDetails);
    const addedEnums = diff.enums.filter(e => e.op === "add");
    const droppedEnums = diff.enums.filter(e => e.op === "drop");
    const modifiedEnums = diff.enums.filter(e => e.op === "modify");

    // 1. ENUM / TYPE creation FIRST — tables may reference custom types
    if (addedEnums.length + droppedEnums.length + modifiedEnums.length > 0) {
        sections.push("-- ═══════════════════════════════════════");
        sections.push("-- ENUM / TYPE CHANGES");
        sections.push("-- ═══════════════════════════════════════");
        for (const e of addedEnums) {
            if (e.after?.kind === "enum" && e.after.enum_labels) {
                const labels = e.after.enum_labels.map(l => `'${l.replace(/'/g, "''")}'`).join(", ");
                sections.push(`CREATE TYPE ${quoteIdent(e.schema)}.${quoteIdent(e.name)} AS ENUM (${labels});`);
            }
        }
        for (const e of modifiedEnums) {
            if (e.after?.kind === "enum" && e.after.enum_labels && e.before?.enum_labels) {
                const newLabels = e.after.enum_labels.filter(l => !e.before!.enum_labels!.includes(l));
                for (const label of newLabels) {
                    sections.push(`ALTER TYPE ${quoteIdent(e.schema)}.${quoteIdent(e.name)} ADD VALUE IF NOT EXISTS '${label.replace(/'/g, "''")}';`);
                }
            }
        }
        for (const e of droppedEnums) {
            sections.push(`DROP TYPE IF EXISTS ${quoteIdent(e.schema)}.${quoteIdent(e.name)};`);
        }
    }

    // 2. SEQUENCES — must exist before tables that reference them via nextval()
    if (addedTables.length > 0) {
        const seqStmts = generateSequenceStatements(addedTables);
        if (seqStmts.length > 0) {
            sections.push("\n-- ═══════════════════════════════════════");
            sections.push("-- CREATE SEQUENCES");
            sections.push("-- ═══════════════════════════════════════");
            sections.push(...seqStmts);
        }
    }

    // 3. ADD TABLES
    if (addedTables.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ADD TABLES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of addedTables) {
            sections.push(`\n-- Table: ${t.schema}.${t.table}`);
            sections.push(generateCreateTable(t.sourceDetails!));
        }
    }

    // 2. Modify existing tables
    const modifiedTables = diff.tables.filter(t => t.op === "modify");
    if (modifiedTables.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ALTER TABLES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of modifiedTables) {
            const qTable = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
            sections.push(`\n-- Table: ${t.schema}.${t.table}`);

            for (const col of t.columns) {
                if (col.op === "add" && col.info) {
                    sections.push(`ALTER TABLE ${qTable} ADD COLUMN IF NOT EXISTS ${colDef(col.info)};`);
                } else if (col.op === "drop") {
                    sections.push(`-- WARNING: Data loss — ${col.column} has existing data`);
                    sections.push(`ALTER TABLE ${qTable} DROP COLUMN IF EXISTS ${quoteIdent(col.column)};`);
                } else if (col.op === "modify" && col.before && col.after) {
                    if (col.before.data_type !== col.after.data_type) {
                        sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} TYPE ${col.after.data_type} USING ${quoteIdent(col.column)}::${col.after.data_type};`);
                    }
                    if (col.before.is_nullable !== col.after.is_nullable) {
                        if (!col.after.is_nullable) {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} SET NOT NULL;`);
                        } else {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} DROP NOT NULL;`);
                        }
                    }
                    if (col.before.column_default !== col.after.column_default) {
                        if (col.after.column_default !== null) {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} SET DEFAULT ${col.after.column_default};`);
                        } else {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} DROP DEFAULT;`);
                        }
                    }
                }
            }

            for (const c of t.constraints) {
                if (c.op === "add" && c.after) {
                    const constraint = c.after;
                    if (constraint.constraint_type === "u") {
                        sections.push(`ALTER TABLE ${qTable} ADD CONSTRAINT ${quoteIdent(c.name)} UNIQUE (${constraint.columns.map(quoteIdent).join(", ")});`);
                    } else if (constraint.constraint_type === "c" && constraint.check_clause) {
                        sections.push(`ALTER TABLE ${qTable} ADD CONSTRAINT ${quoteIdent(c.name)} CHECK (${constraint.check_clause});`);
                    } else if (constraint.constraint_type === "f") {
                        const fkCols = constraint.columns.map(quoteIdent).join(", ");
                        const ftParts = (constraint.foreign_table ?? "").split(".");
                        const fkRef = ftParts.length === 2
                            ? `${quoteIdent(ftParts[0])}.${quoteIdent(ftParts[1])}`
                            : quoteIdent(constraint.foreign_table ?? "");
                        const fkRefCols = (constraint.foreign_columns ?? []).map(quoteIdent).join(", ");
                        sections.push(`ALTER TABLE ${qTable} ADD CONSTRAINT ${quoteIdent(c.name)} FOREIGN KEY (${fkCols}) REFERENCES ${fkRef} (${fkRefCols});`);
                    }
                } else if (c.op === "drop") {
                    sections.push(`ALTER TABLE ${qTable} DROP CONSTRAINT IF EXISTS ${quoteIdent(c.name)};`);
                }
            }

            for (const ix of t.indexes) {
                if (ix.op === "add" && ix.after?.definition) {
                    // Strip CONCURRENTLY — invalid inside a transaction
                    sections.push(`${stripConcurrently(ix.after.definition)};`);
                } else if (ix.op === "drop") {
                    sections.push(`DROP INDEX IF EXISTS ${quoteIdent(ix.name)};`);
                }
            }
        }
    }

    // 4. Drop tables (at the end, after modifications)
    const droppedTables = diff.tables.filter(t => t.op === "drop");
    if (droppedTables.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- DROP TABLES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of droppedTables) {
            if (t.rowCount > 0) {
                sections.push(`-- WARNING: Table "${t.schema}.${t.table}" has ${t.rowCount.toLocaleString()} rows — data will be permanently lost`);
            }
            sections.push(`DROP TABLE IF EXISTS ${quoteIdent(t.schema)}.${quoteIdent(t.table)};`);
        }
    }

    // 5. Functions
    const addedFunctions = diff.functions.filter(f => f.op === "add");
    const droppedFunctions = diff.functions.filter(f => f.op === "drop");

    if (addedFunctions.length + droppedFunctions.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- FUNCTION CHANGES");
        sections.push("-- ═══════════════════════════════════════");
        for (const f of addedFunctions) {
            sections.push(`-- TODO: Create function ${f.schema}.${f.name}(${f.arguments})`);
            sections.push(`-- (Retrieve full definition from source DB and apply manually)`);
        }
        for (const f of droppedFunctions) {
            sections.push(`DROP FUNCTION IF EXISTS ${quoteIdent(f.schema)}.${quoteIdent(f.name)}(${f.arguments});`);
        }
    }

    if (sections.length === 0) return "-- No schema differences detected";
    return sections.join("\n");
}

export function generateRollbackSQL(diff: MigrationDiff): string {
    const sections: string[] = [];

    // Rollback adds → drop tables that were added
    const addedTables = diff.tables.filter(t => t.op === "add" && t.sourceDetails);
    if (addedTables.length > 0) {
        sections.push("-- ═══════════════════════════════════════");
        sections.push("-- ROLLBACK: DROP ADDED TABLES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of addedTables) {
            sections.push(`DROP TABLE IF EXISTS ${quoteIdent(t.schema)}.${quoteIdent(t.table)};`);
        }
    }

    // Rollback modifications → reverse each alteration
    const modifiedTables = diff.tables.filter(t => t.op === "modify");
    if (modifiedTables.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ROLLBACK: REVERT TABLE CHANGES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of modifiedTables) {
            const qTable = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
            sections.push(`\n-- Table: ${t.schema}.${t.table}`);

            for (const col of t.columns) {
                if (col.op === "add") {
                    sections.push(`ALTER TABLE ${qTable} DROP COLUMN IF EXISTS ${quoteIdent(col.column)};`);
                } else if (col.op === "drop" && col.info) {
                    sections.push(`ALTER TABLE ${qTable} ADD COLUMN IF NOT EXISTS ${colDef(col.info)};`);
                } else if (col.op === "modify" && col.before && col.after) {
                    if (col.before.data_type !== col.after.data_type) {
                        sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} TYPE ${col.before.data_type} USING ${quoteIdent(col.column)}::${col.before.data_type};`);
                    }
                    if (col.before.is_nullable !== col.after.is_nullable) {
                        if (col.before.is_nullable) {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} DROP NOT NULL;`);
                        } else {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} SET NOT NULL;`);
                        }
                    }
                    if (col.before.column_default !== col.after.column_default) {
                        if (col.before.column_default !== null) {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} SET DEFAULT ${col.before.column_default};`);
                        } else {
                            sections.push(`ALTER TABLE ${qTable} ALTER COLUMN ${quoteIdent(col.column)} DROP DEFAULT;`);
                        }
                    }
                }
            }

            for (const c of t.constraints) {
                if (c.op === "add") {
                    sections.push(`ALTER TABLE ${qTable} DROP CONSTRAINT IF EXISTS ${quoteIdent(c.name)};`);
                } else if (c.op === "drop" && c.before) {
                    const constraint = c.before;
                    if (constraint.constraint_type === "u") {
                        sections.push(`ALTER TABLE ${qTable} ADD CONSTRAINT ${quoteIdent(c.name)} UNIQUE (${constraint.columns.map(quoteIdent).join(", ")});`);
                    }
                }
            }

            for (const ix of t.indexes) {
                if (ix.op === "add") {
                    sections.push(`DROP INDEX IF EXISTS ${quoteIdent(ix.name)};`);
                } else if (ix.op === "drop" && ix.before?.definition) {
                    sections.push(`${stripConcurrently(ix.before.definition)};`);
                }
            }
        }
    }

    // Rollback drops → recreate tables that were dropped
    const droppedTables = diff.tables.filter(t => t.op === "drop" && t.targetDetails);
    if (droppedTables.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ROLLBACK: RECREATE DROPPED TABLES");
        sections.push("-- ═══════════════════════════════════════");
        for (const t of droppedTables) {
            sections.push(`\n-- Table: ${t.schema}.${t.table}`);
            sections.push(generateCreateTable(t.targetDetails!));
        }
    }

    // Rollback enums
    const addedEnums = diff.enums.filter(e => e.op === "add");
    const droppedEnums = diff.enums.filter(e => e.op === "drop");
    if (addedEnums.length + droppedEnums.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ROLLBACK: ENUM / TYPE CHANGES");
        sections.push("-- ═══════════════════════════════════════");
        for (const e of addedEnums) {
            sections.push(`DROP TYPE IF EXISTS ${quoteIdent(e.schema)}.${quoteIdent(e.name)};`);
        }
        for (const e of droppedEnums) {
            if (e.before?.kind === "enum" && e.before.enum_labels) {
                const labels = e.before.enum_labels.map(l => `'${l.replace(/'/g, "''")}'`).join(", ");
                sections.push(`CREATE TYPE ${quoteIdent(e.schema)}.${quoteIdent(e.name)} AS ENUM (${labels});`);
            }
        }
    }

    // Rollback functions
    const addedFunctions = diff.functions.filter(f => f.op === "add");
    const droppedFunctions = diff.functions.filter(f => f.op === "drop");
    if (addedFunctions.length + droppedFunctions.length > 0) {
        sections.push("\n-- ═══════════════════════════════════════");
        sections.push("-- ROLLBACK: FUNCTION CHANGES");
        sections.push("-- ═══════════════════════════════════════");
        for (const f of addedFunctions) {
            sections.push(`DROP FUNCTION IF EXISTS ${quoteIdent(f.schema)}.${quoteIdent(f.name)}(${f.arguments});`);
        }
        for (const f of droppedFunctions) {
            sections.push(`-- TODO: Restore function ${f.schema}.${f.name}(${f.arguments}) from backup`);
        }
    }

    if (sections.length === 0) return "-- Nothing to roll back";
    return sections.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractSchema(key: string): string {
    return key.split(".")[0] ?? "";
}

function extractName(key: string): string {
    const parts = key.split(".");
    return parts.slice(1).join(".").split("(")[0] ?? "";
}

export function severityColor(severity: DiffSeverity): string {
    switch (severity) {
        case "critical": return "text-red-400";
        case "high": return "text-orange-400";
        case "medium": return "text-amber-400";
        case "low": return "text-blue-400";
        case "info": return "text-emerald-400";
    }
}

export function severityBg(severity: DiffSeverity): string {
    switch (severity) {
        case "critical": return "bg-red-500/10 border-red-500/20 text-red-400";
        case "high": return "bg-orange-500/10 border-orange-500/20 text-orange-400";
        case "medium": return "bg-amber-500/10 border-amber-500/20 text-amber-400";
        case "low": return "bg-blue-500/10 border-blue-500/20 text-blue-400";
        case "info": return "bg-emerald-500/10 border-emerald-500/20 text-emerald-400";
    }
}

export function opLabel(op: DiffOp): string {
    switch (op) {
        case "add": return "ADD";
        case "drop": return "DROP";
        case "modify": return "ALTER";
    }
}

export function opColor(op: DiffOp): string {
    switch (op) {
        case "add": return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
        case "drop": return "bg-red-500/10 text-red-400 border-red-500/20";
        case "modify": return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    }
}

/**
 * Split a SQL script into individual executable statements, respecting:
 * - Dollar-quoted strings ($$ ... $$)
 * - Single-quoted string literals
 * - Line comments (--)
 * - Block comments (/* ... *\/)
 * Returns only non-empty, non-comment-only statements.
 */
export function splitSqlStatements(sql: string): string[] {
    const stmts: string[] = [];
    let buf = "";
    let i = 0;
    const n = sql.length;

    while (i < n) {
        // Line comment
        if (sql[i] === "-" && sql[i + 1] === "-") {
            const end = sql.indexOf("\n", i);
            buf += end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
            i = end === -1 ? n : end + 1;
            continue;
        }
        // Block comment
        if (sql[i] === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            buf += end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
            i = end === -1 ? n : end + 2;
            continue;
        }
        // Dollar-quote: $$...$$  or  $tag$...$tag$
        if (sql[i] === "$") {
            const tagEnd = sql.indexOf("$", i + 1);
            if (tagEnd !== -1) {
                const tag = sql.slice(i, tagEnd + 1);
                const closeIdx = sql.indexOf(tag, tagEnd + 1);
                if (closeIdx !== -1) {
                    buf += sql.slice(i, closeIdx + tag.length);
                    i = closeIdx + tag.length;
                    continue;
                }
            }
        }
        // Single-quoted string
        if (sql[i] === "'") {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
                if (sql[j] === "'") { j++; break; }
                j++;
            }
            buf += sql.slice(i, j);
            i = j;
            continue;
        }
        // Statement terminator
        if (sql[i] === ";") {
            buf += ";";
            i++;
            const stmt = buf.trim();
            // Only keep if it has non-comment content
            const code = stmt.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
            if (code.length > 1) stmts.push(stmt);
            buf = "";
            continue;
        }
        buf += sql[i];
        i++;
    }
    const remaining = buf.trim();
    if (remaining) {
        const code = remaining.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (code.length > 0) stmts.push(remaining);
    }
    return stmts;
}
