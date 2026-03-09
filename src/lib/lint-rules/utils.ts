import type {
    LintSeverity,
    SqlLintAst,
    SqlLintDiagnostic,
    SqlLintQuickFix,
    SqlLintStatement,
} from "@/lib/lint-rules/types";

interface StatementFragment {
    text: string;
    startOffset: number;
    endOffset: number;
}

interface QuickFixFromOffsets {
    id: string;
    label: string;
    startOffset: number;
    endOffset: number;
    replacement: string;
    isPreferred?: boolean;
}

interface DiagnosticFromOffsets {
    ruleId: string;
    severity: LintSeverity;
    message: string;
    startOffset: number;
    endOffset: number;
    source?: string;
    quickFixes?: QuickFixFromOffsets[];
}

export const SQL_RESERVED_WORDS = new Set([
    "select",
    "from",
    "where",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "full",
    "cross",
    "on",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "as",
    "with",
    "insert",
    "into",
    "values",
    "update",
    "set",
    "delete",
    "create",
    "alter",
    "drop",
    "truncate",
    "table",
    "distinct",
    "union",
    "all",
    "except",
    "intersect",
    "and",
    "or",
    "not",
    "null",
    "true",
    "false",
    "case",
    "when",
    "then",
    "else",
    "end",
]);

export function buildLineStarts(sql: string): number[] {
    const starts = [0];
    for (let i = 0; i < sql.length; i += 1) {
        if (sql.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

export function lineColumnFromOffset(
    lineStarts: number[],
    sqlLength: number,
    offset: number
): { lineNumber: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, sqlLength));
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const at = lineStarts[mid];
        if (at === clamped) {
            return { lineNumber: mid + 1, column: 1 };
        }
        if (at < clamped) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const lineIndex = Math.max(0, high);
    const lineStart = lineStarts[lineIndex] ?? 0;
    return {
        lineNumber: lineIndex + 1,
        column: clamped - lineStart + 1,
    };
}

export function offsetFromLineColumn(
    sql: string,
    lineStarts: number[],
    lineNumber: number,
    column: number
): number {
    if (lineStarts.length === 0) return 0;
    const safeLine = Math.max(1, Math.min(lineNumber, lineStarts.length));
    const lineStart = lineStarts[safeLine - 1] ?? 0;
    const nextLineStart = safeLine < lineStarts.length ? lineStarts[safeLine] : sql.length;
    const maxColumn = Math.max(1, nextLineStart - lineStart + 1);
    const safeColumn = Math.max(1, Math.min(column, maxColumn));
    return lineStart + safeColumn - 1;
}

export function normalizeIdentifier(raw: string): string {
    const withoutQuotes = raw.trim().replace(/"/g, "");
    const parts = withoutQuotes.split(".");
    return (parts[parts.length - 1] ?? withoutQuotes).toLowerCase();
}

export function splitStatementsWithOffsets(sql: string): StatementFragment[] {
    const statements: StatementFragment[] = [];
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
            statements.push({
                text: fragment,
                startOffset: start,
                endOffset: endExclusive,
            });
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

export function firstKeyword(statement: string): string {
    const cleaned = statement.trim().replace(/^;+/, "").trim();
    if (!cleaned) return "UNKNOWN";

    const first = cleaned.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "UNKNOWN";
    if (first !== "WITH") return first;

    const cteResolved = cleaned.match(
        /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE)\b/i
    )?.[1];

    return cteResolved ? cteResolved.toUpperCase() : "WITH";
}

export function maskSqlLiteralsAndComments(sql: string): string {
    const chars = [...sql];
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag: string | null = null;

    const setSpace = (index: number) => {
        if (chars[index] !== "\n") chars[index] = " ";
    };

    while (i < chars.length) {
        const ch = chars[i];
        const next = i + 1 < chars.length ? chars[i + 1] : "";

        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
            } else {
                setSpace(i);
            }
            i += 1;
            continue;
        }

        if (inBlockComment) {
            setSpace(i);
            if (ch === "*" && next === "/") {
                setSpace(i + 1);
                inBlockComment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if (dollarTag) {
            const maybe = chars.slice(i, i + dollarTag.length).join("");
            if (maybe === dollarTag) {
                for (let j = 0; j < dollarTag.length; j += 1) setSpace(i + j);
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            setSpace(i);
            i += 1;
            continue;
        }

        if (inSingle) {
            setSpace(i);
            if (ch === "'" && next === "'") {
                setSpace(i + 1);
                i += 2;
                continue;
            }
            if (ch === "'") inSingle = false;
            i += 1;
            continue;
        }

        if (inDouble) {
            setSpace(i);
            if (ch === '"' && next === '"') {
                setSpace(i + 1);
                i += 2;
                continue;
            }
            if (ch === '"') inDouble = false;
            i += 1;
            continue;
        }

        if (ch === "-" && next === "-") {
            setSpace(i);
            setSpace(i + 1);
            inLineComment = true;
            i += 2;
            continue;
        }

        if (ch === "/" && next === "*") {
            setSpace(i);
            setSpace(i + 1);
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === "'") {
            setSpace(i);
            inSingle = true;
            i += 1;
            continue;
        }

        if (ch === '"') {
            setSpace(i);
            inDouble = true;
            i += 1;
            continue;
        }

        if (ch === "$") {
            const rest = chars.slice(i).join("");
            const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match) {
                const tag = match[0];
                for (let j = 0; j < tag.length; j += 1) setSpace(i + j);
                dollarTag = tag;
                i += tag.length;
                continue;
            }
        }

        i += 1;
    }

    return chars.join("");
}

export function buildSqlLintAst(sql: string): SqlLintAst {
    const lineStarts = buildLineStarts(sql);
    const statements: SqlLintStatement[] = splitStatementsWithOffsets(sql).map((statement) => {
        const startPos = lineColumnFromOffset(lineStarts, sql.length, statement.startOffset);
        const endPos = lineColumnFromOffset(lineStarts, sql.length, statement.endOffset);
        return {
            text: statement.text,
            maskedText: maskSqlLiteralsAndComments(statement.text),
            keyword: firstKeyword(statement.text),
            startOffset: statement.startOffset,
            endOffset: statement.endOffset,
            startLineNumber: startPos.lineNumber,
            endLineNumber: endPos.lineNumber,
        };
    });

    return { sql, lineStarts, statements };
}

export function createDiagnosticFromOffsets(
    ast: SqlLintAst,
    input: DiagnosticFromOffsets
): SqlLintDiagnostic {
    const start = lineColumnFromOffset(ast.lineStarts, ast.sql.length, input.startOffset);
    const end = lineColumnFromOffset(ast.lineStarts, ast.sql.length, input.endOffset);

    const quickFixes: SqlLintQuickFix[] = (input.quickFixes ?? []).map((fix) => {
        const startPos = lineColumnFromOffset(ast.lineStarts, ast.sql.length, fix.startOffset);
        const endPos = lineColumnFromOffset(ast.lineStarts, ast.sql.length, fix.endOffset);
        return {
            id: fix.id,
            label: fix.label,
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
            replacement: fix.replacement,
            isPreferred: fix.isPreferred,
        };
    });

    return {
        id: `${input.ruleId}:${input.startOffset}:${input.endOffset}`,
        ruleId: input.ruleId,
        severity: input.severity,
        message: input.message,
        source: input.source ?? "TypeScript SQL Linter",
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
        quickFixes,
    };
}
