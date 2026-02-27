"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dbListSchemas, dbListTables, dbExportSql, openPath } from "@/lib/tauri";
import type { SchemaInfo, TableInfo } from "@/lib/types";
import type {
    ExportContentType,
    ExportProgressPayload,
    ExportRequest,
    ExportTableRef,
} from "@/lib/export-types";
import { Database, FileDown, FolderOpen, Loader2, Table2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface ExportDatabaseDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connectionId: string | null;
}

type ExportPhase = "idle" | "exporting" | "done" | "error";

export function ExportDatabaseDialog({
    open,
    onOpenChange,
    connectionId,
}: ExportDatabaseDialogProps) {
    const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
    const [schemaTables, setSchemaTables] = useState<Record<string, TableInfo[]>>({});
    const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
    const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set()); // key: "schema.table"
    const [contentType, setContentType] = useState<ExportContentType>("structure_and_data");
    const [compress, setCompress] = useState(false);
    const [phase, setPhase] = useState<ExportPhase>("idle");
    const [progress, setProgress] = useState<ExportProgressPayload | null>(null);
    const [resultPath, setResultPath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);

    const loadSchemas = useCallback(async () => {
        if (!connectionId) return;
        try {
            const list = await dbListSchemas(connectionId);
            setSchemas(list);
            setSchemaTables({});
            setSelectedSchemas(new Set());
            setSelectedTables(new Set());
        } catch {
            setSchemas([]);
            toast.error("Failed to load schemas.");
        }
    }, [connectionId]);

    useEffect(() => {
        if (!open || !connectionId) return;
        loadSchemas();
    }, [open, connectionId, loadSchemas]);

    useEffect(() => {
        if (!open || !connectionId) return;
        const load = async () => {
            for (const schema of selectedSchemas) {
                if (schemaTables[schema]) continue;
                try {
                    const tables = await dbListTables(connectionId, schema);
                    setSchemaTables((prev) => ({ ...prev, [schema]: tables }));
                } catch {
                    setSchemaTables((prev) => ({ ...prev, [schema]: [] }));
                }
            }
        };
        load();
    }, [open, connectionId, selectedSchemas]);

    useEffect(() => {
        return () => {
            unlistenRef.current?.();
        };
    }, []);

    const toggleSchema = (schema: string) => {
        setSelectedSchemas((prev) => {
            const next = new Set(prev);
            if (next.has(schema)) {
                next.delete(schema);
                const tables = schemaTables[schema] ?? [];
                setSelectedTables((t) => {
                    const n = new Set(t);
                    tables.forEach((tb) => n.delete(`${schema}.${tb.name}`));
                    return n;
                });
            } else {
                next.add(schema);
            }
            return next;
        });
    };

    const toggleTable = (schema: string, table: string) => {
        const key = `${schema}.${table}`;
        setSelectedTables((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const selectAllInSchema = (schema: string) => {
        const tables = (schemaTables[schema] ?? []).filter((t) => t.table_type === "BASE TABLE" || t.table_type === "VIEW");
        setSelectedTables((prev) => {
            const next = new Set(prev);
            tables.forEach((t) => next.add(`${schema}.${t.name}`));
            return next;
        });
    };

    const tablesList: ExportTableRef[] = Array.from(selectedTables).map((key) => {
        const [schema, table] = key.split(".", 2);
        return { schema, table };
    });

    const handleExport = useCallback(async () => {
        if (!connectionId || tablesList.length === 0) {
            toast.error("Select at least one table to export.");
            return;
        }
        setError(null);
        setResultPath(null);
        setPhase("exporting");
        setProgress({ phase: "schema", message: "Starting…", current: 0, total: tablesList.length });

        const unlisten = await listen<ExportProgressPayload>("db-export-progress", (event) => {
            setProgress(event.payload);
        });
        unlistenRef.current = unlisten;

        const request: ExportRequest = {
            connection_id: connectionId,
            schemas: Array.from(selectedSchemas),
            tables: tablesList,
            content_type: contentType,
            compress,
            columns: null,
            where_clause: null,
            output_path: null,
        };

        try {
            const result = await dbExportSql(request);
            unlistenRef.current?.();
            unlistenRef.current = null;
            setResultPath(result.output_path);
            setPhase("done");
            setProgress(null);
            toast.success(`Exported to ${result.output_path}`);
        } catch (e) {
            unlistenRef.current?.();
            unlistenRef.current = null;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            setPhase("error");
            setProgress(null);
            toast.error(msg);
        }
    }, [connectionId, tablesList, selectedSchemas, contentType, compress]);

    const handleOpenFolder = useCallback(async () => {
        if (!resultPath) return;
        try {
            await openPath(resultPath);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to open folder");
        }
    }, [resultPath]);

    const handleClose = useCallback(() => {
        if (phase === "exporting") return;
        setPhase("idle");
        setProgress(null);
        setResultPath(null);
        setError(null);
        onOpenChange(false);
    }, [phase, onOpenChange]);

    const isExporting = phase === "exporting";
    const progressPct = progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

    return (
        <Dialog open={open} onOpenChange={(o) => (!isExporting && !o) && handleClose()}>
            <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
                <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b border-border/50">
                    <DialogTitle className="flex items-center gap-3 text-lg">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/15 border border-blue-500/25">
                            <FileDown className="h-5 w-5 text-blue-400" />
                        </span>
                        Export database (SQL)
                    </DialogTitle>
                    <DialogDescription className="text-sm mt-1">
                        Export schema and/or data from selected tables to a single SQL file. Progress is shown during export.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0 px-6 pb-6">
                    <ScrollArea className="flex-1 min-h-0 -mx-2 px-2">
                        <div className="space-y-4 py-4">
                            <div>
                                <Label className="text-sm font-medium text-muted-foreground flex items-center gap-2 mb-2">
                                    <Database className="h-4 w-4" /> Schemas & tables
                                </Label>
                                <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-2 max-h-48 overflow-y-auto">
                                    {schemas.map((s) => (
                                        <div key={s.name} className="space-y-1.5">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <Checkbox
                                                    checked={selectedSchemas.has(s.name)}
                                                    onCheckedChange={() => toggleSchema(s.name)}
                                                />
                                                <span className="font-medium text-sm">{s.name}</span>
                                            </label>
                                            {selectedSchemas.has(s.name) && (
                                                <div className="ml-6 space-y-1">
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 text-xs text-muted-foreground"
                                                        onClick={() => selectAllInSchema(s.name)}
                                                    >
                                                        Select all in {s.name}
                                                    </Button>
                                                    {(schemaTables[s.name] ?? []).map((t) => {
                                                        const key = `${s.name}.${t.name}`;
                                                        return (
                                                            <label key={key} className="flex items-center gap-2 cursor-pointer">
                                                                <Checkbox
                                                                    checked={selectedTables.has(key)}
                                                                    onCheckedChange={() => toggleTable(s.name, t.name)}
                                                                />
                                                                <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
                                                                <span className="text-sm font-mono">{t.name}</span>
                                                                <span className="text-xs text-muted-foreground">({t.table_type})</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <Label className="text-sm font-medium text-muted-foreground mb-2 block">Content</Label>
                                <div className="flex flex-wrap gap-4">
                                    {(
                                        [
                                            { value: "structure_only" as const, label: "Structure only (DDL)" },
                                            { value: "data_only" as const, label: "Data only (INSERTs)" },
                                            { value: "structure_and_data" as const, label: "Structure + data" },
                                        ] as const
                                    ).map(({ value, label }) => (
                                        <label key={value} className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="contentType"
                                                checked={contentType === value}
                                                onChange={() => setContentType(value)}
                                                className="rounded-full border-border"
                                            />
                                            <span className="text-sm">{label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <label className="flex items-center gap-2 cursor-pointer">
                                <Checkbox checked={compress} onCheckedChange={(c) => setCompress(!!c)} />
                                <span className="text-sm text-muted-foreground">Compress output (gzip)</span>
                            </label>

                            {phase === "exporting" && progress && (
                                <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-2">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">{progress.message}</span>
                                        <span>
                                            {progress.current} / {progress.total}
                                            {progress.rows_exported != null && ` · ${progress.rows_exported.toLocaleString()} rows`}
                                        </span>
                                    </div>
                                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                                        <div
                                            className="h-full bg-primary transition-all duration-300"
                                            style={{ width: `${Math.min(100, progressPct)}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {phase === "done" && resultPath && (
                                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Export complete</p>
                                    <p className="text-xs font-mono text-muted-foreground break-all">{resultPath}</p>
                                    <div className="flex gap-2">
                                        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={handleOpenFolder}>
                                            <FolderOpen className="h-3.5 w-3.5" />
                                            Open folder
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                navigator.clipboard.writeText(resultPath);
                                                toast.success("Path copied to clipboard");
                                            }}
                                        >
                                            Copy path
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {phase === "error" && error && (
                                <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>

                    <DialogFooter className="pt-4 border-t border-border/50 shrink-0">
                        <Button type="button" variant="outline" onClick={handleClose} disabled={isExporting}>
                            {phase === "done" || phase === "error" ? "Close" : "Cancel"}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleExport}
                            disabled={isExporting || tablesList.length === 0 || !connectionId}
                            className="gap-2"
                        >
                            {isExporting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <FileDown className="h-4 w-4" />
                            )}
                            Export
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
