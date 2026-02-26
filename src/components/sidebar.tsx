"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShallow } from "zustand/react/shallow";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TableManagerDialog } from "@/components/table-manager-dialog";
import { SeedDataDialog } from "@/components/seed-data-dialog";
import { CreateTableDialog } from "@/components/create-table-dialog";
import { CreateEnumDialog } from "@/components/create-enum-dialog";
import { CreateDatabaseDialog } from "@/components/create-database-dialog";
import { AIDocWriterDialog } from "@/components/ai-doc-writer-dialog";
import {
    ChevronRight,
    ChevronDown,
    Table2,
    Database,
    RefreshCw,
    Eye,
    Search,
    X,
    Check,
    Loader2,
    Layers,
    Server,
    Zap,
    Code2,
    Type,
    Braces,
    Columns,
    ShieldCheck,
    Hash,
    Sparkles,
    Trash2,
    AlertTriangle,
    Copy,
    Play,
    Info,
    Plus,
    Clock3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function formatRowCount(count: number): string {
    if (count < 0) return "~";
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
}

const INDENT = 8;
const LEAF_INDENT = 24;
const SECTION_BATCH_SIZE = 120;

type SchemaSectionKey = "functions" | "triggerFunctions" | "types";
type RenderSectionKey = "tables" | "views" | "functions" | "triggerFunctions" | "types";

function TreeNode({
    icon: Icon,
    label,
    count,
    expanded,
    onToggle,
    isActive,
    level = 0,
    iconColor = "text-muted-foreground/60",
    onAdd,
    addTitle,
}: {
    icon: React.ElementType;
    label: string;
    count?: number;
    expanded: boolean;
    onToggle: () => void;
    isActive?: boolean;
    level?: number;
    iconColor?: string;
    onAdd?: () => void;
    addTitle?: string;
}) {
    return (
        <div
            className={cn(
                "group flex w-full items-center gap-1.5 py-[5px] text-left text-[11px] transition-all duration-100 cursor-pointer select-none",
                "hover:bg-white/[0.04] rounded-md",
                isActive && "bg-white/[0.06] text-foreground"
            )}
            style={{ paddingLeft: INDENT + level * 12, paddingRight: 6 }}
            onClick={onToggle}
        >
            <span className="flex items-center justify-center h-4 w-4 shrink-0 text-muted-foreground/40">
                {expanded
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
            </span>
            <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
            <span className={cn(
                "truncate flex-1 font-medium text-muted-foreground/80 group-hover:text-foreground/90 transition-colors",
                isActive && "text-foreground"
            )}>
                {label}
            </span>
            {count != null && (
                <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/35 px-1">
                    {count}
                </span>
            )}
            {onAdd && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAdd(); }}
                    title={addTitle ?? `Add ${label.toLowerCase()}`}
                    className="opacity-0 group-hover:opacity-100 transition-all h-4 w-4 flex items-center justify-center rounded hover:bg-emerald-500/15 text-muted-foreground/40 hover:text-emerald-400 shrink-0"
                >
                    <Plus className="h-2.5 w-2.5" />
                </button>
            )}
        </div>
    );
}

function SchemaSectionHeader({
    icon: Icon,
    label,
    count,
    iconColor = "text-muted-foreground/40",
    expanded,
    onToggle,
    onAdd,
    addTitle,
}: {
    icon: React.ElementType;
    label: string;
    count: number | string;
    iconColor?: string;
    expanded?: boolean;
    onToggle?: () => void;
    onAdd?: () => void;
    addTitle?: string;
}) {
    return (
        <div
            className={cn(
                "group flex items-center gap-1.5 py-1 pr-1.5 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/35 rounded-md",
                onToggle && "cursor-pointer hover:bg-white/[0.03]"
            )}
            style={{ paddingLeft: LEAF_INDENT + 16 }}
            onClick={onToggle}
        >
            {onToggle ? (
                <span className="flex h-3 w-3 items-center justify-center text-muted-foreground/35">
                    {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                </span>
            ) : (
                <span className="h-3 w-3 shrink-0" />
            )}
            <Icon className={cn("h-2.5 w-2.5 shrink-0", iconColor)} />
            <span>{label}</span>
            <span className="font-mono tabular-nums opacity-70">{count}</span>
            {onAdd && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAdd(); }}
                    title={addTitle ?? `Add ${label.toLowerCase()}`}
                    className="ml-auto opacity-0 group-hover:opacity-100 transition-all h-3.5 w-3.5 flex items-center justify-center rounded hover:bg-emerald-500/15 text-muted-foreground/40 hover:text-emerald-400"
                >
                    <Plus className="h-2 w-2" />
                </button>
            )}
        </div>
    );
}

function ObjectLeaf({
    icon: Icon,
    label,
    isActive,
    onClick,
    rowCount,
}: {
    icon: React.ElementType;
    label: string;
    isActive?: boolean;
    onClick: () => void;
    rowCount?: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "group flex w-full items-center gap-1.5 py-[4px] pr-2 text-left text-[11px] transition-all duration-100 rounded-md",
                "hover:bg-white/[0.04]",
                isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground/70 hover:text-foreground/85"
            )}
            style={{ paddingLeft: LEAF_INDENT + 16 }}
        >
            <span className={cn(
                "w-0.5 h-3 rounded-full shrink-0 transition-all",
                isActive ? "bg-primary opacity-100" : "bg-transparent"
            )} />
            <Icon className={cn("h-3 w-3 shrink-0", isActive ? "text-primary" : "text-muted-foreground/40 group-hover:text-muted-foreground/70")} />
            <span className={cn("truncate flex-1 font-mono text-[10.5px]", isActive && "font-medium")}>
                {label}
            </span>
            {rowCount != null && rowCount >= 0 && (
                <span className="text-[9px] font-mono tabular-nums text-muted-foreground/30 shrink-0">
                    {formatRowCount(rowCount)}
                </span>
            )}
        </button>
    );
}

function TableLeaf({
    schema,
    tableName,
    isView,
    isActive,
    rowCount,
    tableComment,
    onClick,
    onOpenManager,
    onSeedData,
}: {
    schema: string;
    tableName: string;
    isView: boolean;
    isActive: boolean;
    rowCount?: number;
    tableComment?: string | null;
    onClick: () => void;
    onOpenManager: (tab: string) => void;
    onSeedData?: (schema: string, table: string) => void;
}) {
    const copyName = () => {
        navigator.clipboard.writeText(tableName);
        toast.success("Table name copied");
    };
    const copyQualified = () => {
        navigator.clipboard.writeText(`"${schema}"."${tableName}"`);
        toast.success("Qualified name copied");
    };

    const Icon = isView ? Eye : Table2;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <button
                    type="button"
                    onClick={onClick}
                    title={tableComment?.trim() || undefined}
                    className={cn(
                        "group flex w-full items-center gap-1.5 py-[4px] pr-2 text-left text-[11px] transition-all duration-100 rounded-md",
                        "hover:bg-white/[0.04]",
                        isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground/70 hover:text-foreground/85"
                    )}
                    style={{ paddingLeft: LEAF_INDENT + 16 }}
                >
                    <span className={cn(
                        "w-0.5 h-3 rounded-full shrink-0 transition-all",
                        isActive ? "bg-primary opacity-100" : "bg-transparent"
                    )} />
                    <Icon className={cn(
                        "h-3 w-3 shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground/40 group-hover:text-muted-foreground/70"
                    )} />
                    <span className={cn("truncate flex-1 font-mono text-[10.5px]", isActive && "font-medium")}>
                        {tableName}
                    </span>
                    {rowCount != null && rowCount >= 0 && (
                        <span className="text-[9px] font-mono tabular-nums text-muted-foreground/30 shrink-0">
                            {formatRowCount(rowCount)}
                        </span>
                    )}
                </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
                <ContextMenuLabel className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3 text-muted-foreground/60" />
                    <span className="font-mono truncate">{tableName}</span>
                </ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onClick}>
                    <Eye className="h-3.5 w-3.5" />View Data
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("overview")}>
                    <Info className="h-3.5 w-3.5" />Table Details
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuLabel>Structure</ContextMenuLabel>
                <ContextMenuItem onClick={() => onOpenManager("columns")}>
                    <Columns className="h-3.5 w-3.5" />Manage Columns
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("constraints")}>
                    <ShieldCheck className="h-3.5 w-3.5" />View Constraints
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("indexes")}>
                    <Hash className="h-3.5 w-3.5" />View Indexes
                </ContextMenuItem>
                {!isView && (
                    <ContextMenuItem onClick={() => onOpenManager("triggers")}>
                        <Zap className="h-3.5 w-3.5" />View Triggers
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuLabel>Actions</ContextMenuLabel>
                {!isView && onSeedData && (
                    <ContextMenuItem onClick={() => onSeedData(schema, tableName)}>
                        <Sparkles className="h-3.5 w-3.5 text-amber-400" />Seed data…
                    </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => onOpenManager("sql")}>
                    <Play className="h-3.5 w-3.5 text-emerald-400" />Run SQL Script
                </ContextMenuItem>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Copy className="h-3.5 w-3.5" />Copy Name
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem onClick={copyName}>Table name only</ContextMenuItem>
                        <ContextMenuItem onClick={copyQualified}>Qualified (schema.table)</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                {!isView && (
                    <ContextMenuItem
                        onClick={() => onOpenManager("overview")}
                        className="text-amber-400 focus:text-amber-300 focus:bg-amber-500/10"
                    >
                        <AlertTriangle className="h-3.5 w-3.5" />Truncate Table…
                    </ContextMenuItem>
                )}
                <ContextMenuItem
                    onClick={() => onOpenManager("overview")}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                    <Trash2 className="h-3.5 w-3.5" />Drop {isView ? "View" : "Table"}…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function DropDatabaseConfirm({
    name,
    isDropping,
    onConfirm,
    onCancel,
}: {
    name: string;
    isDropping: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0f0f0f] shadow-2xl p-5 space-y-4 mx-4">
                <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 border border-destructive/20">
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                    </div>
                    <div className="space-y-1 pt-0.5">
                        <p className="text-sm font-semibold">Drop database?</p>
                        <p className="text-xs text-muted-foreground/70 leading-relaxed">
                            This will permanently delete{" "}
                            <span className="font-mono font-medium text-foreground/90 bg-white/[0.05] px-1 rounded">
                                {name}
                            </span>{" "}
                            and all its data.
                        </p>
                    </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={isDropping}
                        className="h-8 px-4 text-xs rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07] text-foreground/70 hover:text-foreground transition-all disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={isDropping}
                        className="h-8 px-4 text-xs rounded-lg bg-destructive/90 text-white hover:bg-destructive transition-all disabled:opacity-50 flex items-center gap-1.5"
                    >
                        {isDropping ? (
                            <><Loader2 className="h-3 w-3 animate-spin" />Dropping…</>
                        ) : (
                            <><Trash2 className="h-3 w-3" />Drop Database</>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function Sidebar({ onSelectObject }: { onSelectObject?: () => void } = {}) {
    const {
        schemas,
        tables,
        selectedSchema,
        selectedTable,
        expandedSchemas,
        isLoadingSchemas,
        isLoadingTables,
        databaseName,
        serverVersion,
        databases,
        isSwitchingDatabase,
        eventTriggers,
        eventTriggersStatus,
        eventTriggersError,
        schemaFunctions,
        schemaFunctionsStatus,
        schemaFunctionsError,
        schemaTypes,
        schemaTypesStatus,
        schemaTypesError,
        connectionId,
        toggleSchema,
        selectTable,
        selectPreview,
        previewSelection,
        refreshSchemas,
        switchDatabase,
        dropDatabase,
        isLoadingDatabases,
        loadEventTriggers,
        loadSchemaFunctions,
        loadSchemaTypes,
    } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            schemas: state.schemas,
            tables: state.tables,
            selectedSchema: state.selectedSchema,
            selectedTable: state.selectedTable,
            expandedSchemas: state.expandedSchemas,
            isLoadingSchemas: state.isLoadingSchemas,
            isLoadingTables: state.isLoadingTables,
            databaseName: state.databaseName,
            serverVersion: state.serverVersion,
            databases: state.databases,
            isSwitchingDatabase: state.isSwitchingDatabase,
            eventTriggers: state.eventTriggers,
            eventTriggersStatus: state.eventTriggersStatus,
            eventTriggersError: state.eventTriggersError,
            schemaFunctions: state.schemaFunctions,
            schemaFunctionsStatus: state.schemaFunctionsStatus,
            schemaFunctionsError: state.schemaFunctionsError,
            schemaTypes: state.schemaTypes,
            schemaTypesStatus: state.schemaTypesStatus,
            schemaTypesError: state.schemaTypesError,
            toggleSchema: state.toggleSchema,
            selectTable: state.selectTable,
            selectPreview: state.selectPreview,
            previewSelection: state.previewSelection,
            refreshSchemas: state.refreshSchemas,
            switchDatabase: state.switchDatabase,
            dropDatabase: state.dropDatabase,
            isLoadingDatabases: state.isLoadingDatabases,
            loadEventTriggers: state.loadEventTriggers,
            loadSchemaFunctions: state.loadSchemaFunctions,
            loadSchemaTypes: state.loadSchemaTypes,
        }))
    );

    const [search, setSearch] = useState("");
    const [databasesOpen, setDatabasesOpen] = useState(false);
    const [schemasOpen, setSchemasOpen] = useState(true);
    const [eventTriggersOpen, setEventTriggersOpen] = useState(false);
    const [dbPickerOpen, setDbPickerOpen] = useState(false);
    const [dbSearch, setDbSearch] = useState("");
    const dbPickerRef = useRef<HTMLDivElement>(null);

    const [schemaSectionOpen, setSchemaSectionOpen] = useState<Record<string, Record<SchemaSectionKey, boolean>>>({});
    const [sectionRenderLimit, setSectionRenderLimit] = useState<Record<string, number>>({});

    const [createDatabaseOpen, setCreateDatabaseOpen] = useState(false);
    const [dropDbName, setDropDbName] = useState<string | null>(null);
    const [isDroppingDb, setIsDroppingDb] = useState(false);
    const [docWriterOpen, setDocWriterOpen] = useState(false);

    const [managerDialog, setManagerDialog] = useState<{
        schema: string;
        table: string;
        tab: string;
    } | null>(null);
    const [seedDialog, setSeedDialog] = useState<{ schema: string; table: string } | null>(null);

    const [createTableSchema, setCreateTableSchema] = useState<string | null>(null);
    const [createEnumSchema, setCreateEnumSchema] = useState<string | null>(null);

    useEffect(() => {
        function handler(e: MouseEvent) {
            if (dbPickerRef.current && !dbPickerRef.current.contains(e.target as Node)) {
                setDbPickerOpen(false);
                setDbSearch("");
            }
        }
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    useEffect(() => {
        setSchemaSectionOpen({});
        setSectionRenderLimit({});
        setEventTriggersOpen(false);
    }, [databaseName]);

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";

    const searchLower = useMemo(() => search.trim().toLowerCase(), [search]);
    const hasSearch = searchLower.length > 0;

    const filteredDatabases = useMemo(
        () => databases.filter((db) => !dbSearch || db.toLowerCase().includes(dbSearch.toLowerCase())),
        [databases, dbSearch]
    );

    const tableBuckets = useMemo(() => {
        const out: Record<string, { tables: typeof tables; views: typeof tables }> = {};
        for (const table of tables) {
            if (hasSearch && !table.name.toLowerCase().includes(searchLower)) continue;
            if (!out[table.schema]) out[table.schema] = { tables: [], views: [] };
            if (table.table_type === "VIEW") out[table.schema].views.push(table);
            else out[table.schema].tables.push(table);
        }
        return out;
    }, [tables, hasSearch, searchLower]);

    const filteredFunctions = useMemo(() => {
        const out: Record<string, typeof schemaFunctions[string]> = {};
        for (const [schema, functions] of Object.entries(schemaFunctions)) {
            out[schema] = hasSearch
                ? functions.filter((fn) => fn.name.toLowerCase().includes(searchLower))
                : functions;
        }
        return out;
    }, [schemaFunctions, hasSearch, searchLower]);

    const filteredTypes = useMemo(() => {
        const out: Record<string, typeof schemaTypes[string]> = {};
        for (const [schema, types] of Object.entries(schemaTypes)) {
            out[schema] = hasSearch
                ? types.filter((typeItem) => typeItem.name.toLowerCase().includes(searchLower))
                : types;
        }
        return out;
    }, [schemaTypes, hasSearch, searchLower]);

    const loadedTableSchemas = useMemo(() => new Set(tables.map((table) => table.schema)), [tables]);

    const totalObjects = useMemo(() => {
        const loadedFunctions = Object.values(schemaFunctions).reduce((acc, list) => acc + list.length, 0);
        const loadedTypes = Object.values(schemaTypes).reduce((acc, list) => acc + list.length, 0);
        return tables.length + loadedFunctions + loadedTypes;
    }, [tables.length, schemaFunctions, schemaTypes]);

    const hasSearchMatch = useMemo(() => {
        if (!hasSearch) return true;
        return schemas.some((schema) => {
            const bucket = tableBuckets[schema.name];
            const fn = filteredFunctions[schema.name] ?? [];
            const types = filteredTypes[schema.name] ?? [];
            return (bucket?.tables.length ?? 0) > 0 || (bucket?.views.length ?? 0) > 0 || fn.length > 0 || types.length > 0;
        });
    }, [hasSearch, schemas, tableBuckets, filteredFunctions, filteredTypes]);

    const getSectionState = useCallback((schema: string) => (
        schemaSectionOpen[schema] ?? { functions: false, triggerFunctions: false, types: false }
    ), [schemaSectionOpen]);

    const toggleSection = useCallback((schema: string, section: SchemaSectionKey) => {
        setSchemaSectionOpen((prev) => {
            const current = prev[schema] ?? { functions: false, triggerFunctions: false, types: false };
            const nextValue = !current[section];
            if (nextValue) {
                if (section === "types") {
                    void loadSchemaTypes(schema);
                } else {
                    void loadSchemaFunctions(schema);
                }
            }
            return {
                ...prev,
                [schema]: {
                    ...current,
                    [section]: nextValue,
                },
            };
        });
    }, [loadSchemaFunctions, loadSchemaTypes]);

    const ensureSectionLimit = useCallback(
        (schema: string, section: RenderSectionKey, total: number) => {
            const key = `${schema}:${section}`;
            setSectionRenderLimit((prev) => ({
                ...prev,
                [key]: Math.min(total, (prev[key] ?? SECTION_BATCH_SIZE) + SECTION_BATCH_SIZE),
            }));
        },
        []
    );

    function getVisibleItems<T>(schema: string, section: RenderSectionKey, list: T[]) {
        const key = `${schema}:${section}`;
        const limit = Math.min(list.length, sectionRenderLimit[key] ?? SECTION_BATCH_SIZE);
        return {
            items: list.slice(0, limit),
            hasMore: list.length > limit,
            shown: limit,
        };
    }

    const handleEventTriggerToggle = useCallback(() => {
        setEventTriggersOpen((prev) => {
            const next = !prev;
            if (next) void loadEventTriggers();
            return next;
        });
    }, [loadEventTriggers]);

    const handleRefresh = useCallback(() => {
        setSchemaSectionOpen({});
        setSectionRenderLimit({});
        void refreshSchemas();
    }, [refreshSchemas]);

    const handleSwitchDatabase = useCallback((db: string) => {
        setDbPickerOpen(false);
        setDbSearch("");
        setSchemaSectionOpen({});
        setSectionRenderLimit({});
        void switchDatabase(db);
    }, [switchDatabase]);

    const handleDropDatabase = async (name: string) => {
        setIsDroppingDb(true);
        try {
            await dropDatabase(name);
            toast.success(`Database "${name}" dropped`);
        } catch (err) {
            const msg = String(err).replace(/^[a-z_]+:\s*/i, "");
            toast.error(msg || `Failed to drop "${name}"`);
        } finally {
            setIsDroppingDb(false);
            setDropDbName(null);
        }
    };

    return (
        <>
            <CreateDatabaseDialog
                open={createDatabaseOpen}
                onClose={() => setCreateDatabaseOpen(false)}
                onCreated={() => { }}
            />
            {dropDbName && (
                <DropDatabaseConfirm
                    name={dropDbName}
                    isDropping={isDroppingDb}
                    onConfirm={() => handleDropDatabase(dropDbName)}
                    onCancel={() => setDropDbName(null)}
                />
            )}
            {managerDialog && (
                <TableManagerDialog
                    open={!!managerDialog}
                    onClose={() => setManagerDialog(null)}
                    schema={managerDialog.schema}
                    table={managerDialog.table}
                    initialTab={managerDialog.tab}
                    onTableChanged={() => refreshSchemas()}
                />
            )}
            {createTableSchema !== null && (
                <CreateTableDialog
                    open={true}
                    onClose={() => setCreateTableSchema(null)}
                    defaultSchema={createTableSchema}
                    schemas={schemas.map((s) => s.name)}
                    onCreated={() => {
                        handleRefresh();
                        setCreateTableSchema(null);
                    }}
                />
            )}
            {createEnumSchema !== null && (
                <CreateEnumDialog
                    open={true}
                    onClose={() => setCreateEnumSchema(null)}
                    defaultSchema={createEnumSchema}
                    schemas={schemas.map((s) => s.name)}
                    onCreated={() => {
                        const schemaName = createEnumSchema;
                        if (schemaName) {
                            void loadSchemaTypes(schemaName, true);
                        }
                        setCreateEnumSchema(null);
                    }}
                />
            )}
            {docWriterOpen && <AIDocWriterDialog open={docWriterOpen} onOpenChange={setDocWriterOpen} />}
            {seedDialog && connectionId && (
                <SeedDataDialog
                    open={!!seedDialog}
                    onOpenChange={(o) => !o && setSeedDialog(null)}
                    connectionId={connectionId}
                    schema={seedDialog.schema}
                    table={seedDialog.table}
                    onSuccess={() => refreshSchemas()}
                />
            )}

            <div className="flex h-full w-full flex-col min-h-0 bg-[#0b0b0b] border-r border-white/[0.06] overflow-hidden">
                <div className="px-2.5 pt-3 pb-2 border-b border-white/[0.05] space-y-2 shrink-0">
                    <div className="flex items-center gap-1.5">
                        <div ref={dbPickerRef} className="relative flex-1 min-w-0">
                            <button
                                onClick={() => { setDbPickerOpen((o) => !o); setDbSearch(""); }}
                                disabled={isSwitchingDatabase || databases.length === 0}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition-all duration-150",
                                    "bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.06] hover:border-white/[0.10]",
                                    "disabled:opacity-40",
                                    dbPickerOpen && "bg-white/[0.06] border-primary/30 ring-1 ring-primary/10"
                                )}
                            >
                                <div className="flex h-5 w-5 items-center justify-center rounded-md bg-amber-500/15 border border-amber-500/20 shrink-0">
                                    {isSwitchingDatabase
                                        ? <Loader2 className="h-2.5 w-2.5 text-amber-400 animate-spin" />
                                        : <Server className="h-2.5 w-2.5 text-amber-400/90" />}
                                </div>
                                <span className="truncate font-semibold text-foreground/90 flex-1">
                                    {isSwitchingDatabase ? "Switching…" : databaseName || "Database"}
                                </span>
                                {pgVersion && (
                                    <span className="shrink-0 text-[9px] font-mono text-muted-foreground/30 hidden sm:block">
                                        PG {pgVersion}
                                    </span>
                                )}
                                <ChevronDown className={cn(
                                    "h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150",
                                    dbPickerOpen && "rotate-180"
                                )} />
                            </button>

                            {dbPickerOpen && databases.length > 0 && (
                                <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-white/[0.08] bg-[#101010] shadow-2xl shadow-black/60 overflow-hidden">
                                    {databases.length > 5 && (
                                        <div className="px-2 pt-2 pb-1.5 border-b border-white/[0.05]">
                                            <div className="relative">
                                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/30 pointer-events-none" />
                                                <Input
                                                    autoFocus
                                                    value={dbSearch}
                                                    onChange={(e) => setDbSearch(e.target.value)}
                                                    placeholder="Search databases…"
                                                    className="h-7 pl-7 text-xs bg-white/[0.04] border-white/[0.06] focus-visible:ring-0 rounded-lg"
                                                />
                                            </div>
                                        </div>
                                    )}
                                    <ScrollArea className="max-h-48">
                                        <div className="p-1">
                                            {filteredDatabases.map((db) => {
                                                const isCurrent = db === databaseName;
                                                return (
                                                    <button
                                                        key={db}
                                                        onClick={() => { if (!isCurrent) handleSwitchDatabase(db); }}
                                                        disabled={isCurrent}
                                                        className={cn(
                                                            "flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] text-left rounded-lg transition-all",
                                                            "hover:bg-white/[0.05]",
                                                            isCurrent ? "text-primary font-medium" : "text-foreground/70"
                                                        )}
                                                    >
                                                        <Database className="h-3 w-3 shrink-0 text-amber-400/60" />
                                                        <span className="truncate flex-1">{db}</span>
                                                        {isCurrent && <Check className="h-3 w-3 text-primary shrink-0" />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </ScrollArea>
                                    <div className="border-t border-white/[0.05] p-1">
                                        <button
                                            onClick={() => { setDbPickerOpen(false); setDbSearch(""); setCreateDatabaseOpen(true); }}
                                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] text-left text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/8 rounded-lg transition-all"
                                        >
                                            <Plus className="h-3 w-3 shrink-0" />
                                            <span>Create new database</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={handleRefresh}
                                    disabled={isLoadingSchemas || isSwitchingDatabase}
                                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-muted-foreground/40 hover:text-foreground/80 hover:bg-white/[0.06] hover:border-white/[0.09] transition-all disabled:opacity-30 shrink-0"
                                >
                                    <RefreshCw className={cn("h-3.5 w-3.5", isLoadingSchemas && "animate-spin")} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="right">Refresh</TooltipContent>
                        </Tooltip>
                    </div>

                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/30 pointer-events-none" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Filter objects…"
                            className="h-7 pl-7 pr-7 text-[11px] bg-white/[0.03] border-white/[0.06] focus:border-primary/30 focus-visible:ring-0 rounded-lg placeholder:text-muted-foreground/25"
                        />
                        {search && (
                            <button
                                type="button"
                                onClick={() => setSearch("")}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={() => setDocWriterOpen(true)}
                            className="flex h-7 items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 text-[10px] font-medium text-violet-200 hover:bg-violet-500/15 transition-colors"
                        >
                            <Sparkles className="h-3 w-3" />
                            AI Docs
                        </button>
                        <Link
                            href="/query-history"
                            className="flex h-7 items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/15 transition-colors"
                        >
                            <Clock3 className="h-3 w-3" />
                            Query History
                        </Link>
                    </div>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                    <div className="py-1.5 px-1.5">
                        {isLoadingSchemas ? (
                            <div className="space-y-1 px-1">
                                {[1, 2, 3, 4, 5].map((i) => (
                                    <Skeleton key={i} className="h-7 w-full rounded-lg opacity-30" />
                                ))}
                            </div>
                        ) : !hasSearchMatch && hasSearch ? (
                            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/30 px-4">
                                <Search className="h-7 w-7 mb-2.5 opacity-40" />
                                <p className="text-[11px] text-center">
                                    No matches for &ldquo;{search}&rdquo;
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-0.5">
                                <TreeNode
                                    icon={Zap}
                                    label="Event Triggers"
                                    count={eventTriggersStatus === "success" ? eventTriggers.length : undefined}
                                    expanded={eventTriggersOpen}
                                    onToggle={handleEventTriggerToggle}
                                    iconColor="text-violet-400/70"
                                />
                                {eventTriggersOpen && (
                                    <div className="ml-3 border-l border-white/[0.05] pl-0 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                        {eventTriggersStatus === "loading" && (
                                            <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/35" style={{ paddingLeft: LEAF_INDENT + 12 }}>
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                Loading event triggers…
                                            </div>
                                        )}
                                        {eventTriggersStatus === "error" && (
                                            <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: LEAF_INDENT + 12 }}>
                                                <span className="text-[10px] text-destructive/80 truncate max-w-[130px]">{eventTriggersError ?? "Failed to load"}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => void loadEventTriggers(true)}
                                                    className="h-5 px-1.5 rounded border border-destructive/30 text-[10px] text-destructive/80 hover:bg-destructive/10"
                                                >
                                                    Retry
                                                </button>
                                            </div>
                                        )}
                                        {eventTriggersStatus === "success" && eventTriggers.length === 0 && (
                                            <div className="py-1.5 text-[10px] text-muted-foreground/30 italic" style={{ paddingLeft: LEAF_INDENT + 12 }}>
                                                None
                                            </div>
                                        )}
                                        {eventTriggersStatus === "success" && eventTriggers.map((et) => (
                                            <ObjectLeaf
                                                key={et.name}
                                                icon={Zap}
                                                label={et.name}
                                                isActive={previewSelection?.kind === "event_trigger" && previewSelection.name === et.name}
                                                onClick={() => { onSelectObject?.(); selectPreview({ kind: "event_trigger", name: et.name }); }}
                                            />
                                        ))}
                                    </div>
                                )}

                                <TreeNode
                                    icon={Database}
                                    label="Databases"
                                    count={databases.length}
                                    expanded={databasesOpen}
                                    onToggle={() => setDatabasesOpen((o) => !o)}
                                    iconColor="text-amber-400/70"
                                    onAdd={() => setCreateDatabaseOpen(true)}
                                    addTitle="Create new database"
                                />
                                {databasesOpen && (
                                    <div className="ml-3 border-l border-white/[0.05] animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                        {isLoadingDatabases ? (
                                            <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/30" style={{ paddingLeft: LEAF_INDENT + 12 }}>
                                                <Loader2 className="h-3 w-3 animate-spin" />Loading…
                                            </div>
                                        ) : databases.length === 0 ? (
                                            <div className="py-1.5 text-[10px] text-muted-foreground/30 italic" style={{ paddingLeft: LEAF_INDENT + 12 }}>
                                                No databases
                                            </div>
                                        ) : (
                                            databases.map((db) => {
                                                const isCurrent = db === databaseName;
                                                return (
                                                    <ContextMenu key={db}>
                                                        <ContextMenuTrigger asChild>
                                                            <button
                                                                type="button"
                                                                onClick={() => !isCurrent && handleSwitchDatabase(db)}
                                                                disabled={isSwitchingDatabase}
                                                                className={cn(
                                                                    "group flex w-full items-center gap-1.5 py-[4px] pr-2 text-[11px] text-left transition-all rounded-md hover:bg-white/[0.04]",
                                                                    isCurrent ? "text-primary font-medium" : "text-muted-foreground/65 hover:text-foreground/85"
                                                                )}
                                                                style={{ paddingLeft: LEAF_INDENT + 16 }}
                                                            >
                                                                <span className={cn("w-0.5 h-3 rounded-full shrink-0", isCurrent ? "bg-primary" : "bg-transparent")} />
                                                                <Database className="h-3 w-3 shrink-0 text-amber-400/50" />
                                                                <span className="truncate flex-1 font-mono text-[10.5px]">{db}</span>
                                                                {isCurrent && <Check className="h-2.5 w-2.5 text-primary shrink-0" />}
                                                            </button>
                                                        </ContextMenuTrigger>
                                                        <ContextMenuContent className="w-48">
                                                            <ContextMenuLabel className="flex items-center gap-1.5">
                                                                <Database className="h-3 w-3 text-amber-400/60" />
                                                                <span className="font-mono truncate">{db}</span>
                                                            </ContextMenuLabel>
                                                            <ContextMenuSeparator />
                                                            {!isCurrent && (
                                                                <ContextMenuItem onClick={() => handleSwitchDatabase(db)} disabled={isSwitchingDatabase}>
                                                                    <Database className="h-3.5 w-3.5" />Connect
                                                                </ContextMenuItem>
                                                            )}
                                                            <ContextMenuItem onClick={() => { navigator.clipboard.writeText(db); toast.success("Name copied"); }}>
                                                                <Copy className="h-3.5 w-3.5" />Copy Name
                                                            </ContextMenuItem>
                                                            <ContextMenuSeparator />
                                                            <ContextMenuItem onClick={() => setDropDbName(db)} disabled={isCurrent} className="text-destructive focus:text-destructive">
                                                                <Trash2 className="h-3.5 w-3.5" />Drop Database…
                                                            </ContextMenuItem>
                                                        </ContextMenuContent>
                                                    </ContextMenu>
                                                );
                                            })
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => setCreateDatabaseOpen(true)}
                                            className="flex w-full items-center gap-1.5 py-[4px] pr-2 text-[10px] text-emerald-400/40 hover:text-emerald-400/80 transition-all rounded-md hover:bg-emerald-500/[0.06]"
                                            style={{ paddingLeft: LEAF_INDENT + 16 }}
                                        >
                                            <span className="w-0.5 h-3 rounded-full bg-transparent shrink-0" />
                                            <Plus className="h-2.5 w-2.5 shrink-0" />
                                            <span>New database</span>
                                        </button>
                                    </div>
                                )}

                                <TreeNode
                                    icon={Layers}
                                    label="Schemas"
                                    count={schemas.length}
                                    expanded={schemasOpen}
                                    onToggle={() => setSchemasOpen((o) => !o)}
                                    iconColor="text-sky-400/70"
                                />

                                {schemasOpen && (
                                    <div className="ml-3 border-l border-white/[0.05] animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                        {schemas.map((schema) => {
                                            const schemaName = schema.name;
                                            const isExpanded = expandedSchemas.has(schemaName);
                                            const bucket = tableBuckets[schemaName];
                                            const tableList = bucket?.tables ?? [];
                                            const viewList = bucket?.views ?? [];
                                            const loadedFunctionsForSchema = filteredFunctions[schemaName] ?? [];
                                            const funcs = loadedFunctionsForSchema.filter((fn) => !fn.is_trigger_function);
                                            const triggerFuncs = loadedFunctionsForSchema.filter((fn) => fn.is_trigger_function);
                                            const typeList = filteredTypes[schemaName] ?? [];
                                            const tablesLoaded = loadedTableSchemas.has(schemaName) || schema.table_count === 0;
                                            const shouldExpand =
                                                isExpanded ||
                                                (hasSearch && (tableList.length > 0 || viewList.length > 0 || funcs.length > 0 || triggerFuncs.length > 0 || typeList.length > 0));

                                            const sectionState = getSectionState(schemaName);
                                            const functionsOpen = sectionState.functions || (hasSearch && funcs.length > 0);
                                            const triggerFunctionsOpen = sectionState.triggerFunctions || (hasSearch && triggerFuncs.length > 0);
                                            const typesOpen = sectionState.types || (hasSearch && typeList.length > 0);

                                            const functionStatus = schemaFunctionsStatus[schemaName] ?? "idle";
                                            const typeStatus = schemaTypesStatus[schemaName] ?? "idle";

                                            const visibleTables = getVisibleItems(schemaName, "tables", tableList);
                                            const visibleViews = getVisibleItems(schemaName, "views", viewList);
                                            const visibleFunctions = getVisibleItems(schemaName, "functions", funcs);
                                            const visibleTriggerFunctions = getVisibleItems(schemaName, "triggerFunctions", triggerFuncs);
                                            const visibleTypes = getVisibleItems(schemaName, "types", typeList);

                                            return (
                                                <div key={schemaName}>
                                                    <TreeNode
                                                        icon={Layers}
                                                        label={schemaName}
                                                        count={schema.table_count}
                                                        expanded={shouldExpand}
                                                        onToggle={() => toggleSchema(schemaName)}
                                                        isActive={selectedSchema === schemaName && !selectedTable}
                                                        level={1}
                                                        iconColor="text-sky-400/60"
                                                    />

                                                    {shouldExpand && (
                                                        <div className="ml-3 border-l border-white/[0.05] py-0.5 space-y-0.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                                                            <SchemaSectionHeader
                                                                icon={Table2}
                                                                label="Tables"
                                                                count={tableList.length}
                                                                iconColor="text-emerald-500/60"
                                                                onAdd={() => setCreateTableSchema(schemaName)}
                                                                addTitle="Create new table"
                                                            />
                                                            {!tablesLoaded && isLoadingTables && (
                                                                <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/35" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                                    Loading tables…
                                                                </div>
                                                            )}
                                                            {visibleTables.items.map((tableItem) => (
                                                                <TableLeaf
                                                                    key={tableItem.name}
                                                                    schema={schemaName}
                                                                    tableName={tableItem.name}
                                                                    isView={false}
                                                                    rowCount={tableItem.row_count}
                                                                    tableComment={tableItem.table_comment}
                                                                    isActive={selectedSchema === schemaName && selectedTable === tableItem.name}
                                                                    onClick={() => { onSelectObject?.(); selectTable(schemaName, tableItem.name); }}
                                                                    onOpenManager={(tab) => setManagerDialog({ schema: schemaName, table: tableItem.name, tab })}
                                                                    onSeedData={(s, t) => setSeedDialog({ schema: s, table: t })}
                                                                />
                                                            ))}
                                                            {visibleTables.hasMore && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => ensureSectionLimit(schemaName, "tables", tableList.length)}
                                                                    className="ml-10 text-[10px] text-muted-foreground/45 hover:text-foreground/75 transition-colors"
                                                                >
                                                                    Show {Math.min(tableList.length - visibleTables.shown, SECTION_BATCH_SIZE)} more tables
                                                                </button>
                                                            )}

                                                            {viewList.length > 0 && (
                                                                <>
                                                                    <SchemaSectionHeader
                                                                        icon={Eye}
                                                                        label="Views"
                                                                        count={viewList.length}
                                                                        iconColor="text-blue-400/60"
                                                                    />
                                                                    {visibleViews.items.map((viewItem) => (
                                                                        <TableLeaf
                                                                            key={viewItem.name}
                                                                            schema={schemaName}
                                                                            tableName={viewItem.name}
                                                                            isView={true}
                                                                            rowCount={viewItem.row_count}
                                                                            tableComment={viewItem.table_comment}
                                                                            isActive={selectedSchema === schemaName && selectedTable === viewItem.name}
                                                                            onClick={() => { onSelectObject?.(); selectTable(schemaName, viewItem.name); }}
                                                                            onOpenManager={(tab) => setManagerDialog({ schema: schemaName, table: viewItem.name, tab })}
                                                                        />
                                                                    ))}
                                                                    {visibleViews.hasMore && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => ensureSectionLimit(schemaName, "views", viewList.length)}
                                                                            className="ml-10 text-[10px] text-muted-foreground/45 hover:text-foreground/75 transition-colors"
                                                                        >
                                                                            Show {Math.min(viewList.length - visibleViews.shown, SECTION_BATCH_SIZE)} more views
                                                                        </button>
                                                                    )}
                                                                </>
                                                            )}

                                                            <SchemaSectionHeader
                                                                icon={Code2}
                                                                label="Functions"
                                                                count={functionStatus === "success" ? funcs.length : "…"}
                                                                iconColor="text-violet-400/60"
                                                                expanded={functionsOpen}
                                                                onToggle={() => toggleSection(schemaName, "functions")}
                                                            />
                                                            {functionsOpen && (
                                                                <>
                                                                    {functionStatus === "loading" && (
                                                                        <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/35" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                                            Loading functions…
                                                                        </div>
                                                                    )}
                                                                    {functionStatus === "error" && (
                                                                        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <span className="text-[10px] text-destructive/80 truncate max-w-[130px]">
                                                                                {schemaFunctionsError[schemaName] ?? "Failed to load"}
                                                                            </span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => void loadSchemaFunctions(schemaName, true)}
                                                                                className="h-5 px-1.5 rounded border border-destructive/30 text-[10px] text-destructive/80 hover:bg-destructive/10"
                                                                            >
                                                                                Retry
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                    {functionStatus === "success" && visibleFunctions.items.map((fn) => {
                                                                        const key = `${fn.name}(${fn.arguments})`;
                                                                        const isActive =
                                                                            previewSelection?.kind === "function" &&
                                                                            previewSelection.schema === schemaName &&
                                                                            previewSelection.name === fn.name &&
                                                                            previewSelection.arguments === fn.arguments;
                                                                        return (
                                                                            <ObjectLeaf
                                                                                key={key}
                                                                                icon={Braces}
                                                                                label={fn.arguments ? `${fn.name}(${fn.arguments})` : fn.name}
                                                                                isActive={isActive}
                                                                                onClick={() => {
                                                                                    onSelectObject?.();
                                                                                    selectPreview({ kind: "function", schema: schemaName, name: fn.name, arguments: fn.arguments });
                                                                                }}
                                                                            />
                                                                        );
                                                                    })}
                                                                    {functionStatus === "success" && visibleFunctions.hasMore && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => ensureSectionLimit(schemaName, "functions", funcs.length)}
                                                                            className="ml-10 text-[10px] text-muted-foreground/45 hover:text-foreground/75 transition-colors"
                                                                        >
                                                                            Show {Math.min(funcs.length - visibleFunctions.shown, SECTION_BATCH_SIZE)} more functions
                                                                        </button>
                                                                    )}
                                                                    {functionStatus === "success" && funcs.length === 0 && (
                                                                        <div className="py-1.5 text-[10px] text-muted-foreground/30 italic" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            {hasSearch ? "No matches" : "None"}
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}

                                                            <SchemaSectionHeader
                                                                icon={Zap}
                                                                label="Trigger Functions"
                                                                count={functionStatus === "success" ? triggerFuncs.length : "…"}
                                                                iconColor="text-amber-400/60"
                                                                expanded={triggerFunctionsOpen}
                                                                onToggle={() => toggleSection(schemaName, "triggerFunctions")}
                                                            />
                                                            {triggerFunctionsOpen && (
                                                                <>
                                                                    {functionStatus === "loading" && (
                                                                        <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/35" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                                            Loading trigger functions…
                                                                        </div>
                                                                    )}
                                                                    {functionStatus === "error" && (
                                                                        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <span className="text-[10px] text-destructive/80 truncate max-w-[130px]">
                                                                                {schemaFunctionsError[schemaName] ?? "Failed to load"}
                                                                            </span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => void loadSchemaFunctions(schemaName, true)}
                                                                                className="h-5 px-1.5 rounded border border-destructive/30 text-[10px] text-destructive/80 hover:bg-destructive/10"
                                                                            >
                                                                                Retry
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                    {functionStatus === "success" && visibleTriggerFunctions.items.map((fn) => {
                                                                        const key = `tg_${fn.name}(${fn.arguments})`;
                                                                        const isActive =
                                                                            previewSelection?.kind === "function" &&
                                                                            previewSelection.schema === schemaName &&
                                                                            previewSelection.name === fn.name &&
                                                                            previewSelection.arguments === fn.arguments;
                                                                        return (
                                                                            <ObjectLeaf
                                                                                key={key}
                                                                                icon={Zap}
                                                                                label={fn.arguments ? `${fn.name}(${fn.arguments})` : fn.name}
                                                                                isActive={isActive}
                                                                                onClick={() => {
                                                                                    onSelectObject?.();
                                                                                    selectPreview({ kind: "function", schema: schemaName, name: fn.name, arguments: fn.arguments });
                                                                                }}
                                                                            />
                                                                        );
                                                                    })}
                                                                    {functionStatus === "success" && visibleTriggerFunctions.hasMore && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => ensureSectionLimit(schemaName, "triggerFunctions", triggerFuncs.length)}
                                                                            className="ml-10 text-[10px] text-muted-foreground/45 hover:text-foreground/75 transition-colors"
                                                                        >
                                                                            Show {Math.min(triggerFuncs.length - visibleTriggerFunctions.shown, SECTION_BATCH_SIZE)} more trigger functions
                                                                        </button>
                                                                    )}
                                                                    {functionStatus === "success" && triggerFuncs.length === 0 && (
                                                                        <div className="py-1.5 text-[10px] text-muted-foreground/30 italic" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            {hasSearch ? "No matches" : "None"}
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}

                                                            <SchemaSectionHeader
                                                                icon={Type}
                                                                label="Types"
                                                                count={typeStatus === "success" ? typeList.length : "…"}
                                                                iconColor="text-rose-400/60"
                                                                expanded={typesOpen}
                                                                onToggle={() => toggleSection(schemaName, "types")}
                                                                onAdd={() => setCreateEnumSchema(schemaName)}
                                                                addTitle="Create new enum"
                                                            />
                                                            {typesOpen && (
                                                                <>
                                                                    {typeStatus === "loading" && (
                                                                        <div className="flex items-center gap-1.5 py-1.5 text-[10px] text-muted-foreground/35" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                                            Loading types…
                                                                        </div>
                                                                    )}
                                                                    {typeStatus === "error" && (
                                                                        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            <span className="text-[10px] text-destructive/80 truncate max-w-[130px]">
                                                                                {schemaTypesError[schemaName] ?? "Failed to load"}
                                                                            </span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => void loadSchemaTypes(schemaName, true)}
                                                                                className="h-5 px-1.5 rounded border border-destructive/30 text-[10px] text-destructive/80 hover:bg-destructive/10"
                                                                            >
                                                                                Retry
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                    {typeStatus === "success" && visibleTypes.items.map((typeItem) => (
                                                                        <ObjectLeaf
                                                                            key={typeItem.name}
                                                                            icon={Type}
                                                                            label={`${typeItem.name} (${typeItem.kind})`}
                                                                            isActive={
                                                                                previewSelection?.kind === "type" &&
                                                                                previewSelection.schema === schemaName &&
                                                                                previewSelection.name === typeItem.name
                                                                            }
                                                                            onClick={() => {
                                                                                onSelectObject?.();
                                                                                selectPreview({ kind: "type", schema: schemaName, name: typeItem.name });
                                                                            }}
                                                                        />
                                                                    ))}
                                                                    {typeStatus === "success" && visibleTypes.hasMore && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => ensureSectionLimit(schemaName, "types", typeList.length)}
                                                                            className="ml-10 text-[10px] text-muted-foreground/45 hover:text-foreground/75 transition-colors"
                                                                        >
                                                                            Show {Math.min(typeList.length - visibleTypes.shown, SECTION_BATCH_SIZE)} more types
                                                                        </button>
                                                                    )}
                                                                    {typeStatus === "success" && typeList.length === 0 && (
                                                                        <div className="py-1.5 text-[10px] text-muted-foreground/30 italic" style={{ paddingLeft: LEAF_INDENT + 16 }}>
                                                                            {hasSearch ? "No matches" : "None"}
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}

                                                            {tablesLoaded &&
                                                                tableList.length === 0 &&
                                                                viewList.length === 0 &&
                                                                functionStatus === "idle" &&
                                                                typeStatus === "idle" && (
                                                                    <div style={{ paddingLeft: LEAF_INDENT + 16 }} className="py-1.5 flex items-center gap-2">
                                                                        <span className="text-[10px] text-muted-foreground/30 italic">
                                                                            {hasSearch ? "No matches" : "Empty schema"}
                                                                        </span>
                                                                        {!hasSearch && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => setCreateTableSchema(schemaName)}
                                                                                className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-emerald-400/50 hover:text-emerald-400 hover:bg-emerald-500/8 border border-emerald-500/15 transition-all"
                                                                            >
                                                                                <Plus className="h-2.5 w-2.5" />
                                                                                Create table
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                )}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </ScrollArea>

                <div className="px-3 py-2 border-t border-white/[0.05] shrink-0">
                    <p className="text-[9.5px] font-mono text-muted-foreground/25 tabular-nums">
                        {schemas.length} schema{schemas.length !== 1 ? "s" : ""} &middot; {totalObjects} loaded objects
                    </p>
                </div>
            </div>
        </>
    );
}
