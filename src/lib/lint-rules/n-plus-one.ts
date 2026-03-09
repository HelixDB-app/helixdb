import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets } from "@/lib/lint-rules/utils";

const CORRELATED_SUBQUERY_RE = /\(\s*select\b[\s\S]*?\bwhere\b[\s\S]*?\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/i;

export const nPlusOneRule: LintRule = {
    id: "n_plus_one_subquery",
    severity: "info",
    description: "Detects likely correlated subqueries that can become N+1 patterns.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            if (statement.keyword !== "SELECT" && statement.keyword !== "WITH") continue;
            const found = CORRELATED_SUBQUERY_RE.exec(statement.maskedText);
            if (!found || typeof found.index !== "number") continue;

            const selectOffsetInMatch = found[0].toLowerCase().indexOf("select");
            const selectOffset = found.index + Math.max(0, selectOffsetInMatch);
            const startOffset = statement.startOffset + selectOffset;

            diagnostics.push(
                createDiagnosticFromOffsets(ast, {
                    ruleId: "n_plus_one_subquery",
                    severity: "info",
                    message: "Potential N+1 query shape (correlated subquery in SELECT list).",
                    startOffset,
                    endOffset: startOffset + 6,
                })
            );
        }

        return diagnostics;
    },
};
