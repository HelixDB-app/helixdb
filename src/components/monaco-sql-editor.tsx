"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import type { editor, IDisposable } from "monaco-editor";
import Editor from "@monaco-editor/react";
import { cn } from "@/lib/utils";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import type { SchemaContext } from "@/lib/ai-suggestions";
import { useSettingsStore } from "@/stores/settings-store";

const EDITOR_HEIGHT = 200;

// SQL keywords for completions
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

// Pattern to detect table context (after FROM/JOIN/UPDATE/INTO)
const TABLE_CONTEXT_RE = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:["'\w]+\.)?(\w*)$/i;
// Pattern to detect column context (after table.)
const COLUMN_CONTEXT_RE = /(\w+)\.\w*$/;

export interface MonacoSqlEditorProps {
    value: string;
    onChange: (value: string) => void;
    onExecute: () => void;
    onFormatSql?: (formatted: string) => void;
    onFetchColumns?: (tableName: string) => Promise<string[]>;
    schemaContext?: SchemaContext;
    disabled?: boolean;
    className?: string;
}

export function MonacoSqlEditor({
    value,
    onChange,
    onExecute,
    onFormatSql,
    onFetchColumns,
    schemaContext,
    disabled,
    className,
}: MonacoSqlEditorProps) {
    const { resolvedTheme } = useTheme();
    const {
        editorFontSize,
        editorTabSize,
        editorWordWrap,
        editorMinimap,
        editorLineNumbers,
        editorFontLigatures,
    } = useSettingsStore();

    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const schemaContextRef = useRef<SchemaContext | undefined>(schemaContext);
    const onFetchColumnsRef = useRef<typeof onFetchColumns>(onFetchColumns);
    const onFormatSqlRef = useRef<typeof onFormatSql>(onFormatSql);
    const disposablesRef = useRef<IDisposable[]>([]);
    // Track last AI request time to throttle
    const lastAIRequestRef = useRef<number>(0);

    // Keep refs current
    useEffect(() => {
        schemaContextRef.current = schemaContext;
    }, [schemaContext]);

    useEffect(() => {
        onFetchColumnsRef.current = onFetchColumns;
    }, [onFetchColumns]);

    useEffect(() => {
        onFormatSqlRef.current = onFormatSql;
    }, [onFormatSql]);

    // Dispose providers on unmount
    useEffect(() => {
        return () => {
            disposablesRef.current.forEach((d) => d.dispose());
            disposablesRef.current = [];
        };
    }, []);

    const monacoTheme = resolvedTheme === "light" ? "helix-light" : "helix-dark";

    const handleEditorWillMount = useCallback(
        (monacoInstance: typeof import("monaco-editor")) => {
            // Light theme
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
                    "scrollbarSlider.background": "#64646433",
                    "scrollbarSlider.hoverBackground": "#64646466",
                    "scrollbarSlider.activeBackground": "#64646466",
                },
            });

            // Dark theme (VS Code Dark+ palette)
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
                    "scrollbar.shadow": "#00000000",
                    "scrollbarSlider.background": "#79797933",
                    "scrollbarSlider.hoverBackground": "#64646480",
                    "scrollbarSlider.activeBackground": "#64646480",
                },
            });

            // ── Schema-aware completion provider ──────────────────────────────
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

                    // Keyword completions (always available)
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
                        let cols = ctx.columns[tableName] ?? ctx.columns[tableName.toLowerCase()] ?? [];

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

            // ── AI completion provider ────────────────────────────────────────
            const aiProvider = monacoInstance.languages.registerCompletionItemProvider("sql", {
                triggerCharacters: [" ", "\n"],
                provideCompletionItems: (model, position) => {
                    const now = Date.now();
                    if (now - lastAIRequestRef.current < 500) {
                        return { suggestions: [], incomplete: true };
                    }
                    lastAIRequestRef.current = now;

                    const ctx = schemaContextRef.current;
                    const sql = model.getValue();
                    if (!sql.trim() || sql.trim().length < 4) {
                        return { suggestions: [] };
                    }

                    const wordInfo = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: wordInfo.startColumn,
                        endColumn: position.column,
                    };

                    return new Promise((resolve) => {
                        aiSuggestionEngine.getSuggestions(
                            sql,
                            ctx ?? { tables: [], columns: {} },
                            (suggestions) => {
                                resolve({
                                    suggestions: suggestions.map((text, i) => ({
                                        label: text,
                                        kind: monacoInstance.languages.CompletionItemKind.Snippet,
                                        insertText: text,
                                        range,
                                        sortText: String(i).padStart(3, "0"),
                                        detail: "Nova AI",
                                        documentation: "AI-powered SQL suggestion",
                                    })),
                                });
                            }
                        );
                    });
                },
            });

            disposablesRef.current.push(schemaProvider, aiProvider);
        },
        []
    );

    const handleEditorDidMount = useCallback(
        (editorInstance: editor.IStandaloneCodeEditor, monacoInstance: typeof import("monaco-editor")) => {
            editorRef.current = editorInstance;

            editorInstance.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
                run: () => onExecute(),
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

            editorInstance.focus();
        },
        [onExecute]
    );

    return (
        <div
            className={cn("relative overflow-hidden rounded-b border border-t-0", className)}
            style={{ borderColor: "var(--monaco-editor-border, rgba(255,255,255,0.12))" }}
        >
            <Editor
                height={EDITOR_HEIGHT}
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
                    suggestOnTriggerCharacters: true,
                    acceptSuggestionOnEnter: "smart",
                }}
            />
        </div>
    );
}
