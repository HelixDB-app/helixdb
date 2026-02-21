"use client";

import { useState, useRef, useEffect } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
import { CreateTableDialog } from "@/components/create-table-dialog";
import { CreateDatabaseDialog } from "@/components/create-database-dialog";
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
    Trash2,
    AlertTriangle,
    Copy,
    Play,
    Info,
    Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function formatRowCount(count: number): string {
    if (count < 0) return "~";
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
}

const INDENT = 10;
const LEAF_INDENT = 28;

/** Collapsible tree node with icon, label, pill count */
function TreeNode({
    icon: Icon,
    label,
    count,
    expanded,
    onToggle,
    isActive,
    level = 0,
    iconColor = "text-muted-foreground",
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
                "group flex w-full items-center gap-2 py-1.5 text-left text-xs transition-colors rounded-r-md",
                "hover:bg-accent/50",
                isActive && "bg-primary/10 text-primary"
            )}
            style={{ paddingLeft: INDENT + level * 14 }}
        >
            <button
                type="button"
                onClick={onToggle}
                className="flex flex-1 min-w-0 items-center gap-2"
            >
                {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
                <span className="truncate flex-1 font-medium">{label}</span>
                {count != null && (
                    <span className="shrink-0 min-w-[1.25rem] text-right text-[10px] font-mono text-muted-foreground/70 tabular-nums">
                        {count}
                    </span>
                )}
            </button>
            {onAdd && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAdd(); }}
                    title={addTitle ?? `Add ${label.toLowerCase()}`}
                    className="mr-1 opacity-0 group-hover:opacity-100 transition-opacity h-4 w-4 flex items-center justify-center rounded hover:bg-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 shrink-0"
                >
                    <Plus className="h-2.5 w-2.5" />
                </button>
            )}
        </div>
    );
}

/** Section header inside a schema (Tables, Views, Functions, etc.) */
function SchemaSectionHeader({
    icon: Icon,
    label,
    count,
    iconColor = "text-muted-foreground/70",
    onAdd,
    addTitle,
}: {
    icon: React.ElementType;
    label: string;
    count: number;
    iconColor?: string;
    onAdd?: () => void;
    addTitle?: string;
}) {
    return (
        <div
            className="group flex items-center gap-2 py-1 pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 border-l-2 border-transparent"
            style={{ paddingLeft: LEAF_INDENT + 4 }}
        >
            <Icon className={cn("h-3 w-3 shrink-0", iconColor)} />
            <span>{label}</span>
            <span className="font-mono tabular-nums">({count})</span>
            {onAdd && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAdd(); }}
                    title={addTitle ?? `Add ${label.toLowerCase()}`}
                    className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity h-4 w-4 flex items-center justify-center rounded hover:bg-emerald-500/20 text-emerald-400/70 hover:text-emerald-400"
                >
                    <Plus className="h-2.5 w-2.5" />
                </button>
            )}
        </div>
    );
}

/** Clickable leaf (table, view, function, type) */
function ObjectLeaf({
    icon: Icon,
    label,
    subtitle,
    isActive,
    onClick,
    rowCount,
}: {
    icon: React.ElementType;
    label: string;
    subtitle?: string;
    isActive?: boolean;
    onClick: () => void;
    rowCount?: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 py-1 pr-2 text-left text-xs transition-colors rounded-r-md",
                "hover:bg-accent/40",
                isActive && "bg-primary/10 border-r-2 border-primary text-primary"
            )}
            style={{ paddingLeft: LEAF_INDENT + 20 }}
        >
            <span className="w-3.5 shrink-0" />
            <Icon
                className={cn(
                    "h-3 w-3 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground/60"
                )}
            />
            <span className={cn("truncate flex-1", isActive && "font-medium")}>
                {label}
            </span>
            {rowCount != null && rowCount >= 0 && (
                <span className="text-[9px] font-mono text-muted-foreground/40 tabular-nums shrink-0">
                    {formatRowCount(rowCount)}
                </span>
            )}
        </button>
    );
}

/** Table/View leaf wrapped with a right-click context menu */
function TableLeaf({
    schema,
    tableName,
    isView,
    isActive,
    rowCount,
    onClick,
    onOpenManager,
}: {
    schema: string;
    tableName: string;
    isView: boolean;
    isActive: boolean;
    rowCount?: number;
    onClick: () => void;
    onOpenManager: (tab: string) => void;
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
                    className={cn(
                        "flex w-full items-center gap-2 py-1 pr-2 text-left text-xs transition-colors rounded-r-md",
                        "hover:bg-accent/40",
                        isActive && "bg-primary/10 border-r-2 border-primary text-primary"
                    )}
                    style={{ paddingLeft: LEAF_INDENT + 20 }}
                >
                    <span className="w-3.5 shrink-0" />
                    <Icon
                        className={cn(
                            "h-3 w-3 shrink-0",
                            isActive ? "text-primary" : "text-muted-foreground/60"
                        )}
                    />
                    <span className={cn("truncate flex-1", isActive && "font-medium")}>
                        {tableName}
                    </span>
                    {rowCount != null && rowCount >= 0 && (
                        <span className="text-[9px] font-mono text-muted-foreground/40 tabular-nums shrink-0">
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
                    <Eye className="h-3.5 w-3.5" />
                    View Data
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("overview")}>
                    <Info className="h-3.5 w-3.5" />
                    Table Details
                </ContextMenuItem>

                <ContextMenuSeparator />
                <ContextMenuLabel>Structure</ContextMenuLabel>

                <ContextMenuItem onClick={() => onOpenManager("columns")}>
                    <Columns className="h-3.5 w-3.5" />
                    Manage Columns
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("constraints")}>
                    <ShieldCheck className="h-3.5 w-3.5" />
                    View Constraints
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenManager("indexes")}>
                    <Hash className="h-3.5 w-3.5" />
                    View Indexes
                </ContextMenuItem>
                {!isView && (
                    <ContextMenuItem onClick={() => onOpenManager("triggers")}>
                        <Zap className="h-3.5 w-3.5" />
                        View Triggers
                    </ContextMenuItem>
                )}

                <ContextMenuSeparator />
                <ContextMenuLabel>Actions</ContextMenuLabel>

                <ContextMenuItem onClick={() => onOpenManager("sql")}>
                    <Play className="h-3.5 w-3.5 text-emerald-400" />
                    Run SQL Script
                </ContextMenuItem>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Copy className="h-3.5 w-3.5" />
                        Copy Name
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem onClick={copyName}>
                            Table name only
                        </ContextMenuItem>
                        <ContextMenuItem onClick={copyQualified}>
                            Qualified (schema.table)
                        </ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>

                <ContextMenuSeparator />

                {!isView && (
                    <ContextMenuItem
                        onClick={() => onOpenManager("overview")}
                        className="text-amber-400 focus:text-amber-300 focus:bg-amber-500/10"
                    >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Truncate Table…
                    </ContextMenuItem>
                )}
                <ContextMenuItem
                    onClick={() => onOpenManager("overview")}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Drop {isView ? "View" : "Table"}…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Read-only leaf (e.g. event trigger, function name without table select) */
function InfoLeaf({
    icon: Icon,
    label,
    subtitle,
    iconColor = "text-muted-foreground/60",
}: {
    icon: React.ElementType;
    label: string;
    subtitle?: string;
    iconColor?: string;
}) {
    return (
        <div
            className="flex items-center gap-2 py-1 pr-2 text-xs text-muted-foreground/80 rounded-r-md"
            style={{ paddingLeft: LEAF_INDENT + 20 }}
        >
            <span className="w-3.5 shrink-0" />
            <Icon className={cn("h-3 w-3 shrink-0", iconColor)} />
            <span className="truncate flex-1 font-mono text-[11px]">{label}</span>
        </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl border border-border/40 bg-card shadow-2xl p-5 space-y-4 mx-4">
                <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/15">
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                    </div>
                    <div className="space-y-1">
                        <p className="text-sm font-semibold">Drop database?</p>
                        <p className="text-xs text-muted-foreground">
                            This will permanently delete{" "}
                            <span className="font-mono font-medium text-foreground">
                                {name}
                            </span>{" "}
                            and all its data. This action cannot be undone.
                        </p>
                    </div>
                </div>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={isDropping}
                        className="h-8 px-3 text-xs rounded-lg border border-border/40 bg-background/60 hover:bg-accent/50 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={isDropping}
                        className="h-8 px-3 text-xs rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                        {isDropping ? (
                            <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Dropping…
                            </>
                        ) : (
                            <>
                                <Trash2 className="h-3 w-3" />
                                Drop Database
                            </>
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
        isLoadingSchemaObjects,
        databaseName,
        serverVersion,
        databases,
        isSwitchingDatabase,
        eventTriggers,
        schemaFunctions,
        schemaTypes,
        toggleSchema,
        selectTable,
        selectPreview,
        previewSelection,
        refreshSchemas,
        switchDatabase,
        dropDatabase,
        isLoadingDatabases,
    } = useConnectionStore();

    const [search, setSearch] = useState("");
    const [databasesOpen, setDatabasesOpen] = useState(false);
    const [schemasOpen, setSchemasOpen] = useState(true);
    const [eventTriggersOpen, setEventTriggersOpen] = useState(false);
    const [dbPickerOpen, setDbPickerOpen] = useState(false);
    const [dbSearch, setDbSearch] = useState("");
    const dbPickerRef = useRef<HTMLDivElement>(null);

    // Create Database Dialog
    const [createDatabaseOpen, setCreateDatabaseOpen] = useState(false);
    // Drop database confirmation
    const [dropDbName, setDropDbName] = useState<string | null>(null);
    const [isDroppingDb, setIsDroppingDb] = useState(false);

    // Table Manager Dialog
    const [managerDialog, setManagerDialog] = useState<{
        schema: string;
        table: string;
        tab: string;
    } | null>(null);

    // Create Table Dialog
    const [createTableSchema, setCreateTableSchema] = useState<string | null>(null);

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

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";

    const filteredTablesForSchema = (schema: string) =>
        tables
            .filter((t) => t.schema === schema)
            .filter(
                (t) =>
                    !search ||
                    t.name.toLowerCase().includes(search.toLowerCase())
            );
    const filterSchemaObjects = <T extends { name: string }>(list: T[]) =>
        !search
            ? list
            : list.filter((x) =>
                  x.name.toLowerCase().includes(search.toLowerCase())
              );

    const tablesBySchema = (schema: string) =>
        tables.filter((t) => t.schema === schema && t.table_type !== "VIEW");
    const viewsBySchema = (schema: string) =>
        tables.filter((t) => t.schema === schema && t.table_type === "VIEW");
    const functionsBySchema = (schema: string) =>
        schemaFunctions[schema]?.filter((f) => !f.is_trigger_function) ?? [];
    const triggerFunctionsBySchema = (schema: string) =>
        schemaFunctions[schema]?.filter((f) => f.is_trigger_function) ?? [];
    const typesBySchema = (schema: string) => schemaTypes[schema] ?? [];

    const totalObjects =
        tables.length +
        Object.values(schemaFunctions).flat().length +
        Object.values(schemaTypes).flat().length;
    const hasSearch = search.length > 0;
    const hasSearchMatch =
        !hasSearch ||
        schemas.some((s) => filteredTablesForSchema(s.name).length > 0) ||
        schemas.some((s) => {
            const f = filterSchemaObjects(functionsBySchema(s.name));
            const t = filterSchemaObjects(typesBySchema(s.name));
            return f.length > 0 || t.length > 0;
        });

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
            onCreated={() => {}}
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
                onCreated={(_schema, _table) => {
                    refreshSchemas();
                    setCreateTableSchema(null);
                }}
            />
        )}
        <div className="flex h-full w-full flex-col min-h-0 bg-card/10 border-r border-border/20 overflow-hidden">
            {/* Header */}
            <div className="px-3 pt-3 pb-2.5 border-b border-border/20 bg-card/20 space-y-2 shrink-0">
                <div className="flex items-center gap-1.5">
                    <div ref={dbPickerRef} className="relative flex-1 min-w-0">
                        <button
                            onClick={() => {
                                setDbPickerOpen((o) => !o);
                                setDbSearch("");
                            }}
                            disabled={isSwitchingDatabase || databases.length === 0}
                            className={cn(
                                "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-all",
                                "bg-background/60 border border-border/30 hover:border-primary/30",
                                "disabled:opacity-50",
                                dbPickerOpen && "border-primary/40 ring-1 ring-primary/10"
                            )}
                        >
                            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-amber-500/20 shrink-0">
                                {isSwitchingDatabase ? (
                                    <Loader2 className="h-2.5 w-2.5 text-amber-400 animate-spin" />
                                ) : (
                                    <Server className="h-2.5 w-2.5 text-amber-400" />
                                )}
                            </div>
                            <span className="truncate font-semibold text-foreground/95">
                                {isSwitchingDatabase ? "Switching…" : databaseName || "Database"}
                            </span>
                            <ChevronDown
                                className={cn(
                                    "h-3 w-3 text-muted-foreground/50 shrink-0 ml-auto transition-transform",
                                    dbPickerOpen && "rotate-180"
                                )}
                            />
                        </button>

                        {dbPickerOpen && databases.length > 0 && (
                            <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-border/40 bg-card shadow-xl overflow-hidden">
                                {databases.length > 5 && (
                                    <div className="px-2 pt-2 pb-1 border-b border-border/20">
                                        <div className="relative">
                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                                            <Input
                                                autoFocus
                                                value={dbSearch}
                                                onChange={(e) => setDbSearch(e.target.value)}
                                                placeholder="Search databases…"
                                                className="h-8 pl-8 text-xs bg-background/50 border-border/30 focus-visible:ring-0 rounded-lg"
                                            />
                                        </div>
                                    </div>
                                )}
                                <ScrollArea className="max-h-52">
                                    <div className="py-1">
                                        {databases
                                            .filter(
                                                (db) =>
                                                    !dbSearch ||
                                                    db
                                                        .toLowerCase()
                                                        .includes(dbSearch.toLowerCase())
                                            )
                                            .map((db) => {
                                                const isCurrent = db === databaseName;
                                                return (
                                                    <button
                                                        key={db}
                                                        onClick={() => {
                                                            setDbPickerOpen(false);
                                                            setDbSearch("");
                                                            switchDatabase(db);
                                                        }}
                                                        disabled={isCurrent}
                                                        className={cn(
                                                            "flex w-full items-center gap-2 px-3 py-2 text-xs text-left transition-colors hover:bg-accent/50 rounded-lg mx-1",
                                                            isCurrent && "text-primary font-medium"
                                                        )}
                                                    >
                                                        <Database className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                                                        <span className="truncate flex-1">{db}</span>
                                                        {isCurrent && (
                                                            <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                                                        )}
                                                    </button>
                                                );
                                            })}
                                    </div>
                                </ScrollArea>
                                <div className="border-t border-border/20 p-1">
                                    <button
                                        onClick={() => {
                                            setDbPickerOpen(false);
                                            setDbSearch("");
                                            setCreateDatabaseOpen(true);
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-left text-emerald-400/80 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                                    >
                                        <Plus className="h-3.5 w-3.5 shrink-0" />
                                        <span>Create new database</span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground shrink-0"
                                onClick={refreshSchemas}
                                disabled={isLoadingSchemas || isSwitchingDatabase}
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-3.5 w-3.5",
                                        isLoadingSchemas && "animate-spin"
                                    )}
                                />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">Refresh</TooltipContent>
                    </Tooltip>
                </div>

                {pgVersion && (
                    <p className="text-[10px] text-muted-foreground/50 font-mono px-1">
                        PostgreSQL {pgVersion}
                    </p>
                )}

                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter objects…"
                        className="h-8 pl-8 pr-8 text-xs bg-background/50 border-border/25 focus:border-primary/40 focus-visible:ring-0 rounded-lg"
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={() => setSearch("")}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>

            {/* Object tree — min-h-0 lets this flex child shrink so ScrollArea can overflow */}
            <ScrollArea className="flex-1 min-h-0">
                <div className="py-2">
                    {isLoadingSchemas ? (
                        <div className="space-y-1.5 px-2">
                            {[1, 2, 3, 4, 5, 6].map((i) => (
                                <Skeleton key={i} className="h-8 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : !hasSearchMatch && hasSearch ? (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground px-4">
                            <Search className="h-8 w-8 mb-3 opacity-20" />
                            <p className="text-xs text-center">
                                No objects matching &quot;{search}&quot;
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {/* Event Triggers */}
                            <TreeNode
                                icon={Zap}
                                label="Event Triggers"
                                count={eventTriggers.length}
                                expanded={eventTriggersOpen}
                                onToggle={() => setEventTriggersOpen((o) => !o)}
                                iconColor="text-violet-400/90"
                            />
                            {eventTriggersOpen && (
                                <div className="ml-1 border-l border-border/20 pl-0.5">
                                    {eventTriggers.length === 0 ? (
                                        <div
                                            className="py-2 text-[10px] text-muted-foreground/50 italic"
                                            style={{ paddingLeft: LEAF_INDENT + 20 }}
                                        >
                                            None
                                        </div>
                                    ) : (
                                        eventTriggers.map((et) => (
                                            <ObjectLeaf
                                                key={et.name}
                                                icon={Zap}
                                                label={et.name}
                                                isActive={
                                                    previewSelection?.kind === "event_trigger" &&
                                                    previewSelection.name === et.name
                                                }
                                                onClick={() => {
                                                    onSelectObject?.();
                                                    selectPreview({ kind: "event_trigger", name: et.name });
                                                }}
                                            />
                                        ))
                                    )}
                                </div>
                            )}

                            {/* Databases */}
                            <TreeNode
                                icon={Database}
                                label="Databases"
                                count={databases.length}
                                expanded={databasesOpen}
                                onToggle={() => setDatabasesOpen((o) => !o)}
                                iconColor="text-amber-400/90"
                                onAdd={() => setCreateDatabaseOpen(true)}
                                addTitle="Create new database"
                            />
                            {databasesOpen && (
                                <div className="ml-1 border-l border-border/20 pl-0.5">
                                    {isLoadingDatabases ? (
                                        <div
                                            className="flex items-center gap-1.5 py-2 text-[10px] text-muted-foreground/50"
                                            style={{ paddingLeft: LEAF_INDENT + 20 }}
                                        >
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Loading…
                                        </div>
                                    ) : databases.length === 0 ? (
                                        <div
                                            className="py-2 text-[10px] text-muted-foreground/50 italic"
                                            style={{ paddingLeft: LEAF_INDENT + 20 }}
                                        >
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
                                                            onClick={() => !isCurrent && switchDatabase(db)}
                                                            disabled={isSwitchingDatabase}
                                                            className={cn(
                                                                "flex w-full items-center gap-2 py-1.5 pr-2 text-xs text-left transition-colors rounded-r-md hover:bg-accent/40",
                                                                isCurrent && "text-primary font-medium"
                                                            )}
                                                            style={{ paddingLeft: LEAF_INDENT + 20 }}
                                                        >
                                                            <span className="w-3.5 shrink-0" />
                                                            <Database className="h-3 w-3 shrink-0 text-amber-400/80" />
                                                            <span className="truncate flex-1">{db}</span>
                                                            {isCurrent && (
                                                                <Check className="h-3 w-3 text-primary shrink-0" />
                                                            )}
                                                        </button>
                                                    </ContextMenuTrigger>
                                                    <ContextMenuContent className="w-48">
                                                        <ContextMenuLabel className="flex items-center gap-1.5">
                                                            <Database className="h-3 w-3 text-amber-400/80" />
                                                            <span className="font-mono truncate">{db}</span>
                                                        </ContextMenuLabel>
                                                        <ContextMenuSeparator />
                                                        {!isCurrent && (
                                                            <ContextMenuItem
                                                                onClick={() => switchDatabase(db)}
                                                                disabled={isSwitchingDatabase}
                                                            >
                                                                <Database className="h-3.5 w-3.5" />
                                                                Connect
                                                            </ContextMenuItem>
                                                        )}
                                                        <ContextMenuItem
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(db);
                                                                toast.success("Name copied");
                                                            }}
                                                        >
                                                            <Copy className="h-3.5 w-3.5" />
                                                            Copy Name
                                                        </ContextMenuItem>
                                                        <ContextMenuSeparator />
                                                        <ContextMenuItem
                                                            onClick={() => setDropDbName(db)}
                                                            disabled={isCurrent}
                                                            className="text-destructive focus:text-destructive"
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                            Drop Database…
                                                        </ContextMenuItem>
                                                    </ContextMenuContent>
                                                </ContextMenu>
                                            );
                                        })
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setCreateDatabaseOpen(true)}
                                        className="flex w-full items-center gap-1.5 py-1.5 pr-2 text-[10px] text-emerald-400/60 hover:text-emerald-400 transition-colors rounded-r-md hover:bg-emerald-500/10"
                                        style={{ paddingLeft: LEAF_INDENT + 20 }}
                                    >
                                        <span className="w-3.5 shrink-0" />
                                        <Plus className="h-2.5 w-2.5 shrink-0" />
                                        <span>New database</span>
                                    </button>
                                </div>
                            )}

                            {/* Schemas */}
                            <TreeNode
                                icon={Layers}
                                label="Schemas"
                                count={schemas.length}
                                expanded={schemasOpen}
                                onToggle={() => setSchemasOpen((o) => !o)}
                                iconColor="text-sky-400/90"
                            />

                            {schemasOpen && (
                                <div className="ml-1 border-l border-border/20">
                                    {schemas.map((schema) => {
                                        const isExpanded = expandedSchemas.has(schema.name);
                                        const schemaTables = tablesBySchema(schema.name);
                                        const schemaViews = viewsBySchema(schema.name);
                                        const funcs = filterSchemaObjects(
                                            functionsBySchema(schema.name)
                                        );
                                        const triggerFuncs = filterSchemaObjects(
                                            triggerFunctionsBySchema(schema.name)
                                        );
                                        const typeList = filterSchemaObjects(
                                            typesBySchema(schema.name)
                                        );
                                        const filteredT = filteredTablesForSchema(schema.name);
                                        const tableList = filteredT.filter(
                                            (t) => t.table_type !== "VIEW"
                                        );
                                        const viewList = filteredT.filter(
                                            (t) => t.table_type === "VIEW"
                                        );
                                        const allTablesLoaded = tables.some(
                                            (t) => t.schema === schema.name
                                        );
                                        const shouldExpand =
                                            isExpanded ||
                                            (hasSearch &&
                                                (filteredT.length > 0 ||
                                                    funcs.length > 0 ||
                                                    typeList.length > 0));

                                        return (
                                            <div key={schema.name}>
                                                <TreeNode
                                                    icon={Layers}
                                                    label={schema.name}
                                                    count={schema.table_count}
                                                    expanded={shouldExpand}
                                                    onToggle={() => toggleSchema(schema.name)}
                                                    isActive={
                                                        selectedSchema === schema.name && !selectedTable
                                                    }
                                                    level={1}
                                                    iconColor="text-sky-400/80"
                                                />

                                                {shouldExpand && (
                                                    <div className="ml-1 border-l border-border/20 space-y-1 py-1">
                                                        {isLoadingSchemaObjects &&
                                                            !schemaFunctions[schema.name] &&
                                                            !schemaTypes[schema.name] && (
                                                                <div
                                                                    className="flex gap-1 px-2"
                                                                    style={{
                                                                        paddingLeft: LEAF_INDENT + 16,
                                                                    }}
                                                                >
                                                                    <Skeleton className="h-5 flex-1 rounded" />
                                                                    <Skeleton className="h-5 flex-1 rounded" />
                                                                </div>
                                                            )}

                                                        {/* Tables */}
                                                        {(tableList.length > 0 || allTablesLoaded) && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Table2}
                                                                    label="Tables"
                                                                    count={tableList.length}
                                                                    iconColor="text-emerald-500/80"
                                                                    onAdd={() => setCreateTableSchema(schema.name)}
                                                                    addTitle="Create new table"
                                                                />
                                                                {tableList.map((t) => (
                                                                    <TableLeaf
                                                                        key={t.name}
                                                                        schema={schema.name}
                                                                        tableName={t.name}
                                                                        isView={false}
                                                                        rowCount={t.row_count}
                                                                        isActive={
                                                                            selectedSchema === schema.name &&
                                                                            selectedTable === t.name
                                                                        }
                                                                        onClick={() => {
                                                                            onSelectObject?.();
                                                                            selectTable(schema.name, t.name);
                                                                        }}
                                                                        onOpenManager={(tab) =>
                                                                            setManagerDialog({ schema: schema.name, table: t.name, tab })
                                                                        }
                                                                    />
                                                                ))}
                                                            </>
                                                        )}

                                                        {/* Views */}
                                                        {viewList.length > 0 && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Eye}
                                                                    label="Views"
                                                                    count={viewList.length}
                                                                    iconColor="text-blue-400/80"
                                                                />
                                                                {viewList.map((v) => (
                                                                    <TableLeaf
                                                                        key={v.name}
                                                                        schema={schema.name}
                                                                        tableName={v.name}
                                                                        isView={true}
                                                                        rowCount={v.row_count}
                                                                        isActive={
                                                                            selectedSchema === schema.name &&
                                                                            selectedTable === v.name
                                                                        }
                                                                        onClick={() => {
                                                                            onSelectObject?.();
                                                                            selectTable(schema.name, v.name);
                                                                        }}
                                                                        onOpenManager={(tab) =>
                                                                            setManagerDialog({ schema: schema.name, table: v.name, tab })
                                                                        }
                                                                    />
                                                                ))}
                                                            </>
                                                        )}

                                                        {/* Functions */}
                                                        {funcs.length > 0 && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Code2}
                                                                    label="Functions"
                                                                    count={funcs.length}
                                                                    iconColor="text-violet-400/80"
                                                                />
                                                                {funcs.map((f) => {
                                                                    const key = `${f.name}(${f.arguments})`;
                                                                    const isActive =
                                                                        previewSelection?.kind === "function" &&
                                                                        previewSelection.schema === schema.name &&
                                                                        previewSelection.name === f.name &&
                                                                        previewSelection.arguments === f.arguments;
                                                                    return (
                                                                        <ObjectLeaf
                                                                            key={key}
                                                                            icon={Braces}
                                                                            label={
                                                                                f.arguments
                                                                                    ? `${f.name}(${f.arguments})`
                                                                                    : f.name
                                                                            }
                                                                            isActive={isActive}
                                                                            onClick={() => {
                                                                                onSelectObject?.();
                                                                                selectPreview({
                                                                                    kind: "function",
                                                                                    schema: schema.name,
                                                                                    name: f.name,
                                                                                    arguments: f.arguments,
                                                                                });
                                                                            }}
                                                                        />
                                                                    );
                                                                })}
                                                            </>
                                                        )}

                                                        {/* Trigger Functions */}
                                                        {triggerFuncs.length > 0 && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Zap}
                                                                    label="Trigger Functions"
                                                                    count={triggerFuncs.length}
                                                                    iconColor="text-amber-400/80"
                                                                />
                                                                {triggerFuncs.map((f) => {
                                                                    const key = `tg_${f.name}(${f.arguments})`;
                                                                    const isActive =
                                                                        previewSelection?.kind === "function" &&
                                                                        previewSelection.schema === schema.name &&
                                                                        previewSelection.name === f.name &&
                                                                        previewSelection.arguments === f.arguments;
                                                                    return (
                                                                        <ObjectLeaf
                                                                            key={key}
                                                                            icon={Zap}
                                                                            label={
                                                                                f.arguments
                                                                                    ? `${f.name}(${f.arguments})`
                                                                                    : f.name
                                                                            }
                                                                            isActive={isActive}
                                                                            onClick={() => {
                                                                                onSelectObject?.();
                                                                                selectPreview({
                                                                                    kind: "function",
                                                                                    schema: schema.name,
                                                                                    name: f.name,
                                                                                    arguments: f.arguments,
                                                                                });
                                                                            }}
                                                                        />
                                                                    );
                                                                })}
                                                            </>
                                                        )}

                                                        {/* Types */}
                                                        {typeList.length > 0 && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Type}
                                                                    label="Types"
                                                                    count={typeList.length}
                                                                    iconColor="text-rose-400/80"
                                                                />
                                                                {typeList.map((ty) => (
                                                                    <ObjectLeaf
                                                                        key={ty.name}
                                                                        icon={Type}
                                                                        label={`${ty.name} (${ty.kind})`}
                                                                        isActive={
                                                                            previewSelection?.kind === "type" &&
                                                                            previewSelection.schema === schema.name &&
                                                                            previewSelection.name === ty.name
                                                                        }
                                                                        onClick={() => {
                                                                            onSelectObject?.();
                                                                            selectPreview({
                                                                                kind: "type",
                                                                                schema: schema.name,
                                                                                name: ty.name,
                                                                            });
                                                                        }}
                                                                    />
                                                                ))}
                                                            </>
                                                        )}

                                                        {tableList.length === 0 &&
                                                            viewList.length === 0 &&
                                                            funcs.length === 0 &&
                                                            triggerFuncs.length === 0 &&
                                                            typeList.length === 0 && (
                                                                <div
                                                                    style={{ paddingLeft: LEAF_INDENT + 16 }}
                                                                    className="py-1.5 flex items-center gap-2"
                                                                >
                                                                    <span className="text-[10px] text-muted-foreground/40 italic">
                                                                        {hasSearch ? "No matches" : "Empty schema"}
                                                                    </span>
                                                                    {!hasSearch && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setCreateTableSchema(schema.name)}
                                                                            className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/20 transition-colors"
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

            {/* Footer */}
            <div className="px-3 py-2.5 border-t border-border/20 bg-card/20 shrink-0">
                <p className="text-[10px] text-muted-foreground/50 font-mono">
                    {schemas.length} schema{schemas.length !== 1 ? "s" : ""} · {totalObjects} objects
                </p>
            </div>
        </div>
        </>
    );
}
