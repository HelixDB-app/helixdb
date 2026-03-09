import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";

export interface GenerateSqlUnitTestScriptOptions {
    prompt: string;
    schemaSummary: string;
    existingScript?: string;
    apiKey: string;
    model: GeminiModelId;
    signal?: AbortSignal;
}

const AI_SYSTEM_PROMPT = `You are a senior PostgreSQL QA engineer.
Generate SQL unit tests in a JavaScript-like DSL for a SQL IDE.

Allowed functions:
- createTestCase(name, sql, expected)
- assertRowCount(sql, expected)
- assertColumnValues(sql, column, expected)
- runTestSuite(testCases)

Rules:
1. Output ONLY executable DSL code. No markdown, no explanation.
2. Always include clear test names.
3. Write deterministic SQL (include ORDER BY when asserting column values).
4. Prefer rowCount assertions for INSERT/UPDATE/DELETE tests.
5. Use realistic test coverage: success path + edge cases.
6. Do not use any function outside the allowed list.
7. Make sure code can run directly in the editor.`;

function stripCodeFences(input: string): string {
    return input
        .replace(/^```[a-zA-Z]*\n?/, "")
        .replace(/```$/g, "")
        .trim();
}

export async function generateSqlUnitTestScriptWithAI(
    options: GenerateSqlUnitTestScriptOptions
): Promise<string> {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
        throw new Error("Add your Gemini API key in Settings -> AI to use AI test generation.");
    }
    const prompt = options.prompt.trim();
    if (!prompt) {
        throw new Error("Describe what test coverage you want before generating.");
    }

    const userPrompt = [
        "Database schema summary:",
        options.schemaSummary || "(schema not available)",
        "",
        "Coverage request:",
        prompt,
        "",
        "Current editor content (optional context):",
        options.existingScript?.trim() || "(empty)",
    ].join("\n");

    const raw = await withGeminiLogging(
        () =>
            callGeminiSync(
                options.model,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                AI_SYSTEM_PROMPT,
                options.signal,
                { maxOutputTokens: 3072 }
            ),
        {
            model: options.model,
            featureType: "other",
            endpoint: "generateContent",
        }
    );

    const clean = stripCodeFences(raw);
    if (!clean) {
        throw new Error("AI returned an empty response.");
    }
    if (!clean.includes("createTestCase(") && !clean.includes("assertRowCount(") && !clean.includes("assertColumnValues(")) {
        throw new Error("AI response did not contain valid SQL unit test DSL.");
    }

    return clean;
}
