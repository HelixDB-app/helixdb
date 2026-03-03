/**
 * AI-powered query error analysis using Gemini Flash Lite.
 * Analyzes the failed SQL, error message, and database schema to suggest a fix.
 */

import { callGeminiSync } from "@/lib/ai-chat-engine";
import type { GeminiModelId } from "@/lib/ai-chat-engine";
import { useSettingsStore } from "@/stores/settings-store";
import { AIError } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";

const AI_ERROR_SYSTEM_PROMPT = `You are a PostgreSQL expert inside a database IDE. The user's query failed and they need a clear, actionable explanation.

Given:
1. The SQL they ran
2. The exact error message from PostgreSQL
3. A summary of the current database schema (tables with columns, and functions with signatures)

Your task:
- Explain in 2–4 short sentences WHY the error occurred, in plain language.
- Give a concrete FIX: either corrected SQL (in a \`\`\`sql block) or step-by-step actions (e.g. "Create the function with CREATE FUNCTION ..." or "Add explicit cast: column::date").
- Base your answer only on the provided schema. If a table/function is missing, say so and suggest creating it or fixing the name/schema.
- Be concise and professional. No preamble.`;

/** Build user prompt for error analysis */
function buildErrorAnalysisPrompt(sql: string, errorMessage: string, schemaContext: string): string {
    return [
        "SQL that was run:",
        "```sql",
        sql.trim().slice(0, 8000),
        "```",
        "",
        "PostgreSQL error:",
        "```",
        errorMessage.slice(0, 4000),
        "```",
        "",
        "Relevant schema (tables and functions in the database):",
        "```",
        schemaContext.slice(0, 6000),
        "```",
        "",
        "Provide a short explanation and a concrete fix.",
    ].join("\n");
}

export interface ExplainErrorOptions {
    model?: GeminiModelId;
    signal?: AbortSignal;
}

/**
 * Get an AI-generated explanation and fix for a query error using Gemini Flash Lite.
 * Uses schema context so the model can suggest fixes that match the actual DB (e.g. missing function, wrong types).
 */
export async function explainQueryErrorWithAI(
    sql: string,
    errorMessage: string,
    schemaContext: string,
    options?: ExplainErrorOptions
): Promise<string> {
    const settings = useSettingsStore.getState();
    const apiKey = settings.geminiApiKey?.trim() ?? "";
    const model: GeminiModelId = (options?.model ?? settings.defaultAiModel ?? "gemini-2.5-flash-lite") as GeminiModelId;

    if (!apiKey) {
        throw new AIError(
            0,
            "No API key",
            "Add your Gemini API key in Settings → AI to use AI Explain.",
            false
        );
    }

    const userPrompt = buildErrorAnalysisPrompt(sql, errorMessage, schemaContext);
    const response = await withGeminiLogging(
        () => callGeminiSync(
            model,
            apiKey,
            [{ role: "user", parts: [{ text: userPrompt }] }],
            AI_ERROR_SYSTEM_PROMPT,
            options?.signal,
            { maxOutputTokens: 2048 }
        ),
        { model, featureType: "query-error", endpoint: "generateContent" }
    );

    return response?.trim() ?? "No explanation generated.";
}
