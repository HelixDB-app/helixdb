import rawTemplateCatalog from "@/data/schema-designer-templates.json";
import type { SchemaDesignerColumn, SchemaDesignerIndex, SchemaDesignerTable } from "@/lib/types";

// ── Raw Catalog Types ────────────────────────────────────────────────────────

export interface TemplateForeignKeyRef {
    target_table: string;
    target_column: string;
}

export interface SchemaTemplateColumn {
    name: string;
    data_type: string;
    nullable: boolean;
    default_value: string | null;
    is_primary_key: boolean;
    unique?: boolean;
    foreign_key?: TemplateForeignKeyRef | null;
}

export interface SchemaTemplateIndex {
    name: string;
    columns: string[];
    unique: boolean;
    method: string;
}

export interface SchemaTemplateTable {
    name: string;
    columns: SchemaTemplateColumn[];
    indexes?: SchemaTemplateIndex[];
}

export interface SchemaTemplateEntry {
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    tables: SchemaTemplateTable[];
}

export interface SchemaTemplateCatalog {
    version: number;
    updated_at: string;
    full_schema_templates: SchemaTemplateEntry[];
    module_templates: SchemaTemplateEntry[];
}

export type TemplateKind = "full" | "module";

export interface PreparedSchemaTemplate extends SchemaTemplateEntry {
    kind: TemplateKind;
    tableCount: number;
    columnCount: number;
    searchText: string;
}

interface PreparedCatalog {
    version: number;
    updatedAt: string;
    full: PreparedSchemaTemplate[];
    modules: PreparedSchemaTemplate[];
    fullCategories: string[];
    moduleCategories: string[];
}

interface PendingColumn {
    sourceForeignKey: TemplateForeignKeyRef | null;
    column: SchemaDesignerColumn;
}

interface PendingTable {
    table: SchemaDesignerTable;
    columns: PendingColumn[];
}

export interface InstantiateTemplateOptions {
    existingTables?: SchemaDesignerTable[];
    mode?: "replace" | "append";
}

export interface InstantiateTemplateResult {
    tables: SchemaDesignerTable[];
    insertedCount: number;
    renamedTables: { from: string; to: string }[];
    unresolvedForeignKeys: number;
}

const rawCatalog = rawTemplateCatalog as SchemaTemplateCatalog;

function genId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeName(value: string, fallback: string): string {
    const cleaned = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    const base = cleaned || fallback;
    return /^[0-9]/.test(base) ? `n_${base}` : base;
}

function ensureUniqueName(base: string, used: Set<string>): string {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }

    let n = 2;
    let candidate = `${base}_${n}`;
    while (used.has(candidate)) {
        n += 1;
        candidate = `${base}_${n}`;
    }
    used.add(candidate);
    return candidate;
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function mapTablesByName(tables: SchemaDesignerTable[]): Map<string, SchemaDesignerTable> {
    const byName = new Map<string, SchemaDesignerTable>();
    for (const table of tables) {
        const key = normalizeName(table.name, table.name);
        if (!byName.has(key)) byName.set(key, table);
    }
    return byName;
}

function buildTemplateSearchText(template: SchemaTemplateEntry): string {
    const tableNames = template.tables.map(t => t.name);
    const columnNames = template.tables.flatMap(t => t.columns.map(c => c.name));
    return [
        template.name,
        template.description,
        template.category,
        ...template.tags,
        ...tableNames,
        ...columnNames,
    ]
        .join(" ")
        .toLowerCase();
}

function normalizeTemplateEntry(entry: SchemaTemplateEntry, kind: TemplateKind): PreparedSchemaTemplate {
    const tags = uniqueStrings(entry.tags ?? []);
    const tableCount = entry.tables.length;
    const columnCount = entry.tables.reduce((sum, table) => sum + table.columns.length, 0);

    return {
        ...entry,
        category: normalizeName(entry.category || "general", "general"),
        tags,
        kind,
        tableCount,
        columnCount,
        searchText: buildTemplateSearchText({ ...entry, tags }),
    };
}

function toPreparedCatalog(catalog: SchemaTemplateCatalog): PreparedCatalog {
    const full = (catalog.full_schema_templates ?? []).map(template => normalizeTemplateEntry(template, "full"));
    const modules = (catalog.module_templates ?? []).map(template => normalizeTemplateEntry(template, "module"));

    return {
        version: catalog.version,
        updatedAt: catalog.updated_at,
        full,
        modules,
        fullCategories: uniqueStrings(full.map(t => t.category)).sort(),
        moduleCategories: uniqueStrings(modules.map(t => t.category)).sort(),
    };
}

const TEMPLATE_CATALOG: PreparedCatalog = toPreparedCatalog(rawCatalog);

export function getSchemaTemplateCatalog(): PreparedCatalog {
    return TEMPLATE_CATALOG;
}

export function filterTemplates(
    templates: PreparedSchemaTemplate[],
    query: string,
    category: string
): PreparedSchemaTemplate[] {
    const q = query.trim().toLowerCase();
    const c = category.trim().toLowerCase();

    return templates.filter((template) => {
        if (c && c !== "all" && template.category !== c) return false;
        if (!q) return true;
        return template.searchText.includes(q);
    });
}

function computeInsertAnchor(existingTables: SchemaDesignerTable[]): { x: number; y: number } {
    const positioned = existingTables.filter(t => t.position);
    if (positioned.length === 0) {
        const x = 48;
        const y = 48 + Math.ceil(existingTables.length / 4) * 192;
        return { x, y };
    }

    const maxY = Math.max(...positioned.map(t => t.position!.y));
    return { x: 48, y: maxY + 220 };
}

function assignTablePositions(
    tables: SchemaDesignerTable[],
    mode: "replace" | "append",
    existingTables: SchemaDesignerTable[]
): SchemaDesignerTable[] {
    const anchor = mode === "replace" ? { x: 48, y: 48 } : computeInsertAnchor(existingTables);
    const columnsPerRow = 4;
    const xStep = 288;
    const yStep = 192;

    return tables.map((table, index) => ({
        ...table,
        position: {
            x: anchor.x + (index % columnsPerRow) * xStep,
            y: anchor.y + Math.floor(index / columnsPerRow) * yStep,
        },
    }));
}

function resolveForeignKey(
    source: TemplateForeignKeyRef,
    tableNameMap: Map<string, string>,
    insertedByName: Map<string, SchemaDesignerTable>,
    existingByName: Map<string, SchemaDesignerTable>
): { target_table_id: string; target_column_id: string } | null {
    const targetTemplateName = normalizeName(source.target_table, source.target_table);
    const resolvedName = tableNameMap.get(targetTemplateName) ?? targetTemplateName;
    const targetTable = insertedByName.get(resolvedName) ?? existingByName.get(resolvedName);
    if (!targetTable) return null;

    const targetColumnName = normalizeName(source.target_column, source.target_column);
    const targetColumn = targetTable.columns.find(c => normalizeName(c.name, c.name) === targetColumnName);
    if (!targetColumn) return null;

    return {
        target_table_id: targetTable.id,
        target_column_id: targetColumn.id,
    };
}

function instantiateTemplateTables(
    template: PreparedSchemaTemplate,
    options?: InstantiateTemplateOptions
): InstantiateTemplateResult {
    const existingTables = options?.existingTables ?? [];
    const mode = options?.mode ?? "replace";

    const existingByName = mapTablesByName(existingTables);
    const usedTableNames = new Set(mode === "append" ? [...existingByName.keys()] : []);

    const tableNameMap = new Map<string, string>();
    const renamedTables: { from: string; to: string }[] = [];

    const pendingTables: PendingTable[] = template.tables.map((source, tableIndex) => {
        const originalName = normalizeName(source.name, `table_${tableIndex + 1}`);
        const runtimeName = ensureUniqueName(originalName, usedTableNames);
        tableNameMap.set(originalName, runtimeName);

        if (originalName !== runtimeName) {
            renamedTables.push({ from: originalName, to: runtimeName });
        }

        const usedColumnNames = new Set<string>();
        const columnIdByName = new Map<string, string>();

        const pendingColumns = source.columns.map((rawColumn, colIndex) => {
            const originalColumnName = normalizeName(rawColumn.name, `column_${colIndex + 1}`);
            const runtimeColumnName = ensureUniqueName(originalColumnName, usedColumnNames);
            const columnId = genId();
            columnIdByName.set(originalColumnName, columnId);

            const column: SchemaDesignerColumn = {
                id: columnId,
                name: runtimeColumnName,
                data_type: rawColumn.data_type,
                nullable: rawColumn.nullable,
                default_value: rawColumn.default_value,
                is_primary_key: rawColumn.is_primary_key,
                unique: rawColumn.unique,
                foreign_key: null,
            };

            return {
                sourceForeignKey: rawColumn.foreign_key ?? null,
                column,
            };
        });

        const indexNameUsed = new Set<string>();
        const indexes: SchemaDesignerIndex[] = (source.indexes ?? [])
            .map((index, indexIndex) => {
                const rawIndexName = normalizeName(index.name, `${runtimeName}_idx_${indexIndex + 1}`);
                const indexName = ensureUniqueName(rawIndexName, indexNameUsed);
                const columns = index.columns
                    .map((name) => columnIdByName.get(normalizeName(name, name)))
                    .filter((id): id is string => Boolean(id));

                if (columns.length === 0) return null;

                return {
                    id: genId(),
                    name: indexName,
                    columns,
                    unique: index.unique,
                    method: index.method,
                };
            })
            .filter((index): index is SchemaDesignerIndex => Boolean(index));

        return {
            table: {
                id: genId(),
                name: runtimeName,
                columns: pendingColumns.map(c => c.column),
                indexes,
                position: null,
            },
            columns: pendingColumns,
        };
    });

    const insertedTables = pendingTables.map(t => t.table);
    const insertedByName = mapTablesByName(insertedTables);

    let unresolvedForeignKeys = 0;
    for (const pendingTable of pendingTables) {
        for (const pendingColumn of pendingTable.columns) {
            const sourceForeignKey = pendingColumn.sourceForeignKey;
            if (!sourceForeignKey) continue;

            const resolvedForeignKey = resolveForeignKey(
                sourceForeignKey,
                tableNameMap,
                insertedByName,
                existingByName
            );

            if (!resolvedForeignKey) {
                unresolvedForeignKeys += 1;
                continue;
            }

            pendingColumn.column.foreign_key = resolvedForeignKey;
        }
    }

    return {
        tables: assignTablePositions(insertedTables, mode, existingTables),
        insertedCount: insertedTables.length,
        renamedTables,
        unresolvedForeignKeys,
    };
}

export function instantiateFullSchemaTemplate(
    template: PreparedSchemaTemplate
): InstantiateTemplateResult {
    return instantiateTemplateTables(template, { mode: "replace" });
}

export function instantiateModuleTemplate(
    template: PreparedSchemaTemplate,
    existingTables: SchemaDesignerTable[]
): InstantiateTemplateResult {
    return instantiateTemplateTables(template, {
        mode: "append",
        existingTables,
    });
}
