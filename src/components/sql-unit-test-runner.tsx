"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import Editor from "@monaco-editor/react";
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from "recharts";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import {
    ArrowLeft,
    ArrowRight,
    BarChart3,
    Bot,
    CheckCircle2,
    Database,
    Eraser,
    FileCode2,
    FlaskConical,
    Layers3,
    Loader2,
    Play,
    Plus,
    RefreshCw,
    Search,
    ShieldCheck,
    Sparkles,
    Square,
    Wand2,
    XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useQueryStore } from "@/stores/query-store";
import { resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import { generateSqlUnitTestScriptWithAI } from "@/lib/sql-unit-test-ai";
import {
    formatTestCaseSnippet,
    generateAutoTableTestSource,
    generateTestFromResult,
    parseSqlUnitTestSource,
    renderTestReport,
    runTestSuite,
    type SqlAutoTableTarget,
    type SqlTestCase,
    type SqlTestResult,
} from "@/lib/sql-unit-tests";

const EDITOR_STORAGE_KEY = "helix-sql-unit-test-source-v2";
const TABLE_PAGE_SIZE = 10;
const UNIT_TEST_DSL_LIB_URI = "file:///helix-sql-unit-test-dsl.d.ts";
const UNIT_TEST_DSL_LIB = `
declare type SqlTestPrimitive = string | number | boolean | null;
declare interface SqlTestExpected {
  rowCount?: number;
  columnValues?: Record<string, SqlTestPrimitive[]>;
  errorIncludes?: string;
}
declare interface SqlTestCase {
  id: string;
  name: string;
  sql: string;
  expected: SqlTestExpected;
  createdAt: number;
}
declare interface QueryResultLike {
  query: string;
  row_count: number;
  columns: Array<{ name: string }>;
  rows: unknown[][];
  is_error: boolean;
  error_message?: string | null;
}
declare function createTestCase(name: string, sql: string, expected?: SqlTestExpected): SqlTestCase;
declare function assertRowCount(sql: string, expected: number, name?: string): SqlTestCase;
declare function assertColumnValues(sql: string, column: string, expected: SqlTestPrimitive[], name?: string): SqlTestCase;
declare function generateTestFromResult(queryResult: QueryResultLike, name?: string): SqlTestCase;
declare function runTestSuite(testCases: SqlTestCase[]): SqlTestCase[];
`;

type RunnerStep = "generator" | "editor" | "report";
type GenerationMode = "replace" | "append";

const STEP_ORDER: Array<{ id: RunnerStep; title: string; subtitle: string; icon: React.ComponentType<{ className?: string }> }> = [
    {
        id: "generator",
        title: "1. Auto Builder",
        subtitle: "Select tables and generate tests",
        icon: Layers3,
    },
    {
        id: "editor",
        title: "2. Source Editor",
        subtitle: "Edit DSL and validate suite",
        icon: FileCode2,
    },
    {
        id: "report",
        title: "3. Run & Report",
        subtitle: "Execute and inspect failures",
        icon: BarChart3,
    },
];

const DEFAULT_TEST_SOURCE = `// SQL Unit Test DSL
// Available helpers:
//   createTestCase(name, sql, expected)
//   assertRowCount(sql, expected)
//   assertColumnValues(sql, column, expectedArray)
//   runTestSuite(testCases)

const selectSmoke = createTestCase(
    "SELECT smoke test",
    \`
SELECT x
FROM (VALUES (1), (2), (3)) AS t(x)
ORDER BY x;
    \`,
    {
        rowCount: 3,
        columnValues: {
            x: [1, 2, 3],
        },
    }
);

const insertRows = assertRowCount(
    \`
CREATE TEMP TABLE ut_insert(id INT);
INSERT INTO ut_insert(id) VALUES (1), (2);
    \`,
    2
);

runTestSuite([selectSmoke, insertRows]);`;

interface ProgressState {
    completed: number;
    total: number;
}

function formatMs(value: number): string {
    if (!Number.isFinite(value)) return "0ms";
    if (value < 1) return `${value.toFixed(2)}ms`;
    if (value < 1000) return `${value.toFixed(1)}ms`;
    return `${(value / 1000).toFixed(2)}s`;
}

function tableKey(schema: string, table: string): string {
    return `${schema}.${table}`;
}

export function SqlUnitTestRunner() {
    const { resolvedTheme } = useTheme();
    const { connectionId, databaseName, tables } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            databaseName: state.databaseName,
            tables: state.tables,
        }))
    );
    const { tabs, activeTabId } = useQueryStore(
        useShallow((state) => ({
            tabs: state.tabs,
            activeTabId: state.activeTabId,
        }))
    );
    const { geminiApiKey, defaultAiModel } = useSettingsStore(
        useShallow((state) => ({
            geminiApiKey: state.geminiApiKey,
            defaultAiModel: state.defaultAiModel,
        }))
    );

    const activeQueryResult = useMemo(
        () => tabs.find((tab) => tab.id === activeTabId)?.result ?? null,
        [tabs, activeTabId]
    );

    const sortedTables = useMemo(
        () =>
            [...tables].sort((a, b) => {
                if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
                return a.name.localeCompare(b.name);
            }),
        [tables]
    );

    const [activeStep, setActiveStep] = useState<RunnerStep>("generator");

    const [source, setSource] = useState(DEFAULT_TEST_SOURCE);
    const [parsedCases, setParsedCases] = useState<SqlTestCase[]>([]);
    const [parseWarnings, setParseWarnings] = useState<string[]>([]);
    const [parseError, setParseError] = useState<string | null>(null);
    const [parseErrorLine, setParseErrorLine] = useState<number | null>(null);
    const [parseErrorColumn, setParseErrorColumn] = useState<number | null>(null);

    const [results, setResults] = useState<SqlTestResult[]>([]);
    const [progress, setProgress] = useState<ProgressState>({ completed: 0, total: 0 });
    const [isRunning, setIsRunning] = useState(false);
    const [selectedResultId, setSelectedResultId] = useState<string | null>(null);

    const [aiPrompt, setAiPrompt] = useState(
        "Create pgTAP-style SQL coverage for all key tables: read smoke tests, metadata checks, and common failure guards."
    );
    const [isAiGenerating, setIsAiGenerating] = useState(false);

    const [tableSearch, setTableSearch] = useState("");
    const [tablePage, setTablePage] = useState(1);
    const [selectedTableKeys, setSelectedTableKeys] = useState<string[]>([]);
    const [includeMetadataCheck, setIncludeMetadataCheck] = useState(true);
    const [includeReadSmoke, setIncludeReadSmoke] = useState(true);
    const [generationMode, setGenerationMode] = useState<GenerationMode>("replace");

    const abortRef = useRef<AbortController | null>(null);
    const dslLibRegisteredRef = useRef(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const raw = localStorage.getItem(EDITOR_STORAGE_KEY);
        if (raw) setSource(raw);
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        localStorage.setItem(EDITOR_STORAGE_KEY, source);
    }, [source]);

    const selectedTableKeySet = useMemo(() => new Set(selectedTableKeys), [selectedTableKeys]);

    const filteredTables = useMemo(() => {
        const token = tableSearch.trim().toLowerCase();
        if (!token) return sortedTables;
        return sortedTables.filter((table) => {
            const label = `${table.schema}.${table.name}`.toLowerCase();
            return label.includes(token);
        });
    }, [sortedTables, tableSearch]);

    const totalTablePages = useMemo(
        () => Math.max(1, Math.ceil(filteredTables.length / TABLE_PAGE_SIZE)),
        [filteredTables.length]
    );

    const tablePageRows = useMemo(() => {
        const start = (tablePage - 1) * TABLE_PAGE_SIZE;
        return filteredTables.slice(start, start + TABLE_PAGE_SIZE);
    }, [filteredTables, tablePage]);

    useEffect(() => {
        setTablePage((prev) => Math.min(prev, totalTablePages));
    }, [totalTablePages]);

    const tableSignature = useMemo(
        () => sortedTables.map((table) => tableKey(table.schema, table.name)).join("|"),
        [sortedTables]
    );

    useEffect(() => {
        const availableKeys = new Set(sortedTables.map((table) => tableKey(table.schema, table.name)));
        setSelectedTableKeys((prev) => {
            const kept = prev.filter((key) => availableKeys.has(key));
            if (kept.length > 0) return kept;
            return sortedTables.map((table) => tableKey(table.schema, table.name));
        });
    }, [tableSignature, sortedTables]);

    const selectedTables = useMemo(
        () =>
            sortedTables.filter((table) => selectedTableKeySet.has(tableKey(table.schema, table.name))),
        [sortedTables, selectedTableKeySet]
    );

    const selectedResult = useMemo(
        () => results.find((result) => result.id === selectedResultId) ?? null,
        [results, selectedResultId]
    );

    const report = useMemo(() => renderTestReport(results), [results]);

    const schemaSummaryForAi = useMemo(() => {
        const sourceTables = selectedTables.length > 0 ? selectedTables : sortedTables;
        if (sourceTables.length === 0) return "";
        return sourceTables
            .slice(0, 240)
            .map((table) => `${table.schema}.${table.name} (${table.row_count.toLocaleString()} rows)`)
            .join("\n");
    }, [selectedTables, sortedTables]);

    useEffect(() => {
        if (results.length === 0) {
            setSelectedResultId(null);
            return;
        }
        if (selectedResultId && results.some((result) => result.id === selectedResultId)) return;
        const firstFailure = results.find((result) => !result.passed);
        setSelectedResultId(firstFailure?.id ?? results[0].id);
    }, [results, selectedResultId]);

    const parseSource = useCallback(
        (notify = false) => {
            const parsed = parseSqlUnitTestSource(source);
            setParsedCases(parsed.testCases);
            setParseWarnings(parsed.warnings);
            setParseError(parsed.error);
            setParseErrorLine(parsed.errorLine ?? null);
            setParseErrorColumn(parsed.errorColumn ?? null);

            if (!notify) return parsed;

            if (parsed.error) {
                const location =
                    parsed.errorLine !== undefined
                        ? ` (line ${parsed.errorLine}${parsed.errorColumn !== undefined ? `, col ${parsed.errorColumn}` : ""})`
                        : "";
                toast.error(`Validation failed${location}: ${parsed.error}`);
            } else if (parsed.testCases.length === 0) {
                toast.warning("No tests found. Add test cases or generate from tables.");
            } else {
                toast.success(`Validated ${parsed.testCases.length} tests.`, { duration: 1500 });
                if (parsed.warnings.length > 0) {
                    toast.warning(parsed.warnings[0], { duration: 2400 });
                }
            }

            return parsed;
        },
        [source]
    );

    const handleEditorBeforeMount = useCallback((monaco: typeof import("monaco-editor")) => {
        if (dslLibRegisteredRef.current) return;

        const tsApi = (monaco as unknown as {
            languages?: {
                typescript?: {
                    javascriptDefaults?: {
                        setDiagnosticsOptions: (options: {
                            noSemanticValidation?: boolean;
                            noSyntaxValidation?: boolean;
                        }) => void;
                        addExtraLib: (content: string, filePath?: string) => void;
                    };
                };
            };
        }).languages?.typescript?.javascriptDefaults;

        if (!tsApi) return;
        tsApi.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
        });
        tsApi.addExtraLib(UNIT_TEST_DSL_LIB, UNIT_TEST_DSL_LIB_URI);
        dslLibRegisteredRef.current = true;
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            parseSource(false);
        }, 160);
        return () => window.clearTimeout(timer);
    }, [source, parseSource]);

    const executeCases = useCallback(
        async (testCases: SqlTestCase[], runLabel: string) => {
            if (!connectionId) {
                toast.error("Connect to a database before running SQL unit tests.");
                return;
            }
            if (testCases.length === 0) {
                toast.warning("No test cases to run.");
                return;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            setIsRunning(true);
            setProgress({ completed: 0, total: testCases.length });
            setResults([]);
            setActiveStep("report");

            try {
                const finalResults = await runTestSuite(testCases, {
                    connectionId,
                    signal: controller.signal,
                    onProgress: (result, completed, total) => {
                        setResults((prev) => [...prev, result]);
                        setProgress({ completed, total });
                    },
                });

                const passed = finalResults.filter((result) => result.passed).length;
                const failed = finalResults.length - passed;
                toast.success(
                    `${runLabel} complete: ${passed}/${finalResults.length} passed${failed ? `, ${failed} failed` : ""}.`,
                    { duration: 2600 }
                );
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    toast.info("Test run cancelled.");
                } else {
                    toast.error(error instanceof Error ? error.message : String(error));
                }
            } finally {
                abortRef.current = null;
                setIsRunning(false);
            }
        },
        [connectionId]
    );

    const handleRunAll = useCallback(async () => {
        const parsed = parseSource(true);
        if (parsed.error || parsed.testCases.length === 0) return;
        await executeCases(parsed.testCases, "Run all tests");
    }, [executeCases, parseSource]);

    const handleRunSingle = useCallback(
        async (testCase: SqlTestCase) => {
            await executeCases([testCase], `Test ${testCase.name}`);
        },
        [executeCases]
    );

    const handleCancelRun = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const handleClearResults = useCallback(() => {
        setResults([]);
        setProgress({ completed: 0, total: 0 });
        setSelectedResultId(null);
    }, []);

    const handleResetTemplate = useCallback(() => {
        setSource(DEFAULT_TEST_SOURCE);
        setActiveStep("editor");
        toast.success("Template restored.");
    }, []);

    const toggleTableSelection = useCallback((key: string, checked: boolean) => {
        setSelectedTableKeys((prev) => {
            if (checked) {
                if (prev.includes(key)) return prev;
                return [...prev, key];
            }
            return prev.filter((entry) => entry !== key);
        });
    }, []);

    const handleSelectAllPage = useCallback(() => {
        const pageKeys = tablePageRows.map((table) => tableKey(table.schema, table.name));
        setSelectedTableKeys((prev) => Array.from(new Set([...prev, ...pageKeys])));
    }, [tablePageRows]);

    const handleClearPageSelection = useCallback(() => {
        const pageSet = new Set(tablePageRows.map((table) => tableKey(table.schema, table.name)));
        setSelectedTableKeys((prev) => prev.filter((key) => !pageSet.has(key)));
    }, [tablePageRows]);

    const handleSelectAllFiltered = useCallback(() => {
        const filteredKeys = filteredTables.map((table) => tableKey(table.schema, table.name));
        setSelectedTableKeys((prev) => Array.from(new Set([...prev, ...filteredKeys])));
    }, [filteredTables]);

    const handleAutoGenerateFromTables = useCallback(
        (scope: "selected" | "all") => {
            const baseTables = scope === "all" ? sortedTables : selectedTables;
            if (baseTables.length === 0) {
                toast.warning("No tables selected for auto generation.");
                return;
            }

            const targets: SqlAutoTableTarget[] = baseTables.map((table) => ({
                schema: table.schema,
                name: table.name,
                rowCount: table.row_count,
            }));

            const generated = generateAutoTableTestSource(targets, {
                includeMetadataCheck,
                includeReadSmoke,
            });

            if (generationMode === "append" && source.trim()) {
                setSource((prev) => `${prev.trimEnd()}\n\n${generated}`);
            } else {
                setSource(generated);
            }

            setActiveStep("editor");
            toast.success(
                `Generated ${targets.length.toLocaleString()} table test block(s).`,
                { duration: 2200 }
            );
        },
        [sortedTables, selectedTables, includeMetadataCheck, includeReadSmoke, generationMode, source]
    );

    const handleGenerateFromActiveResult = useCallback(() => {
        if (!activeQueryResult) {
            toast.error("Run a query in Query view first to generate a test.");
            return;
        }

        try {
            const generatedTest = generateTestFromResult(activeQueryResult, "Generated from active query result");
            const snippet = formatTestCaseSnippet(generatedTest);
            setSource((prev) => `${prev.trimEnd()}\n\n${snippet}\n`);
            setActiveStep("editor");
            toast.success("Generated test appended to source.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }, [activeQueryResult]);

    const handleAiGenerate = useCallback(async () => {
        if (isAiGenerating || isRunning) return;
        setIsAiGenerating(true);
        try {
            const generatedSource = await generateSqlUnitTestScriptWithAI({
                prompt: aiPrompt,
                schemaSummary: schemaSummaryForAi,
                existingScript: source,
                apiKey: resolveGeminiApiKey(geminiApiKey),
                model: defaultAiModel,
            });

            if (generationMode === "append" && source.trim()) {
                setSource((prev) => `${prev.trimEnd()}\n\n${generatedSource}`);
            } else {
                setSource(generatedSource);
            }

            setActiveStep("editor");
            toast.success("AI generated SQL unit test source.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setIsAiGenerating(false);
        }
    }, [
        aiPrompt,
        schemaSummaryForAi,
        source,
        geminiApiKey,
        defaultAiModel,
        generationMode,
        isAiGenerating,
        isRunning,
    ]);

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-gradient-to-br from-cyan-500/10 via-background to-emerald-500/10">
            <div className="shrink-0 border-b border-border/30 bg-card/55 px-4 py-3 backdrop-blur-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                        <div className="flex items-center gap-2">
                            <div className="rounded-lg border border-cyan-400/40 bg-cyan-500/10 p-1.5">
                                <FlaskConical className="h-4 w-4 text-cyan-300" />
                            </div>
                            <h2 className="text-sm font-semibold text-foreground/95">SQL Unit Test Studio</h2>
                            <Badge variant="outline" className="border-emerald-400/40 bg-emerald-500/10 text-[10px] text-emerald-200">
                                Transaction rollback safe
                            </Badge>
                            <Badge variant="outline" className="border-cyan-400/40 bg-cyan-500/10 text-[10px] text-cyan-100">
                                pgTAP-inspired workflow
                            </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground/80">
                            Guided page-by-page flow: generate tests from tables, edit source, then run and inspect pass/fail diagnostics.
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/80">
                            <span className="inline-flex items-center gap-1">
                                <Database className="h-3.5 w-3.5 text-cyan-300" />
                                DB: <span className="font-mono text-foreground/90">{databaseName ?? "not connected"}</span>
                            </span>
                            <span className="text-muted-foreground/40">|</span>
                            <span>{selectedTables.length.toLocaleString()} tables selected</span>
                            <span className="text-muted-foreground/40">|</span>
                            <span>{progress.total > 0 ? `${progress.completed}/${progress.total} executed` : "No active run"}</span>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5 border-border/45 bg-card/40"
                            onClick={() => parseSource(true)}
                            disabled={isRunning || isAiGenerating}
                        >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Validate Source
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5 border-cyan-400/35 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20"
                            onClick={handleGenerateFromActiveResult}
                            disabled={isRunning || isAiGenerating}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            From Active Result
                        </Button>
                        {isRunning ? (
                            <Button size="sm" className="h-8 gap-1.5 bg-rose-600 text-white hover:bg-rose-500" onClick={handleCancelRun}>
                                <Square className="h-3.5 w-3.5" />
                                Stop
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                className="h-8 gap-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 text-white hover:from-emerald-500 hover:to-cyan-500"
                                onClick={handleRunAll}
                                disabled={isAiGenerating}
                            >
                                <Play className="h-3.5 w-3.5" />
                                Run All
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <div className="shrink-0 border-b border-border/25 bg-card/30 p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    {STEP_ORDER.map((step) => {
                        const Icon = step.icon;
                        const active = activeStep === step.id;
                        return (
                            <button
                                key={step.id}
                                className={cn(
                                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                                    active
                                        ? "border-cyan-400/45 bg-cyan-500/12"
                                        : "border-border/35 bg-background/35 hover:bg-background/55"
                                )}
                                onClick={() => setActiveStep(step.id)}
                            >
                                <div className="flex items-center gap-2">
                                    <Icon className={cn("h-4 w-4", active ? "text-cyan-300" : "text-muted-foreground")} />
                                    <p className={cn("text-xs font-semibold", active ? "text-cyan-100" : "text-foreground/90")}>{step.title}</p>
                                </div>
                                <p className="mt-1 text-[11px] text-muted-foreground/80">{step.subtitle}</p>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto p-3">
                {activeStep === "generator" && (
                    <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
                        <Card className="border-border/35 bg-card/50">
                            <CardHeader className="py-3">
                                <CardTitle className="text-sm">Table Selection (Paged)</CardTitle>
                                <CardDescription>
                                    Pick the tables to auto-generate SQL unit tests. Default is all tables.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 pt-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="relative min-w-[240px] flex-1">
                                        <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground/60" />
                                        <Input
                                            value={tableSearch}
                                            onChange={(event) => {
                                                setTableSearch(event.target.value);
                                                setTablePage(1);
                                            }}
                                            placeholder="Search schema.table"
                                            className="h-8 pl-8 text-xs"
                                        />
                                    </div>
                                    <Badge variant="outline" className="h-8 px-2 text-[11px]">
                                        {filteredTables.length.toLocaleString()} visible
                                    </Badge>
                                    <Badge variant="outline" className="h-8 px-2 text-[11px]">
                                        {selectedTables.length.toLocaleString()} selected
                                    </Badge>
                                </div>

                                <div className="flex flex-wrap items-center gap-1.5">
                                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={handleSelectAllPage}>
                                        Select page
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={handleClearPageSelection}>
                                        Clear page
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={handleSelectAllFiltered}>
                                        Select filtered
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-[11px]"
                                        onClick={() => setSelectedTableKeys([])}
                                    >
                                        Clear all
                                    </Button>
                                </div>

                                <div className="rounded-lg border border-border/30 bg-background/25">
                                    <ScrollArea className="h-[320px]">
                                        <div className="divide-y divide-border/20">
                                            {tablePageRows.length === 0 ? (
                                                <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">No tables on this page.</p>
                                            ) : (
                                                tablePageRows.map((table) => {
                                                    const key = tableKey(table.schema, table.name);
                                                    const checked = selectedTableKeySet.has(key);
                                                    return (
                                                        <label
                                                            key={key}
                                                            className="flex cursor-pointer items-center gap-2 px-3 py-2.5 hover:bg-background/40"
                                                        >
                                                            <Checkbox
                                                                checked={checked}
                                                                onCheckedChange={(value) => toggleTableSelection(key, value === true)}
                                                            />
                                                            <div className="min-w-0 flex-1">
                                                                <p className="truncate text-xs font-medium text-foreground/90">{table.schema}.{table.name}</p>
                                                                <p className="text-[10px] text-muted-foreground/65">
                                                                    {table.row_count.toLocaleString()} rows
                                                                </p>
                                                            </div>
                                                        </label>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </ScrollArea>
                                </div>

                                <div className="flex items-center justify-between rounded-md border border-border/25 bg-background/20 px-2 py-1.5">
                                    <span className="text-[11px] text-muted-foreground/80">
                                        Page {tablePage} of {totalTablePages}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => setTablePage((prev) => Math.max(1, prev - 1))}
                                            disabled={tablePage <= 1}
                                        >
                                            <ArrowLeft className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => setTablePage((prev) => Math.min(totalTablePages, prev + 1))}
                                            disabled={tablePage >= totalTablePages}
                                        >
                                            <ArrowRight className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <div className="space-y-3">
                            <Card className="border-border/35 bg-card/50">
                                <CardHeader className="py-3">
                                    <CardTitle className="text-sm">Auto Generate Tests</CardTitle>
                                    <CardDescription>
                                        Create deterministic, readable table checks in one click.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3 pt-0">
                                    <div className="space-y-2 rounded-md border border-border/30 bg-background/25 p-2.5">
                                        <label className="flex items-center gap-2 text-xs">
                                            <Checkbox checked={includeMetadataCheck} onCheckedChange={(v) => setIncludeMetadataCheck(v === true)} />
                                            Include metadata checks (table exists + has columns)
                                        </label>
                                        <label className="flex items-center gap-2 text-xs">
                                            <Checkbox checked={includeReadSmoke} onCheckedChange={(v) => setIncludeReadSmoke(v === true)} />
                                            Include read smoke tests (SELECT * LIMIT 25)
                                        </label>
                                    </div>

                                    <div className="space-y-2 rounded-md border border-border/30 bg-background/25 p-2.5">
                                        <p className="text-[11px] font-medium text-foreground/85">Write mode</p>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                className={cn(
                                                    "rounded-md px-2.5 py-1 text-[11px] border",
                                                    generationMode === "replace"
                                                        ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-100"
                                                        : "border-border/35 text-muted-foreground"
                                                )}
                                                onClick={() => setGenerationMode("replace")}
                                            >
                                                Replace source
                                            </button>
                                            <button
                                                className={cn(
                                                    "rounded-md px-2.5 py-1 text-[11px] border",
                                                    generationMode === "append"
                                                        ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-100"
                                                        : "border-border/35 text-muted-foreground"
                                                )}
                                                onClick={() => setGenerationMode("append")}
                                            >
                                                Append source
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-2">
                                        <Button
                                            className="h-8 gap-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 text-white hover:from-emerald-500 hover:to-cyan-500"
                                            onClick={() => handleAutoGenerateFromTables("selected")}
                                            disabled={isRunning || isAiGenerating}
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            Generate for Selected Tables
                                        </Button>
                                        <Button
                                            variant="outline"
                                            className="h-8 gap-1.5 border-emerald-400/35 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                                            onClick={() => handleAutoGenerateFromTables("all")}
                                            disabled={isRunning || isAiGenerating}
                                        >
                                            <Database className="h-3.5 w-3.5" />
                                            Generate for All Tables
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="border-border/35 bg-card/50">
                                <CardHeader className="py-3">
                                    <CardTitle className="flex items-center gap-2 text-sm">
                                        <Bot className="h-4 w-4 text-cyan-300" />
                                        AI SQL Test Writer
                                    </CardTitle>
                                    <CardDescription>
                                        Generate stronger edge-case coverage from schema context.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-2 pt-0">
                                    <Input
                                        value={aiPrompt}
                                        onChange={(event) => setAiPrompt(event.target.value)}
                                        className="h-8 text-xs"
                                        placeholder="Describe coverage: e.g. pgTAP-like tests for orders and users"
                                        disabled={isRunning || isAiGenerating}
                                    />
                                    <Button
                                        className="h-8 w-full gap-1.5 bg-cyan-600 text-white hover:bg-cyan-500"
                                        onClick={handleAiGenerate}
                                        disabled={isRunning || isAiGenerating}
                                    >
                                        {isAiGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                                        Generate with AI
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                )}

                {activeStep === "editor" && (
                    <div className="space-y-3">
                        <Card className="border-border/35 bg-card/50">
                            <CardHeader className="py-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <CardTitle className="text-sm">Test Source Editor</CardTitle>
                                        <CardDescription>
                                            Use DSL helpers or generated code. Validate before execution.
                                        </CardDescription>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 px-2 text-[11px]"
                                            onClick={() => parseSource(true)}
                                            disabled={isRunning || isAiGenerating}
                                        >
                                            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                                            Validate
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 px-2 text-[11px]"
                                            onClick={handleResetTemplate}
                                            disabled={isRunning || isAiGenerating}
                                        >
                                            <Eraser className="mr-1 h-3.5 w-3.5" />
                                            Reset
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-2 pt-0">
                                <div className="h-[52vh] min-h-[290px] overflow-hidden rounded-lg border border-border/30">
                                    <Editor
                                        value={source}
                                        onChange={(value) => setSource(value ?? "")}
                                        language="javascript"
                                        theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                                        beforeMount={handleEditorBeforeMount}
                                        options={{
                                            minimap: { enabled: false },
                                            fontSize: 13,
                                            lineNumbers: "on",
                                            scrollBeyondLastLine: false,
                                            wordWrap: "on",
                                            tabSize: 4,
                                            insertSpaces: true,
                                            automaticLayout: true,
                                        }}
                                    />
                                </div>

                                {(parseError || parseWarnings.length > 0) && (
                                    <div className="space-y-2">
                                        {parseError && (
                                            <div className="rounded-md border border-rose-500/35 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-100">
                                                {parseError}
                                                {(parseErrorLine || parseErrorColumn) && (
                                                    <span className="ml-1 text-rose-100/85">
                                                        (line {parseErrorLine ?? "?"}, col {parseErrorColumn ?? "?"})
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {parseWarnings.map((warning) => (
                                            <div
                                                key={warning}
                                                className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100"
                                            >
                                                {warning}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card className="border-border/35 bg-card/50">
                            <CardHeader className="py-3">
                                <div className="flex items-center justify-between gap-2">
                                    <CardTitle className="text-sm">Discovered Tests</CardTitle>
                                    <Badge variant="outline" className="text-[10px]">
                                        {parsedCases.length}
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent className="pt-0">
                                {parsedCases.length === 0 ? (
                                    <p className="text-xs text-muted-foreground/75">
                                        Tests appear here automatically while you edit source.
                                    </p>
                                ) : (
                                    <div className="space-y-1.5">
                                        {parsedCases.map((testCase) => (
                                            <div
                                                key={testCase.id}
                                                className="flex items-center gap-2 rounded-md border border-border/30 bg-background/30 px-2.5 py-2"
                                            >
                                                <p className="truncate text-xs font-medium text-foreground/90">{testCase.name}</p>
                                                <span className="ml-auto text-[10px] text-muted-foreground/65">
                                                    {testCase.expected.rowCount !== undefined ? `rows=${testCase.expected.rowCount}` : "execution"}
                                                </span>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-6 px-2 text-[10px]"
                                                    onClick={() => handleRunSingle(testCase)}
                                                    disabled={isRunning || isAiGenerating}
                                                >
                                                    <Play className="mr-1 h-3 w-3" />
                                                    Run
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                )}

                {activeStep === "report" && (
                    <div className="space-y-3">
                        <Card className="border-border/35 bg-card/50">
                            <CardHeader className="py-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <CardTitle className="text-sm">Execution Controls</CardTitle>
                                        <CardDescription>
                                            Run your full suite and inspect pass/fail diagnostics.
                                        </CardDescription>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        {isRunning ? (
                                            <Button size="sm" className="h-8 gap-1.5 bg-rose-600 text-white hover:bg-rose-500" onClick={handleCancelRun}>
                                                <Square className="h-3.5 w-3.5" /> Stop
                                            </Button>
                                        ) : (
                                            <Button
                                                size="sm"
                                                className="h-8 gap-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 text-white hover:from-emerald-500 hover:to-cyan-500"
                                                onClick={handleRunAll}
                                                disabled={isAiGenerating}
                                            >
                                                <Play className="h-3.5 w-3.5" /> Run All
                                            </Button>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8 gap-1.5"
                                            onClick={handleClearResults}
                                            disabled={isRunning || results.length === 0}
                                        >
                                            Clear
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground/80">
                                    <Badge variant="outline">TAP summary: 1..{report.total}</Badge>
                                    <span>{report.passed} passed</span>
                                    <span className="text-muted-foreground/40">/</span>
                                    <span>{report.failed} failed</span>
                                    <span className="text-muted-foreground/40">|</span>
                                    <span>{formatMs(report.totalDurationMs)} total</span>
                                    {isRunning && (
                                        <span className="inline-flex items-center gap-1 text-cyan-100">
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            Running {progress.completed}/{progress.total}
                                        </span>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        <div className="grid gap-3 xl:grid-cols-[0.9fr_1.1fr]">
                            <Card className="border-border/35 bg-card/50">
                                <CardHeader className="py-3">
                                    <CardTitle className="text-sm">Suite Report</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3 pt-0">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
                                            <p className="text-[11px] text-emerald-100/80">Passed</p>
                                            <p className="mt-0.5 text-xl font-semibold text-emerald-200">{report.passed}</p>
                                        </div>
                                        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5">
                                            <p className="text-[11px] text-rose-100/80">Failed</p>
                                            <p className="mt-0.5 text-xl font-semibold text-rose-200">{report.failed}</p>
                                        </div>
                                        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2.5">
                                            <p className="text-[11px] text-cyan-100/80">Pass Rate</p>
                                            <p className="mt-0.5 text-xl font-semibold text-cyan-100">{report.passRate.toFixed(1)}%</p>
                                        </div>
                                        <div className="rounded-lg border border-border/40 bg-background/35 p-2.5">
                                            <p className="text-[11px] text-muted-foreground/80">Avg Duration</p>
                                            <p className="mt-0.5 text-xl font-semibold text-foreground/90">{formatMs(report.averageDurationMs)}</p>
                                        </div>
                                    </div>

                                    <Separator className="bg-border/30" />

                                    {report.total === 0 ? (
                                        <div className="rounded-md border border-border/30 bg-background/25 p-4 text-center">
                                            <Sparkles className="mx-auto h-5 w-5 text-muted-foreground/40" />
                                            <p className="mt-2 text-xs text-muted-foreground/75">
                                                Run tests to populate visual report cards.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                            <div className="h-[180px] rounded-lg border border-border/25 bg-background/25 p-2">
                                                <ResponsiveContainer>
                                                    <PieChart>
                                                        <Pie
                                                            data={report.statusChartData}
                                                            cx="50%"
                                                            cy="50%"
                                                            innerRadius={46}
                                                            outerRadius={70}
                                                            dataKey="value"
                                                        >
                                                            {report.statusChartData.map((entry) => (
                                                                <Cell key={entry.name} fill={entry.fill} />
                                                            ))}
                                                        </Pie>
                                                        <RechartsTooltip />
                                                    </PieChart>
                                                </ResponsiveContainer>
                                            </div>

                                            <div className="h-[180px] rounded-lg border border-border/25 bg-background/25 p-2">
                                                <ResponsiveContainer>
                                                    <BarChart data={report.durationChartData}>
                                                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.3)" />
                                                        <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} height={46} />
                                                        <YAxis tick={{ fontSize: 10 }} />
                                                        <RechartsTooltip />
                                                        <Bar dataKey="durationMs" radius={[4, 4, 0, 0]}>
                                                            {report.durationChartData.map((entry, idx) => (
                                                                <Cell key={`${entry.name}-${idx}`} fill={entry.fill} />
                                                            ))}
                                                        </Bar>
                                                    </BarChart>
                                                </ResponsiveContainer>
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <div className="space-y-3">
                                <Card className="border-border/35 bg-card/50">
                                    <CardHeader className="py-3">
                                        <CardTitle className="text-sm">Execution Results</CardTitle>
                                        <CardDescription>
                                            Select a test to inspect failure reason and fix hint.
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="pt-0">
                                        {results.length === 0 ? (
                                            <div className="rounded-md border border-dashed border-border/30 bg-background/20 p-6 text-center text-xs text-muted-foreground/70">
                                                No test execution results yet.
                                            </div>
                                        ) : (
                                            <ScrollArea className="h-[280px] pr-2">
                                                <div className="space-y-1.5">
                                                    {results.map((result) => (
                                                        <button
                                                            key={`${result.id}-${result.executedAt}`}
                                                            className={cn(
                                                                "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                                                                selectedResultId === result.id
                                                                    ? "border-primary/60 bg-primary/10"
                                                                    : "border-border/35 bg-background/25 hover:bg-background/40"
                                                            )}
                                                            onClick={() => setSelectedResultId(result.id)}
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                {result.passed ? (
                                                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                                                ) : (
                                                                    <XCircle className="h-3.5 w-3.5 text-rose-400" />
                                                                )}
                                                                <span className="truncate text-xs font-medium text-foreground/90">{result.name}</span>
                                                                <span className="ml-auto text-[10px] text-muted-foreground/60">
                                                                    {formatMs(result.durationMs)}
                                                                </span>
                                                            </div>
                                                            <p className="mt-1 truncate text-[11px] text-muted-foreground/75">
                                                                {result.assertions.find((assertion) => !assertion.passed)?.message ?? "All assertions passed."}
                                                            </p>
                                                        </button>
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        )}
                                    </CardContent>
                                </Card>

                                {selectedResult && (
                                    <Card className="border-border/35 bg-card/50">
                                        <CardHeader className="py-3">
                                            <CardTitle className="text-sm">Selected Result Details</CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-2 text-xs pt-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge
                                                    variant="outline"
                                                    className={cn(
                                                        selectedResult.passed
                                                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                                                            : "border-rose-500/35 bg-rose-500/10 text-rose-200"
                                                    )}
                                                >
                                                    {selectedResult.passed ? "PASSED" : "FAILED"}
                                                </Badge>
                                                <Badge variant="outline" className="text-[10px]">
                                                    {selectedResult.queryType ?? "unknown"}
                                                </Badge>
                                                <span className="text-muted-foreground/70">
                                                    {new Date(selectedResult.executedAt).toLocaleTimeString()}
                                                </span>
                                            </div>

                                            <div className="rounded-md border border-border/35 bg-background/30 p-2">
                                                <p className="text-[11px] font-medium text-foreground/90">Assertions</p>
                                                <ul className="mt-1.5 space-y-1">
                                                    {selectedResult.assertions.map((assertion, index) => (
                                                        <li key={`${selectedResult.id}-assert-${index}`} className="text-[11px]">
                                                            <span
                                                                className={cn(
                                                                    "inline-flex h-5 items-center rounded px-1.5 font-medium",
                                                                    assertion.passed
                                                                        ? "bg-emerald-500/15 text-emerald-200"
                                                                        : "bg-rose-500/15 text-rose-200"
                                                                )}
                                                            >
                                                                {assertion.passed ? "PASS" : "FAIL"}
                                                            </span>
                                                            <span className="ml-2 text-foreground/85">{assertion.message}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>

                                            {!selectedResult.passed && selectedResult.fixSuggestion && (
                                                <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-2 text-amber-100">
                                                    <p className="text-[11px] font-medium">Fix suggestion</p>
                                                    <p className="mt-0.5 text-[11px] text-amber-100/85">{selectedResult.fixSuggestion}</p>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
