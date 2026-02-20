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
} from "lucide-react";
import { cn } from "@/lib/utils";

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
}: {
    icon: React.ElementType;
    label: string;
    count?: number;
    expanded: boolean;
    onToggle: () => void;
    isActive?: boolean;
    level?: number;
    iconColor?: string;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            className={cn(
                "flex w-full items-center gap-2 py-1.5 text-left text-xs transition-colors rounded-r-md",
                "hover:bg-accent/50",
                isActive && "bg-primary/10 text-primary"
            )}
            style={{ paddingLeft: INDENT + level * 14 }}
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
    );
}

/** Section header inside a schema (Tables, Views, Functions, etc.) */
function SchemaSectionHeader({
    icon: Icon,
    label,
    count,
    iconColor = "text-muted-foreground/70",
}: {
    icon: React.ElementType;
    label: string;
    count: number;
    iconColor?: string;
}) {
    return (
        <div
            className="flex items-center gap-2 py-1 pr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 border-l-2 border-transparent pl-1"
            style={{ paddingLeft: LEAF_INDENT + 4 }}
        >
            <Icon className={cn("h-3 w-3 shrink-0", iconColor)} />
            <span>{label}</span>
            <span className="font-mono tabular-nums">({count})</span>
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

export function Sidebar() {
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
    } = useConnectionStore();

    const [search, setSearch] = useState("");
    const [databasesOpen, setDatabasesOpen] = useState(false);
    const [schemasOpen, setSchemasOpen] = useState(true);
    const [eventTriggersOpen, setEventTriggersOpen] = useState(false);
    const [dbPickerOpen, setDbPickerOpen] = useState(false);
    const [dbSearch, setDbSearch] = useState("");
    const dbPickerRef = useRef<HTMLDivElement>(null);

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

    return (
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
                                                onClick={() =>
                                                    selectPreview({ kind: "event_trigger", name: et.name })
                                                }
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
                            />
                            {databasesOpen && (
                                <div className="ml-1 border-l border-border/20 pl-0.5">
                                    {databases.map((db) => {
                                        const isCurrent = db === databaseName;
                                        return (
                                            <button
                                                key={db}
                                                type="button"
                                                onClick={() => !isCurrent && switchDatabase(db)}
                                                disabled={isCurrent}
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
                                        );
                                    })}
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
                                                        {tableList.length > 0 && (
                                                            <>
                                                                <SchemaSectionHeader
                                                                    icon={Table2}
                                                                    label="Tables"
                                                                    count={tableList.length}
                                                                    iconColor="text-emerald-500/80"
                                                                />
                                                                {tableList.map((t) => (
                                                                    <ObjectLeaf
                                                                        key={t.name}
                                                                        icon={Table2}
                                                                        label={t.name}
                                                                        rowCount={t.row_count}
                                                                        isActive={
                                                                            selectedSchema ===
                                                                                schema.name &&
                                                                            selectedTable === t.name
                                                                        }
                                                                        onClick={() =>
                                                                            selectTable(
                                                                                schema.name,
                                                                                t.name
                                                                            )
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
                                                                    <ObjectLeaf
                                                                        key={v.name}
                                                                        icon={Eye}
                                                                        label={v.name}
                                                                        rowCount={v.row_count}
                                                                        isActive={
                                                                            selectedSchema ===
                                                                                schema.name &&
                                                                            selectedTable === v.name
                                                                        }
                                                                        onClick={() =>
                                                                            selectTable(
                                                                                schema.name,
                                                                                v.name
                                                                            )
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
                                                                            onClick={() =>
                                                                                selectPreview({
                                                                                    kind: "function",
                                                                                    schema: schema.name,
                                                                                    name: f.name,
                                                                                    arguments: f.arguments,
                                                                                })
                                                                            }
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
                                                                            onClick={() =>
                                                                                selectPreview({
                                                                                    kind: "function",
                                                                                    schema: schema.name,
                                                                                    name: f.name,
                                                                                    arguments: f.arguments,
                                                                                })
                                                                            }
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
                                                                        onClick={() =>
                                                                            selectPreview({
                                                                                kind: "type",
                                                                                schema: schema.name,
                                                                                name: ty.name,
                                                                            })
                                                                        }
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
                                                                    className="py-2 text-[10px] text-muted-foreground/50 italic"
                                                                    style={{
                                                                        paddingLeft: LEAF_INDENT + 20,
                                                                    }}
                                                                >
                                                                    {hasSearch
                                                                        ? "No matches"
                                                                        : "No objects"}
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
    );
}
