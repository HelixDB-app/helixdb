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
