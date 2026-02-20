"use client";

import { useCallback, useRef } from "react";
import type { editor } from "monaco-editor";

import Editor from "@monaco-editor/react";
import { cn } from "@/lib/utils";

const EDITOR_HEIGHT = 200;

export interface MonacoSqlEditorProps {
    value: string;
    onChange: (value: string) => void;
    onExecute: () => void;
    disabled?: boolean;
    className?: string;
    placeholder?: string;
}

export function MonacoSqlEditor({
    value,
    onChange,
    onExecute,
    disabled,
    className,
}: MonacoSqlEditorProps) {
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

    const handleEditorDidMount = useCallback(
        (editorInstance: editor.IStandaloneCodeEditor, monacoInstance: typeof import("monaco-editor")) => {
            editorRef.current = editorInstance;

            editorInstance.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
                run: () => onExecute(),
            });

            editorInstance.focus();
        },
        [onExecute]
    );

    const handleEditorWillMount = useCallback((monacoInstance: typeof import("monaco-editor")) => {
        monacoInstance.editor.defineTheme("helix-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [],
            colors: {
                "editor.background": "#0a0a0a",
                "editor.foreground": "#e5e5e5",
            },
        });
    }, []);

    return (
        <div className={cn("relative overflow-hidden rounded-b border border-border/30 border-t-0", className)}>
            <Editor
                height={EDITOR_HEIGHT}
                defaultLanguage="sql"
                language="sql"
                value={value}
                onChange={(v) => onChange(v ?? "")}
                onMount={handleEditorDidMount}
                beforeMount={handleEditorWillMount}
                theme="helix-dark"
                loading={null}
                options={{
                    minimap: { enabled: false },
                    lineNumbers: "on",
                    lineNumbersMinChars: 3,
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    wordWrap: "on",
                    padding: { top: 12, bottom: 12 },
                    scrollbar: {
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                    },
                    renderLineHighlight: "line",
                    cursorBlinking: "smooth",
                    smoothScrolling: true,
                    tabSize: 4,
                    insertSpaces: true,
                    automaticLayout: true,
                    readOnly: disabled,
                    domReadOnly: disabled,
                }}
            />
        </div>
    );
}
