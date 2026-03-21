export type DbErrorContext = "update" | "insert" | "delete" | "query";

function normalizeMessage(raw: string): string {
    return raw
        .replace(/^(update|insert|delete|query) error:\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim();
}

function titleFor(context: DbErrorContext | undefined): string {
    switch (context) {
        case "insert":
            return "Insert failed";
        case "delete":
            return "Delete failed";
        case "query":
            return "Query failed";
        case "update":
        default:
            return "Update failed";
    }
}

export function formatDbError(err: unknown, context?: DbErrorContext): { title: string; description?: string } {
    const raw = String(err ?? "").trim();
    const msg = normalizeMessage(raw);

    if (/error serializing parameter/i.test(raw)) {
        return {
            title: titleFor(context),
            description: "Value could not be sent to the database. Check the column type and try a valid value.",
        };
    }

    const invalidTypeMatch = msg.match(/invalid input syntax for type \"?([^\"]+)\"?/i);
    if (invalidTypeMatch) {
        return {
            title: titleFor(context),
            description: `Value does not match type ${invalidTypeMatch[1]}.`,
        };
    }

    if (/violates unique constraint/i.test(msg)) {
        return {
            title: titleFor(context),
            description: "Value must be unique.",
        };
    }

    if (/violates not-null constraint/i.test(msg)) {
        return {
            title: titleFor(context),
            description: "A required field is missing.",
        };
    }

    if (/violates foreign key constraint/i.test(msg)) {
        return {
            title: titleFor(context),
            description: "Referenced row does not exist.",
        };
    }

    if (/permission denied/i.test(msg)) {
        return {
            title: titleFor(context),
            description: "You do not have permission to modify this table.",
        };
    }

    if (/duplicate key value/i.test(msg)) {
        return {
            title: titleFor(context),
            description: "Duplicate key value.",
        };
    }

    return {
        title: titleFor(context),
        description: msg || raw || "Unknown error.",
    };
}

/** User-friendly message for table load/count errors (e.g. "Count error: db error"). */
export function formatLoadDataError(raw: string): { summary: string; detail: string } {
    const msg = raw
        .replace(/^(count|load)\s+error:\s*/i, "")
        .replace(/^db error:?\s*/i, "")
        .trim();
    const isConnectionRelated =
        !msg ||
        msg === "db error" ||
        /connection|timeout|refused|ECONNREFUSED|ETIMEDOUT|network/i.test(raw);
    const summary = isConnectionRelated
        ? "The connection may have been lost or the database is temporarily unavailable."
        : msg || "Could not load table data.";
    return { summary, detail: raw };
}

/**
 * Transport / server / pool failures (retry often helps). Not SQL syntax, constraints, or missing objects.
 */
export function isDbInfrastructureError(raw: string): boolean {
    const s = String(raw ?? "").trim();
    if (!s) return true;

    const stripped = s
        .replace(/^(count|load|query|update|insert|delete)\s+error:\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim();
    const inner = stripped.replace(/^db error:?\s*/i, "").trim();

    if (!inner || inner === "db error") return true;

    if (
        /connection|timeout|refused|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|network|unreachable|socket|broken pipe|reset by peer|closed the connection|server closed|ssl|tls|handshake|certificate|pool|acquire|too many clients|admin shutdown|db unavailable|starting up|recovery/i.test(
            s
        )
    ) {
        return true;
    }

    // Wrapped generic backend error with no Postgres detail — usually connectivity.
    if (/^db error\b/i.test(stripped) && stripped.length < 120 && !/syntax|violat|constraint|permission|does not exist|undefined column|undefined table/i.test(s)) {
        return true;
    }

    return false;
}
