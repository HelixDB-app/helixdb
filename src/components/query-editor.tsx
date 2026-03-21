"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryStore } from "@/stores/query-store";
import type { QueryHistoryEntry, QueryTab } from "@/stores/query-store";
import { useSandboxStore } from "@/stores/sandbox-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useNotesStore } from "@/stores/notes-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useQueryFilesStore } from "@/stores/query-files-store";
import { useIdeFsStore } from "@/stores/ide-fs-store";
import { useSchemaDocGenStore } from "@/stores/schema-doc-gen-store";
import { useCollaborationStore, getCollaborationPermissions } from "@/stores/collaboration-store";
import { useShallow } from "zustand/react/shallow";
import { formatCellValue } from "@/lib/types";
import type { QueryResult } from "@/lib/types";
import { dbGetColumns, dbExplainQuery, dbExecuteQuery, dbGetDocumentationContext } from "@/lib/tauri";
import type { SandboxExecuteResult } from "@/lib/tauri";
import { NotesPanel } from "@/components/notes-panel";
import { QueryPlanViewer } from "@/components/query-plan-viewer";
import { SandboxDiffViewer } from "@/components/sandbox-diff-viewer";
import { DataCanvas } from "@/components/data-canvas";
import { ConnectionEnvBadge } from "@/components/connection-env-badge";
import { QueryResultView } from "@/components/query-result-view";
import { QueryReviewPanel } from "@/components/query-review-panel";
import { formatHelixSql } from "@/lib/format-sql";
import { MonacoSqlEditor } from "@/components/monaco-sql-editor";
import { DocumentBlockEditor } from "@/components/document-block-editor";
import { AIChatPanel } from "@/components/ai-chat-panel";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import { explainSql } from "@/lib/sql-explain-ai";
import { getSqlReviewIntent, runSqlSafetyReview, type SqlReviewReport } from "@/lib/sql-review";
import { isDocFileName } from "@/lib/doc-editor";
import { isEditableTarget } from "@/lib/shortcut-keys";
import {
    formatEnvironmentLabel,
    normalizeConnectionEnvironment,
} from "@/lib/connection-metadata";
import {
    STRICT_PRODUCTION_CONFIRMATION,
    shouldRequireProductionGuard,
    type SqlRiskClassification,
} from "@/lib/sql-risk-guard";
import { QueryErrorPanel } from "@/components/query-error-panel";
import { QueryTabBar } from "@/components/query-tab-bar";
import { QueryToolbar } from "@/components/query-toolbar";
import {
    QuerySidebar,
    QueryActivityBar,
    type QueryLoadSqlOptions,
    type SidebarPanel,
} from "@/components/query-sidebar";
import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useDefaultLayout } from "react-resizable-panels";
import {
    AlertCircle,
    Braces,
    ChevronDown,
    CheckCircle2,
    Clock,
    Copy,
    Database,
    Download,
    FileText,
    GitBranch,
    LayoutDashboard,
    Loader2,
    Minimize2,
    Play,
    Shield,
    ShieldCheck,
    StickyNote,
    Sparkles,
    Terminal,
    Users,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import dynamic from "next/dynamic";

const GitPanel = dynamic(() => import("@/components/git-panel").then((m) => ({ default: m.GitPanel })), { ssr: false });

// ── Helpers ─────────────────────────────────────────────────────────────────

function isCommandResult(result: QueryResult): boolean {
    return (
        result.columns.length === 1 &&
        result.columns[0].name === "affected_rows" &&
        result.rows.length === 1
    );
}

function isMultiStatementResult(result: QueryResult): boolean {
    return (
        result.columns.length === 1 &&
        result.columns[0].name === "statements" &&
        result.rows.length === 1
    );
}

function getDisplayCount(result: QueryResult): number {
    if (isCommandResult(result) || isMultiStatementResult(result)) {
        const cell = result.rows[0]?.[0];
        if (cell && "value" in cell && typeof cell.value === "number") return cell.value;
    }
    return result.row_count;
}

function getRowCountLabel(result: QueryResult): string {
    const n = getDisplayCount(result);
    if (isMultiStatementResult(result)) {
        return n === 1 ? "1 statement executed" : `${n} statements executed`;
    }
    const affected = isCommandResult(result);
    if (n === 1) return affected ? "1 row affected" : "1 row returned";
    return affected ? `${n.toLocaleString()} rows affected` : `${n.toLocaleString()} rows returned`;
}

function exportResultToCSV(result: QueryResult): string {
    const escapeCSV = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = result.columns.map((c) => escapeCSV(c.name)).join(",");
    const body = result.rows
        .map((row) => row.map((cell) => (cell.type === "Null" ? "" : escapeCSV(formatCellValue(cell)))).join(","))
        .join("\n");
    return header + "\n" + body;
}

function exportResultToJSON(result: QueryResult): string {
    const rows = result.rows.map((row) =>
        Object.fromEntries(
            result.columns.map((col, i) => {
                const cell = row[i] ?? { type: "Null" as const };
                if (cell.type === "Null") return [col.name, null];
                if (["Bool", "Int16", "Int32", "Int64", "Float32", "Float64"].includes(cell.type))
                    return [col.name, cell.value];
                if (cell.type === "Json") return [col.name, cell.value];
                return [col.name, formatCellValue(cell)];
            })
        )
    );
    return JSON.stringify(rows, null, 2);
}

function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function normalizeSqlForCompare(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parse a single table from simple SELECT ... FROM table/schema.table. Returns undefined if not detectable. */
function parseSingleTableFromSql(sql: string): { schema: string; table: string } | undefined {
    const trimmed = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const fromMatch = trimmed.match(/\bfrom\s+([\s\S]+?)(?=\s+(?:where|group|order|limit|offset|$))/i);
    if (!fromMatch) return undefined;
    const firstToken = fromMatch[1].trim().split(/\s/)[0]?.replace(/;+$/, "") ?? "";
    if (!firstToken) return undefined;
    const quoted = firstToken.match(/^"([^"]*)"\s*\.\s*"([^"]*)"$/);
    if (quoted) return { schema: quoted[1] || "public", table: quoted[2] };
    const dotted = firstToken.match(/^(\w+)\.(\w+)$/);
    if (dotted) return { schema: dotted[1], table: dotted[2] };
    if (/^\w+$/.test(firstToken)) return { schema: "public", table: firstToken };
    return undefined;
}

function getReviewIssueCounts(report: SqlReviewReport) {
    return report.issues.reduce(
        (acc, issue) => {
            if (issue.severity === "block") acc.block += 1;
            if (issue.severity === "warn") acc.warn += 1;
            if (issue.severity === "info") acc.info += 1;
            return acc;
        },
        { block: 0, warn: 0, info: 0 }
    );
}

function columnCacheKey(schema: string, table: string): string {
    return `${schema}.${table}`.toLowerCase();
}

function getCachedColumns(cache: Record<string, string[]>, schema: string, table: string): string[] {
    const scoped = cache[columnCacheKey(schema, table)];
    if (scoped) return scoped;
    return cache[table.toLowerCase()] ?? [];
}

// ── Cursor/Selection helpers ───────────────────────────────────────────────

type CursorSelection = {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
};

type CursorPayload = {
    lineNumber: number;
    column: number;
    selection?: CursorSelection | null;
};

function clamp(num: number, min: number, max: number): number {
    return Math.min(Math.max(num, min), max);
}

function normalizeSelection(selection: CursorSelection): CursorSelection {
    const isReversed =
        selection.startLineNumber > selection.endLineNumber ||
        (selection.startLineNumber === selection.endLineNumber && selection.startColumn > selection.endColumn);
    if (!isReversed) return selection;
    return {
        startLineNumber: selection.endLineNumber,
        startColumn: selection.endColumn,
        endLineNumber: selection.startLineNumber,
        endColumn: selection.startColumn,
    };
}

function getOffsetFromPosition(text: string, lineNumber: number, column: number): number {
    const lines = text.split("\n");
    if (lines.length === 0) return 0;
    const safeLine = clamp(lineNumber, 1, lines.length);
    let offset = 0;
    for (let i = 0; i < safeLine - 1; i += 1) {
        offset += lines[i].length + 1;
    }
    const lineText = lines[safeLine - 1] ?? "";
    const safeColumn = clamp(column, 1, lineText.length + 1);
    return offset + safeColumn - 1;
}

function getTextFromSelection(text: string, selection: CursorSelection): string {
    const normalized = normalizeSelection(selection);
    const start = getOffsetFromPosition(text, normalized.startLineNumber, normalized.startColumn);
    const end = getOffsetFromPosition(text, normalized.endLineNumber, normalized.endColumn);
    if (end <= start) return "";
    return text.slice(start, end);
}

function findStatementRanges(sql: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let start = 0;
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inLine = false;
    let inBlock = false;
    let dollarTag: string | null = null;

    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (inLine) {
            if (ch === "\n") inLine = false;
            i += 1;
            continue;
        }
        if (inBlock) {
            if (ch === "*" && next === "/") {
                inBlock = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (dollarTag) {
            if (ch === "$" && sql.startsWith(dollarTag, i)) {
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            i += 1;
            continue;
        }
        if (inSingle) {
            if (ch === "'" && next === "'") {
                i += 2;
                continue;
            }
            if (ch === "'") {
                inSingle = false;
            }
            i += 1;
            continue;
        }
        if (inDouble) {
            if (ch === "\"") inDouble = false;
            i += 1;
            continue;
        }

        if (ch === "-" && next === "-") {
            inLine = true;
            i += 2;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            i += 1;
            continue;
        }
        if (ch === "\"") {
            inDouble = true;
            i += 1;
            continue;
        }
        if (ch === "$") {
            const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
            if (match) {
                dollarTag = match[0];
                i += dollarTag.length;
                continue;
            }
        }
        if (ch === ";") {
            ranges.push({ start, end: i });
            start = i + 1;
            i += 1;
            continue;
        }
        i += 1;
    }

    if (start < sql.length) {
        ranges.push({ start, end: sql.length });
    }
    return ranges;
}

function getLineNumberAtOffset(text: string, offset: number): number {
    let line = 1;
    const limit = Math.min(offset, text.length);
    for (let i = 0; i < limit; i += 1) {
        if (text[i] === "\n") line += 1;
    }
    return line;
}

function getStatementAtOffset(sql: string, offset: number): { text: string; startOffset: number; endOffset: number } | null {
    const ranges = findStatementRanges(sql);
    const candidate = ranges.find((r) => offset >= r.start && offset <= r.end)
        ?? [...ranges].reverse().find((r) => sql.slice(r.start, r.end).trim().length > 0);
    if (!candidate) return null;

    let start = candidate.start;
    let end = candidate.end;
    while (start < end && /\s/.test(sql[start])) start += 1;
    while (end > start && /\s/.test(sql[end - 1])) end -= 1;
    const text = sql.slice(start, end).trim();
    if (!text) return null;
    return { text, startOffset: start, endOffset: end };
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingProductionGuardExecution {
    connectionId: string;
    tabId: string;
    sqlSnapshot: string;
    mode: "direct" | "sandbox";
    reviewAudit?: QueryHistoryEntry["aiReview"];
    classification: SqlRiskClassification;
}

interface EditorGroup {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
}

interface LiveResultMeta {
    updatedByName: string;
    updatedAt: number;
    truncated: boolean;
    previewRows: number;
}

type SplitDropPlacement = "left" | "center" | "right";

function dedupeIds(ids: string[]): string[] {
    return Array.from(new Set(ids));
}

function getDraggedFileNodeId(dataTransfer: DataTransfer): string | null {
    const raw = dataTransfer.getData("application/x-helix-file-node");
    return raw || null;
}

function getCollaborationDocKey(tabId: string, tabFileMap: Record<string, string>): string {
    const fileId = tabFileMap[tabId];
    if (fileId) return `file:${fileId}`;
    return "scratch:shared";
}

// ── Main component ───────────────────────────────────────────────────────────

export function QueryEditor() {
    const {
        connectionId,
        databaseName,
        tables,
        selectedSchema,
        schemaFunctions,
        connections,
        activeConnectionId,
        databases,
        switchDatabase,
        schemas,
        selectSchema,
    } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            databaseName: state.databaseName,
            tables: state.tables,
            selectedSchema: state.selectedSchema,
            schemaFunctions: state.schemaFunctions,
            connections: state.connections,
            activeConnectionId: state.activeConnectionId,
            databases: state.databases,
            switchDatabase: state.switchDatabase,
            schemas: state.schemas,
            selectSchema: state.selectSchema,
        }))
    );

    const {
        aiReviewEnabled,
        aiReviewAutoOnDml,
        aiReviewUseGemini,
        aiReviewModel,
        aiReviewComplexLineThreshold,
        geminiApiKey,
        strictProductionGuard,
    } = useSettingsStore();

    const {
        tabs,
        activeTabId,
        addTab,
        removeTab,
        setActiveTab,
        updateSql,
        setTabResult,
        executeQuery,
        history,
        clearHistory,
        deleteHistoryEntry,
        loadHistoryFromStorage,
    } = useQueryStore();

    const { updateFile, queryFiles } = useQueryFilesStore(
        useShallow((state) => ({
            updateFile: state.updateFile,
            queryFiles: state.files,
        }))
    );
    const ideNodes = useIdeFsStore((state) => state.nodes);
    const {
        status: collaborationStatus,
        roomId: collaborationRoomId,
        localAccessLevel,
        localUserId: collaborationLocalUserId,
        docs: collaborationDocs,
        remoteCursorsByDoc,
        setConnectionContext: setCollaborationConnectionContext,
        setActiveDocKey,
        publishCursor,
        publishDocument,
        queryResults: collaborationQueryResults,
        publishQueryResult,
    } = useCollaborationStore(
        useShallow((state) => ({
            status: state.status,
            roomId: state.roomId,
            localAccessLevel: state.localAccessLevel,
            localUserId: state.localUserId,
            docs: state.docs,
            remoteCursorsByDoc: state.remoteCursorsByDoc,
            setConnectionContext: state.setConnectionContext,
            setActiveDocKey: state.setActiveDocKey,
            publishCursor: state.publishCursor,
            publishDocument: state.publishDocument,
            queryResults: state.queryResults,
            publishQueryResult: state.publishQueryResult,
        }))
    );
    const collaborationPermissions = useMemo(
        () => getCollaborationPermissions(localAccessLevel),
        [localAccessLevel]
    );

    // ── Sandbox ────────────────────────────────────────────────────────────
    const {
        status: sandboxStatus,
        result: sandboxResult,
        anomalyWarning,
        elapsedSecs: sandboxElapsed,
        pendingSql: sandboxPendingSql,
        error: sandboxError,
        enableSandbox,
        disableSandbox,
        runInSandbox,
        commitSandbox,
        rollbackSandbox,
        loadHistory: loadSandboxHistory,
        tickElapsed,
    } = useSandboxStore();

    const isSandboxMode = sandboxStatus !== "off";
    const isSandboxReviewing = sandboxStatus === "reviewing";
    const isSandboxCommitting = sandboxStatus === "committing";
    const isSandboxRollingBack = sandboxStatus === "rolling_back";
    const isSandboxBusy = sandboxStatus === "executing" || isSandboxCommitting || isSandboxRollingBack;

    useEffect(() => {
        if (!isSandboxMode) return;
        const interval = setInterval(tickElapsed, 5000);
        return () => clearInterval(interval);
    }, [isSandboxMode, tickElapsed]);

    useEffect(() => {
        if (sandboxElapsed > 600 && isSandboxReviewing) {
            toast.warning("Sandbox transaction has been open for over 10 minutes — remember to commit or rollback.", {
                id: "sandbox-idle",
                duration: 10000,
            });
        }
    }, [sandboxElapsed, isSandboxReviewing]);

    useEffect(() => {
        if (sandboxError) toast.error(sandboxError, { duration: 5000 });
    }, [sandboxError]);

    useEffect(() => { loadSandboxHistory(); }, [loadSandboxHistory]);
    useEffect(() => {
        setCollaborationConnectionContext(connectionId ?? null);
    }, [connectionId, setCollaborationConnectionContext]);

    // ── Notes ──────────────────────────────────────────────────────────────
    const { saveNote: storeNoteSave } = useNotesStore();

    // ── UI state ───────────────────────────────────────────────────────────
    const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel | null>("files");
    type RightPanelView = "ai" | "collaboration" | "notes";
    const [rightPanelView, setRightPanelView] = useState<RightPanelView | null>(null);
    const [saveNoteOpen, setSaveNoteOpen] = useState(false);
    const [saveNoteTitle, setSaveNoteTitle] = useState("");
    const [saveNoteLoading, setSaveNoteLoading] = useState(false);
    const [editorFullScreen, setEditorFullScreen] = useState(false);
    const [runSqlFileOpen, setRunSqlFileOpen] = useState(false);
    const runSqlFileInputRef = useRef<HTMLInputElement>(null);
    const toggleRightPanel = useCallback((view: RightPanelView) => {
        setRightPanelView((current) => (current === view ? null : view));
    }, []);
    const openRightPanel = useCallback((view: RightPanelView) => {
        setRightPanelView(view);
    }, []);

    // Editor split groups (VS Code-style groups within the query editor area)
    const editorGroupCounterRef = useRef(1);
    const [editorGroups, setEditorGroups] = useState<EditorGroup[]>([
        { id: "group-1", tabIds: [], activeTabId: null },
    ]);
    const [activeEditorGroupId, setActiveEditorGroupId] = useState("group-1");
    const [fileDropTarget, setFileDropTarget] = useState<{
        groupId: string;
        placement: SplitDropPlacement;
    } | null>(null);

    // Tab → file mapping for unsaved indicator
    const [tabFileMap, setTabFileMap] = useState<Record<string, string>>({});
    // Ref always holds latest tabFileMap to avoid stale closures in Monaco onChange
    const tabFileMapRef = useRef(tabFileMap);
    const suppressCollabPublishRef = useRef<Record<string, string>>({});
    const appliedRemoteDocVersionRef = useRef<Record<string, number>>({});
    const tabExecutionStateRef = useRef<Record<string, boolean>>({});
    const appliedRemoteResultAtRef = useRef<Record<string, number>>({});
    const schemaDocGenRef = useRef<{ updateSql: (tabId: string, sql: string) => void; tabFileMap: Record<string, string> }>({
        updateSql: () => {},
        tabFileMap: {},
    });
    const [liveResultMetaByTab, setLiveResultMetaByTab] = useState<Record<string, LiveResultMeta>>({});
    const cursorByTabRef = useRef<Record<string, CursorPayload>>({});
    const aiContextHandlerRef = useRef<(() => void) | null>(null);
    const pendingAiContextAddRef = useRef(false);
    useEffect(() => { tabFileMapRef.current = tabFileMap; }, [tabFileMap]);
    useEffect(() => {
        schemaDocGenRef.current.updateSql = updateSql;
        schemaDocGenRef.current.tabFileMap = tabFileMap;
    }, [updateSql, tabFileMap]);
    useEffect(() => {
        useSchemaDocGenStore.getState().setOnSchemaDocFileUpdated((fileId, content) => {
            const { updateSql: updateSqlFn, tabFileMap: map } = schemaDocGenRef.current;
            const tabId = Object.entries(map).find(([, id]) => id === fileId)?.[0];
            if (tabId) updateSqlFn(tabId, content);
        });
        return () => useSchemaDocGenStore.getState().setOnSchemaDocFileUpdated(null);
    }, []);

    // ── Review state ───────────────────────────────────────────────────────
    const [reviewReport, setReviewReport] = useState<SqlReviewReport | null>(null);
    const [reviewLoading, setReviewLoading] = useState(false);
    const [reviewPendingApproval, setReviewPendingApproval] = useState<{
        sql: string;
        mode: "direct" | "sandbox";
        trigger: "auto" | "manual";
    } | null>(null);

    // ── Prod guard ─────────────────────────────────────────────────────────
    const [prodGuardPending, setProdGuardPending] = useState<PendingProductionGuardExecution | null>(null);
    const [prodGuardTypedText, setProdGuardTypedText] = useState("");
    const [prodGuardReason, setProdGuardReason] = useState("");

    // ── Plan/result view per tab ───────────────────────────────────────────
    const [planData, setPlanData] = useState<Record<string, string>>({});
    const [planLoading, setPlanLoading] = useState<Record<string, boolean>>({});
    const [resultView, setResultView] = useState<Record<string, "results" | "plan" | "canvas">>({});

    const activePlan = activeTabId ? planData[activeTabId] : undefined;
    const isExplaining = activeTabId ? (planLoading[activeTabId] ?? false) : false;
    const activeResultView = activeTabId ? (resultView[activeTabId] ?? "results") : "results";

    // ── Column cache ───────────────────────────────────────────────────────
    const [columnCache, setColumnCache] = useState<Record<string, string[]>>({});
    const columnCacheRef = useRef<Record<string, string[]>>({});
    const pendingColumnLoadsRef = useRef<Record<string, Promise<string[]>>>({});

    useEffect(() => { columnCacheRef.current = columnCache; }, [columnCache]);
    useEffect(() => {
        setColumnCache({});
        columnCacheRef.current = {};
        pendingColumnLoadsRef.current = {};
    }, [connectionId]);

    // ── Derived ────────────────────────────────────────────────────────────
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

    const activeEditorGroup = useMemo(
        () => editorGroups.find((group) => group.id === activeEditorGroupId) ?? editorGroups[0] ?? null,
        [editorGroups, activeEditorGroupId]
    );
    const activeConnectionEntry = useMemo(
        () => connections.find((entry) => entry.connectionId === activeConnectionId) ?? null,
        [connections, activeConnectionId]
    );
    const activeEnvironment = normalizeConnectionEnvironment(activeConnectionEntry?.environment);

    const tablesByPriority = useMemo(() => {
        if (!selectedSchema) return tables;
        return [
            ...tables.filter((t) => t.schema === selectedSchema),
            ...tables.filter((t) => t.schema !== selectedSchema),
        ];
    }, [tables, selectedSchema]);

    const schemaContext = useMemo(
        () => ({
            tables: tablesByPriority.map((t) => t.name),
            columns: tablesByPriority.reduce<Record<string, string[]>>((acc, table) => {
                const tableName = table.name.toLowerCase();
                if (acc[tableName]) return acc;
                acc[tableName] = getCachedColumns(columnCache, table.schema, table.name);
                return acc;
            }, {}),
        }),
        [tablesByPriority, columnCache]
    );

    const tableRowCounts = useMemo(() => {
        const out: Record<string, number> = {};
        for (const table of tables) out[table.name.toLowerCase()] = table.row_count ?? 0;
        return out;
    }, [tables]);

    const tableColumnsForReview = useMemo(() => {
        const out: Record<string, string[]> = {};
        for (const table of tables) {
            const cols = getCachedColumns(columnCache, table.schema, table.name);
            const tableName = table.name.toLowerCase();
            if (!out[tableName] || table.schema === selectedSchema) out[tableName] = cols.map((c) => c.toLowerCase());
        }
        return out;
    }, [tables, columnCache, selectedSchema]);

    const reviewIsStale = useMemo(() => {
        if (!reviewReport || !activeTab?.sql) return false;
        return normalizeSqlForCompare(reviewReport.sql) !== normalizeSqlForCompare(activeTab.sql);
    }, [reviewReport, activeTab?.sql]);

    const getActiveCursorContext = useCallback((): { text: string; kind: "selection" | "statement" | "full"; range?: { startLine: number; endLine: number } } | null => {
        if (!activeTabId) return null;
        const tab = tabsById.get(activeTabId);
        if (!tab) return null;
        const cursor = cursorByTabRef.current[activeTabId];
        if (cursor?.selection) {
            const normalized = normalizeSelection(cursor.selection);
            const selectedText = getTextFromSelection(tab.sql, normalized);
            if (selectedText.trim()) {
                return {
                    text: selectedText,
                    kind: "selection" as const,
                    range: {
                        startLine: normalized.startLineNumber,
                        endLine: normalized.endLineNumber,
                    },
                };
            }
        }
        if (cursor) {
            const offset = getOffsetFromPosition(tab.sql, cursor.lineNumber, cursor.column);
            const statement = getStatementAtOffset(tab.sql, offset);
            if (statement?.text?.trim()) {
                return {
                    text: statement.text,
                    kind: "statement" as const,
                    range: {
                        startLine: getLineNumberAtOffset(tab.sql, statement.startOffset),
                        endLine: getLineNumberAtOffset(tab.sql, statement.endOffset),
                    },
                };
            }
        }
        return {
            text: tab.sql,
            kind: "full" as const,
            range: {
                startLine: 1,
                endLine: Math.max(1, tab.sql.split("\n").length),
            },
        };
    }, [activeTabId, tabsById]);

    const registerAiContextHandler = useCallback((handler: (() => void) | null) => {
        aiContextHandlerRef.current = handler;
        if (handler && pendingAiContextAddRef.current) {
            pendingAiContextAddRef.current = false;
            handler();
        }
    }, []);

    const triggerAiContextAdd = useCallback((tabId: string, payload: CursorPayload) => {
        cursorByTabRef.current[tabId] = payload;
        openRightPanel("ai");
        const handler = aiContextHandlerRef.current;
        if (handler) {
            handler();
            return;
        }
        pendingAiContextAddRef.current = true;
    }, [openRightPanel]);

    const schemaContextForAi = useMemo(() => {
        const schema = selectedSchema ?? "public";
        const tableLines = tables
            .filter((t) => t.schema === schema)
            .map((t) => `  ${t.schema}.${t.name}: ${getCachedColumns(columnCache, t.schema, t.name).join(", ") || "(columns not loaded)"}`);
        const funcs = schemaFunctions[schema] ?? [];
        const funcLines = funcs
            .filter((f) => !f.is_trigger_function)
            .map((f) => `  ${f.name}(${f.arguments}) -> ${f.return_type}`);
        return ["Tables:", ...tableLines, "", "Functions:", ...(funcLines.length ? funcLines : ["  (none listed)"])].join("\n");
    }, [tables, columnCache, selectedSchema, schemaFunctions]);

    const docAiAssistStats = useMemo(() => {
        if (!connectionId) return { tableCount: 0, fileCount: 0, docCount: 0 };
        const files = Object.values(ideNodes).filter(
            (node) => node.connectionId === connectionId && node.type === "file"
        );
        const docCount = files.filter((node) => {
            const lower = node.name.toLowerCase();
            return isDocFileName(node.name) || lower.endsWith(".md") || lower.endsWith(".markdown");
        }).length;
        return {
            tableCount: tables.length,
            fileCount: files.length,
            docCount,
        };
    }, [connectionId, ideNodes, tables.length]);

    const getDocAiAssistContext = useCallback(
        async ({ content, title }: { content: string; title?: string | null }) => {
            const fileEntries = connectionId
                ? useIdeFsStore.getState().getAllFileEntries(connectionId)
                : [];
            let schemaContext = null;
            let schemaError: string | null = null;
            if (connectionId) {
                try {
                    schemaContext = await dbGetDocumentationContext(connectionId, null);
                } catch (err) {
                    schemaError = String(err).replace(/^[a-z_]+:\\s*/i, "").trim() || "Failed to load schema context.";
                }
            }
            return {
                databaseName: databaseName ?? null,
                schemaContext,
                schemaError,
                fileEntries,
                activeDoc: {
                    path: title ?? null,
                    content,
                },
            };
        },
        [connectionId, databaseName]
    );

    const savedFileSqlMap = useMemo(
        () => Object.fromEntries(queryFiles.map((file) => [file.id, file.sql])),
        [queryFiles]
    );

    const fileNameById = useMemo(() => {
        const fileNameMap: Record<string, string> = {};
        for (const file of queryFiles) {
            fileNameMap[file.id] = file.name;
        }
        for (const node of Object.values(ideNodes)) {
            if (node.type === "file") {
                fileNameMap[node.id] = node.name;
            }
        }
        return fileNameMap;
    }, [queryFiles, ideNodes]);

    const getTabFileName = useCallback(
        (tabId: string): string | null => {
            const fileId = tabFileMap[tabId];
            if (fileId) return fileNameById[fileId] ?? null;
            return tabsById.get(tabId)?.title ?? null;
        },
        [tabFileMap, fileNameById, tabsById]
    );

    const isDocTab = useCallback((tabId: string): boolean => {
        return isDocFileName(getTabFileName(tabId));
    }, [getTabFileName]);

    const activeTabIsDoc = useMemo(
        () => (activeTabId ? isDocTab(activeTabId) : false),
        [activeTabId, isDocTab]
    );
    const queryEditorVerticalLayout = useDefaultLayout({
        id: "helix-query-editor-vsplit",
        panelIds: ["qe-editor", "qe-results"],
    });
    const isCollaborationReadOnly = collaborationStatus === "connected" && !collaborationPermissions.canEdit;

    const activeDocKey = useMemo(() => {
        if (!activeTabId) return null;
        return getCollaborationDocKey(activeTabId, tabFileMap);
    }, [activeTabId, tabFileMap]);

    const getCollaboratorsForTab = useCallback(
        (tabId: string) => {
            const docKey = getCollaborationDocKey(tabId, tabFileMapRef.current);
            return (remoteCursorsByDoc[docKey] ?? [])
                .filter((participant) => participant.id !== collaborationLocalUserId)
                .map((participant) => ({
                    id: participant.id,
                    name: participant.name,
                    initials: participant.initials,
                    colorIndex: participant.colorIndex,
                    color: `collab-${participant.colorIndex}`,
                    selection: participant.cursor?.selection ?? null,
                    lineNumber: participant.cursor?.lineNumber,
                    column: participant.cursor?.column,
                }));
        },
        [remoteCursorsByDoc, collaborationLocalUserId]
    );

    useEffect(() => {
        if (collaborationStatus !== "connected") return;
        void setActiveDocKey(activeDocKey);
    }, [collaborationStatus, activeDocKey, setActiveDocKey]);

    useEffect(() => {
        if (collaborationStatus === "connected") {
            setRightPanelView((current) => current ?? "collaboration");
        }
    }, [collaborationStatus]);

    useEffect(() => {
        if (collaborationStatus === "connected") return;
        appliedRemoteResultAtRef.current = {};
        setLiveResultMetaByTab({});
    }, [collaborationStatus]);

    useEffect(() => {
        if (collaborationStatus !== "connected" || !collaborationPermissions.canEdit) return;
        if (!activeTabId || !activeDocKey) return;
        const sql = tabsById.get(activeTabId)?.sql ?? "";
        void publishDocument(activeDocKey, sql);
    }, [
        collaborationStatus,
        collaborationPermissions.canEdit,
        activeTabId,
        activeDocKey,
        tabsById,
        publishDocument,
    ]);

    useEffect(() => {
        if (collaborationStatus !== "connected" || !activeTabId || !activeDocKey) return;
        const incoming = collaborationDocs[activeDocKey];
        if (!incoming || incoming.updatedBy === collaborationLocalUserId) return;
        const lastAppliedVersion = appliedRemoteDocVersionRef.current[activeDocKey] ?? 0;
        if (incoming.version <= lastAppliedVersion) return;

        const currentSql = tabsById.get(activeTabId)?.sql ?? "";
        if (currentSql !== incoming.content) {
            suppressCollabPublishRef.current[activeDocKey] = incoming.content;
            updateSql(activeTabId, incoming.content);
            const fileId = tabFileMapRef.current[activeTabId];
            if (fileId?.startsWith("fs-")) {
                useIdeFsStore.getState().updateContent(fileId, incoming.content);
            } else if (fileId) {
                updateFile(fileId, { sql: incoming.content });
            }
        }

        appliedRemoteDocVersionRef.current[activeDocKey] = incoming.version;
    }, [
        collaborationStatus,
        collaborationDocs,
        collaborationLocalUserId,
        activeDocKey,
        activeTabId,
        tabsById,
        updateSql,
        updateFile,
    ]);

    useEffect(() => {
        const knownTabIds = new Set(tabs.map((tab) => tab.id));
        const finishedTabIds: string[] = [];

        for (const tab of tabs) {
            const wasExecuting = tabExecutionStateRef.current[tab.id] ?? false;
            const justFinished = wasExecuting && !tab.isExecuting && Boolean(tab.result);
            if (isDocTab(tab.id)) {
                tabExecutionStateRef.current[tab.id] = tab.isExecuting;
                continue;
            }
            if (justFinished && tab.result) {
                finishedTabIds.push(tab.id);
                if (collaborationStatus === "connected" && collaborationPermissions.canEdit) {
                    const docKey = getCollaborationDocKey(tab.id, tabFileMapRef.current);
                    void publishQueryResult(docKey, tab.sql, tab.title, tab.result);
                }
            }
            tabExecutionStateRef.current[tab.id] = tab.isExecuting;
        }

        for (const tabId of Object.keys(tabExecutionStateRef.current)) {
            if (!knownTabIds.has(tabId)) {
                delete tabExecutionStateRef.current[tabId];
            }
        }
        for (const appliedKey of Object.keys(appliedRemoteResultAtRef.current)) {
            const parts = appliedKey.split("::");
            const tabId = parts[1];
            if (tabId && !knownTabIds.has(tabId)) {
                delete appliedRemoteResultAtRef.current[appliedKey];
            }
        }

        if (finishedTabIds.length > 0) {
            setLiveResultMetaByTab((prev) => {
                let changed = false;
                const next = { ...prev };
                for (const tabId of finishedTabIds) {
                    if (!next[tabId]) continue;
                    delete next[tabId];
                    changed = true;
                }
                return changed ? next : prev;
            });
        }
    }, [tabs, collaborationStatus, collaborationPermissions.canEdit, isDocTab, publishQueryResult]);

    useEffect(() => {
        if (collaborationStatus !== "connected") return;

        const updates: Array<{
            tabId: string;
            result: QueryResult;
            executionTimeMs: number;
            meta: LiveResultMeta;
        }> = [];
        const tabsToShowResults = new Set<string>();
        let activeDocToast: string | null = null;

        for (const [docKey, snapshot] of Object.entries(collaborationQueryResults)) {
            if (snapshot.updatedBy === collaborationLocalUserId) continue;

            const matchingTabs = tabs
                .filter((tab) => getCollaborationDocKey(tab.id, tabFileMapRef.current) === docKey && !isDocTab(tab.id))
                .map((tab) => tab.id);
            if (matchingTabs.length === 0) continue;

            let appliedForAnyTab = false;
            for (const tabId of matchingTabs) {
                const appliedKey = `${docKey}::${tabId}`;
                const lastApplied = appliedRemoteResultAtRef.current[appliedKey] ?? 0;
                if (snapshot.updatedAt <= lastApplied) continue;
                updates.push({
                    tabId,
                    result: snapshot.result,
                    executionTimeMs: snapshot.result.execution_time_ms,
                    meta: {
                        updatedByName: snapshot.updatedByName,
                        updatedAt: snapshot.updatedAt,
                        truncated: snapshot.truncated,
                        previewRows: snapshot.previewRows,
                    },
                });
                tabsToShowResults.add(tabId);
                appliedRemoteResultAtRef.current[appliedKey] = snapshot.updatedAt;
                appliedForAnyTab = true;
            }

            if (appliedForAnyTab && activeDocKey && activeDocKey === docKey) {
                activeDocToast = `${snapshot.updatedByName} ran query • ${getRowCountLabel(snapshot.result)}`;
            }
        }

        if (updates.length === 0) return;

        for (const update of updates) {
            setTabResult(update.tabId, update.result, update.executionTimeMs);
        }

        setResultView((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const tabId of tabsToShowResults) {
                if (next[tabId] === "results") continue;
                next[tabId] = "results";
                changed = true;
            }
            return changed ? next : prev;
        });

        setLiveResultMetaByTab((prev) => {
            const next = { ...prev };
            for (const update of updates) {
                next[update.tabId] = update.meta;
            }
            return next;
        });

        if (activeDocToast) {
            toast.success(activeDocToast, { duration: 2200 });
        }
    }, [
        collaborationStatus,
        collaborationQueryResults,
        collaborationLocalUserId,
        activeDocKey,
        isDocTab,
        tabs,
        setTabResult,
    ]);

    // ── Editor split groups ───────────────────────────────────────────────
    useEffect(() => {
        setEditorGroups((prev) => {
            const validTabIds = new Set(tabs.map((tab) => tab.id));
            let changed = false;

            let nextGroups = prev.map((group) => {
                const nextTabIds = group.tabIds.filter((id) => validTabIds.has(id));
                const nextActiveTabId =
                    group.activeTabId && nextTabIds.includes(group.activeTabId)
                        ? group.activeTabId
                        : (nextTabIds[nextTabIds.length - 1] ?? null);

                if (
                    nextTabIds.length !== group.tabIds.length ||
                    nextActiveTabId !== group.activeTabId
                ) {
                    changed = true;
                    return { ...group, tabIds: nextTabIds, activeTabId: nextActiveTabId };
                }
                return group;
            });

            if (nextGroups.length === 0) {
                nextGroups = [{ id: "group-1", tabIds: [], activeTabId: null }];
                changed = true;
            }

            const assigned = new Set(nextGroups.flatMap((group) => group.tabIds));
            const unassigned = tabs.map((tab) => tab.id).filter((id) => !assigned.has(id));
            if (unassigned.length > 0) {
                const targetIndex = Math.max(
                    0,
                    nextGroups.findIndex((group) => group.id === activeEditorGroupId)
                );
                const group = nextGroups[targetIndex] ?? nextGroups[0];
                if (group) {
                    const merged = dedupeIds([...group.tabIds, ...unassigned]);
                    if (
                        merged.length !== group.tabIds.length ||
                        !merged.every((id, idx) => id === group.tabIds[idx])
                    ) {
                        changed = true;
                    }
                    nextGroups = nextGroups.map((candidate, idx) =>
                        idx === targetIndex
                            ? {
                                ...candidate,
                                tabIds: merged,
                                activeTabId: candidate.activeTabId ?? merged[0] ?? null,
                            }
                            : candidate
                    );
                }
            }

            return changed ? nextGroups : prev;
        });
    }, [tabs, activeEditorGroupId]);

    useEffect(() => {
        if (editorGroups.some((group) => group.id === activeEditorGroupId)) return;
        if (editorGroups[0]) setActiveEditorGroupId(editorGroups[0].id);
    }, [editorGroups, activeEditorGroupId]);

    useEffect(() => {
        const focusedGroup = activeEditorGroup ?? null;
        const fallbackGroup = editorGroups.find((group) => group.tabIds.length > 0) ?? null;
        const nextActive =
            focusedGroup?.activeTabId ??
            focusedGroup?.tabIds[0] ??
            fallbackGroup?.activeTabId ??
            fallbackGroup?.tabIds[0] ??
            null;
        if (nextActive && nextActive !== activeTabId) setActiveTab(nextActive);
        if (
            focusedGroup &&
            focusedGroup.tabIds.length === 0 &&
            fallbackGroup &&
            fallbackGroup.id !== focusedGroup.id
        ) {
            setActiveEditorGroupId(fallbackGroup.id);
        }
    }, [activeEditorGroup, activeTabId, editorGroups, setActiveTab]);

    const focusEditorGroup = useCallback((groupId: string, tabId?: string | null) => {
        setActiveEditorGroupId(groupId);
        setEditorGroups((prev) =>
            prev.map((group) =>
                group.id === groupId && tabId && group.activeTabId !== tabId
                    ? { ...group, activeTabId: tabId }
                    : group
            )
        );
        const group = editorGroups.find((candidate) => candidate.id === groupId);
        const nextTabId = tabId ?? group?.activeTabId ?? group?.tabIds[0] ?? null;
        if (nextTabId) setActiveTab(nextTabId);
    }, [editorGroups, setActiveTab]);

    const openTabInGroup = useCallback((groupId: string, tabId: string, activate = true) => {
        setEditorGroups((prev) =>
            prev.map((group) =>
                group.id === groupId
                    ? {
                        ...group,
                        tabIds: group.tabIds.includes(tabId) ? group.tabIds : [...group.tabIds, tabId],
                        activeTabId: activate ? tabId : (group.activeTabId ?? tabId),
                    }
                    : group
            )
        );
        if (activate) {
            setActiveEditorGroupId(groupId);
            setActiveTab(tabId);
        }
    }, [setActiveTab]);

    const openTabInNewSplit = useCallback((
        anchorGroupId: string,
        tabId: string,
        placement: "left" | "right" = "right"
    ) => {
        const nextGroupId = `group-${++editorGroupCounterRef.current}`;
        setEditorGroups((prev) => {
            const anchorIndex = prev.findIndex((group) => group.id === anchorGroupId);
            const nextGroup: EditorGroup = { id: nextGroupId, tabIds: [tabId], activeTabId: tabId };
            if (anchorIndex === -1) return [...prev, nextGroup];
            const insertAt = placement === "left" ? anchorIndex : anchorIndex + 1;
            return [
                ...prev.slice(0, insertAt),
                nextGroup,
                ...prev.slice(insertAt),
            ];
        });
        setActiveEditorGroupId(nextGroupId);
        setActiveTab(tabId);
        return nextGroupId;
    }, [setActiveTab]);

    const closeEditorGroup = useCallback((groupId: string) => {
        let fallbackGroupId: string | null = null;
        let fallbackTabId: string | null = null;

        setEditorGroups((prev) => {
            if (prev.length <= 1) return prev;
            const groupIndex = prev.findIndex((group) => group.id === groupId);
            if (groupIndex === -1) return prev;

            const groupToClose = prev[groupIndex];
            const remaining = prev.filter((group) => group.id !== groupId);
            const mergeTargetIndex = groupIndex > 0 ? groupIndex - 1 : 0;
            const mergeTarget = remaining[mergeTargetIndex];
            if (!mergeTarget) return remaining;

            const mergedTabIds = dedupeIds([...mergeTarget.tabIds, ...groupToClose.tabIds]);
            const mergedActiveTabId =
                mergeTarget.activeTabId ?? groupToClose.activeTabId ?? mergedTabIds[0] ?? null;

            fallbackGroupId = mergeTarget.id;
            fallbackTabId = mergedActiveTabId;

            return remaining.map((group, idx) =>
                idx === mergeTargetIndex
                    ? { ...group, tabIds: mergedTabIds, activeTabId: mergedActiveTabId }
                    : group
            );
        });

        if (activeEditorGroupId === groupId && fallbackGroupId) {
            setActiveEditorGroupId(fallbackGroupId);
            if (fallbackTabId) setActiveTab(fallbackTabId);
        }
    }, [activeEditorGroupId, setActiveTab]);

    const handleSelectGroupTab = useCallback((groupId: string, tabId: string) => {
        setEditorGroups((prev) =>
            prev.map((group) =>
                group.id === groupId ? { ...group, activeTabId: tabId } : group
            )
        );
        setActiveEditorGroupId(groupId);
        setActiveTab(tabId);
    }, [setActiveTab]);

    const handleCloseGroupTab = useCallback((groupId: string, tabId: string) => {
        let removeFromStore = false;
        let nextGroupActiveTab: string | null = null;

        setEditorGroups((prev) => {
            const tabGroupCount = prev.reduce(
                (count, group) => count + (group.tabIds.includes(tabId) ? 1 : 0),
                0
            );
            removeFromStore = tabGroupCount <= 1;

            return prev.map((group) => {
                if (group.id !== groupId) return group;
                const remainingTabIds = group.tabIds.filter((id) => id !== tabId);
                const nextActive =
                    group.activeTabId === tabId
                        ? (remainingTabIds[remainingTabIds.length - 1] ?? null)
                        : group.activeTabId;
                nextGroupActiveTab = nextActive;
                return { ...group, tabIds: remainingTabIds, activeTabId: nextActive };
            });
        });

        if (removeFromStore) {
            removeTab(tabId);
            setTabFileMap((prev) => {
                if (!prev[tabId]) return prev;
                const next = { ...prev };
                delete next[tabId];
                return next;
            });
            return;
        }

        if (
            activeEditorGroupId === groupId &&
            activeTabId === tabId &&
            nextGroupActiveTab
        ) {
            setActiveTab(nextGroupActiveTab);
        }
    }, [activeEditorGroupId, activeTabId, removeTab, setActiveTab]);

    const handleNewTabInGroup = useCallback((groupId: string) => {
        const nextTabId = addTab();
        openTabInGroup(groupId, nextTabId, true);
    }, [addTab, openTabInGroup]);

    // ── Column fetching ────────────────────────────────────────────────────
    const handleFetchColumns = useCallback(
        async (tableName: string): Promise<string[]> => {
            if (!connectionId) return [];
            const normalized = tableName.toLowerCase();
            const tableInfo =
                tables.find((t) => t.name.toLowerCase() === normalized && (!selectedSchema || t.schema === selectedSchema)) ??
                tables.find((t) => t.name.toLowerCase() === normalized);
            if (!tableInfo) return [];
            const cacheKey = columnCacheKey(tableInfo.schema, tableInfo.name);
            const cached = getCachedColumns(columnCacheRef.current, tableInfo.schema, tableInfo.name);
            if (cached.length > 0) return cached;
            const requestKey = `${connectionId}:${cacheKey}`;
            const existingRequest = pendingColumnLoadsRef.current[requestKey];
            if (existingRequest) return existingRequest;
            try {
                const request = dbGetColumns(connectionId, tableInfo.schema, tableInfo.name).then((cols) => {
                    if (useConnectionStore.getState().connectionId !== connectionId) return [];
                    const colNames = cols.map((c) => c.name);
                    setColumnCache((prev) => {
                        const next = { ...prev, [cacheKey]: colNames };
                        const unscoped = tableInfo.name.toLowerCase();
                        if (!prev[unscoped] || tableInfo.schema === selectedSchema) next[unscoped] = colNames;
                        return next;
                    });
                    return colNames;
                });
                pendingColumnLoadsRef.current[requestKey] = request;
                return await request;
            } catch {
                return [];
            } finally {
                delete pendingColumnLoadsRef.current[`${connectionId}:${cacheKey}`];
            }
        },
        [connectionId, selectedSchema, tables]
    );

    // ── Format ─────────────────────────────────────────────────────────────
    const handleFormatSql = useCallback(
        (sql: string) => {
            if (!activeTabId) return;
            if (isDocTab(activeTabId)) {
                toast.info("Formatting is only available for SQL tabs.");
                return;
            }
            try {
                const formatted = formatHelixSql(sql);
                updateSql(activeTabId, formatted);
                toast.success("SQL formatted", { duration: 1200 });
            } catch {
                toast.error("Could not format SQL", { duration: 1500 });
            }
        },
        [activeTabId, isDocTab, updateSql]
    );

    // ── Next action ────────────────────────────────────────────────────────
    const handleNextAction = useCallback(
        async (action: string) => {
            if (!activeTabId) return;
            if (isDocTab(activeTabId)) {
                toast.info("AI SQL suggestions are only available for SQL tabs.");
                return;
            }
            const currentSql = activeTab?.sql ?? "";
            toast.loading("Nova is applying suggestion…", { id: "nova-action" });
            try {
                const prompt = currentSql
                    ? `Given this existing query:\n${currentSql}\n\nApply the following change and return the updated SQL:\n${action}`
                    : action;
                const newSql = await aiSuggestionEngine.getNaturalLanguageSQL(prompt, schemaContext);
                if (newSql) {
                    updateSql(activeTabId, newSql);
                    toast.success("Suggestion applied", { id: "nova-action", duration: 1500 });
                } else {
                    toast.dismiss("nova-action");
                }
            } catch {
                toast.error("Nova couldn't apply the suggestion", { id: "nova-action", duration: 2000 });
            }
        },
        [activeTabId, activeTab?.sql, isDocTab, schemaContext, updateSql]
    );

    // ── Load history ───────────────────────────────────────────────────────
    useEffect(() => { loadHistoryFromStorage(); }, [loadHistoryFromStorage]);
    useEffect(() => { if (tabs.length === 0) addTab(); }, [tabs.length, addTab]);

    // ── SQL change guards ──────────────────────────────────────────────────
    useEffect(() => {
        if (!reviewPendingApproval || !activeTab?.sql) return;
        if (normalizeSqlForCompare(reviewPendingApproval.sql) !== normalizeSqlForCompare(activeTab.sql))
            setReviewPendingApproval(null);
    }, [reviewPendingApproval, activeTab?.sql]);

    useEffect(() => {
        if (!prodGuardPending) return;
        const sql = activeTab?.sql.trim() ?? "";
        const guardExpired =
            prodGuardPending.connectionId !== connectionId ||
            prodGuardPending.tabId !== activeTabId ||
            normalizeSqlForCompare(prodGuardPending.sqlSnapshot) !== normalizeSqlForCompare(sql);
        if (!guardExpired) return;
        setProdGuardPending(null);
        setProdGuardTypedText("");
        setProdGuardReason("");
    }, [prodGuardPending, connectionId, activeTabId, activeTab?.sql]);

    // ── Review audit ───────────────────────────────────────────────────────
    const buildReviewAudit = useCallback(
        (mode: "manual" | "auto", report?: SqlReviewReport): QueryHistoryEntry["aiReview"] | undefined => {
            if (!report) return undefined;
            return {
                mode,
                overridden: report.issues.some((i) => i.severity === "block" || i.severity === "warn"),
                aiModel: report.aiModel,
                issueCounts: getReviewIssueCounts(report),
            };
        },
        []
    );

    // ── Execute ────────────────────────────────────────────────────────────
    const executeCurrentSql = useCallback(
        (mode: "direct" | "sandbox", reviewAudit?: QueryHistoryEntry["aiReview"], guardReason?: string) => {
            if (!connectionId || !activeTabId) return;
            if (isDocTab(activeTabId)) {
                toast.info("Query execution is not available for .doc files.");
                return;
            }
            const sql = activeTab?.sql.trim() ?? "";
            if (!sql) return;

            const guardDecision = shouldRequireProductionGuard({ strictProductionGuard, environment: activeEnvironment, sql });
            if (guardDecision.required && !guardReason) {
                setProdGuardPending({ connectionId, tabId: activeTabId, sqlSnapshot: sql, mode, reviewAudit, classification: guardDecision.classification });
                setProdGuardTypedText("");
                setProdGuardReason("");
                return;
            }

            if (mode === "sandbox") {
                runInSandbox(connectionId, sql);
                return;
            }

            executeQuery(connectionId, activeTabId, databaseName || undefined, {
                aiReview: reviewAudit,
                environment: activeEnvironment,
                productionGuardReason: guardReason?.trim() || undefined,
            });
        },
        [connectionId, activeTabId, activeTab?.sql, isDocTab, strictProductionGuard, activeEnvironment, databaseName, executeQuery, runInSandbox]
    );

    const runQueryReview = useCallback(
        async (trigger: "manual" | "auto"): Promise<SqlReviewReport | null> => {
            if (activeTabId && isDocTab(activeTabId)) return null;
            if (!activeTab?.sql.trim()) return null;
            const sql = activeTab.sql.trim();
            setReviewLoading(true);
            setReviewPendingApproval(null);
            try {
                const report = await runSqlSafetyReview(
                    sql,
                    { tableColumns: tableColumnsForReview, tableRowCounts, schemaSummary: schemaContextForAi },
                    { enableGemini: aiReviewUseGemini, geminiApiKey: geminiApiKey.trim(), geminiModel: aiReviewModel, complexLineThreshold: aiReviewComplexLineThreshold }
                );
                setReviewReport(report);
                if (trigger === "manual") {
                    const counts = getReviewIssueCounts(report);
                    if (counts.block > 0) toast.error(`AI Review: ${counts.block} blocking issue(s) found.`, { duration: 2600 });
                    else if (counts.warn > 0) toast.warning(`AI Review: ${counts.warn} warning(s) found.`, { duration: 2600 });
                    else toast.success("AI Review passed.", { duration: 1800 });
                }
                return report;
            } catch (error) {
                toast.error(`AI review failed: ${error instanceof Error ? error.message : "Review failed."}`, { duration: 3500 });
                return null;
            } finally {
                setReviewLoading(false);
            }
        },
        [activeTab?.sql, activeTabId, isDocTab, aiReviewUseGemini, geminiApiKey, aiReviewModel, aiReviewComplexLineThreshold, tableColumnsForReview, tableRowCounts, schemaContextForAi]
    );

    const handleManualReview = useCallback(async () => {
        if (activeTabId && isDocTab(activeTabId)) {
            toast.info("AI SQL review is not available for .doc files.");
            return;
        }
        if (!aiReviewEnabled) {
            toast.info("AI Review Mode is disabled. Enable it in Settings > Query.");
            return;
        }
        await runQueryReview("manual");
    }, [activeTabId, aiReviewEnabled, isDocTab, runQueryReview]);

    const handleRunAfterReview = useCallback(() => {
        if (!reviewPendingApproval || !activeTab?.sql) return;
        const currentSql = activeTab.sql.trim();
        if (normalizeSqlForCompare(reviewPendingApproval.sql) !== normalizeSqlForCompare(currentSql)) {
            setReviewPendingApproval(null);
            toast.info("SQL changed after review. Run review again before executing.");
            return;
        }
        const reviewAudit = buildReviewAudit(reviewPendingApproval.trigger, reviewReport ?? undefined);
        executeCurrentSql(reviewPendingApproval.mode, reviewAudit);
        setReviewPendingApproval(null);
    }, [reviewPendingApproval, activeTab?.sql, executeCurrentSql, reviewReport, buildReviewAudit]);

    const closeProdGuardDialog = useCallback(() => {
        setProdGuardPending(null);
        setProdGuardTypedText("");
        setProdGuardReason("");
    }, []);

    const handleConfirmProdGuard = useCallback(() => {
        if (!prodGuardPending) return;
        if (prodGuardTypedText.trim() !== STRICT_PRODUCTION_CONFIRMATION) {
            toast.error(`Type exactly "${STRICT_PRODUCTION_CONFIRMATION}" to continue.`);
            return;
        }
        const reason = prodGuardReason.trim();
        if (!reason) { toast.error("Please enter a reason before executing on production."); return; }
        const sql = activeTab?.sql.trim() ?? "";
        const isStillValid =
            prodGuardPending.connectionId === connectionId &&
            prodGuardPending.tabId === activeTabId &&
            normalizeSqlForCompare(prodGuardPending.sqlSnapshot) === normalizeSqlForCompare(sql);
        if (!isStillValid) {
            closeProdGuardDialog();
            toast.info("Query changed. Re-run to review production guard again.");
            return;
        }
        executeCurrentSql(prodGuardPending.mode, prodGuardPending.reviewAudit, reason);
        closeProdGuardDialog();
    }, [prodGuardPending, prodGuardTypedText, prodGuardReason, activeTab?.sql, connectionId, activeTabId, closeProdGuardDialog, executeCurrentSql]);

    const handleExecute = useCallback(async () => {
        if (!connectionId || !activeTabId) return;
        if (isDocTab(activeTabId)) {
            toast.info("Query execution is not available for .doc files.");
            return;
        }
        const sql = activeTab?.sql.trim() ?? "";
        if (!sql) return;
        const mode: "direct" | "sandbox" = isSandboxMode ? "sandbox" : "direct";
        const intent = getSqlReviewIntent(sql);
        const shouldAutoReview = aiReviewEnabled && aiReviewAutoOnDml && intent.autoReviewCandidate;
        if (!shouldAutoReview) {
            if (reviewPendingApproval) setReviewPendingApproval(null);
            const reviewedForCurrentSql = reviewReport && !reviewIsStale ? reviewReport : undefined;
            const reviewAudit = buildReviewAudit("manual", reviewedForCurrentSql);
            executeCurrentSql(mode, reviewAudit);
            return;
        }
        const report = await runQueryReview("auto");
        if (!report) return;
        setReviewPendingApproval({ sql, mode, trigger: "auto" });
        toast.info("AI review complete. Confirm in the review panel to execute.", { duration: 2600 });
    }, [connectionId, activeTabId, activeTab?.sql, isDocTab, isSandboxMode, aiReviewEnabled, aiReviewAutoOnDml, reviewPendingApproval, reviewReport, reviewIsStale, buildReviewAudit, executeCurrentSql, runQueryReview]);

    // ── Keyboard shortcuts ─────────────────────────────────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { setEditorFullScreen((v) => v ? false : v); return; }
            const isModEnter = (e.metaKey || e.ctrlKey) && e.key === "Enter";
            if (isModEnter) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                handleExecute();
                return;
            }
            const isShiftMod = (e.metaKey || e.ctrlKey) && e.shiftKey;
            if (isShiftMod) {
                if (isEditableTarget(e.target)) return;
                const key = e.key.toUpperCase();
                if (key === "N") { e.preventDefault(); toggleRightPanel("notes"); return; }
                if (key === "A") { e.preventDefault(); toggleRightPanel("ai"); return; }
                if (key === "C") { e.preventDefault(); toggleRightPanel("collaboration"); return; }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [handleExecute, toggleRightPanel]);

    // ── Explain ────────────────────────────────────────────────────────────
    const handleExplain = useCallback(async (tabId?: string, sql?: string) => {
        const tid = tabId ?? activeTabId;
        if (tid && isDocTab(tid)) {
            toast.info("Explain is only available for SQL tabs.");
            return;
        }
        const query = sql ?? activeTab?.sql.trim();
        if (!connectionId || !tid || !query) return;
        setPlanLoading((prev) => ({ ...prev, [tid]: true }));
        setResultView((prev) => ({ ...prev, [tid]: "plan" }));
        try {
            const json = await dbExplainQuery(connectionId, query);
            setPlanData((prev) => ({ ...prev, [tid]: json }));
        } catch (err) {
            toast.error(String(err), { duration: 4000 });
            setResultView((prev) => ({ ...prev, [tid]: "results" }));
        } finally {
            setPlanLoading((prev) => ({ ...prev, [tid]: false }));
        }
    }, [connectionId, activeTabId, activeTab?.sql, isDocTab]);

    // ── AI Explain (Nova inline widget) ───────────────────────────────────
    // This triggers the same flow as pressing ⌘⇧E in the editor.
    // We use the Monaco action trigger via a shared ref on the editor component.
    const monacoEditorActionRef = useRef<((actionId: string) => void) | null>(null);
    const handleAiExplain = useCallback(() => {
        // Try to fire the Monaco action (handled inside MonacoSqlEditor)
        if (monacoEditorActionRef.current) {
            monacoEditorActionRef.current("explain-query");
            return;
        }
        // Fallback: call explainSql directly (no anchor rect; widget will position at top of viewport)
        const sql = activeTab?.sql.trim();
        if (!sql) return;
        explainSql(sql, schemaContext).catch(() => { });
    }, [activeTab?.sql, schemaContext]);

    const handleApplyFix = useCallback(async (fixSql: string) => {
        if (!connectionId || !activeTabId) return;
        try {
            await dbExecuteQuery(connectionId, fixSql, { environment: activeEnvironment });
            toast.success("Fix applied — re-analysing plan…", { duration: 2000 });
            await handleExplain(activeTabId, activeTab?.sql.trim());
        } catch (err) {
            toast.error(`Fix failed: ${String(err)}`, { duration: 4000 });
        }
    }, [connectionId, activeTabId, activeTab?.sql, activeEnvironment, handleExplain]);

    // ── History actions ────────────────────────────────────────────────────
    const handleRerunFromHistory = useCallback(
        (sql: string) => {
            if (!connectionId) return;
            const targetGroupId = activeEditorGroup?.id ?? activeEditorGroupId;
            if (!activeTabId) {
                const nextTabId = addTab("Re-run", sql);
                openTabInGroup(targetGroupId, nextTabId, true);
                setTimeout(() => {
                    executeQuery(connectionId, nextTabId, databaseName || undefined, {
                        environment: activeEnvironment,
                    });
                }, 50);
            } else {
                if (isDocTab(activeTabId)) {
                    const nextTabId = addTab("Re-run", sql);
                    openTabInGroup(targetGroupId, nextTabId, true);
                    setTimeout(() => {
                        executeQuery(connectionId, nextTabId, databaseName || undefined, {
                            environment: activeEnvironment,
                        });
                    }, 50);
                } else {
                    updateSql(activeTabId, sql);
                    setTimeout(() => handleExecute(), 50);
                }
            }
        },
        [
            activeEditorGroup?.id,
            activeEditorGroupId,
            activeEnvironment,
            activeTabId,
            addTab,
            connectionId,
            databaseName,
            executeQuery,
            handleExecute,
            isDocTab,
            openTabInGroup,
            updateSql,
        ]
    );

    // ── Load SQL from sidebar file ─────────────────────────────────────────
    const handleLoadSql = useCallback(
        (sql: string, options?: QueryLoadSqlOptions) => {
            const openTarget = options?.openTarget ?? "active";
            const sourceGroupId =
                options?.sourceGroupId && editorGroups.some((group) => group.id === options.sourceGroupId)
                    ? options.sourceGroupId
                    : (activeEditorGroup?.id ?? activeEditorGroupId);

            const openTabByTarget = (tabId: string) => {
                if (openTarget === "split-left") {
                    openTabInNewSplit(sourceGroupId, tabId, "left");
                    return;
                }
                if (openTarget === "split-right" || openTarget === "new-split") {
                    openTabInNewSplit(sourceGroupId, tabId, "right");
                    return;
                }
                openTabInGroup(sourceGroupId, tabId, true);
            };

            if (options?.fromFileId) {
                const existingFileTabId =
                    Object.entries(tabFileMapRef.current).find(
                        ([tabId, fileId]) => fileId === options.fromFileId && tabsById.has(tabId)
                    )?.[0] ?? null;

                let targetTabId = existingFileTabId;
                if (!targetTabId) {
                    targetTabId = addTab(options.fileName, sql);
                    setTabFileMap((prev) => ({ ...prev, [targetTabId!]: options.fromFileId! }));
                } else {
                    updateSql(targetTabId, sql);
                }

                openTabByTarget(targetTabId);
                return;
            }

            if (openTarget !== "active") {
                const splitTabId = addTab(options?.fileName, sql);
                openTabByTarget(splitTabId);
                return;
            }

            const group = editorGroups.find((candidate) => candidate.id === sourceGroupId);
            const targetTabId = group?.activeTabId ?? group?.tabIds[0] ?? null;
            if (targetTabId) {
                updateSql(targetTabId, sql);
                openTabInGroup(sourceGroupId, targetTabId, true);
                return;
            }

            const nextTabId = addTab(options?.fileName, sql);
            openTabInGroup(sourceGroupId, nextTabId, true);
        },
        [
            activeEditorGroupId,
            activeEditorGroup?.id,
            addTab,
            editorGroups,
            openTabInGroup,
            openTabInNewSplit,
            tabsById,
            updateSql,
        ]
    );

    const handleEditorPaneDragOver = useCallback(
        (e: React.DragEvent<HTMLDivElement>, groupId: string) => {
            const fileNodeId = getDraggedFileNodeId(e.dataTransfer);
            if (!fileNodeId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / Math.max(rect.width, 1);
            const placement: SplitDropPlacement =
                ratio < 0.25 ? "left" : ratio > 0.75 ? "right" : "center";
            setFileDropTarget((prev) =>
                prev && prev.groupId === groupId && prev.placement === placement
                    ? prev
                    : { groupId, placement }
            );
        },
        []
    );

    const handleEditorPaneDragLeave = useCallback(
        (e: React.DragEvent<HTMLDivElement>, groupId: string) => {
            const to = e.relatedTarget as Node | null;
            if (to && e.currentTarget.contains(to)) return;
            setFileDropTarget((prev) => (prev?.groupId === groupId ? null : prev));
        },
        []
    );

    const handleEditorPaneDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>, groupId: string) => {
            const fileNodeId = getDraggedFileNodeId(e.dataTransfer);
            setFileDropTarget(null);
            if (!fileNodeId) return;
            e.preventDefault();

            const node = useIdeFsStore.getState().nodes[fileNodeId];
            if (!node || node.type !== "file") return;

            const placement = fileDropTarget?.groupId === groupId
                ? fileDropTarget.placement
                : "center";
            const openTarget: QueryLoadSqlOptions["openTarget"] =
                placement === "left"
                    ? "split-left"
                    : placement === "right"
                        ? "split-right"
                        : "active";

            handleLoadSql(node.content, {
                fromFileId: node.id,
                fileName: node.name,
                openTarget,
                sourceGroupId: groupId,
            });
            if (connectionId) useIdeFsStore.getState().setActiveFile(connectionId, node.id);
        },
        [connectionId, fileDropTarget, handleLoadSql]
    );

    // ── File save (when SQL changes, sync to file) ─────────────────────────
    // Uses ref to always read latest tabFileMap — prevents stale closure in Monaco's onChange
    const handleSqlChange = useCallback(
        (tabId: string, sql: string) => {
            updateSql(tabId, sql);
            const fileId = tabFileMapRef.current[tabId];
            if (fileId) {
                if (fileId.startsWith("fs-")) {
                    useIdeFsStore.getState().updateContent(fileId, sql);
                } else {
                    updateFile(fileId, { sql });
                }
            }

            if (collaborationStatus !== "connected" || !collaborationPermissions.canEdit) return;
            const docKey = getCollaborationDocKey(tabId, tabFileMapRef.current);
            if (suppressCollabPublishRef.current[docKey] === sql) {
                delete suppressCollabPublishRef.current[docKey];
                return;
            }
            void publishDocument(docKey, sql);
        },
        [updateSql, updateFile, collaborationStatus, collaborationPermissions.canEdit, publishDocument]
    );

    const handleCursorActivity = useCallback(
        (tabId: string, payload: CursorPayload) => {
            cursorByTabRef.current[tabId] = payload;
            if (collaborationStatus !== "connected") return;
            const docKey = getCollaborationDocKey(tabId, tabFileMapRef.current);
            void publishCursor(docKey, {
                lineNumber: payload.lineNumber,
                column: payload.column,
                selection: payload.selection ?? null,
            });
        },
        [collaborationStatus, publishCursor]
    );

    const renderTabEditor = useCallback(
        (
            tab: QueryTab,
            options: {
                keyPrefix: string;
                editorHeight: number;
                className: string;
                reviewIssues: SqlReviewReport["issues"];
                fillHeight?: boolean;
            }
        ) => {
            if (isDocTab(tab.id)) {
                const docCollaborators = getCollaboratorsForTab(tab.id).map((participant) => ({
                    id: participant.id,
                    name: participant.name,
                    initials: participant.initials,
                    colorIndex: participant.colorIndex,
                }));
                const docFileName = getTabFileName(tab.id)?.toLowerCase() ?? "";
                const isSchemaDoc = docFileName === "readme.doc";
                return (
                    <DocumentBlockEditor
                        key={`${options.keyPrefix}-${tab.id}`}
                        value={tab.sql}
                        onChange={(value) => handleSqlChange(tab.id, value)}
                        collaborators={docCollaborators}
                        readOnly={isCollaborationReadOnly}
                        className={options.className}
                        variant={isSchemaDoc ? "schema" : "default"}
                        aiAssist={{
                            getContext: getDocAiAssistContext,
                            docTitle: getTabFileName(tab.id),
                            stats: docAiAssistStats,
                        }}
                    />
                );
            }

            return (
                    <MonacoSqlEditor
                        key={`${options.keyPrefix}-${tab.id}`}
                        value={tab.sql}
                        onChange={(value) => handleSqlChange(tab.id, value)}
                        onCursorActivity={(cursor) => handleCursorActivity(tab.id, cursor)}
                        onAddContextShortcut={(cursor) => triggerAiContextAdd(tab.id, cursor)}
                        onExecute={handleExecute}
                        onReview={handleManualReview}
                        onFormatSql={handleFormatSql}
                        onFetchColumns={handleFetchColumns}
                        onNextAction={handleNextAction}
                    reviewIssues={options.reviewIssues}
                    schemaContext={schemaContext}
                    collaborators={getCollaboratorsForTab(tab.id)}
                    disabled={tab.isExecuting || isCollaborationReadOnly}
                    className={options.className}
                    hideNextActionSuggestions
                    editorHeight={options.editorHeight}
                    fillHeight={options.fillHeight}
                    onRegisterActionTrigger={(trigger) => { monacoEditorActionRef.current = trigger; }}
                />
            );
        },
        [
            docAiAssistStats,
            getDocAiAssistContext,
            getCollaboratorsForTab,
            handleCursorActivity,
            handleExecute,
            handleFetchColumns,
            handleFormatSql,
            handleManualReview,
            handleNextAction,
            handleSqlChange,
            getTabFileName,
            isCollaborationReadOnly,
            isDocTab,
            schemaContext,
        ]
    );

    // ── Export ─────────────────────────────────────────────────────────────
    const handleExport = (format: "csv" | "json", resultOverride?: QueryResult) => {
        const result = resultOverride ?? activeTab?.result;
        if (!result || result.is_error || result.columns.length === 0) return;
        const tabTitle = activeTab?.title ?? "query";
        const filename = `${tabTitle.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}`;
        if (format === "csv") {
            downloadBlob(exportResultToCSV(result), `${filename}.csv`, "text/csv;charset=utf-8;");
            toast.success("CSV downloaded", { duration: 1500 });
        } else {
            downloadBlob(exportResultToJSON(result), `${filename}.json`, "application/json");
            toast.success("JSON downloaded", { duration: 1500 });
        }
    };

    const hasResult = !activeTabIsDoc && activeTab?.result && !activeTab.result.is_error && activeTab.result.columns.length > 0;

    // ── File run ───────────────────────────────────────────────────────────
    const handleRunSqlFile = useCallback(
        (content: string) => {
            if (!activeTabId) return;
            if (isDocTab(activeTabId)) {
                toast.info("Run file is disabled while a .doc tab is active.");
                return;
            }
            updateSql(activeTabId, content);
            setRunSqlFileOpen(false);
            toast.success("SQL loaded — running…", { duration: 1500 });
            setTimeout(() => handleExecute(), 50);
        },
        [activeTabId, isDocTab, updateSql, handleExecute]
    );

    const handleRunSqlFileSelect = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!file.name.toLowerCase().endsWith(".sql")) { toast.error("Please select a .sql file"); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const sql = String(reader.result ?? "").trim();
                if (!sql) { toast.warning("File is empty"); return; }
                handleRunSqlFile(sql);
            };
            reader.readAsText(file, "UTF-8");
        },
        [handleRunSqlFile]
    );

    const handleRunSqlFileDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const file = e.dataTransfer.files?.[0];
            if (!file) return;
            if (!file.name.toLowerCase().endsWith(".sql")) { toast.error("Please select a .sql file"); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const sql = String(reader.result ?? "").trim();
                if (!sql) { toast.warning("File is empty"); return; }
                handleRunSqlFile(sql);
            };
            reader.readAsText(file, "UTF-8");
        },
        [handleRunSqlFile]
    );

    // ── Activity bar toggle ────────────────────────────────────────────────
    const handleActivityBarToggle = useCallback((panel: SidebarPanel) => {
        setSidebarPanel((prev) => prev === panel ? null : panel);
    }, []);

    const isSwitchingDb = useConnectionStore((s) => s.isSwitchingDatabase);
    const rightPanelMode = rightPanelView;
    const rightPanelPx =
        rightPanelMode === "collaboration" ? 340 : rightPanelMode === "notes" ? 360 : rightPanelMode === "ai" ? 420 : 0;
    const rightPanelWidthClass =
        rightPanelMode === "collaboration" ? "w-[340px]" : rightPanelMode === "notes" ? "w-[360px]" : "w-[420px]";

    return (
        <div className="flex h-full overflow-hidden bg-background">
            {/* ── Dialogs ──────────────────────────────────────────────── */}

            {/* Run SQL file dialog */}
            <Dialog open={runSqlFileOpen} onOpenChange={setRunSqlFileOpen}>
                <DialogContent className="sm:max-w-md gap-0 p-0">
                    <DialogHeader className="px-4 pt-4 pb-2">
                        <DialogTitle className="text-sm flex items-center gap-2">
                            <FileText className="h-4 w-4 text-sky-400" />
                            Run SQL file
                        </DialogTitle>
                    </DialogHeader>
                    <div
                        className="mx-4 mb-4 rounded-xl border-2 border-dashed border-border/40 hover:border-sky-500/40 hover:bg-sky-500/5 transition-colors p-6 text-center cursor-pointer"
                        onClick={() => runSqlFileInputRef.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onDrop={handleRunSqlFileDrop}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && runSqlFileInputRef.current?.click()}
                    >
                        <input ref={runSqlFileInputRef} type="file" accept=".sql" className="hidden" onChange={handleRunSqlFileSelect} />
                        <FileText className="h-10 w-10 mx-auto text-muted-foreground/50 mb-2" />
                        <p className="text-sm font-medium text-foreground">Choose a .sql file</p>
                        <p className="text-xs text-muted-foreground/60 mt-0.5">Load into editor and run</p>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Production guard dialog */}
            <Dialog open={Boolean(prodGuardPending)} onOpenChange={(open) => { if (!open) closeProdGuardDialog(); }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-base">
                            <ShieldCheck className="h-4 w-4 text-red-300" />
                            Production guard required
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-100/85">
                            This connection is tagged as{" "}
                            <span className="font-semibold">{formatEnvironmentLabel(activeEnvironment)}</span>.
                            Confirm before executing risky SQL.
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">Detected risky statements:</span>
                            {(prodGuardPending?.classification.riskyStatements ?? []).map((statement) => (
                                <Badge key={statement} variant="outline" className="h-5 px-1.5 text-[10px] border-red-500/30 text-red-300 bg-red-500/10">
                                    {statement}
                                </Badge>
                            ))}
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">
                                Type <span className="font-mono text-foreground">{STRICT_PRODUCTION_CONFIRMATION}</span>
                            </label>
                            <Input
                                value={prodGuardTypedText}
                                onChange={(e) => setProdGuardTypedText(e.target.value)}
                                placeholder={STRICT_PRODUCTION_CONFIRMATION}
                                className="h-9 font-mono text-xs"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">Reason for this production query</label>
                            <Textarea
                                value={prodGuardReason}
                                onChange={(e) => setProdGuardReason(e.target.value)}
                                placeholder="Describe why this change is needed and what scope it impacts."
                                className="min-h-24 text-sm resize-none"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={closeProdGuardDialog}>Cancel</Button>
                        <Button
                            size="sm"
                            className="bg-red-600 hover:bg-red-500 text-white"
                            onClick={handleConfirmProdGuard}
                            disabled={prodGuardTypedText.trim() !== STRICT_PRODUCTION_CONFIRMATION || !prodGuardReason.trim()}
                        >
                            Continue on production
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Save Note dialog */}
            <Dialog open={saveNoteOpen} onOpenChange={setSaveNoteOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-sm font-medium flex items-center gap-2">
                            <StickyNote className="h-4 w-4 text-amber-400" />
                            Save Note
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Title</label>
                            <Input
                                value={saveNoteTitle}
                                onChange={(e) => setSaveNoteTitle(e.target.value)}
                                placeholder="e.g. User activity report…"
                                className="h-8 text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && saveNoteTitle.trim()) {
                                        e.preventDefault();
                                        (async () => {
                                            setSaveNoteLoading(true);
                                            try {
                                                const now = new Date().toISOString();
                                                await storeNoteSave({ id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: saveNoteTitle.trim(), sql: activeTab?.sql ?? "", created_at: now, updated_at: now, tags: [] });
                                                setSaveNoteOpen(false);
                                                toast.success("Note saved", { duration: 1500 });
                                            } catch { toast.error("Failed to save note", { duration: 2000 }); }
                                            finally { setSaveNoteLoading(false); }
                                        })();
                                    }
                                }}
                            />
                        </div>
                        <div className="rounded-md border border-border/30 bg-muted/20 p-2">
                            <p className="text-[10px] text-muted-foreground/50 mb-1">SQL content</p>
                            <p className="text-xs font-mono text-foreground/70 truncate">
                                {(activeTab?.sql ?? "").replace(/\s+/g, " ").slice(0, 200) || "(empty)"}
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setSaveNoteOpen(false)}>Cancel</Button>
                        <Button
                            size="sm"
                            className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white"
                            disabled={!saveNoteTitle.trim() || saveNoteLoading}
                            onClick={async () => {
                                setSaveNoteLoading(true);
                                try {
                                    const now = new Date().toISOString();
                                    await storeNoteSave({ id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: saveNoteTitle.trim(), sql: activeTab?.sql ?? "", created_at: now, updated_at: now, tags: [] });
                                    setSaveNoteOpen(false);
                                    toast.success("Note saved", { duration: 1500 });
                                } catch { toast.error("Failed to save note", { duration: 2000 }); }
                                finally { setSaveNoteLoading(false); }
                            }}
                        >
                            {saveNoteLoading && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                            Save Note
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Layout ───────────────────────────────────────────────── */}

            {/* Activity bar */}
            <QueryActivityBar activePanel={sidebarPanel} onToggle={handleActivityBarToggle} />

            {/* Git panel — full-width takeover (like VS Code Source Control) */}
            {sidebarPanel === "git" && (
                <div className="flex-1 min-w-0 overflow-hidden">
                    <GitPanel />
                </div>
            )}

            {/* Sidebar panel (files / templates / history) */}
            {sidebarPanel && sidebarPanel !== "git" && (
                <div className="w-64 shrink-0 flex flex-col overflow-hidden border-r border-border/25">
                    <QuerySidebar
                        activePanel={sidebarPanel}
                        history={history}
                        onLoadSql={handleLoadSql}
                        onRerunSql={handleRerunFromHistory}
                        onClearHistory={clearHistory}
                        onDeleteHistoryEntry={deleteHistoryEntry}
                        schemaContext={schemaContext}
                        connectionId={connectionId ?? "default"}
                        databaseName={databaseName || "workspace"}
                        canEditFiles={collaborationStatus !== "connected" || collaborationPermissions.canEdit}
                        canDeleteFiles={collaborationStatus !== "connected" || collaborationPermissions.canDelete}
                    />
                </div>
            )}

            {/* Main editor column — hidden when git panel is open */}
            <div className={cn("flex flex-col flex-1 min-w-0 overflow-hidden", sidebarPanel === "git" && "hidden")}>
                {(collaborationStatus === "connected" || collaborationRoomId) && (
                    <div className="flex items-center gap-2 border-b border-cyan-500/20 bg-cyan-500/8 px-3 py-1.5 shrink-0">
                        <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                        <span className="text-xs font-medium text-cyan-300">
                            Live collaboration {collaborationRoomId ? `• ${collaborationRoomId}` : ""}
                        </span>
                        <Badge variant="outline" className="h-5 border-cyan-500/25 bg-cyan-500/10 text-[10px] text-cyan-200">
                            {localAccessLevel ?? "view"}
                        </Badge>
                        {isCollaborationReadOnly && (
                            <span className="text-[10px] text-cyan-100/80">Read-only mode</span>
                        )}
                        <div className="ml-auto">
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-6 border-cyan-500/30 bg-cyan-500/10 px-2 text-[10px] text-cyan-100 hover:bg-cyan-500/20"
                                onClick={() => toggleRightPanel("collaboration")}
                            >
                                {rightPanelView === "collaboration" ? "Hide collaboration" : "Show collaboration"}
                            </Button>
                        </div>
                    </div>
                )}
                {/* Sandbox banner */}
                {isSandboxMode && (
                    <div className="flex items-center gap-2 px-4 py-1 bg-emerald-500/5 border-b border-emerald-500/15 shrink-0">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                        <span className="text-xs text-emerald-400/90 font-medium">SANDBOX MODE</span>
                        <span className="text-xs text-emerald-400/50 ml-1">
                            {isSandboxReviewing ? "— Review diff, then Commit or Rollback"
                                : isSandboxBusy ? "— Processing…"
                                    : "— Nothing committed until you approve"}
                        </span>
                        {isSandboxReviewing && sandboxElapsed > 0 && (
                            <span className="ml-auto text-[10px] font-mono text-emerald-400/40">txn open {sandboxElapsed}s</span>
                        )}
                    </div>
                )}

                {/* AI review panel */}
                {aiReviewEnabled && (
                    <QueryReviewPanel
                        report={reviewReport}
                        isLoading={reviewLoading}
                        isStale={reviewIsStale}
                        onRecheck={handleManualReview}
                        onClose={() => { setReviewReport(null); setReviewPendingApproval(null); }}
                        pendingApproval={Boolean(reviewPendingApproval)}
                        onRunPending={handleRunAfterReview}
                        onCancelPending={() => setReviewPendingApproval(null)}
                    />
                )}

                {activeTab ? (
                    <>
                        {/* Full-screen editor overlay: sidebar + full-height Monaco */}
                        {editorFullScreen && (
                            <div className="fixed inset-0 z-50 bg-background flex flex-col h-screen">
                                <header className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-background shrink-0">
                                    <span className="text-sm font-medium text-muted-foreground">
                                        {activeTabIsDoc ? "Document editor" : "Query editor"}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        {!activeTabIsDoc && (
                                            <>
                                                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handleManualReview}
                                                    disabled={!activeTab.sql.trim() || activeTab.isExecuting || reviewLoading || !aiReviewEnabled}>
                                                    {reviewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
                                                    Review
                                                </Button>
                                                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handleExecute}
                                                    disabled={activeTab.isExecuting || reviewLoading || isSandboxBusy || isSandboxReviewing || !activeTab.sql.trim()}>
                                                    {activeTab.isExecuting || isSandboxBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                                    Run
                                                </Button>
                                            </>
                                        )}
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    size="sm"
                                                    variant={rightPanelView === "ai" ? "secondary" : "outline"}
                                                    className={cn(
                                                        "h-8 gap-1.5",
                                                        rightPanelView === "ai" && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
                                                    )}
                                                    onClick={() => toggleRightPanel("ai")}
                                                    aria-pressed={rightPanelView === "ai"}
                                                >
                                                    <Sparkles className="h-3.5 w-3.5" />
                                                    {rightPanelView === "ai" ? "Hide AI" : "AI chat"}
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="bottom" className="max-w-[14rem] text-xs">
                                                {rightPanelView === "ai" ? "Close AI assistant" : "Open AI assistant"} · ⌘⇧A
                                            </TooltipContent>
                                        </Tooltip>
                                        <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setEditorFullScreen(false)}>
                                            <Minimize2 className="h-3.5 w-3.5" />
                                            Exit full screen
                                        </Button>
                                    </div>
                                </header>
                                <div className="flex flex-1 min-h-0">
                                    <QueryActivityBar activePanel={sidebarPanel} onToggle={handleActivityBarToggle} />
                                    {sidebarPanel && sidebarPanel !== "git" && (
                                        <div className="w-64 shrink-0 flex flex-col overflow-hidden border-r border-border/25">
                                            <QuerySidebar
                                                activePanel={sidebarPanel}
                                                history={history}
                                                onLoadSql={handleLoadSql}
                                                onRerunSql={handleRerunFromHistory}
                                                onClearHistory={clearHistory}
                                                onDeleteHistoryEntry={deleteHistoryEntry}
                                                schemaContext={schemaContext}
                                                connectionId={connectionId ?? "default"}
                                                databaseName={databaseName || "workspace"}
                                                canEditFiles={collaborationStatus !== "connected" || collaborationPermissions.canEdit}
                                                canDeleteFiles={collaborationStatus !== "connected" || collaborationPermissions.canDelete}
                                            />
                                        </div>
                                    )}
                                    <div
                                        className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden"
                                        style={
                                            editorFullScreen && rightPanelPx > 0
                                                ? { paddingRight: rightPanelPx }
                                                : undefined
                                        }
                                    >
                                        {renderTabEditor(activeTab, {
                                            keyPrefix: "fullscreen",
                                            editorHeight: 480,
                                            className: "rounded-none border-0 flex-1 min-h-0",
                                            reviewIssues: reviewReport?.issues ?? [],
                                            fillHeight: true,
                                        })}
                                    </div>
                                </div>
                            </div>
                        )}

                        {(() => {
                            const editorColumn = (
                                <div className="flex h-full min-h-0 flex-col">
                                <QueryToolbar
                                    isExecuting={activeTab.isExecuting}
                                    isReviewLoading={reviewLoading}
                                    isExplaining={isExplaining}
                                    hasSql={!activeTabIsDoc && Boolean(activeTab.sql.trim())}
                                    allowRunFile={!activeTabIsDoc}
                                    isSandboxMode={isSandboxMode}
                                    isSandboxBusy={isSandboxBusy}
                                    isSandboxReviewing={isSandboxReviewing}
                                    aiReviewEnabled={aiReviewEnabled}
                                    isFullScreen={editorFullScreen}
                                    onRun={handleExecute}
                                    onReview={handleManualReview}
                                    onFormat={() => activeTab.sql && handleFormatSql(activeTab.sql)}
                                    onExplain={() => handleExplain()}
                                    onAiExplain={handleAiExplain}
                                    onRunFile={() => setRunSqlFileOpen(true)}
                                    onSaveNote={() => { setSaveNoteTitle(""); setSaveNoteOpen(true); }}
                                    onToggleFullScreen={() => setEditorFullScreen((v) => !v)}
                                    onToggleSandbox={() => {
                                        if (isSandboxMode) { disableSandbox(); toast.info("Sandbox mode off", { duration: 1500 }); }
                                        else { enableSandbox(); toast.success("Sandbox mode enabled — queries run inside a transaction", { duration: 2500 }); }
                                    }}
                                />
                                <div className="flex-1 min-h-[280px] overflow-hidden">
                                    {editorGroups.length > 1 ? (
                                        <ResizablePanelGroup id="qe-editor-hgroup" orientation="horizontal" className="h-full min-h-0">
                                            {editorGroups.map((group, index) => {
                                                const groupTabs = group.tabIds
                                                    .map((tabId) => tabsById.get(tabId))
                                                    .filter((tab): tab is QueryTab => Boolean(tab));
                                                const groupActiveTab =
                                                    (group.activeTabId ? tabsById.get(group.activeTabId) : null) ?? groupTabs[0] ?? null;
                                                const isFocusedGroup = group.id === activeEditorGroupId;
                                                const dropPlacement =
                                                    fileDropTarget?.groupId === group.id ? fileDropTarget.placement : null;
                                                return (
                                                    <Fragment key={group.id}>
                                                        <ResizablePanel
                                                            id={`qe-editor-panel-${group.id}`}
                                                            defaultSize={`${100 / Math.max(editorGroups.length, 1)}%`}
                                                            minSize="18%"
                                                            className="min-w-0"
                                                        >
                                                            <div
                                                                className={cn(
                                                                    "relative flex h-full min-h-0 flex-col overflow-hidden border-r border-border/20",
                                                                    isFocusedGroup && "ring-1 ring-inset ring-primary/35"
                                                                )}
                                                                onMouseDownCapture={() => focusEditorGroup(group.id, groupActiveTab?.id ?? null)}
                                                                onDragOver={(e) => handleEditorPaneDragOver(e, group.id)}
                                                                onDragLeave={(e) => handleEditorPaneDragLeave(e, group.id)}
                                                                onDrop={(e) => handleEditorPaneDrop(e, group.id)}
                                                            >
                                                                <QueryTabBar
                                                                    tabs={groupTabs}
                                                                    activeTabId={groupActiveTab?.id ?? null}
                                                                    onSelectTab={(tabId) => handleSelectGroupTab(group.id, tabId)}
                                                                    onCloseTab={(tabId) => handleCloseGroupTab(group.id, tabId)}
                                                                    onNewTab={() => handleNewTabInGroup(group.id)}
                                                                    tabFileMap={tabFileMap}
                                                                    savedFileSqlMap={savedFileSqlMap}
                                                                    extraActions={
                                                                        <div className="flex items-center border-l border-border/20">
                                                                            {groupActiveTab && (
                                                                                <Tooltip>
                                                                                    <TooltipTrigger asChild>
                                                                                        <button
                                                                                            type="button"
                                                                                            onClick={() => openTabInNewSplit(group.id, groupActiveTab.id, "right")}
                                                                                            className="h-9 px-2.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                                                                                            aria-label="Split right"
                                                                                        >
                                                                                            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
                                                                                                <rect x="2" y="3" width="12" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                                                                                                <path d="M8 3v10" stroke="currentColor" strokeWidth="1.2" />
                                                                                                <path d="M10.5 8H13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                                                                            </svg>
                                                                                        </button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent>Split right</TooltipContent>
                                                                                </Tooltip>
                                                                            )}
                                                                            {editorGroups.length > 1 && (
                                                                                <Tooltip>
                                                                                    <TooltipTrigger asChild>
                                                                                        <button
                                                                                            type="button"
                                                                                            onClick={() => closeEditorGroup(group.id)}
                                                                                            className="h-9 px-2.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                                                            aria-label="Close split"
                                                                                        >
                                                                                            <X className="h-3.5 w-3.5" />
                                                                                        </button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent>Close split</TooltipContent>
                                                                                </Tooltip>
                                                                            )}
                                                                        </div>
                                                                    }
                                                                />

                                                                {groupActiveTab ? (
                                                                    renderTabEditor(groupActiveTab, {
                                                                        keyPrefix: group.id,
                                                                        editorHeight: 480,
                                                                        className: "rounded-none border-0 flex-1 min-h-[200px]",
                                                                        reviewIssues: activeTabId === groupActiveTab.id
                                                                            ? (reviewReport?.issues ?? [])
                                                                            : [],
                                                                    })
                                                                ) : (
                                                                    <div className="flex flex-1 items-center justify-center border-t border-border/10 bg-muted/10 text-muted-foreground">
                                                                        <div className="text-center">
                                                                            <p className="text-xs font-medium text-foreground/75">Empty split</p>
                                                                            <p className="mt-1 text-[11px] text-muted-foreground/70">
                                                                                Drop a file here or create a tab.
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                )}

                                                                {dropPlacement && (
                                                                    <div className="pointer-events-none absolute inset-1.5 z-20">
                                                                        <div
                                                                            className={cn(
                                                                                "h-full rounded-md border-2 border-dashed transition-all",
                                                                                dropPlacement === "center" && "border-primary/70 bg-primary/10",
                                                                                dropPlacement === "left" && "border-primary/60 bg-gradient-to-r from-primary/20 via-primary/5 to-transparent",
                                                                                dropPlacement === "right" && "border-primary/60 bg-gradient-to-l from-primary/20 via-primary/5 to-transparent"
                                                                            )}
                                                                        />
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </ResizablePanel>
                                                        {index < editorGroups.length - 1 && (
                                                            <ResizableHandle
                                                                withHandle
                                                                className="shrink-0 w-2 bg-border/20 hover:bg-border/45 data-[resize-handle-active]:bg-primary/45 transition-colors"
                                                            />
                                                        )}
                                                    </Fragment>
                                                );
                                            })}
                                        </ResizablePanelGroup>
                                    ) : (
                                        (() => {
                                            const group = editorGroups[0];
                                            const groupTabs = (group?.tabIds ?? [])
                                                .map((tabId) => tabsById.get(tabId))
                                                .filter((tab): tab is QueryTab => Boolean(tab));
                                            const groupActiveTab =
                                                group && group.activeTabId
                                                    ? (tabsById.get(group.activeTabId) ?? groupTabs[0] ?? null)
                                                    : (groupTabs[0] ?? null);
                                            const dropPlacement =
                                                fileDropTarget?.groupId === group?.id ? fileDropTarget.placement : null;
                                            return (
                                                <div
                                                    className="relative flex h-full min-h-0 flex-col overflow-hidden border-r border-border/20"
                                                    onMouseDownCapture={() => group && focusEditorGroup(group.id, groupActiveTab?.id ?? null)}
                                                    onDragOver={(e) => group && handleEditorPaneDragOver(e, group.id)}
                                                    onDragLeave={(e) => group && handleEditorPaneDragLeave(e, group.id)}
                                                    onDrop={(e) => group && handleEditorPaneDrop(e, group.id)}
                                                >
                                                    <QueryTabBar
                                                        tabs={groupTabs}
                                                        activeTabId={groupActiveTab?.id ?? null}
                                                        onSelectTab={(tabId) => group && handleSelectGroupTab(group.id, tabId)}
                                                        onCloseTab={(tabId) => group && handleCloseGroupTab(group.id, tabId)}
                                                        onNewTab={() => group && handleNewTabInGroup(group.id)}
                                                        tabFileMap={tabFileMap}
                                                        savedFileSqlMap={savedFileSqlMap}
                                                        extraActions={
                                                            <div className="flex items-center border-l border-border/20">
                                                                {groupActiveTab && group && (
                                                                    <Tooltip>
                                                                        <TooltipTrigger asChild>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => openTabInNewSplit(group.id, groupActiveTab.id, "right")}
                                                                                className="h-9 px-2.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                                                                                aria-label="Split right"
                                                                            >
                                                                                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
                                                                                    <rect x="2" y="3" width="12" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                                                                                    <path d="M8 3v10" stroke="currentColor" strokeWidth="1.2" />
                                                                                    <path d="M10.5 8H13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                                                                </svg>
                                                                            </button>
                                                                        </TooltipTrigger>
                                                                        <TooltipContent>Split right</TooltipContent>
                                                                    </Tooltip>
                                                                )}
                                                            </div>
                                                        }
                                                    />

                                                    {groupActiveTab ? (
                                                        renderTabEditor(groupActiveTab, {
                                                            keyPrefix: group?.id ?? "group",
                                                            editorHeight: 580,
                                                            className: "rounded-none border-0 flex-1 min-h-[200px]",
                                                            reviewIssues: activeTabId === groupActiveTab.id
                                                                ? (reviewReport?.issues ?? [])
                                                                : [],
                                                        })
                                                    ) : (
                                                        <div className="flex flex-1 items-center justify-center border-t border-border/10 bg-muted/10 text-muted-foreground">
                                                            <div className="text-center">
                                                                <p className="text-xs font-medium text-foreground/75">No tab in this split</p>
                                                                <p className="mt-1 text-[11px] text-muted-foreground/70">
                                                                    Open a file from Explorer to begin.
                                                                </p>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {dropPlacement && (
                                                        <div className="pointer-events-none absolute inset-1.5 z-20">
                                                            <div
                                                                className={cn(
                                                                    "h-full rounded-md border-2 border-dashed transition-all",
                                                                    dropPlacement === "center" && "border-primary/70 bg-primary/10",
                                                                    dropPlacement === "left" && "border-primary/60 bg-gradient-to-r from-primary/20 via-primary/5 to-transparent",
                                                                    dropPlacement === "right" && "border-primary/60 bg-gradient-to-l from-primary/20 via-primary/5 to-transparent"
                                                                )}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })()
                                    )}
                                </div>
                                </div>
                            );

                            if (activeTabIsDoc) {
                                return (
                                    <div className="flex min-h-[320px] w-full flex-1 flex-col min-h-0">
                                        {editorColumn}
                                    </div>
                                );
                            }

                            return (
                        <ResizablePanelGroup
                            id="qe-vgroup"
                            defaultLayout={queryEditorVerticalLayout.defaultLayout}
                            onLayoutChanged={queryEditorVerticalLayout.onLayoutChanged}
                            orientation="vertical"
                            className="flex min-h-[320px] w-full flex-1"
                        >
                            <ResizablePanel id="qe-editor" defaultSize="65%" minSize="8%" maxSize="92%" className="flex min-h-0 flex-col">
                                {editorColumn}
                            </ResizablePanel>

                            <ResizableHandle
                                withHandle
                                className="shrink-0 min-h-3 cursor-row-resize rounded-sm border-y border-transparent bg-border/15 py-1 transition-colors hover:border-border/25 hover:bg-muted/40 data-[resize-handle-active]:border-emerald-500/30 data-[resize-handle-active]:bg-emerald-500/20"
                            />

                            <ResizablePanel id="qe-results" defaultSize="35%" minSize="8%" maxSize="92%" className="flex min-h-0 flex-col overflow-hidden">
                                <ResultsArea
                                    activeTab={activeTab}
                                    isDocumentTab={activeTabIsDoc}
                                    isSandboxMode={isSandboxMode}
                                    isSandboxReviewing={isSandboxReviewing}
                                    isSandboxBusy={isSandboxBusy}
                                    isSandboxCommitting={isSandboxCommitting}
                                    isSandboxRollingBack={isSandboxRollingBack}
                                    sandboxResult={sandboxResult}
                                    sandboxPendingSql={sandboxPendingSql}
                                    sandboxElapsed={sandboxElapsed}
                                    sandboxStatus={sandboxStatus}
                                    anomalyWarning={anomalyWarning}
                                    onCommit={commitSandbox}
                                    onRollback={rollbackSandbox}
                                    activeResultView={activeResultView}
                                    setResultView={(view) => activeTabId && setResultView((p) => ({ ...p, [activeTabId]: view }))}
                                    activePlan={activePlan}
                                    isExplaining={isExplaining}
                                    onExplain={() => handleExplain()}
                                    onApplyFix={handleApplyFix}
                                    hasResult={Boolean(hasResult)}
                                    history={history}
                                    onShowHistory={() => setSidebarPanel((p) => p === "history" ? null : "history")}
                                    onExport={handleExport}
                                    schemaContextForAi={schemaContextForAi}
                                    // Status bar props
                                    databaseName={databaseName}
                                    databases={databases}
                                    selectedSchema={selectedSchema}
                                    schemas={schemas}
                                    onSwitchDatabase={(db) => connectionId && switchDatabase(connectionId, db)}
                                    onSwitchSchema={(schema) => selectSchema(schema ?? "public")}
                                    activeEnvironment={activeEnvironment}
                                    strictProductionGuard={strictProductionGuard}
                                    isSwitchingDb={isSwitchingDb}
                                    connectionId={connectionId}
                                    liveResultMeta={activeTabId ? (liveResultMetaByTab[activeTabId] ?? null) : null}
                                    onRefresh={() => handleExecute()}
                                    activeTabIsExecuting={Boolean(activeTab?.isExecuting)}
                                />
                            </ResizablePanel>
                        </ResizablePanelGroup>
                            );
                        })()}
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <div className="flex flex-col items-center gap-4">
                            <div className="rounded-2xl border border-border/30 bg-muted/20 p-8 flex flex-col items-center gap-3">
                                <Terminal className="h-12 w-12 opacity-20" />
                                <p className="text-sm font-medium text-foreground/80">No query tab open</p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleNewTabInGroup(activeEditorGroup?.id ?? activeEditorGroupId)}
                                    className="gap-1.5"
                                >
                                    Open new tab
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Workspace panels: compact icon strip above status bar */}
                <div
                    className={cn(
                        "fixed z-30 flex h-8 items-center gap-0.5 rounded-lg border px-0.5 backdrop-blur-md transition-shadow",
                        "border-border/40 bg-background/80 dark:bg-card/75",
                        "shadow-sm",
                        "bottom-2 right-3 sm:bottom-2 sm:right-4",
                        rightPanelView && "border-border/55 shadow-md"
                    )}
                    role="toolbar"
                    aria-label="Workspace panels"
                >
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="AI assistant"
                                aria-pressed={rightPanelView === "ai"}
                                className={cn(
                                    "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
                                    "hover:bg-muted/70 hover:text-foreground",
                                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                    rightPanelView === "ai" && "bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary"
                                )}
                                onClick={() => toggleRightPanel("ai")}
                            >
                                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[14rem] text-center text-xs">
                            {rightPanelView === "ai" ? "Close AI assistant" : "AI assistant"} · ⌘⇧A
                        </TooltipContent>
                    </Tooltip>

                    <div className="h-4 w-px shrink-0 bg-border/35" aria-hidden />

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="Collaboration"
                                aria-pressed={rightPanelView === "collaboration"}
                                className={cn(
                                    "relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                                    "hover:bg-muted/70",
                                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                    rightPanelView === "collaboration"
                                        ? "bg-cyan-500/14 text-cyan-200 hover:bg-cyan-500/20"
                                        : "text-cyan-300/80 hover:text-cyan-200"
                                )}
                                onClick={() => toggleRightPanel("collaboration")}
                            >
                                {collaborationStatus === "connected" && (
                                    <span
                                        className="absolute right-1 top-1 h-1 w-1 rounded-full bg-cyan-400"
                                        aria-hidden
                                    />
                                )}
                                <Users className="h-3.5 w-3.5" aria-hidden />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[14rem] text-center text-xs">
                            {rightPanelView === "collaboration" ? "Close collaboration" : "Collaboration"} · ⌘⇧C
                        </TooltipContent>
                    </Tooltip>

                    {activeTab && (
                        <>
                            <div className="h-4 w-px shrink-0 bg-border/35" aria-hidden />
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label="Notes"
                                        aria-pressed={rightPanelView === "notes"}
                                        className={cn(
                                            "relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                                            "hover:bg-muted/70",
                                            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                            rightPanelView === "notes"
                                                ? "bg-amber-500/12 text-amber-300/95 hover:bg-amber-500/18"
                                                : "text-amber-400/70 hover:text-amber-300/90"
                                        )}
                                        onClick={() => toggleRightPanel("notes")}
                                    >
                                        <StickyNote className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[14rem] text-center text-xs">
                                    {rightPanelView === "notes" ? "Close notes" : "Notes"} · ⌘⇧N
                                </TooltipContent>
                            </Tooltip>
                        </>
                    )}
                </div>
            </div>

            {rightPanelMode && (
                <div
                    className={cn(
                        "border-l border-border/25 flex flex-col min-h-0 bg-background",
                        editorFullScreen
                            ? cn(
                                  "fixed z-[55] top-12 right-0 bottom-0 shadow-2xl shadow-black/20",
                                  rightPanelWidthClass
                              )
                            : cn("shrink-0 h-full", rightPanelWidthClass)
                    )}
                >
                    {rightPanelMode === "ai" && (
                        <AIChatPanel
                            variant="sidebar"
                            getCursorContext={getActiveCursorContext}
                            registerAddContextHandler={registerAiContextHandler}
                        />
                    )}
                    {rightPanelMode === "collaboration" && (
                        <CollaborationPanel connectionId={connectionId} />
                    )}
                    {rightPanelMode === "notes" && (
                        <NotesPanel
                            onInsertSql={(sql) => {
                                if (activeTabId) { updateSql(activeTabId, sql); setRightPanelView(null); }
                                else { addTab("From Note", sql); setRightPanelView(null); }
                            }}
                            onClose={() => setRightPanelView(null)}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

// ── Results area subcomponent ─────────────────────────────────────────────

interface ResultsAreaProps {
    activeTab: NonNullable<ReturnType<typeof useQueryStore.getState>["tabs"][number]> & { result: QueryResult | null; isExecuting: boolean };
    isDocumentTab: boolean;
    isSandboxMode: boolean;
    isSandboxReviewing: boolean;
    isSandboxBusy: boolean;
    isSandboxCommitting: boolean;
    isSandboxRollingBack: boolean;
    sandboxResult: SandboxExecuteResult | null;
    sandboxPendingSql: string | null;
    sandboxElapsed: number;
    sandboxStatus: string;
    anomalyWarning: string | null;
    onCommit: () => void;
    onRollback: () => void;
    activeResultView: "results" | "plan" | "canvas";
    setResultView: (v: "results" | "plan" | "canvas") => void;
    activePlan?: string;
    isExplaining: boolean;
    onExplain: () => void;
    onApplyFix: (sql: string) => Promise<void>;
    hasResult: boolean;
    history: QueryHistoryEntry[];
    onShowHistory: () => void;
    onExport: (format: "csv" | "json", resultOverride?: QueryResult) => void;
    schemaContextForAi: string;
    databaseName: string | null;
    databases: string[];
    selectedSchema: string | null;
    schemas: { name: string }[];
    onSwitchDatabase: (db: string) => void;
    onSwitchSchema: (schema: string | null) => void;
    activeEnvironment: ReturnType<typeof normalizeConnectionEnvironment>;
    strictProductionGuard: boolean;
    isSwitchingDb: boolean;
    connectionId: string | null;
    liveResultMeta: LiveResultMeta | null;
    onRefresh?: () => void;
    activeTabIsExecuting?: boolean;
}

function ResultsArea({
    activeTab,
    isDocumentTab,
    isSandboxMode,
    isSandboxReviewing,
    isSandboxBusy,
    isSandboxCommitting,
    isSandboxRollingBack,
    sandboxResult,
    sandboxPendingSql,
    sandboxElapsed,
    sandboxStatus,
    anomalyWarning,
    onCommit,
    onRollback,
    activeResultView,
    setResultView,
    activePlan,
    isExplaining,
    onExplain,
    onApplyFix,
    hasResult,
    history,
    onShowHistory,
    onExport,
    schemaContextForAi,
    databaseName,
    databases,
    selectedSchema,
    schemas,
    onSwitchDatabase,
    onSwitchSchema,
    activeEnvironment,
    strictProductionGuard,
    isSwitchingDb,
    connectionId,
    liveResultMeta,
    onRefresh,
    activeTabIsExecuting = false,
}: ResultsAreaProps) {
    if (isDocumentTab) {
        return (
            <div className="flex h-full items-center justify-center border-t border-border/20 bg-muted/5 text-muted-foreground">
                <div className="max-w-sm px-6 text-center">
                    <p className="text-sm font-medium text-foreground/80">Notion-style Document</p>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                        This document uses Novel (Tiptap) blocks and is auto-saved as JSON. SQL run results appear only for .sql tabs.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Sandbox diff */}
            {isSandboxReviewing && sandboxResult && (
                <div className="flex-1 overflow-hidden">
                    <SandboxDiffViewer
                        result={sandboxResult}
                        sql={sandboxPendingSql ?? ""}
                        elapsedSecs={sandboxElapsed}
                        anomalyWarning={anomalyWarning}
                        onCommit={onCommit}
                        onRollback={onRollback}
                        isCommitting={isSandboxCommitting}
                        isRollingBack={isSandboxRollingBack}
                    />
                </div>
            )}

            {/* Sandbox busy */}
            {isSandboxBusy && (
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-5 w-5 animate-pulse text-emerald-400" />
                        <span className="text-sm text-muted-foreground">
                            {sandboxStatus === "executing" ? "Running in sandbox transaction…"
                                : sandboxStatus === "committing" ? "Committing changes…"
                                    : "Rolling back changes…"}
                        </span>
                    </div>
                </div>
            )}

            {/* Sandbox ready */}
            {isSandboxMode && sandboxStatus === "ready" && !activeTab.result && (
                <div className="flex-1 flex h-full flex-col items-center justify-center text-muted-foreground">
                    <ShieldCheck className="h-12 w-12 mb-3 opacity-15 text-emerald-400" />
                    <p className="text-sm font-medium">Sandbox mode active</p>
                    <p className="text-xs mt-1 opacity-60">Write SQL above and press ⌘+Enter. Changes won&apos;t be committed until you approve.</p>
                </div>
            )}

            {/* Result view tab switcher */}
            {!isSandboxMode && (activeTab.result || activePlan) && (
                <div className="flex items-center gap-0.5 border-b border-border/20 bg-muted/20 px-2 shrink-0">
                    {(["results", "plan", "canvas"] as const).map((view) => {
                        if (view === "plan" && !activePlan) return null;
                        if (view === "canvas" && (!activeTab.result || activeTab.result.is_error || activeTab.result.columns.length === 0 || isCommandResult(activeTab.result) || isMultiStatementResult(activeTab.result))) return null;
                        return (
                            <button
                                key={view}
                                onClick={() => setResultView(view)}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium border-b-2 transition-colors -mb-px capitalize",
                                    activeResultView === view
                                        ? "border-primary text-foreground"
                                        : "border-transparent text-muted-foreground hover:text-foreground/80"
                                )}
                            >
                                {view === "plan" && <GitBranch className="h-3 w-3" />}
                                {view === "canvas" && <LayoutDashboard className="h-3 w-3" />}
                                {view}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Plan view */}
            {!isSandboxMode && activeResultView === "plan" && activePlan && (
                <div className="flex-1 overflow-hidden">
                    <QueryPlanViewer rawJson={activePlan} onApplyFix={onApplyFix} />
                </div>
            )}

            {/* Explain loading */}
            {!isSandboxMode && activeResultView === "plan" && isExplaining && (
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                        <span className="text-sm text-muted-foreground">Analysing query plan…</span>
                    </div>
                </div>
            )}

            {/* Canvas view */}
            {!isSandboxMode && activeResultView === "canvas" && activeTab.result && !activeTab.result.is_error && (
                <div className="flex-1 overflow-hidden">
                    <DataCanvas result={activeTab.result} />
                </div>
            )}

            {/* Results view */}
            {!isSandboxMode && activeResultView === "results" && activeTab.result ? (
                activeTab.result.is_error ? (
                    <QueryErrorPanel
                        message={activeTab.result.error_message ?? "Unknown error"}
                        sql={activeTab.sql}
                        schemaContextForAi={schemaContextForAi}
                        onRetry={onRefresh}
                        isRetrying={activeTabIsExecuting}
                    />
                ) : (
                    <div className="flex h-full min-h-0 flex-col">
                        {liveResultMeta && (
                            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-cyan-500/20 bg-cyan-500/10 shrink-0">
                                <p className="text-[11px] text-cyan-100/90">
                                    Live result shared by <span className="font-medium text-cyan-100">{liveResultMeta.updatedByName}</span>{" "}
                                    at {new Date(liveResultMeta.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </p>
                                {liveResultMeta.truncated && (
                                    <Badge
                                        variant="outline"
                                        className="border-cyan-400/30 bg-cyan-500/10 text-[10px] text-cyan-100"
                                    >
                                        Preview {liveResultMeta.previewRows.toLocaleString()} rows
                                    </Badge>
                                )}
                            </div>
                        )}

                        {/* Slow query banner */}
                        {activeTab.result.execution_time_ms > 500 && (
                            <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-amber-500/5 border-b border-amber-500/15 shrink-0">
                                <div className="flex items-center gap-2">
                                    <AlertCircle className="h-3 w-3 text-amber-500 shrink-0" />
                                    <span className="text-[11px] text-muted-foreground">Slow query ({activeTab.result.execution_time_ms.toFixed(0)}ms)</span>
                                </div>
                                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shrink-0" onClick={onExplain} disabled={isExplaining}>
                                    {isExplaining ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                                    Explain
                                </Button>
                            </div>
                        )}

                        {isCommandResult(activeTab.result) || isMultiStatementResult(activeTab.result) ? (
                            <div className="flex-1 flex items-center justify-center p-6">
                                <p className="text-sm text-muted-foreground">
                                    {isMultiStatementResult(activeTab.result)
                                        ? `${getDisplayCount(activeTab.result)} statement${getDisplayCount(activeTab.result) !== 1 ? "s" : ""} executed successfully.`
                                        : `${getDisplayCount(activeTab.result).toLocaleString()} row${getDisplayCount(activeTab.result) !== 1 ? "s" : ""} affected.`}
                                </p>
                            </div>
                        ) : (
                            <QueryResultView
                                result={activeTab.result}
                                onExport={(format, resultOverride) => onExport(format, resultOverride)}
                                connectionId={connectionId}
                                editableTable={(() => {
                                    const q = activeTab.result?.query ?? activeTab.sql ?? "";
                                    return parseSingleTableFromSql(q);
                                })()}
                                onRefresh={onRefresh}
                                className="flex-1 min-h-0"
                            />
                        )}
                    </div>
                )
            ) : null}

            {/* Executing */}
            {!isSandboxMode && activeResultView === "results" && activeTab.isExecuting && !activeTab.result && (
                <div className="flex-1 flex items-center justify-center min-h-[200px] animate-in fade-in duration-200">
                    <div className="flex flex-col items-center gap-5">
                        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/15 to-cyan-500/10 border border-emerald-500/25 shadow-lg shadow-emerald-500/5">
                            <Loader2 className="h-7 w-7 animate-spin text-emerald-500" />
                            <div className="absolute inset-0 rounded-2xl bg-emerald-500/5 animate-pulse" aria-hidden />
                        </div>
                        <div className="text-center space-y-1">
                            <p className="text-sm font-medium text-foreground/90">Executing query…</p>
                            <p className="text-xs text-muted-foreground/60">Results will appear here</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty state */}
            {!isSandboxMode && activeResultView === "results" && !activeTab.result && !activeTab.isExecuting && (
                <div className="flex-1 flex h-full flex-col items-center justify-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-4">
                        <div className="rounded-2xl border border-border/30 bg-muted/20 p-6 flex flex-col items-center gap-3">
                            <Terminal className="h-10 w-10 opacity-20" />
                            <p className="text-sm font-medium text-foreground/80">Run a query</p>
                            <p className="text-xs opacity-70">Write SQL above and press</p>
                            <div className="flex items-center gap-1.5">
                                <kbd className="px-2 py-1 rounded-md bg-muted/80 font-mono text-[11px] border border-border/50 text-foreground/80">⌘</kbd>
                                <span className="text-muted-foreground/60">+</span>
                                <kbd className="px-2 py-1 rounded-md bg-muted/80 font-mono text-[11px] border border-border/50 text-foreground/80">Enter</kbd>
                            </div>
                        </div>
                        {history.length > 0 && (
                            <button onClick={onShowHistory} className="text-xs text-muted-foreground/50 hover:text-muted-foreground flex items-center gap-1.5 transition-colors">
                                <GitBranch className="h-3 w-3" />
                                View query history
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Status bar */}
            <StatusBar
                databaseName={databaseName}
                databases={databases}
                selectedSchema={selectedSchema}
                schemas={schemas}
                onSwitchDatabase={onSwitchDatabase}
                onSwitchSchema={onSwitchSchema}
                activeEnvironment={activeEnvironment}
                strictProductionGuard={strictProductionGuard}
                isSwitchingDb={isSwitchingDb}
                connectionId={connectionId}
                result={activeTab.result}
            />
        </div>
    );
}

// ── Status bar ────────────────────────────────────────────────────────────

interface StatusBarProps {
    databaseName: string | null;
    databases: string[];
    selectedSchema: string | null;
    schemas: { name: string }[];
    onSwitchDatabase: (db: string) => void;
    onSwitchSchema: (schema: string | null) => void;
    activeEnvironment: ReturnType<typeof normalizeConnectionEnvironment>;
    strictProductionGuard: boolean;
    isSwitchingDb: boolean;
    connectionId: string | null;
    result: QueryResult | null;
}

function StatusBar({
    databaseName,
    databases,
    selectedSchema,
    schemas,
    onSwitchDatabase,
    onSwitchSchema,
    activeEnvironment,
    strictProductionGuard,
    isSwitchingDb,
    connectionId,
    result,
}: StatusBarProps) {
    const [dbOpen, setDbOpen] = useState(false);
    const [schemaOpen, setSchemaOpen] = useState(false);

    if (!connectionId) return null;

    return (
        <div className="flex items-center gap-2 px-3 py-1 border-t border-border/20 bg-background shrink-0 text-[11px]">
            {/* DB switcher */}
            <Popover open={dbOpen} onOpenChange={setDbOpen}>
                <PopoverTrigger asChild>
                    <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors">
                        {isSwitchingDb ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <Database className="h-3 w-3" />
                        )}
                        <span className="font-mono">{databaseName ?? "—"}</span>
                        <ChevronDown className="h-3 w-3 opacity-50" />
                    </button>
                </PopoverTrigger>
                <PopoverContent className="w-52 p-1" align="start" side="top">
                    <p className="text-[10px] font-medium text-muted-foreground/60 px-2 py-1 uppercase tracking-widest">Switch database</p>
                    <ScrollArea className="max-h-48">
                        {databases.length === 0 ? (
                            <p className="text-xs text-muted-foreground/40 px-2 py-2">No databases listed</p>
                        ) : (
                            databases.map((db) => (
                                <button
                                    key={db}
                                    className={cn(
                                        "w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent transition-colors",
                                        db === databaseName ? "text-primary font-medium" : "text-foreground/80"
                                    )}
                                    onClick={() => { onSwitchDatabase(db); setDbOpen(false); }}
                                >
                                    {db}
                                </button>
                            ))
                        )}
                    </ScrollArea>
                </PopoverContent>
            </Popover>

            <span className="text-muted-foreground/20">/</span>

            {/* Schema switcher */}
            <Popover open={schemaOpen} onOpenChange={setSchemaOpen}>
                <PopoverTrigger asChild>
                    <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors">
                        <span className="font-mono">{selectedSchema ?? "public"}</span>
                        <ChevronDown className="h-3 w-3 opacity-50" />
                    </button>
                </PopoverTrigger>
                <PopoverContent className="w-44 p-1" align="start" side="top">
                    <p className="text-[10px] font-medium text-muted-foreground/60 px-2 py-1 uppercase tracking-widest">Switch schema</p>
                    <ScrollArea className="max-h-40">
                        {schemas.map((s) => (
                            <button
                                key={s.name}
                                className={cn(
                                    "w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent transition-colors",
                                    s.name === selectedSchema ? "text-primary font-medium" : "text-foreground/80"
                                )}
                                onClick={() => { onSwitchSchema(s.name); setSchemaOpen(false); }}
                            >
                                {s.name}
                            </button>
                        ))}
                    </ScrollArea>
                </PopoverContent>
            </Popover>

            <span className="flex-1" />

            {/* Result count */}
            {result && !result.is_error && (
                <span className="text-muted-foreground/50 font-mono">
                    {result.row_count.toLocaleString()} row{result.row_count !== 1 ? "s" : ""}
                </span>
            )}

            {/* Env badge */}
            <ConnectionEnvBadge environment={activeEnvironment} compact />

            {strictProductionGuard && activeEnvironment === "prod" && (
                <Badge variant="outline" className="h-4 px-1 text-[9px] border-red-500/30 text-red-300 bg-red-500/10">Guard</Badge>
            )}
        </div>
    );
}
