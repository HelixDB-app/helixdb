import type { SchemaContext } from "@/lib/ai-suggestions";

export type LintSeverity = "error" | "warning" | "info";

export interface SqlLintQuickFix {
    id: string;
    label: string;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    replacement: string;
    isPreferred?: boolean;
}

export interface SqlLintDiagnostic {
    id: string;
    ruleId: string;
    severity: LintSeverity;
    message: string;
    source: string;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    quickFixes: SqlLintQuickFix[];
}

export interface SqlLintStatement {
    text: string;
    maskedText: string;
    keyword: string;
    startOffset: number;
    endOffset: number;
    startLineNumber: number;
    endLineNumber: number;
}

export interface SqlLintAst {
    sql: string;
    lineStarts: number[];
    statements: SqlLintStatement[];
}

export interface LintRuleContext {
    sql: string;
    schemaContext?: SchemaContext;
}

export interface LintRule {
    id: string;
    severity: LintSeverity;
    description?: string;
    check: (ast: SqlLintAst, context: LintRuleContext) => SqlLintDiagnostic[];
}
