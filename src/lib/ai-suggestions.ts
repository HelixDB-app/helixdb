import { APP_NAME } from "@/lib/app-config";
import { notifyNoInternetDetected } from "@/lib/network-errors";

const CLOUDFLARE_ENDPOINT = "https://auto-comment.gokulakrishnanr812-492.workers.dev/";

export interface SchemaContext {
    tables: string[];
    /** tableName → ordered list of column names (pre-populated on connect) */
    columns: Record<string, string[]>;
}

export interface AISuggestionTelemetry {
    latencyMs: number;
    source: "cache" | "network" | "coalesced";
}

export interface AISuggestionBatch {
    suggestions: string[];
    telemetry: AISuggestionTelemetry;
}

export interface AIInlineCompletionResult {
    completion: string;
    telemetry: AISuggestionTelemetry;
}

export interface AISuggestionOptions {
    signal?: AbortSignal;
    maxSuggestions?: number;
    contextWindowChars?: number;
}

type SuggestionCallback = (suggestions: string[]) => void;

// ── LRU Cache ───────────────────────────────────────────────────────────────

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

    clear(): void {
        this.map.clear();
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowMs(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

function elapsedMs(start: number): number {
    return Math.max(1, Math.round(nowMs() - start));
}

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

/** Keep only the recent tail of SQL to reduce prompt size and latency. */
function trimSqlContext(sql: string, maxChars: number): string {
    const normalized = sql.replace(/\u0000/g, "").replace(/\s+$/, "");
    if (normalized.length <= maxChars) return normalized;
    return normalized.slice(-maxChars);
}

function normalizeForDedup(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Produces a human-readable schema block for injection into prompts.
 */
function buildSchemaBlock(schema: SchemaContext): string {
    if (schema.tables.length === 0) return "";

    const lines = schema.tables.slice(0, 40).map((t) => {
        const cols = schema.columns[t] ?? schema.columns[t.toLowerCase()];
        const colStr = cols && cols.length > 0 ? cols.slice(0, 24).join(", ") : "(columns loading...)";
        return `  ${t.padEnd(24)} -> ${colStr}`;
    });

    return ["DATABASE SCHEMA", "---------------", ...lines].join("\n");
}

/** Flat set of all verified column names (lower-cased) across every table. */
function knownColumnSet(schema: SchemaContext): Set<string> {
    const s = new Set<string>();
    for (const cols of Object.values(schema.columns)) {
        for (const c of cols) s.add(c.toLowerCase());
    }
    return s;
}

function stripCodeFences(text: string): string {
    return text
        .replace(/^```sql\n?/gi, "")
        .replace(/^```\n?/g, "")
        .replace(/```$/g, "")
        .trim();
}

/**
 * Removes any prefix the model echoed back from the already-typed text.
 * Tries rolling windows of 1–6 trailing words to detect overlap.
 */
function stripLeadingDuplication(completion: string, textUntilCursor: string): string {
    if (!completion) return "";
    const words = textUntilCursor.trimEnd().split(/\s+/).filter(Boolean);

    for (let w = Math.min(6, words.length); w >= 1; w--) {
        const suffix = words.slice(-w).join(" ");
        if (completion.toLowerCase().startsWith(suffix.toLowerCase())) {
            const stripped = completion.slice(suffix.length).replace(/^\s+/, "");
            if (stripped.length > 0) return stripped;
        }
    }
    return completion;
}

/**
 * Ensures one space between typed text and completion when both sides are words.
 */
function ensureProperSpacing(completion: string, textUntilCursor: string): string {
    if (!completion) return "";
    const lastChar = textUntilCursor.slice(-1);
    const firstChar = completion[0];

    const lastIsWord = /[A-Za-z0-9_*]/.test(lastChar);
    const firstIsWord = /[A-Za-z0-9_*]/.test(firstChar);

    if (lastIsWord && firstIsWord) return " " + completion;
    return completion;
}

// ── Schema guard token sets ────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
    "select", "from", "where", "join", "on", "insert", "into", "values", "update", "set",
    "delete", "create", "table", "drop", "alter", "add", "column", "returning", "limit",
    "offset", "order", "by", "group", "having", "as", "and", "or", "not", "in", "is", "null",
    "like", "between", "exists", "distinct", "count", "sum", "avg", "min", "max", "with",
    "inner", "left", "right", "full", "outer", "cross", "union", "all", "except", "intersect",
    "true", "false", "case", "when", "then", "else", "end", "cast", "coalesce", "nullif",
    "default", "primary", "key", "unique", "index", "constraint", "references", "foreign",
    "integer", "int", "bigint", "text", "varchar", "boolean", "bool", "timestamp", "date",
    "serial", "float", "numeric", "jsonb", "json", "uuid", "array", "using", "ilike",
    "begin", "commit", "rollback", "transaction", "explain", "analyze",
    "public", "pg_catalog", "information_schema", "current_timestamp", "now",
]);

const SQL_FUNCTIONS = new Set([
    "date_trunc", "extract", "to_char", "to_date", "to_timestamp", "age", "timezone",
    "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value",
    "json_build_object", "jsonb_build_object", "json_agg", "jsonb_agg", "unnest", "generate_series",
    "greatest", "least", "lower", "upper", "trim", "concat", "substring", "length",
]);

function hasUnknownIdentifiers(fragment: string, schema: SchemaContext): boolean {
    if (!fragment || Object.keys(schema.columns).length === 0) return false;

    const allowedColumns = knownColumnSet(schema);
    const knownTables = new Set(schema.tables.map((t) => t.toLowerCase()));

    const scrubbed = fragment
        .replace(/--.*$/gm, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/'[^']*'/g, " ")
        .replace(/"[^"]*"/g, " ")
        .replace(/\d+(\.\d+)?/g, " ");

    const ids = scrubbed.match(/\b[a-z_][a-z0-9_]*\b/gi) ?? [];

    for (const idRaw of ids) {
        const id = idRaw.toLowerCase();
        if (SQL_KEYWORDS.has(id) || SQL_FUNCTIONS.has(id)) continue;
        if (allowedColumns.has(id) || knownTables.has(id)) continue;
        // Allow short aliases like u, t1, q, cte aliases, etc.
        if (id.length <= 2) continue;
        return true;
    }

    return false;
}

function scoreSuggestion(suggestion: string, textUntilCursor: string): number {
    const tailToken = textUntilCursor.match(/[a-z_][a-z0-9_]*$/i)?.[0]?.toLowerCase() ?? "";
    const norm = suggestion.toLowerCase();

    let score = 0;
    if (tailToken && norm.startsWith(tailToken)) score += 2;
    if (/^\s*(where|order by|group by|limit|join|and|or|returning|set|values)\b/i.test(suggestion)) {
        score += 0.25;
    }

    // Slightly prefer concise snippets; very long snippets are lower rank.
    score -= Math.max(0, suggestion.length - 100) * 0.01;
    return score;
}

function sanitizeDropdownSuggestions(
    raw: string,
    textUntilCursor: string,
    schema: SchemaContext,
    maxSuggestions: number
): string[] {
    const seen = new Set<string>();
    const out: { text: string; score: number; idx: number }[] = [];

    const lines = raw
        .split("\n")
        .map((line) => stripCodeFences(line).trim())
        .filter((line) => line.length > 1 && !line.startsWith("--") && !line.startsWith("```"));

    for (const [idx, line] of lines.entries()) {
        let suggestion = line.replace(/^[-*]\s*/, "").trim();
        if (!suggestion) continue;

        suggestion = stripLeadingDuplication(suggestion, textUntilCursor);
        suggestion = ensureProperSpacing(suggestion, textUntilCursor).trimEnd();

        if (!suggestion || suggestion.length < 2) continue;
        if (hasUnknownIdentifiers(suggestion, schema)) continue;

        const key = normalizeForDedup(suggestion);
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({ text: suggestion, score: scoreSuggestion(suggestion, textUntilCursor), idx });
    }

    out.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return out.slice(0, maxSuggestions).map((x) => x.text);
}

function sanitizeInlineCompletion(raw: string, textUntilCursor: string, schema: SchemaContext): string {
    const cleaned = stripCodeFences(raw);
    const lines = cleaned
        .split("\n")
        .map((line) => line.trimEnd());

    // Find first non-empty line index
    const firstNonEmptyIdx = lines.findIndex((line) => line.length > 0);
    if (firstNonEmptyIdx === -1) return "";

    // Take up to 12 lines for block-level suggestions
    const relevantLines = lines.slice(firstNonEmptyIdx, firstNonEmptyIdx + 12)
        // Trim trailing empty lines
        .reduceRight<string[]>((acc, line) => {
            if (acc.length === 0 && line.length === 0) return acc;
            acc.unshift(line);
            return acc;
        }, []);

    if (relevantLines.length === 0) return "";

    // For single-line: apply standard dedup and spacing
    if (relevantLines.length === 1) {
        let completion = stripLeadingDuplication(relevantLines[0], textUntilCursor);
        completion = ensureProperSpacing(completion, textUntilCursor);
        if (completion.length > 400) {
            completion = completion.slice(0, 400).trimEnd();
        }
        if (hasUnknownIdentifiers(completion, schema)) return "";
        return completion;
    }

    // For multi-line block suggestions:
    // Apply dedup only on the first line, then join with remaining lines
    let firstLine = stripLeadingDuplication(relevantLines[0], textUntilCursor);
    firstLine = ensureProperSpacing(firstLine, textUntilCursor);

    const block = [firstLine, ...relevantLines.slice(1)].join("\n");

    // Cap total length for performance
    if (block.length > 800) {
        // Find the last complete line within the limit
        const truncated = block.slice(0, 800);
        const lastNewline = truncated.lastIndexOf("\n");
        return lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated.trimEnd();
    }

    return block;
}

// ── Worker call ─────────────────────────────────────────────────────────────

async function callWorker(
    messages: { role: string; content: string }[],
    opts: {
        temperature?: number;
        max_tokens?: number;
        signal?: AbortSignal;
        sessionId: string;
    }
): Promise<string> {
    let res: Response;
    try {
        res = await fetch(CLOUDFLARE_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                conversationId: opts.sessionId,
                messages,
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                temperature: opts.temperature ?? 0.3,
                max_tokens: opts.max_tokens ?? 256,
                stream: false,
                skipCache: false,
            }),
            signal: opts.signal,
        });
    } catch (error) {
        notifyNoInternetDetected(error);
        return "";
    }

    if (!res.ok) return "";

    const data = await res.json();
    return data?.result?.response ?? data?.response ?? data?.choices?.[0]?.message?.content ?? "";
}

// ── System prompts ──────────────────────────────────────────────────────────

function dropdownPrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, an expert PostgreSQL assistant embedded inside ${appName}.

${schemaBlock}

YOUR TASK
---------
Complete the partial SQL query the user is writing.
Return a list of up to 5 high-quality, ready-to-use SQL completions.

OUTPUT RULES
------------
1. Output ONLY raw SQL completions - one per line, no numbering.
2. Every table and column MUST exist in DATABASE SCHEMA above.
3. Each suggestion must be a valid SQL fragment that continues the query.
4. No explanations. No markdown. No code fences.
5. Rank suggestions from most to least likely.`;
}

function inlinePrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    const hasColumns = Object.keys(schema.columns).length > 0;

    return `\
You are Nova, a SQL ghost-text completion engine for ${appName}.

${schemaBlock}

YOUR TASK
---------
The user is actively typing SQL.
Output only the text that should appear immediately after the cursor.
You MUST provide COMPLETE, multi-line block suggestions when appropriate.

For example, if the user types:
  CREATE TABLE categories (
You should suggest the FULL table body:
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );

STRICT RULES
------------
1. Output ONLY the continuation from the cursor.
2. Never repeat text already typed by the user.
3. ${hasColumns
            ? "Only use table/column names from DATABASE SCHEMA."
            : "Do not invent table/column names."}
4. Return exactly one continuation — multi-line is encouraged for block completions.
5. No markdown, no explanations, no code fences.
6. If query is complete, return an empty string.
7. For CREATE TABLE, INSERT, and other structured statements, ALWAYS suggest complete blocks.
8. Maintain consistent indentation (4 spaces) in multi-line suggestions.`;
}

function nextActionPrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, a SQL advisor embedded in ${appName}.

${schemaBlock}

YOUR TASK
---------
The user has written a SQL query. Suggest 3 concise, actionable next steps.

OUTPUT RULES
------------
1. Output EXACTLY 3 suggestions - one per line.
2. Each suggestion must be <= 60 characters.
3. Only reference tables and columns from DATABASE SCHEMA.
4. No numbering, bullets, or explanations.`;
}

function naturalLanguagePrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, an expert PostgreSQL assistant for ${appName}.

${schemaBlock}

YOUR TASK
---------
Convert the user's natural language description into a valid PostgreSQL query.

OUTPUT RULES
------------
1. Output ONLY SQL query text.
2. Only use table/column names from DATABASE SCHEMA.
3. Use LIMIT 200 for SELECT queries unless user specifies another limit.
4. Use standard PostgreSQL syntax.`;
}

// ── Engine ─────────────────────────────────────────────────────────────────

class AISuggestionEngine {
    private readonly sessionId: string;
    private readonly completionCache: LRUCache<string, string[]>;
    private readonly inlineCache: LRUCache<string, string>;
    private readonly nextActionCache: LRUCache<string, string[]>;

    private readonly dropdownInFlight: Map<string, Promise<AISuggestionBatch>> = new Map();
    private readonly inlineInFlight: Map<string, Promise<AIInlineCompletionResult>> = new Map();
    private inlineAbort: AbortController | null = null;

    constructor() {
        this.sessionId = crypto.randomUUID();
        this.completionCache = new LRUCache(160);
        this.inlineCache = new LRUCache(280);
        this.nextActionCache = new LRUCache(80);
    }

    // ── Cache keys ──────────────────────────────────────────────────────

    private ck(sqlTail: string, tables: string[]): string {
        return `c::${sqlTail.slice(-420)}::${tables.slice(0, 12).join(",")}`;
    }

    private ik(prefixTail: string, tables: string[]): string {
        return `i::${prefixTail.slice(-420)}::${tables.slice(0, 12).join(",")}`;
    }

    private nk(sqlTail: string, tables: string[]): string {
        return `n::${sqlTail.slice(-240)}::${tables.slice(0, 12).join(",")}`;
    }

    // ── Dropdown completions ────────────────────────────────────────────

    /**
     * Legacy callback API kept for compatibility.
     */
    getSuggestions(sql: string, schema: SchemaContext, callback: SuggestionCallback): void {
        this.getDropdownSuggestions(sql, schema)
            .then((res) => callback(res.suggestions))
            .catch(() => callback([]));
    }

    async getDropdownSuggestions(
        textUntilCursor: string,
        schema: SchemaContext,
        opts: AISuggestionOptions = {}
    ): Promise<AISuggestionBatch> {
        const maxSuggestions = clamp(opts.maxSuggestions ?? 5, 1, 8);
        const contextWindowChars = clamp(opts.contextWindowChars ?? 1200, 300, 4000);
        const sqlTail = trimSqlContext(textUntilCursor, contextWindowChars);

        if (!sqlTail.trim()) {
            return {
                suggestions: [],
                telemetry: { latencyMs: 1, source: "network" },
            };
        }

        const key = this.ck(sqlTail, schema.tables);

        if (this.completionCache.has(key)) {
            return {
                suggestions: this.completionCache.get(key) ?? [],
                telemetry: { latencyMs: 1, source: "cache" },
            };
        }

        if (this.dropdownInFlight.has(key)) {
            const shared = await this.dropdownInFlight.get(key)!;
            return {
                ...shared,
                telemetry: { ...shared.telemetry, source: "coalesced" },
            };
        }

        const start = nowMs();
        const promise = (async (): Promise<AISuggestionBatch> => {
            try {
                const raw = await callWorker(
                    [
                        { role: "system", content: dropdownPrompt(schema, APP_NAME) },
                        { role: "user", content: `Complete this SQL query:\n\n${sqlTail}` },
                    ],
                    {
                        temperature: 0.2,
                        max_tokens: 220,
                        signal: opts.signal,
                        sessionId: this.sessionId,
                    }
                );

                const suggestions = sanitizeDropdownSuggestions(raw, textUntilCursor, schema, maxSuggestions);
                this.completionCache.set(key, suggestions);

                return {
                    suggestions,
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                };
            } catch {
                return {
                    suggestions: [],
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                };
            } finally {
                this.dropdownInFlight.delete(key);
            }
        })();

        this.dropdownInFlight.set(key, promise);
        return promise;
    }

    // ── Inline ghost-text completion ────────────────────────────────────

    async getInlineCompletion(
        textUntilCursor: string,
        schema: SchemaContext,
        signal?: AbortSignal,
        contextWindowChars?: number
    ): Promise<string> {
        const res = await this.getInlineCompletionWithTelemetry(textUntilCursor, schema, {
            signal,
            contextWindowChars,
        });
        return res.completion;
    }

    async getInlineCompletionWithTelemetry(
        textUntilCursor: string,
        schema: SchemaContext,
        opts: AISuggestionOptions = {}
    ): Promise<AIInlineCompletionResult> {
        const contextWindowChars = clamp(opts.contextWindowChars ?? 1200, 300, 4000);
        const prefixTail = trimSqlContext(textUntilCursor, contextWindowChars);
        if (prefixTail.trim().length < 4) {
            return {
                completion: "",
                telemetry: { latencyMs: 1, source: "network" },
            };
        }

        const key = this.ik(prefixTail, schema.tables);
        if (this.inlineCache.has(key)) {
            return {
                completion: this.inlineCache.get(key) ?? "",
                telemetry: { latencyMs: 1, source: "cache" },
            };
        }

        if (this.inlineInFlight.has(key)) {
            const shared = await this.inlineInFlight.get(key)!;
            return {
                ...shared,
                telemetry: { ...shared.telemetry, source: "coalesced" },
            };
        }

        // Cancel stale inline request when a newer one starts.
        this.inlineAbort?.abort();
        this.inlineAbort = new AbortController();
        const effectiveSignal = opts.signal ?? this.inlineAbort.signal;

        const start = nowMs();
        const promise = (async (): Promise<AIInlineCompletionResult> => {
            try {
                const raw = await callWorker(
                    [
                        { role: "system", content: inlinePrompt(schema, APP_NAME) },
                        {
                            role: "user",
                            content: `SQL typed so far (cursor is at the very end):\n\n${prefixTail}\n\nContinue from the cursor:`,
                        },
                    ],
                    {
                        temperature: 0.1,
                        max_tokens: 400,
                        signal: effectiveSignal,
                        sessionId: this.sessionId,
                    }
                );

                const completion = sanitizeInlineCompletion(raw, textUntilCursor, schema);
                if (completion) this.inlineCache.set(key, completion);

                return {
                    completion,
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                };
            } catch {
                return {
                    completion: "",
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                };
            } finally {
                this.inlineInFlight.delete(key);
            }
        })();

        this.inlineInFlight.set(key, promise);
        return promise;
    }

    // ── Next-action predictions ─────────────────────────────────────────

    async getNextActions(sql: string, schema: SchemaContext): Promise<string[]> {
        if (sql.trim().length < 10) return [];

        const sqlTail = trimSqlContext(sql.trim(), 800);
        const key = this.nk(sqlTail, schema.tables);
        if (this.nextActionCache.has(key)) return this.nextActionCache.get(key) ?? [];

        try {
            const raw = await callWorker(
                [
                    { role: "system", content: nextActionPrompt(schema, APP_NAME) },
                    { role: "user", content: `Query:\n\n${sqlTail}` },
                ],
                { temperature: 0.4, max_tokens: 180, sessionId: this.sessionId }
            );

            const suggestions = raw
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 5 && !s.startsWith("```") && !s.startsWith("--"))
                .slice(0, 3);

            this.nextActionCache.set(key, suggestions);
            return suggestions;
        } catch {
            return [];
        }
    }

    // ── Natural language → SQL ──────────────────────────────────────────

    async getNaturalLanguageSQL(query: string, schema: SchemaContext): Promise<string> {
        const raw = await callWorker(
            [
                { role: "system", content: naturalLanguagePrompt(schema, APP_NAME) },
                { role: "user", content: query },
            ],
            { temperature: 0.2, max_tokens: 256, sessionId: this.sessionId }
        );

        if (!raw) throw new Error("AI request failed");
        return stripCodeFences(raw);
    }

    clearCache(): void {
        this.completionCache.clear();
        this.inlineCache.clear();
        this.nextActionCache.clear();
        this.dropdownInFlight.clear();
        this.inlineInFlight.clear();
        this.inlineAbort?.abort();
    }
}

export const aiSuggestionEngine = new AISuggestionEngine();
