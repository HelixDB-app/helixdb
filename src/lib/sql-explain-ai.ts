/**
 * AI-powered SQL explanation engine using Gemini.
 * Provides plain-English breakdowns of what a SQL query does —
 * table flow, join logic, filter effects, and performance notes.
 */

import { callGeminiSync } from "@/lib/ai-chat-engine";
import type { GeminiModelId } from "@/lib/ai-chat-engine";
import { AIError } from "@/lib/ai-chat-engine";
import { resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import { withGeminiLogging } from "@/lib/gemini-logger";
import type { SchemaContext } from "@/lib/ai-suggestions";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TableFlowStep {
    /** "table" | "filter" | "join" | "aggregate" | "sort" | "limit" | "output" */
    type: "table" | "filter" | "join" | "aggregate" | "sort" | "limit" | "output";
    label: string;
    detail?: string;
}

export interface SqlExplanation {
    /** Short 1–3 sentence headline explaining what the query accomplishes. */
    summary: string;
    /** Step-by-step data flow through the query. */
    tableFlow: TableFlowStep[];
    /** Explanation of JOIN conditions and why they matter. Empty if no JOINs. */
    joinLogic?: string;
    /** Impact of WHERE/HAVING filters on the result set. Empty if no filters. */
    filterEffects?: string;
    /** Performance tips — e.g. missing indexes, full-table scans, N+1 risks. */
    performanceNotes: string[];
    /** Complexity label: "simple" | "moderate" | "complex" | "expert" */
    complexity: "simple" | "moderate" | "complex" | "expert";
}

export interface ExplainOptions {
    model?: GeminiModelId;
    signal?: AbortSignal;
}

// ── LRU Cache ────────────────────────────────────────────────────────────────

class LRUCache<K, V> {
    private readonly max: number;
    private readonly map: Map<K, V>;

    constructor(max: number) {
        this.max = max;
        this.map = new Map();
    }

    get(key: K): V | undefined {
        if (!this.map.has(key)) return undefined;
        const val = this.map.get(key)!;
        this.map.delete(key);
        this.map.set(key, val);
        return val;
    }

    set(key: K, val: V): void {
        if (this.map.has(key)) this.map.delete(key);
        if (this.map.size >= this.max) {
            this.map.delete(this.map.keys().next().value!);
        }
        this.map.set(key, val);
    }

    has(key: K): boolean {
        return this.map.has(key);
    }
}

/** Simple string hash for cache keys. Not cryptographic — just fast & good enough. */
function hashSql(sql: string): string {
    let h = 0;
    for (let i = 0; i < sql.length; i++) {
        h = (Math.imul(31, h) + sql.charCodeAt(i)) | 0;
    }
    return `ex::${h >>> 0}`;
}

const explanationCache = new LRUCache<string, SqlExplanation>(64);

export function getCachedExplanation(sql: string): SqlExplanation | undefined {
    return explanationCache.get(hashSql(sql.trim()));
}

export function cacheExplanation(sql: string, result: SqlExplanation): void {
    explanationCache.set(hashSql(sql.trim()), result);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Nova, an expert PostgreSQL assistant embedded inside a database IDE.
The user wants a clear, developer-friendly explanation of their SQL query.

Your task:
1. Write a SHORT SUMMARY (1–3 sentences) explaining what the query does in plain English.
2. Produce a DATA FLOW list describing the step-by-step journey of data through the query.
3. If JOINs are present, describe the JOIN LOGIC concisely.
4. If WHERE/HAVING filters exist, describe their FILTER EFFECTS on the result set.
5. List up to 3 PERFORMANCE NOTES (e.g. missing indexes, sequential scans, large aggregations). If none, return an empty array.
6. Rate the query COMPLEXITY as one of: simple | moderate | complex | expert.

You MUST respond with ONLY a valid JSON object matching this TypeScript interface:
{
  "summary": string,
  "tableFlow": Array<{ type: "table"|"filter"|"join"|"aggregate"|"sort"|"limit"|"output", label: string, detail?: string }>,
  "joinLogic"?: string,
  "filterEffects"?: string,
  "performanceNotes": string[],
  "complexity": "simple"|"moderate"|"complex"|"expert"
}

No markdown fences. No extra text. Only the JSON object.`;

function buildExplainPrompt(sql: string, schemaBlock: string): string {
    const parts = ["SQL Query to explain:"];
    parts.push(sql.trim().slice(0, 8000));
    if (schemaBlock) {
        parts.push("\nRelevant database schema:");
        parts.push(schemaBlock.slice(0, 4000));
    }
    parts.push("\nRespond with only the JSON object as specified.");
    return parts.join("\n");
}

function buildSchemaBlock(schema: SchemaContext): string {
    if (schema.tables.length === 0) return "";
    return schema.tables
        .slice(0, 30)
        .map((t) => {
            const cols = schema.columns[t] ?? schema.columns[t.toLowerCase()] ?? [];
            return `${t}: ${cols.slice(0, 20).join(", ")}`;
        })
        .join("\n");
}

// ── Fallback parser ───────────────────────────────────────────────────────────

/** Safely parse the JSON response; falls back to a minimal explanation on failure. */
function parseExplanationResponse(raw: string, sql: string): SqlExplanation {
    // Strip accidental code fences
    const cleaned = raw
        .replace(/^```(?:json)?\n?/gi, "")
        .replace(/```$/g, "")
        .trim();

    try {
        const parsed = JSON.parse(cleaned) as SqlExplanation;
        // Validate required fields
        if (typeof parsed.summary !== "string" || !Array.isArray(parsed.tableFlow)) {
            throw new Error("Invalid shape");
        }
        return parsed;
    } catch {
        // Minimal graceful fallback
        const upper = sql.trim().toUpperCase();
        const type = upper.startsWith("SELECT")
            ? "SELECT"
            : upper.startsWith("INSERT")
                ? "INSERT"
                : upper.startsWith("UPDATE")
                    ? "UPDATE"
                    : upper.startsWith("DELETE")
                        ? "DELETE"
                        : "SQL";

        return {
            summary: `This is a ${type} statement.`,
            tableFlow: [{ type: "output", label: "Query Result" }],
            performanceNotes: [],
            complexity: "simple",
        };
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a plain-English explanation of a SQL query using Gemini.
 * Results are cached by SQL content hash to avoid redundant API calls.
 */
export async function explainSql(
    sql: string,
    schemaContext?: SchemaContext,
    options?: ExplainOptions
): Promise<SqlExplanation> {
    const normalizedSql = sql.trim();
    if (!normalizedSql) {
        throw new Error("No SQL provided to explain.");
    }

    // Return cached result if available
    const cached = getCachedExplanation(normalizedSql);
    if (cached) return cached;

    const settings = useSettingsStore.getState();
    const apiKey = resolveGeminiApiKey(settings.geminiApiKey);
    const model: GeminiModelId = (
        options?.model ??
        settings.defaultAiModel ??
        "gemini-2.5-flash-lite"
    ) as GeminiModelId;

    if (!apiKey) {
        throw new AIError(
            0,
            "No API key",
            "Add your Gemini API key in Settings → AI to use AI Explain.",
            false
        );
    }

    const schemaBlock = schemaContext ? buildSchemaBlock(schemaContext) : "";
    const userPrompt = buildExplainPrompt(normalizedSql, schemaBlock);

    const raw = await withGeminiLogging(
        () =>
            callGeminiSync(
                model,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                SYSTEM_PROMPT,
                options?.signal,
                { maxOutputTokens: 1024 }
            ),
        { model, featureType: "query-explain", endpoint: "generateContent" }
    );

    const explanation = parseExplanationResponse(raw, normalizedSql);
    cacheExplanation(normalizedSql, explanation);
    return explanation;
}

/**
 * Extract and explain only the selected portion of a SQL query.
 * Falls back to the full SQL if the selection is too short.
 */
export function explainSelection(
    fullSql: string,
    selectedText: string,
    schemaContext?: SchemaContext,
    options?: ExplainOptions
): Promise<SqlExplanation> {
    const target = selectedText.trim().length > 10 ? selectedText.trim() : fullSql;
    return explainSql(target, schemaContext, options);
}
