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
import type { CollaborationSelection } from "@/lib/collaboration/types";
import { Loader2, Sparkles, Zap } from "lucide-react";
import { explainSql, explainSelection } from "@/lib/sql-explain-ai";
import type { SqlExplanation } from "@/lib/sql-explain-ai";
import { InlineExplainWidget } from "@/components/inline-explain-widget";
import {
    registerLintProvider,
    type RegisteredLintProvider,
} from "@/lib/sql-linter";
import { readClipboardText } from "@/lib/clipboard";

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
    /** Editor height in px; default 200. Ignored when fillHeight is true. */
    editorHeight?: number;
    /** When true, editor fills container height (use in flex layout with flex-1 min-h-0 parent). */
    fillHeight?: boolean;
    /** Hide the Nova AI next-action suggestions bar above the results area */
    hideNextActionSuggestions?: boolean;
    collaborators?: Array<{
        id: string;
        name: string;
        colorIndex: number;
        color: string;
        initials: string;
        selection?: CollaborationSelection | null;
        lineNumber?: number;
        column?: number;
    }>;
    onCursorActivity?: (payload: {
        lineNumber: number;
        column: number;
        selection?: CollaborationSelection | null;
    }) => void;
    /** Triggered when Cmd+L is pressed in the editor to add cursor/selection context to AI. */
    onAddContextShortcut?: (payload: {
        lineNumber: number;
        column: number;
        selection?: CollaborationSelection | null;
    }) => void;
    /** Called once on mount with a function that can trigger any Monaco editor action by ID. */
    onRegisterActionTrigger?: (trigger: (actionId: string) => void) => void;
}

interface MutableCollaboratorWidget extends editor.IContentWidget {
    domNode: HTMLDivElement;
    setPosition: (position: MonacoPosition) => void;
}

type MonacoPosition = {
    lineNumber: number;
    column: number;
};

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
    fillHeight = false,
    hideNextActionSuggestions = false,
    collaborators = [],
    onCursorActivity,
    onAddContextShortcut,
    onRegisterActionTrigger,
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
    const onCursorActivityRef = useRef<typeof onCursorActivity>(onCursorActivity);
    const onRegisterActionTriggerRef = useRef<typeof onRegisterActionTrigger>(onRegisterActionTrigger);
    const onChangeRef = useRef(onChange);
    const onExecuteRef = useRef(onExecute);
    const onReviewRef = useRef(onReview);
    const disposablesRef = useRef<IDisposable[]>([]);
    const lintProviderRef = useRef<RegisteredLintProvider | null>(null);
    const collaboratorDecorationsRef = useRef<string[]>([]);
    const collaboratorWidgetsRef = useRef<Record<string, MutableCollaboratorWidget>>({});
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

    // ── Inline Explain Widget state ──────────────────────────────────────────
    const [explainState, setExplainState] = useState<{
        isOpen: boolean;
        isLoading: boolean;
        error: string | null;
        explanation: SqlExplanation | null;
        anchorRect: DOMRect | null;
    }>({
        isOpen: false,
        isLoading: false,
        error: null,
        explanation: null,
        anchorRect: null,
    });
    const explainAbortRef = useRef<AbortController | null>(null);

    const beginAiRequest = useCallback(() => {
        aiPendingCountRef.current += 1;
        setAiRequestInFlight(true);
    }, []);

    const endAiRequest = useCallback(() => {
        aiPendingCountRef.current = Math.max(0, aiPendingCountRef.current - 1);
        setAiRequestInFlight(aiPendingCountRef.current > 0);
    }, []);

    /** Get the screen-space rect for the cursor position in the editor. */
    const getAnchorRect = useCallback((): DOMRect | null => {
        const editorInstance = editorRef.current;
        if (!editorInstance) return null;
        const position = editorInstance.getPosition();
        if (!position) return null;
        const domNode = editorInstance.getDomNode();
        if (!domNode) return null;
        const scrolledPos = editorInstance.getScrolledVisiblePosition(position);
        if (!scrolledPos) return null;
        const editorBounds = domNode.getBoundingClientRect();
        return new DOMRect(
            editorBounds.left + scrolledPos.left,
            editorBounds.top + scrolledPos.top,
            0,
            scrolledPos.height
        );
    }, []);

    const dismissExplanation = useCallback(() => {
        explainAbortRef.current?.abort();
        explainAbortRef.current = null;
        setExplainState({
            isOpen: false,
            isLoading: false,
            error: null,
            explanation: null,
            anchorRect: null,
        });
    }, []);

    const triggerExplain = useCallback(
        async (sql: string, selectedText?: string) => {
            if (!sql.trim()) return;
            explainAbortRef.current?.abort();
            const abort = new AbortController();
            explainAbortRef.current = abort;

            const anchorRect = getAnchorRect();
            setExplainState({
                isOpen: true,
                isLoading: true,
                error: null,
                explanation: null,
                anchorRect,
            });

            try {
                const result = selectedText
                    ? await explainSelection(sql, selectedText, schemaContextRef.current, {
                        signal: abort.signal,
                    })
                    : await explainSql(sql, schemaContextRef.current, { signal: abort.signal });

                if (abort.signal.aborted) return;
                setExplainState((prev) => ({
                    ...prev,
                    isLoading: false,
                    explanation: result,
                }));
            } catch (err) {
                if (abort.signal.aborted) return;
                const msg =
                    err instanceof Error
                        ? err.message
                        : "An unexpected error occurred. Check your Gemini API key in Settings → AI.";
                setExplainState((prev) => ({ ...prev, isLoading: false, error: msg }));
            }
        },
        [getAnchorRect]
    );

    const triggerExplainRef = useRef(triggerExplain);

    // Keep refs current
    useEffect(() => { triggerExplainRef.current = triggerExplain; }, [triggerExplain]);
    useEffect(() => { onExecuteRef.current = onExecute; }, [onExecute]);
    useEffect(() => { onReviewRef.current = onReview; }, [onReview]);
    useEffect(() => {
        schemaContextRef.current = schemaContext;
        lintProviderRef.current?.trigger();
    }, [schemaContext]);
    useEffect(() => { disabledRef.current = !!disabled; }, [disabled]);
    useEffect(() => { onFetchColumnsRef.current = onFetchColumns; }, [onFetchColumns]);
    useEffect(() => { onFormatSqlRef.current = onFormatSql; }, [onFormatSql]);
    useEffect(() => { onNextActionRef.current = onNextAction; }, [onNextAction]);
    useEffect(() => { onCursorActivityRef.current = onCursorActivity; }, [onCursorActivity]);
    useEffect(() => { onRegisterActionTriggerRef.current = onRegisterActionTrigger; }, [onRegisterActionTrigger]);
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
            lintProviderRef.current = null;
            dropdownAbortRef.current?.abort();
            const editorInstance = editorRef.current;
            if (editorInstance) {
                for (const widget of Object.values(collaboratorWidgetsRef.current)) {
                    editorInstance.removeContentWidget(widget);
                }
                collaboratorWidgetsRef.current = {};
                collaboratorDecorationsRef.current = editorInstance.deltaDecorations(collaboratorDecorationsRef.current, []);
            }
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

    // Live collaborator selections, cursors, and labels.
    useEffect(() => {
        const editorInstance = editorRef.current;
        const monacoInstance = monacoRef.current;
        const model = editorInstance?.getModel();
        if (!editorInstance || !monacoInstance || !model) return;

        const clampPosition = (lineNumber?: number, column?: number): MonacoPosition => {
            const safeLine = Math.max(1, Math.min(lineNumber ?? 1, model.getLineCount()));
            const maxColumn = model.getLineMaxColumn(safeLine);
            const safeColumn = Math.max(1, Math.min(column ?? 1, maxColumn));
            return { lineNumber: safeLine, column: safeColumn };
        };

        const nextDecorations: editor.IModelDeltaDecoration[] = [];
        const activeWidgetIds = new Set<string>();

        for (const collaborator of collaborators) {
            const colorClass = `collab-color-${collaborator.colorIndex % 12}`;
            const pos = clampPosition(collaborator.lineNumber, collaborator.column);

            if (collaborator.selection) {
                const start = clampPosition(
                    collaborator.selection.startLineNumber,
                    collaborator.selection.startColumn
                );
                const end = clampPosition(
                    collaborator.selection.endLineNumber,
                    collaborator.selection.endColumn
                );
                nextDecorations.push({
                    range: new monacoInstance.Range(
                        start.lineNumber,
                        start.column,
                        end.lineNumber,
                        end.column
                    ),
                    options: {
                        className: `collab-selection ${colorClass}`,
                        stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    },
                });
            }

            nextDecorations.push({
                range: new monacoInstance.Range(
                    pos.lineNumber,
                    pos.column,
                    pos.lineNumber,
                    pos.column
                ),
                options: {
                    className: `collab-cursor ${colorClass}`,
                    stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
            });

            const widgetId = `collab-widget-${collaborator.id}`;
            activeWidgetIds.add(widgetId);
            let widget = collaboratorWidgetsRef.current[widgetId];
            if (!widget) {
                const domNode = document.createElement("div");
                domNode.className = "collab-cursor-label";
                const chip = document.createElement("span");
                chip.className = "collab-cursor-chip";
                const initialsNode = document.createElement("span");
                initialsNode.className = "collab-cursor-chip-initials";
                const nameNode = document.createElement("span");
                nameNode.className = "collab-cursor-chip-name";
                chip.append(initialsNode, nameNode);
                domNode.append(chip);
                let position: MonacoPosition = pos;
                widget = {
                    domNode,
                    getId: () => widgetId,
                    getDomNode: () => domNode,
                    getPosition: () => ({
                        position,
                        preference: [
                            monacoInstance.editor.ContentWidgetPositionPreference.ABOVE,
                            monacoInstance.editor.ContentWidgetPositionPreference.BELOW,
                        ],
                    }),
                    setPosition: (nextPosition: MonacoPosition) => {
                        position = nextPosition;
                    },
                };
                collaboratorWidgetsRef.current[widgetId] = widget;
                editorInstance.addContentWidget(widget);
            }
            const chip = widget.domNode.firstElementChild as HTMLSpanElement | null;
            const initialsNode = chip?.firstElementChild as HTMLSpanElement | null;
            const nameNode = chip?.lastElementChild as HTMLSpanElement | null;
            if (chip) {
                chip.className = `collab-cursor-chip ${colorClass}`;
            }
            if (initialsNode) {
                initialsNode.textContent = collaborator.initials;
            }
            if (nameNode) {
                nameNode.textContent = collaborator.name;
            }
            widget.setPosition(pos);
            editorInstance.layoutContentWidget(widget);
        }

        for (const [widgetId, widget] of Object.entries(collaboratorWidgetsRef.current)) {
            if (!activeWidgetIds.has(widgetId)) {
                editorInstance.removeContentWidget(widget);
                delete collaboratorWidgetsRef.current[widgetId];
            }
        }

        collaboratorDecorationsRef.current = editorInstance.deltaDecorations(
            collaboratorDecorationsRef.current,
            nextDecorations
        );
    }, [collaborators, value]);

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
                    "editor.background": "#1e1e1e",
                    "editor.foreground": "#d4d4d4",
                    "editorLineNumber.foreground": "#858585",
                    "editorLineNumber.activeForeground": "#c6c6c6",
                    "editorCursor.foreground": "#aeafad",
                    "editor.selectionBackground": "#264f7840",
                    "editor.inactiveSelectionBackground": "#3a3d4140",
                    "editor.lineHighlightBackground": "#2d2d2d",
                    "editor.lineHighlightBorder": "#2d2d2d",
                    "editorIndentGuide.background": "#404040",
                    "editorIndentGuide.activeBackground": "#707070",
                    "editorBracketMatch.background": "#0064001a",
                    "editorBracketMatch.border": "#006400",
                    "editorWidget.background": "#252526",
                    "editorWidget.border": "#454545",
                    "editorSuggestWidget.background": "#252526",
                    "editorSuggestWidget.border": "#454545",
                    "editorSuggestWidget.foreground": "#d4d4d4",
                    "editorSuggestWidget.highlightForeground": "#0097fb",
                    "editorSuggestWidget.selectedBackground": "#094771",
                    "editorGhostText.foreground": "#6a737d",
                    "editorStickyScroll.background": "#1e1e1e",
                    "editorStickyScrollHover.background": "#2d2d2d",
                    "scrollbar.shadow": "#00000000",
                    "scrollbarSlider.background": "#79797933",
                    "scrollbarSlider.hoverBackground": "#79797966",
                    "scrollbarSlider.activeBackground": "#79797999",
                },
            });

            // ── Schema-aware dropdown completions ────────────────────────────────
            const schemaProvider = monacoInstance.languages.registerCompletionItemProvider("sql", {
                triggerCharacters: ["."],
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
                triggerCharacters: ["."],
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
                freeInlineCompletions: () => { },
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

            const lintProvider = registerLintProvider(monacoInstance, editorInstance, {
                delayMs: 220,
                getSchemaContext: () => schemaContextRef.current,
                enableRustCore: true,
            });
            lintProviderRef.current = lintProvider;
            disposablesRef.current.push({
                dispose: () => {
                    lintProvider.dispose();
                    if (lintProviderRef.current === lintProvider) {
                        lintProviderRef.current = null;
                    }
                },
            });

            editorInstance.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
                run: () => onExecuteRef.current(),
            });

            editorInstance.addAction({
                id: "review-query",
                label: "Review Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyR],
                run: () => onReviewRef.current?.(),
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
                id: "show-sql-quick-fixes",
                label: "Show SQL Quick Fixes",
                keybindings: [monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.Enter],
                run: () => {
                    editorInstance.trigger("keyboard", "editor.action.quickFix", {});
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

            // ── AI Explain Query actions ─────────────────────────────────────
            editorInstance.addAction({
                id: "explain-query",
                label: "✦ Explain Query (Nova AI)",
                keybindings: [
                    monacoInstance.KeyMod.CtrlCmd |
                    monacoInstance.KeyMod.Shift |
                    monacoInstance.KeyCode.KeyE,
                ],
                contextMenuGroupId: "1_modification",
                contextMenuOrder: 1.5,
                run: () => {
                    const sql = editorInstance.getValue();
                    triggerExplainRef.current(sql);
                },
            });

            editorInstance.addAction({
                id: "explain-selection",
                label: "✦ Explain Selection (Nova AI)",
                // Visible in context menu only when there is a non-empty selection
                precondition: "editorHasSelection",
                contextMenuGroupId: "1_modification",
                contextMenuOrder: 1.6,
                run: () => {
                    const sql = editorInstance.getValue();
                    const selection = editorInstance.getSelection();
                    const selectedText = selection
                        ? editorInstance.getModel()?.getValueInRange(selection) ?? ""
                        : "";
                    triggerExplainRef.current(sql, selectedText || undefined);
                },
            });

            // ── Add to AI context (Cmd+L) ─────────────────────────────────
            editorInstance.addAction({
                id: "ai-add-context",
                label: "✦ Add to AI Context (Nova)",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyL],
                contextMenuGroupId: "1_modification",
                contextMenuOrder: 1.7,
                run: () => {
                    if (disabledRef.current) return;
                    const position = editorInstance.getPosition();
                    const selection = editorInstance.getSelection();
                    if (!position) return;
                    onAddContextShortcut?.({
                        lineNumber: position.lineNumber,
                        column: position.column,
                        selection: selection
                            ? {
                                startLineNumber: selection.startLineNumber,
                                startColumn: selection.startColumn,
                                endLineNumber: selection.endLineNumber,
                                endColumn: selection.endColumn,
                            }
                            : null,
                    });
                },
            });

            // Custom paste (Cmd+V / Ctrl+V): read clipboard, insert at cursor, sync to parent.
            // Ensures paste works when default paste is blocked (e.g. Tauri before native Edit menu).
            editorInstance.addAction({
                id: "helix-paste",
                label: "Paste",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV],
                run: async () => {
                    const model = editorInstance.getModel();
                    if (!model || disabledRef.current) return;
                    const text = await readClipboardText();
                    if (text !== "") {
                        const selection = editorInstance.getSelection();
                        if (selection) {
                            editorInstance.executeEdits("helix-paste", [{
                                range: selection,
                                text,
                                forceMoveMarkers: true as const,
                            }]);
                            onChangeRef.current(model.getValue());
                            return;
                        }
                    }
                    // Fallback: trigger built-in paste then sync
                    editorInstance.trigger("keyboard", "editor.action.clipboardPasteAction", null);
                    queueMicrotask(() => onChangeRef.current(model.getValue()));
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

            const emitCursorActivity = () => {
                const position = editorInstance.getPosition();
                if (!position) return;
                const selection = editorInstance.getSelection();
                onCursorActivityRef.current?.({
                    lineNumber: position.lineNumber,
                    column: position.column,
                    selection: selection
                        ? {
                            startLineNumber: selection.startLineNumber,
                            startColumn: selection.startColumn,
                            endLineNumber: selection.endLineNumber,
                            endColumn: selection.endColumn,
                        }
                        : null,
                });
            };

            const positionDisposable = editorInstance.onDidChangeCursorPosition(() => {
                emitCursorActivity();
            });
            const selectionDisposable = editorInstance.onDidChangeCursorSelection(() => {
                emitCursorActivity();
            });
            disposablesRef.current.push(positionDisposable, selectionDisposable);
            emitCursorActivity();

            editorInstance.focus();

            // Register action trigger for external callers (e.g. toolbar button)
            onRegisterActionTriggerRef.current?.((actionId) => {
                editorInstance.trigger("external", actionId, null);
            });
        },
        [] // Using refs for all callbacks to avoid stale closures in handleEditorDidMount
    );

    return (
        <div className={cn("flex flex-col", className)}>
            {/* ── Inline Explain Widget (portal → document.body) ──────────── */}
            {explainState.isOpen && (
                <InlineExplainWidget
                    explanation={explainState.explanation}
                    isLoading={explainState.isLoading}
                    error={explainState.error}
                    anchorRect={explainState.anchorRect}
                    onDismiss={dismissExplanation}
                />
            )}

            {/* ── Editor ──────────────────────────────────────────────────────── */}
            <div
                className={cn(
                    "relative overflow-hidden rounded-b border border-t-0",
                    fillHeight && "flex-1 min-h-0 flex flex-col"
                )}
                data-monaco-editor
                style={{
                    borderColor: "var(--monaco-editor-border, rgba(255,255,255,0.12))",
                    ...(fillHeight ? {} : { minHeight: editorHeight }),
                }}
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
                    height={fillHeight ? "100%" : editorHeight}
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
                        fontFamily: "var(--font-mono), 'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
                        fontLigatures: editorFontLigatures,
                        wordWrap: editorWordWrap ? "on" : "off",
                        padding: { top: 16, bottom: 16 },
                        scrollbar: {
                            verticalScrollbarSize: 10,
                            horizontalScrollbarSize: 10,
                            verticalSliderSize: 6,
                            horizontalSliderSize: 6,
                        },
                        renderLineHighlight: "line",
                        renderLineHighlightOnlyWhenFocus: false,
                        cursorBlinking: "smooth",
                        cursorSmoothCaretAnimation: "on",
                        cursorWidth: 2,
                        smoothScrolling: true,
                        tabSize: editorTabSize,
                        insertSpaces: true,
                        automaticLayout: true,
                        readOnly: disabled,
                        domReadOnly: disabled,
                        bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
                        guides: {
                            bracketPairs: "active",
                            indentation: true,
                            highlightActiveIndentation: true,
                        },
                        renderWhitespace: "selection",
                        stickyScroll: { enabled: true, maxLineCount: 3 },
                        quickSuggestions: false,
                        quickSuggestionsDelay: 400,
                        suggestOnTriggerCharacters: true,
                        acceptSuggestionOnEnter: "off",
                        // Enable inline ghost-text (Copilot-style Tab-to-accept)
                        inlineSuggest: {
                            enabled: aiAutocompleteEnabled && aiInlineSuggestions && !disabled,
                            mode: "prefix",
                            suppressSuggestions: true,
                        },
                    }}
                />
                {aiAutocompleteEnabled && aiShowSuggestionLatency && !disabled && (
                    <div className="pointer-events-none absolute right-3 top-3 z-20 transition-opacity duration-300" style={{ opacity: liveAi.mode === "idle" && !aiRequestInFlight ? 0.4 : 0.9 }}>
                        <div
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium shadow-sm",
                                "bg-background/70 backdrop-blur-md border text-muted-foreground",
                                aiRequestInFlight
                                    ? "border-emerald-500/30"
                                    : liveAi.mode === "inline"
                                        ? "border-blue-500/25"
                                        : "border-border/30"
                            )}
                        >
                            {aiRequestInFlight ? (
                                <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                            ) : (
                                <Sparkles className="h-3 w-3 text-purple-400/80" />
                            )}
                            <span className="text-foreground/70">Nova</span>
                            {liveAi.latencyMs != null && (
                                <span className="font-mono text-[9px] text-foreground/50">{liveAi.latencyMs}ms</span>
                            )}
                            {liveAi.source && liveAi.source !== "network" && (
                                <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-emerald-400">
                                    {liveAi.source}
                                </span>
                            )}
                        </div>
                    </div>
                )}
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
