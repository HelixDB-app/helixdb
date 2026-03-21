import { format } from "sql-formatter";
import type { FormatOptionsWithLanguage } from "sql-formatter";

/** Monaco / toolbar: same combo as `format-sql` action in `monaco-sql-editor.tsx`. */
export const FORMAT_SQL_KEY_COMBO = "Shift+Alt+F";

/**
 * Collapsed, tabular-aligned PostgreSQL style: major clauses stay readable,
 * keywords align in one column, and expressions stay on one line when they fit.
 */
const helixPostgresFormat: FormatOptionsWithLanguage = {
    language: "postgresql",
    tabWidth: 2,
    useTabs: false,
    keywordCase: "upper",
    identifierCase: "preserve",
    dataTypeCase: "upper",
    functionCase: "upper",
    indentStyle: "tabularLeft",
    logicalOperatorNewline: "before",
    expressionWidth: 88,
    linesBetweenQueries: 1,
    denseOperators: true,
    newlineBeforeSemicolon: false,
};

export function formatHelixSql(sql: string): string {
    return format(sql, helixPostgresFormat);
}
