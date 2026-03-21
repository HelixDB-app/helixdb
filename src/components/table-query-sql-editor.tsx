"use client";

import { useCallback } from "react";
import { useTheme } from "next-themes";
import type { editor } from "monaco-editor";
import Editor from "@monaco-editor/react";

function registerHelixThemes(monaco: typeof import("monaco-editor")) {
    monaco.editor.defineTheme("helix-light", {
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
            "scrollbarSlider.background": "#64646433",
            "scrollbarSlider.hoverBackground": "#64646466",
            "scrollbarSlider.activeBackground": "#64646466",
        },
    });

    monaco.editor.defineTheme("helix-dark", {
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
            "editor.background": "#0c0c0e",
            "editor.foreground": "#d4d4d4",
            "editorLineNumber.foreground": "#858585",
            "editorLineNumber.activeForeground": "#c6c6c6",
            "editorCursor.foreground": "#aeafad",
            "editor.selectionBackground": "#264f7840",
            "editor.inactiveSelectionBackground": "#3a3d4140",
            "editor.lineHighlightBackground": "#ffffff0a",
            "editor.lineHighlightBorder": "#00000000",
            "editorIndentGuide.background": "#404040",
            "editorIndentGuide.activeBackground": "#707070",
            "scrollbarSlider.background": "#79797933",
            "scrollbarSlider.hoverBackground": "#79797966",
            "scrollbarSlider.activeBackground": "#79797999",
        },
    });
}

export interface TableQuerySqlEditorProps {
    value: string;
    onChange: (value: string) => void;
    onRun: () => void;
    height?: number;
    readOnly?: boolean;
}

export function TableQuerySqlEditor({
    value,
    onChange,
    onRun,
    height = 220,
    readOnly = false,
}: TableQuerySqlEditorProps) {
    const { resolvedTheme } = useTheme();
    const monacoTheme = resolvedTheme === "light" ? "helix-light" : "helix-dark";

    const beforeMount = useCallback((monaco: typeof import("monaco-editor")) => {
        registerHelixThemes(monaco);
    }, []);

    const onMount = useCallback(
        (editorInstance: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
            editorInstance.addAction({
                id: "table-query-run",
                label: "Run query",
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
                run: () => {
                    onRun();
                },
            });
        },
        [onRun]
    );

    return (
        <div
            className="overflow-hidden rounded-md border border-border/40 bg-muted/20"
            data-monaco-editor
        >
            <Editor
                height={height}
                language="sql"
                theme={monacoTheme}
                value={value}
                onChange={(v) => onChange(v ?? "")}
                beforeMount={beforeMount}
                onMount={onMount}
                options={{
                    readOnly,
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    tabSize: 2,
                    padding: { top: 8, bottom: 8 },
                    automaticLayout: true,
                    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                }}
            />
        </div>
    );
}
