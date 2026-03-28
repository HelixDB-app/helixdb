function stripCodeFences(text: string): string {
    let t = text.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
    if (fence?.[1]) t = fence[1].trim();
    return t;
}

/** Parse Gemini JSON output for natural-language search (no side effects). */
export function parseNlSearchModelJson(raw: string): {
    sql?: string;
    title?: string;
    explanation?: string;
    tablesUsed?: unknown;
} | null {
    const cleaned = stripCodeFences(raw.trim());
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const slice = cleaned.slice(start, end + 1);
    try {
        const parsed = JSON.parse(slice) as Record<string, unknown>;
        return {
            sql: typeof parsed.sql === "string" ? parsed.sql : undefined,
            title: typeof parsed.title === "string" ? parsed.title : undefined,
            explanation: typeof parsed.explanation === "string" ? parsed.explanation : undefined,
            tablesUsed: parsed.tablesUsed,
        };
    } catch {
        return null;
    }
}
