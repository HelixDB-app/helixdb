import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { useSettingsStore } from "@/stores/settings-store";
import type {
    DocumentationCommentPatch,
    DocumentationContext,
    DocumentationTable,
    DocumentationColumn,
    DocumentationIndex,
} from "@/lib/types";

export type DocumentationScope =
    | { kind: "database" }
    | { kind: "schema"; schema: string }
    | { kind: "table"; schema: string; table: string };

export interface GenerateDocumentationOptions {
    includeIndexes?: boolean;
    model?: GeminiModelId;
    signal?: AbortSignal;
}

interface DocumentationTarget extends DocumentationCommentPatch {
    id: string;
}

export interface GeneratedDocumentationItem extends DocumentationTarget {
    comment: string;
}

const DOC_WRITER_SYSTEM_PROMPT = `You generate PostgreSQL COMMENT ON documentation.

Output format rules:
- Return ONLY valid JSON.
- Shape must be: {"items":[{"id":"target-id","comment":"..."}]}
- Do not include markdown fences.
- Use only target ids provided in INPUT_JSON.targets.
- Return one item per target.

Writing rules:
- Keep comments concise, specific, and implementation-focused.
- Do not invent business rules that are not inferable from schema.
- Mention relationships only when foreign keys/index structure clearly show them.
- For table comments: summarize purpose and key relationships.
- For column comments: explain meaning and usage.
- For index comments: explain constraint/performance intent.
- Max ~320 characters per comment.`;

function hasComment(value: string | null | undefined): boolean {
    return Boolean(value && value.trim().length > 0);
}

function tableKey(schema: string, table: string): string {
    return `${schema}.${table}`.toLowerCase();
}

function applyScopeToTables(tables: DocumentationTable[], scope: DocumentationScope): DocumentationTable[] {
    if (scope.kind === "database") return tables;
    if (scope.kind === "schema") return tables.filter((t) => t.schema === scope.schema);
    return tables.filter((t) => t.schema === scope.schema && t.table === scope.table);
}

function buildTargets(
    context: DocumentationContext,
    scope: DocumentationScope,
    includeIndexes: boolean
): DocumentationTarget[] {
    const scopedTables = applyScopeToTables(context.tables, scope);
    const scopedKeys = new Set(scopedTables.map((t) => tableKey(t.schema, t.table)));

    const targets: DocumentationTarget[] = [];

    for (const t of scopedTables) {
        if (!hasComment(t.comment)) {
            targets.push({
                id: `table|${t.schema}|${t.table}`,
                kind: "table",
                schema: t.schema,
                table: t.table,
                comment: "",
            });
        }
    }

    for (const c of context.columns) {
        if (!scopedKeys.has(tableKey(c.schema, c.table))) continue;
        if (hasComment(c.comment)) continue;
        targets.push({
            id: `column|${c.schema}|${c.table}|${c.name}`,
            kind: "column",
            schema: c.schema,
            table: c.table,
            column: c.name,
            comment: "",
        });
    }

    if (includeIndexes) {
        for (const i of context.indexes) {
            if (!scopedKeys.has(tableKey(i.schema, i.table))) continue;
            if (hasComment(i.comment)) continue;
            targets.push({
                id: `index|${i.schema}|${i.table}|${i.name}`,
                kind: "index",
                schema: i.schema,
                table: i.table,
                index: i.name,
                comment: "",
            });
        }
    }

    return targets;
}

function buildCompactContext(
    tables: DocumentationTable[],
    columns: DocumentationColumn[],
    indexes: DocumentationIndex[]
): string {
    const byTable = new Map<string, { table: DocumentationTable; cols: DocumentationColumn[]; idx: DocumentationIndex[] }>();

    for (const t of tables) {
        byTable.set(tableKey(t.schema, t.table), { table: t, cols: [], idx: [] });
    }
    for (const c of columns) {
        const key = tableKey(c.schema, c.table);
        const bucket = byTable.get(key);
        if (bucket) bucket.cols.push(c);
    }
    for (const i of indexes) {
        const key = tableKey(i.schema, i.table);
        const bucket = byTable.get(key);
        if (bucket) bucket.idx.push(i);
    }

    const lines: string[] = [];
    for (const bucket of byTable.values()) {
        const { table, cols, idx } = bucket;
        lines.push(`TABLE ${table.schema}.${table.table} [${table.table_type}]`);
        if (hasComment(table.comment)) {
            lines.push(`  existing_table_comment: ${String(table.comment).replace(/\s+/g, " ").trim()}`);
        }

        for (const c of cols.sort((a, b) => a.ordinal_position - b.ordinal_position)) {
            const flags: string[] = [];
            if (c.is_primary_key) flags.push("pk");
            if (!c.is_nullable) flags.push("not-null");
            if (c.foreign_key_target) flags.push(`fk->${c.foreign_key_target}`);
            if (c.column_default) flags.push(`default=${c.column_default}`);
            if (hasComment(c.comment)) flags.push("has-comment");
            const flagText = flags.length ? ` {${flags.join(", ")}}` : "";
            lines.push(`  COL ${c.name}: ${c.data_type}${flagText}`);
        }

        for (const i of idx) {
            const flags: string[] = [];
            if (i.is_primary) flags.push("primary");
            if (i.is_unique && !i.is_primary) flags.push("unique");
            if (hasComment(i.comment)) flags.push("has-comment");
            const flagText = flags.length ? ` {${flags.join(", ")}}` : "";
            lines.push(`  IDX ${i.name}: ${i.index_type} (${i.columns.join(", ")})${flagText}`);
        }
    }

    return lines.join("\n");
}

function stripCodeFences(text: string): string {
    return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseItems(raw: string): { id: string; comment: string }[] {
    const trimmed = stripCodeFences(raw);
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
            return (parsed as { items: unknown[] }).items
                .filter((item): item is { id: unknown; comment: unknown } => item != null && typeof item === "object")
                .map((item) => ({
                    id: String((item as { id: unknown }).id ?? "").trim(),
                    comment: String((item as { comment: unknown }).comment ?? "").trim(),
                }))
                .filter((item) => item.id.length > 0 && item.comment.length > 0);
        }
    } catch {
        // fallback below
    }

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
        throw new Error("AI Doc Writer returned non-JSON output.");
    }

    const parsed = JSON.parse(objectMatch[0]) as { items?: Array<{ id?: unknown; comment?: unknown }> };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items
        .map((item) => ({
            id: String(item.id ?? "").trim(),
            comment: String(item.comment ?? "").trim(),
        }))
        .filter((item) => item.id.length > 0 && item.comment.length > 0);
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: settings.geminiApiKey ?? "",
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

export function getUndocumentedTargets(
    context: DocumentationContext,
    scope: DocumentationScope,
    includeIndexes = true
): DocumentationCommentPatch[] {
    return buildTargets(context, scope, includeIndexes).map((target) => ({
        kind: target.kind,
        schema: target.schema,
        table: target.table ?? null,
        column: target.column ?? null,
        index: target.index ?? null,
        comment: target.comment,
    }));
}

export async function generateDocumentationComments(
    context: DocumentationContext,
    scope: DocumentationScope,
    options: GenerateDocumentationOptions = {}
): Promise<GeneratedDocumentationItem[]> {
    const includeIndexes = options.includeIndexes ?? true;
    const targets = buildTargets(context, scope, includeIndexes);
    if (targets.length === 0) {
        return [];
    }

    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options.model ?? model;
    if (!apiKey) {
        throw new Error("Add your Gemini API key in Settings → AI to use AI Doc Writer.");
    }

    const scopedTables = applyScopeToTables(context.tables, scope);
    const scopedKeys = new Set(scopedTables.map((t) => tableKey(t.schema, t.table)));
    const scopedColumns = context.columns.filter((c) => scopedKeys.has(tableKey(c.schema, c.table)));
    const scopedIndexes = context.indexes.filter((i) => scopedKeys.has(tableKey(i.schema, i.table)));

    const inputPayload = {
        database_name: context.database_name,
        scope,
        tables_total: scopedTables.length,
        columns_total: scopedColumns.length,
        indexes_total: scopedIndexes.length,
        targets: targets.map((t) => ({
            id: t.id,
            kind: t.kind,
            schema: t.schema,
            table: t.table ?? null,
            column: t.column ?? null,
            index: t.index ?? null,
        })),
        schema_context: buildCompactContext(scopedTables, scopedColumns, scopedIndexes),
    };

    const userPrompt = [
        "Generate documentation comments for all targets.",
        "Return exactly one item per target id.",
        "Do not include comments for objects not listed in targets.",
        "",
        `INPUT_JSON:\n${JSON.stringify(inputPayload)}`,
    ].join("\n");

    const response = await callGeminiSync(
        modelId,
        apiKey,
        [{ role: "user", parts: [{ text: userPrompt }] }],
        DOC_WRITER_SYSTEM_PROMPT,
        options.signal,
        { maxOutputTokens: 8192 }
    );

    const parsed = parseItems(response);
    const byId = new Map(targets.map((t) => [t.id, t]));

    const out: GeneratedDocumentationItem[] = [];
    for (const item of parsed) {
        const target = byId.get(item.id);
        if (!target) continue;
        out.push({ ...target, comment: item.comment });
    }

    const missingIds = targets
        .map((t) => t.id)
        .filter((id) => !out.some((item) => item.id === id));

    if (missingIds.length > 0) {
        throw new Error(`AI Doc Writer did not return comments for ${missingIds.length} target(s). Try again.`);
    }

    return out;
}
