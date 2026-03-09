import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets } from "@/lib/lint-rules/utils";

export const deprecatedSyntaxRule: LintRule = {
    id: "deprecated_comma_join",
    severity: "warning",
    description: "Flags comma-separated FROM lists in favor of explicit JOIN syntax.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            if (statement.keyword !== "SELECT" && statement.keyword !== "WITH") continue;

            const fromMatch = statement.maskedText.match(
                /\bfrom\b([\s\S]*?)(?:\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|$)/i
            );
            if (!fromMatch) continue;
            const fromClause = fromMatch[1] ?? "";
            if (/\bjoin\b/i.test(fromClause)) continue;
            const commaIndex = fromClause.indexOf(",");
            if (commaIndex < 0) continue;

            const startOffset =
                statement.startOffset + (fromMatch.index ?? 0) + fromMatch[0].indexOf(fromClause) + commaIndex;
            diagnostics.push(
                createDiagnosticFromOffsets(ast, {
                    ruleId: "deprecated_comma_join",
                    severity: "warning",
                    message: "Comma join style is deprecated. Use explicit JOIN ... ON clauses.",
                    startOffset,
                    endOffset: startOffset + 1,
                })
            );
        }

        return diagnostics;
    },
};
