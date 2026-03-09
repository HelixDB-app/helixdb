import type { LintRule, SqlLintDiagnostic, SqlLintStatement } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets } from "@/lib/lint-rules/utils";

function findKeywordOffset(statement: SqlLintStatement, keyword: "DELETE" | "UPDATE"): number {
    const idx = statement.maskedText.toLowerCase().search(keyword === "DELETE" ? /\bdelete\b/i : /\bupdate\b/i);
    return idx >= 0 ? statement.startOffset + idx : statement.startOffset;
}

function whereInsertionOffset(statement: SqlLintStatement): number {
    const trimmed = statement.text.replace(/\s+$/g, "");
    if (trimmed.endsWith(";")) {
        return statement.startOffset + trimmed.length - 1;
    }
    return statement.startOffset + trimmed.length;
}

export const missingWhereRule: LintRule = {
    id: "missing_where",
    severity: "warning",
    description: "Flags destructive statements without WHERE filters.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            if (statement.keyword !== "DELETE" && statement.keyword !== "UPDATE") continue;
            if (/\bwhere\b/i.test(statement.maskedText)) continue;

            const keyword = statement.keyword as "DELETE" | "UPDATE";
            const startOffset = findKeywordOffset(statement, keyword);
            const endOffset = startOffset + keyword.length;
            const insertOffset = whereInsertionOffset(statement);

            diagnostics.push(
                createDiagnosticFromOffsets(ast, {
                    ruleId: keyword === "DELETE" ? "missing_where_delete" : "missing_where_update",
                    severity: keyword === "DELETE" ? "error" : "warning",
                    message:
                        keyword === "DELETE"
                            ? "DELETE has no WHERE clause and can remove all rows."
                            : "UPDATE has no WHERE clause and can update every row.",
                    startOffset,
                    endOffset,
                    quickFixes: [
                        {
                            id: "add-where-clause",
                            label: "Add WHERE placeholder",
                            startOffset: insertOffset,
                            endOffset: insertOffset,
                            replacement: " WHERE /* TODO: add filter */",
                            isPreferred: true,
                        },
                    ],
                })
            );
        }

        return diagnostics;
    },
};
