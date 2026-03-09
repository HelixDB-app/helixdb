import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets } from "@/lib/lint-rules/utils";

const STAR_RE = /(^|,)\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?\*/g;

export const selectStarRule: LintRule = {
    id: "select_star",
    severity: "warning",
    description: "Discourages wildcard projections in SELECT statements.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            if (statement.keyword !== "SELECT" && statement.keyword !== "WITH") continue;

            const projectionMatch = statement.maskedText.match(/\bselect\b([\s\S]*?)\bfrom\b/i);
            if (!projectionMatch) continue;
            const projection = projectionMatch[1] ?? "";
            const projectionOffset = projectionMatch.index ?? 0;
            const absoluteProjectionStart = statement.startOffset + projectionOffset + projectionMatch[0].indexOf(projection);

            STAR_RE.lastIndex = 0;
            let match = STAR_RE.exec(projection);
            while (match) {
                const starIndexInMatch = match[0].lastIndexOf("*");
                const startOffset = absoluteProjectionStart + match.index + starIndexInMatch;
                diagnostics.push(
                    createDiagnosticFromOffsets(ast, {
                        ruleId: "select_star",
                        severity: "warning",
                        message: "Avoid SELECT * in production queries; project explicit columns.",
                        startOffset,
                        endOffset: startOffset + 1,
                    })
                );
                match = STAR_RE.exec(projection);
            }
        }

        return diagnostics;
    },
};
