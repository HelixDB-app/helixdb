"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnectionStore } from "@/stores/connection-store";
import { dbGetTableDetails, dbExecuteQuery } from "@/lib/db-platform";
import {
    dbRenameTable,
    dbRenameColumn,
    dbAlterColumn,
    dbAddColumn,
    dbDropColumn,
    dbTruncateTable,
    dbDropTable,
} from "@/lib/tauri";
import type { TableDetails, ColumnInfo } from "@/lib/types";
import {
    Table2,
    Eye,
    Key,
    ShieldCheck,
    Zap,
    Plus,
    Pencil,
    Trash2,
    RefreshCw,
    Check,
    X,
    AlertTriangle,
    Copy,
    Code2,
    Loader2,
    Hash,
    Database,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

type DialogMode =
    | { type: "details" }
    | { type: "rename_table" }
    | { type: "rename_column"; column: string }
    | { type: "edit_column"; column: ColumnInfo }
    | { type: "add_column" }
    | { type: "drop_column"; column: string }
    | { type: "truncate" }
    | { type: "drop_table" };

interface TableManagerDialogProps {
    open: boolean;
    onClose: () => void;
    schema: string;
    table: string;
    initialTab?: string;
    /** Called after a destructive operation so sidebar can refresh */
    onTableChanged?: () => void;
}

// ─── Constraint type badge ────────────────────────────────────────────────────

function ConstraintBadge({ type }: { type: string }) {
    const map: Record<string, { label: string; className: string }> = {
        "PRIMARY KEY": { label: "PK", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
        "FOREIGN KEY": { label: "FK", className: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
        UNIQUE: { label: "UQ", className: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
        CHECK: { label: "CK", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    };
    const cfg = map[type.toUpperCase()] ?? { label: type.slice(0, 2), className: "bg-muted text-muted-foreground" };
    return (
        <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold border font-mono", cfg.className)}>
            {cfg.label}
        </span>
    );
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel = "Confirm",
    destructive = false,
    loading = false,
    onConfirm,
    onCancel,
}: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    destructive?: boolean;
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {destructive && <AlertTriangle className="h-4 w-4 text-destructive" />}
                        {title}
                    </DialogTitle>
                    <DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        variant={destructive ? "destructive" : "default"}
                        size="sm"
                        onClick={onConfirm}
                        disabled={loading}
                    >
                        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Columns Tab ─────────────────────────────────────────────────────────────

function ColumnsTab({
    details,
    connectionId,
    onRefresh,
}: {
    details: TableDetails;
    connectionId: string;
    onRefresh: () => void;
}) {
    const [editingCol, setEditingCol] = useState<ColumnInfo | null>(null);
    const [editName, setEditName] = useState("");
    const [editType, setEditType] = useState("");
    const [editDefault, setEditDefault] = useState("");
    const [editNullable, setEditNullable] = useState(true);
    const [saving, setSaving] = useState(false);

    const [addingCol, setAddingCol] = useState(false);
    const [newColName, setNewColName] = useState("");
    const [newColType, setNewColType] = useState("text");
    const [newColNullable, setNewColNullable] = useState(true);
    const [newColDefault, setNewColDefault] = useState("");
    const [addingSaving, setAddingSaving] = useState(false);

    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const [dropping, setDropping] = useState(false);

    const startEdit = (col: ColumnInfo) => {
        setEditingCol(col);
        setEditName(col.name);
        setEditType(col.data_type);
        setEditDefault(col.column_default ?? "");
        setEditNullable(col.is_nullable);
    };

    const saveEdit = async () => {
        if (!editingCol) return;
        setSaving(true);
        try {
            const nameChanged = editName !== editingCol.name;
            const typeChanged = editType !== editingCol.data_type;
            const defaultChanged = editDefault !== (editingCol.column_default ?? "");
            const nullableChanged = editNullable !== editingCol.is_nullable;

            if (nameChanged) {
                await dbRenameColumn(connectionId, details.schema, details.name, editingCol.name, editName);
            }
            if (typeChanged || defaultChanged || nullableChanged) {
                await dbAlterColumn(
                    connectionId, details.schema,
                    nameChanged ? details.name : details.name,
                    nameChanged ? editName : editingCol.name,
                    typeChanged ? editType : null,
                    defaultChanged ? editDefault : null,
                    nullableChanged ? editNullable : null,
                );
            }
            toast.success("Column updated");
            setEditingCol(null);
            onRefresh();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setSaving(false);
        }
    };

    const addColumn = async () => {
        if (!newColName.trim() || !newColType.trim()) return;
        setAddingSaving(true);
        try {
            await dbAddColumn(
                connectionId, details.schema, details.name,
                newColName.trim(), newColType.trim(),
                newColNullable,
                newColDefault.trim() || null,
            );
            toast.success(`Column "${newColName}" added`);
            setAddingCol(false);
            setNewColName(""); setNewColType("text"); setNewColNullable(true); setNewColDefault("");
            onRefresh();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setAddingSaving(false);
        }
    };

    const dropColumn = async (col: string) => {
        setDropping(true);
        try {
            await dbDropColumn(connectionId, details.schema, details.name, col);
            toast.success(`Column "${col}" dropped`);
            setDropTarget(null);
            onRefresh();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setDropping(false);
        }
    };

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/20 shrink-0 bg-muted/10">
                <p className="text-xs text-muted-foreground font-medium">{details.columns.length} columns</p>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 hover:bg-accent/50" onClick={() => setAddingCol(true)}>
                    <Plus className="h-3 w-3" /> Add Column
                </Button>
            </div>

            <div className="flex-1 overflow-auto bg-background/50 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">
                <table className="w-full text-xs min-w-[950px]">
                    <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur shadow-sm">
                        <tr className="border-b border-border/20 text-muted-foreground/70">
                            <th className="px-4 py-2 text-left font-medium">#</th>
                            <th className="px-3 py-2 text-left font-medium">Name</th>
                            <th className="px-3 py-2 text-left font-medium">Type</th>
                            <th className="px-3 py-2 text-left font-medium">Default</th>
                            <th className="px-3 py-2 text-left font-medium">Nullable</th>
                            <th className="px-3 py-2 text-left font-medium">PK</th>
                            <th className="px-3 py-2 text-right font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {details.columns.map((col) => (
                            editingCol?.name === col.name ? (
                                <tr key={col.name} className="border-b border-border/10 bg-primary/5">
                                    <td className="px-4 py-2 text-muted-foreground/50 font-mono">{col.ordinal_position}</td>
                                    <td className="px-3 py-1.5">
                                        <Input
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className="h-7 text-xs font-mono bg-background/60"
                                        />
                                    </td>
                                    <td className="px-3 py-1.5">
                                        <Input
                                            value={editType}
                                            onChange={(e) => setEditType(e.target.value)}
                                            className="h-7 text-xs font-mono bg-background/60"
                                        />
                                    </td>
                                    <td className="px-3 py-1.5">
                                        <Input
                                            value={editDefault}
                                            onChange={(e) => setEditDefault(e.target.value)}
                                            placeholder="NULL"
                                            className="h-7 text-xs font-mono bg-background/60"
                                        />
                                    </td>
                                    <td className="px-3 py-1.5">
                                        <button
                                            type="button"
                                            onClick={() => setEditNullable((n) => !n)}
                                            className={cn(
                                                "h-5 w-9 rounded-full transition-colors",
                                                editNullable ? "bg-primary" : "bg-muted"
                                            )}
                                        />
                                    </td>
                                    <td className="px-3 py-1.5" />
                                    <td className="px-3 py-1.5 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingCol(null)} disabled={saving}>
                                                <X className="h-3 w-3" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="h-6 w-6 text-primary" onClick={saveEdit} disabled={saving}>
                                                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                <tr key={col.name} className="border-b border-border/10 hover:bg-accent/20 group">
                                    <td className="px-4 py-2 text-muted-foreground/40 font-mono tabular-nums">{col.ordinal_position}</td>
                                    <td className="px-3 py-2 font-mono font-medium" title={col.comment?.trim() || undefined}>{col.name}</td>
                                    <td className="px-3 py-2 text-sky-400/80 font-mono">{col.data_type}</td>
                                    <td className="px-3 py-2 text-muted-foreground/60 font-mono truncate max-w-[120px]">
                                        {col.column_default ?? <span className="italic opacity-40">NULL</span>}
                                    </td>
                                    <td className="px-3 py-2">
                                        <span className={cn(
                                            "text-[10px] font-medium",
                                            col.is_nullable ? "text-emerald-400/70" : "text-rose-400/70"
                                        )}>
                                            {col.is_nullable ? "YES" : "NO"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2">
                                        {col.is_primary_key && <Key className="h-3 w-3 text-amber-400" />}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button
                                                variant="ghost" size="icon" className="h-6 w-6"
                                                onClick={() => startEdit(col)}
                                            >
                                                <Pencil className="h-3 w-3" />
                                            </Button>
                                            <Button
                                                variant="ghost" size="icon" className="h-6 w-6 text-destructive"
                                                onClick={() => setDropTarget(col.name)}
                                                disabled={col.is_primary_key}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            )
                        ))}
                        {addingCol && (
                            <tr className="border-b border-border/10 bg-emerald-500/5">
                                <td className="px-4 py-1.5 text-muted-foreground/40">+</td>
                                <td className="px-3 py-1.5">
                                    <Input autoFocus value={newColName} onChange={(e) => setNewColName(e.target.value)} placeholder="column_name" className="h-7 text-xs font-mono bg-background/60" />
                                </td>
                                <td className="px-3 py-1.5">
                                    <Input value={newColType} onChange={(e) => setNewColType(e.target.value)} placeholder="text" className="h-7 text-xs font-mono bg-background/60" />
                                </td>
                                <td className="px-3 py-1.5">
                                    <Input value={newColDefault} onChange={(e) => setNewColDefault(e.target.value)} placeholder="NULL" className="h-7 text-xs font-mono bg-background/60" />
                                </td>
                                <td className="px-3 py-1.5">
                                    <button
                                        type="button"
                                        onClick={() => setNewColNullable((n) => !n)}
                                        className={cn("h-5 w-9 rounded-full transition-colors", newColNullable ? "bg-primary" : "bg-muted")}
                                    />
                                </td>
                                <td colSpan={2} className="px-3 py-1.5 text-right">
                                    <div className="flex items-center justify-end gap-1">
                                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setAddingCol(false)}>
                                            <X className="h-3 w-3" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-400" onClick={addColumn} disabled={addingSaving}>
                                            {addingSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <ConfirmDialog
                open={!!dropTarget}
                title={`Drop column "${dropTarget}"?`}
                description="This will permanently remove the column and all its data. This action cannot be undone."
                confirmLabel="Drop Column"
                destructive
                loading={dropping}
                onConfirm={() => dropTarget && dropColumn(dropTarget)}
                onCancel={() => setDropTarget(null)}
            />
        </div>
    );
}

// ─── Constraints Tab ──────────────────────────────────────────────────────────

function ConstraintsTab({ details }: { details: TableDetails }) {
    return (
        <div className="flex-1 overflow-auto px-5 py-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">
            {details.constraints.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/50">
                    <ShieldCheck className="h-10 w-10 mb-3 opacity-20" />
                    <p className="text-xs">No constraints defined</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {details.constraints.map((c) => (
                        <div key={c.name} className="rounded-lg border border-border/20 bg-card/40 p-3 hover:bg-card/60 transition-colors">
                            <div className="flex items-center gap-2 mb-2">
                                <ConstraintBadge type={c.constraint_type} />
                                <span className="font-mono text-xs font-medium">{c.name}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                                <span className="font-semibold uppercase tracking-wide">Columns:</span>
                                {c.columns.map((col) => (
                                    <span key={col} className="font-mono bg-muted/40 rounded px-1.5 py-0.5">{col}</span>
                                ))}
                            </div>
                            {c.foreign_table && (
                                <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground mt-1.5">
                                    <span className="font-semibold uppercase tracking-wide">References:</span>
                                    <span className="font-mono bg-sky-500/10 text-sky-400 rounded px-1.5 py-0.5">
                                        {c.foreign_table}({(c.foreign_columns ?? []).join(", ")})
                                    </span>
                                </div>
                            )}
                            {c.check_clause && (
                                <div className="mt-1.5 font-mono text-[11px] text-emerald-400/80 bg-emerald-500/5 rounded px-2 py-1">
                                    {c.check_clause}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Indexes Tab ──────────────────────────────────────────────────────────────

function IndexesTab({ details }: { details: TableDetails }) {
    return (
        <div className="flex-1 overflow-auto px-5 py-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">
            {details.indexes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/50">
                    <Hash className="h-10 w-10 mb-3 opacity-20" />
                    <p className="text-xs">No indexes defined</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {details.indexes.map((idx) => (
                        <div key={idx.name} className="rounded-lg border border-border/20 bg-card/40 p-3 hover:bg-card/60 transition-colors">
                            <div className="flex items-center gap-2 mb-1.5">
                                {idx.is_primary && (
                                    <span className="text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5">PK</span>
                                )}
                                {idx.is_unique && !idx.is_primary && (
                                    <span className="text-[10px] font-bold bg-violet-500/15 text-violet-400 border border-violet-500/30 rounded px-1.5 py-0.5">UQ</span>
                                )}
                                <span className="font-mono text-xs font-medium">{idx.name}</span>
                                <span className="ml-auto text-[10px] text-muted-foreground/60 uppercase font-mono">{idx.index_type}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground mb-1.5">
                                {idx.columns.map((col) => (
                                    <span key={col} className="font-mono bg-muted/40 rounded px-1.5 py-0.5">{col}</span>
                                ))}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground/50 bg-muted/20 rounded px-2 py-1 break-all">
                                {idx.definition}
                            </div>
                            {idx.comment?.trim() && (
                                <p className="mt-1.5 text-[10px] text-muted-foreground/70">{idx.comment}</p>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Triggers Tab ─────────────────────────────────────────────────────────────

function TriggersTab({ details }: { details: TableDetails }) {
    return (
        <div className="flex-1 overflow-auto px-5 py-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">
            {details.triggers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/50">
                    <Zap className="h-10 w-10 mb-3 opacity-20" />
                    <p className="text-xs">No triggers defined</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {details.triggers.map((t) => (
                        <div key={t.name} className="rounded-lg border border-border/20 bg-card/40 p-3 hover:bg-card/60 transition-colors">
                            <div className="flex items-center gap-2 mb-1.5">
                                <Zap className={cn("h-3 w-3", t.enabled ? "text-amber-400" : "text-muted-foreground/40")} />
                                <span className="font-mono text-xs font-medium">{t.name}</span>
                                <span className={cn("ml-auto text-[10px] rounded px-1.5 py-0.5 font-medium", t.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground")}>
                                    {t.enabled ? "ENABLED" : "DISABLED"}
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 text-[10px]">
                                <span className="text-violet-400/80 font-mono">{t.timing}</span>
                                {t.events.map((ev) => (
                                    <span key={ev} className="font-mono bg-muted/40 rounded px-1.5 py-0.5 text-muted-foreground">{ev}</span>
                                ))}
                                <span className="text-muted-foreground/50">→</span>
                                <span className="font-mono text-sky-400/80">{t.function_name}()</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── SQL Script Tab ───────────────────────────────────────────────────────────

function SqlScriptTab({
    details,
    connectionId,
}: {
    details: TableDetails;
    connectionId: string;
}) {
    const defaultSql = `-- Custom SQL script for ${details.schema}.${details.name}\n-- Run any SQL to modify structure or data\n\n`;
    const [sql, setSql] = useState(defaultSql);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{ success: boolean; message: string; rows?: number; time?: number } | null>(null);

    const runSql = async () => {
        if (!sql.trim() || sql.trim().startsWith("--")) return;
        setRunning(true);
        setResult(null);
        try {
            const res = await dbExecuteQuery(connectionId, sql);
            if (res.is_error) {
                setResult({ success: false, message: res.error_message ?? "Query failed" });
            } else {
                setResult({
                    success: true,
                    message: `Query executed successfully`,
                    rows: res.row_count,
                    time: res.execution_time_ms,
                });
            }
        } catch (e) {
            setResult({ success: false, message: String(e) });
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0 border-b border-border/20">
                <MonacoEditor
                    height="100%"
                    language="sql"
                    value={sql}
                    onChange={(v) => setSql(v ?? "")}
                    theme="vs-dark"
                    options={{
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        minimap: { enabled: false },
                        lineNumbers: "on",
                        scrollBeyondLastLine: false,
                        wordWrap: "on",
                        padding: { top: 12, bottom: 12 },
                        renderLineHighlight: "line",
                        suggestOnTriggerCharacters: true,
                    }}
                />
            </div>
            <div className="px-4 py-3 flex items-center gap-3">
                <Button size="sm" onClick={runSql} disabled={running} className="gap-1.5 h-8">
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Code2 className="h-3.5 w-3.5" />}
                    Run Script
                </Button>
                {result && (
                    <div className={cn(
                        "flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border",
                        result.success
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-destructive/10 text-destructive border-destructive/20"
                    )}>
                        {result.success ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        <span>{result.message}</span>
                        {result.rows != null && <span className="text-muted-foreground">· {result.rows} rows</span>}
                        {result.time != null && <span className="text-muted-foreground">· {result.time.toFixed(1)}ms</span>}
                    </div>
                )}
                <div className="ml-auto text-[10px] text-muted-foreground/50 font-mono">
                    {details.schema}.{details.name}
                </div>
            </div>
        </div>
    );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
    details,
    connectionId,
    onRenameTable,
}: {
    details: TableDetails;
    connectionId: string;
    onRenameTable: () => void;
}) {
    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success("Copied to clipboard");
    };

    return (
        <div className="flex-1 overflow-auto px-5 py-5 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">
            <div className="space-y-4 max-w-5xl mx-auto">
                {/* Identity */}
                <div className="rounded-lg border border-border/20 bg-card/40 overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border/20 bg-card/60">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Identity</p>
                    </div>
                    <div className="divide-y divide-border/10">
                        {[
                            { label: "Schema", value: details.schema },
                            { label: "Name", value: details.name },
                            { label: "Type", value: details.table_type },
                        ].map(({ label, value }) => (
                            <div key={label} className="flex items-center px-4 py-2.5 group">
                                <span className="text-[11px] text-muted-foreground/60 w-24 shrink-0">{label}</span>
                                <span className="font-mono text-xs font-medium flex-1">{value}</span>
                                <button
                                    type="button"
                                    onClick={() => copyToClipboard(value)}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <Copy className="h-3 w-3 text-muted-foreground/50 hover:text-foreground" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Storage */}
                <div className="rounded-lg border border-border/20 bg-card/40 overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border/20 bg-card/60">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Storage</p>
                    </div>
                    <div className="divide-y divide-border/10">
                        {[
                            { label: "Rows (est.)", value: details.row_count.toLocaleString() },
                            { label: "Total Size", value: details.total_size },
                            { label: "Table Size", value: details.table_size },
                            { label: "Indexes Size", value: details.indexes_size },
                        ].map(({ label, value }) => (
                            <div key={label} className="flex items-center px-4 py-2.5">
                                <span className="text-[11px] text-muted-foreground/60 w-24 shrink-0">{label}</span>
                                <span className="font-mono text-xs font-medium">{value}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Summary */}
                <div className="grid grid-cols-4 gap-2">
                    {[
                        { label: "Columns", value: details.columns.length, color: "text-sky-400" },
                        { label: "Constraints", value: details.constraints.length, color: "text-amber-400" },
                        { label: "Indexes", value: details.indexes.length, color: "text-violet-400" },
                        { label: "Triggers", value: details.triggers.length, color: "text-emerald-400" },
                    ].map(({ label, value, color }) => (
                        <div key={label} className="rounded-lg border border-border/20 bg-card/40 p-3 text-center">
                            <p className={cn("text-lg font-bold tabular-nums", color)}>{value}</p>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{label}</p>
                        </div>
                    ))}
                </div>

                {details.comment && (
                    <div className="rounded-lg border border-border/20 bg-card/40 p-3">
                        <p className="text-[11px] text-muted-foreground/60 mb-1 font-semibold uppercase tracking-wide">Comment</p>
                        <p className="text-xs text-muted-foreground">{details.comment}</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

export function TableManagerDialog({
    open,
    onClose,
    schema,
    table,
    initialTab = "overview",
    onTableChanged,
}: TableManagerDialogProps) {
    const { connectionId, refreshSchemas } = useConnectionStore();
    const [details, setDetails] = useState<TableDetails | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState(initialTab);

    // Rename table state
    const [renamingTable, setRenamingTable] = useState(false);
    const [newTableName, setNewTableName] = useState("");
    const [renameSaving, setRenameSaving] = useState(false);

    // Destructive operation state
    const [confirmTruncate, setConfirmTruncate] = useState(false);
    const [confirmDrop, setConfirmDrop] = useState(false);
    const [destructiveLoading, setDestructiveLoading] = useState(false);

    const loadDetails = useCallback(async () => {
        if (!connectionId || !schema || !table) return;
        setLoading(true);
        setError(null);
        try {
            const d = await dbGetTableDetails(connectionId, schema, table);
            setDetails(d);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [connectionId, schema, table]);

    useEffect(() => {
        if (open) {
            setActiveTab(initialTab);
            loadDetails();
        }
    }, [open, loadDetails, initialTab]);

    const handleRenameTable = async () => {
        if (!newTableName.trim() || !connectionId) return;
        setRenameSaving(true);
        try {
            await dbRenameTable(connectionId, schema, table, newTableName.trim());
            toast.success(`Table renamed to "${newTableName}"`);
            setRenamingTable(false);
            refreshSchemas();
            onTableChanged?.();
            onClose();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setRenameSaving(false);
        }
    };

    const handleTruncate = async () => {
        if (!connectionId) return;
        setDestructiveLoading(true);
        try {
            await dbTruncateTable(connectionId, schema, table);
            toast.success(`Table "${table}" truncated`);
            setConfirmTruncate(false);
            loadDetails();
            onTableChanged?.();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setDestructiveLoading(false);
        }
    };

    const handleDrop = async () => {
        if (!connectionId) return;
        setDestructiveLoading(true);
        try {
            await dbDropTable(connectionId, schema, table, true);
            toast.success(`Table "${table}" dropped`);
            setConfirmDrop(false);
            refreshSchemas();
            onTableChanged?.();
            onClose();
        } catch (e) {
            toast.error(String(e));
        } finally {
            setDestructiveLoading(false);
        }
    };

    const isView = details?.table_type === "VIEW";

    return (
        <>
            <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
                <DialogContent className="max-w-[96vw] xl:max-w-[1100px] w-full h-[90vh] flex flex-col p-0 gap-0 overflow-hidden shadow-2xl sm:rounded-xl">
                    {/* Header */}
                    <div className="flex items-start justify-between px-6 pt-6 pb-5 border-b border-border/20 shrink-0 bg-muted/5">
                        <div className="flex items-center gap-4 min-w-0">
                            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 shrink-0 border border-primary/20 shadow-sm">
                                {isView ? <Eye className="h-5 w-5 text-blue-400" /> : <Table2 className="h-5 w-5 text-emerald-400" />}
                            </div>
                            <div className="min-w-0">
                                {renamingTable ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            autoFocus
                                            value={newTableName}
                                            onChange={(e) => setNewTableName(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") handleRenameTable();
                                                if (e.key === "Escape") setRenamingTable(false);
                                            }}
                                            className="h-8 text-base font-mono w-64 bg-background/60"
                                        />
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setRenamingTable(false)}><X className="h-4 w-4" /></Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" onClick={handleRenameTable} disabled={renameSaving}>
                                            {renameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-lg font-semibold font-mono truncate tracking-tight">{table}</h2>
                                        <button
                                            type="button"
                                            onClick={() => { setNewTableName(table); setRenamingTable(true); }}
                                            className="text-muted-foreground/40 hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                )}
                                <p className="text-xs text-muted-foreground/70 font-mono mt-0.5 flex items-center gap-1.5">
                                    <Database className="h-3 w-3 opacity-50" />
                                    {schema}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0 mt-1">
                            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={loadDetails} disabled={loading}>
                                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                Refresh
                            </Button>
                            {!isView && (
                                <Button
                                    variant="outline" size="sm"
                                    className="h-7 text-xs gap-1.5 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                                    onClick={() => setConfirmTruncate(true)}
                                >
                                    <AlertTriangle className="h-3 w-3" /> Truncate
                                </Button>
                            )}
                            <Button
                                variant="outline" size="sm"
                                className="h-7 text-xs gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                                onClick={() => setConfirmDrop(true)}
                            >
                                <Trash2 className="h-3 w-3" /> Drop
                            </Button>
                        </div>
                    </div>

                    {/* Body */}
                    <div className="flex-1 min-h-0 flex flex-col">
                        {loading && !details ? (
                            <div className="flex-1 space-y-3 p-4">
                                {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
                            </div>
                        ) : error ? (
                            <div className="flex-1 flex items-center justify-center">
                                <div className="text-center">
                                    <AlertTriangle className="h-10 w-10 text-destructive/50 mx-auto mb-3" />
                                    <p className="text-sm text-muted-foreground">{error}</p>
                                    <Button variant="ghost" size="sm" className="mt-3" onClick={loadDetails}>Retry</Button>
                                </div>
                            </div>
                        ) : details ? (
                            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
                                <TabsList className="mx-4 mt-3 shrink-0 h-8 bg-muted/30 rounded-lg p-0.5 gap-0.5">
                                    {[
                                        { value: "overview", label: "Overview" },
                                        { value: "columns", label: `Columns (${details.columns.length})` },
                                        { value: "constraints", label: `Constraints (${details.constraints.length})` },
                                        { value: "indexes", label: `Indexes (${details.indexes.length})` },
                                        { value: "triggers", label: `Triggers (${details.triggers.length})` },
                                        { value: "sql", label: "SQL Script" },
                                    ].map(({ value, label }) => (
                                        <TabsTrigger key={value} value={value} className="h-7 text-[11px] px-3 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm">
                                            {label}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                                <div className="flex-1 min-h-0 mt-2">
                                    <TabsContent value="overview" className="h-full m-0">
                                        <OverviewTab details={details} connectionId={connectionId!} onRenameTable={() => { setNewTableName(table); setRenamingTable(true); }} />
                                    </TabsContent>
                                    <TabsContent value="columns" className="h-full m-0 flex flex-col">
                                        <ColumnsTab details={details} connectionId={connectionId!} onRefresh={loadDetails} />
                                    </TabsContent>
                                    <TabsContent value="constraints" className="h-full m-0 flex flex-col">
                                        <ConstraintsTab details={details} />
                                    </TabsContent>
                                    <TabsContent value="indexes" className="h-full m-0 flex flex-col">
                                        <IndexesTab details={details} />
                                    </TabsContent>
                                    <TabsContent value="triggers" className="h-full m-0 flex flex-col">
                                        <TriggersTab details={details} />
                                    </TabsContent>
                                    <TabsContent value="sql" className="h-full m-0 flex flex-col">
                                        <SqlScriptTab details={details} connectionId={connectionId!} />
                                    </TabsContent>
                                </div>
                            </Tabs>
                        ) : null}
                    </div>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={confirmTruncate}
                title={`Truncate "${table}"?`}
                description={`This will permanently delete ALL rows from "${schema}.${table}" and reset sequences. This cannot be undone.`}
                confirmLabel="Truncate Table"
                destructive
                loading={destructiveLoading}
                onConfirm={handleTruncate}
                onCancel={() => setConfirmTruncate(false)}
            />

            <ConfirmDialog
                open={confirmDrop}
                title={`Drop "${table}"?`}
                description={`This will permanently drop the table "${schema}.${table}" and all its data, indexes, and constraints (CASCADE). This cannot be undone.`}
                confirmLabel="Drop Table"
                destructive
                loading={destructiveLoading}
                onConfirm={handleDrop}
                onCancel={() => setConfirmDrop(false)}
            />
        </>
    );
}
