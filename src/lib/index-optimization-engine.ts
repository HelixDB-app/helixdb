/**
 * AI-powered Index Optimization — suggests indexes from table structure and query patterns.
 * Uses Gemini for analysis; outputs structured suggestions with explanations.
 */

import { callGeminiSync } from "@/lib/ai-chat-engine";
import type { GeminiModelId } from "@/lib/ai-chat-engine";
import { resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import { withGeminiLogging } from "@/lib/gemini-logger";
import type { ColumnInfo, IndexStats, QuerySample } from "@/lib/types";

export interface IndexSuggestion {
    columns: string[];
    index_type: string;
    is_unique: boolean;
    where_clause: string | null;
    index_name: string | null;
    explanation: string;
    priority: "high" | "medium" | "low";
}

const SYSTEM_PROMPT = `You are an expert PostgreSQL DBA. Given a table's columns, existing indexes, and optional query samples, suggest new indexes to improve performance.

Rules:
- Output only a single JSON array of suggestions. No markdown, no code fence, no explanation outside the JSON.
- Each suggestion must have: columns (string[]), index_type (one of: BTREE, HASH, GIN, GIST, BRIN, SPGIST), is_unique (boolean), where_clause (string or null for partial index), index_name (string or null for auto), explanation (short clear reason), priority ("high"|"medium"|"low").
- Prefer BTREE unless the column type or query pattern clearly needs GIN (JSONB, arrays, full-text), GIST (geometry), BRIN (large ordered tables), or HASH (exact equality only).
- Do not suggest an index that duplicates an existing one (same columns and type).
- For composite indexes, put equality/filter columns first, then range/sort columns.
- Suggest at most 5 indexes. Only suggest indexes that will clearly help.`;

function buildUserPrompt(
    schema: string,
    table: string,
    columns: ColumnInfo[],
    existingIndexes: IndexStats[],
    querySamples: QuerySample[]
): string {
    const colLines = columns.map(
        (c) => `  - ${c.name} (${c.data_type})${c.is_primary_key ? " PK" : ""}${!c.is_nullable ? " NOT NULL" : ""}`
    );
    const idxLines = existingIndexes.map(
        (i) => `  - ${i.index_name}: ${i.columns.join(", ")} (${i.index_type})${i.is_unique ? " UNIQUE" : ""}`
    );
    const queryLines =
        querySamples.length > 0
            ? querySamples
                  .slice(0, 10)
                  .map(
                      (q) =>
                          `  - [${q.calls} calls, ${(q.mean_exec_time_ms ?? 0).toFixed(1)}ms avg] ${q.query.slice(0, 200)}...`
                  )
            : ["  (No query samples available — suggest based on schema and common patterns.)"];

    return [
        `Schema: ${schema}, Table: ${table}`,
        "",
        "Columns:",
        ...colLines,
        "",
        "Existing indexes:",
        existingIndexes.length ? idxLines.join("\n") : "  (none)",
        "",
        "Sample queries (from pg_stat_statements):",
        ...queryLines,
        "",
        'Output a JSON array of index suggestions only. Example: [{"columns":["user_id"],"index_type":"BTREE","is_unique":false,"where_clause":null,"index_name":null,"explanation":"Speeds up lookups by user_id","priority":"high"}]',
    ].join("\n");
}

function parseSuggestions(raw: string): IndexSuggestion[] {
    let text = raw.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) text = jsonMatch[0];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter(
            (p): p is Record<string, unknown> =>
                p != null &&
                typeof p === "object" &&
                Array.isArray((p as Record<string, unknown>).columns)
        )
        .map((p) => ({
            columns: (p.columns as string[]).filter((c) => typeof c === "string"),
            index_type: String(p.index_type ?? "BTREE").toUpperCase(),
            is_unique: Boolean(p.is_unique),
            where_clause: p.where_clause != null && p.where_clause !== "" ? String(p.where_clause) : null,
            index_name: p.index_name != null && p.index_name !== "" ? String(p.index_name) : null,
            explanation: String(p.explanation ?? ""),
            priority: ["high", "medium", "low"].includes(String(p.priority)) ? (p.priority as "high" | "medium" | "low") : "medium",
        }))
        .filter((s) => s.columns.length > 0);
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: resolveGeminiApiKey(settings.geminiApiKey),
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

/**
 * Get AI index suggestions for a table from its structure, existing indexes, and query samples.
 */
export async function getIndexSuggestions(
    schema: string,
    table: string,
    columns: ColumnInfo[],
    existingIndexes: IndexStats[],
    querySamples: QuerySample[],
    options: { model?: GeminiModelId; signal?: AbortSignal }
): Promise<IndexSuggestion[]> {
    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options.model ?? model;
    if (!apiKey) {
        throw new Error("Add your Gemini API key in Settings → AI to use AI index optimization.");
    }
    const userPrompt = buildUserPrompt(schema, table, columns, existingIndexes, querySamples);
    const response = await withGeminiLogging(
        () => callGeminiSync(
            modelId,
            apiKey,
            [{ role: "user", parts: [{ text: userPrompt }] }],
            SYSTEM_PROMPT,
            options.signal,
            { maxOutputTokens: 2048 }
        ),
        { model: modelId, featureType: "index-optimization", endpoint: "generateContent" }
    );
    return parseSuggestions(response);
}
