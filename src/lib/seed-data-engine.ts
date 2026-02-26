/**
 * AI-powered Data Seeding — generates realistic sample rows from table schema.
 * Uses Gemini to produce JSON rows; validates and returns typed row data.
 */

import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { useSettingsStore } from "@/stores/settings-store";
import type { ColumnInfo, TableDetails } from "@/lib/types";

export type SeedDataRow = Record<string, string | null>;

const SYSTEM_PROMPT = `You are a database expert. Given a PostgreSQL table schema, generate realistic sample data.

Rules:
- Output ONLY a single JSON array of objects. No markdown, no code fence, no explanation outside the JSON.
- Each object has keys = column names (exact spelling/case from the schema). Values are strings or null.
- For nullable columns you may use null. For NOT NULL columns always provide a string value.
- Generate realistic, consistent data: proper names, emails, dates (ISO 8601), integers, decimals, booleans as "true"/"false", UUIDs as standard format.
- For serial/identity columns omit the key or use a plausible integer if the schema says it's not auto-generated.
- For foreign key columns use plausible reference values (e.g. integer IDs, UUIDs) that could exist in the referenced table.
- Respect data types: numbers as string digits, booleans as "true"/"false", timestamps as ISO strings, etc.`;

function buildSchemaForSeed(details: TableDetails): string {
    const { columns, constraints } = details;
    const fkByColumn = new Map<string, { refTable: string; refCol: string }>();
    for (const c of constraints) {
        if (c.constraint_type === "f" && c.columns.length > 0 && c.foreign_table && c.foreign_columns?.length) {
            fkByColumn.set(c.columns[0], { refTable: c.foreign_table, refCol: c.foreign_columns[0] });
        }
    }
    const lines = columns.map((col) => {
        const flags: string[] = [];
        if (col.is_primary_key) flags.push("pk");
        const fk = fkByColumn.get(col.name);
        if (fk) flags.push(`fk→${fk.refTable}.${fk.refCol}`);
        if (col.is_nullable) flags.push("null");
        const type = col.data_type.toLowerCase().replace("character varying", "varchar");
        const flagStr = flags.length ? `,${flags.join(",")}` : "";
        return `  - ${col.name}: ${type}${flagStr}`;
    });
    return `Table: ${details.schema}.${details.name}\nColumns:\n${lines.join("\n")}`;
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: settings.geminiApiKey ?? "",
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

function coerceValue(
    raw: unknown,
    col: ColumnInfo
): string | null {
    if (raw === null || raw === undefined) return col.is_nullable ? null : "";
    const s = String(raw).trim();
    if (s === "" || s.toLowerCase() === "null") return col.is_nullable ? null : "";
    const t = col.data_type.toLowerCase();
    if (t.includes("int") || t === "smallint" || t === "bigint" || t === "serial" || t === "bigserial") {
        const n = Number(s);
        if (Number.isNaN(n) || !Number.isInteger(n)) throw new Error(`Invalid integer for ${col.name}: ${s}`);
    }
    if (t.includes("double") || t.includes("real") || t === "numeric" || t === "decimal") {
        if (Number.isNaN(Number(s))) throw new Error(`Invalid number for ${col.name}: ${s}`);
    }
    if (t === "boolean" || t === "bool") {
        const v = s.toLowerCase();
        if (!["true", "false", "yes", "no", "1", "0"].includes(v))
            throw new Error(`Invalid boolean for ${col.name}: ${s}`);
    }
    if (t === "uuid" && !/^[0-9a-f-]{36}$/i.test(s))
        throw new Error(`Invalid UUID for ${col.name}: ${s}`);
    return s;
}

function parseAndValidateRows(
    raw: string,
    columns: ColumnInfo[]
): SeedDataRow[] {
    let text = raw.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) text = jsonMatch[0];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("AI response was not valid JSON. Try regenerating.");
    }
    if (!Array.isArray(parsed))
        throw new Error("AI response must be a JSON array of row objects.");
    const colNames = new Set(columns.map((c) => c.name));
    const result: SeedDataRow[] = [];
    for (let i = 0; i < parsed.length; i++) {
        const row = parsed[i];
        if (row === null || typeof row !== "object")
            throw new Error(`Row ${i + 1}: expected an object.`);
        const obj = row as Record<string, unknown>;
        const out: SeedDataRow = {};
        for (const col of columns) {
            const val = obj[col.name];
            try {
                const coerced = coerceValue(val, col);
                if (coerced === "" && !col.is_nullable)
                    throw new Error(`Row ${i + 1}: missing required column "${col.name}".`);
                out[col.name] = coerced;
            } catch (e) {
                throw e instanceof Error ? e : new Error(`Row ${i + 1}: ${String(e)}`);
            }
        }
        result.push(out);
    }
    return result;
}

export interface GenerateSeedDataOptions {
    model?: GeminiModelId;
    signal?: AbortSignal;
    /** When set, the AI will generate corrected rows to fix this insert error. */
    previousError?: string;
}

/**
 * Generate realistic sample rows for a table using AI. Returns validated row objects.
 * Pass options.previousError when a previous insert failed so the AI can fix the data.
 */
export async function generateSeedData(
    schema: string,
    table: string,
    details: TableDetails,
    rowCount: number,
    options?: GenerateSeedDataOptions
): Promise<SeedDataRow[]> {
    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options?.model ?? model;
    if (!apiKey)
        throw new Error("Add your Gemini API key in Settings → AI to use data seeding.");
    if (details.columns.length === 0)
        throw new Error("Table has no columns.");
    const schemaStr = buildSchemaForSeed(details);
    const count = Math.min(Math.max(1, rowCount), 100);
    let instruction = `Generate exactly ${count} sample rows as a JSON array of objects. Each object must have keys for every column listed above. Use realistic values. Output only the JSON array, nothing else.`;
    if (options?.previousError?.trim()) {
        instruction = [
            instruction,
            "",
            "A previous insert failed with this error:",
            options.previousError.trim(),
            "",
            "Generate corrected rows that will satisfy the database: use proper types (e.g. ISO timestamps for timestamp columns, valid UUIDs, non-empty values for NOT NULL columns), and fix any constraint violations mentioned in the error. Output only the JSON array, nothing else.",
        ].join("\n");
    }
    const userPrompt = [schemaStr, "", instruction].join("\n");
    const response = await callGeminiSync(
        modelId,
        apiKey,
        [{ role: "user", parts: [{ text: userPrompt }] }],
        SYSTEM_PROMPT,
        options?.signal,
        { maxOutputTokens: 8192 }
    );
    return parseAndValidateRows(response, details.columns);
}
