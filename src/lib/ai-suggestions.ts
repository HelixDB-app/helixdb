import { APP_NAME } from "@/lib/app-config";

const CLOUDFLARE_ENDPOINT = "https://auto-comment.gokulakrishnanr812-492.workers.dev/";

export interface SchemaContext {
    tables: string[];
    /** tableName → ordered list of column names (pre-populated on connect) */
    columns: Record<string, string[]>;
}

type SuggestionCallback = (suggestions: string[]) => void;

// ── LRU Cache ─────────────────────────────────────────────────────────────────

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

    has(key: K): boolean { return this.map.has(key); }
    clear(): void { this.map.clear(); }
}

// ── Schema serialisation ──────────────────────────────────────────────────────

/**
 * Produces a human-readable schema block for injection into every prompt.
 * Format chosen to be unambiguous for the model and compact for token budgets.
 *
 * Example output:
 *   DATABASE SCHEMA
 *   ───────────────
 *   users       → id, name, created_at
 *   orders      → id, user_id, total, status
 */
function buildSchemaBlock(schema: SchemaContext): string {
    if (schema.tables.length === 0) return "";

    const lines = schema.tables.slice(0, 40).map((t) => {
        const cols = schema.columns[t];
        const colStr = cols && cols.length > 0
            ? cols.slice(0, 20).join(", ")
            : "(columns loading…)";
        return `  ${t.padEnd(24)} → ${colStr}`;
    });

    return [
        "DATABASE SCHEMA",
        "───────────────",
        ...lines,
    ].join("\n");
}

/** Flat set of all verified column names (lower-cased) across every table. */
function knownColumnSet(schema: SchemaContext): Set<string> {
    const s = new Set<string>();
    for (const cols of Object.values(schema.columns)) {
        for (const c of cols) s.add(c.toLowerCase());
    }
    return s;
}

// ── Worker call ───────────────────────────────────────────────────────────────

async function callWorker(
    messages: { role: string; content: string }[],
    opts: {
        temperature?: number;
        max_tokens?: number;
        signal?: AbortSignal;
        sessionId: string;
    }
): Promise<string> {
    const res = await fetch(CLOUDFLARE_ENDPOINT, {
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

    if (!res.ok) return "";

    const data = await res.json();
    return (
        data?.result?.response ??
        data?.response ??
        data?.choices?.[0]?.message?.content ??
        ""
    );
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
 * Tries rolling windows of 1–6 trailing words to detect the overlap.
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
 * Ensures exactly one space between the typed text and the completion when both
 * sides are non-whitespace word characters.  Prevents run-on tokens like
 * "SELECTcount(*)" while avoiding double-spaces.
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

// ── SQL keyword set (for schema guard) ───────────────────────────────────────

const SQL_KEYWORDS = new Set([
    "select","from","where","join","on","insert","into","values","update","set",
    "delete","create","table","drop","alter","add","column","returning","limit",
    "offset","order","by","group","having","as","and","or","not","in","is","null",
    "like","between","exists","distinct","count","sum","avg","min","max","with",
    "inner","left","right","full","outer","cross","union","all","except","intersect",
    "true","false","case","when","then","else","end","cast","coalesce","nullif",
    "default","primary","key","unique","index","constraint","references","foreign",
    "integer","int","bigint","text","varchar","boolean","bool","timestamp","date",
    "serial","float","numeric","jsonb","json","uuid","array","using","ilike",
    "returning","begin","commit","rollback","transaction","explain","analyze",
    "public","pg_catalog","information_schema","current_timestamp","now",
]);

// ── System prompts ────────────────────────────────────────────────────────────

function dropdownPrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, an expert PostgreSQL assistant embedded inside ${appName}.

${schemaBlock}

YOUR TASK
─────────
Complete the partial SQL query the user is writing.
Return a list of up to 5 high-quality, ready-to-use SQL completions.

OUTPUT RULES
────────────
1. Output ONLY raw SQL completions — one per line, no numbering.
2. Every table name and column name MUST exist in DATABASE SCHEMA above.
   Never invent or guess names not listed there.
3. Each suggestion must be a valid SQL fragment that finishes the user's query.
4. No explanations. No markdown. No code fences. No blank lines.
5. Rank suggestions from most to least likely to be what the user wants.`;
}

function inlinePrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    const hasColumns = Object.keys(schema.columns).length > 0;

    return `\
You are Nova, a SQL ghost-text completion engine for ${appName}.

${schemaBlock}

YOUR TASK
─────────
The user is actively typing a SQL query.
Your job: output the text that should appear immediately after the cursor.

STRICT RULES — follow every rule or the output will be rejected
──────────────────────────────────────────────────────────────
1. OUTPUT ONLY the continuation from the cursor.
   Never repeat any text the user has already typed.

2. ${hasColumns
        ? "ONLY use column names listed in DATABASE SCHEMA. Using unlisted names is FORBIDDEN."
        : "Do not invent column names. Complete SQL keywords and structure only."}

3. ONLY use table names from DATABASE SCHEMA. Never invent table names.

4. Return a SINGLE continuation (not a list).
   No markdown. No code fences. No explanations. No blank lines.

5. Match the style of the existing query:
   — same keyword case (upper/lower)
   — same spacing style

6. If the SQL is already syntactically complete, output an empty string.

7. Do NOT start the continuation with text that already ends the user's query.`;
}

function nextActionPrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, a SQL advisor embedded in ${appName}.

${schemaBlock}

YOUR TASK
─────────
The user has written a SQL query. Suggest 3 concise, actionable next steps
or improvements they could make to the query.

OUTPUT RULES
────────────
1. Output EXACTLY 3 suggestions — one per line.
2. Each suggestion must be ≤ 60 characters.
3. Only reference tables and columns from DATABASE SCHEMA.
4. No numbering, no bullets, no explanations. Plain text only.
5. Be specific and actionable.
   Good: "Add ORDER BY created_at DESC"
   Bad:  "You could add an ORDER BY clause"`;
}

function naturalLanguagePrompt(schema: SchemaContext, appName: string): string {
    const schemaBlock = buildSchemaBlock(schema);
    return `\
You are Nova, an expert PostgreSQL assistant for ${appName}.

${schemaBlock}

YOUR TASK
─────────
Convert the user's natural language description into a valid PostgreSQL query.

OUTPUT RULES
────────────
1. Output ONLY the SQL query — no explanations, no markdown, no code fences.
2. ONLY use table and column names from DATABASE SCHEMA above.
3. Use LIMIT 200 for SELECT queries unless the user specifies a different limit.
4. Use standard PostgreSQL syntax.`;
}

// ── Engine ────────────────────────────────────────────────────────────────────

class AISuggestionEngine {
    private readonly sessionId: string;
    private readonly completionCache: LRUCache<string, string[]>;
    private readonly inlineCache: LRUCache<string, string>;
    private readonly nextActionCache: LRUCache<string, string[]>;

    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly inFlight: Map<string, Promise<string[]>> = new Map();
    private inlineAbort: AbortController | null = null;

    constructor() {
        this.sessionId = crypto.randomUUID();
        this.completionCache = new LRUCache(120);
        this.inlineCache = new LRUCache(250);
        this.nextActionCache = new LRUCache(80);
    }

    // ── Cache keys ──────────────────────────────────────────────────────────

    private ck(sql: string, tables: string[]): string {
        return `c::${sql.slice(-200)}::${tables.slice(0, 8).join(",")}`;
    }
    private ik(prefix: string, tables: string[]): string {
        return `i::${prefix.slice(-300)}::${tables.slice(0, 8).join(",")}`;
    }
    private nk(sql: string, tables: string[]): string {
        return `n::${sql.slice(-200)}::${tables.slice(0, 8).join(",")}`;
    }

    // ── Dropdown completions (debounced + deduplicated) ──────────────────────

    getSuggestions(sql: string, schema: SchemaContext, callback: SuggestionCallback): void {
        if (!sql.trim()) { callback([]); return; }

        const key = this.ck(sql, schema.tables);
        if (this.completionCache.has(key)) {
            callback(this.completionCache.get(key)!);
            return;
        }
        if (this.inFlight.has(key)) {
            this.inFlight.get(key)!.then(callback);
            return;
        }

        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        this.debounceTimer = setTimeout(() => {
            const promise = (async (): Promise<string[]> => {
                try {
                    const raw = await callWorker(
                        [
                            { role: "system", content: dropdownPrompt(schema, APP_NAME) },
                            { role: "user", content: `Complete this SQL query:\n\n${sql}` },
                        ],
                        { temperature: 0.25, max_tokens: 256, sessionId: this.sessionId }
                    );
                    return raw
                        .split("\n")
                        .map((s) => s.trim())
                        .filter((s) => s.length > 3 && !s.startsWith("--") && !s.startsWith("```"))
                        .slice(0, 5);
                } catch {
                    return [];
                } finally {
                    this.inFlight.delete(key);
                }
            })();

            this.inFlight.set(key, promise);
            promise.then((s) => {
                this.completionCache.set(key, s);
                callback(s);
            });
        }, 350);
    }

    // ── Inline ghost-text completion (Tab-to-accept) ─────────────────────────

    async getInlineCompletion(
        textUntilCursor: string,
        schema: SchemaContext,
        signal?: AbortSignal
    ): Promise<string> {
        if (textUntilCursor.trim().length < 6) return "";

        const key = this.ik(textUntilCursor, schema.tables);
        if (this.inlineCache.has(key)) return this.inlineCache.get(key)!;

        this.inlineAbort?.abort();
        this.inlineAbort = new AbortController();
        const effectiveSignal = signal ?? this.inlineAbort.signal;

        try {
            const raw = await callWorker(
                [
                    { role: "system", content: inlinePrompt(schema, APP_NAME) },
                    {
                        role: "user",
                        content: `SQL typed so far (cursor is at the very end):\n\n${textUntilCursor}\n\nContinue from the cursor:`,
                    },
                ],
                { temperature: 0.1, max_tokens: 150, signal: effectiveSignal, sessionId: this.sessionId }
            );

            let completion = stripCodeFences(raw);

            // Remove any accidental echo of already-typed tokens
            completion = stripLeadingDuplication(completion, textUntilCursor);

            // Fix missing space at word boundary
            completion = ensureProperSpacing(completion, textUntilCursor);

            // Schema guard: reject completions referencing unknown identifiers
            if (Object.keys(schema.columns).length > 0) {
                const allowed = knownColumnSet(schema);
                const knownTables = new Set(schema.tables.map((t) => t.toLowerCase()));

                const identifiers = completion
                    .replace(/'[^']*'/g, "")   // strip string literals
                    .replace(/\d+(\.\d+)?/g, "") // strip numbers
                    .match(/\b[a-z_][a-z0-9_]*\b/gi) ?? [];

                const hasUnknown = identifiers
                    .map((id) => id.toLowerCase())
                    .some((id) => !SQL_KEYWORDS.has(id) && !allowed.has(id) && !knownTables.has(id));

                if (hasUnknown) return "";
            }

            if (completion) this.inlineCache.set(key, completion);
            return completion;
        } catch {
            return "";
        }
    }

    // ── Next-action predictions ───────────────────────────────────────────────

    async getNextActions(sql: string, schema: SchemaContext): Promise<string[]> {
        if (sql.trim().length < 10) return [];

        const key = this.nk(sql, schema.tables);
        if (this.nextActionCache.has(key)) return this.nextActionCache.get(key)!;

        try {
            const raw = await callWorker(
                [
                    { role: "system", content: nextActionPrompt(schema, APP_NAME) },
                    { role: "user", content: `Query:\n\n${sql.trim()}` },
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

    // ── Natural language → SQL ────────────────────────────────────────────────

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
    }
}

export const aiSuggestionEngine = new AISuggestionEngine();
