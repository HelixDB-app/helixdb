import type { editor, IDisposable } from "monaco-editor";
import type { SchemaContext } from "@/lib/ai-suggestions";
import { builtInRules } from "@/lib/lint-rules";
import type {
    LintRule,
    LintRuleContext,
    LintSeverity,
    SqlLintDiagnostic,
    SqlLintQuickFix,
} from "@/lib/lint-rules/types";
import {
    buildSqlLintAst,
    offsetFromLineColumn,
} from "@/lib/lint-rules/utils";
import { dbLintSql, type DbSqlLintDiagnostic } from "@/lib/tauri";

export type {
    LintRule,
    LintRuleContext,
    LintSeverity,
    SqlLintAst,
    SqlLintDiagnostic,
    SqlLintQuickFix,
    SqlLintStatement,
} from "@/lib/lint-rules/types";
export { builtInRules };

export interface CustomRuleDefinition {
    id: string;
    severity?: LintSeverity;
    description?: string;
    check: LintRule["check"];
}

export interface LintSqlOptions {
    rules?: LintRule[];
    customRules?: LintRule[];
    enableRustCore?: boolean;
    forceTypeScriptRules?: boolean;
    maxDiagnostics?: number;
}

export interface RegisterLintProviderOptions extends LintSqlOptions {
    markerOwner?: string;
    delayMs?: number;
    schemaContext?: SchemaContext;
    getSchemaContext?: () => SchemaContext | undefined;
    onDiagnostics?: (diagnostics: SqlLintDiagnostic[]) => void;
}

export interface DebouncedLintController extends IDisposable {
    trigger: () => void;
}

export interface RegisteredLintProvider extends DebouncedLintController {}

const DEFAULT_MARKER_OWNER = "sql-lint-live";
const DEFAULT_DELAY_MS = 220;
const QUICK_FIX_KIND = "quickfix.sqlLint";

const modelDiagnostics = new Map<string, SqlLintDiagnostic[]>();
let codeActionProviderDisposable: IDisposable | null = null;
let codeActionProviderRefCount = 0;

function isTauriRuntime(): boolean {
    if (typeof window === "undefined") return false;
    const w = window as Window & {
        __TAURI__?: unknown;
        __TAURI_INTERNALS__?: unknown;
    };
    return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

function severityRank(severity: LintSeverity): number {
    if (severity === "error") return 0;
    if (severity === "warning") return 1;
    return 2;
}

function markerSeverity(
    monaco: typeof import("monaco-editor"),
    severity: LintSeverity
): number {
    if (severity === "error") return monaco.MarkerSeverity.Error;
    if (severity === "warning") return monaco.MarkerSeverity.Warning;
    return monaco.MarkerSeverity.Info;
}

function normalizeRustDiagnostic(diagnostic: DbSqlLintDiagnostic): SqlLintDiagnostic {
    return {
        id: diagnostic.id,
        ruleId: diagnostic.ruleId,
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: diagnostic.source,
        startLineNumber: diagnostic.startLineNumber,
        startColumn: diagnostic.startColumn,
        endLineNumber: diagnostic.endLineNumber,
        endColumn: diagnostic.endColumn,
        quickFixes: (diagnostic.quickFixes ?? []).map((fix) => ({
            id: fix.id,
            label: fix.label,
            startLineNumber: fix.startLineNumber,
            startColumn: fix.startColumn,
            endLineNumber: fix.endLineNumber,
            endColumn: fix.endColumn,
            replacement: fix.replacement,
            isPreferred: fix.isPreferred,
        })),
    };
}

function dedupeDiagnostics(diagnostics: SqlLintDiagnostic[]): SqlLintDiagnostic[] {
    const seen = new Set<string>();
    const out: SqlLintDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
        const key = [
            diagnostic.ruleId,
            diagnostic.startLineNumber,
            diagnostic.startColumn,
            diagnostic.endLineNumber,
            diagnostic.endColumn,
            diagnostic.message,
        ].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(diagnostic);
    }
    return out;
}

function sortDiagnostics(diagnostics: SqlLintDiagnostic[]): SqlLintDiagnostic[] {
    return [...diagnostics].sort((a, b) => {
        return (
            severityRank(a.severity) - severityRank(b.severity) ||
            a.startLineNumber - b.startLineNumber ||
            a.startColumn - b.startColumn ||
            a.message.localeCompare(b.message)
        );
    });
}

function getSchemaContext(options: RegisterLintProviderOptions): SchemaContext | undefined {
    return options.getSchemaContext?.() ?? options.schemaContext;
}

function rangesOverlap(
    aStartLine: number,
    aStartColumn: number,
    aEndLine: number,
    aEndColumn: number,
    bStartLine: number,
    bStartColumn: number,
    bEndLine: number,
    bEndColumn: number
): boolean {
    const aStart = `${String(aStartLine).padStart(6, "0")}:${String(aStartColumn).padStart(6, "0")}`;
    const aEnd = `${String(aEndLine).padStart(6, "0")}:${String(aEndColumn).padStart(6, "0")}`;
    const bStart = `${String(bStartLine).padStart(6, "0")}:${String(bStartColumn).padStart(6, "0")}`;
    const bEnd = `${String(bEndLine).padStart(6, "0")}:${String(bEndColumn).padStart(6, "0")}`;
    return aStart <= bEnd && bStart <= aEnd;
}

function setModelMarkers(
    monaco: typeof import("monaco-editor"),
    model: editor.ITextModel,
    markerOwner: string,
    diagnostics: SqlLintDiagnostic[]
): void {
    const markers: editor.IMarkerData[] = diagnostics.map((diagnostic) => ({
        severity: markerSeverity(monaco, diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source || "SQL Lint",
        code: diagnostic.ruleId,
        startLineNumber: diagnostic.startLineNumber,
        startColumn: diagnostic.startColumn,
        endLineNumber: diagnostic.endLineNumber,
        endColumn: diagnostic.endColumn,
    }));
    monaco.editor.setModelMarkers(model, markerOwner, markers);
}

function ensureCodeActionProvider(monaco: typeof import("monaco-editor")): IDisposable {
    if (!codeActionProviderDisposable) {
        codeActionProviderDisposable = monaco.languages.registerCodeActionProvider("sql", {
            provideCodeActions: (model, range) => {
                const diagnostics = modelDiagnostics.get(model.uri.toString()) ?? [];
                if (diagnostics.length === 0) {
                    return { actions: [], dispose: () => {} };
                }

                const overlapping = diagnostics.filter((diagnostic) =>
                    rangesOverlap(
                        diagnostic.startLineNumber,
                        diagnostic.startColumn,
                        diagnostic.endLineNumber,
                        diagnostic.endColumn,
                        range.startLineNumber,
                        range.startColumn,
                        range.endLineNumber,
                        range.endColumn
                    )
                );
                if (overlapping.length === 0) {
                    return { actions: [], dispose: () => {} };
                }

                const actions: import("monaco-editor").languages.CodeAction[] = [];
                const safeFixes: Array<{ fix: SqlLintQuickFix; diagnostic: SqlLintDiagnostic }> = [];

                for (const diagnostic of overlapping) {
                    for (const fix of diagnostic.quickFixes ?? []) {
                        const fixRange = new monaco.Range(
                            fix.startLineNumber,
                            fix.startColumn,
                            fix.endLineNumber,
                            fix.endColumn
                        );
                        actions.push({
                            title: fix.label,
                            kind: QUICK_FIX_KIND,
                            isPreferred: Boolean(fix.isPreferred),
                            diagnostics: [],
                            edit: {
                                edits: [
                                    {
                                        resource: model.uri,
                                        versionId: model.getVersionId(),
                                        textEdit: {
                                            range: fixRange,
                                            text: fix.replacement,
                                        },
                                    },
                                ],
                            },
                        });
                        if (fix.isPreferred) {
                            safeFixes.push({ fix, diagnostic });
                        }
                    }
                }

                if (safeFixes.length > 1) {
                    const sortedFixes = [...safeFixes].sort((a, b) => {
                        const aStart = model.getOffsetAt(
                            new monaco.Position(a.fix.startLineNumber, a.fix.startColumn)
                        );
                        const bStart = model.getOffsetAt(
                            new monaco.Position(b.fix.startLineNumber, b.fix.startColumn)
                        );
                        return aStart - bStart;
                    });

                    const nonOverlapping: Array<{ fix: SqlLintQuickFix; diagnostic: SqlLintDiagnostic }> = [];
                    let lastEnd = -1;
                    for (const entry of sortedFixes) {
                        const currentStart = model.getOffsetAt(
                            new monaco.Position(entry.fix.startLineNumber, entry.fix.startColumn)
                        );
                        const currentEnd = model.getOffsetAt(
                            new monaco.Position(entry.fix.endLineNumber, entry.fix.endColumn)
                        );
                        if (currentStart >= lastEnd) {
                            nonOverlapping.push(entry);
                            lastEnd = currentEnd;
                        }
                    }

                    if (nonOverlapping.length > 1) {
                        actions.push({
                            title: "Apply all safe SQL lint fixes",
                            kind: QUICK_FIX_KIND,
                            isPreferred: false,
                            diagnostics: [],
                            edit: {
                                edits: nonOverlapping.map((entry) => ({
                                    resource: model.uri,
                                    versionId: model.getVersionId(),
                                    textEdit: {
                                        range: new monaco.Range(
                                            entry.fix.startLineNumber,
                                            entry.fix.startColumn,
                                            entry.fix.endLineNumber,
                                            entry.fix.endColumn
                                        ),
                                        text: entry.fix.replacement,
                                    },
                                })),
                            },
                        });
                    }
                }

                return {
                    actions,
                    dispose: () => {},
                };
            },
        });
    }

    codeActionProviderRefCount += 1;
    return {
        dispose: () => {
            codeActionProviderRefCount = Math.max(0, codeActionProviderRefCount - 1);
            if (codeActionProviderRefCount === 0 && codeActionProviderDisposable) {
                codeActionProviderDisposable.dispose();
                codeActionProviderDisposable = null;
            }
        },
    };
}

export function createCustomRule(definition: CustomRuleDefinition): LintRule {
    const id = definition.id.trim();
    if (!id) {
        throw new Error("Custom lint rule requires a non-empty id.");
    }

    return {
        id,
        severity: definition.severity ?? "warning",
        description: definition.description,
        check: definition.check,
    };
}

export function quickFix(diagnostic: SqlLintDiagnostic): SqlLintQuickFix[] {
    return [...(diagnostic.quickFixes ?? [])];
}

export function applyLintQuickFix(sql: string, fix: SqlLintQuickFix): string {
    const ast = buildSqlLintAst(sql);
    const start = offsetFromLineColumn(sql, ast.lineStarts, fix.startLineNumber, fix.startColumn);
    const end = offsetFromLineColumn(sql, ast.lineStarts, fix.endLineNumber, fix.endColumn);
    if (start > end) return sql;
    return `${sql.slice(0, start)}${fix.replacement}${sql.slice(end)}`;
}

export async function lintSql(
    sql: string,
    schemaContext?: SchemaContext,
    options: LintSqlOptions = {}
): Promise<SqlLintDiagnostic[]> {
    const ast = buildSqlLintAst(sql);
    const context: LintRuleContext = { sql, schemaContext };

    const diagnostics: SqlLintDiagnostic[] = [];
    let rustUsed = false;

    if ((options.enableRustCore ?? true) && isTauriRuntime()) {
        try {
            const rustDiagnostics = await dbLintSql(sql, schemaContext ? {
                tables: schemaContext.tables,
                columns: schemaContext.columns,
            } : null);
            diagnostics.push(...rustDiagnostics.map(normalizeRustDiagnostic));
            rustUsed = true;
        } catch {
            rustUsed = false;
        }
    }

    const effectiveRules =
        options.rules ??
        ((!rustUsed || options.forceTypeScriptRules) ? builtInRules : []);

    for (const rule of effectiveRules) {
        try {
            diagnostics.push(...rule.check(ast, context));
        } catch {
            // Ignore one bad rule so linting remains resilient.
        }
    }

    for (const rule of options.customRules ?? []) {
        try {
            diagnostics.push(...rule.check(ast, context));
        } catch {
            // Ignore one bad custom rule so editor linting remains responsive.
        }
    }

    const deduped = dedupeDiagnostics(diagnostics);
    const sorted = sortDiagnostics(deduped);
    const max = options.maxDiagnostics ?? 100;
    return sorted.slice(0, Math.max(1, max));
}

export function debounceAndLint(
    editorInstance: editor.IStandaloneCodeEditor,
    delayMs: number,
    runLint: () => void | Promise<void> = () => {}
): DebouncedLintController {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const trigger = () => {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            void runLint();
        }, Math.max(50, delayMs));
    };

    const contentDisposable = editorInstance.onDidChangeModelContent(() => {
        trigger();
    });

    return {
        trigger,
        dispose: () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            contentDisposable.dispose();
        },
    };
}

export function registerLintProvider(
    monaco: typeof import("monaco-editor"),
    editorInstance: editor.IStandaloneCodeEditor,
    options: RegisterLintProviderOptions = {}
): RegisteredLintProvider {
    const markerOwner = options.markerOwner ?? DEFAULT_MARKER_OWNER;
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    let disposed = false;
    let activeModel = editorInstance.getModel();
    let requestSeq = 0;

    const providerRef = ensureCodeActionProvider(monaco);

    const clearModelState = (model: editor.ITextModel | null) => {
        if (!model) return;
        modelDiagnostics.delete(model.uri.toString());
        monaco.editor.setModelMarkers(model, markerOwner, []);
    };

    const runLint = async () => {
        if (disposed) return;
        const model = editorInstance.getModel();
        if (!model) return;

        const currentSeq = ++requestSeq;
        const sql = model.getValue();
        const schemaContext = getSchemaContext(options);

        const diagnostics = await lintSql(sql, schemaContext, {
            rules: options.rules,
            customRules: options.customRules,
            enableRustCore: options.enableRustCore,
            forceTypeScriptRules: options.forceTypeScriptRules,
            maxDiagnostics: options.maxDiagnostics,
        });

        if (disposed || currentSeq !== requestSeq || model.isDisposed()) return;

        modelDiagnostics.set(model.uri.toString(), diagnostics);
        setModelMarkers(monaco, model, markerOwner, diagnostics);
        options.onDiagnostics?.(diagnostics);
    };

    const debounced = debounceAndLint(editorInstance, delayMs, runLint);
    const modelDisposable = editorInstance.onDidChangeModel(() => {
        clearModelState(activeModel);
        activeModel = editorInstance.getModel();
        debounced.trigger();
    });

    debounced.trigger();

    return {
        trigger: () => {
            debounced.trigger();
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            debounced.dispose();
            modelDisposable.dispose();
            clearModelState(activeModel);
            providerRef.dispose();
        },
    };
}
