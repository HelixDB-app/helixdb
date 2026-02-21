"use client";

import { useEffect, useState, useCallback } from "react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connection-store";
import { useQueryStore } from "@/stores/query-store";
import { useSearchStore } from "@/stores/search-store";
import { dbGetColumns, dbSearchTableData } from "@/lib/tauri";
import type { ColumnInfo, TableInfo, QueryResult } from "@/lib/types";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";
import {
    Table2,
    Play,
    Clock,
    Search,
    ChevronRight,
    Loader2,
    Terminal,
    Key,
    Database,
    Hash,
    Type,
    Filter,
    Trash2,
    Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Operators ───────────────────────────────────────────────────────────────

interface Operator {
    label: string;
    description: string;
    noValue?: boolean;
}

const OPERATORS: Operator[] = [
    { label: "=", description: "Equals" },
    { label: "!=", description: "Not equals" },
    { label: ">", description: "Greater than" },
    { label: "<", description: "Less than" },
    { label: ">=", description: "Greater or equal" },
    { label: "<=", description: "Less or equal" },
    { label: "LIKE", description: "Pattern match — use % as wildcard" },
    { label: "NOT LIKE", description: "Inverse pattern match" },
    { label: "ILIKE", description: "Case-insensitive pattern match" },
    { label: "IS NULL", description: "Value is null", noValue: true },
    { label: "IS NOT NULL", description: "Value is not null", noValue: true },
];

// ─── Input parser ────────────────────────────────────────────────────────────

type SearchStage =
    | { type: "init" }
    | { type: "table"; filter: string }
    | { type: "column"; schema: string; table: string; filter: string }
    | { type: "operator"; schema: string; table: string; col: string; opFilter: string }
    | { type: "value"; schema: string; table: string; col: string; op: string; value: string }
    | { type: "raw_sql"; sql: string }
    | { type: "ai_nl"; query: string };

const SQL_KEYWORDS = [
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
    "CREATE", "DROP", "ALTER", "EXPLAIN", "TABLE", "SHOW",
];

function parseInput(input: string, tables: TableInfo[]): SearchStage {
    const trimmed = input.trim();
    if (!trimmed) return { type: "init" };

    // AI natural language mode: starts with "?"
    if (trimmed.startsWith("?")) {
        const query = trimmed.slice(1).trim();
        return { type: "ai_nl", query };
    }

    const upper = trimmed.toUpperCase();
    if (SQL_KEYWORDS.some((kw) => upper.startsWith(kw)) || trimmed.includes(";")) {
        return { type: "raw_sql", sql: trimmed };
    }

    const dotIdx = trimmed.indexOf(".");
    if (dotIdx === -1) return { type: "table", filter: trimmed };

    const tablePart = trimmed.substring(0, dotIdx).toLowerCase();
    const rest = trimmed.substring(dotIdx + 1);

    const matchedTable = tables.find((t) => t.name.toLowerCase() === tablePart);
    const schema = matchedTable?.schema ?? "public";

    // Match operators longest-first to avoid partial matches (e.g. "NOT LIKE" before "NOT")
    const sortedOps = [...OPERATORS].sort((a, b) => b.label.length - a.label.length);
    for (const op of sortedOps) {
        const needle = " " + op.label.toUpperCase();
        const idx = rest.toUpperCase().indexOf(needle);
        if (idx !== -1) {
            const col = rest.substring(0, idx);
            const afterOp = rest.substring(idx + needle.length);
            // Ensure the character after the op label is a space or end-of-string
            if (afterOp === "" || afterOp.startsWith(" ")) {
                return {
                    type: "value",
                    schema,
                    table: tablePart,
                    col,
                    op: op.label,
                    value: afterOp.trimStart(),
                };
            }
        }
    }

    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx !== -1) {
        const col = rest.substring(0, spaceIdx);
        const opFilter = rest.substring(spaceIdx + 1);
        return { type: "operator", schema, table: tablePart, col, opFilter };
    }

    return { type: "column", schema, table: tablePart, filter: rest };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
}

function buildStructuredSQL(
    schema: string,
    table: string,
    col: string,
    op: string,
    value: string
): string {
    const noValue = op === "IS NULL" || op === "IS NOT NULL";
    if (noValue) {
        return `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} LIMIT 200`;
    }
    // Escape single quotes in the preview SQL (parameterized path handles this safely)
    const escaped = value.replace(/'/g, "''");
    return `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} '${escaped}' LIMIT 200`;
}

function ColTypeIcon({ dataType }: { dataType: string }) {
    const dt = dataType.toLowerCase();
    if (dt.includes("int") || dt.includes("numeric") || dt.includes("float") || dt.includes("double") || dt.includes("real")) {
        return <Hash className="h-3 w-3 text-blue-400/70" />;
    }
    if (dt.includes("bool")) {
        return <Filter className="h-3 w-3 text-yellow-400/70" />;
    }
    return <Type className="h-3 w-3 text-muted-foreground/50" />;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onNavigateToQuery: () => void;
    onNavigateToTable: (schema: string, table: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CommandPalette({
    open,
    onOpenChange,
    onNavigateToQuery,
    onNavigateToTable,
}: CommandPaletteProps) {
    const { connectionId, tables, isConnected } = useConnectionStore();
    const { addTab, updateSql, executeQuery } = useQueryStore();
    const { recentSearches, addRecentSearch, clearRecentSearches } = useSearchStore();

    const [input, setInput] = useState("");
    const [columns, setColumns] = useState<ColumnInfo[]>([]);
    const [isLoadingColumns, setIsLoadingColumns] = useState(false);
    const [lastFetchedKey, setLastFetchedKey] = useState<string | null>(null);
    const [isExecuting, setIsExecuting] = useState(false);

    // AI natural language state
    const [aiGeneratedSQL, setAiGeneratedSQL] = useState<string | null>(null);
    const [isAiLoading, setIsAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [lastAiQuery, setLastAiQuery] = useState<string | null>(null);

    const parsed = parseInput(input, tables);

    // Reset state when dialog closes
    useEffect(() => {
        if (!open) {
            setInput("");
            setColumns([]);
            setLastFetchedKey(null);
            setIsExecuting(false);
            setAiGeneratedSQL(null);
            setAiError(null);
            setLastAiQuery(null);
            setIsAiLoading(false);
        }
    }, [open]);

    // Fetch AI SQL when in ai_nl stage with a non-empty query
    useEffect(() => {
        if (parsed.type !== "ai_nl") {
            setAiGeneratedSQL(null);
            setAiError(null);
            setLastAiQuery(null);
            return;
        }

        const { query } = parsed;
        if (!query || query === lastAiQuery) return;

        const timer = setTimeout(async () => {
            setLastAiQuery(query);
            setIsAiLoading(true);
            setAiGeneratedSQL(null);
            setAiError(null);
            try {
                const sql = await aiSuggestionEngine.getNaturalLanguageSQL(query, {
                    tables: tables.map((t) => t.name),
                    columns: {},
                });
                setAiGeneratedSQL(sql || null);
            } catch {
                setAiError("AI request failed. Check your connection.");
            } finally {
                setIsAiLoading(false);
            }
        }, 600);

        return () => clearTimeout(timer);
    }, [parsed.type === "ai_nl" ? parsed.query : null, tables, lastAiQuery]);

    // Lazily fetch columns when in column/operator/value stage
    useEffect(() => {
        if (!connectionId) return;
        if (
            parsed.type !== "column" &&
            parsed.type !== "operator" &&
            parsed.type !== "value"
        )
            return;

        const { schema, table } = parsed as { schema: string; table: string };
        const key = `${schema}.${table}`;
        if (key === lastFetchedKey) return;

        setLastFetchedKey(key);
        setIsLoadingColumns(true);
        dbGetColumns(connectionId, schema, table)
            .then((cols) => {
                setColumns(cols);
                setIsLoadingColumns(false);
            })
            .catch(() => {
                setColumns([]);
                setIsLoadingColumns(false);
            });
    }, [
        parsed.type,
        parsed.type === "column" || parsed.type === "operator" || parsed.type === "value"
            ? (parsed as { schema: string }).schema + "." + (parsed as { table: string }).table
            : null,
        connectionId,
        lastFetchedKey,
    ]);

    // Core execution: adds a Query tab, navigates, and runs asynchronously
    const executeSearch = useCallback(
        async (sql: string, label: string) => {
            if (!connectionId) return;
            addRecentSearch(label, sql);
            addTab(label);
            const { activeTabId } = useQueryStore.getState();
            if (!activeTabId) return;
            updateSql(activeTabId, sql);
            onNavigateToQuery();
            onOpenChange(false);
            // Fire-and-forget — the tab shows its own loading state
            executeQuery(connectionId, activeTabId);
        },
        [connectionId, addRecentSearch, addTab, updateSql, executeQuery, onNavigateToQuery, onOpenChange]
    );

    // Structured search via the safe Rust backend command
    const runStructured = useCallback(async () => {
        if (parsed.type !== "value" || !connectionId) return;
        const { schema, table, col, op, value } = parsed;
        setIsExecuting(true);

        const noValue = op === "IS NULL" || op === "IS NOT NULL";
        const label = `${table}.${col} ${op}${!noValue && value ? ` ${value}` : ""}`;

        if (noValue) {
            const sql = `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} LIMIT 200`;
            await executeSearch(sql, label);
        } else {
            try {
                // Use parameterized Rust command for safe query execution
                const result: QueryResult = await dbSearchTableData(
                    connectionId,
                    schema,
                    table,
                    col,
                    op,
                    value,
                    200
                );
                addRecentSearch(label, result.query);
                addTab(label);
                const { activeTabId } = useQueryStore.getState();
                if (activeTabId) {
                    updateSql(activeTabId, result.query);
                    // Inject pre-fetched results directly into the tab
                    useQueryStore.setState((s) => ({
                        tabs: s.tabs.map((t) =>
                            t.id === activeTabId
                                ? { ...t, result, executionTime: result.execution_time_ms }
                                : t
                        ),
                    }));
                }
                onNavigateToQuery();
                onOpenChange(false);
            } catch {
                // Fall back to plain SQL execution
                const sql = buildStructuredSQL(schema, table, col, op, value);
                await executeSearch(sql, label);
            }
        }
        setIsExecuting(false);
    }, [
        parsed,
        connectionId,
        executeSearch,
        addRecentSearch,
        addTab,
        updateSql,
        onNavigateToQuery,
        onOpenChange,
    ]);

    // ─── Derived lists ───────────────────────────────────────────────────────

    const filteredTables = (() => {
        if (parsed.type === "init") return tables.slice(0, 12);
        if (parsed.type === "table") {
            const f = parsed.filter.toLowerCase();
            return tables.filter((t) => t.name.toLowerCase().includes(f)).slice(0, 12);
        }
        return [];
    })();

    const displayColumns = (() => {
        if (parsed.type === "column") {
            const f = parsed.filter.toLowerCase();
            return f
                ? columns.filter((c) => c.name.toLowerCase().startsWith(f))
                : columns;
        }
        if (parsed.type === "operator" || parsed.type === "value") return columns;
        return [];
    })().slice(0, 15);

    const filteredOperators = (() => {
        if (parsed.type === "operator") {
            const f = parsed.opFilter.toLowerCase();
            return f
                ? OPERATORS.filter(
                    (op) =>
                        op.label.toLowerCase().startsWith(f) ||
                        op.description.toLowerCase().includes(f)
                )
                : OPERATORS;
        }
        return [];
    })();

    // ─── Render ──────────────────────────────────────────────────────────────

    const previewSQL =
        parsed.type === "value"
            ? buildStructuredSQL(parsed.schema, parsed.table, parsed.col, parsed.op, parsed.value)
            : "";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="overflow-hidden p-0 shadow-2xl border-border/30 max-w-[680px] w-full bg-card/95 backdrop-blur-xl">
                <Command shouldFilter={false} className="rounded-lg border-0">
                    {/* Input */}
                    <div className="flex items-center border-b border-border/20 px-1">
                        <CommandInput
                            value={input}
                            onValueChange={setInput}
                            placeholder={
                                isConnected
                                    ? "Search tables, run SQL, or ? for AI…  e.g. users.email = value"
                                    : "Connect to a database first"
                            }
                            className="h-12 text-sm"
                            disabled={!isConnected || isExecuting}
                        />
                        {isExecuting && (
                            <Loader2 className="mr-3 h-4 w-4 animate-spin text-muted-foreground/50 shrink-0" />
                        )}
                    </div>

                    {/* List */}
                    <CommandList className="max-h-[440px] overflow-y-auto p-1">

                        {/* Not connected */}
                        {!isConnected && (
                            <div className="flex flex-col items-center justify-center py-14 gap-3">
                                <Database className="h-9 w-9 text-muted-foreground/20" />
                                <p className="text-sm text-muted-foreground/50">
                                    Connect to a database to use search
                                </p>
                            </div>
                        )}

                        {/* ── INIT ── */}
                        {isConnected && parsed.type === "init" && (
                            <>
                                {recentSearches.length > 0 && (
                                    <CommandGroup
                                        heading={
                                            <div className="flex items-center justify-between w-full">
                                                <span>Recent</span>
                                                <button
                                                    onClick={clearRecentSearches}
                                                    className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                                                >
                                                    <Trash2 className="h-2.5 w-2.5" />
                                                    Clear
                                                </button>
                                            </div>
                                        }
                                    >
                                        {recentSearches.slice(0, 5).map((r, i) => (
                                            <CommandItem
                                                key={i}
                                                value={`recent-${i}`}
                                                onSelect={() => setInput(r.query)}
                                                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer group"
                                            >
                                                <Clock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                                                <span className="flex-1 text-sm font-mono text-muted-foreground/80 truncate">
                                                    {r.query}
                                                </span>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        executeSearch(r.sql, r.query);
                                                    }}
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-emerald-500/10"
                                                    title="Run again"
                                                >
                                                    <Play className="h-3 w-3 text-emerald-400/70" />
                                                </button>
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                )}

                                {recentSearches.length > 0 && filteredTables.length > 0 && (
                                    <CommandSeparator className="my-1" />
                                )}

                                {filteredTables.length > 0 && (
                                    <CommandGroup heading="Tables">
                                        {filteredTables.map((t) => (
                                            <TableRow
                                                key={`${t.schema}.${t.name}`}
                                                table={t}
                                                onFilter={() => setInput(`${t.name}.`)}
                                                onOpen={() => {
                                                    onNavigateToTable(t.schema, t.name);
                                                    onOpenChange(false);
                                                }}
                                            />
                                        ))}
                                    </CommandGroup>
                                )}

                                {recentSearches.length === 0 && filteredTables.length === 0 && (
                                    <div className="flex flex-col items-center justify-center py-14 gap-2 text-center">
                                        <Search className="h-8 w-8 text-muted-foreground/20" />
                                        <p className="text-sm text-muted-foreground/50">
                                            Type to search tables, columns, or run SQL
                                        </p>
                                        <p className="text-xs text-muted-foreground/30 font-mono mt-0.5">
                                            users.email = john@example.com
                                        </p>
                                        <p className="text-xs text-muted-foreground/25 font-mono mt-0.5">
                                            <span className="text-violet-400/50">?</span> show all active drivers
                                        </p>
                                    </div>
                                )}
                            </>
                        )}

                        {/* ── TABLE FILTER ── */}
                        {isConnected && parsed.type === "table" && (
                            <>
                                {filteredTables.length > 0 ? (
                                    <CommandGroup heading="Tables">
                                        {filteredTables.map((t) => (
                                            <TableRow
                                                key={`${t.schema}.${t.name}`}
                                                table={t}
                                                highlight={parsed.filter}
                                                onFilter={() => setInput(`${t.name}.`)}
                                                onOpen={() => {
                                                    onNavigateToTable(t.schema, t.name);
                                                    onOpenChange(false);
                                                }}
                                            />
                                        ))}
                                    </CommandGroup>
                                ) : (
                                    <CommandEmpty className="py-8 text-center text-sm text-muted-foreground/50">
                                        No tables match &ldquo;{parsed.filter}&rdquo;
                                    </CommandEmpty>
                                )}

                                <CommandSeparator className="my-1" />

                                <CommandGroup heading="Quick SQL">
                                    <CommandItem
                                        value="quick-select"
                                        onSelect={() =>
                                            setInput(`SELECT * FROM "${parsed.filter}" LIMIT 100`)
                                        }
                                        className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                    >
                                        <Terminal className="h-3.5 w-3.5 text-blue-400/70 shrink-0" />
                                        <span className="text-sm text-muted-foreground/70">
                                            SELECT * FROM{" "}
                                            <span className="text-foreground/80 font-mono">
                                                &quot;{parsed.filter}&quot;
                                            </span>{" "}
                                            LIMIT 100
                                        </span>
                                    </CommandItem>
                                </CommandGroup>
                            </>
                        )}

                        {/* ── COLUMN FILTER ── */}
                        {isConnected && parsed.type === "column" && (
                            <CommandGroup
                                heading={
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-muted-foreground/60">{parsed.table}</span>
                                        <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                                        <span>Columns</span>
                                    </span>
                                }
                            >
                                {isLoadingColumns ? (
                                    <div className="flex items-center gap-2 px-2.5 py-3 text-muted-foreground/50">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        <span className="text-sm">Loading columns…</span>
                                    </div>
                                ) : displayColumns.length > 0 ? (
                                    displayColumns.map((col) => (
                                        <ColumnRow
                                            key={col.name}
                                            col={col}
                                            onSelect={() =>
                                                setInput(`${parsed.table}.${col.name} `)
                                            }
                                        />
                                    ))
                                ) : (
                                    <CommandEmpty className="py-6 text-sm text-muted-foreground/50">
                                        No columns found
                                    </CommandEmpty>
                                )}
                            </CommandGroup>
                        )}

                        {/* ── OPERATOR SELECT ── */}
                        {isConnected && parsed.type === "operator" && (
                            <CommandGroup
                                heading={
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-muted-foreground/60">{parsed.table}</span>
                                        <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                                        <span className="font-mono text-foreground/80">{parsed.col}</span>
                                        <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                                        <span>Operator</span>
                                    </span>
                                }
                            >
                                {filteredOperators.map((op) => (
                                    <CommandItem
                                        key={op.label}
                                        value={`op-${op.label}`}
                                        onSelect={() =>
                                            setInput(`${parsed.table}.${parsed.col} ${op.label} `)
                                        }
                                        className="flex items-center gap-3 rounded-md px-2.5 py-2 cursor-pointer"
                                    >
                                        <span className="w-20 font-mono text-sm font-semibold text-emerald-400/80 shrink-0">
                                            {op.label}
                                        </span>
                                        <span className="flex-1 text-sm text-muted-foreground/70">
                                            {op.description}
                                        </span>
                                        {op.noValue && (
                                            <Badge
                                                variant="outline"
                                                className="h-4 px-1.5 text-[9px] border-border/20 text-muted-foreground/40"
                                            >
                                                no value
                                            </Badge>
                                        )}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}

                        {/* ── VALUE / RUN ── */}
                        {isConnected && parsed.type === "value" && (
                            <>
                                <CommandGroup heading="Execute">
                                    <CommandItem
                                        value="run-search"
                                        onSelect={runStructured}
                                        disabled={isExecuting}
                                        className={cn(
                                            "flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer group",
                                            isExecuting && "opacity-60"
                                        )}
                                    >
                                        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20 shrink-0">
                                            {isExecuting ? (
                                                <Loader2 className="h-3.5 w-3.5 text-emerald-400 animate-spin" />
                                            ) : (
                                                <Play className="h-3.5 w-3.5 text-emerald-400" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium">
                                                {isExecuting ? "Running…" : "Run search query"}
                                            </p>
                                            <p className="text-xs font-mono text-muted-foreground/55 mt-0.5 truncate">
                                                {previewSQL}
                                            </p>
                                            <div className="flex items-center gap-2 mt-1.5">
                                                <Badge
                                                    variant="outline"
                                                    className="h-4 px-1.5 text-[9px] border-border/20 text-muted-foreground/40"
                                                >
                                                    LIMIT 200
                                                </Badge>
                                                <span className="text-[10px] text-muted-foreground/30">
                                                    Opens in Query tab
                                                </span>
                                            </div>
                                        </div>
                                        <kbd className="hidden group-data-[selected=true]:inline-flex h-5 items-center rounded border border-border/30 bg-muted/30 px-1.5 font-mono text-[10px] text-muted-foreground/50">
                                            ↵
                                        </kbd>
                                    </CommandItem>
                                </CommandGroup>

                                {parsed.op !== "IS NULL" && parsed.op !== "IS NOT NULL" && (
                                    <>
                                        <CommandSeparator className="my-1" />
                                        <div className="flex items-center justify-between px-3 py-2">
                                            <div className="flex items-center gap-1.5 text-xs font-mono">
                                                <span className="text-muted-foreground/50">{parsed.table}</span>
                                                <span className="text-muted-foreground/30">.</span>
                                                <span className="text-foreground/70">{parsed.col}</span>
                                                <span className="text-emerald-400/70 mx-1">{parsed.op}</span>
                                                <span className="text-blue-400/80">
                                                    {parsed.value || <span className="italic text-muted-foreground/30">value…</span>}
                                                </span>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="h-4 px-1.5 text-[9px] border-border/20 text-muted-foreground/40"
                                            >
                                                {parsed.schema}
                                            </Badge>
                                        </div>

                                        {/* Column info in context */}
                                        {columns.length > 0 && (
                                            <CommandGroup heading="Also filter by column">
                                                {columns
                                                    .filter((c) => c.name !== parsed.col)
                                                    .slice(0, 5)
                                                    .map((col) => (
                                                        <ColumnRow
                                                            key={col.name}
                                                            col={col}
                                                            onSelect={() =>
                                                                setInput(`${parsed.table}.${col.name} `)
                                                            }
                                                            compact
                                                        />
                                                    ))}
                                            </CommandGroup>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {/* ── AI NATURAL LANGUAGE ── */}
                        {isConnected && parsed.type === "ai_nl" && (
                            <CommandGroup
                                heading={
                                    <span className="flex items-center gap-1.5">
                                        <Sparkles className="h-3 w-3 text-violet-400/70" />
                                        <span>Nova AI</span>
                                        {parsed.query && (
                                            <span className="text-muted-foreground/50 font-normal">
                                                — {parsed.query.slice(0, 40)}{parsed.query.length > 40 ? "…" : ""}
                                            </span>
                                        )}
                                    </span>
                                }
                            >
                                {!parsed.query ? (
                                    <div className="px-2.5 py-4 text-center text-xs text-muted-foreground/50">
                                        Type a natural language query after{" "}
                                        <span className="font-mono text-violet-400/70">?</span>
                                        <br />
                                        <span className="text-[10px] text-muted-foreground/30 font-mono mt-1 block">
                                            e.g. ? show all active drivers
                                        </span>
                                    </div>
                                ) : isAiLoading ? (
                                    <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground/50">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400/60" />
                                        <span className="text-sm">Nova is generating SQL…</span>
                                    </div>
                                ) : aiError ? (
                                    <div className="px-3 py-3 text-xs text-destructive/70">
                                        {aiError}
                                    </div>
                                ) : aiGeneratedSQL ? (
                                    <CommandItem
                                        value="run-ai-sql"
                                        onSelect={() =>
                                            executeSearch(
                                                aiGeneratedSQL,
                                                parsed.query.length > 50
                                                    ? parsed.query.substring(0, 50) + "…"
                                                    : parsed.query
                                            )
                                        }
                                        disabled={isExecuting}
                                        className="flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer group"
                                    >
                                        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/10 border border-violet-500/20 shrink-0">
                                            {isExecuting ? (
                                                <Loader2 className="h-3.5 w-3.5 text-violet-400 animate-spin" />
                                            ) : (
                                                <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium">Run AI-generated query</p>
                                            <p className="mt-0.5 text-xs font-mono text-muted-foreground/55 line-clamp-3 break-all whitespace-pre-wrap">
                                                {aiGeneratedSQL}
                                            </p>
                                            <div className="flex items-center gap-2 mt-1.5">
                                                <Badge
                                                    variant="outline"
                                                    className="h-4 px-1.5 text-[9px] border-violet-500/20 text-violet-400/60"
                                                >
                                                    Nova AI
                                                </Badge>
                                                <span className="text-[10px] text-muted-foreground/30">
                                                    Opens in Query tab
                                                </span>
                                            </div>
                                        </div>
                                        <kbd className="hidden group-data-[selected=true]:inline-flex h-5 items-center rounded border border-border/30 bg-muted/30 px-1.5 font-mono text-[10px] text-muted-foreground/50">
                                            ↵
                                        </kbd>
                                    </CommandItem>
                                ) : (
                                    <div className="px-3 py-3 text-xs text-muted-foreground/40">
                                        No SQL generated. Try rephrasing your query.
                                    </div>
                                )}
                            </CommandGroup>
                        )}

                        {/* ── RAW SQL ── */}
                        {isConnected && parsed.type === "raw_sql" && (
                            <CommandGroup heading="Execute SQL">
                                <CommandItem
                                    value="run-raw-sql"
                                    onSelect={() =>
                                        executeSearch(
                                            parsed.sql,
                                            parsed.sql.length > 60
                                                ? parsed.sql.substring(0, 60) + "…"
                                                : parsed.sql
                                        )
                                    }
                                    disabled={isExecuting}
                                    className="flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer group"
                                >
                                    <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-blue-500/10 border border-blue-500/20 shrink-0">
                                        {isExecuting ? (
                                            <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />
                                        ) : (
                                            <Terminal className="h-3.5 w-3.5 text-blue-400" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium">Run SQL query</p>
                                        <p className="mt-0.5 text-xs font-mono text-muted-foreground/55 line-clamp-2 break-all">
                                            {parsed.sql}
                                        </p>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <span className="text-[10px] text-muted-foreground/30">
                                                Opens in Query tab
                                            </span>
                                        </div>
                                    </div>
                                </CommandItem>
                            </CommandGroup>
                        )}
                    </CommandList>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-border/10 px-3 py-1.5">
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/30">
                            <span>↑↓ navigate</span>
                            <span>↵ select</span>
                            <span>esc close</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground/30 font-mono">
                            {parsed.type === "init" || parsed.type === "table"
                                ? "table.column operator value · ? for AI"
                                : parsed.type === "column"
                                    ? "select column to filter"
                                    : parsed.type === "operator"
                                        ? "select operator"
                                        : parsed.type === "value"
                                            ? "type value · ↵ run"
                                            : parsed.type === "ai_nl"
                                                ? "Nova AI · ↵ run"
                                                : "SQL mode · ↵ run"}
                        </span>
                    </div>
                </Command>
            </DialogContent>
        </Dialog>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TableRow({
    table,
    highlight,
    onFilter,
    onOpen,
}: {
    table: TableInfo;
    highlight?: string;
    onFilter: () => void;
    onOpen: () => void;
}) {
    const name = table.name;
    const hl = highlight?.toLowerCase() ?? "";

    return (
        <CommandItem
            value={`table-${table.schema}-${table.name}`}
            onSelect={onFilter}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer group"
        >
            <Table2 className="h-3.5 w-3.5 text-emerald-400/60 shrink-0" />
            <span className="flex-1 text-sm">
                {hl && name.toLowerCase().includes(hl) ? (
                    <>
                        {name.substring(0, name.toLowerCase().indexOf(hl))}
                        <span className="text-emerald-400">
                            {name.substring(
                                name.toLowerCase().indexOf(hl),
                                name.toLowerCase().indexOf(hl) + hl.length
                            )}
                        </span>
                        {name.substring(name.toLowerCase().indexOf(hl) + hl.length)}
                    </>
                ) : (
                    name
                )}
            </span>
            <div className="flex items-center gap-1.5 opacity-0 group-data-[selected=true]:opacity-100 group-hover:opacity-100 transition-opacity">
                <span className="text-[10px] text-muted-foreground/40 font-mono">{table.schema}</span>
                {table.row_count > 0 && (
                    <Badge
                        variant="outline"
                        className="h-4 px-1 text-[9px] border-border/20 text-muted-foreground/40"
                    >
                        {formatCount(table.row_count)}
                    </Badge>
                )}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpen();
                    }}
                    title="Open table"
                    className="p-0.5 rounded hover:bg-muted/50"
                >
                    <Database className="h-3 w-3 text-muted-foreground/40" />
                </button>
            </div>
            <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
        </CommandItem>
    );
}

function ColumnRow({
    col,
    onSelect,
    compact,
}: {
    col: ColumnInfo;
    onSelect: () => void;
    compact?: boolean;
}) {
    return (
        <CommandItem
            value={`col-${col.name}`}
            onSelect={onSelect}
            className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 cursor-pointer",
                compact ? "py-1.5" : "py-2"
            )}
        >
            {col.is_primary_key ? (
                <Key className="h-3.5 w-3.5 text-yellow-400/80 shrink-0" />
            ) : (
                <ColTypeIcon dataType={col.data_type} />
            )}
            <span className={cn("flex-1 font-mono", compact ? "text-xs" : "text-sm")}>
                {col.name}
            </span>
            <div className="flex items-center gap-1.5 opacity-60">
                <span className="text-[10px] text-muted-foreground/50">{col.data_type}</span>
                {col.is_primary_key && (
                    <Badge
                        variant="outline"
                        className="h-3.5 px-1 text-[9px] border-yellow-500/30 text-yellow-500/60"
                    >
                        PK
                    </Badge>
                )}
                {!col.is_nullable && !col.is_primary_key && (
                    <Badge
                        variant="outline"
                        className="h-3.5 px-1 text-[9px] border-border/20 text-muted-foreground/40"
                    >
                        NN
                    </Badge>
                )}
            </div>
            <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
        </CommandItem>
    );
}
