"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { editor, IDisposable } from "monaco-editor";
import Editor from "@monaco-editor/react";
import { cn } from "@/lib/utils";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import type { SchemaContext } from "@/lib/ai-suggestions";
import { useSettingsStore } from "@/stores/settings-store";
import type { SqlReviewIssue } from "@/lib/sql-review";
import { Sparkles, Zap } from "lucide-react";

const EDITOR_HEIGHT = 200;

// ── SQL keywords ──────────────────────────────────────────────────────────────
const SQL_KEYWORDS = [
    "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
    "FULL OUTER JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
    "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE",
    "DROP TABLE", "ALTER TABLE", "ADD COLUMN", "DROP COLUMN", "DISTINCT",
    "COUNT", "SUM", "AVG", "MIN", "MAX", "AS", "AND", "OR", "NOT", "IN",
    "NOT IN", "IS NULL", "IS NOT NULL", "LIKE", "ILIKE", "BETWEEN", "EXISTS",
    "UNION", "UNION ALL", "INTERSECT", "EXCEPT", "WITH", "RETURNING",
    "TRUNCATE", "EXPLAIN", "ANALYZE", "COALESCE", "NULLIF", "CAST",
];

const TABLE_CONTEXT_RE = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:["'\w]+\.)?(\w*)$/i;
const COLUMN_CONTEXT_RE = /(\w+)\.\w*$/;

// A query is "substantial" when it looks complete enough to warrant next-action suggestions
function isSubstantialQuery(sql: string): boolean {
    const t = sql.trim().toUpperCase();
    return t.length > 20 && /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\b/.test(t);
}

export interface MonacoSqlEditorProps {
    value: string;
    onChange: (value: string) => void;
    onExecute: () => void;
    onReview?: () => void;
    onFormatSql?: (formatted: string) => void;
    onFetchColumns?: (tableName: string) => Promise<string[]>;
    onNextAction?: (action: string) => void;
    reviewIssues?: SqlReviewIssue[];
    schemaContext?: SchemaContext;
    disabled?: boolean;
    className?: string;
    /** Editor height in px; default 200 */
    editorHeight?: number;
    /** Hide the Nova AI next-action suggestions bar above the results area */
    hideNextActionSuggestions?: boolean;
}

export function MonacoSqlEditor({
    value,
    onChange,
    onExecute,
    onReview,
    onFormatSql,
    onFetchColumns,
    onNextAction,
    reviewIssues,
    schemaContext,
    disabled,
    className,
    editorHeight = EDITOR_HEIGHT,
    hideNextActionSuggestions = false,
}: MonacoSqlEditorProps) {
    const { resolvedTheme } = useTheme();
    const {
        editorFontSize,
        editorTabSize,
        editorWordWrap,
        editorMinimap,
        editorLineNumbers,
        editorFontLigatures,
        aiAutocompleteEnabled,
        aiInlineSuggestions,
        aiDropdownSuggestions,
        aiNextActionSuggestions,
        aiSuggestionMinChars,
        aiSuggestionThrottleMs,
        aiSuggestionContextWindowChars,
        aiShowSuggestionLatency,
    } = useSettingsStore();

    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
    const schemaContextRef = useRef<SchemaContext | undefined>(schemaContext);
    const disabledRef = useRef<boolean>(!!disabled);
    const onFetchColumnsRef = useRef<typeof onFetchColumns>(onFetchColumns);
    const onFormatSqlRef = useRef<typeof onFormatSql>(onFormatSql);
    const onNextActionRef = useRef<typeof onNextAction>(onNextAction);
    const onChangeRef = useRef(onChange);
    const disposablesRef = useRef<IDisposable[]>([]);
    const lastDropdownRequestRef = useRef<number>(0);
    const lastInlineRequestRef = useRef<number>(0);
    const nextActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dropdownAbortRef = useRef<AbortController | null>(null);
    const aiPendingCountRef = useRef<number>(0);
    const aiConfigRef = useRef({
        aiAutocompleteEnabled,
        aiInlineSuggestions,
        aiDropdownSuggestions,
        aiNextActionSuggestions,
        aiSuggestionMinChars,
        aiSuggestionThrottleMs,
        aiSuggestionContextWindowChars,
        aiShowSuggestionLatency,
    });

    const [nextActions, setNextActions] = useState<string[]>([]);
    const [nextActionsLoading, setNextActionsLoading] = useState(false);
    const [liveAi, setLiveAi] = useState<{
        mode: "idle" | "inline" | "dropdown";
        latencyMs: number | null;
        source: "cache" | "network" | "coalesced" | null;
    }>({
        mode: "idle",
        latencyMs: null,
        source: null,
    });
    const [aiRequestInFlight, setAiRequestInFlight] = useState(false);

    const beginAiRequest = useCallback(() => {
        aiPendingCountRef.current += 1;
        setAiRequestInFlight(true);
    }, []);

    const endAiRequest = useCallback(() => {
        aiPendingCountRef.current = Math.max(0, aiPendingCountRef.current - 1);
        setAiRequestInFlight(aiPendingCountRef.current > 0);
    }, []);

    // Keep refs current
    useEffect(() => { schemaContextRef.current = schemaContext; }, [schemaContext]);
    useEffect(() => { disabledRef.current = !!disabled; }, [disabled]);
    useEffect(() => { onFetchColumnsRef.current = onFetchColumns; }, [onFetchColumns]);
    useEffect(() => { onFormatSqlRef.current = onFormatSql; }, [onFormatSql]);
    useEffect(() => { onNextActionRef.current = onNextAction; }, [onNextAction]);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => {
        aiConfigRef.current = {
            aiAutocompleteEnabled,
            aiInlineSuggestions,
            aiDropdownSuggestions,
            aiNextActionSuggestions,
            aiSuggestionMinChars,
            aiSuggestionThrottleMs,
            aiSuggestionContextWindowChars,
            aiShowSuggestionLatency,
        };
    }, [
        aiAutocompleteEnabled,
        aiInlineSuggestions,
        aiDropdownSuggestions,
        aiNextActionSuggestions,
        aiSuggestionMinChars,
        aiSuggestionThrottleMs,
        aiSuggestionContextWindowChars,
        aiShowSuggestionLatency,
    ]);

    // Dispose providers on unmount
    useEffect(() => {
        return () => {
            disposablesRef.current.forEach((d) => d.dispose());
            disposablesRef.current = [];
            dropdownAbortRef.current?.abort();
        };
    }, []);

    // Monaco decorations for AI Review findings.
    useEffect(() => {
        const editorInstance = editorRef.current;
        const monacoInstance = monacoRef.current;
        const model = editorInstance?.getModel();
        if (!editorInstance || !monacoInstance || !model) return;

        const markers = (reviewIssues ?? []).map((issue) => {
            const line = Math.max(1, Math.min(issue.line ?? 1, model.getLineCount()));
            const severity =
                issue.severity === "block"
                    ? monacoInstance.MarkerSeverity.Error
                    : issue.severity === "warn"
                        ? monacoInstance.MarkerSeverity.Warning
                        : monacoInstance.MarkerSeverity.Hint;

            return {
                severity,
                message: `[AI Review] ${issue.title}: ${issue.message}`,
                startLineNumber: line,
                startColumn: 1,
                endLineNumber: line,
                endColumn: model.getLineMaxColumn(line),
                source: "AI Review",
            };
        });

        monacoInstance.editor.setModelMarkers(model, "ai-review", markers);
        return () => {
            monacoInstance.editor.setModelMarkers(model, "ai-review", []);
        };
    }, [reviewIssues, value]);

    // ── Next-action suggestions (debounced 1.8s, only for substantial queries) ─
    useEffect(() => {
        if (nextActionTimerRef.current) clearTimeout(nextActionTimerRef.current);

        if (!aiAutocompleteEnabled || !aiNextActionSuggestions || disabled || !isSubstantialQuery(value)) {
            setNextActions([]);
            return;
        }

        nextActionTimerRef.current = setTimeout(async () => {
            const ctx = schemaContextRef.current ?? { tables: [], columns: {} };
            setNextActionsLoading(true);
            try {
                const actions = await aiSuggestionEngine.getNextActions(value, ctx);
                setNextActions(actions);
            } catch {
                setNextActions([]);
            } finally {
                setNextActionsLoading(false);
            }
        }, Math.max(800, aiSuggestionThrottleMs * 4));

        return () => {
            if (nextActionTimerRef.current) clearTimeout(nextActionTimerRef.current);
        };
    }, [value, aiAutocompleteEnabled, aiNextActionSuggestions, aiSuggestionThrottleMs, disabled]);

    const monacoTheme = resolvedTheme === "light" ? "helix-light" : "helix-dark";

    const handleEditorWillMount = useCallback(
        (monacoInstance: typeof import("monaco-editor")) => {
            // ── Themes ──────────────────────────────────────────────────────────
            monacoInstance.editor.defineTheme("helix-light", {
                base: "vs",
                inherit: true,
                rules: [
                    { token: "keyword", foreground: "0000FF", fontStyle: "bold" },
                    { token: "keyword.sql", foreground: "0000FF", fontStyle: "bold" },
                    { token: "type", foreground: "267F99" },
                    { token: "type.sql", foreground: "267F99" },
                    { token: "string", foreground: "A31515" },
                    { token: "string.sql", foreground: "A31515" },
                    { token: "number", foreground: "098658" },
                    { token: "number.sql", foreground: "098658" },
                    { token: "comment", foreground: "008000", fontStyle: "italic" },
                    { token: "comment.sql", foreground: "008000", fontStyle: "italic" },
                    { token: "identifier", foreground: "001080" },
                    { token: "identifier.sql", foreground: "001080" },
                    { token: "operator", foreground: "000000" },
                    { token: "delimiter", foreground: "000000" },
                    { token: "predefined", foreground: "267F99" },
                ],
                colors: {
                    "editor.background": "#FFFFFF",
                    "editor.foreground": "#000000",
                    "editorLineNumber.foreground": "#237893",
                    "editorLineNumber.activeForeground": "#0B216F",
                    "editorCursor.foreground": "#000000",
                    "editor.selectionBackground": "#ADD6FF",
                    "editor.inactiveSelectionBackground": "#E5EBF1",
                    "editorIndentGuide.background": "#D3D3D3",
                    "editorIndentGuide.activeBackground": "#939393",
                    "editorWidget.background": "#F3F3F3",
                    "editorWidget.border": "#C8C8C8",
                    "editorSuggestWidget.background": "#F3F3F3",
                    "editorSuggestWidget.border": "#C8C8C8",
                    "editorSuggestWidget.foreground": "#000000",
                    "editorSuggestWidget.highlightForeground": "#0066BF",
                    "editorSuggestWidget.selectedBackground": "#CCE8FF",
                    "editorGhostText.foreground": "#94949480",
                    "scrollbarSlider.background": "#64646433",
                    "scrollbarSlider.hoverBackground": "#64646466",
                    "scrollbarSlider.activeBackground": "#64646466",
                },
            });

            monacoInstance.editor.defineTheme("helix-dark", {
                base: "vs-dark",
                inherit: true,
                rules: [
                    { token: "keyword", foreground: "569CD6", fontStyle: "bold" },
                    { token: "keyword.sql", foreground: "569CD6", fontStyle: "bold" },
                    { token: "type", foreground: "4EC9B0" },
                    { token: "type.sql", foreground: "4EC9B0" },
                    { token: "string", foreground: "CE9178" },
                    { token: "string.sql", foreground: "CE9178" },
                    { token: "number", foreground: "B5CEA8" },
                    { token: "number.sql", foreground: "B5CEA8" },
                    { token: "comment", foreground: "6A9955", fontStyle: "italic" },
                    { token: "comment.sql", foreground: "6A9955", fontStyle: "italic" },
                    { token: "identifier", foreground: "9CDCFE" },
                    { token: "identifier.sql", foreground: "9CDCFE" },
                    { token: "operator", foreground: "D4D4D4" },
                    { token: "operator.sql", foreground: "D4D4D4" },
                    { token: "delimiter", foreground: "D4D4D4" },
                    { token: "delimiter.sql", foreground: "D4D4D4" },
                    { token: "predefined", foreground: "4EC9B0" },
                    { token: "predefined.sql", foreground: "4EC9B0" },
                ],
                colors: {
                    "editor.background": "#1E1E1E",
                    "editor.foreground": "#D4D4D4",
                    "editorLineNumber.foreground": "#858585",
                    "editorLineNumber.activeForeground": "#C6C6C6",
                    "editorCursor.foreground": "#AEAFAD",
                    "editor.selectionBackground": "#264F78",
                    "editor.inactiveSelectionBackground": "#3A3D41",
                    "editorIndentGuide.background": "#404040",
                    "editorIndentGuide.activeBackground": "#707070",
                    "editorWidget.background": "#252526",
                    "editorWidget.border": "#454545",
                    "editorSuggestWidget.background": "#252526",
                    "editorSuggestWidget.border": "#454545",
                    "editorSuggestWidget.foreground": "#D4D4D4",
                    "editorSuggestWidget.highlightForeground": "#569CD6",
                    "editorSuggestWidget.selectedBackground": "#094771",
                    "editorGhostText.foreground": "#ffffff30",
                    "scrollbar.shadow": "#00000000",
                    "scrollbarSlider.background": "#79797933",
                    "scrollbarSlider.hoverBackground": "#64646480",
                    "scrollbarSlider.activeBackground": "#64646480",
                },
            });

            // ── Schema-aware dropdown completions ────────────────────────────────
            const schemaProvider = monacoInstance.languages.registerCompletionItemProvider("sql", {
                triggerCharacters: [" ", ".", "\n"],
                provideCompletionItems: async (model, position) => {
                    const textUntilPosition = model.getValueInRange({
                        startLineNumber: 1,
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                    });

                    const wordInfo = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: wordInfo.startColumn,
                        endColumn: position.column,
                    };

                    const ctx = schemaContextRef.current;

                    const keywordSuggestions = SQL_KEYWORDS.map((kw) => ({
                        label: kw,
                        kind: monacoInstance.languages.CompletionItemKind.Keyword,
                        insertText: kw,
                        range,
                        detail: "SQL keyword",
                        sortText: "z_" + kw,
                    }));

                    if (!ctx || ctx.tables.length === 0) {
                        return { suggestions: keywordSuggestions };
                    }

                    // Table context: after FROM / JOIN / UPDATE / INTO / TABLE
                    const tableMatch = textUntilPosition.match(TABLE_CONTEXT_RE);
                    if (tableMatch) {
                        const tableSuggestions = ctx.tables.map((table) => ({
                            label: table,
                            kind: monacoInstance.languages.CompletionItemKind.Class,
                            insertText: table,
                            range,
                            detail: "Table",
                            sortText: "a_" + table,
                        }));
                        return { suggestions: [...tableSuggestions, ...keywordSuggestions] };
                    }

                    // Column context: after "tablename."
                    const dotMatch = textUntilPosition.match(COLUMN_CONTEXT_RE);
                    if (dotMatch) {
                        const tableName = dotMatch[1].toLowerCase();
                        let cols =
                            ctx.columns[tableName] ??
                            ctx.columns[tableName.toLowerCase()] ??
                            [];

                        if (cols.length === 0 && onFetchColumnsRef.current) {
                            try {
                                cols = await onFetchColumnsRef.current(tableName);
                            } catch {
                                cols = [];
                            }
                        }

                        if (cols.length > 0) {
                            return {
                                suggestions: cols.map((col) => ({
                                    label: col,
                                    kind: monacoInstance.languages.CompletionItemKind.Field,
                                    insertText: col,
                                    range,
                                    detail: "Column",
                                    sortText: "a_" + col,
                                })),
                            };
                        }
                    }

                    return { suggestions: keywordSuggestions };
                },
            });

            // ── AI dropdown completions (throttled, cursor-aware, telemetry) ─────
            const aiDropdownProvider = monacoInstance.languages.registerCompletionItemProvider("sql", {
                triggerCharacters: [" ", "\n", "."],
                provideCompletionItems: async (model, position, _ctx, token) => {
                    const cfg = aiConfigRef.current;
                    if (!cfg.aiAutocompleteEnabled || !cfg.aiDropdownSuggestions || disabledRef.current) {
                        return { suggestions: [] };
                    }

                    const now = Date.now();
                    if (now - lastDropdownRequestRef.current < cfg.aiSuggestionThrottleMs) {
                        return { suggestions: [], incomplete: true };
                    }
                    lastDropdownRequestRef.current = now;

                    const textUntilCursor = model.getValueInRange({
                        startLineNumber: 1,
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                    });

                    if (textUntilCursor.trim().length < cfg.aiSuggestionMinChars) {
                        return { suggestions: [] };
                    }

                    const wordInfo = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: wordInfo.startColumn,
                        endColumn: position.column,
                    };

                    const ctx = schemaContextRef.current ?? { tables: [], columns: {} };
                    dropdownAbortRef.current?.abort();
                    const abortController = new AbortController();
                    dropdownAbortRef.current = abortController;
                    token?.onCancellationRequested?.(() => abortController.abort());

                    beginAiRequest();
                    try {
                        const result = await aiSuggestionEngine.getDropdownSuggestions(textUntilCursor, ctx, {
                            signal: abortController.signal,
                            contextWindowChars: cfg.aiSuggestionContextWindowChars,
                            maxSuggestions: 5,
                        });

                        if (token?.isCancellationRequested || abortController.signal.aborted) {
                            return { suggestions: [] };
                        }

                        setLiveAi({
                            mode: "dropdown",
                            latencyMs: result.telemetry.latencyMs,
                            source: result.telemetry.source,
                        });

                        return {
                            suggestions: result.suggestions.map((text, i) => ({
                                label: text,
                                kind: monacoInstance.languages.CompletionItemKind.Snippet,
                                insertText: text,
                                range,
                                sortText: String(i).padStart(3, "0"),
                                detail: `✦ Nova AI (${result.telemetry.source})`,
                                documentation: {
                                    value: `**AI suggestion** • ${result.telemetry.latencyMs}ms`,
                                },
                            })),
                        };
                    } catch {
                        return { suggestions: [] };
                    } finally {
                        if (dropdownAbortRef.current === abortController) {
                            dropdownAbortRef.current = null;
                        }
                        endAiRequest();
                    }
                },
            });

            // ── Inline ghost-text completions (Cursor-style) ────────────────────
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inlineProvider = (monacoInstance.languages as any).registerInlineCompletionsProvider?.("sql", {
                provideInlineCompletions: async (
                    model: editor.ITextModel,
                    position: { lineNumber: number; column: number },
                    _context: unknown,
                    token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void }
                ) => {
                    const cfg = aiConfigRef.current;
                    if (!cfg.aiAutocompleteEnabled || !cfg.aiInlineSuggestions || disabledRef.current) {
                        return { items: [] };
                    }

                    const now = Date.now();
                    if (now - lastInlineRequestRef.current < cfg.aiSuggestionThrottleMs) {
                        return { items: [] };
                    }
                    lastInlineRequestRef.current = now;

                    const textUntilCursor = model.getValueInRange({
                        startLineNumber: 1,
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                    });

                    if (textUntilCursor.trim().length < cfg.aiSuggestionMinChars) {
                        return { items: [] };
                    }

                    const ctx = schemaContextRef.current ?? { tables: [], columns: {} };
                    const abortController = new AbortController();
                    token.onCancellationRequested(() => abortController.abort());

                    beginAiRequest();
                    try {
                        const result = await aiSuggestionEngine.getInlineCompletionWithTelemetry(
                            textUntilCursor,
                            ctx,
                            {
                                signal: abortController.signal,
                                contextWindowChars: cfg.aiSuggestionContextWindowChars,
                            }
                        );

                        if (!result.completion || token.isCancellationRequested || abortController.signal.aborted) {
                            return { items: [] };
                        }

                        setLiveAi({
                            mode: "inline",
                            latencyMs: result.telemetry.latencyMs,
                            source: result.telemetry.source,
                        });

                        return {
                            items: [
                                {
                                    insertText: result.completion,
                                    range: {
                                        startLineNumber: position.lineNumber,
                                        startColumn: position.column,
                                        endLineNumber: position.lineNumber,
                                        endColumn: position.column,
                                    },
                                },
                            ],
                        };
                    } catch {
                        return { items: [] };
                    } finally {
                        endAiRequest();
                    }
                },
                freeInlineCompletions: () => {},
            });

            disposablesRef.current.push(schemaProvider, aiDropdownProvider);
            if (inlineProvider) disposablesRef.current.push(inlineProvider);
        },
        [beginAiRequest, endAiRequest]
    );

    const handleEditorDidMount = useCallback(
        (editorInstance: editor.IStandaloneCodeEditor, monacoInstance: typeof import("monaco-editor")) => {
            editorRef.current = editorInstance;
            monacoRef.current = monacoInstance;

            editorInstance.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
                run: () => onExecute(),
            });

            editorInstance.addAction({
                id: "review-query",
                label: "Review Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyR],
                run: () => onReview?.(),
            });

            editorInstance.addAction({
                id: "format-sql",
                label: "Format SQL",
                keybindings: [
                    monacoInstance.KeyMod.Shift |
                    monacoInstance.KeyMod.Alt |
                    monacoInstance.KeyCode.KeyF,
                ],
                run: () => {
                    const current = editorInstance.getValue();
                    onFormatSqlRef.current?.(current);
                },
            });

            editorInstance.addAction({
                id: "accept-next-ai-word",
                label: "Accept Next AI Word",
                keybindings: [monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.RightArrow],
                run: () => {
                    editorInstance.trigger("keyboard", "editor.action.inlineSuggest.acceptNextWord", {});
                },
            });

            editorInstance.addAction({
                id: "trigger-ai-inline-suggestion",
                label: "Trigger AI Inline Suggestion",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Period],
                run: () => {
                    editorInstance.trigger("keyboard", "editor.action.inlineSuggest.trigger", {});
                },
            });

            // Custom paste (Cmd+V / Ctrl+V): read clipboard, insert at cursor, sync to parent.
            // Ensures paste works even when default paste is blocked (e.g. in Tauri/desktop).
            editorInstance.addAction({
                id: "helix-paste",
                label: "Paste",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV],
                run: async () => {
                    const model = editorInstance.getModel();
                    if (!model || disabledRef.current) return;
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text === "") return;
                        const selection = editorInstance.getSelection();
                        if (!selection) return;
                        const edit = {
                            range: selection,
                            text,
                            forceMoveMarkers: true as const,
                        };
                        editorInstance.executeEdits("helix-paste", [edit]);
                        const newValue = model.getValue();
                        onChangeRef.current(newValue);
                    } catch {
                        // Fallback: trigger built-in paste then sync
                        editorInstance.trigger("keyboard", "editor.action.clipboardPasteAction", null);
                        queueMicrotask(() => {
                            const v = model.getValue();
                            onChangeRef.current(v);
                        });
                    }
                },
            });

            // Sync to parent after any paste (built-in or custom)
            if (typeof editorInstance.onDidPaste === "function") {
                const pasteDisposable = editorInstance.onDidPaste(() => {
                    const model = editorInstance.getModel();
                    if (model) {
                        const v = model.getValue();
                        queueMicrotask(() => onChangeRef.current(v));
                    }
                });
                disposablesRef.current.push(pasteDisposable);
            }

            // DOM paste fallback: when paste reaches the editor dom node, sync after
            const domNode = editorInstance.getDomNode();
            if (domNode) {
                const onDomPaste = () => {
                    queueMicrotask(() => {
                        const model = editorInstance.getModel();
                        if (model) onChangeRef.current(model.getValue());
                    });
                };
                domNode.addEventListener("paste", onDomPaste);
                disposablesRef.current.push({
                    dispose: () => domNode.removeEventListener("paste", onDomPaste),
                });
            }

            editorInstance.focus();
        },
        [onExecute, onReview]
    );

    return (
        <div className={cn("flex flex-col", className)}>
            {/* ── Editor ──────────────────────────────────────────────────────── */}
            <div
                className="relative overflow-hidden rounded-b border border-t-0"
                style={{ borderColor: "var(--monaco-editor-border, rgba(255,255,255,0.12))", minHeight: editorHeight }}
            >
                {!value.trim() && !disabled && (
                    <div
                        className="absolute left-0 top-0 right-0 bottom-0 flex items-start pt-[52px] pl-[52px] pointer-events-none z-[1]"
                        aria-hidden
                    >
                        <span className="text-[13px] font-mono text-muted-foreground/50">
                            Type or paste SQL here… (⌘↵ to run)
                        </span>
                    </div>
                )}
                <Editor
                    height={editorHeight}
                    defaultLanguage="sql"
                    language="sql"
                    value={value}
                    onChange={(v) => onChange(v ?? "")}
                    onMount={handleEditorDidMount}
                    beforeMount={handleEditorWillMount}
                    theme={monacoTheme}
                    loading={null}
                    options={{
                        minimap: { enabled: editorMinimap },
                        lineNumbers: editorLineNumbers ? "on" : "off",
                        lineNumbersMinChars: 3,
                        scrollBeyondLastLine: false,
                        fontSize: editorFontSize,
                        fontFamily: "var(--font-mono), ui-monospace, monospace",
                        fontLigatures: editorFontLigatures,
                        wordWrap: editorWordWrap ? "on" : "off",
                        padding: { top: 12, bottom: 12 },
                        scrollbar: {
                            verticalScrollbarSize: 8,
                            horizontalScrollbarSize: 8,
                        },
                        renderLineHighlight: "line",
                        cursorBlinking: "smooth",
                        smoothScrolling: true,
                        tabSize: editorTabSize,
                        insertSpaces: true,
                        automaticLayout: true,
                        readOnly: disabled,
                        domReadOnly: disabled,
                        quickSuggestions: {
                            other: true,
                            comments: false,
                            strings: false,
                        },
                        quickSuggestionsDelay: Math.min(240, Math.max(20, Math.round(aiSuggestionThrottleMs / 2))),
                        suggestOnTriggerCharacters: true,
                        acceptSuggestionOnEnter: "smart",
                        // Enable inline ghost-text (Copilot-style Tab-to-accept)
                        inlineSuggest: {
                            enabled: aiAutocompleteEnabled && aiInlineSuggestions && !disabled,
                            mode: "prefix",
                            suppressSuggestions: false,
                        },
                    }}
                />
{/* 
                {aiAutocompleteEnabled && aiShowSuggestionLatency && !disabled && (
                    <div className="pointer-events-none absolute left-2 top-2 z-20">
                        <div
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium",
                                "bg-background/80 backdrop-blur border-border/40 text-muted-foreground"
                            )}
                        >
                            {aiRequestInFlight ? (
                                <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                            ) : (
                                <Zap className="h-3 w-3 text-amber-400/80" />
                            )}
                            <span>AI {liveAi.mode === "idle" ? "ready" : liveAi.mode}</span>
                            {liveAi.latencyMs != null && (
                                <span className="font-mono text-foreground/80">{liveAi.latencyMs}ms</span>
                            )}
                            {liveAi.source && (
                                <span className="uppercase tracking-wide text-[9px] text-muted-foreground/70">
                                    {liveAi.source}
                                </span>
                            )}
                        </div>
                    </div>
                )} */}
            </div>

            {/* Next-action suggestions bar — hidden when hideNextActionSuggestions (cleaner results view) */}
            {!hideNextActionSuggestions &&
                (nextActions.length > 0 || nextActionsLoading) &&
                !disabled &&
                aiAutocompleteEnabled &&
                aiNextActionSuggestions && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 border border-t-0 border-border/30 bg-muted/20 rounded-b overflow-x-auto">
                        <div className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground/50 font-medium">
                            {nextActionsLoading ? (
                                <Zap className="h-3 w-3 animate-pulse text-yellow-500/70" />
                            ) : (
                                <Sparkles className="h-3 w-3 text-purple-400/70" />
                            )}
                            <span>Nova</span>
                        </div>
                        {nextActionsLoading && (
                            <div className="flex gap-1">
                                {[1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className="h-5 rounded bg-muted/40 animate-pulse"
                                        style={{ width: `${60 + i * 20}px` }}
                                    />
                                ))}
                            </div>
                        )}
                        {!nextActionsLoading &&
                            nextActions.map((action, i) => (
                                <button
                                    key={i}
                                    onClick={() => {
                                        if (onNextActionRef.current) onNextActionRef.current(action);
                                    }}
                                    className={cn(
                                        "shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px]",
                                        "border border-border/40 bg-background/60 hover:bg-accent/60",
                                        "text-muted-foreground hover:text-foreground",
                                        "transition-colors duration-150 cursor-pointer whitespace-nowrap font-mono"
                                    )}
                                    title="Click to apply this suggestion"
                                >
                                    {action}
                                </button>
                            ))}
                    </div>
                )}
        </div>
    );
}
