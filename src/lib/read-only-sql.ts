/** Mirrors `strip_leading_comments_and_whitespace` in `src-tauri/src/db/queries.rs`. */
export function stripLeadingCommentsAndWhitespace(sql: string): string {
    let s = sql;
    for (;;) {
        s = s.trimStart();
        if (s.length === 0) return s;
        if (s.startsWith("--")) {
            const nl = s.indexOf("\n");
            if (nl === -1) return "";
            s = s.slice(nl + 1);
            continue;
        }
        if (s.startsWith("/*")) {
            const end = s.indexOf("*/");
            if (end === -1) return "";
            s = s.slice(end + 2);
            continue;
        }
        return s;
    }
}

function statementIsReadOnly(stmt: string): boolean {
    const head = stripLeadingCommentsAndWhitespace(stmt.trim());
    if (!head) return false;
    const upper = head.toUpperCase();
    return (
        upper.startsWith("SELECT") ||
        upper.startsWith("WITH") ||
        upper.startsWith("TABLE") ||
        upper.startsWith("VALUES") ||
        upper.startsWith("SHOW") ||
        upper.startsWith("EXPLAIN")
    );
}

/** Port of `split_sql_statements` — splits on `;` outside comments and quoted strings. */
export function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = "";
    const chars = [...sql];
    const n = chars.length;
    let i = 0;

    while (i < n) {
        const c = chars[i]!;

        if (c === "-" && i + 1 < n && chars[i + 1] === "-") {
            current += c;
            current += chars[i + 1]!;
            i += 2;
            while (i < n && chars[i] !== "\n") {
                current += chars[i]!;
                i += 1;
            }
            if (i < n) {
                current += chars[i]!;
                i += 1;
            }
            continue;
        }

        if (c === "/" && i + 1 < n && chars[i + 1] === "*") {
            current += c;
            current += chars[i + 1]!;
            i += 2;
            while (i + 1 < n && !(chars[i] === "*" && chars[i + 1] === "/")) {
                current += chars[i]!;
                i += 1;
            }
            if (i + 1 < n) {
                current += chars[i]!;
                current += chars[i + 1]!;
                i += 2;
            }
            continue;
        }

        if (c === "'") {
            current += c;
            i += 1;
            while (i < n) {
                const q = chars[i]!;
                if (q === "'" && i + 1 < n && chars[i + 1] === "'") {
                    current += q;
                    current += chars[i + 1]!;
                    i += 2;
                    continue;
                }
                if (q === "'") {
                    current += q;
                    i += 1;
                    break;
                }
                current += q;
                i += 1;
            }
            continue;
        }

        if (c === '"') {
            current += c;
            i += 1;
            while (i < n && chars[i] !== '"') {
                if (chars[i] === "\\" && i + 1 < n) {
                    current += chars[i]!;
                    current += chars[i + 1]!;
                    i += 2;
                    continue;
                }
                current += chars[i]!;
                i += 1;
            }
            if (i < n) {
                current += chars[i]!;
                i += 1;
            }
            continue;
        }

        if (c === "$" && i + 1 < n) {
            i += 1;
            let tag = "";
            while (i < n && chars[i] !== "$") {
                tag += chars[i]!;
                i += 1;
            }
            if (i < n) {
                i += 1;
                const delim = `$${tag}$`;
                current += delim;
                for (;;) {
                    if (i + delim.length <= n) {
                        const peek = chars.slice(i, i + delim.length).join("");
                        if (peek === delim) {
                            current += peek;
                            i += delim.length;
                            break;
                        }
                    }
                    if (i >= n) break;
                    current += chars[i]!;
                    i += 1;
                }
            } else {
                current += c;
            }
            continue;
        }

        if (c === ";") {
            const stmt = current.trim();
            if (stmt.length > 0) statements.push(stmt);
            current = "";
            i += 1;
            continue;
        }

        current += c;
        i += 1;
    }

    const last = current.trim();
    if (last.length > 0) statements.push(last);
    return statements;
}

export function validateReadOnlySql(sql: string): { ok: true } | { ok: false; message: string } {
    const trimmed = sql.trim();
    if (!trimmed) {
        return { ok: false, message: "Enter a SQL query." };
    }
    const statements = splitSqlStatements(trimmed);
    const nonEmpty = statements.map((s) => s.trim()).filter((s) => s.length > 0);
    if (nonEmpty.length === 0) {
        return { ok: false, message: "Enter a SQL query." };
    }
    for (let i = 0; i < nonEmpty.length; i += 1) {
        if (!statementIsReadOnly(nonEmpty[i]!)) {
            return {
                ok: false,
                message:
                    "Only read-only statements are allowed (SELECT, WITH, TABLE, VALUES, SHOW, EXPLAIN).",
            };
        }
    }
    return { ok: true };
}
