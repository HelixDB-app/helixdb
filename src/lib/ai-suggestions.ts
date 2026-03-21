import { APP_NAME } from "@/lib/app-config";
import { notifyNoInternetDetected } from "@/lib/network-errors";
import { isTauriRuntime } from "@/lib/runtime";
import { aiSuggestionsWorkerPost } from "@/lib/tauri";

/** Override with `NEXT_PUBLIC_AI_SUGGESTIONS_WORKER_URL` for your own Worker deployment. */
const DEFAULT_SQL_AI_WORKER_URL = "https://auto-comment.gokulakrishnanr812-492.workers.dev/";
const DEFAULT_SQL_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function readEnvVar(key: string): string {
    return typeof process !== "undefined" ? process.env[key]?.trim() ?? "" : "";
}

function readSettingValue(key: string): string {
    if (typeof window === "undefined") return "";
    try {
        const raw = window.localStorage.getItem("helix-settings");
        if (!raw) return "";
        const parsed = JSON.parse(raw) as { state?: Record<string, unknown> } | null;
        const value = parsed?.state?.[key];
        return typeof value === "string" ? value.trim() : "";
    } catch {
        return "";
    }
}

function sqlAiWorkerUrl(): string {
    return (
        readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_WORKER_URL")
        || readSettingValue("aiWorkerUrl")
        || DEFAULT_SQL_AI_WORKER_URL
    );
}

function hasExplicitWorkerUrl(): boolean {
    return Boolean(readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_WORKER_URL") || readSettingValue("aiWorkerUrl"));
}

function sqlAiCompleteUrl(): string {
    const fromEnv = readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_COMPLETE_URL");
    if (fromEnv) {
        return fromEnv.includes("/complete") ? fromEnv : `${fromEnv.replace(/\/+$/, "")}/complete`;
    }
    const fromSettings = readSettingValue("aiCompletionUrl");
    if (fromSettings) {
        return fromSettings.includes("/complete")
            ? fromSettings
            : `${fromSettings.replace(/\/+$/, "")}/complete`;
    }
    const base = sqlAiWorkerUrl().replace(/\/+$/, "");
    return `${base}/complete`;
}

type AiProvider = { url: string; model: string };
type CompletionProvider = { url: string };

type CallResult = {
    text: string;
    usedStream: boolean;
};

type StreamOptions = {
    maxChars?: number;
    maxLines?: number;
    stopOnPattern?: RegExp;
};

function normalizeProviders(list: AiProvider[]): AiProvider[] {
    const seen = new Set<string>();
    const out: AiProvider[] = [];
    for (const provider of list) {
        if (!provider.url) continue;
        const key = `${provider.url}::${provider.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(provider);
    }
    return out;
}

function suggestionProviders(): AiProvider[] {
    const primaryModel = readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_MODEL") || DEFAULT_SQL_AI_MODEL;
    const secondaryUrl = readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_SECONDARY_URL");
    const secondaryModel = readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_SECONDARY_MODEL") || primaryModel;
    return normalizeProviders([
        { url: sqlAiWorkerUrl(), model: primaryModel },
        { url: secondaryUrl, model: secondaryModel },
    ]);
}

function normalizeCompletionProviders(list: CompletionProvider[]): CompletionProvider[] {
    const seen = new Set<string>();
    const out: CompletionProvider[] = [];
    for (const provider of list) {
        if (!provider.url) continue;
        const key = provider.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(provider);
    }
    return out;
}

function completionProviders(): CompletionProvider[] {
    const secondaryUrl = readEnvVar("NEXT_PUBLIC_AI_SUGGESTIONS_COMPLETE_SECONDARY_URL");
    return normalizeCompletionProviders([
        { url: sqlAiCompleteUrl() },
        { url: secondaryUrl },
    ]);
}

function extractWorkerResponseText(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const d = data as Record<string, unknown>;
    const result = d.result;
    if (typeof result === "string") {
        const trimmed = result.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            try {
                return extractWorkerResponseText(JSON.parse(trimmed) as unknown);
            } catch {
                return result;
            }
        }
        return result;
    }
    if (result && typeof result === "object") {
        const rObj = result as { response?: unknown; text?: unknown; output?: unknown; completion?: unknown };
        if (typeof rObj.response === "string") return rObj.response;
        if (typeof rObj.text === "string") return rObj.text;
        if (typeof rObj.output === "string") return rObj.output;
        if (typeof rObj.completion === "string") return rObj.completion;
    }
    if (typeof d.response === "string") return d.response;
    if (typeof d.output === "string") return d.output;
    if (typeof d.text === "string") return d.text;
    if (typeof d.completion === "string") return d.completion;
    const choices = d.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const msg = (choices[0] as { message?: { content?: unknown } }).message;
        if (msg && typeof msg.content === "string") return msg.content;
    }
    return "";
}

export interface SchemaContext {
    tables: string[];
    /** tableName → ordered list of column names (pre-populated on connect) */
    columns: Record<string, string[]>;
}

export interface AISuggestionTelemetry {
    latencyMs: number;
    source: "network" | "coalesced" | "stream" | "cache";
}

export interface AISuggestionBatch {
    suggestions: string[];
    telemetry: AISuggestionTelemetry;
    error?: string;
}

export interface AIInlineCompletionResult {
    completion: string;
    telemetry: AISuggestionTelemetry;
    error?: string;
}

export interface AISuggestionOptions {
    signal?: AbortSignal;
    maxSuggestions?: number;
    contextWindowChars?: number;
    fullSql?: string;
    cursorOffset?: number;
    preferSingleLine?: boolean;
    recentCompletions?: string[];
    recentRejections?: string[];
    skipCache?: boolean;
}

type SuggestionCallback = (suggestions: string[]) => void;

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
function trimSqlContext(sql: string, maxChars: number, preserveTrailingNewline = false): string {
    const endsWithNewline = preserveTrailingNewline && /\n\s*$/.test(sql);
    const normalized = sql.replace(/\u0000/g, "").replace(/\s+$/, "");
    let trimmed = normalized.length <= maxChars ? normalized : normalized.slice(-maxChars);
    if (endsWithNewline && !trimmed.endsWith("\n")) {
        trimmed = trimmed.length < maxChars ? `${trimmed}\n` : trimmed;
    }
    return trimmed;
}

function normalizeForDedup(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLineKey(line: string): string {
    return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeSqlText(sql: string): string {
    return sql.replace(/\u0000/g, "");
}

function recentNonEmptyLines(sql: string, maxLines = 8): string[] {
    return sql
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-maxLines);
}

function isNewStatementStart(fragment: string): boolean {
    return /^\s*(select|insert|update|delete|create|drop|alter|with|grant|revoke|begin|commit|rollback)\b/i.test(fragment);
}

function canStartNewStatement(textUntilCursor: string): boolean {
    const trimmed = textUntilCursor.trimEnd();
    if (!trimmed) return true;
    const lastSemi = trimmed.lastIndexOf(";");
    const tail = lastSemi >= 0 ? trimmed.slice(lastSemi + 1) : trimmed;
    const tailTrimmed = tail.trim();
    if (!tailTrimmed) return true;
    if (!/\s/.test(tailTrimmed) && tailTrimmed.length <= 12) return true; // partial keyword
    return false;
}

function isInsideCreateTableColumns(textUntilCursor: string): boolean {
    const lower = textUntilCursor.toLowerCase();
    const createIdx = lower.lastIndexOf("create table");
    if (createIdx === -1) return false;
    const after = textUntilCursor.slice(createIdx);
    const openIdx = after.indexOf("(");
    if (openIdx === -1) return false;
    const body = after.slice(openIdx + 1);
    let depth = 1;
    for (const ch of body) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (depth === 0) return false;
    }
    return depth > 0;
}

function extractCurrentCreateTableColumns(textUntilCursor: string): Set<string> {
    const lower = textUntilCursor.toLowerCase();
    const createIdx = lower.lastIndexOf("create table");
    if (createIdx === -1) return new Set();
    const after = textUntilCursor.slice(createIdx);
    const openIdx = after.indexOf("(");
    if (openIdx === -1) return new Set();
    const body = after.slice(openIdx + 1);

    const cols = new Set<string>();
    let depth = 0;
    let segmentStart = 0;
    const pushSegment = (seg: string) => {
        const trimmed = seg.trim();
        if (!trimmed) return;
        const lowerSeg = trimmed.toLowerCase();
        if (/^(constraint|primary|foreign|unique|check)\b/.test(lowerSeg)) return;
        const token = normalizeSqlIdentifier(trimmed.split(/\s+/)[0] || "");
        if (token) cols.add(token.toLowerCase());
    };

    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "(") depth += 1;
        if (ch === ")") depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) {
            pushSegment(body.slice(segmentStart, i));
            segmentStart = i + 1;
        }
    }
    pushSegment(body.slice(segmentStart));
    return cols;
}

function hasRepeatedKeyword(line: string): boolean {
    const lower = line.toLowerCase();
    const valuesIdx = lower.indexOf("values");
    if (valuesIdx >= 0 && lower.indexOf("values", valuesIdx + 6) >= 0) return true;
    if (/(insert\s+into).*\1/i.test(lower)) return true;
    if (/(create\s+index).*\1/i.test(lower)) return true;
    return false;
}

function looksLikeSql(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/^[a-z0-9_]+\s*[,)]?$/.test(trimmed)) return true;
    const lower = trimmed.toLowerCase();
    if (/\b(select|insert|update|delete|create|drop|alter|with|values|into|index|table|from|join)\b/.test(lower)) {
        return true;
    }
    if (/\b(primary|key|not|null|unique|default|varchar|text|timestamp|uuid|serial|integer|int|bigint|boolean|numeric|date|jsonb|json|float)\b/.test(lower)) {
        return true;
    }
    if (/[();]/.test(trimmed) && /[a-z]/i.test(trimmed)) return true;
    return false;
}

function shouldJoinTailToken(
    tailToken: string,
    completion: string,
    schema: SchemaContext,
    insideCreateTable: boolean
): boolean {
    if (!insideCreateTable) return false;
    const token = tailToken.trim();
    if (!token || token.length > 6) return false;
    const trimmed = completion.trimStart();
    if (!/^[a-z_]/.test(trimmed)) return false;
    const combined = (token + trimmed).toLowerCase();
    const knownCols = knownColumnSet(schema);
    if (knownCols.has(combined)) return true;
    const commonCols = new Set([
        "created_at",
        "updated_at",
        "deleted_at",
        "full_name",
        "first_name",
        "last_name",
        "user_id",
        "account_id",
        "phone",
        "phone_number",
        "email",
        "status",
    ]);
    if (commonCols.has(combined)) return true;
    if (combined.includes("_") && token.length <= 3) return true;
    return false;
}

function isNonSqlResponse(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const hasWords = /[a-z]{4,}/i.test(trimmed);
    if (!hasWords) return false;
    if (looksLikeSql(trimmed)) return false;
    return true;
}

function guessCreateTableColumnDefinition(columnName: string): string {
    const name = columnName.trim();
    const lower = name.toLowerCase();
    if (!name) return "";
    if (lower === "id") return `${name} UUID PRIMARY KEY DEFAULT gen_random_uuid(),`;
    if (lower.endsWith("_id")) return `${name} UUID NOT NULL,`;
    if (lower === "created_at") return `${name} TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),`;
    if (lower === "updated_at") return `${name} TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),`;
    if (lower.includes("email")) return `${name} VARCHAR(255) UNIQUE NOT NULL,`;
    if (lower.includes("name")) return `${name} VARCHAR(255) NOT NULL,`;
    if (lower.includes("title")) return `${name} VARCHAR(255) NOT NULL,`;
    if (lower.includes("description") || lower === "desc") return `${name} TEXT,`;
    if (lower.includes("status")) return `${name} VARCHAR(30) NOT NULL DEFAULT 'active',`;
    if (lower.includes("age")) return `${name} INTEGER,`;
    if (lower.includes("price") || lower.includes("amount") || lower.includes("total")) {
        return `${name} NUMERIC(12,2) NOT NULL,`;
    }
    if (lower.startsWith("is_") || lower.startsWith("has_") || lower.startsWith("can_")) {
        return `${name} BOOLEAN NOT NULL DEFAULT FALSE,`;
    }
    return `${name} VARCHAR(255) NOT NULL,`;
}

function buildCreateTableFallback(
    textUntilCursor: string,
    schema: SchemaContext
): string {
    if (!isInsideCreateTableColumns(textUntilCursor)) return "";
    const tailToken = textUntilCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
    const existing = extractCurrentCreateTableColumns(textUntilCursor);
    const candidates = Array.from(knownColumnSet(schema));

    const createMatch = textUntilCursor
        .toLowerCase()
        .match(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/i);
    const tableName = createMatch?.[1] ?? "";
    const tableCandidates = schema.tables;
    const findClosestTable = () => {
        if (!tableName) return "";
        const lower = tableName.toLowerCase();
        let best = "";
        let bestScore = 0;
        for (const t of tableCandidates) {
            const tl = t.toLowerCase();
            if (tl === lower) return t;
            let score = 0;
            if (lower.startsWith(tl) || tl.startsWith(lower)) {
                score = Math.min(lower.length, tl.length) + 2;
            } else if (lower.includes(tl) || tl.includes(lower)) {
                score = Math.min(lower.length, tl.length);
            }
            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }
        return best;
    };

    let columnName = "";
    if (tailToken.length >= 2) {
        const match = candidates.find((c) => c.startsWith(tailToken.toLowerCase()));
        columnName = match ?? tailToken;
    } else {
        const closestTable = findClosestTable();
        const cols = closestTable
            ? schema.columns[closestTable.toLowerCase()] ?? schema.columns[closestTable] ?? []
            : [];
        columnName = cols.find((c) => !existing.has(c.toLowerCase())) ?? "";
        if (!columnName) {
            const defaults = ["full_name", "phone", "status", "created_at", "updated_at"];
            columnName = defaults.find((c) => !existing.has(c)) ?? "";
        }
    }

    if (!columnName || existing.has(columnName.toLowerCase())) return "";
    const expanded = guessCreateTableColumnDefinition(columnName);
    if (!expanded) return "";

    const suffix =
        tailToken && expanded.toLowerCase().startsWith(tailToken.toLowerCase())
            ? expanded.slice(tailToken.length)
            : expanded;
    const currentLine = textUntilCursor.split("\n").pop() ?? "";
    const currentIndent = currentLine.match(/^\s*/)?.[0] ?? "";
    const completion = ensureProperSpacing(suffix, textUntilCursor);
    if (!currentLine.trim() && currentIndent) {
        return currentIndent + completion.trimStart();
    }
    return completion;
}

function applyTypedPrefix(completion: string, textUntilCursor: string): string {
    if (!completion) return "";
    const tailToken = textUntilCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
    if (tailToken && completion.toLowerCase().startsWith(tailToken.toLowerCase())) {
        return completion.slice(tailToken.length);
    }
    return ensureProperSpacing(completion, textUntilCursor);
}

function guessValueForColumn(columnName: string): string {
    const lower = columnName.toLowerCase();
    if (lower === "id" || lower.endsWith("_id")) return "gen_random_uuid()";
    if (lower === "created_at" || lower === "updated_at") return "NOW()";
    if (lower.includes("email")) return "'user@example.com'";
    if (lower.includes("name")) return "'name'";
    if (lower.includes("title")) return "'title'";
    if (lower.includes("description") || lower === "desc") return "'description'";
    if (lower.includes("status")) return "'active'";
    if (lower.includes("age")) return "0";
    if (lower.includes("price") || lower.includes("amount") || lower.includes("total")) return "0";
    if (lower.startsWith("is_") || lower.startsWith("has_") || lower.startsWith("can_")) return "FALSE";
    return "'value'";
}

function buildInsertFallback(
    textUntilCursor: string,
    schema: SchemaContext
): string {
    const line = textUntilCursor.split("\n").pop() ?? "";
    const trimmed = line.trim();
    if (!/^(ins|insert)\b/i.test(trimmed)) return "";

    const tableMatch = trimmed.match(/insert\s+into\s+([a-z_][a-z0-9_]*)?$/i);
    const partialTable = tableMatch?.[1] ?? "";
    const tables = schema.tables.length > 0 ? schema.tables : [];
    if (tables.length === 0) return "";

    let table = tables[tables.length - 1];
    if (partialTable) {
        const match = tables.find((t) => t.toLowerCase().startsWith(partialTable.toLowerCase()));
        if (match) table = match;
    }

    const cols =
        schema.columns[table.toLowerCase()] ??
        schema.columns[table] ??
        [];
    const statement =
        cols.length === 0
            ? `INSERT INTO ${table} (column1, column2) VALUES ('value', 'value');`
            : `INSERT INTO ${table} (${cols.slice(0, 6).join(", ")}) VALUES (${cols
                .slice(0, 6)
                .map((c) => guessValueForColumn(c))
                .join(", ")});`;
    return applyTypedPrefix(statement, textUntilCursor);
}

function buildCreateIndexFallback(
    textUntilCursor: string,
    schema: SchemaContext
): string {
    const line = textUntilCursor.split("\n").pop() ?? "";
    const trimmed = line.trim();
    if (!/^(crea|create)\s+ind/i.test(trimmed)) return "";

    const tables = schema.tables.length > 0 ? schema.tables : [];
    if (tables.length === 0) return "";
    const table = tables[tables.length - 1];
    const cols =
        schema.columns[table.toLowerCase()] ??
        schema.columns[table] ??
        [];
    const column = cols.find((c) => c.toLowerCase().includes("email"))
        || cols.find((c) => c.toLowerCase().includes("name"))
        || cols[0]
        || "id";
    const indexName = `idx_${table}_${column}`;
    const statement = `CREATE INDEX ${indexName} ON ${table} (${column});`;
    return applyTypedPrefix(statement, textUntilCursor);
}

function buildInlineFallback(
    textUntilCursor: string,
    schema: SchemaContext
): string {
    const createTableFallback = buildCreateTableFallback(textUntilCursor, schema);
    if (createTableFallback) return createTableFallback;
    const insertFallback = buildInsertFallback(textUntilCursor, schema);
    if (insertFallback) return insertFallback;
    const indexFallback = buildCreateIndexFallback(textUntilCursor, schema);
    if (indexFallback) return indexFallback;
    return "";
}

function buildInlineContext(
    fullSql: string,
    cursorOffset: number,
    budget: number
): {
    contextBlock: string;
    prefixTail: string;
    suffixHead: string;
    currentLine: string;
} {
    const sql = normalizeSqlText(fullSql);
    const safeOffset = clamp(cursorOffset, 0, sql.length);
    const prefix = sql.slice(0, safeOffset);
    const suffix = sql.slice(safeOffset);

    const totalBudget = clamp(budget, 400, 6000);
    const headBudget = Math.max(120, Math.floor(totalBudget * 0.15));
    const tailBudget = Math.max(120, Math.floor(totalBudget * 0.15));
    const prefixBudget = Math.max(220, Math.floor(totalBudget * 0.45));
    const suffixBudget = Math.max(180, totalBudget - headBudget - tailBudget - prefixBudget);

    const prefixTail = prefix.length > prefixBudget ? prefix.slice(-prefixBudget) : prefix;
    const suffixHead = suffix.length > suffixBudget ? suffix.slice(0, suffixBudget) : suffix;

    const blocks: string[] = [];
    if (prefix.length > prefixBudget) {
        const head = sql.slice(0, headBudget);
        blocks.push(`FILE START (trimmed)\n${head}`);
    }

    blocks.push(`NEAR CURSOR\n${prefixTail}\n<<<CURSOR>>>\n${suffixHead}`);

    if (suffix.length > suffixBudget) {
        const tail = sql.slice(Math.max(0, sql.length - tailBudget));
        blocks.push(`FILE END (trimmed)\n${tail}`);
    }

    const currentLine = prefix.split("\n").pop() ?? "";
    return {
        contextBlock: blocks.join("\n\n"),
        prefixTail,
        suffixHead,
        currentLine,
    };
}

function buildCompletionSql(
    fullSql: string | undefined,
    textUntilCursor: string,
    contextWindowChars: number
): string {
    return trimSqlContext(textUntilCursor, contextWindowChars, true);
}

function allowMultiLineAfterTerminator(textUntilCursor: string): boolean {
    const lines = textUntilCursor.split("\n");
    const currentLine = lines[lines.length - 1] ?? "";
    if (currentLine.trim()) return false;
    for (let i = lines.length - 2; i >= 0; i -= 1) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;
        return /;\s*$/.test(trimmed);
    }
    return false;
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

function buildSchemaMap(schema: SchemaContext): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const table of schema.tables) {
        const cols = schema.columns[table] ?? schema.columns[table.toLowerCase()] ?? [];
        out[table] = cols;
    }
    return out;
}

function normalizeSqlIdentifier(input: string): string {
    const trimmed = input.trim().replace(/;+$/, "");
    const unquoted = trimmed.replace(/^["'`]/, "").replace(/["'`]$/, "");
    const parts = unquoted.split(".");
    return parts[parts.length - 1] || unquoted;
}

function extractSchemaFromSql(sql: string): SchemaContext {
    const tables: string[] = [];
    const columns: Record<string, string[]> = {};
    const lower = sql.toLowerCase();
    let idx = 0;

    while (idx < lower.length) {
        const hit = lower.indexOf("create table", idx);
        if (hit === -1) break;
        idx = hit + "create table".length;

        const after = sql.slice(hit, Math.min(sql.length, hit + 200));
        const match = after.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/i);
        if (!match) continue;
        const tableToken = normalizeSqlIdentifier(match[1]);
        if (!tableToken) continue;

        const openIdx = sql.indexOf("(", hit);
        if (openIdx === -1) continue;

        let depth = 0;
        let closeIdx = -1;
        for (let i = openIdx; i < sql.length; i += 1) {
            const ch = sql[i];
            if (ch === "(") depth += 1;
            if (ch === ")") {
                depth -= 1;
                if (depth === 0) {
                    closeIdx = i;
                    break;
                }
            }
        }
        if (closeIdx === -1) continue;

        const body = sql.slice(openIdx + 1, closeIdx);
        const parts: string[] = [];
        let segmentStart = 0;
        let segDepth = 0;
        for (let i = 0; i < body.length; i += 1) {
            const ch = body[i];
            if (ch === "(") segDepth += 1;
            if (ch === ")") segDepth = Math.max(0, segDepth - 1);
            if (ch === "," && segDepth === 0) {
                parts.push(body.slice(segmentStart, i));
                segmentStart = i + 1;
            }
        }
        parts.push(body.slice(segmentStart));

        const colList: string[] = [];
        for (const raw of parts) {
            const line = raw.trim();
            if (!line) continue;
            const lowerLine = line.toLowerCase();
            if (/^(constraint|primary|foreign|unique|check)\b/.test(lowerLine)) continue;
            const token = normalizeSqlIdentifier(line.split(/\s+/)[0] || "");
            if (!token) continue;
            colList.push(token);
        }

        if (colList.length > 0) {
            tables.push(tableToken);
            columns[tableToken.toLowerCase()] = Array.from(new Set(colList));
        } else if (!tables.includes(tableToken)) {
            tables.push(tableToken);
        }
    }

    return { tables, columns };
}

function mergeSchema(base: SchemaContext, extra?: SchemaContext): SchemaContext {
    if (!extra) return base;
    const tables = Array.from(new Set([...base.tables, ...extra.tables]));
    const columns: Record<string, string[]> = { ...base.columns };
    for (const [table, cols] of Object.entries(extra.columns)) {
        const key = table.toLowerCase();
        const existing = columns[key] ?? [];
        columns[key] = Array.from(new Set([...existing, ...cols]));
    }
    return { tables, columns };
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

function extractStreamChunkText(data: unknown): string {
    if (!data) return "";
    if (typeof data === "string") return data;
    if (typeof data !== "object") return "";
    const d = data as Record<string, unknown>;
    if (typeof d.response === "string") return d.response;
    if (typeof d.delta === "string") return d.delta;
    if (typeof d.output === "string") return d.output;
    if (typeof d.text === "string") return d.text;
    if (typeof d.completion === "string") return d.completion;
    const choices = d.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const choice = choices[0] as Record<string, unknown>;
        const delta = choice.delta as { content?: unknown } | undefined;
        const msg = choice.message as { content?: unknown } | undefined;
        if (delta && typeof delta.content === "string") return delta.content;
        if (msg && typeof msg.content === "string") return msg.content;
    }
    if (d.result) return extractStreamChunkText(d.result);
    return "";
}

type CompletionCallResult = {
    completion: string;
    cached: boolean;
    latencyMs?: number;
    error?: string;
};

type CompletionProviderState = {
    lastCallAt: number;
    cooldownUntil: number;
    failures: number;
};

const COMPLETION_MIN_INTERVAL_MS = 80;
const COMPLETION_MAX_BACKOFF_MS = 4000;
const completionProviderState = new Map<string, CompletionProviderState>();

function getCompletionProviderState(url: string): CompletionProviderState {
    const existing = completionProviderState.get(url);
    if (existing) return existing;
    const created: CompletionProviderState = { lastCallAt: 0, cooldownUntil: 0, failures: 0 };
    completionProviderState.set(url, created);
    return created;
}

function canCallCompletionProvider(url: string): boolean {
    const state = getCompletionProviderState(url);
    const now = nowMs();
    if (state.cooldownUntil && now < state.cooldownUntil) return false;
    if (state.lastCallAt && now - state.lastCallAt < COMPLETION_MIN_INTERVAL_MS) return false;
    return true;
}

function markCompletionProviderCall(url: string): void {
    const state = getCompletionProviderState(url);
    state.lastCallAt = nowMs();
}

function markCompletionProviderSuccess(url: string): void {
    const state = getCompletionProviderState(url);
    state.failures = 0;
    state.cooldownUntil = 0;
}

function markCompletionProviderFailure(url: string): void {
    const state = getCompletionProviderState(url);
    state.failures = Math.min(6, state.failures + 1);
    const backoff = Math.min(COMPLETION_MAX_BACKOFF_MS, 250 * Math.pow(2, state.failures - 1));
    state.cooldownUntil = nowMs() + backoff;
}

function extractCompletionResponse(data: unknown): CompletionCallResult {
    if (!data || typeof data !== "object") return { completion: "", cached: false };
    const d = data as Record<string, unknown>;
    if (typeof d.error === "string" && d.error.trim()) {
        return { completion: "", cached: false, error: d.error.trim() };
    }
    let completion = "";
    if (typeof d.completion === "string") completion = d.completion;
    if (!completion) completion = extractWorkerResponseText(data);
    const cached =
        typeof d.cached === "boolean"
            ? d.cached
            : typeof (d.result as { cached?: unknown } | undefined)?.cached === "boolean"
                ? Boolean((d.result as { cached?: unknown }).cached)
                : false;
    const latencyMs =
        typeof d.latency_ms === "number"
            ? d.latency_ms
            : typeof d.latencyMs === "number"
                ? d.latencyMs
                : typeof (d.result as { latency_ms?: unknown } | undefined)?.latency_ms === "number"
                    ? Number((d.result as { latency_ms?: unknown }).latency_ms)
                    : undefined;
    return { completion, cached, latencyMs };
}

function shouldStopStream(text: string, opts?: StreamOptions): boolean {
    if (!opts) return false;
    if (opts.stopOnPattern && opts.stopOnPattern.test(text)) return true;
    if (opts.maxLines && text.split("\n").length >= opts.maxLines) return true;
    if (opts.maxChars && text.length >= opts.maxChars) return true;
    return false;
}

/**
 * Removes any prefix the model echoed back from the already-typed text.
 * Tries rolling windows of 1–6 trailing words to detect overlap.
 */
type StripResult = { text: string; stripped: boolean; needsSpace: boolean };

function stripLeadingDuplication(completion: string, textUntilCursor: string): StripResult {
    if (!completion) return { text: "", stripped: false, needsSpace: false };
    const candidate = completion.trimStart();
    const words = textUntilCursor.trimEnd().split(/\s+/).filter(Boolean);

    for (let w = Math.min(6, words.length); w >= 1; w--) {
        const suffix = words.slice(-w).join(" ");
        if (candidate.toLowerCase().startsWith(suffix.toLowerCase())) {
            const nextChar = candidate[suffix.length] ?? "";
            const continuesWord = /[A-Za-z0-9_]/.test(nextChar);
            const stripped = candidate.slice(suffix.length).replace(/^\s+/, "");
            return { text: stripped, stripped: true, needsSpace: !continuesWord };
        }
    }
    return { text: completion, stripped: false, needsSpace: false };
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

        const dedup = stripLeadingDuplication(suggestion, textUntilCursor);
        suggestion = dedup.text;
        if (dedup.stripped && dedup.needsSpace) {
            suggestion = " " + suggestion;
        } else if (!dedup.stripped) {
            suggestion = ensureProperSpacing(suggestion, textUntilCursor);
        }
        suggestion = suggestion.trimEnd();

        if (!suggestion || suggestion.length < 2) continue;
        if (!looksLikeSql(suggestion)) continue;
        if (hasUnknownIdentifiers(suggestion, schema)) continue;

        const key = normalizeForDedup(suggestion);
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({ text: suggestion, score: scoreSuggestion(suggestion, textUntilCursor), idx });
    }

    out.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return out.slice(0, maxSuggestions).map((x) => x.text);
}

function sanitizeInlineCompletion(
    raw: string,
    textUntilCursor: string,
    schema: SchemaContext,
    fullSql?: string,
    preferSingleLine?: boolean,
    recentRejections?: string[]
): string {
    const cleaned = stripCodeFences(raw).replace(/<<<CURSOR>>>/g, "").trimEnd();
    const lines = cleaned.split("\n").map((line) => line.trimEnd());

    // Find first non-empty line index
    const firstNonEmptyIdx = lines.findIndex((line) => line.length > 0);
    if (firstNonEmptyIdx === -1) return "";

    if (!looksLikeSql(lines[firstNonEmptyIdx] ?? "")) return "";

    const insideCreateTable = isInsideCreateTableColumns(textUntilCursor);
    const existingColumns = insideCreateTable ? extractCurrentCreateTableColumns(textUntilCursor) : new Set<string>();
    const maxLines = preferSingleLine ? 1 : insideCreateTable ? 12 : 4;

    // Take up to N lines for block-level suggestions
    let relevantLines = lines.slice(firstNonEmptyIdx, firstNonEmptyIdx + maxLines)
        // Trim trailing empty lines
        .reduceRight<string[]>((acc, line) => {
            if (acc.length === 0 && line.length === 0) return acc;
            acc.unshift(line);
            return acc;
        }, []);

    if (relevantLines.length === 0) return "";

    const recentLines = recentNonEmptyLines(
        trimSqlContext(fullSql ?? textUntilCursor, 2400),
        12
    );
    const recentLineKeys = new Set(recentLines.map((line) => normalizeLineKey(line)));
    const rejectionKeys = new Set((recentRejections ?? []).map((line) => normalizeLineKey(line)));

    const filteredLines: string[] = [];
    const seenKeys = new Set<string>();
    for (const line of relevantLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const key = normalizeLineKey(trimmed);
        if (!key) continue;
        if (seenKeys.has(key)) continue;
        if (recentLineKeys.has(key) && key.length > 6) continue;
        if (rejectionKeys.has(key)) continue;
        if (hasRepeatedKeyword(trimmed)) continue;
        if (insideCreateTable) {
            if (isNewStatementStart(trimmed)) continue;
            const colMatch = trimmed.match(/^["'`]?([a-z_][a-z0-9_]*)["'`]?\b/i);
            if (colMatch) {
                const colName = colMatch[1]?.toLowerCase();
                if (colName && existingColumns.has(colName)) continue;
            }
        }
        seenKeys.add(key);
        filteredLines.push(line);
    }

    relevantLines = filteredLines;

    if (relevantLines.length === 0) return "";

    const allowStatementStart = canStartNewStatement(textUntilCursor);
    const lastChar = textUntilCursor.slice(-1);
    const tailToken =
        /[A-Za-z0-9_]/.test(lastChar)
            ? textUntilCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? ""
            : "";
    const currentLine = textUntilCursor.split("\n").pop() ?? "";
    const currentIndent = textUntilCursor.split("\n").pop()?.match(/^\s*/)?.[0] ?? "";

    if (tailToken) {
        const firstLine = relevantLines[0]?.trimStart() ?? "";
        if (firstLine && !firstLine.toLowerCase().startsWith(tailToken.toLowerCase())) {
            return "";
        }
    }

    if (currentIndent && relevantLines.length > 1) {
        relevantLines = relevantLines.map((line, idx) => {
            if (idx === 0) return line;
            if (/^\s+/.test(line)) return line;
            return currentIndent + line.trimStart();
        });
    }

    // For single-line: apply standard dedup and spacing
    if (relevantLines.length === 1) {
        const dedup = stripLeadingDuplication(relevantLines[0], textUntilCursor);
        let completion = dedup.text;
        if (dedup.stripped && dedup.needsSpace && completion) {
            completion = " " + completion;
        } else if (!dedup.stripped) {
            const tailToken = textUntilCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
            if (shouldJoinTailToken(tailToken, completion, schema, insideCreateTable)) {
                completion = completion.replace(/^\s+/, "");
            } else {
                completion = ensureProperSpacing(completion, textUntilCursor);
            }
        }
        completion = completion
            .replace(/^(insert|select|update|delete|create)\s+\1\b/i, "$1")
            .replace(/\b(create\s+index)\s+\1\b/i, "$1");
        if (completion.length > 400) {
            completion = completion.slice(0, 400).trimEnd();
        }
        const trimmedCompletion = completion.trim();
        if (
            insideCreateTable &&
            trimmedCompletion.length > 0 &&
            !/\s/.test(trimmedCompletion) &&
            !trimmedCompletion.includes("(")
        ) {
            const bareToken = trimmedCompletion.replace(/,+$/, "");
            if (bareToken) {
                const fullToken = tailToken && !bareToken.toLowerCase().startsWith(tailToken.toLowerCase())
                    ? `${tailToken}${bareToken}`
                    : bareToken;
                const expanded = guessCreateTableColumnDefinition(fullToken);
                if (expanded) {
                    const suffix =
                        tailToken && expanded.toLowerCase().startsWith(tailToken.toLowerCase())
                            ? expanded.slice(tailToken.length)
                            : expanded;
                    completion = ensureProperSpacing(suffix, textUntilCursor);
                    if (!currentLine.trim() && currentIndent) {
                        completion = currentIndent + completion.trimStart();
                    }
                }
            }
        }
        if (rejectionKeys.has(normalizeLineKey(completion))) return "";
        if (!allowStatementStart && isNewStatementStart(completion)) return "";
        if (insideCreateTable && isNewStatementStart(completion)) return "";
        if (!insideCreateTable && hasUnknownIdentifiers(completion, schema)) return "";
        return completion;
    }

    // For multi-line block suggestions:
    // Apply dedup only on the first line, then join with remaining lines
    const firstDedup = stripLeadingDuplication(relevantLines[0], textUntilCursor);
    let firstLine = firstDedup.text;
    if (firstDedup.stripped && firstDedup.needsSpace && firstLine) {
        firstLine = " " + firstLine;
    } else if (!firstDedup.stripped) {
        const tailToken = textUntilCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
        if (shouldJoinTailToken(tailToken, firstLine, schema, insideCreateTable)) {
            firstLine = firstLine.replace(/^\s+/, "");
        } else {
            firstLine = ensureProperSpacing(firstLine, textUntilCursor);
        }
    }
    firstLine = firstLine
        .replace(/^(insert|select|update|delete|create)\s+\1\b/i, "$1")
        .replace(/\b(create\s+index)\s+\1\b/i, "$1");
    if (rejectionKeys.has(normalizeLineKey(firstLine))) return "";
    if (!allowStatementStart && isNewStatementStart(firstLine)) return "";
    if (insideCreateTable && isNewStatementStart(firstLine)) return "";

    const block = [firstLine, ...relevantLines.slice(1)].join("\n");
    if (!insideCreateTable && hasUnknownIdentifiers(block, schema)) return "";

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

async function postJson(
    url: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
): Promise<unknown | null> {
    if (isTauriRuntime()) {
        try {
            const text = await aiSuggestionsWorkerPost(url, payload);
            try {
                return JSON.parse(text) as unknown;
            } catch {
                return null;
            }
        } catch (error) {
            notifyNoInternetDetected(error);
            return null;
        }
    }

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            return null;
        }
        notifyNoInternetDetected(error);
        throw error;
    }

    if (!res.ok) {
        let detail = "";
        try {
            detail = await res.text();
        } catch {
            detail = "";
        }
        throw new Error(`AI provider error ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    try {
        return (await res.json()) as unknown;
    } catch {
        return null;
    }
}

async function callProvider(
    provider: AiProvider,
    messages: { role: string; content: string }[],
    opts: {
        temperature?: number;
        max_tokens?: number;
        signal?: AbortSignal;
        sessionId: string;
        mode?: "predict" | "chat";
        stream?: boolean;
        streamOptions?: StreamOptions;
    }
): Promise<CallResult> {
    const canStream = !!opts.stream && !isTauriRuntime();
    const payload = {
        conversationId: opts.sessionId,
        messages,
        model: provider.model,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.max_tokens ?? 256,
        stream: canStream,
        skipCache: true,
        mode: opts.mode ?? "chat",
    };

    if (canStream) {
        let res: Response;
        try {
            res = await fetch(provider.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: opts.signal,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return { text: "", usedStream: true };
            }
            notifyNoInternetDetected(error);
            throw error;
        }

        if (!res.ok) {
            let detail = "";
            try {
                detail = await res.text();
            } catch {
                detail = "";
            }
            throw new Error(`AI provider error ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
            try {
                const data = (await res.json()) as unknown;
                return { text: extractWorkerResponseText(data), usedStream: true };
            } catch {
                return { text: "", usedStream: true };
            }
        }

        const reader = res.body?.getReader();
        if (!reader) return { text: "", usedStream: true };

        const decoder = new TextDecoder();
        let buffer = "";
        let output = "";
        let done = false;

        while (!done) {
            if (opts.signal?.aborted) break;
            const { value, done: doneReading } = await reader.read();
            if (value) {
                buffer += decoder.decode(value, { stream: !doneReading });
                let idx = buffer.indexOf("\n");
                while (idx >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line) {
                        if (line.startsWith("data:")) {
                            const data = line.slice(5).trim();
                            if (data === "[DONE]") {
                                done = true;
                                break;
                            }
                            let chunk = "";
                            try {
                                chunk = extractStreamChunkText(JSON.parse(data) as unknown);
                            } catch {
                                chunk = extractStreamChunkText(data);
                            }
                            if (chunk) {
                                output += chunk;
                                if (shouldStopStream(output, opts.streamOptions)) {
                                    done = true;
                                    break;
                                }
                            }
                        } else {
                            let chunk = "";
                            try {
                                chunk = extractStreamChunkText(JSON.parse(line) as unknown);
                            } catch {
                                chunk = extractStreamChunkText(line);
                            }
                            if (chunk) {
                                output += chunk;
                                if (shouldStopStream(output, opts.streamOptions)) {
                                    done = true;
                                    break;
                                }
                            }
                        }
                    }
                    idx = buffer.indexOf("\n");
                }
            }
            if (doneReading) break;
        }

        if (buffer.trim()) {
            try {
                output += extractStreamChunkText(JSON.parse(buffer.trim()) as unknown);
            } catch {
                output += extractStreamChunkText(buffer.trim());
            }
        }

        return { text: output, usedStream: true };
    }

    const data = await postJson(provider.url, payload, opts.signal);
    if (!data) return { text: "", usedStream: false };
    return { text: extractWorkerResponseText(data), usedStream: false };
}

async function callCompletionProvider(
    provider: CompletionProvider,
    payload: {
        sql: string;
        schema?: Record<string, string[]>;
        skipCache?: boolean;
    },
    signal?: AbortSignal
): Promise<CompletionCallResult> {
    if (!provider.url) return { completion: "", cached: false };
    if (!canCallCompletionProvider(provider.url)) return { completion: "", cached: false };
    markCompletionProviderCall(provider.url);

    if (isTauriRuntime()) {
        try {
            const text = await aiSuggestionsWorkerPost(provider.url, payload);
            let data: unknown = null;
            try {
                data = JSON.parse(text) as unknown;
            } catch {
                data = text;
            }
            const result = extractCompletionResponse(data);
            if (result.error) {
                markCompletionProviderFailure(provider.url);
                throw new Error(`AI provider error: ${result.error}`);
            }
            markCompletionProviderSuccess(provider.url);
            return result;
        } catch (error) {
            notifyNoInternetDetected(error);
            markCompletionProviderFailure(provider.url);
            throw error;
        }
    }

    let res: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    if (signal) {
        signal.addEventListener(
            "abort",
            () => controller.abort(),
            { once: true }
        );
    }
    try {
        res = await fetch(provider.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof DOMException && error.name === "AbortError") {
            return { completion: "", cached: false };
        }
        notifyNoInternetDetected(error);
        markCompletionProviderFailure(provider.url);
        throw error;
    }

    clearTimeout(timeoutId);
    if (!res.ok) {
        let detail = "";
        try {
            detail = await res.text();
        } catch {
            detail = "";
        }
        markCompletionProviderFailure(provider.url);
        const hint = res.status === 404
            ? " (check Completion API URL in Settings)"
            : "";
        throw new Error(`AI provider error ${res.status}${hint}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    let data: unknown = null;
    try {
        data = (await res.json()) as unknown;
    } catch {
        data = null;
    }
    if (!data) return { completion: "", cached: false };
    const result = extractCompletionResponse(data);
    if (result.error) {
        markCompletionProviderFailure(provider.url);
        throw new Error(`AI provider error: ${result.error}`);
    }
    markCompletionProviderSuccess(provider.url);
    return result;
}

async function callCompletionWithFallback(
    providers: CompletionProvider[],
    payload: {
        sql: string;
        schema?: Record<string, string[]>;
        skipCache?: boolean;
    },
    signal?: AbortSignal
): Promise<CompletionCallResult> {
    let lastError: unknown = null;
    let hadSuccess = false;
    for (const provider of providers) {
        if (signal?.aborted) return { completion: "", cached: false };
        try {
            const result = await callCompletionProvider(provider, payload, signal);
            if (result.completion) return result;
            hadSuccess = true;
        } catch (error) {
            lastError = error;
        }
    }
    if (!hadSuccess && lastError) throw lastError;
    return { completion: "", cached: false };
}

async function callWithFallback(
    providers: AiProvider[],
    messages: { role: string; content: string }[],
    opts: {
        temperature?: number;
        max_tokens?: number;
        signal?: AbortSignal;
        sessionId: string;
        mode?: "predict" | "chat";
        stream?: boolean;
        streamOptions?: StreamOptions;
    }
): Promise<CallResult> {
    let lastError: unknown = null;
    let hadSuccess = false;
    for (const provider of providers) {
        if (opts.signal?.aborted) return { text: "", usedStream: false };
        try {
            const result = await callProvider(provider, messages, opts);
            if (result.text) return result;
            hadSuccess = true;
        } catch (error) {
            lastError = error;
        }
    }
    if (!hadSuccess && lastError) throw lastError;
    return { text: "", usedStream: false };
}

// ── System prompts ──────────────────────────────────────────────────────────

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

    private readonly dropdownInFlight: Map<string, Promise<AISuggestionBatch>> = new Map();
    private readonly inlineInFlight: Map<string, Promise<AIInlineCompletionResult>> = new Map();
    private inlineAbort: AbortController | null = null;

    constructor() {
        this.sessionId = crypto.randomUUID();
    }

    // ── Cache keys ──────────────────────────────────────────────────────

    private ck(sqlTail: string, tables: string[]): string {
        return `c::${sqlTail.slice(-420)}::${tables.slice(0, 12).join(",")}`;
    }

    private ik(prefixTail: string, suffixHead: string, tables: string[]): string {
        return `i::${prefixTail.slice(-420)}::${suffixHead.slice(0, 180)}::${tables.slice(0, 12).join(",")}`;
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
                const completionSql = buildCompletionSql(opts.fullSql, sqlTail, contextWindowChars);
                const response = await callCompletionWithFallback(
                    completionProviders(),
                    {
                        sql: completionSql,
                        schema: buildSchemaMap(schema),
                        skipCache: opts.skipCache ?? false,
                    },
                    opts.signal
                );

                const completionLine =
                    (response.completion ?? "")
                        .split("\n")
                        .find((line) => line.trim().length > 0) ?? "";
                const suggestions = sanitizeDropdownSuggestions(
                    completionLine,
                    textUntilCursor,
                    schema,
                    maxSuggestions
                );

                return {
                    suggestions,
                    telemetry: {
                        latencyMs: response.latencyMs ?? elapsedMs(start),
                        source: response.cached ? "cache" : "network",
                    },
                    error: isNonSqlResponse(response.completion ?? "")
                        ? "AI returned non-SQL response"
                        : undefined,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : "AI request failed";
                return {
                    suggestions: [],
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                    error: message,
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
        const preferSingleLine = opts.preferSingleLine ?? false;
        const insideCreateTable = isInsideCreateTableColumns(textUntilCursor);
        const allowMultiLine = allowMultiLineAfterTerminator(textUntilCursor);
        const hasCreateColumns = insideCreateTable
            ? extractCurrentCreateTableColumns(textUntilCursor).size > 0
            : false;
        const effectivePreferSingleLine =
            preferSingleLine && !(insideCreateTable && !hasCreateColumns) && !allowMultiLine;
        let prefixTail = trimSqlContext(textUntilCursor, contextWindowChars);
        let suffixHead = "";
        const schemaSql = opts.fullSql ? trimSqlContext(opts.fullSql, 20000) : "";
        const mergedSchema = opts.fullSql ? mergeSchema(schema, extractSchemaFromSql(schemaSql)) : schema;

        if (opts.fullSql && typeof opts.cursorOffset === "number") {
            const built = buildInlineContext(opts.fullSql, opts.cursorOffset, contextWindowChars);
            prefixTail = trimSqlContext(built.prefixTail, contextWindowChars);
            suffixHead = built.suffixHead;
        }

        if (prefixTail.trim().length < 2) {
            return {
                completion: "",
                telemetry: { latencyMs: 1, source: "network" },
            };
        }

        const key = this.ik(prefixTail, suffixHead, mergedSchema.tables);

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
                const completionSql = buildCompletionSql(opts.fullSql, textUntilCursor, contextWindowChars);
                const response = await callCompletionWithFallback(
                    completionProviders(),
                    {
                        sql: completionSql,
                        schema: buildSchemaMap(mergedSchema),
                        skipCache: opts.skipCache ?? false,
                    },
                    effectiveSignal
                );

                let completion = sanitizeInlineCompletion(
                    response.completion ?? "",
                    textUntilCursor,
                    mergedSchema,
                    opts.fullSql,
                    effectivePreferSingleLine,
                    opts.recentRejections
                );
                if (!completion) {
                    completion = buildInlineFallback(textUntilCursor, mergedSchema);
                }

                return {
                    completion,
                    telemetry: {
                        latencyMs: response.latencyMs ?? elapsedMs(start),
                        source: response.cached ? "cache" : "network",
                    },
                    error: isNonSqlResponse(response.completion ?? "")
                        ? "AI returned non-SQL response"
                        : undefined,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : "AI request failed";
                return {
                    completion: "",
                    telemetry: { latencyMs: elapsedMs(start), source: "network" },
                    error: message,
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
        if (!hasExplicitWorkerUrl()) return [];

        const sqlTail = trimSqlContext(sql.trim(), 800);

        try {
            const { text: raw } = await callWithFallback(
                suggestionProviders(),
                [
                    { role: "system", content: nextActionPrompt(schema, APP_NAME) },
                    { role: "user", content: `Query:\n\n${sqlTail}` },
                ],
                { temperature: 0.4, max_tokens: 180, sessionId: this.sessionId, mode: "chat" }
            );

            const suggestions = raw
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 5 && !s.startsWith("```") && !s.startsWith("--"))
                .slice(0, 3);

            return suggestions;
        } catch {
            return [];
        }
    }

    // ── Natural language → SQL ──────────────────────────────────────────

    async getNaturalLanguageSQL(query: string, schema: SchemaContext): Promise<string> {
        if (!hasExplicitWorkerUrl()) {
            throw new Error("AI worker URL not configured.");
        }
        const { text: raw } = await callWithFallback(
            suggestionProviders(),
            [
                { role: "system", content: naturalLanguagePrompt(schema, APP_NAME) },
                { role: "user", content: query },
            ],
            { temperature: 0.2, max_tokens: 256, sessionId: this.sessionId, mode: "chat" }
        );

        if (!raw) throw new Error("AI request failed");
        return stripCodeFences(raw);
    }

    clearCache(): void {
        this.dropdownInFlight.clear();
        this.inlineInFlight.clear();
        this.inlineAbort?.abort();
    }
}

export const aiSuggestionEngine = new AISuggestionEngine();
