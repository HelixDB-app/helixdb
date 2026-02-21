import { APP_NAME } from "@/lib/app-config";

const CLOUDFLARE_ENDPOINT = "https://auto-comment.gokulakrishnanr812-492.workers.dev/";

export interface SchemaContext {
    tables: string[];
    columns: Record<string, string[]>;
}

type SuggestionCallback = (suggestions: string[]) => void;

class AISuggestionEngine {
    private readonly sessionId: string;
    private readonly cache: Map<string, string[]>;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly MAX_CACHE = 50;

    constructor() {
        this.sessionId = crypto.randomUUID();
        this.cache = new Map();
    }

    private buildCacheKey(sql: string, tables: string[]): string {
        const suffix = sql.slice(-200);
        const fingerprint = tables.slice(0, 10).join(",");
        return `${suffix}::${fingerprint}`;
    }

    private buildSystemPrompt(schema: SchemaContext): string {
        const tableList = schema.tables.slice(0, 30).join(", ");
        const columnDetails = Object.entries(schema.columns)
            .slice(0, 10)
            .map(([table, cols]) => `${table}(${cols.slice(0, 10).join(", ")})`)
            .join("; ");

        return [
            `You are Nova, an expert SQL assistant integrated into ${APP_NAME}, a PostgreSQL admin tool.`,
            tableList ? `Available tables: ${tableList}.` : "",
            columnDetails ? `Column info: ${columnDetails}.` : "",
            "Respond ONLY with SQL completion suggestions, one per line.",
            "No explanations. No markdown. No code fences. Pure SQL fragments only.",
            "Max 5 suggestions. Each suggestion should complete the user's partial SQL query.",
        ]
            .filter(Boolean)
            .join(" ");
    }

    private evictIfNeeded(): void {
        if (this.cache.size >= this.MAX_CACHE) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
    }

    private async fetchSuggestions(sql: string, schema: SchemaContext): Promise<string[]> {
        const body = {
            conversationId: this.sessionId,
            messages: [
                { role: "system", content: this.buildSystemPrompt(schema) },
                { role: "user", content: `Complete this SQL query:\n${sql}` },
            ],
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            temperature: 0.4,
            max_tokens: 256,
            stream: false,
            skipCache: false,
        };

        const res = await fetch(CLOUDFLARE_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) return [];

        const data = await res.json();
        const text: string =
            data?.result?.response ??
            data?.response ??
            data?.choices?.[0]?.message?.content ??
            "";

        return text
            .split("\n")
            .map((s: string) => s.trim())
            .filter(
                (s: string) =>
                    s.length > 3 &&
                    !s.startsWith("--") &&
                    !s.startsWith("#") &&
                    !s.startsWith("```")
            )
            .slice(0, 5);
    }

    /**
     * Debounced suggestion fetch. Calls `callback` with results (empty array on error/cache miss).
     * If cached, calls callback synchronously.
     */
    getSuggestions(sql: string, schema: SchemaContext, callback: SuggestionCallback): void {
        if (!sql.trim()) {
            callback([]);
            return;
        }

        const key = this.buildCacheKey(sql, schema.tables);
        if (this.cache.has(key)) {
            callback(this.cache.get(key)!);
            return;
        }

        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        this.debounceTimer = setTimeout(async () => {
            try {
                const suggestions = await this.fetchSuggestions(sql, schema);
                this.evictIfNeeded();
                this.cache.set(key, suggestions);
                callback(suggestions);
            } catch {
                callback([]);
            }
        }, 400);
    }

    /**
     * Converts a natural language query to a PostgreSQL SELECT statement.
     */
    async getNaturalLanguageSQL(query: string, schema: SchemaContext): Promise<string> {
        const tableList = schema.tables.slice(0, 30).join(", ");
        const body = {
            conversationId: this.sessionId,
            messages: [
                {
                    role: "system",
                    content: [
                        "You are Nova, an expert SQL assistant.",
                        "Convert the user's natural language request to a single valid PostgreSQL query.",
                        tableList ? `Available tables: ${tableList}.` : "",
                        "Respond ONLY with the SQL. No explanations, no markdown, no code fences.",
                        "Use LIMIT 200 for SELECT queries unless the user specifies otherwise.",
                    ]
                        .filter(Boolean)
                        .join(" "),
                },
                { role: "user", content: query },
            ],
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            temperature: 0.3,
            max_tokens: 256,
            stream: false,
            skipCache: false,
        };

        const res = await fetch(CLOUDFLARE_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error("AI request failed");

        const data = await res.json();
        const text: string =
            data?.result?.response ??
            data?.response ??
            data?.choices?.[0]?.message?.content ??
            "";

        return text
            .replace(/```sql\n?/gi, "")
            .replace(/```\n?/g, "")
            .trim();
    }

    clearCache(): void {
        this.cache.clear();
    }
}

export const aiSuggestionEngine = new AISuggestionEngine();
