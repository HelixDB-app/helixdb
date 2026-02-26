"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useShallow } from "zustand/react/shallow";
import { dbApplyDocumentationComments, dbGetDocumentationContext } from "@/lib/tauri";
import {
    generateDocumentationComments,
    getUndocumentedTargets,
    type DocumentationScope,
    type GeneratedDocumentationItem,
} from "@/lib/ai-doc-writer";
import type { DocumentationCommentPatch, DocumentationContext } from "@/lib/types";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
    Check,
    ChevronsUpDown,
    ChevronLeft,
    ChevronRight,
    FileText,
    Loader2,
    Pencil,
    RefreshCw,
    Sparkles,
} from "lucide-react";

const PAGE_SIZE = 50;

type ScopeMode = "database" | "schema" | "table";

interface TableScopeSelection {
    schema: string;
    table: string;
}

interface TableScopeOption extends TableScopeSelection {
    key: string;
    tableType: string;
}

interface AIDocWriterDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function targetOrder(kind: GeneratedDocumentationItem["kind"]): number {
    if (kind === "table") return 0;
    if (kind === "column") return 1;
    return 2;
}

function displayName(item: GeneratedDocumentationItem): string {
    if (item.kind === "table") {
        return `${item.schema}.${item.table}`;
    }
    if (item.kind === "column") {
        return `${item.schema}.${item.table}.${item.column}`;
    }
    return `${item.schema}.${item.index}`;
}

function tableScopeKey(schema: string, table: string): string {
    return `${schema}\u0000${table}`;
}

export function AIDocWriterDialog({ open, onOpenChange }: AIDocWriterDialogProps) {
    const {
        connectionId,
        selectedSchema,
        selectedTable,
        refreshSchemas,
    } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            selectedSchema: state.selectedSchema,
            selectedTable: state.selectedTable,
            refreshSchemas: state.refreshSchemas,
        }))
    );

    const [scopeMode, setScopeMode] = useState<ScopeMode>("database");
    const [includeIndexes, setIncludeIndexes] = useState(true);

    const [context, setContext] = useState<DocumentationContext | null>(null);
    const [loadingContext, setLoadingContext] = useState(false);
    const [contextError, setContextError] = useState<string | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [isApplying, setIsApplying] = useState(false);

    const [generated, setGenerated] = useState<GeneratedDocumentationItem[]>([]);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [editingId, setEditingId] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [filterText, setFilterText] = useState("");
    const [selectedScopeTable, setSelectedScopeTable] = useState<TableScopeSelection | null>(null);
    const [tablePickerOpen, setTablePickerOpen] = useState(false);

    const hasSidebarTableScope = Boolean(selectedSchema && selectedTable);

    useEffect(() => {
        if (!open) return;
        if (hasSidebarTableScope) {
            setScopeMode("table");
            return;
        }
        if (selectedSchema) {
            setScopeMode("schema");
            return;
        }
        setScopeMode("database");
    }, [open, hasSidebarTableScope, selectedSchema]);

    const resetGeneratedState = useCallback(() => {
        setGenerated([]);
        setDrafts({});
        setEditingId(null);
        setFilterText("");
        setPage(1);
    }, []);

    const loadContext = useCallback(async () => {
        if (!connectionId) return;
        setLoadingContext(true);
        setContextError(null);
        try {
            const next = await dbGetDocumentationContext(connectionId, null);
            setContext(next);
        } catch (error) {
            const message = String(error).replace(/^[a-z_]+:\s*/i, "").trim() || "Failed to scan schema.";
            setContextError(message);
            setContext(null);
        } finally {
            setLoadingContext(false);
        }
    }, [connectionId]);

    const tableScopeOptions = useMemo<TableScopeOption[]>(() => {
        if (!context) return [];
        const sorted = [...context.tables].sort((a, b) => {
            const schemaDiff = a.schema.localeCompare(b.schema);
            if (schemaDiff !== 0) return schemaDiff;
            return a.table.localeCompare(b.table);
        });
        return sorted.map((table) => ({
            key: tableScopeKey(table.schema, table.table),
            schema: table.schema,
            table: table.table,
            tableType: table.table_type,
        }));
    }, [context]);

    const groupedTableScopeOptions = useMemo(() => {
        const grouped = new Map<string, TableScopeOption[]>();
        for (const option of tableScopeOptions) {
            const bucket = grouped.get(option.schema);
            if (bucket) {
                bucket.push(option);
            } else {
                grouped.set(option.schema, [option]);
            }
        }
        return Array.from(grouped.entries());
    }, [tableScopeOptions]);

    const canUseTableScope = hasSidebarTableScope || tableScopeOptions.length > 0;

    useEffect(() => {
        if (!open || !selectedSchema || !selectedTable) return;
        setSelectedScopeTable((prev) => {
            if (prev?.schema === selectedSchema && prev.table === selectedTable) {
                return prev;
            }
            return { schema: selectedSchema, table: selectedTable };
        });
    }, [open, selectedSchema, selectedTable]);

    useEffect(() => {
        if (!open) return;
        if (tableScopeOptions.length === 0) {
            if (!hasSidebarTableScope) setSelectedScopeTable(null);
            return;
        }

        setSelectedScopeTable((prev) => {
            if (prev) {
                const currentKey = tableScopeKey(prev.schema, prev.table);
                if (tableScopeOptions.some((option) => option.key === currentKey)) {
                    return prev;
                }
            }

            if (selectedSchema && selectedTable) {
                const selectedKey = tableScopeKey(selectedSchema, selectedTable);
                const matched = tableScopeOptions.find((option) => option.key === selectedKey);
                if (matched) {
                    return { schema: matched.schema, table: matched.table };
                }
            }

            const [firstOption] = tableScopeOptions;
            if (!firstOption) return null;
            return { schema: firstOption.schema, table: firstOption.table };
        });
    }, [open, tableScopeOptions, selectedSchema, selectedTable, hasSidebarTableScope]);

    useEffect(() => {
        if (!open) return;
        if (scopeMode !== "table") return;
        if (selectedScopeTable) return;
        if (selectedSchema) {
            setScopeMode("schema");
            return;
        }
        setScopeMode("database");
    }, [open, scopeMode, selectedScopeTable, selectedSchema]);

    const activeScope: DocumentationScope = useMemo(() => {
        if (scopeMode === "table" && selectedScopeTable) {
            return {
                kind: "table",
                schema: selectedScopeTable.schema,
                table: selectedScopeTable.table,
            };
        }
        if (scopeMode === "schema" && selectedSchema) {
            return { kind: "schema", schema: selectedSchema };
        }
        return { kind: "database" };
    }, [scopeMode, selectedScopeTable, selectedSchema]);

    useEffect(() => {
        if (!open || !connectionId) return;
        resetGeneratedState();
        setTablePickerOpen(false);
        void loadContext();
    }, [open, connectionId, loadContext, resetGeneratedState]);

    useEffect(() => {
        if (!open) return;
        resetGeneratedState();
    }, [open, activeScope, includeIndexes, resetGeneratedState]);

    const undocumentedTargets = useMemo(() => {
        if (!context) return [];
        return getUndocumentedTargets(context, activeScope, includeIndexes);
    }, [context, activeScope, includeIndexes]);

    const targetStats = useMemo(() => {
        const stats = { table: 0, column: 0, index: 0 };
        for (const t of undocumentedTargets) {
            stats[t.kind] += 1;
        }
        return stats;
    }, [undocumentedTargets]);

    const filteredGenerated = useMemo(() => {
        if (!filterText.trim()) return generated;
        const query = filterText.trim().toLowerCase();
        return generated.filter((item) => {
            const name = displayName(item).toLowerCase();
            const text = (drafts[item.id] ?? item.comment).toLowerCase();
            return name.includes(query) || text.includes(query);
        });
    }, [generated, filterText, drafts]);

    const totalPages = Math.max(1, Math.ceil(filteredGenerated.length / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);

    const pagedItems = useMemo(() => {
        const start = (currentPage - 1) * PAGE_SIZE;
        return filteredGenerated.slice(start, start + PAGE_SIZE);
    }, [filteredGenerated, currentPage]);

    useEffect(() => {
        setPage((prev) => Math.min(prev, totalPages));
    }, [totalPages]);

    const handleGenerate = useCallback(async () => {
        if (!context) return;
        if (undocumentedTargets.length === 0) {
            toast.info("All selected objects already have comments.");
            return;
        }
        setIsGenerating(true);
        try {
            const result = await generateDocumentationComments(context, activeScope, {
                includeIndexes,
            });

            const sorted = [...result].sort((a, b) => {
                const kindDiff = targetOrder(a.kind) - targetOrder(b.kind);
                if (kindDiff !== 0) return kindDiff;
                const aName = displayName(a);
                const bName = displayName(b);
                return aName.localeCompare(bName);
            });

            setGenerated(sorted);
            setDrafts(Object.fromEntries(sorted.map((item) => [item.id, item.comment])));
            setEditingId(null);
            setFilterText("");
            setPage(1);
            toast.success(`Generated ${sorted.length} comment${sorted.length === 1 ? "" : "s"}.`);
        } catch (error) {
            toast.error(String(error));
        } finally {
            setIsGenerating(false);
        }
    }, [context, activeScope, includeIndexes, undocumentedTargets.length]);

    const handleApplyAll = useCallback(async () => {
        if (!connectionId) return;
        const patches: DocumentationCommentPatch[] = [];
        for (const item of generated) {
            const comment = (drafts[item.id] ?? item.comment).trim();
            if (!comment) continue;
            patches.push({
                kind: item.kind,
                schema: item.schema,
                table: item.table ?? null,
                column: item.column ?? null,
                index: item.index ?? null,
                comment,
            });
        }

        if (patches.length === 0) {
            toast.error("No comments to apply.");
            return;
        }

        setIsApplying(true);
        try {
            const applied = await dbApplyDocumentationComments(connectionId, patches);
            await refreshSchemas();
            await loadContext();
            resetGeneratedState();
            toast.success(`Applied ${applied} COMMENT ON statement${applied === 1 ? "" : "s"}.`);
        } catch (error) {
            toast.error(String(error));
        } finally {
            setIsApplying(false);
        }
    }, [connectionId, generated, drafts, refreshSchemas, loadContext, resetGeneratedState]);

    const scopeLabel =
        activeScope.kind === "database"
            ? "Entire database"
            : activeScope.kind === "schema"
                ? `Schema: ${activeScope.schema}`
                : `Table: ${activeScope.schema}.${activeScope.table}`;
    const selectedScopeTableKey = selectedScopeTable
        ? tableScopeKey(selectedScopeTable.schema, selectedScopeTable.table)
        : null;
    const selectedScopeTableLabel = selectedScopeTable
        ? `${selectedScopeTable.schema}.${selectedScopeTable.table}`
        : "Select a table";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-5xl w-[95vw] h-[86vh] flex flex-col gap-0 p-0 overflow-hidden">
                <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/20 shrink-0">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-cyan-400" />
                        AI Doc Writer
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground/80">
                        Generate, review, and apply PostgreSQL COMMENT ON documentation for undocumented objects.
                    </DialogDescription>
                </DialogHeader>

                <div className="px-5 py-3 border-b border-border/20 bg-muted/20 shrink-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant={scopeMode === "database" ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setScopeMode("database")}
                        >
                            Entire DB
                        </Button>
                        <Button
                            type="button"
                            variant={scopeMode === "schema" ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!selectedSchema}
                            onClick={() => setScopeMode("schema")}
                        >
                            Selected Schema
                        </Button>
                        <Button
                            type="button"
                            variant={scopeMode === "table" ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!canUseTableScope}
                            onClick={() => setScopeMode("table")}
                        >
                            Selected Table
                        </Button>

                        <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded border-border"
                                checked={includeIndexes}
                                onChange={(e) => setIncludeIndexes(e.target.checked)}
                            />
                            Include index comments
                        </label>

                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 ml-auto text-xs"
                            onClick={() => void loadContext()}
                            disabled={loadingContext}
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", loadingContext && "animate-spin")} />
                        </Button>
                    </div>

                    {scopeMode === "table" && (
                        <div className="mt-2 flex items-center gap-2">
                            <Badge variant="outline" className="h-7 px-2 text-[10px] uppercase tracking-wide">
                                Target
                            </Badge>
                            <Popover open={tablePickerOpen} onOpenChange={setTablePickerOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        role="combobox"
                                        aria-expanded={tablePickerOpen}
                                        className="h-7 w-[320px] max-w-full justify-between text-xs font-mono"
                                        disabled={tableScopeOptions.length === 0}
                                    >
                                        <span className="truncate">{selectedScopeTableLabel}</span>
                                        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-60" />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-[360px] p-0" align="start">
                                    <Command>
                                        <CommandInput placeholder="Search tables..." />
                                        <CommandList className="max-h-72">
                                            <CommandEmpty>No tables found.</CommandEmpty>
                                            {groupedTableScopeOptions.map(([schemaName, options]) => (
                                                <CommandGroup key={schemaName} heading={schemaName}>
                                                    {options.map((option) => {
                                                        const isSelected = selectedScopeTableKey === option.key;
                                                        return (
                                                            <CommandItem
                                                                key={option.key}
                                                                value={`${option.schema}.${option.table} ${option.tableType}`.toLowerCase()}
                                                                onSelect={() => {
                                                                    setSelectedScopeTable({
                                                                        schema: option.schema,
                                                                        table: option.table,
                                                                    });
                                                                    setTablePickerOpen(false);
                                                                }}
                                                                className="text-xs"
                                                            >
                                                                <Check className={cn("h-3.5 w-3.5", isSelected ? "opacity-100" : "opacity-0")} />
                                                                <span className="font-mono">{option.table}</span>
                                                                <span className="ml-auto text-[10px] text-muted-foreground/70">
                                                                    {option.tableType}
                                                                </span>
                                                            </CommandItem>
                                                        );
                                                    })}
                                                </CommandGroup>
                                            ))}
                                        </CommandList>
                                    </Command>
                                </PopoverContent>
                            </Popover>
                        </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px] h-5">{scopeLabel}</Badge>
                        <Badge variant="outline" className="text-[10px] h-5">Tables: {targetStats.table}</Badge>
                        <Badge variant="outline" className="text-[10px] h-5">Columns: {targetStats.column}</Badge>
                        {includeIndexes && <Badge variant="outline" className="text-[10px] h-5">Indexes: {targetStats.index}</Badge>}
                        <Badge variant="outline" className="text-[10px] h-5">Total: {undocumentedTargets.length}</Badge>
                    </div>
                </div>

                <div className="flex-1 min-h-0">
                    {loadingContext ? (
                        <div className="h-full flex items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Scanning schema metadata…
                        </div>
                    ) : contextError ? (
                        <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
                            <p className="text-sm text-destructive">{contextError}</p>
                            <Button size="sm" variant="outline" onClick={() => void loadContext()}>
                                Retry
                            </Button>
                        </div>
                    ) : generated.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center px-8 text-center gap-4">
                            <FileText className="h-10 w-10 text-muted-foreground/35" />
                            <div className="space-y-1">
                                <p className="text-sm font-medium">Undocumented objects are ready for AI generation</p>
                                <p className="text-xs text-muted-foreground">
                                    Existing comments are skipped by default so human-written docs are preserved.
                                </p>
                            </div>
                            <Button
                                onClick={() => void handleGenerate()}
                                disabled={isGenerating || undocumentedTargets.length === 0}
                                className="gap-1.5"
                            >
                                {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                Generate Documentation
                            </Button>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col">
                            <div className="px-5 py-2.5 border-b border-border/20 shrink-0">
                                <div className="flex items-center gap-2">
                                    <Input
                                        value={filterText}
                                        onChange={(e) => setFilterText(e.target.value)}
                                        placeholder="Filter by object name or comment text…"
                                        className="h-8 text-xs"
                                    />
                                    <Badge variant="outline" className="h-8 px-2 text-[10px]">
                                        {filteredGenerated.length} items
                                    </Badge>
                                </div>
                            </div>
                            <ScrollArea className="flex-1 min-h-0">
                                <div className="px-5 py-3 space-y-2.5">
                                    {pagedItems.map((item) => {
                                        const current = drafts[item.id] ?? item.comment;
                                        const isEditing = editingId === item.id;

                                        return (
                                            <div key={item.id} className="rounded-lg border border-border/20 bg-card/50 p-3">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Badge variant="outline" className="h-5 text-[10px] uppercase tracking-wide">
                                                        {item.kind}
                                                    </Badge>
                                                    <p className="text-xs font-mono text-foreground/85 truncate">{displayName(item)}</p>
                                                    <div className="ml-auto">
                                                        {isEditing ? (
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-6 px-2 text-xs"
                                                                onClick={() => setEditingId(null)}
                                                            >
                                                                <Check className="h-3 w-3 mr-1" />Done
                                                            </Button>
                                                        ) : (
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-6 px-2 text-xs"
                                                                onClick={() => setEditingId(item.id)}
                                                            >
                                                                <Pencil className="h-3 w-3 mr-1" />Edit
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>

                                                {isEditing ? (
                                                    <Textarea
                                                        value={current}
                                                        onChange={(e) => {
                                                            const next = e.target.value;
                                                            setDrafts((prev) => ({ ...prev, [item.id]: next }));
                                                        }}
                                                        className="min-h-[82px] text-xs leading-relaxed"
                                                    />
                                                ) : (
                                                    <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                                                        {current}
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </ScrollArea>

                            {filteredGenerated.length > PAGE_SIZE && (
                                <div className="px-5 py-2 border-t border-border/20 flex items-center justify-between text-xs text-muted-foreground shrink-0">
                                    <span>
                                        Page {currentPage} / {totalPages}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7"
                                            disabled={currentPage <= 1}
                                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                                        >
                                            <ChevronLeft className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7"
                                            disabled={currentPage >= totalPages}
                                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                        >
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="px-5 py-3 border-t border-border/20 shrink-0">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenChange(false)}
                        disabled={isGenerating || isApplying}
                    >
                        Close
                    </Button>
                    {generated.length === 0 ? (
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => void handleGenerate()}
                            disabled={isGenerating || loadingContext || undocumentedTargets.length === 0}
                            className="gap-1.5"
                        >
                            {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            Generate Documentation
                        </Button>
                    ) : (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleGenerate()}
                                disabled={isGenerating || isApplying}
                                className="gap-1.5"
                            >
                                {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                Regenerate
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => void handleApplyAll()}
                                disabled={isApplying || isGenerating}
                                className="gap-1.5"
                            >
                                {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                Apply All
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
