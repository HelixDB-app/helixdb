import type { LintRule, SqlLintDiagnostic } from "@/lib/lint-rules/types";
import { createDiagnosticFromOffsets, normalizeIdentifier } from "@/lib/lint-rules/utils";

const LEFT_JOIN_RE =
    /\bleft\s+(?:outer\s+)?join\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*))?\s+on\b/gi;

function countAliasUsages(statementLower: string, aliasLower: string): number {
    const needle = `${aliasLower}.`;
    let cursor = 0;
    let count = 0;
    while (cursor < statementLower.length) {
        const next = statementLower.indexOf(needle, cursor);
        if (next < 0) break;
        const prev = next > 0 ? statementLower[next - 1] : "";
        if (!/[A-Za-z0-9_]/.test(prev)) count += 1;
        cursor = next + needle.length;
    }
    return count;
}

export const unusedJoinsRule: LintRule = {
    id: "unused_join",
    severity: "info",
    description: "Highlights LEFT JOIN aliases that are not referenced after joining.",
    check: (ast): SqlLintDiagnostic[] => {
        const diagnostics: SqlLintDiagnostic[] = [];

        for (const statement of ast.statements) {
            const lower = statement.maskedText.toLowerCase();
            LEFT_JOIN_RE.lastIndex = 0;
            let match = LEFT_JOIN_RE.exec(lower);
            while (match) {
                const tableRef = match[1] ?? "";
                const alias = (match[2] ?? normalizeIdentifier(tableRef)).toLowerCase();
                if (alias && countAliasUsages(lower, alias) <= 1) {
                    const startOffset = statement.startOffset + match.index;
                    diagnostics.push(
                        createDiagnosticFromOffsets(ast, {
                            ruleId: "unused_join",
                            severity: "info",
                            message: "LEFT JOIN alias looks unused outside ON clause.",
                            startOffset,
                            endOffset: startOffset + 4,
                        })
                    );
                }
                match = LEFT_JOIN_RE.exec(lower);
            }
        }

        return diagnostics;
    },
};
