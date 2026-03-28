import { AIError, callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import { parseNlSearchModelJson } from "@/lib/nl-search-json";
import { validateNlGeneratedSql } from "@/lib/sql-risk-guard";
import { getResolvedGeminiApiKey, useSettingsStore } from "@/stores/settings-store";

export interface NlSearchResult {
    sql: string | null;
    title: string;
    explanation: string;
    tablesUsed: string[];
    error?: string;
}

const NL_SEARCH_SYSTEM = `You are Nova, an expert PostgreSQL assistant inside a database IDE.

You convert natural language into ONE read-only PostgreSQL query.

RULES
-----
1. Output a single JSON object ONLY — no markdown, no code fences, no commentary before or after.
2. JSON shape (all keys required, use empty string or [] if unused):
   {"sql":"...","title":"short label","explanation":"one sentence what the query returns","tablesUsed":["schema.table",...]}
3. sql must be valid PostgreSQL. Use only tables and columns that appear in DATABASE SCHEMA.
4. Qualify tables as "schema"."table" when schema is not public or when ambiguous.
5. Use LIMIT 200 on SELECT unless the user clearly asks for a different cap (max LIMIT 5000).
6. Only SELECT or WITH … SELECT. Never INSERT, UPDATE, DELETE, DDL, or utility commands.
7. If the question cannot be answered with the given schema, set sql to empty string and explain in explanation.`;

function djb2Hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
}

function normalizeTablesUsed(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}

const CACHE_MAX = 48;
const cacheOrder: string[] = [];
const cacheMap = new Map<string, NlSearchResult>();

function cacheGet(key: string): NlSearchResult | undefined {
    const hit = cacheMap.get(key);
    if (!hit) return undefined;
    const idx = cacheOrder.indexOf(key);
    if (idx !== -1) {
        cacheOrder.splice(idx, 1);
        cacheOrder.push(key);
    }
    return hit;
}

function cacheSet(key: string, value: NlSearchResult): void {
    if (cacheMap.has(key)) {
        const idx = cacheOrder.indexOf(key);
        if (idx !== -1) cacheOrder.splice(idx, 1);
    }
    cacheMap.set(key, value);
    cacheOrder.push(key);
    while (cacheOrder.length > CACHE_MAX) {
        const oldest = cacheOrder.shift();
        if (oldest) cacheMap.delete(oldest);
    }
}

const inFlight = new Map<string, Promise<NlSearchResult>>();

export interface NaturalLanguageToSqlOptions {
    signal?: AbortSignal;
    model?: GeminiModelId;
    schemaFingerprint: string;
    fkSummaryBlock?: string;
}

/**
 * Turn natural language + compressed schema into validated read-only SQL via Gemini.
 */
export async function naturalLanguageToSql(
    nlQuery: string,
    compressedSchema: string,
    options: NaturalLanguageToSqlOptions
): Promise<NlSearchResult> {
    const normalized = nlQuery.trim().toLowerCase();
    const apiKey = getResolvedGeminiApiKey();
    const settings = useSettingsStore.getState();
    const model: GeminiModelId = (options.model ?? settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId;

    if (!apiKey) {
        return {
            sql: null,
            title: "",
            explanation: "",
            tablesUsed: [],
            error: "Add your Gemini API key in Settings → AI or set NEXT_PUBLIC_GEMINI_API_KEY to use Nova AI search.",
        };
    }

    if (!normalized) {
        return {
            sql: null,
            title: "",
            explanation: "",
            tablesUsed: [],
            error: "Enter a question after ?",
        };
    }

    const cacheKey = `${djb2Hash(normalized)}::${djb2Hash(options.schemaFingerprint)}::${model}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const fkBlock = options.fkSummaryBlock?.trim() ?? "";
    const userPrompt = [
        "DATABASE SCHEMA (compressed; T:schema.table|C:col(type,flags))",
        compressedSchema.slice(0, 24000),
        fkBlock.slice(0, 8000),
        "",
        "USER QUESTION:",
        nlQuery.trim().slice(0, 2000),
    ].join("\n");

    const promise = (async (): Promise<NlSearchResult> => {
        let raw: string;
        try {
            raw = await withGeminiLogging(
                () =>
                    callGeminiSync(
                        model,
                        apiKey,
                        [{ role: "user", parts: [{ text: userPrompt }] }],
                        NL_SEARCH_SYSTEM,
                        options.signal,
                        { maxOutputTokens: 2048 }
                    ),
                { model, featureType: "nl-search", endpoint: "generateContent" }
            );
        } catch (e) {
            if (e instanceof AIError) {
                return {
                    sql: null,
                    title: "",
                    explanation: "",
                    tablesUsed: [],
                    error: e.userMessage || e.message,
                };
            }
            const msg = e instanceof Error ? e.message : "Request failed";
            return {
                sql: null,
                title: "",
                explanation: "",
                tablesUsed: [],
                error: msg,
            };
        }

        if (options.signal?.aborted) {
            return {
                sql: null,
                title: "",
                explanation: "",
                tablesUsed: [],
                error: "Cancelled.",
            };
        }

        const parsed = parseNlSearchModelJson(raw ?? "");
        if (!parsed) {
            const err: NlSearchResult = {
                sql: null,
                title: "",
                explanation: "",
                tablesUsed: [],
                error: "Could not parse AI response. Try rephrasing your question.",
            };
            return err;
        }

        const sql = (parsed.sql ?? "").trim();
        const title = (parsed.title ?? "AI search").trim() || "AI search";
        const explanation = (parsed.explanation ?? "").trim();
        const tablesUsed = normalizeTablesUsed(parsed.tablesUsed);

        if (!sql) {
            const err: NlSearchResult = {
                sql: null,
                title,
                explanation,
                tablesUsed,
                error: explanation || "No query could be generated for this question.",
            };
            cacheSet(cacheKey, err);
            return err;
        }

        const stripSemi = sql.replace(/;+\s*$/g, "").trim();
        const readOnly = validateNlGeneratedSql(stripSemi);
        if (!readOnly.ok) {
            const err: NlSearchResult = {
                sql: null,
                title,
                explanation,
                tablesUsed,
                error: readOnly.error,
            };
            cacheSet(cacheKey, err);
            return err;
        }

        const ok: NlSearchResult = {
            sql: stripSemi,
            title,
            explanation,
            tablesUsed,
        };
        cacheSet(cacheKey, ok);
        return ok;
    })();

    inFlight.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        inFlight.delete(cacheKey);
    }
}
