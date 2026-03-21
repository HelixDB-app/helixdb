import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import { useSettingsStore } from "@/stores/settings-store";
import type { SchemaImportResult } from "@/lib/tauri";

const SCHEMA_DOC_SYSTEM_PROMPT = `You write clear, professional PostgreSQL schema documentation in Markdown.

Output rules:
- Return ONLY the markdown document. No code fences around the whole output.
- Use headings: # for schema title, ## for sections (Tables, Views, Functions, Indexes, Triggers, Sequences).
- For each table: name, brief purpose (infer from name/columns/comment if present), and list key columns or relationships if obvious from DDL.
- For views: name, whether materialized, and a one-line description.
- For functions: name, arguments, return type, and a one-line description.
- For indexes: name, table, unique/primary if applicable, and purpose (lookup, constraint, etc.).
- For triggers and sequences: name and brief purpose.
- Keep descriptions concise. Do not invent business logic not evident from the schema.
- Use bullet or numbered lists where appropriate. Use \`code\` for object names.`;

const DDL_MAX_CHARS = 800;

function truncateDdl(ddl: string): string {
    if (!ddl || ddl.length <= DDL_MAX_CHARS) return ddl;
    return ddl.slice(0, DDL_MAX_CHARS) + "\n-- ... (truncated)";
}

function buildSchemaContext(schema: SchemaImportResult): string {
    const lines: string[] = [];

    lines.push(`Schema: ${schema.schema}`);
    lines.push("");

    if (schema.tables.length > 0) {
        lines.push("--- TABLES ---");
        for (const t of schema.tables) {
            const rows =
                typeof t.estimated_rows === "number" && t.estimated_rows > 0
                    ? ` (~${t.estimated_rows.toLocaleString()} rows)`
                    : "";
            const comment = t.comment ? ` | comment: ${t.comment}` : "";
            lines.push(`Table: ${t.name}${rows}${comment}`);
            lines.push(truncateDdl(t.ddl ?? ""));
            lines.push("");
        }
    }

    if (schema.views.length > 0) {
        lines.push("--- VIEWS ---");
        for (const v of schema.views) {
            const kind = v.is_materialized ? "Materialized View" : "View";
            lines.push(`${kind}: ${v.name}`);
            lines.push(truncateDdl(v.ddl ?? ""));
            lines.push("");
        }
    }

    if (schema.functions.length > 0) {
        lines.push("--- FUNCTIONS ---");
        for (const fn of schema.functions) {
            lines.push(`${fn.kind}: ${fn.name}(${fn.arguments}) -> ${fn.return_type}`);
            lines.push(truncateDdl(fn.ddl ?? ""));
            lines.push("");
        }
    }

    const nonPkIndexes = schema.indexes.filter((i) => !i.is_primary);
    if (nonPkIndexes.length > 0) {
        lines.push("--- INDEXES (non-PK) ---");
        for (const idx of nonPkIndexes) {
            const u = idx.is_unique ? " UNIQUE" : "";
            lines.push(`Index${u}: ${idx.name} on table ${idx.table_name}`);
            lines.push(truncateDdl(idx.ddl ?? ""));
            lines.push("");
        }
    }

    if (schema.triggers.length > 0) {
        lines.push("--- TRIGGERS ---");
        for (const tr of schema.triggers) {
            lines.push(`Trigger: ${tr.name} on ${tr.table_name}`);
            lines.push(truncateDdl(tr.ddl ?? ""));
            lines.push("");
        }
    }

    if (schema.sequences.length > 0) {
        lines.push("--- SEQUENCES ---");
        for (const seq of schema.sequences) {
            lines.push(`Sequence: ${seq.name}`);
            lines.push(truncateDdl(seq.ddl ?? ""));
            lines.push("");
        }
    }

    return lines.join("\n");
}

export interface GenerateSchemaDocOptions {
    signal?: AbortSignal;
    model?: GeminiModelId;
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: settings.geminiApiKey ?? "",
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

/**
 * Generate a single markdown documentation document for an imported schema.
 * Uses Gemini to analyze tables, views, functions, indexes, triggers, and sequences.
 * Returns raw markdown; caller should convert to doc JSON and persist.
 */
export async function generateSchemaDocContent(
    schema: SchemaImportResult,
    databaseName: string,
    options: GenerateSchemaDocOptions = {}
): Promise<string> {
    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options.model ?? model;
    if (!apiKey) {
        throw new Error("Add your Gemini API key in Settings → AI to generate schema documentation.");
    }

    const context = buildSchemaContext(schema);
    const userPrompt = [
        `Database: ${databaseName}`,
        ``,
        `Write schema documentation for the following PostgreSQL schema. Use the DDL and metadata below.`,
        ``,
        `CONTEXT:`,
        context,
    ].join("\n");

    const response = await withGeminiLogging(
        () =>
            callGeminiSync(
                modelId,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                SCHEMA_DOC_SYSTEM_PROMPT,
                options.signal,
                { maxOutputTokens: 8192 }
            ),
        { model: modelId, featureType: "schema-doc", endpoint: "generateContent" }
    );

    return response?.trim() ?? "";
}
