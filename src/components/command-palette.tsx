"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTheme } from "next-themes";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connection-store";
import { useQueryStore } from "@/stores/query-store";
import { useSearchStore } from "@/stores/search-store";
import {
    dbGetColumns,
    dbListEventTriggers,
    dbListFunctions,
    dbListTables,
    dbListTypes,
    dbSearchTableData,
} from "@/lib/tauri";
import type {
    ColumnInfo,
    EventTriggerInfo,
    FunctionInfo,
    PreviewSelection,
    QueryResult,
    TableInfo,
    TypeInfo,
} from "@/lib/types";
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
    Bookmark,
    BookmarkCheck,
    Moon,
    Sun,
    SlidersHorizontal,
    ArrowUpDown,
    ArrowUpAZ,
    Rows3,
    Braces,
    Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
    { label: "LIKE", description: "Pattern match - use % as wildcard" },
    { label: "NOT LIKE", description: "Inverse pattern match" },
    { label: "ILIKE", description: "Case-insensitive pattern match" },
    { label: "IS NULL", description: "Value is null", noValue: true },
    { label: "IS NOT NULL", description: "Value is not null", noValue: true },
];

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

    const sortedOps = [...OPERATORS].sort((a, b) => b.label.length - a.label.length);
    for (const op of sortedOps) {
        const needle = " " + op.label.toUpperCase();
        const idx = rest.toUpperCase().indexOf(needle);
        if (idx !== -1) {
            const col = rest.substring(0, idx);
            const afterOp = rest.substring(idx + needle.length);
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

function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
}

function formatAge(timestamp: number): string {
    const delta = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
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
    const escaped = value.replace(/'/g, "''");
    return `SELECT * FROM "${schema}"."${table}" WHERE "${col}" ${op} '${escaped}' LIMIT 200`;
}

function tokenize(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
}

function scoreMatch(query: string, tokens: string[], primary: string, searchText: string): number {
    if (!query) return 0;
    let score = 0;
    const primaryLower = primary.toLowerCase();
    if (primaryLower === query) score += 160;
    if (primaryLower.startsWith(query)) score += 120;
    if (searchText.includes(query)) score += 42;
    for (const token of tokens) {
        if (primaryLower === token) score += 72;
        else if (primaryLower.startsWith(token)) score += 26;
        else if (primaryLower.includes(token)) score += 18;
        if (searchText.includes(token)) score += 8;
    }
    return score;
}

function allTokensMatch(tokens: string[], text: string): boolean {
    return tokens.every((token) => text.includes(token));
}

function searchSignature(query: string, sql: string): string {
    return `${query.trim().toLowerCase()}::${sql.trim().toLowerCase()}`;
}

function sqlSignature(sql: string): string {
    return sql.trim().toLowerCase();
}

function tableKey(schema: string, table: string): string {
    return `${schema}::${table}`;
}

function splitTableKey(key: string): { schema: string; table: string } {
    const sep = key.indexOf("::");
    if (sep === -1) return { schema: "public", table: key };
    return { schema: key.slice(0, sep), table: key.slice(sep + 2) };
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let cursor = 0;

    async function runWorker() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index]);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

function mergeTables(tables: TableInfo[]): TableInfo[] {
    const out = new Map<string, TableInfo>();
    for (const table of tables) {
        out.set(tableKey(table.schema, table.name), table);
    }
    return Array.from(out.values());
}

type CatalogKind = "table" | "view" | "column" | "function" | "type" | "event_trigger";
type SearchCategory = CatalogKind | "recent" | "saved";
type SortMode = "relevance" | "name" | "rows" | "recent";
type RowFilter = "any" | "nonempty" | "1k" | "100k";

const ALL_CATEGORIES: SearchCategory[] = [
    "table",
    "view",
    "column",
    "function",
    "type",
    "event_trigger",
    "recent",
    "saved",
];

const ROW_FILTERS: Array<{ value: RowFilter; label: string; min: number }> = [
    { value: "any", label: "Any rows", min: 0 },
    { value: "nonempty", label: "Rows > 0", min: 1 },
    { value: "1k", label: "Rows >= 1K", min: 1_000 },
    { value: "100k", label: "Rows >= 100K", min: 100_000 },
];

type CatalogCandidate =
    | {
        kind: "table" | "view";
        key: string;
        schema: string;
        name: string;
        rowCount: number;
        tableComment: string | null;
        searchText: string;
        primaryText: string;
    }
    | {
        kind: "column";
        key: string;
        schema: string;
        table: string;
        name: string;
        dataType: string;
        rowCount: number;
        isPrimaryKey: boolean;
        isNullable: boolean;
        searchText: string;
        primaryText: string;
    }
    | {
        kind: "function";
        key: string;
        schema: string;
        name: string;
        arguments: string;
        functionKind: string;
        language: string;
        isTriggerFunction: boolean;
        searchText: string;
        primaryText: string;
    }
    | {
        kind: "type";
        key: string;
        schema: string;
        name: string;
        typeKind: string;
        searchText: string;
        primaryText: string;
    }
    | {
        kind: "event_trigger";
        key: string;
        name: string;
        event: string;
        enabled: string;
        functionName: string;
        searchText: string;
        primaryText: string;
    };

interface RankedCatalogResult {
    candidate: CatalogCandidate;
    score: number;
}

function matchesRowFilter(candidate: CatalogCandidate, rowFilter: RowFilter): boolean {
    const minRows = ROW_FILTERS.find((entry) => entry.value === rowFilter)?.min ?? 0;
    if (minRows <= 0) return true;
    if (candidate.kind === "table" || candidate.kind === "view") {
        return candidate.rowCount >= minRows;
    }
    if (candidate.kind === "column") {
        return candidate.rowCount >= minRows;
    }
    return true;
}

function collectHighlightRanges(text: string, query: string): Array<[number, number]> {
    const lower = text.toLowerCase();
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const ranges: Array<[number, number]> = [];

    for (const token of tokens) {
        let from = 0;
        while (from < lower.length) {
            const idx = lower.indexOf(token, from);
            if (idx === -1) break;
            ranges.push([idx, idx + token.length]);
            from = idx + token.length;
        }
    }

    if (!ranges.length) return [];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [ranges[0]];
    for (let i = 1; i < ranges.length; i += 1) {
        const [start, end] = ranges[i];
        const previous = merged[merged.length - 1];
        if (start <= previous[1]) {
            previous[1] = Math.max(previous[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
    const ranges = collectHighlightRanges(text, query);
    if (!ranges.length) return <>{text}</>;

    const out: React.ReactNode[] = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (cursor < start) {
            out.push(<span key={`plain-${cursor}`}>{text.slice(cursor, start)}</span>);
        }
        out.push(
            <span key={`hl-${start}`} className="rounded-sm bg-emerald-500/15 text-emerald-400 px-0.5">
                {text.slice(start, end)}
            </span>
        );
        cursor = end;
    }
    if (cursor < text.length) {
        out.push(<span key={`plain-${cursor}`}>{text.slice(cursor)}</span>);
    }
    return <>{out}</>;
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

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onNavigateToQuery: () => void;
    onNavigateToTable: (schema: string, table: string) => void;
    onNavigateToData: () => void;
}

export function CommandPalette({
    open,
    onOpenChange,
    onNavigateToQuery,
    onNavigateToTable,
    onNavigateToData,
}: CommandPaletteProps) {
    const connectionId = useConnectionStore((state) => state.connectionId);
    const tables = useConnectionStore((state) => state.tables);
    const schemas = useConnectionStore((state) => state.schemas);
    const isConnected = useConnectionStore((state) => state.isConnected);
    const selectPreview = useConnectionStore((state) => state.selectPreview);
    const loadEventTriggers = useConnectionStore((state) => state.loadEventTriggers);

    const { addTab, updateSql, executeQuery } = useQueryStore();
    const {
        recentSearches,
        savedSearches,
        addRecentSearch,
        clearRecentSearches,
        saveSearch,
        unsaveSearch,
        touchSavedSearch,
        clearSavedSearches,
    } = useSearchStore();

    const { resolvedTheme, setTheme } = useTheme();

    const [input, setInput] = useState("");
    const [columns, setColumns] = useState<ColumnInfo[]>([]);
    const [isLoadingColumns, setIsLoadingColumns] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);

    const [aiGeneratedSQL, setAiGeneratedSQL] = useState<string | null>(null);
    const [isAiLoading, setIsAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [lastAiQuery, setLastAiQuery] = useState<string | null>(null);

    const [allTables, setAllTables] = useState<TableInfo[]>([]);
    const [allFunctions, setAllFunctions] = useState<Array<{ schema: string; item: FunctionInfo }>>([]);
    const [allTypes, setAllTypes] = useState<Array<{ schema: string; item: TypeInfo }>>([]);
    const [allEventTriggers, setAllEventTriggers] = useState<EventTriggerInfo[]>([]);
    const [isHydratingCatalog, setIsHydratingCatalog] = useState(false);
    const [catalogStage, setCatalogStage] = useState("");
    const [catalogConnectionId, setCatalogConnectionId] = useState<string | null>(null);

    const [columnCache, setColumnCache] = useState<Record<string, ColumnInfo[]>>({});
    const columnCacheRef = useRef<Record<string, ColumnInfo[]>>({});
    const pendingColumnsRef = useRef<Map<string, Promise<ColumnInfo[]>>>(new Map());
    const catalogRunRef = useRef(0);

    const [activeCategories, setActiveCategories] = useState<SearchCategory[]>(ALL_CATEGORIES);
    const [schemaFilter, setSchemaFilter] = useState<string>("all");
    const [sortMode, setSortMode] = useState<SortMode>("relevance");
    const [rowFilter, setRowFilter] = useState<RowFilter>("any");

    useEffect(() => {
        columnCacheRef.current = columnCache;
    }, [columnCache]);

    useEffect(() => {
        if (!open) {
            setInput("");
            setColumns([]);
            setIsExecuting(false);
            setAiGeneratedSQL(null);
            setAiError(null);
            setLastAiQuery(null);
            setIsAiLoading(false);
            setSchemaFilter("all");
            setSortMode("relevance");
            setRowFilter("any");
            setActiveCategories(ALL_CATEGORIES);
        }
    }, [open]);

    useEffect(() => {
        setCatalogConnectionId(null);
        setAllTables([]);
        setAllFunctions([]);
        setAllTypes([]);
        setAllEventTriggers([]);
        setColumnCache({});
        pendingColumnsRef.current.clear();
    }, [connectionId]);

    useEffect(() => {
        if (tables.length === 0) return;
        setAllTables((prev) => mergeTables([...prev, ...tables]));
    }, [tables]);

    useEffect(() => {
        if (!open || !isConnected || !connectionId) return;
        if (catalogConnectionId === connectionId) return;

        let cancelled = false;
        const runId = catalogRunRef.current + 1;
        catalogRunRef.current = runId;
        const isStale = () => cancelled || catalogRunRef.current !== runId;

        const schemaNames = Array.from(new Set(schemas.map((schema) => schema.name).filter(Boolean)));

        const hydrateCatalog = async () => {
            setIsHydratingCatalog(true);
            setCatalogStage("Indexing tables");

            const loadedTables = await mapWithConcurrency(schemaNames, 4, async (schema) => {
                try {
                    return await dbListTables(connectionId, schema);
                } catch {
                    return [] as TableInfo[];
                }
            });
            if (isStale()) return;
            const mergedTables = mergeTables([...tables, ...loadedTables.flat()]);
            setAllTables(mergedTables);

            setCatalogStage("Indexing functions, types, and triggers");
            const [triggers, functionsBySchema, typesBySchema] = await Promise.all([
                dbListEventTriggers(connectionId).catch(() => [] as EventTriggerInfo[]),
                mapWithConcurrency(schemaNames, 4, async (schema) => {
                    try {
                        const items = await dbListFunctions(connectionId, schema);
                        return { schema, items };
                    } catch {
                        return { schema, items: [] as FunctionInfo[] };
                    }
                }),
                mapWithConcurrency(schemaNames, 4, async (schema) => {
                    try {
                        const items = await dbListTypes(connectionId, schema);
                        return { schema, items };
                    } catch {
                        return { schema, items: [] as TypeInfo[] };
                    }
                }),
            ]);
            if (isStale()) return;

            setAllEventTriggers(triggers);
            setAllFunctions(functionsBySchema.flatMap(({ schema, items }) => items.map((item) => ({ schema, item }))));
            setAllTypes(typesBySchema.flatMap(({ schema, items }) => items.map((item) => ({ schema, item }))));
            setCatalogConnectionId(connectionId);
            setCatalogStage("");
            setIsHydratingCatalog(false);
        };

        hydrateCatalog().catch(() => {
            if (isStale()) return;
            setCatalogStage("");
            setIsHydratingCatalog(false);
        });

        return () => {
            cancelled = true;
        };
    }, [open, isConnected, connectionId, catalogConnectionId, schemas, tables]);

    const visibleTables = allTables.length > 0 ? allTables : tables;
    const parsed = parseInput(input, visibleTables);

    const normalizedInput = input.trim().toLowerCase();
    const searchTokens = useMemo(() => tokenize(normalizedInput), [normalizedInput]);
    const activeCategorySet = useMemo(() => new Set(activeCategories), [activeCategories]);
    const aiQuery = parsed.type === "ai_nl" ? parsed.query : null;

    const schemaOptions = useMemo(() => {
        const out = new Set<string>();
        for (const table of visibleTables) out.add(table.schema);
        for (const fn of allFunctions) out.add(fn.schema);
        for (const typeItem of allTypes) out.add(typeItem.schema);
        return Array.from(out).sort((a, b) => a.localeCompare(b));
    }, [visibleTables, allFunctions, allTypes]);

    const tableByKey = useMemo(() => {
        const out = new Map<string, TableInfo>();
        for (const table of visibleTables) {
            out.set(tableKey(table.schema, table.name), table);
        }
        return out;
    }, [visibleTables]);

    const fetchColumnsForTable = useCallback(
        async (schema: string, table: string): Promise<ColumnInfo[]> => {
            if (!connectionId) return [];
            const key = tableKey(schema, table);
            const cached = columnCacheRef.current[key];
            if (cached) return cached;

            const existingRequest = pendingColumnsRef.current.get(key);
            if (existingRequest) return existingRequest;

            const request = dbGetColumns(connectionId, schema, table)
                .then((cols) => {
                    setColumnCache((prev) => {
                        if (prev[key]) return prev;
                        return { ...prev, [key]: cols };
                    });
                    return cols;
                })
                .catch(() => [] as ColumnInfo[])
                .finally(() => {
                    pendingColumnsRef.current.delete(key);
                });

            pendingColumnsRef.current.set(key, request);
            return request;
        },
        [connectionId]
    );

    const structuredTableKey =
        parsed.type === "column" || parsed.type === "operator" || parsed.type === "value"
            ? tableKey(parsed.schema, parsed.table)
            : null;

    useEffect(() => {
        if (!connectionId || !structuredTableKey) return;
        const { schema, table } = splitTableKey(structuredTableKey);

        let cancelled = false;
        setIsLoadingColumns(true);
        fetchColumnsForTable(schema, table)
            .then((cols) => {
                if (cancelled) return;
                setColumns(cols);
                setIsLoadingColumns(false);
            })
            .catch(() => {
                if (cancelled) return;
                setColumns([]);
                setIsLoadingColumns(false);
            });

        return () => {
            cancelled = true;
        };
    }, [connectionId, structuredTableKey, fetchColumnsForTable]);

    const candidateTablesForPrefetch = useMemo(() => {
        if (!normalizedInput || searchTokens.length === 0) return [] as TableInfo[];
        const scored = visibleTables
            .map((table) => {
                const text = `${table.schema} ${table.name} ${table.table_comment ?? ""}`.toLowerCase();
                if (!allTokensMatch(searchTokens, text)) return { table, score: 0 };
                const score = scoreMatch(normalizedInput, searchTokens, `${table.schema}.${table.name}`, text);
                return { table, score };
            })
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map((entry) => entry.table);
        return scored;
    }, [visibleTables, normalizedInput, searchTokens]);

    useEffect(() => {
        if (!open || !connectionId) return;
        if (parsed.type !== "init" && parsed.type !== "table") return;
        if (searchTokens.length === 0) return;
        for (const table of candidateTablesForPrefetch) {
            void fetchColumnsForTable(table.schema, table.name);
        }
    }, [
        open,
        connectionId,
        parsed.type,
        searchTokens,
        candidateTablesForPrefetch,
        fetchColumnsForTable,
    ]);

    useEffect(() => {
        if (!aiQuery) {
            setAiGeneratedSQL(null);
            setAiError(null);
            setLastAiQuery(null);
            return;
        }

        const query = aiQuery;
        if (!query || query === lastAiQuery) return;

        const timer = setTimeout(async () => {
            setLastAiQuery(query);
            setIsAiLoading(true);
            setAiGeneratedSQL(null);
            setAiError(null);
            try {
                const sql = await aiSuggestionEngine.getNaturalLanguageSQL(query, {
                    tables: visibleTables.map((t) => t.name),
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
    }, [aiQuery, visibleTables, lastAiQuery]);

    const catalogCandidates = useMemo<CatalogCandidate[]>(() => {
        const out: CatalogCandidate[] = [];

        for (const table of visibleTables) {
            const kind = table.table_type === "VIEW" ? "view" : "table";
            const primaryText = `${table.schema}.${table.name}`;
            const searchText = `${table.schema} ${table.name} ${table.table_comment ?? ""} ${kind}`.toLowerCase();
            out.push({
                kind,
                key: `tbl:${table.schema}.${table.name}`,
                schema: table.schema,
                name: table.name,
                rowCount: table.row_count,
                tableComment: table.table_comment,
                searchText,
                primaryText,
            });
        }

        for (const [key, cols] of Object.entries(columnCache)) {
            const { schema, table } = splitTableKey(key);
            const baseTable = tableByKey.get(key);
            const rowCount = baseTable?.row_count ?? 0;
            for (const col of cols) {
                const primaryText = `${schema}.${table}.${col.name}`;
                const searchText = `${schema} ${table} ${col.name} ${col.data_type} ${col.is_primary_key ? "pk" : ""}`.toLowerCase();
                out.push({
                    kind: "column",
                    key: `col:${schema}.${table}.${col.name}`,
                    schema,
                    table,
                    name: col.name,
                    dataType: col.data_type,
                    rowCount,
                    isPrimaryKey: col.is_primary_key,
                    isNullable: col.is_nullable,
                    searchText,
                    primaryText,
                });
            }
        }

        for (const fn of allFunctions) {
            const primaryText = `${fn.schema}.${fn.item.name}`;
            const searchText = `${fn.schema} ${fn.item.name} ${fn.item.arguments} ${fn.item.kind} ${fn.item.language}`.toLowerCase();
            out.push({
                kind: "function",
                key: `fn:${fn.schema}.${fn.item.name}(${fn.item.arguments})`,
                schema: fn.schema,
                name: fn.item.name,
                arguments: fn.item.arguments,
                functionKind: fn.item.kind,
                language: fn.item.language,
                isTriggerFunction: fn.item.is_trigger_function,
                searchText,
                primaryText,
            });
        }

        for (const typeItem of allTypes) {
            const primaryText = `${typeItem.schema}.${typeItem.item.name}`;
            const searchText = `${typeItem.schema} ${typeItem.item.name} ${typeItem.item.kind}`.toLowerCase();
            out.push({
                kind: "type",
                key: `type:${typeItem.schema}.${typeItem.item.name}`,
                schema: typeItem.schema,
                name: typeItem.item.name,
                typeKind: typeItem.item.kind,
                searchText,
                primaryText,
            });
        }

        for (const eventTrigger of allEventTriggers) {
            const primaryText = eventTrigger.name;
            const searchText = `${eventTrigger.name} ${eventTrigger.event} ${eventTrigger.enabled} ${eventTrigger.function_name}`.toLowerCase();
            out.push({
                kind: "event_trigger",
                key: `et:${eventTrigger.name}`,
                name: eventTrigger.name,
                event: eventTrigger.event,
                enabled: eventTrigger.enabled,
                functionName: eventTrigger.function_name,
                searchText,
                primaryText,
            });
        }

        return out;
    }, [visibleTables, columnCache, allFunctions, allTypes, allEventTriggers, tableByKey]);

    const rankedCatalogResults = useMemo<RankedCatalogResult[]>(() => {
        const query = normalizedInput;
        const out: RankedCatalogResult[] = [];

        for (const candidate of catalogCandidates) {
            if (!activeCategorySet.has(candidate.kind)) continue;
            if (schemaFilter !== "all" && "schema" in candidate && candidate.schema !== schemaFilter) continue;
            if (!matchesRowFilter(candidate, rowFilter)) continue;

            if (!query) {
                let baseline = 10;
                if (candidate.kind === "table" || candidate.kind === "view") {
                    baseline += Math.log10(candidate.rowCount + 1) * 4;
                }
                if (candidate.kind === "column") {
                    baseline += candidate.isPrimaryKey ? 8 : 0;
                }
                out.push({ candidate, score: baseline });
                continue;
            }

            if (!allTokensMatch(searchTokens, candidate.searchText)) continue;
            let score = scoreMatch(query, searchTokens, candidate.primaryText, candidate.searchText);
            if (candidate.kind === "table" || candidate.kind === "view") {
                score += Math.min(18, Math.log10(candidate.rowCount + 1) * 2.5);
            }
            if (candidate.kind === "column" && candidate.isPrimaryKey) {
                score += 12;
            }
            if (candidate.kind === "function" && candidate.isTriggerFunction) {
                score += 4;
            }
            if (score <= 0) continue;
            out.push({ candidate, score });
        }

        out.sort((a, b) => {
            if (sortMode === "name") {
                return a.candidate.primaryText.localeCompare(b.candidate.primaryText);
            }
            if (sortMode === "rows") {
                const aRows = "rowCount" in a.candidate ? a.candidate.rowCount : 0;
                const bRows = "rowCount" in b.candidate ? b.candidate.rowCount : 0;
                if (bRows !== aRows) return bRows - aRows;
                return b.score - a.score;
            }
            if (sortMode === "recent") {
                return a.candidate.primaryText.localeCompare(b.candidate.primaryText);
            }
            if (b.score !== a.score) return b.score - a.score;
            return a.candidate.primaryText.localeCompare(b.candidate.primaryText);
        });

        return out.slice(0, 220);
    }, [catalogCandidates, activeCategorySet, schemaFilter, rowFilter, normalizedInput, searchTokens, sortMode]);

    const savedBySignature = useMemo(() => {
        const map = new Map<string, { id: string; label: string; query: string; sql: string }>();
        for (const saved of savedSearches) {
            map.set(searchSignature(saved.query, saved.sql), {
                id: saved.id,
                label: saved.label,
                query: saved.query,
                sql: saved.sql,
            });
        }
        return map;
    }, [savedSearches]);

    const savedBySql = useMemo(() => {
        const map = new Map<string, { id: string }>();
        for (const saved of savedSearches) {
            map.set(sqlSignature(saved.sql), { id: saved.id });
        }
        return map;
    }, [savedSearches]);

    const filteredSavedSearches = useMemo(() => {
        if (!activeCategorySet.has("saved")) return [];
        const query = normalizedInput;
        let list = [...savedSearches];
        if (query) {
            list = list.filter((entry) => {
                const text = `${entry.label} ${entry.query} ${entry.sql}`.toLowerCase();
                return allTokensMatch(searchTokens, text);
            });
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        return list.slice(0, 10);
    }, [activeCategorySet, normalizedInput, savedSearches, searchTokens]);

    const filteredRecentSearches = useMemo(() => {
        if (!activeCategorySet.has("recent")) return [];
        const query = normalizedInput;
        let list = [...recentSearches];
        if (query) {
            list = list.filter((entry) => {
                const text = `${entry.query} ${entry.sql}`.toLowerCase();
                return allTokensMatch(searchTokens, text);
            });
        }
        list.sort((a, b) => b.timestamp - a.timestamp);
        return list.slice(0, 8);
    }, [activeCategorySet, normalizedInput, recentSearches, searchTokens]);

    const categoryCounts = useMemo(() => {
        const out: Record<SearchCategory, number> = {
            table: 0,
            view: 0,
            column: 0,
            function: 0,
            type: 0,
            event_trigger: 0,
            recent: filteredRecentSearches.length,
            saved: filteredSavedSearches.length,
        };
        for (const result of rankedCatalogResults) {
            out[result.candidate.kind] += 1;
        }
        return out;
    }, [rankedCatalogResults, filteredRecentSearches.length, filteredSavedSearches.length]);

    const groupedCatalog = useMemo(() => {
        return {
            tablesAndViews: rankedCatalogResults.filter((entry) => entry.candidate.kind === "table" || entry.candidate.kind === "view").slice(0, 14),
            columns: rankedCatalogResults.filter((entry) => entry.candidate.kind === "column").slice(0, 14),
            functions: rankedCatalogResults.filter((entry) => entry.candidate.kind === "function").slice(0, 12),
            types: rankedCatalogResults.filter((entry) => entry.candidate.kind === "type").slice(0, 12),
            eventTriggers: rankedCatalogResults.filter((entry) => entry.candidate.kind === "event_trigger").slice(0, 8),
        };
    }, [rankedCatalogResults]);

    const liveSuggestions = useMemo(() => {
        if (!normalizedInput) return [] as string[];
        const out: string[] = [];

        for (const result of groupedCatalog.tablesAndViews.slice(0, 4)) {
            if (result.candidate.kind === "table" || result.candidate.kind === "view") {
                out.push(`${result.candidate.name}.`);
            }
        }
        for (const result of groupedCatalog.columns.slice(0, 3)) {
            if (result.candidate.kind === "column") {
                out.push(`${result.candidate.table}.${result.candidate.name} `);
            }
        }
        for (const saved of filteredSavedSearches.slice(0, 2)) {
            out.push(saved.query);
        }

        const unique = Array.from(new Set(out)).filter((entry) => entry.toLowerCase() !== input.toLowerCase());
        return unique.slice(0, 8);
    }, [normalizedInput, groupedCatalog, filteredSavedSearches, input]);

    const executeSearch = useCallback(
        async (sql: string, label: string, savedId?: string) => {
            if (!connectionId) return;
            addRecentSearch(label, sql);
            if (savedId) {
                touchSavedSearch(savedId);
            } else {
                const maybeSaved = savedBySql.get(sqlSignature(sql));
                if (maybeSaved) touchSavedSearch(maybeSaved.id);
            }
            addTab(label);
            const { activeTabId } = useQueryStore.getState();
            if (!activeTabId) return;
            updateSql(activeTabId, sql);
            onNavigateToQuery();
            onOpenChange(false);
            executeQuery(connectionId, activeTabId);
        },
        [
            connectionId,
            addRecentSearch,
            touchSavedSearch,
            savedBySql,
            addTab,
            updateSql,
            onNavigateToQuery,
            onOpenChange,
            executeQuery,
        ]
    );

    const openPreviewObject = useCallback(
        (selection: PreviewSelection) => {
            selectPreview(selection);
            onNavigateToData();
            onOpenChange(false);
        },
        [selectPreview, onNavigateToData, onOpenChange]
    );

    const toggleSaveQuery = useCallback(
        (label: string, query: string, sql: string) => {
            const signature = searchSignature(query, sql);
            const existing = savedBySignature.get(signature);
            if (existing) {
                unsaveSearch(existing.id);
                return;
            }
            saveSearch(label, query, sql);
        },
        [savedBySignature, unsaveSearch, saveSearch]
    );

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
                const maybeSaved = savedBySql.get(sqlSignature(result.query));
                if (maybeSaved) touchSavedSearch(maybeSaved.id);
                addTab(label);
                const { activeTabId } = useQueryStore.getState();
                if (activeTabId) {
                    updateSql(activeTabId, result.query);
                    useQueryStore.setState((state) => ({
                        tabs: state.tabs.map((tab) =>
                            tab.id === activeTabId
                                ? { ...tab, result, executionTime: result.execution_time_ms }
                                : tab
                        ),
                    }));
                }
                onNavigateToQuery();
                onOpenChange(false);
            } catch {
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
        savedBySql,
        touchSavedSearch,
        addTab,
        updateSql,
        onNavigateToQuery,
        onOpenChange,
    ]);

    const displayColumns = (() => {
        if (parsed.type === "column") {
            const filter = parsed.filter.toLowerCase();
            return filter
                ? columns.filter((c) => c.name.toLowerCase().startsWith(filter))
                : columns;
        }
        if (parsed.type === "operator" || parsed.type === "value") return columns;
        return [];
    })().slice(0, 24);

    const filteredOperators = (() => {
        if (parsed.type === "operator") {
            const filter = parsed.opFilter.toLowerCase();
            return filter
                ? OPERATORS.filter(
                    (op) =>
                        op.label.toLowerCase().startsWith(filter) ||
                        op.description.toLowerCase().includes(filter)
                )
                : OPERATORS;
        }
        return [];
    })();

    const previewSQL =
        parsed.type === "value"
            ? buildStructuredSQL(parsed.schema, parsed.table, parsed.col, parsed.op, parsed.value)
            : "";

    const allCategoriesSelected = activeCategories.length === ALL_CATEGORIES.length;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="overflow-hidden p-0 shadow-2xl border-border/30 max-w-[920px] w-[96vw] bg-gradient-to-b from-card via-card/95 to-muted/30 backdrop-blur-xl">
                <Command
                    shouldFilter={false}
                    className="rounded-lg border-0 [&_[data-slot=command-input-wrapper]]:border-b-0"
                >
                    <div className="border-b border-border/20 bg-gradient-to-r from-emerald-500/[0.04] via-transparent to-blue-500/[0.04]">
                        <div className="flex items-center px-1">
                            <CommandInput
                                value={input}
                                onValueChange={setInput}
                                placeholder={
                                    isConnected
                                        ? "Search everything: tables, columns, functions, types, triggers... or run SQL"
                                        : "Connect to a database first"
                                }
                                className="h-12 text-sm"
                                disabled={!isConnected || isExecuting}
                            />

                            {isHydratingCatalog && (
                                <Badge
                                    variant="outline"
                                    className="mr-1.5 h-6 border-emerald-500/30 bg-emerald-500/5 text-[10px] text-emerald-400"
                                >
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    {catalogStage || "Indexing"}
                                </Badge>
                            )}

                            <button
                                type="button"
                                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                                className="mr-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/40 bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                                aria-label="Toggle light and dark mode"
                                title="Toggle light/dark mode"
                            >
                                {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                            </button>

                            {isExecuting && (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin text-muted-foreground/60 shrink-0" />
                            )}
                        </div>

                        {isConnected && (parsed.type === "init" || parsed.type === "table") && (
                            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
                                <button
                                    type="button"
                                    onClick={() => setActiveCategories(ALL_CATEGORIES)}
                                    className={cn(
                                        "h-6 rounded-md border px-2 text-[11px] transition-colors",
                                        allCategoriesSelected
                                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                                            : "border-border/30 bg-background/40 text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    All
                                </button>

                                {[
                                    { key: "table", label: "Tables" },
                                    { key: "view", label: "Views" },
                                    { key: "column", label: "Columns" },
                                    { key: "function", label: "Functions" },
                                    { key: "type", label: "Types" },
                                    { key: "event_trigger", label: "Triggers" },
                                    { key: "saved", label: "Saved" },
                                    { key: "recent", label: "Recent" },
                                ].map((cat) => {
                                    const category = cat.key as SearchCategory;
                                    const active = activeCategorySet.has(category);
                                    return (
                                        <button
                                            key={cat.key}
                                            type="button"
                                            onClick={() => {
                                                setActiveCategories((prev) => {
                                                    if (prev.includes(category)) {
                                                        if (prev.length === 1) return prev;
                                                        return prev.filter((item) => item !== category);
                                                    }
                                                    return [...prev, category];
                                                });
                                            }}
                                            className={cn(
                                                "h-6 rounded-md border px-2 text-[11px] transition-colors",
                                                active
                                                    ? "border-primary/35 bg-primary/10 text-foreground"
                                                    : "border-border/30 bg-background/30 text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            {cat.label}
                                            <span className="ml-1 text-[10px] text-muted-foreground/60">
                                                {categoryCounts[category]}
                                            </span>
                                        </button>
                                    );
                                })}

                                <div className="ml-auto flex items-center gap-1.5">
                                    <Select value={schemaFilter} onValueChange={setSchemaFilter}>
                                        <SelectTrigger className="h-7 w-[150px] rounded-md border-border/30 bg-background/40 text-xs">
                                            <SlidersHorizontal className="mr-1.5 h-3 w-3 text-muted-foreground/60" />
                                            <SelectValue placeholder="Schema" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">All schemas</SelectItem>
                                            {schemaOptions.map((schema) => (
                                                <SelectItem key={schema} value={schema}>
                                                    {schema}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>

                                    <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
                                        <SelectTrigger className="h-7 w-[128px] rounded-md border-border/30 bg-background/40 text-xs">
                                            {sortMode === "name" ? (
                                                <ArrowUpAZ className="mr-1.5 h-3 w-3 text-muted-foreground/60" />
                                            ) : sortMode === "rows" ? (
                                                <Rows3 className="mr-1.5 h-3 w-3 text-muted-foreground/60" />
                                            ) : (
                                                <ArrowUpDown className="mr-1.5 h-3 w-3 text-muted-foreground/60" />
                                            )}
                                            <SelectValue placeholder="Sort" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="relevance">Relevance</SelectItem>
                                            <SelectItem value="name">Name</SelectItem>
                                            <SelectItem value="rows">Row count</SelectItem>
                                            <SelectItem value="recent">Recent</SelectItem>
                                        </SelectContent>
                                    </Select>

                                    <Select value={rowFilter} onValueChange={(value) => setRowFilter(value as RowFilter)}>
                                        <SelectTrigger className="h-7 w-[128px] rounded-md border-border/30 bg-background/40 text-xs">
                                            <Rows3 className="mr-1.5 h-3 w-3 text-muted-foreground/60" />
                                            <SelectValue placeholder="Rows" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {ROW_FILTERS.map((filter) => (
                                                <SelectItem key={filter.value} value={filter.value}>
                                                    {filter.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}
                    </div>

                    <CommandList className="max-h-[560px] overflow-y-auto p-1">
                        {!isConnected && (
                            <div className="flex flex-col items-center justify-center py-14 gap-3">
                                <Database className="h-9 w-9 text-muted-foreground/20" />
                                <p className="text-sm text-muted-foreground/50">
                                    Connect to a database to use global search
                                </p>
                            </div>
                        )}

                        {isConnected && (parsed.type === "init" || parsed.type === "table") && (
                            <>
                                {liveSuggestions.length > 0 && (
                                    <CommandGroup heading="Suggestions">
                                        {liveSuggestions.map((suggestion) => (
                                            <CommandItem
                                                key={suggestion}
                                                value={`suggestion-${suggestion}`}
                                                onSelect={() => setInput(suggestion)}
                                                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                            >
                                                <Search className="h-3.5 w-3.5 text-emerald-400/70" />
                                                <span className="text-sm text-foreground/85">
                                                    <HighlightedText text={suggestion} query={input} />
                                                </span>
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                )}

                                {filteredSavedSearches.length > 0 && (
                                    <CommandGroup
                                        heading={
                                            <div className="flex w-full items-center justify-between">
                                                <span>Saved searches</span>
                                                <button
                                                    type="button"
                                                    onClick={() => clearSavedSearches()}
                                                    className="text-[10px] text-muted-foreground/45 hover:text-muted-foreground transition-colors"
                                                >
                                                    Clear
                                                </button>
                                            </div>
                                        }
                                    >
                                        {filteredSavedSearches.map((saved) => (
                                            <CommandItem
                                                key={saved.id}
                                                value={`saved-${saved.id}`}
                                                onSelect={() => executeSearch(saved.sql, saved.query, saved.id)}
                                                className="group flex items-start gap-2.5 rounded-md px-2.5 py-2.5 cursor-pointer"
                                            >
                                                <BookmarkCheck className="mt-0.5 h-3.5 w-3.5 text-emerald-400/70 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-sm font-medium text-foreground/90">
                                                        <HighlightedText text={saved.label || saved.query} query={input} />
                                                    </p>
                                                    <p className="truncate text-[11px] font-mono text-muted-foreground/55">
                                                        {saved.query}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100 transition-opacity">
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            unsaveSearch(saved.id);
                                                        }}
                                                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-border/30 hover:bg-muted/50"
                                                        title="Remove saved search"
                                                    >
                                                        <Trash2 className="h-3 w-3 text-muted-foreground/70" />
                                                    </button>
                                                </div>
                                                <span className="shrink-0 text-[10px] text-muted-foreground/35">
                                                    {formatAge(saved.updatedAt)}
                                                </span>
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                )}

                                {filteredRecentSearches.length > 0 && (
                                    <CommandGroup
                                        heading={
                                            <div className="flex w-full items-center justify-between">
                                                <span>Recent</span>
                                                <button
                                                    type="button"
                                                    onClick={clearRecentSearches}
                                                    className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                                                >
                                                    <Trash2 className="h-2.5 w-2.5" />
                                                    Clear
                                                </button>
                                            </div>
                                        }
                                    >
                                        {filteredRecentSearches.map((recent, index) => {
                                            const signature = searchSignature(recent.query, recent.sql);
                                            const isSaved = savedBySignature.has(signature);
                                            return (
                                                <CommandItem
                                                    key={`${recent.query}-${recent.timestamp}-${index}`}
                                                    value={`recent-${index}`}
                                                    onSelect={() => setInput(recent.query)}
                                                    className="group flex items-start gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    <Clock className="mt-0.5 h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm text-muted-foreground/90">
                                                            <HighlightedText text={recent.query} query={input} />
                                                        </p>
                                                        <p className="truncate text-[11px] font-mono text-muted-foreground/45">
                                                            {recent.sql}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100 transition-opacity">
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                executeSearch(recent.sql, recent.query);
                                                            }}
                                                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-border/30 hover:bg-emerald-500/10"
                                                            title="Run search"
                                                        >
                                                            <Play className="h-3 w-3 text-emerald-400/80" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                toggleSaveQuery(recent.query, recent.query, recent.sql);
                                                            }}
                                                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-border/30 hover:bg-muted/50"
                                                            title={isSaved ? "Unsave" : "Save search"}
                                                        >
                                                            {isSaved ? (
                                                                <BookmarkCheck className="h-3 w-3 text-emerald-400/80" />
                                                            ) : (
                                                                <Bookmark className="h-3 w-3 text-muted-foreground/70" />
                                                            )}
                                                        </button>
                                                    </div>
                                                    <span className="shrink-0 text-[10px] text-muted-foreground/35">
                                                        {formatAge(recent.timestamp)}
                                                    </span>
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {(filteredSavedSearches.length > 0 || filteredRecentSearches.length > 0 || liveSuggestions.length > 0) && (
                                    <CommandSeparator className="my-1" />
                                )}

                                {groupedCatalog.tablesAndViews.length > 0 && (
                                    <CommandGroup heading="Tables & views">
                                        {groupedCatalog.tablesAndViews.map(({ candidate }) => {
                                            if (candidate.kind !== "table" && candidate.kind !== "view") return null;
                                            return (
                                                <CommandItem
                                                    key={candidate.key}
                                                    value={candidate.key}
                                                    onSelect={() => {
                                                        onNavigateToTable(candidate.schema, candidate.name);
                                                        onOpenChange(false);
                                                    }}
                                                    className="group flex items-start gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    <Table2 className="mt-0.5 h-3.5 w-3.5 text-emerald-400/70 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-foreground/90">
                                                            <HighlightedText text={`${candidate.schema}.${candidate.name}`} query={input} />
                                                        </p>
                                                        <p className="truncate text-[11px] text-muted-foreground/55">
                                                            {candidate.kind === "view" ? "View" : "Table"}
                                                            {candidate.tableComment ? ` - ${candidate.tableComment}` : ""}
                                                        </p>
                                                    </div>
                                                    <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-border/20 text-muted-foreground/45">
                                                        {formatCount(candidate.rowCount)} rows
                                                    </Badge>
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {groupedCatalog.columns.length > 0 && (
                                    <CommandGroup heading="Columns">
                                        {groupedCatalog.columns.map(({ candidate }) => {
                                            if (candidate.kind !== "column") return null;
                                            return (
                                                <CommandItem
                                                    key={candidate.key}
                                                    value={candidate.key}
                                                    onSelect={() => setInput(`${candidate.table}.${candidate.name} `)}
                                                    className="group flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    {candidate.isPrimaryKey ? (
                                                        <Key className="h-3.5 w-3.5 text-yellow-400/80 shrink-0" />
                                                    ) : (
                                                        <ColTypeIcon dataType={candidate.dataType} />
                                                    )}
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate font-mono text-sm text-foreground/85">
                                                            <HighlightedText text={`${candidate.schema}.${candidate.table}.${candidate.name}`} query={input} />
                                                        </p>
                                                        <p className="truncate text-[11px] text-muted-foreground/50">
                                                            {candidate.dataType}
                                                            {candidate.isPrimaryKey ? " - primary key" : candidate.isNullable ? " - nullable" : " - not null"}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {groupedCatalog.functions.length > 0 && (
                                    <CommandGroup heading="Functions">
                                        {groupedCatalog.functions.map(({ candidate }) => {
                                            if (candidate.kind !== "function") return null;
                                            return (
                                                <CommandItem
                                                    key={candidate.key}
                                                    value={candidate.key}
                                                    onSelect={() =>
                                                        openPreviewObject({
                                                            kind: "function",
                                                            schema: candidate.schema,
                                                            name: candidate.name,
                                                            arguments: candidate.arguments,
                                                        })
                                                    }
                                                    className="group flex items-start gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    {candidate.isTriggerFunction ? (
                                                        <Zap className="mt-0.5 h-3.5 w-3.5 text-amber-400/80 shrink-0" />
                                                    ) : (
                                                        <Braces className="mt-0.5 h-3.5 w-3.5 text-violet-400/80 shrink-0" />
                                                    )}
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-foreground/90">
                                                            <HighlightedText
                                                                text={`${candidate.schema}.${candidate.name}(${candidate.arguments})`}
                                                                query={input}
                                                            />
                                                        </p>
                                                        <p className="truncate text-[11px] text-muted-foreground/50">
                                                            {candidate.functionKind} - {candidate.language}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {groupedCatalog.types.length > 0 && (
                                    <CommandGroup heading="Types">
                                        {groupedCatalog.types.map(({ candidate }) => {
                                            if (candidate.kind !== "type") return null;
                                            return (
                                                <CommandItem
                                                    key={candidate.key}
                                                    value={candidate.key}
                                                    onSelect={() =>
                                                        openPreviewObject({
                                                            kind: "type",
                                                            schema: candidate.schema,
                                                            name: candidate.name,
                                                        })
                                                    }
                                                    className="group flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    <Type className="h-3.5 w-3.5 text-rose-400/80 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-foreground/90">
                                                            <HighlightedText text={`${candidate.schema}.${candidate.name}`} query={input} />
                                                        </p>
                                                        <p className="truncate text-[11px] text-muted-foreground/50">
                                                            {candidate.typeKind}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {groupedCatalog.eventTriggers.length > 0 && (
                                    <CommandGroup heading="Event triggers">
                                        {groupedCatalog.eventTriggers.map(({ candidate }) => {
                                            if (candidate.kind !== "event_trigger") return null;
                                            return (
                                                <CommandItem
                                                    key={candidate.key}
                                                    value={candidate.key}
                                                    onSelect={() => {
                                                        void loadEventTriggers(undefined, false).finally(() => {
                                                            openPreviewObject({ kind: "event_trigger", name: candidate.name });
                                                        });
                                                    }}
                                                    className="group flex items-start gap-2.5 rounded-md px-2.5 py-2 cursor-pointer"
                                                >
                                                    <Zap className="mt-0.5 h-3.5 w-3.5 text-amber-400/80 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-foreground/90">
                                                            <HighlightedText text={candidate.name} query={input} />
                                                        </p>
                                                        <p className="truncate text-[11px] text-muted-foreground/50">
                                                            {candidate.event} - {candidate.functionName}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground/25 ml-0.5" />
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                )}

                                {parsed.type === "table" && parsed.filter && (
                                    <>
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
                                                    SELECT * FROM <span className="text-foreground/80 font-mono">&quot;{parsed.filter}&quot;</span> LIMIT 100
                                                </span>
                                            </CommandItem>
                                        </CommandGroup>
                                    </>
                                )}

                                {filteredSavedSearches.length === 0 &&
                                    filteredRecentSearches.length === 0 &&
                                    groupedCatalog.tablesAndViews.length === 0 &&
                                    groupedCatalog.columns.length === 0 &&
                                    groupedCatalog.functions.length === 0 &&
                                    groupedCatalog.types.length === 0 &&
                                    groupedCatalog.eventTriggers.length === 0 && (
                                        <CommandEmpty className="py-12 text-center text-sm text-muted-foreground/50">
                                            No matches found. Try broader terms or adjust filters.
                                        </CommandEmpty>
                                    )}
                            </>
                        )}

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
                                        <span className="text-sm">Loading columns...</span>
                                    </div>
                                ) : displayColumns.length > 0 ? (
                                    displayColumns.map((col) => (
                                        <ColumnRow
                                            key={col.name}
                                            col={col}
                                            input={input}
                                            onSelect={() => setInput(`${parsed.table}.${col.name} `)}
                                        />
                                    ))
                                ) : (
                                    <CommandEmpty className="py-6 text-sm text-muted-foreground/50">
                                        No columns found
                                    </CommandEmpty>
                                )}
                            </CommandGroup>
                        )}

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
                                        onSelect={() => setInput(`${parsed.table}.${parsed.col} ${op.label} `)}
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

                        {isConnected && parsed.type === "value" && (
                            <>
                                <CommandGroup heading="Execute">
                                    <CommandItem
                                        value="run-search"
                                        onSelect={runStructured}
                                        disabled={isExecuting}
                                        className={cn(
                                            "group flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer",
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
                                                {isExecuting ? "Running..." : "Run search query"}
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
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleSaveQuery(
                                                    `${parsed.table}.${parsed.col} ${parsed.op}`,
                                                    `${parsed.table}.${parsed.col} ${parsed.op} ${parsed.value}`.trim(),
                                                    previewSQL
                                                );
                                            }}
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/30 hover:bg-muted/50"
                                            title={savedBySignature.has(searchSignature(`${parsed.table}.${parsed.col} ${parsed.op} ${parsed.value}`.trim(), previewSQL)) ? "Unsave" : "Save search"}
                                        >
                                            {savedBySignature.has(searchSignature(`${parsed.table}.${parsed.col} ${parsed.op} ${parsed.value}`.trim(), previewSQL)) ? (
                                                <BookmarkCheck className="h-3.5 w-3.5 text-emerald-400" />
                                            ) : (
                                                <Bookmark className="h-3.5 w-3.5 text-muted-foreground/70" />
                                            )}
                                        </button>
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
                                                    {parsed.value || <span className="italic text-muted-foreground/30">value...</span>}
                                                </span>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="h-4 px-1.5 text-[9px] border-border/20 text-muted-foreground/40"
                                            >
                                                {parsed.schema}
                                            </Badge>
                                        </div>

                                        {columns.length > 0 && (
                                            <CommandGroup heading="Also filter by column">
                                                {columns
                                                    .filter((col) => col.name !== parsed.col)
                                                    .slice(0, 8)
                                                    .map((col) => (
                                                        <ColumnRow
                                                            key={col.name}
                                                            col={col}
                                                            input={input}
                                                            onSelect={() => setInput(`${parsed.table}.${col.name} `)}
                                                            compact
                                                        />
                                                    ))}
                                            </CommandGroup>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {isConnected && parsed.type === "ai_nl" && (
                            <CommandGroup
                                heading={
                                    <span className="flex items-center gap-1.5">
                                        <Sparkles className="h-3 w-3 text-violet-400/70" />
                                        <span>Nova AI</span>
                                        {parsed.query && (
                                            <span className="text-muted-foreground/50 font-normal">
                                                - {parsed.query.slice(0, 40)}{parsed.query.length > 40 ? "..." : ""}
                                            </span>
                                        )}
                                    </span>
                                }
                            >
                                {!parsed.query ? (
                                    <div className="px-2.5 py-4 text-center text-xs text-muted-foreground/50">
                                        Type a natural language query after <span className="font-mono text-violet-400/70">?</span>
                                        <br />
                                        <span className="text-[10px] text-muted-foreground/30 font-mono mt-1 block">
                                            e.g. ? show all active drivers
                                        </span>
                                    </div>
                                ) : isAiLoading ? (
                                    <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground/50">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400/60" />
                                        <span className="text-sm">Nova is generating SQL...</span>
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
                                                    ? parsed.query.substring(0, 50) + "..."
                                                    : parsed.query
                                            )
                                        }
                                        disabled={isExecuting}
                                        className="group flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer"
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
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                const queryLabel = parsed.query.length > 50
                                                    ? parsed.query.substring(0, 50) + "..."
                                                    : parsed.query;
                                                toggleSaveQuery(queryLabel, queryLabel, aiGeneratedSQL);
                                            }}
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/30 hover:bg-muted/50"
                                        >
                                            {savedBySignature.has(searchSignature(parsed.query.length > 50 ? parsed.query.substring(0, 50) + "..." : parsed.query, aiGeneratedSQL)) ? (
                                                <BookmarkCheck className="h-3.5 w-3.5 text-emerald-400" />
                                            ) : (
                                                <Bookmark className="h-3.5 w-3.5 text-muted-foreground/70" />
                                            )}
                                        </button>
                                    </CommandItem>
                                ) : (
                                    <div className="px-3 py-3 text-xs text-muted-foreground/40">
                                        No SQL generated. Try rephrasing your query.
                                    </div>
                                )}
                            </CommandGroup>
                        )}

                        {isConnected && parsed.type === "raw_sql" && (
                            <CommandGroup heading="Execute SQL">
                                <CommandItem
                                    value="run-raw-sql"
                                    onSelect={() =>
                                        executeSearch(
                                            parsed.sql,
                                            parsed.sql.length > 60
                                                ? parsed.sql.substring(0, 60) + "..."
                                                : parsed.sql
                                        )
                                    }
                                    disabled={isExecuting}
                                    className="group flex items-start gap-3 rounded-md px-3 py-3 cursor-pointer"
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
                                        <span className="text-[10px] text-muted-foreground/30">Opens in Query tab</span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            const label = parsed.sql.length > 60
                                                ? parsed.sql.substring(0, 60) + "..."
                                                : parsed.sql;
                                            toggleSaveQuery(label, label, parsed.sql);
                                        }}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/30 hover:bg-muted/50"
                                    >
                                        {savedBySignature.has(searchSignature(parsed.sql.length > 60 ? parsed.sql.substring(0, 60) + "..." : parsed.sql, parsed.sql)) ? (
                                            <BookmarkCheck className="h-3.5 w-3.5 text-emerald-400" />
                                        ) : (
                                            <Bookmark className="h-3.5 w-3.5 text-muted-foreground/70" />
                                        )}
                                    </button>
                                </CommandItem>
                            </CommandGroup>
                        )}
                    </CommandList>

                    <div className="flex items-center justify-between border-t border-border/10 px-3 py-1.5">
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/30">
                            <span>↑↓ navigate</span>
                            <span>↵ select</span>
                            <span>esc close</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground/35 font-mono">
                            {parsed.type === "init" || parsed.type === "table"
                                ? `${visibleTables.length} tables · ${allFunctions.length} functions · ${allTypes.length} types`
                                : parsed.type === "column"
                                    ? "Select column to filter"
                                    : parsed.type === "operator"
                                        ? "Select operator"
                                        : parsed.type === "value"
                                            ? "Type value · ↵ run"
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

function ColumnRow({
    col,
    input,
    onSelect,
    compact,
}: {
    col: ColumnInfo;
    input: string;
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
                <HighlightedText text={col.name} query={input} />
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
