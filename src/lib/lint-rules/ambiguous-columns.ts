import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import {
    SQL_RESERVED_WORDS,
    createDiagnosticFromOffsets,
    normalizeIdentifier,
} from "@/lib/lint-rules/utils";

const TABLE_ALIAS_RE =
    /\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*))?/gi;
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

function lookupColumns(columnsMap: Record<string, string[]>, tableName: string): string[] {
    const normalized = normalizeIdentifier(tableName);
    if (Array.isArray(columnsMap[normalized])) {
        return columnsMap[normalized].map((column) => column.toLowerCase());
    }
    for (const [key, columns] of Object.entries(columnsMap)) {
        if (normalizeIdentifier(key) === normalized) {
            return columns.map((column) => column.toLowerCase());
        }
    }
    return [];
}

export const ambiguousColumnsRule: LintRule = {
    id: "ambiguous_column_reference",
    severity: "warning",
    description: "Detects unqualified columns that exist in multiple joined tables.",
    check: (ast, context): SqlLintDiagnostic[] => {
        const schemaContext = context.schemaContext;
        if (!schemaContext) return [];

        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            if (statement.keyword !== "SELECT" && statement.keyword !== "WITH") continue;
            const projectionMatch = statement.maskedText.match(/\bselect\b([\s\S]*?)\bfrom\b/i);
            if (!projectionMatch) continue;

            const aliases: Array<{ alias: string; table: string }> = [];
            TABLE_ALIAS_RE.lastIndex = 0;
            let tableMatch = TABLE_ALIAS_RE.exec(statement.maskedText);
            while (tableMatch) {
                const table = normalizeIdentifier(tableMatch[1] ?? "");
                const alias = (tableMatch[2] ?? table).toLowerCase();
                if (table && alias && !aliases.some((entry) => entry.alias === alias)) {
                    aliases.push({ alias, table });
                }
                tableMatch = TABLE_ALIAS_RE.exec(statement.maskedText);
            }
            if (aliases.length < 2) continue;

            const columnAliases = new Map<string, string[]>();
            for (const entry of aliases) {
                const cols = lookupColumns(schemaContext.columns, entry.table);
                for (const col of cols) {
                    const list = columnAliases.get(col) ?? [];
                    if (!list.includes(entry.alias)) list.push(entry.alias);
                    columnAliases.set(col, list);
                }
            }

            const ambiguousColumns = new Map<string, string[]>();
            for (const [column, refAliases] of columnAliases.entries()) {
                if (refAliases.length > 1) {
                    ambiguousColumns.set(column, refAliases);
                }
            }
            if (ambiguousColumns.size === 0) continue;

            const projection = projectionMatch[1] ?? "";
            const projectionStart =
                statement.startOffset +
                (projectionMatch.index ?? 0) +
                projectionMatch[0].indexOf(projection);
            const projectionChars = projection.split("");

            IDENTIFIER_RE.lastIndex = 0;
            let identifierMatch = IDENTIFIER_RE.exec(projection);
            let emitted = 0;
            while (identifierMatch && emitted < 8) {
                const token = identifierMatch[0];
                const tokenLower = token.toLowerCase();
                const tokenStart = identifierMatch.index;
                const tokenEnd = tokenStart + token.length;
                const prev = tokenStart > 0 ? projectionChars[tokenStart - 1] : "";
                const next = tokenEnd < projectionChars.length ? projectionChars[tokenEnd] : "";

                if (
                    ambiguousColumns.has(tokenLower) &&
                    !SQL_RESERVED_WORDS.has(tokenLower) &&
                    !aliases.some((entry) => entry.alias === tokenLower) &&
                    prev !== "." &&
                    next !== "." &&
                    next !== "("
                ) {
                    const absoluteStart = projectionStart + tokenStart;
                    const absoluteEnd = projectionStart + tokenEnd;
                    const preferredAlias = ambiguousColumns.get(tokenLower)?.[0] ?? aliases[0]?.alias ?? "t";
                    diagnostics.push(
                        createDiagnosticFromOffsets(ast, {
                            ruleId: "ambiguous_column_reference",
                            severity: "warning",
                            message: "Column may be ambiguous across joined tables. Qualify with an alias.",
                            startOffset: absoluteStart,
                            endOffset: absoluteEnd,
                            quickFixes: [
                                {
                                    id: "qualify-column",
                                    label: "Qualify with table alias",
                                    startOffset: absoluteStart,
                                    endOffset: absoluteEnd,
                                    replacement: `${preferredAlias}.${tokenLower}`,
                                    isPreferred: true,
                                },
                            ],
                        })
                    );
                    emitted += 1;
                }

                identifierMatch = IDENTIFIER_RE.exec(projection);
            }
        }

        return diagnostics;
    },
};
