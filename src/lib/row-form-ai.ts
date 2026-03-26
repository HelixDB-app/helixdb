/**
 * AI fill for single-row insert/edit forms — one JSON object from natural language.
 */

import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import { useSettingsStore } from "@/stores/settings-store";
import type { ColumnInfo, TableDetails } from "@/lib/types";
import { buildSchemaForSeed, coerceValue, type SeedDataRow } from "@/lib/seed-data-engine";

const SYSTEM_PROMPT = `You are a database expert. Given a PostgreSQL table schema and user instructions, output one row as a single JSON object.

Rules:
- Output ONLY one JSON object. No markdown, no code fence, no text before or after the JSON.
- Keys = column names (exact spelling/case from the schema). The schema lists only insertable columns (database-generated / STORED GENERATED columns are omitted). Values are strings or null.
- For nullable columns you may use null. For NOT NULL columns always provide a non-empty string value unless the column has a clear server default (then you may omit the key or use null only if nullable).
- Use realistic values matching the user's intent: proper formats for UUIDs, ISO 8601 for timestamps, booleans as "true"/"false", numbers as string digits.
- For foreign key columns use plausible values that could exist in the referenced table.
- Respect PostgreSQL types strictly.`;

export type RowFormFillMode = "insert" | "edit";

export interface GenerateRowFormFillOptions {
    model?: GeminiModelId;
    signal?: AbortSignal;
    /** DB or validation error text — model should fix the row. */
    previousError?: string;
    /**
     * When true, only columns that are empty in currentValues should get new values;
     * others stay as provided (edit mode) or omitted (insert uses existing empties).
     */
    fillEmptyOnly?: boolean;
    /** Edit mode: current field strings in the form. */
    currentValues?: Record<string, string>;
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: settings.geminiApiKey ?? "",
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

/** Parse first `{...}` object from model output and validate against columns. */
export function parseAndValidateSingleRow(raw: string, columns: ColumnInfo[]): SeedDataRow {
    let text = raw.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("AI response was not valid JSON. Try regenerating.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("AI response must be a single JSON object.");
    const obj = parsed as Record<string, unknown>;
    const out: SeedDataRow = {};
    for (const col of columns) {
        const val = obj[col.name];
        try {
            const coerced = coerceValue(val, col);
            if (coerced === "" && !col.is_nullable)
                throw new Error(`Missing required column "${col.name}".`);
            out[col.name] = coerced;
        } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
        }
    }
    return out;
}

/**
 * Generate one row object from natural language. For edit mode, pass currentValues so the model can refine in place.
 */
export async function generateRowFormFill(
    details: TableDetails,
    userInstruction: string,
    mode: RowFormFillMode,
    options?: GenerateRowFormFillOptions
): Promise<SeedDataRow> {
    const { apiKey, model } = getApiKeyAndModel();
    const modelId = options?.model ?? model;
    if (!apiKey)
        throw new Error("Add your Gemini API key in Settings → AI to use AI fill.");
    const writable = details.columns.filter((c) => !c.is_generated);
    if (writable.length === 0) throw new Error("Table has no insertable columns.");

    const detailsForAi: TableDetails = { ...details, columns: writable };
    const schemaStr = buildSchemaForSeed(detailsForAi);
    const trimmed = userInstruction.trim();
    if (!trimmed && !options?.previousError?.trim()) {
        throw new Error("Enter a description or instruction for the AI.");
    }

    let modeBlock =
        mode === "insert"
            ? "Mode: INSERT. Generate a new row suitable for insertion."
            : "Mode: EDIT. The user is editing an existing row. Change only what their instruction implies; keep other fields consistent with current values unless they ask to replace everything.";

    if (options?.fillEmptyOnly) {
        modeBlock +=
            " Only provide values for columns that are empty in the current row data below; for other columns match the current values exactly or omit if allowed.";
    }

    const parts: string[] = [schemaStr, "", modeBlock];
    if (trimmed) {
        parts.push("", "User instruction:", trimmed);
    } else {
        parts.push("", "User instruction: (none — rely on error context below.)");
    }

    if (mode === "edit" && options?.currentValues) {
        const allowed = new Set(writable.map((c) => c.name));
        const filtered = Object.fromEntries(
            Object.entries(options.currentValues).filter(([k]) => allowed.has(k))
        );
        if (Object.keys(filtered).length > 0) {
            parts.push("", "Current row values (string form):", JSON.stringify(filtered));
        }
    }

    parts.push(
        "",
        "Output only one JSON object with a key for every insertable column listed in the schema (same names).",
        "Nothing else."
    );

    if (options?.previousError?.trim()) {
        parts.push(
            "",
            "A previous operation failed with this error:",
            options.previousError.trim(),
            "",
            "Generate a corrected row: fix types, NOT NULL, unique, and foreign key issues. Output only the JSON object."
        );
    }

    const userPrompt = parts.join("\n");
    const response = await withGeminiLogging(
        () =>
            callGeminiSync(
                modelId,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                SYSTEM_PROMPT,
                options?.signal,
                { maxOutputTokens: 16384 }
            ),
        { model: modelId, featureType: "row-form-fill", endpoint: "generateContent" }
    );
    return parseAndValidateSingleRow(response, writable);
}
