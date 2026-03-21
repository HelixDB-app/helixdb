"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { editor, IDisposable, IRange } from "monaco-editor";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { cn } from "@/lib/utils";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import { AI_COMMAND_MODEL_OPTIONS, runAiCommand, type AiCommandModel } from "@/lib/ai-command";
import type { SchemaContext } from "@/lib/ai-suggestions";
import { useSettingsStore } from "@/stores/settings-store";
import type { SqlReviewIssue } from "@/lib/sql-review";
import type { CollaborationSelection } from "@/lib/collaboration/types";
import { Loader2, Sparkles, Zap, X, Send, ChevronDown } from "lucide-react";
import { explainSql, explainSelection } from "@/lib/sql-explain-ai";
import type { SqlExplanation } from "@/lib/sql-explain-ai";
import { InlineExplainWidget } from "@/components/inline-explain-widget";
import { Kbd } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
    registerLintProvider,
    type RegisteredLintProvider,
} from "@/lib/sql-linter";
import { readClipboardText } from "@/lib/clipboard";
import { toast } from "sonner";

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

function isInsideCreateTableColumns(textUntilCursor: string): boolean {
    const lower = textUntilCursor.toLowerCase();
    const createIdx = lower.lastIndexOf("create table");
    if (createIdx === -1) return false;
    const after = textUntilCursor.slice(createIdx);
    const openIdx = after.indexOf("(");
    if (openIdx === -1) return false;
    const body = after.slice(openIdx + 1);
    let depth = 1;
    for (const ch of body) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (depth === 0) return false;
    }
    return depth > 0;
}

function shouldTriggerDropdownAi(textUntilCursor: string, minChars: number): boolean {
    const trimmed = textUntilCursor.trimEnd();
    if (trimmed.length >= minChars) return true;
    const tailToken = trimmed.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
    if (tailToken.length >= 3) return true;
    if (tailToken.length >= 2 && isInsideCreateTableColumns(trimmed)) return true;
    if (/,\\s*$/.test(trimmed) && isInsideCreateTableColumns(trimmed)) return true;
    if (/\n\s*$/.test(textUntilCursor) && isInsideCreateTableColumns(trimmed)) return true;
    return false;
}

function shouldTriggerInlineAi(textUntilCursor: string, minChars: number): boolean {
    const trimmed = textUntilCursor.trimEnd();
    if (trimmed.length >= minChars) return true;
    const tailToken = trimmed.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
    if (tailToken.length >= 2) return true;
    if (tailToken.length >= 1 && isInsideCreateTableColumns(trimmed)) return true;
    if (/,\\s*$/.test(trimmed) && isInsideCreateTableColumns(trimmed)) return true;
    if (/\n\s*$/.test(textUntilCursor)) {
        if (isInsideCreateTableColumns(trimmed)) return true;
        const lines = textUntilCursor.split("\n");
        for (let i = lines.length - 2; i >= 0; i -= 1) {
            const line = lines[i]?.trim();
            if (!line) continue;
            if (/[;,)]$/.test(line)) return true;
            if (/\b(select|insert|update|delete|create|drop|alter|with)\b/i.test(line)) return true;
            break;
        }
    }
    return false;
}

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function getCommandAnchor(
    editorInstance: editor.IStandaloneCodeEditor,
    range: IRange
): { top: number; left: number } {
    const domNode = editorInstance.getDomNode();
    if (!domNode) return { top: 20, left: 20 };
    const pos = editorInstance.getScrolledVisiblePosition({
        lineNumber: range.startLineNumber,
        column: range.startColumn,
    });
    const rect = domNode.getBoundingClientRect();
    const rawTop = (pos?.top ?? 24) - 8;
    const rawLeft = (pos?.left ?? 24);
    const top = clampNumber(rawTop, 8, Math.max(8, rect.height - 180));
    const left = clampNumber(rawLeft, 12, Math.max(12, rect.width - 440));
    return { top, left };
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
    const inlineTriggerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inlineHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inlineEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastEnterTriggerAtRef = useRef<number>(0);
    const dropdownAbortRef = useRef<AbortController | null>(null);
    const aiPendingCountRef = useRef<number>(0);
    const inlineTriggerReasonRef = useRef<"typing" | "newline" | "explicit">("typing");
    const forceInlineOnceRef = useRef<boolean>(false);
    const lastInlineCompletionRef = useRef<string>("");
    const recentInlineCompletionsRef = useRef<string[]>([]);
    const recentInlineRejectionsRef = useRef<string[]>([]);
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

    const aiCommandAbortRef = useRef<AbortController | null>(null);
    const aiCommandInputRef = useRef<HTMLTextAreaElement | null>(null);
    const aiCommandSelectionRef = useRef<IRange | null>(null);
    const aiCommandHasSelectionRef = useRef<boolean>(false);
    const aiCommandSelectionTextRef = useRef<string>("");

    const [nextActions, setNextActions] = useState<string[]>([]);
    const [nextActionsLoading, setNextActionsLoading] = useState(false);
    const [inlineHintVisible, setInlineHintVisible] = useState(false);
    const [aiError, setAiError] = useState<{ message: string; at: number } | null>(null);
    const [liveAi, setLiveAi] = useState<{
        mode: "idle" | "inline" | "dropdown";
        latencyMs: number | null;
        source: "network" | "coalesced" | "stream" | "cache" | null;
    }>({
        mode: "idle",
        latencyMs: null,
        source: null,
    });
    const [aiCommandOpen, setAiCommandOpen] = useState(false);
    const [aiCommandPrompt, setAiCommandPrompt] = useState("");
    const [aiCommandModel, setAiCommandModel] = useState<AiCommandModel>("auto");
    const [aiCommandAnchor, setAiCommandAnchor] = useState<{ top: number; left: number } | null>(null);
    const [aiCommandLoading, setAiCommandLoading] = useState(false);
    const [aiCommandError, setAiCommandError] = useState<string | null>(null);
    const [aiCommandContextLabel, setAiCommandContextLabel] = useState("Edit selection");
    const [aiDiffOpen, setAiDiffOpen] = useState(false);
    const [aiDiffOriginal, setAiDiffOriginal] = useState("");
    const [aiDiffModified, setAiDiffModified] = useState("");
    const [aiDiffRange, setAiDiffRange] = useState<IRange | null>(null);
    const [aiDiffIsFullFile, setAiDiffIsFullFile] = useState(false);
    const [aiDiffMode, setAiDiffMode] = useState<"diff" | "edit">("diff");
    const [aiDiffModel, setAiDiffModel] = useState<string | null>(null);
    const [aiRequestInFlight, setAiRequestInFlight] = useState(false);
    const lastAiErrorToastRef = useRef<number>(0);

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

    const showInlineHint = useCallback(() => {
        setInlineHintVisible(true);
        if (inlineHintTimerRef.current) clearTimeout(inlineHintTimerRef.current);
        inlineHintTimerRef.current = setTimeout(() => setInlineHintVisible(false), 2600);
    }, []);

    const scheduleEnterInlineSuggest = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
        const now = Date.now();
        if (now - lastEnterTriggerAtRef.current < 120) return;
        lastEnterTriggerAtRef.current = now;
        inlineTriggerReasonRef.current = "newline";
        forceInlineOnceRef.current = true;
        if (inlineEnterTimerRef.current) clearTimeout(inlineEnterTimerRef.current);
        inlineEnterTimerRef.current = setTimeout(() => {
            editorInstance.trigger("keyboard", "editor.action.inlineSuggest.trigger", { explicit: true });
        }, 60);
    }, []);

    const hideInlineHint = useCallback(() => {
        if (inlineHintTimerRef.current) clearTimeout(inlineHintTimerRef.current);
        inlineHintTimerRef.current = null;
        setInlineHintVisible(false);
    }, []);

    const reportAiError = useCallback((message: string) => {
        const now = Date.now();
        setAiError({ message, at: now });
        if (now - lastAiErrorToastRef.current > 3000) {
            toast.error("AI suggestions failed", {
                description: message,
            });
            lastAiErrorToastRef.current = now;
        }
    }, []);

    const clearAiError = useCallback(() => {
        setAiError(null);
    }, []);

    const pushRecentInlineCompletion = useCallback((text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const list = recentInlineCompletionsRef.current;
        if (list[list.length - 1] === trimmed) return;
        list.push(trimmed);
        if (list.length > 4) list.shift();
        recentInlineCompletionsRef.current = list;
    }, []);

    const pushRecentInlineRejection = useCallback((text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const list = recentInlineRejectionsRef.current;
        if (list[list.length - 1] === trimmed) return;
        list.push(trimmed);
        if (list.length > 4) list.shift();
        recentInlineRejectionsRef.current = list;
    }, []);

    const showInlineHintRef = useRef(showInlineHint);
    const hideInlineHintRef = useRef(hideInlineHint);
    const pushRecentInlineCompletionRef = useRef(pushRecentInlineCompletion);
    const pushRecentInlineRejectionRef = useRef(pushRecentInlineRejection);
    const reportAiErrorRef = useRef(reportAiError);
    const clearAiErrorRef = useRef(clearAiError);

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

    const openAiCommand = useCallback(() => {
        const editorInstance = editorRef.current;
        if (!editorInstance || disabledRef.current) return;
        const model = editorInstance.getModel();
        if (!model) return;
        const selection = editorInstance.getSelection();
        const hasSelection = !!selection && !selection.isEmpty();
        const range = hasSelection && selection ? selection : model.getFullModelRange();
        const selectionText = hasSelection && selection ? model.getValueInRange(selection) : "";
        editorInstance.revealRangeInCenterIfOutsideViewport(range);
        aiCommandSelectionRef.current = range;
        aiCommandHasSelectionRef.current = hasSelection;
        aiCommandSelectionTextRef.current = selectionText;
        setAiCommandContextLabel(hasSelection ? "Edit selection" : "Edit file");
        setAiCommandAnchor(getCommandAnchor(editorInstance, range));
        setAiCommandOpen(true);
        setAiCommandError(null);
        setTimeout(() => aiCommandInputRef.current?.focus(), 0);
    }, []);

    const closeAiCommand = useCallback(() => {
        aiCommandAbortRef.current?.abort();
        aiCommandAbortRef.current = null;
        setAiCommandOpen(false);
        setAiCommandPrompt("");
        setAiCommandError(null);
        setAiCommandLoading(false);
    }, []);

    const runAiCommandRequest = useCallback(async () => {
        if (aiCommandLoading) return;
        if (!aiCommandPrompt.trim()) {
            setAiCommandError("Add an instruction to run.");
            return;
        }
        const editorInstance = editorRef.current;
        if (!editorInstance) return;
        const model = editorInstance.getModel();
        if (!model) return;
        const range = aiCommandSelectionRef.current ?? model.getFullModelRange();
        const hasSelection = aiCommandHasSelectionRef.current;
        const selectionText = hasSelection ? aiCommandSelectionTextRef.current : undefined;
        const fullText = model.getValue();
        const startOffset = model.getOffsetAt({
            lineNumber: range.startLineNumber,
            column: range.startColumn,
        });
        const endOffset = model.getOffsetAt({
            lineNumber: range.endLineNumber,
            column: range.endColumn,
        });

        aiCommandAbortRef.current?.abort();
        const abort = new AbortController();
        aiCommandAbortRef.current = abort;
        setAiCommandLoading(true);
        setAiCommandError(null);

        try {
            const { text, modelUsed } = await runAiCommand({
                instruction: aiCommandPrompt,
                fullText,
                selectionText,
                selectionStart: startOffset,
                selectionEnd: endOffset,
                language: "SQL",
                model: aiCommandModel,
                signal: abort.signal,
                maxContextChars: Math.max(4000, aiConfigRef.current.aiSuggestionContextWindowChars * 6),
            });

            if (abort.signal.aborted) return;
            const output = text.trim();
            if (!output) {
                setAiCommandError("AI returned an empty response.");
                return;
            }

            const original = selectionText ?? fullText;
            setAiDiffOriginal(original);
            setAiDiffModified(output);
            setAiDiffRange(range);
            setAiDiffIsFullFile(!hasSelection);
            setAiDiffMode("diff");
            setAiDiffModel(modelUsed);
            setAiDiffOpen(true);
            setAiCommandOpen(false);
            setAiCommandPrompt("");
            setAiCommandError(null);
        } catch (err) {
            if (abort.signal.aborted) return;
            const msg =
                typeof err === "object" && err && "userMessage" in err && typeof (err as { userMessage?: unknown }).userMessage === "string"
                    ? String((err as { userMessage?: unknown }).userMessage)
                    : err instanceof Error
                        ? err.message
                        : "AI command failed.";
            setAiCommandError(msg);
            toast.error("AI command failed", { description: msg });
        } finally {
            if (!abort.signal.aborted) {
                setAiCommandLoading(false);
            }
        }
    }, [aiCommandLoading, aiCommandModel, aiCommandPrompt]);

    const acceptAiDiff = useCallback(() => {
        const editorInstance = editorRef.current;
        if (!editorInstance) return;
        const model = editorInstance.getModel();
        if (!model) return;
        const range = aiDiffRange ?? model.getFullModelRange();
        const replacement = aiDiffModified;
        editorInstance.executeEdits("ai-command", [
            {
                range: aiDiffIsFullFile ? model.getFullModelRange() : range,
                text: replacement,
                forceMoveMarkers: true as const,
            },
        ]);
        onChangeRef.current(model.getValue());
        setAiDiffOpen(false);
        setAiDiffRange(null);
    }, [aiDiffIsFullFile, aiDiffModified, aiDiffRange]);

    // Keep refs current
    useEffect(() => { triggerExplainRef.current = triggerExplain; }, [triggerExplain]);
    useEffect(() => { onExecuteRef.current = onExecute; }, [onExecute]);
    useEffect(() => { onReviewRef.current = onReview; }, [onReview]);
    useEffect(() => { showInlineHintRef.current = showInlineHint; }, [showInlineHint]);
    useEffect(() => { hideInlineHintRef.current = hideInlineHint; }, [hideInlineHint]);
    useEffect(() => { pushRecentInlineCompletionRef.current = pushRecentInlineCompletion; }, [pushRecentInlineCompletion]);
    useEffect(() => { pushRecentInlineRejectionRef.current = pushRecentInlineRejection; }, [pushRecentInlineRejection]);
    useEffect(() => { reportAiErrorRef.current = reportAiError; }, [reportAiError]);
    useEffect(() => { clearAiErrorRef.current = clearAiError; }, [clearAiError]);
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
    useEffect(() => {
        if (!aiAutocompleteEnabled || !aiInlineSuggestions || disabled) {
            hideInlineHint();
        }
    }, [aiAutocompleteEnabled, aiInlineSuggestions, disabled, hideInlineHint]);

    useEffect(() => {
        if (!aiCommandOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeAiCommand();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [aiCommandOpen, closeAiCommand]);

    // Dispose providers on unmount
    useEffect(() => {
        return () => {
            disposablesRef.current.forEach((d) => d.dispose());
            disposablesRef.current = [];
            lintProviderRef.current = null;
            dropdownAbortRef.current?.abort();
            if (inlineTriggerTimerRef.current) clearTimeout(inlineTriggerTimerRef.current);
            if (inlineHintTimerRef.current) clearTimeout(inlineHintTimerRef.current);
            if (inlineEnterTimerRef.current) clearTimeout(inlineEnterTimerRef.current);
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
                    "editor.background": "#00000000",
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
                    "editorBracketMatch.background": "#0064001a",
                    "editorBracketMatch.border": "#006400",
                    "editorWidget.background": "#141414",
                    "editorWidget.border": "#333333",
                    "editorSuggestWidget.background": "#141414",
                    "editorSuggestWidget.border": "#333333",
                    "editorSuggestWidget.foreground": "#d4d4d4",
                    "editorSuggestWidget.highlightForeground": "#10b981",
                    "editorSuggestWidget.selectedBackground": "#052e16",
                    "editorGhostText.foreground": "#6a737d",
                    "editorStickyScroll.background": "#00000000",
                    "editorStickyScrollHover.background": "#ffffff0a",
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

                    if (!shouldTriggerDropdownAi(textUntilCursor, cfg.aiSuggestionMinChars)) {
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
                        if (result.error) {
                            reportAiErrorRef.current(result.error);
                        } else {
                            clearAiErrorRef.current();
                        }

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
                    context: { triggerKind?: number } | undefined,
                    token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void }
                ) => {
                    const cfg = aiConfigRef.current;
                    if (!cfg.aiAutocompleteEnabled || !cfg.aiInlineSuggestions || disabledRef.current) {
                        return { items: [] };
                    }

                    const isExplicit =
                        context?.triggerKind ===
                        (monacoInstance.languages as any).InlineCompletionTriggerKind?.Explicit;
                    const triggerReason = inlineTriggerReasonRef.current;
                    inlineTriggerReasonRef.current = "typing";
                    const preferSingleLine = triggerReason === "newline" ? true : !isExplicit;

                    const forceInline = forceInlineOnceRef.current;
                    if (forceInline) forceInlineOnceRef.current = false;

                    const now = Date.now();
                    const throttleMs = isExplicit || forceInline ? 0 : Math.max(80, Math.min(cfg.aiSuggestionThrottleMs, 180));
                    if (!isExplicit && !forceInline && now - lastInlineRequestRef.current < throttleMs) {
                        return { items: [] };
                    }
                    lastInlineRequestRef.current = now;

                    const fullSql = model.getValue();
                    const cursorOffset = model.getOffsetAt(position);
                    const textUntilCursor = fullSql.slice(0, cursorOffset);

                    if (!isExplicit && !forceInline && !shouldTriggerInlineAi(textUntilCursor, cfg.aiSuggestionMinChars)) {
                        return { items: [] };
                    }

                    const ctx = schemaContextRef.current ?? { tables: [], columns: {} };
                    const abortController = new AbortController();
                    token.onCancellationRequested(() => abortController.abort());

                    beginAiRequest();
                    try {
                        const result = await aiSuggestionEngine.getInlineCompletionWithTelemetry(textUntilCursor, ctx, {
                            signal: abortController.signal,
                            contextWindowChars: cfg.aiSuggestionContextWindowChars,
                            fullSql,
                            cursorOffset,
                            preferSingleLine,
                            recentCompletions: recentInlineCompletionsRef.current,
                            recentRejections: recentInlineRejectionsRef.current,
                        });

                        if (result.error) {
                            reportAiErrorRef.current(result.error);
                        } else {
                            clearAiErrorRef.current();
                        }

                        if (!result.completion || token.isCancellationRequested || abortController.signal.aborted) {
                            return { items: [] };
                        }

                        lastInlineCompletionRef.current = result.completion;
                        setLiveAi({
                            mode: "inline",
                            latencyMs: result.telemetry.latencyMs,
                            source: result.telemetry.source,
                        });

                        showInlineHintRef.current();
                        const hintStyle = (monacoInstance.languages as any).InlineCompletionHintStyle?.Label;
                        const hint = hintStyle
                            ? {
                                range: {
                                    startLineNumber: position.lineNumber,
                                    startColumn: position.column,
                                    endLineNumber: position.lineNumber,
                                    endColumn: position.column,
                                },
                                style: hintStyle,
                                content: "Tab to accept",
                                jumpToEdit: false,
                            }
                            : undefined;

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
                                    hint,
                                },
                            ],
                            enableForwardStability: true,
                        };
                    } catch {
                        return { items: [] };
                    } finally {
                        endAiRequest();
                    }
                },
                freeInlineCompletions: () => { },
                // Some Monaco builds call disposeInlineCompletions instead.
                disposeInlineCompletions: () => { },
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
                label: "Format SQL (collapsed)",
                // Match FORMAT_SQL_KEY_COMBO in @/lib/format-sql
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

            editorInstance.addAction({
                id: "accept-next-ai-line",
                label: "Accept Next AI Line",
                keybindings: [monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.DownArrow],
                run: () => {
                    editorInstance.trigger("keyboard", "editor.action.inlineSuggest.acceptNextLine", {});
                },
            });

            const scheduleInlineSuggest = () => {
                const cfg = aiConfigRef.current;
                if (!cfg.aiAutocompleteEnabled || !cfg.aiInlineSuggestions || disabledRef.current) return;
                const model = editorInstance.getModel();
                const position = editorInstance.getPosition();
                if (!model || !position) return;
                const fullSql = model.getValue();
                const cursorOffset = model.getOffsetAt(position);
                const textUntilCursor = fullSql.slice(0, cursorOffset);
                if (!shouldTriggerInlineAi(textUntilCursor, cfg.aiSuggestionMinChars)) return;
                if (inlineTriggerTimerRef.current) clearTimeout(inlineTriggerTimerRef.current);
                const delay = Math.max(80, Math.min(cfg.aiSuggestionThrottleMs, 180));
                inlineTriggerTimerRef.current = setTimeout(() => {
                    editorInstance.trigger("keyboard", "editor.action.inlineSuggest.trigger", { explicit: false });
                }, delay);
            };

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

            editorInstance.addAction({
                id: "ai-command-palette",
                label: "✦ AI Command (Edit Selection)",
                keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyK],
                contextMenuGroupId: "1_modification",
                contextMenuOrder: 1.4,
                run: () => {
                    if (disabledRef.current) return;
                    openAiCommand();
                },
            });

            const inlineContentDisposable = editorInstance.onDidChangeModelContent((e) => {
                scheduleInlineSuggest();
                hideInlineHintRef.current();
                const insertedText = e.changes.map((c) => c.text).join("");
                if (insertedText.includes("\n")) {
                    scheduleEnterInlineSuggest(editorInstance);
                    setTimeout(() => {
                        if (inlineTriggerReasonRef.current === "newline") {
                            inlineTriggerReasonRef.current = "typing";
                        }
                    }, 500);
                }
                const lastCompletion = lastInlineCompletionRef.current;
                if (!lastCompletion) return;
                const inserted = e.changes.map((c) => c.text).join("");
                if (!/[A-Za-z0-9]/.test(inserted)) return;
                const matches =
                    lastCompletion.startsWith(inserted) || inserted.startsWith(lastCompletion);
                if (matches) {
                    if (inserted.length >= 3) {
                        pushRecentInlineCompletionRef.current(inserted);
                    }
                    lastInlineCompletionRef.current = "";
                    if (inserted.length >= 3) {
                        setTimeout(() => {
                            editorInstance.trigger("keyboard", "editor.action.inlineSuggest.trigger", { explicit: false });
                        }, 80);
                    }
                } else {
                    pushRecentInlineRejectionRef.current(lastCompletion);
                    lastInlineCompletionRef.current = "";
                }
            });
            const inlineCursorDisposable = editorInstance.onDidChangeCursorPosition(() => {
                hideInlineHintRef.current();
            });
            const inlineBlurDisposable = editorInstance.onDidBlurEditorText?.(() => {
                hideInlineHintRef.current();
            });

            disposablesRef.current.push(inlineContentDisposable, inlineCursorDisposable);
            if (inlineBlurDisposable) disposablesRef.current.push(inlineBlurDisposable);

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
        [scheduleEnterInlineSuggest, openAiCommand] // Using refs for all callbacks (except Enter scheduling) to avoid stale closures
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
                            mode: "subwordSmart",
                            suppressSuggestions: true,
                            showToolbar: "always",
                            minShowDelay: 0,
                        },
                    }}
                />
                {aiCommandOpen && aiCommandAnchor && (
                    <div
                        className="absolute inset-0 z-40"
                        onMouseDown={(e) => {
                            if ((e.target as HTMLElement).closest("[data-ai-command]")) return;
                            closeAiCommand();
                        }}
                    >
                        <div
                            data-ai-command
                            className={cn(
                                "absolute w-[360px] rounded-lg border border-border/35 bg-background/85",
                                "shadow-lg backdrop-blur-xl overflow-hidden",
                                "animate-in fade-in-0 zoom-in-95"
                            )}
                            style={{ top: aiCommandAnchor.top, left: aiCommandAnchor.left }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/30 bg-muted/15">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10.5px] font-semibold text-foreground/80">AI Command</span>
                                    <span className="text-[9.5px] text-muted-foreground/70">{aiCommandContextLabel}</span>
                                </div>
                                <button
                                    className="rounded-md p-1 text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition"
                                    onClick={closeAiCommand}
                                    aria-label="Close"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                            <div className="p-2.5 space-y-2.5">
                                <Textarea
                                    ref={aiCommandInputRef}
                                    value={aiCommandPrompt}
                                    onChange={(e) => setAiCommandPrompt(e.target.value)}
                                    onKeyDown={(e) => {
                                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                            e.preventDefault();
                                            runAiCommandRequest();
                                        }
                                    }}
                                    placeholder="Describe the change you want..."
                                    rows={3}
                                    className="resize-none bg-background/60 border-border/50 text-xs font-mono leading-relaxed"
                                />
                                {aiCommandError && (
                                    <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
                                        {aiCommandError}
                                    </div>
                                )}
                                <div className="flex items-center justify-between gap-2">
                                    <div className="relative flex items-center">
                                        <select
                                            value={aiCommandModel}
                                            onChange={(e) => setAiCommandModel(e.target.value as AiCommandModel)}
                                            className="h-7 appearance-none rounded-md border border-border/50 bg-background/60 pl-2 pr-6 text-[10px] font-medium text-foreground/80 focus:outline-none focus:ring-1 focus:ring-primary/40"
                                        >
                                            {AI_COMMAND_MODEL_OPTIONS.map((opt) => (
                                                <option key={opt.id} value={opt.id}>
                                                    {opt.label}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-muted-foreground/70" />
                                    </div>
                                    <Button
                                        size="sm"
                                        className="h-7 gap-1.5 text-xs"
                                        onClick={runAiCommandRequest}
                                        disabled={aiCommandLoading}
                                    >
                                        {aiCommandLoading ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Send className="h-3.5 w-3.5" />
                                        )}
                                        {aiCommandLoading ? "Working..." : "Run"}
                                    </Button>
                                </div>
                                <div className="flex items-center gap-2 text-[9.5px] text-muted-foreground/60">
                                    <Kbd className="h-4 px-1 text-[9px]">⌘</Kbd>
                                    <span>+</span>
                                    <Kbd className="h-4 px-1 text-[9px]">Enter</Kbd>
                                    <span>to run</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                {aiAutocompleteEnabled && aiInlineSuggestions && !disabled && inlineHintVisible && (
                    <div className="pointer-events-none absolute right-3 bottom-3 z-20 transition-opacity duration-200">
                        <div className="inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-background/70 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur-md">
                            <Kbd className="h-4 px-1 text-[9px]">Tab</Kbd>
                            <span>accept</span>
                            <span className="text-muted-foreground/50">•</span>
                            <Kbd className="h-4 px-1 text-[9px]">Alt</Kbd>
                            <span className="text-muted-foreground/50">+</span>
                            <Kbd className="h-4 px-1 text-[9px]">→</Kbd>
                            <span>word</span>
                            <span className="text-muted-foreground/50">•</span>
                            <Kbd className="h-4 px-1 text-[9px]">Alt</Kbd>
                            <span className="text-muted-foreground/50">+</span>
                            <Kbd className="h-4 px-1 text-[9px]">↓</Kbd>
                            <span>line</span>
                        </div>
                    </div>
                )}
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
                            {aiError && (
                                <span
                                    className="rounded-full bg-red-500/15 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-red-400"
                                    title={aiError.message}
                                >
                                    AI error
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

            <Dialog
                open={aiDiffOpen}
                onOpenChange={(open) => {
                    setAiDiffOpen(open);
                    if (!open) setAiDiffMode("diff");
                }}
            >
                <DialogContent className="max-w-5xl w-[88vw] max-h-[82vh] flex flex-col gap-2.5">
                    <DialogHeader>
                        <DialogTitle className="flex items-center justify-between text-sm">
                            <span>AI Suggested Changes</span>
                            {aiDiffModel && (
                                <span className="text-[10px] font-mono text-muted-foreground/60">
                                    {aiDiffModel}
                                </span>
                            )}
                        </DialogTitle>
                    </DialogHeader>
                    {aiDiffMode === "edit" && (
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-2">
                            <Textarea
                                value={aiDiffModified}
                                onChange={(e) => setAiDiffModified(e.target.value)}
                                rows={6}
                                className="resize-none text-xs font-mono bg-background/60 border-border/40 leading-relaxed"
                            />
                        </div>
                    )}
                    <div className="flex-1 rounded-lg overflow-hidden border border-border/40">
                        <DiffEditor
                            original={aiDiffOriginal}
                            modified={aiDiffModified}
                            language="sql"
                            theme={monacoTheme}
                            height="100%"
                            options={{
                                readOnly: true,
                                renderSideBySide: true,
                                minimap: { enabled: false },
                                renderOverviewRuler: false,
                                scrollBeyondLastLine: false,
                                renderLineHighlight: "none",
                                fontSize: editorFontSize,
                                fontFamily: "var(--font-mono), 'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
                            }}
                        />
                    </div>
                    <DialogFooter className="flex items-center justify-between">
                        <div className="text-[10px] text-muted-foreground/70">
                            {aiDiffIsFullFile ? "Applying to full file" : "Applying to selection"}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setAiDiffMode(aiDiffMode === "edit" ? "diff" : "edit")}
                            >
                                {aiDiffMode === "edit" ? "Preview" : "Edit"}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setAiDiffOpen(false)}>
                                Reject
                            </Button>
                            <Button size="sm" onClick={acceptAiDiff}>
                                Accept
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
