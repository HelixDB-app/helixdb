import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets } from "@/lib/lint-rules/utils";

const RIGHT_LITERAL_RE =
    /\b[A-Za-z_][A-Za-z0-9_$.]*\s*(?:=|<>|!=|<=|>=|<|>)\s*'(\d+(?:\.\d+)?)'/g;
const LEFT_LITERAL_RE =
    /'(\d+(?:\.\d+)?)'\s*(?:=|<>|!=|<=|>=|<|>)\s*[A-Za-z_][A-Za-z0-9_$.]*/g;

function addImplicitCastDiagnostics(
    astSql: string,
    maskedText: string,
    statementStart: number,
    astFactory: (startOffset: number, endOffset: number, replacement: string) => SqlLintDiagnostic
): SqlLintDiagnostic[] {
    const diagnostics: SqlLintDiagnostic[] = [];
    const quotedPattern = /'(\d+(?:\.\d+)?)'/;

    let rightMatch = RIGHT_LITERAL_RE.exec(maskedText);
    while (rightMatch) {
        const segment = rightMatch[0] ?? "";
        const quoted = quotedPattern.exec(segment);
        if (quoted && typeof quoted.index === "number") {
            const startOffset = statementStart + rightMatch.index + quoted.index;
            const endOffset = startOffset + quoted[0].length;
            if (!astSql.slice(endOffset).trimStart().startsWith("::")) {
                diagnostics.push(astFactory(startOffset, endOffset, quoted[1] ?? ""));
            }
        }
        rightMatch = RIGHT_LITERAL_RE.exec(maskedText);
    }

    let leftMatch = LEFT_LITERAL_RE.exec(maskedText);
    while (leftMatch) {
        const segment = leftMatch[0] ?? "";
        const quoted = quotedPattern.exec(segment);
        if (quoted && typeof quoted.index === "number") {
            const startOffset = statementStart + leftMatch.index + quoted.index;
            const endOffset = startOffset + quoted[0].length;
            if (!astSql.slice(endOffset).trimStart().startsWith("::")) {
                diagnostics.push(astFactory(startOffset, endOffset, quoted[1] ?? ""));
            }
        }
        leftMatch = LEFT_LITERAL_RE.exec(maskedText);
    }

    return diagnostics;
}

export const implicitCastRule: LintRule = {
    id: "implicit_cast",
    severity: "warning",
    description: "Detects quoted numeric literals that can force implicit casts.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            RIGHT_LITERAL_RE.lastIndex = 0;
            LEFT_LITERAL_RE.lastIndex = 0;

            diagnostics.push(
                ...addImplicitCastDiagnostics(
                    ast.sql,
                    statement.maskedText,
                    statement.startOffset,
                    (startOffset, endOffset, replacement) =>
                        createDiagnosticFromOffsets(ast, {
                            ruleId: "implicit_type_cast",
                            severity: "warning",
                            message: "Quoted numeric literal may trigger implicit cast and bypass indexes.",
                            startOffset,
                            endOffset,
                            quickFixes: [
                                {
                                    id: "convert-to-numeric-literal",
                                    label: "Convert to numeric literal",
                                    startOffset,
                                    endOffset,
                                    replacement,
                                    isPreferred: true,
                                },
                            ],
                        })
                )
            );
        }

        return diagnostics;
    },
};
