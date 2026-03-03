import { AIError, callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";

export type ReviewSeverity = "block" | "warn" | "info";

export interface SqlReviewIssue {
    id: string;
    severity: ReviewSeverity;
    title: string;
    message: string;
    suggestion?: string;
    line?: number;
    source: "rule" | "gemini";
}

export interface SqlReviewIntent {
    primaryType: string;
    statementTypes: string[];
    hasSelect: boolean;
    hasDml: boolean;
    hasDestructive: boolean;
    autoReviewCandidate: boolean;
}

export interface SqlReviewContext {
    tableColumns?: Record<string, string[]>;
    tableRowCounts?: Record<string, number>;
    schemaSummary?: string;
}

export interface SqlReviewOptions {
    enableGemini?: boolean;
    geminiApiKey?: string;
    geminiModel?: GeminiModelId;
    complexLineThreshold?: number;
    signal?: AbortSignal;
}

export interface SqlReviewReport {
    sql: string;
    intent: SqlReviewIntent;
    lineCount: number;
    isComplex: boolean;
    issues: SqlReviewIssue[];
    localDurationMs: number;
    aiDurationMs: number | null;
    aiUsed: boolean;
    aiModel: GeminiModelId | null;
    aiError: string | null;
}

const DEFAULT_COMPLEX_LINE_THRESHOLD = 10;
const REVIEW_SYSTEM_PROMPT = `You are a PostgreSQL safety reviewer inside a SQL IDE.

Return ONLY JSON with this shape:
{
  "issues": [
    {
      "severity": "block|warn|info",
      "title": "short title",
      "message": "1-2 sentence risk description",
      "suggestion": "short concrete fix",
      "line": 1
    }
  ]
}

Rules:
- Add only additional risks not already covered by the local findings.
- Keep at most 5 issues.
- Use "block" only for high-risk destructive mistakes.
- No markdown, no prose outside JSON.`;

interface SqlStatement {
    text: string;
    startOffset: number;
}

function nowMs(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

function elapsedMs(start: number): number {
    return Math.max(1, Math.round(nowMs() - start));
}

function normalizeIdentifier(raw: string): string {
    const noQuotes = raw.replace(/"/g, "").trim();
    const withoutSchema = noQuotes.includes(".") ? noQuotes.split(".").pop() ?? noQuotes : noQuotes;
    return withoutSchema.toLowerCase();
}

function severityRank(severity: ReviewSeverity): number {
    if (severity === "block") return 0;
    if (severity === "warn") return 1;
    return 2;
}

function lineFromOffset(sql: string, offset: number): number {
    if (offset <= 0) return 1;
    let line = 1;
    for (let i = 0; i < offset && i < sql.length; i += 1) {
        if (sql.charCodeAt(i) === 10) line += 1;
    }
    return line;
}

function splitStatementsWithOffsets(sql: string): SqlStatement[] {
    const statements: SqlStatement[] = [];
    let start = 0;
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag: string | null = null;

    const pushStatement = (endExclusive: number) => {
        const fragment = sql.slice(start, endExclusive);
        if (fragment.trim().length > 0) {
            statements.push({ text: fragment, startOffset: start });
        }
        start = endExclusive;
    };

    while (i < sql.length) {
        const ch = sql[i];
        const next = i + 1 < sql.length ? sql[i + 1] : "";

        if (inLineComment) {
            if (ch === "\n") inLineComment = false;
            i += 1;
            continue;
        }

        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            i += 1;
            continue;
        }

        if (inSingle) {
            if (ch === "'" && next === "'") {
                i += 2;
                continue;
            }
            if (ch === "'") inSingle = false;
            i += 1;
            continue;
        }

        if (inDouble) {
            if (ch === '"' && next === '"') {
                i += 2;
                continue;
            }
            if (ch === '"') inDouble = false;
            i += 1;
            continue;
        }

        if (ch === "-" && next === "-") {
            inLineComment = true;
            i += 2;
            continue;
        }

        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === "'") {
            inSingle = true;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inDouble = true;
            i += 1;
            continue;
        }

        if (ch === "$") {
            const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match) {
                dollarTag = match[0];
                i += match[0].length;
                continue;
            }
        }

        if (ch === ";") {
            pushStatement(i + 1);
            i += 1;
            continue;
        }

        i += 1;
    }

    if (start < sql.length) {
        pushStatement(sql.length);
    }

    return statements;
}

function firstKeyword(statement: string): string {
    const cleaned = statement.trim().replace(/^;+/, "").trim();
    if (!cleaned) return "UNKNOWN";

    const first = cleaned.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "UNKNOWN";
    if (first !== "WITH") return first;

    const cteResolved = cleaned.match(
        /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE)\b/i
    )?.[1];
    return cteResolved ? cteResolved.toUpperCase() : "WITH";
}

function extractIntent(sql: string): SqlReviewIntent {
    const statements = splitStatementsWithOffsets(sql);
    const statementTypes = statements.map((s) => firstKeyword(s.text));
    const types = statementTypes.filter((t) => t !== "UNKNOWN");
    const primaryType = types[0] ?? "UNKNOWN";

    const hasSelect = types.includes("SELECT");
    const hasDml = types.some((t) => ["INSERT", "UPDATE", "DELETE"].includes(t));
    const hasDestructive = types.some((t) => ["UPDATE", "DELETE", "DROP", "TRUNCATE", "INSERT"].includes(t));
    const autoReviewCandidate = types.some((t) =>
        ["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE"].includes(t)
    );

    return {
        primaryType,
        statementTypes: types,
        hasSelect,
        hasDml,
        hasDestructive,
        autoReviewCandidate,
    };
}

function hasExplicitTransaction(sql: string): boolean {
    return /\b(BEGIN|START\s+TRANSACTION)\b/i.test(sql);
}

function extractWhereClause(statement: string): string {
    const whereMatch = statement.match(/\bWHERE\b([\s\S]*?)(\bGROUP\b|\bORDER\b|\bLIMIT\b|\bRETURNING\b|;|$)/i);
    return whereMatch?.[1] ?? "";
}

function extractReferencedTables(statement: string): string[] {
    const refs = new Set<string>();

    const patterns = [
        /\bFROM\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bJOIN\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bUPDATE\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bINTO\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bDELETE\s+FROM\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bTRUNCATE\s+(?:TABLE\s+)?((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
        /\bDROP\s+TABLE\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/ig,
    ];

    for (const re of patterns) {
        for (const m of statement.matchAll(re)) {
            if (m[1]) refs.add(normalizeIdentifier(m[1]));
        }
    }

    return Array.from(refs);
}

function extractColumnsFromWhere(whereClause: string): string[] {
    const cols = new Set<string>();
    const re =
        /\b([A-Za-z_][A-Za-z0-9_\.]*)\s*(=|!=|<>|>|<|>=|<=|LIKE|ILIKE|IN\s*\(|IS\s+NULL|IS\s+NOT\s+NULL)\b/gi;
    for (const m of whereClause.matchAll(re)) {
        const raw = m[1];
        if (!raw) continue;
        const normalized = raw.toLowerCase().split(".").pop() ?? raw.toLowerCase();
        cols.add(normalized);
    }
    return Array.from(cols);
}

function hasSoftDeleteColumns(tableNames: string[], tableColumns: Record<string, string[]>): boolean {
    return tableNames.some((table) =>
        (tableColumns[table] ?? []).some((c) => c.toLowerCase() === "deleted_at")
    );
}

function looksIdLike(column: string): boolean {
    const c = column.toLowerCase();
    return c === "id" || c.endsWith("_id") || c.endsWith("_uuid") || c === "uuid";
}

function dedupeIssues(issues: SqlReviewIssue[]): SqlReviewIssue[] {
    const seen = new Set<string>();
    const out: SqlReviewIssue[] = [];

    for (const issue of issues) {
        const key = [
            issue.id.toLowerCase(),
            issue.severity,
            (issue.title || "").toLowerCase(),
            (issue.message || "").toLowerCase(),
            String(issue.line ?? 0),
        ].join("::");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(issue);
    }

    out.sort((a, b) => {
        const sevCmp = severityRank(a.severity) - severityRank(b.severity);
        if (sevCmp !== 0) return sevCmp;
        return (a.line ?? 0) - (b.line ?? 0);
    });
    return out;
}

function buildLocalIssues(sql: string, context: SqlReviewContext): SqlReviewIssue[] {
    const issues: SqlReviewIssue[] = [];
    const statements = splitStatementsWithOffsets(sql);
    const fullUpper = sql.toUpperCase();
    const hasTx = hasExplicitTransaction(sql);
    const hasDropProof =
        /\bSELECT\s+COUNT\s*\(\s*\*\s*\)/i.test(sql) ||
        /--.*\b(backup|intent|approved|safe)\b/i.test(sql) ||
        /\/\*[\s\S]*\b(backup|intent|approved|safe)\b[\s\S]*\*\//i.test(sql);

    const tableColumns: Record<string, string[]> = {};
    for (const [name, cols] of Object.entries(context.tableColumns ?? {})) {
        tableColumns[name.toLowerCase()] = cols.map((c) => c.toLowerCase());
    }

    for (const stmt of statements) {
        const type = firstKeyword(stmt.text);
        const stmtUpper = stmt.text.toUpperCase();
        const stmtLine = lineFromOffset(sql, stmt.startOffset);
        const whereClause = extractWhereClause(stmt.text);
        const referencedTables = extractReferencedTables(stmt.text);

        if ((type === "UPDATE" || type === "DELETE") && !/\bWHERE\b/i.test(stmt.text)) {
            issues.push({
                id: "missing-where-on-dml",
                severity: "block",
                title: "Missing WHERE on DML",
                message: `${type} runs without WHERE and can affect every row.`,
                suggestion: "Add a restrictive WHERE clause and verify with SELECT COUNT(*) first.",
                line: stmtLine,
                source: "rule",
            });
        }

        if (type === "DROP" && /\bDROP\s+(TABLE|COLUMN)\b/i.test(stmt.text) && !hasDropProof) {
            issues.push({
                id: "drop-without-backup-check",
                severity: "block",
                title: "DROP without backup check",
                message: "DROP detected without an explicit backup/count verification signal.",
                suggestion: "Run SELECT COUNT(*) first or add an intent comment before DROP.",
                line: stmtLine,
                source: "rule",
            });
        }

        if (type === "TRUNCATE" && !hasTx) {
            issues.push({
                id: "truncate-without-transaction",
                severity: "block",
                title: "TRUNCATE without transaction",
                message: "TRUNCATE is not wrapped in an explicit transaction.",
                suggestion: "Wrap with BEGIN/ROLLBACK (or BEGIN/COMMIT after verification).",
                line: stmtLine,
                source: "rule",
            });
        }

        if (type === "UPDATE" && /\bFROM\b/i.test(stmt.text) && /\bWHERE\b/i.test(stmt.text)) {
            const targetAliasMatch = stmt.text.match(
                /^\s*UPDATE\s+(?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/i
            );
            const targetAlias = targetAliasMatch?.[1]?.toLowerCase() ?? null;

            const fromAliases = new Set<string>();
            for (const m of stmt.text.matchAll(
                /\b(?:FROM|JOIN)\s+(?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi
            )) {
                if (m[1]) fromAliases.add(m[1].toLowerCase());
            }

            const whereAliases = Array.from(
                new Set(Array.from(whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g)).map((m) => m[1].toLowerCase()))
            );

            if (
                targetAlias &&
                whereAliases.length > 0 &&
                !whereAliases.includes(targetAlias) &&
                whereAliases.some((a) => fromAliases.has(a))
            ) {
                issues.push({
                    id: "where-on-wrong-table-alias",
                    severity: "warn",
                    title: "WHERE likely uses the wrong table alias",
                    message: "WHERE references only joined aliases and not the UPDATE target alias.",
                    suggestion: "Verify alias references in WHERE and ensure the target table is constrained.",
                    line: stmtLine,
                    source: "rule",
                });
            }
        }

        if (
            /\b([A-Za-z_][A-Za-z0-9_\.]*(?:_at|timestamp|time|date)[A-Za-z0-9_]*)\s*(=|!=|<>|<|>|<=|>=)\s*(NOW\(\)|CURRENT_TIMESTAMP)\b/i.test(
                stmt.text
            ) &&
            !/\bAT\s+TIME\s+ZONE\b|\btimezone\s*\(/i.test(stmt.text)
        ) {
            issues.push({
                id: "date-comparison-without-timezone",
                severity: "warn",
                title: "Date comparison without timezone handling",
                message: "Timestamp comparison may vary by server/session timezone.",
                suggestion: "Use explicit timezone conversion (AT TIME ZONE) or timestamptz-normalized values.",
                line: stmtLine,
                source: "rule",
            });
        }

        for (const m of stmt.text.matchAll(/\b(?:LIKE|ILIKE)\s+'%[^']*'/gi)) {
            issues.push({
                id: "like-leading-wildcard",
                severity: "warn",
                title: "LIKE with leading wildcard",
                message: "Leading wildcard patterns force full scans on standard btree indexes.",
                suggestion: "Prefer anchored patterns, trigram index, or full-text search depending on use-case.",
                line: lineFromOffset(sql, stmt.startOffset + (m.index ?? 0)),
                source: "rule",
            });
        }

        for (const m of stmt.text.matchAll(/\b[A-Za-z_][A-Za-z0-9_\.]*\s*(=|!=|<>)\s*NULL\b/gi)) {
            issues.push({
                id: "null-comparison-with-equals",
                severity: "warn",
                title: "NULL compared with equals",
                message: "Comparing with = NULL or != NULL is always unknown in SQL.",
                suggestion: "Use IS NULL / IS NOT NULL.",
                line: lineFromOffset(sql, stmt.startOffset + (m.index ?? 0)),
                source: "rule",
            });
        }

        for (const m of stmt.text.matchAll(/\b((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?JOIN\b/gi)) {
            const joinType = (m[1] ?? "").toUpperCase();
            if (joinType.includes("CROSS")) continue;
            const joinStart = m.index ?? 0;
            const rest = stmt.text.slice(joinStart);
            const afterJoin = rest.slice(m[0].length);
            const endMatch = afterJoin.match(
                /\b((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|;)\b/i
            );
            const segment = endMatch
                ? afterJoin.slice(0, Math.max(0, endMatch.index ?? afterJoin.length))
                : afterJoin;
            if (!/\bON\b|\bUSING\b|\bNATURAL\b/i.test(segment)) {
                issues.push({
                    id: "accidental-cartesian-join",
                    severity: "warn",
                    title: "JOIN without ON/USING",
                    message: "This JOIN appears unconstrained and can produce a cartesian product.",
                    suggestion: "Add ON/USING join predicates for the intended key relationship.",
                    line: lineFromOffset(sql, stmt.startOffset + joinStart),
                    source: "rule",
                });
            }
        }

        for (const m of stmt.text.matchAll(/\b\d+\s*\/\s*\d+\b/g)) {
            issues.push({
                id: "integer-division",
                severity: "warn",
                title: "Potential integer division",
                message: "Integer division truncates fractional values in SQL arithmetic.",
                suggestion: "Cast one side to numeric, e.g. 10::numeric / 3.",
                line: lineFromOffset(sql, stmt.startOffset + (m.index ?? 0)),
                source: "rule",
            });
        }

        if (type === "SELECT") {
            const hasLimit = /\bLIMIT\s+\d+/i.test(stmt.text);
            if (!hasLimit) {
                const tableRowCounts = context.tableRowCounts ?? {};
                const estimated = referencedTables.reduce(
                    (sum, table) => sum + (tableRowCounts[table.toLowerCase()] ?? 0),
                    0
                );
                if (estimated >= 1_000_000) {
                    issues.push({
                        id: "row-count-estimate",
                        severity: "info",
                        title: "Large row count estimate",
                        message: `Estimated scan size is about ${estimated.toLocaleString()} rows.`,
                        suggestion: "Use LIMIT or tighter predicates if full scans are not intended.",
                        line: stmtLine,
                        source: "rule",
                    });
                }
            }
        }

        if (whereClause.trim().length > 0) {
            const tableRowCounts = context.tableRowCounts ?? {};
            const largestTable = referencedTables.reduce((max, table) => {
                const size = tableRowCounts[table.toLowerCase()] ?? 0;
                return size > max ? size : max;
            }, 0);

            if (largestTable >= 200_000) {
                const whereCols = extractColumnsFromWhere(whereClause);
                const likelyUnindexed = whereCols.filter(
                    (c) => !looksIdLike(c) && !["created_at", "updated_at", "deleted_at"].includes(c)
                );
                if (likelyUnindexed.length > 0) {
                    issues.push({
                        id: "missing-index-hint",
                        severity: "info",
                        title: "Potential missing index",
                        message: `WHERE filters on ${likelyUnindexed.slice(0, 3).join(", ")} on a large table.`,
                        suggestion: "Review indexes for these predicates with EXPLAIN ANALYZE.",
                        line: stmtLine,
                        source: "rule",
                    });
                }
            }
        }

        if (
            referencedTables.length > 0 &&
            hasSoftDeleteColumns(referencedTables, tableColumns) &&
            !/\bdeleted_at\s+IS\s+NULL\b/i.test(stmt.text)
        ) {
            issues.push({
                id: "soft-delete-not-filtered",
                severity: "info",
                title: "Soft delete filter missing",
                message: "Table appears to use deleted_at but query does not filter deleted rows.",
                suggestion: "Add deleted_at IS NULL when active rows are expected.",
                line: stmtLine,
                source: "rule",
            });
        }

        if (
            /\b[A-Za-z_][A-Za-z0-9_\.]*\s*(=|!=|<>|>|<|>=|<=)\s*'[-]?\d+(\.\d+)?'\b/i.test(stmt.text)
        ) {
            issues.push({
                id: "implicit-type-cast",
                severity: "info",
                title: "Implicit type cast",
                message: "Numeric comparison uses a quoted literal and may force implicit casts.",
                suggestion: "Use numeric literals without quotes or explicit casts.",
                line: stmtLine,
                source: "rule",
            });
        }

        if (type === "SELECT" && /\bORDER\s+BY\b/i.test(stmtUpper) && !/\bLIMIT\s+\d+/i.test(stmtUpper)) {
            issues.push({
                id: "order-by-without-limit",
                severity: "info",
                title: "ORDER BY without LIMIT",
                message: "Sorting full result sets can be expensive on large data.",
                suggestion: "Add LIMIT when only top rows are needed.",
                line: stmtLine,
                source: "rule",
            });
        }
    }

    if (
        /\bSELECT\b/i.test(fullUpper) &&
        /\bUPDATE\b/i.test(fullUpper) &&
        !hasExplicitTransaction(sql)
    ) {
        issues.push({
            id: "non-atomic-update-pattern",
            severity: "info",
            title: "Non-atomic SELECT then UPDATE pattern",
            message: "Detected SELECT + UPDATE sequence without an explicit transaction.",
            suggestion: "Wrap dependent reads/writes in BEGIN/COMMIT to avoid race conditions.",
            line: 1,
            source: "rule",
        });
    }

    return dedupeIssues(issues);
}

function shouldUseGemini(
    issues: SqlReviewIssue[],
    lineCount: number,
    statementCount: number,
    threshold: number
): boolean {
    const hasWarnOrBlock = issues.some((i) => i.severity === "warn" || i.severity === "block");
    if (hasWarnOrBlock) return true;
    return lineCount > threshold || statementCount > 1;
}

function extractJsonObject(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return trimmed.slice(start, end + 1);
}

function toGeminiIssues(raw: string): SqlReviewIssue[] {
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return [];

    try {
        const parsed = JSON.parse(jsonText) as {
            issues?: Array<{
                severity?: string;
                title?: string;
                message?: string;
                suggestion?: string;
                line?: number;
            }>;
        };

        if (!Array.isArray(parsed.issues)) return [];

        const out: SqlReviewIssue[] = [];
        parsed.issues.slice(0, 5).forEach((entry, idx) => {
                const sev = (entry.severity ?? "warn").toLowerCase();
                const severity: ReviewSeverity =
                    sev === "block" || sev === "warn" || sev === "info" ? sev : "warn";
                const title = (entry.title ?? "").trim();
                const message = (entry.message ?? "").trim();
                if (!title || !message) return;
                out.push({
                    id: `gemini-${idx + 1}`,
                    severity,
                    title,
                    message,
                    suggestion: entry.suggestion?.trim() || undefined,
                    line: typeof entry.line === "number" && entry.line > 0 ? Math.floor(entry.line) : undefined,
                    source: "gemini" as const,
                });
            });
        return out;
    } catch {
        return [];
    }
}

function buildGeminiPrompt(
    sql: string,
    localIssues: SqlReviewIssue[],
    context: SqlReviewContext
): string {
    const localBlock = localIssues.length
        ? localIssues
            .map((i) => `- [${i.severity}] ${i.title}: ${i.message}`)
            .join("\n")
        : "- (none)";

    const schemaSummary = (context.schemaSummary ?? "").trim();

    return [
        "SQL to review:",
        "```sql",
        sql.trim().slice(0, 12000),
        "```",
        "",
        "Local findings (already detected, do not duplicate):",
        localBlock,
        "",
        "Schema summary:",
        "```",
        schemaSummary ? schemaSummary.slice(0, 9000) : "(not provided)",
        "```",
        "",
        "Return additional risks only.",
    ].join("\n");
}

export function getSqlReviewIntent(sql: string): SqlReviewIntent {
    return extractIntent(sql);
}

export async function runSqlSafetyReview(
    sql: string,
    context: SqlReviewContext = {},
    options: SqlReviewOptions = {}
): Promise<SqlReviewReport> {
    const lineCount = sql.split(/\r?\n/).length;
    const threshold = options.complexLineThreshold ?? DEFAULT_COMPLEX_LINE_THRESHOLD;
    const statements = splitStatementsWithOffsets(sql);
    const intent = extractIntent(sql);

    const localStart = nowMs();
    const localIssues = buildLocalIssues(sql, context);
    const localDurationMs = elapsedMs(localStart);

    const geminiRequested = Boolean(options.enableGemini);
    const geminiConfigured = Boolean(options.geminiApiKey?.trim());
    const geminiNeeded = shouldUseGemini(localIssues, lineCount, statements.length, threshold);
    const useGemini =
        geminiRequested &&
        geminiConfigured &&
        geminiNeeded;

    let aiIssues: SqlReviewIssue[] = [];
    let aiDurationMs: number | null = null;
    let aiError: string | null =
        geminiRequested && !geminiConfigured && geminiNeeded
            ? "Gemini API key missing; local checks were used."
            : null;
    let aiModel: GeminiModelId | null = null;

    if (useGemini) {
        const start = nowMs();
        aiModel = options.geminiModel ?? "gemini-2.5-flash-lite";
        try {
            const response = await withGeminiLogging(
                () => callGeminiSync(
                    aiModel!,
                    options.geminiApiKey!.trim(),
                    [{ role: "user", parts: [{ text: buildGeminiPrompt(sql, localIssues, context) }] }],
                    REVIEW_SYSTEM_PROMPT,
                    options.signal,
                    { maxOutputTokens: 1400 }
                ),
                { model: aiModel!, featureType: "sql-review", endpoint: "generateContent" }
            );
            aiIssues = toGeminiIssues(response);
        } catch (error) {
            aiError =
                error instanceof AIError
                    ? error.userMessage
                    : error instanceof Error
                        ? error.message
                        : "Gemini review failed.";
        } finally {
            aiDurationMs = elapsedMs(start);
        }
    }

    const dedupedAi = aiIssues.filter((issue) => {
        const cmp = issue.title.toLowerCase();
        return !localIssues.some((local) => local.title.toLowerCase() === cmp);
    });

    const issues = dedupeIssues([...localIssues, ...dedupedAi]);
    const isComplex = lineCount > threshold || statements.length > 1;

    return {
        sql,
        intent,
        lineCount,
        isComplex,
        issues,
        localDurationMs,
        aiDurationMs,
        aiUsed: useGemini,
        aiModel,
        aiError,
    };
}
