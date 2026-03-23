/**
 * Parse PostgreSQL / HelixDB formatted error strings into structured sections for the query UI.
 */

const LABELED_SPLIT = /\n\n(Detail|Hint|CONTEXT|QUERY|SQL state|Position):\s*/g;

export interface PgErrorLineCaret {
    lineNumber: string;
    lineContent: string;
    caret: string;
}

export interface ParsedPgError {
    /** e.g. "Statement 3" when the runner prefixes multi-statement failures */
    statementPrefix: string | null;
    notices: string[];
    /** Main error text (no ERROR: prefix) */
    primaryError: string;
    detail: string | null;
    hint: string | null;
    context: string | null;
    /** QUERY block from the server (internal query), if any */
    queryFromError: string | null;
    /** Position line e.g. "character 42" */
    position: string | null;
    sqlState: string | null;
    lineCaret: PgErrorLineCaret | null;
    /** Full input (normalized newlines), for copy / fallback */
    raw: string;
}

function normalizeNewlines(s: string): string {
    return s.replace(/\r\n/g, "\n").trimEnd();
}

/** Remove first LINE … ^ block from text and return it (PostgreSQL detail style). */
function extractLineCaretFromText(text: string): { cleaned: string; lineCaret: PgErrorLineCaret | null } {
    const re = /LINE\s+(\d+):\s*(.+?)\r?\n(\s*\^[^\n]*)/m;
    const m = text.match(re);
    if (!m || m.index === undefined) return { cleaned: text, lineCaret: null };
    const lineCaret: PgErrorLineCaret = {
        lineNumber: m[1],
        lineContent: m[2],
        caret: m[3].trimEnd(),
    };
    const cleaned = `${text.slice(0, m.index)}${text.slice(m.index + m[0].length)}`.replace(/\n{3,}/g, "\n\n").trim();
    return { cleaned, lineCaret };
}

function parseLabeledSections(body: string): {
    primary: string;
    detail: string | null;
    hint: string | null;
    context: string | null;
    query: string | null;
    sqlState: string | null;
    position: string | null;
} {
    const matches: { label: string; contentStart: number; sectionStart: number }[] = [];
    LABELED_SPLIT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LABELED_SPLIT.exec(body)) !== null) {
        matches.push({
            label: m[1],
            contentStart: m.index + m[0].length,
            sectionStart: m.index,
        });
    }
    const primary = (matches.length ? body.slice(0, matches[0].sectionStart) : body).trim();
    const out = {
        primary,
        detail: null as string | null,
        hint: null as string | null,
        context: null as string | null,
        query: null as string | null,
        sqlState: null as string | null,
        position: null as string | null,
    };
    for (let i = 0; i < matches.length; i++) {
        const end = i + 1 < matches.length ? matches[i + 1].sectionStart : body.length;
        const content = body.slice(matches[i].contentStart, end).trimEnd();
        switch (matches[i].label) {
            case "Detail":
                out.detail = content;
                break;
            case "Hint":
                out.hint = content;
                break;
            case "CONTEXT":
                out.context = content;
                break;
            case "QUERY":
                out.query = content;
                break;
            case "SQL state":
                out.sqlState = content.trim();
                break;
            case "Position":
                out.position = content.trim();
                break;
            default:
                break;
        }
    }
    return out;
}

export function parsePgErrorMessage(raw: string): ParsedPgError {
    const normalized = normalizeNewlines(raw);
    let work = normalized;

    let statementPrefix: string | null = null;
    const stmtMatch = work.match(/^Statement\s+(\d+):\s*/);
    if (stmtMatch) {
        statementPrefix = `Statement ${stmtMatch[1]}`;
        work = work.slice(stmtMatch[0].length);
    }

    const lines = work.split("\n");
    const notices: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*NOTICE:\s*/i.test(line)) {
            notices.push(line.replace(/^\s*NOTICE:\s*/i, "").trim() || line.trim());
            i += 1;
        } else {
            break;
        }
    }
    work = lines.slice(i).join("\n").trimStart();

    const labeled = parseLabeledSections(work);
    let primaryError = labeled.primary.replace(/^ERROR:\s*/i, "").trim();

    let detail = labeled.detail;
    let lineCaret: PgErrorLineCaret | null = null;

    if (detail) {
        const { cleaned, lineCaret: lc } = extractLineCaretFromText(detail);
        if (lc) {
            lineCaret = lc;
            detail = cleaned.trim() || null;
        }
    }
    if (!lineCaret) {
        const { cleaned, lineCaret: lc } = extractLineCaretFromText(primaryError);
        if (lc) {
            lineCaret = lc;
            primaryError = cleaned.trim() || primaryError;
        }
    }

    return {
        statementPrefix,
        notices,
        primaryError: primaryError || labeled.primary.trim(),
        detail,
        hint: labeled.hint,
        context: labeled.context,
        queryFromError: labeled.query,
        position: labeled.position,
        sqlState: labeled.sqlState,
        lineCaret,
        raw: normalized,
    };
}

// ── Safe SQL highlighting (escape first, then wrap tokens) ───────────────────

const SQL_KW = new Set([
    "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "ON", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS", "NULL", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN", "INDEX", "UNIQUE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CASCADE", "CONSTRAINT", "RETURNING", "WITH", "RECURSIVE", "UNION", "ALL", "EXCEPT", "INTERSECT", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "ASC", "DESC", "TRUE", "FALSE", "DEFAULT", "CHECK", "USING", "EXPLAIN", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE", "COALESCE", "NULLIF", "CAST", "OVER", "PARTITION", "DO", "LANGUAGE",
]);
const SQL_TY = new Set([
    "INTEGER", "INT", "BIGINT", "SMALLINT", "SERIAL", "BIGSERIAL", "TEXT", "VARCHAR", "CHAR", "CHARACTER", "BOOLEAN", "BOOL", "TIMESTAMP", "TIMESTAMPTZ", "DATE", "TIME", "INTERVAL", "NUMERIC", "DECIMAL", "FLOAT", "REAL", "DOUBLE", "PRECISION", "UUID", "BYTEA", "INET", "CIDR", "MACADDR", "MONEY", "VARYING",
]);

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function highlightSqlChunk(chunk: string): string {
    return chunk
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="sql-num">$1</span>')
        .replace(/--[^\n]*/g, (comment) => `<span class="sql-comment">${comment}</span>`)
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (token) => {
            const upper = token.toUpperCase();
            if (SQL_KW.has(upper)) return `<span class="sql-kw">${token}</span>`;
            if (SQL_TY.has(upper)) return `<span class="sql-type">${token}</span>`;
            return token;
        });
}

/**
 * Returns HTML safe for dangerouslySetInnerHTML: content is escaped; keywords/numbers/comments skip string literals.
 */
export function highlightSqlForDisplay(sql: string): string {
    const e = escapeHtml(sql);
    const parts = e.split(/('(?:[^'\\]|\\.)*')/g);
    return parts
        .map((part) => {
            if (part.startsWith("'") && part.endsWith("'") && part.length >= 2) {
                return `<span class="sql-str">${part}</span>`;
            }
            return highlightSqlChunk(part);
        })
        .join("");
}
