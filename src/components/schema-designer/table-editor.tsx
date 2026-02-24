"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Table2, Plus, Trash2, Pencil, Key, Link } from "lucide-react";
import { toast } from "sonner";
import type { SchemaDesignerColumn, SchemaDesignerTable } from "@/lib/types";

const PG_TYPES = [
    "UUID", "TEXT", "VARCHAR(255)", "VARCHAR(100)", "VARCHAR(50)",
    "INTEGER", "BIGINT", "SMALLINT", "SERIAL", "BIGSERIAL",
    "NUMERIC(10,2)", "NUMERIC(12,4)", "REAL", "DOUBLE PRECISION",
    "BOOLEAN", "TIMESTAMPTZ", "TIMESTAMP", "DATE", "TIME",
    "JSONB", "JSON", "BYTEA", "INET", "CIDR", "MACADDR",
    "INT4RANGE", "TSTZRANGE", "POINT", "POLYGON",
    "TEXT[]", "INTEGER[]", "UUID[]",
];

interface TableEditorProps {
    selectedTableId: string | null;
    onSelectTable: (id: string | null) => void;
}

export function TableEditor({ selectedTableId, onSelectTable }: TableEditorProps) {
    const {
        getActiveProject,
        addTable,
        deleteTable,
        updateTable,
        addColumn,
        updateColumn,
        deleteColumn,
        pushUndo,
    } = useSchemaDesignerStore();

    const project = getActiveProject();
    const [showAddTable, setShowAddTable] = useState(false);
    const [newTableName, setNewTableName] = useState("");
    const [editingColumn, setEditingColumn] = useState<{ tableId: string; columnId: string } | null>(null);
    const [editForm, setEditForm] = useState<Partial<SchemaDesignerColumn>>({});
    const [showAddColumn, setShowAddColumn] = useState<string | null>(null);
    const [newColForm, setNewColForm] = useState({
        name: "",
        data_type: "TEXT",
        nullable: true,
        default_value: "",
        is_primary_key: false,
    });

    // Remember last selected table by name so we can restore after schema updates (e.g. Script apply) that change table ids
    const lastSelectedTableNameRef = useRef<string | null>(null);

    // Keep selection in sync only when current id is missing (table removed or ids replaced). Preserve selection by name when possible.
    useEffect(() => {
        if (!project?.tables.length) {
            onSelectTable(null);
            lastSelectedTableNameRef.current = null;
            return;
        }
        const exists = selectedTableId && project.tables.some(t => t.id === selectedTableId);
        if (exists) {
            const current = project.tables.find(t => t.id === selectedTableId);
            if (current) lastSelectedTableNameRef.current = current.name;
            return;
        }
        // Current selection is invalid: restore by table name (e.g. after Script apply gave new ids), else pick first
        const nameToRestore = lastSelectedTableNameRef.current;
        const byName = nameToRestore ? project.tables.find(t => t.name === nameToRestore) : null;
        if (byName) {
            onSelectTable(byName.id);
        } else {
            onSelectTable(project.tables[0]?.id ?? null);
            if (project.tables[0]) lastSelectedTableNameRef.current = project.tables[0].name;
        }
    }, [project?.tables, selectedTableId, onSelectTable]);

    const handleAddTable = useCallback(() => {
        if (!newTableName.trim()) return;
        addTable(newTableName.trim().toLowerCase().replace(/\s+/g, "_"));
        setNewTableName("");
        setShowAddTable(false);
        toast.success("Table created!");
    }, [newTableName, addTable]);

    const handleAddColumn = useCallback(() => {
        if (!showAddColumn || !newColForm.name.trim()) return;
        addColumn(showAddColumn, {
            name: newColForm.name.trim().toLowerCase().replace(/\s+/g, "_"),
            data_type: newColForm.data_type,
            nullable: newColForm.nullable,
            default_value: newColForm.default_value || null,
            is_primary_key: newColForm.is_primary_key,
            foreign_key: null,
        });
        setShowAddColumn(null);
        setNewColForm({ name: "", data_type: "TEXT", nullable: true, default_value: "", is_primary_key: false });
        toast.success("Column added!");
    }, [showAddColumn, newColForm, addColumn]);

    const handleSaveColumnEdit = useCallback(() => {
        if (!editingColumn) return;
        pushUndo("Edit column");
        updateColumn(editingColumn.tableId, editingColumn.columnId, editForm);
        setEditingColumn(null);
        setEditForm({});
    }, [editingColumn, editForm, pushUndo, updateColumn]);

    const handleSetForeignKey = useCallback((tableId: string, columnId: string, targetTableId: string, targetColumnId: string) => {
        pushUndo("Set foreign key");
        updateColumn(tableId, columnId, {
            foreign_key: { target_table_id: targetTableId, target_column_id: targetColumnId },
        });
        toast.success("Foreign key set!");
    }, [pushUndo, updateColumn]);

    const handleRemoveForeignKey = useCallback((tableId: string, columnId: string) => {
        pushUndo("Remove foreign key");
        updateColumn(tableId, columnId, { foreign_key: null });
        toast.success("Foreign key removed");
    }, [pushUndo, updateColumn]);

    if (!project) return null;

    const selectedTable = selectedTableId
        ? project.tables.find(t => t.id === selectedTableId)
        : project.tables[0] ?? null;

    return (
        <div className="h-full flex flex-col">
            {/* Header: title + Add Table */}
            <div className="flex items-center justify-between border-b border-border/20 px-4 py-2 shrink-0">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Tables ({project.tables.length})
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 text-xs text-emerald-500 hover:text-emerald-400"
                    onClick={() => setShowAddTable(true)}
                >
                    <Plus className="h-3 w-3" />
                    Add Table
                </Button>
            </div>

            <div className="flex-1 min-h-0 flex">
                {/* Left: table list (no dropdown) */}
                <div className="w-44 shrink-0 border-r border-border/20 flex flex-col overflow-hidden">
                    {project.tables.length === 0 ? (
                        <div className="flex flex-col items-center justify-center flex-1 text-center p-4">
                            <Table2 className="h-8 w-8 text-muted-foreground/20 mb-2" />
                            <p className="text-[11px] text-muted-foreground/60 mb-3">No tables</p>
                            <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => setShowAddTable(true)}>
                                <Plus className="h-3 w-3" />
                                Add table
                            </Button>
                        </div>
                    ) : (
                        <ul className="flex-1 overflow-y-auto py-1">
                            {project.tables.map((table) => {
                                const isSelected = selectedTableId === table.id;
                                return (
                                    <li key={table.id}>
                                        <button
                                            type="button"
                                            className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors rounded-r-md border-l-2 border-transparent group ${isSelected
                                                ? "bg-emerald-500/10 border-l-emerald-500 text-foreground"
                                                : "hover:bg-muted/30 text-muted-foreground hover:text-foreground"
                                                }`}
                                            onClick={() => {
                                                lastSelectedTableNameRef.current = table.name;
                                                onSelectTable(table.id);
                                            }}
                                        >
                                            <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/90" />
                                            <span className="text-sm font-medium truncate flex-1 min-w-0">
                                                {table.name}
                                            </span>
                                            <span className="text-[10px] tabular-nums text-muted-foreground/60 shrink-0">
                                                {table.columns.length}
                                            </span>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (confirm("Delete this table?")) deleteTable(table.id);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 shrink-0"
                                                aria-label="Delete table"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                {/* Right: columns for selected table */}
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    {!selectedTable ? (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-sm">
                            Select a table
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center justify-between border-b border-border/10 px-4 py-2 shrink-0 bg-muted/5">
                                <span className="text-xs font-medium text-foreground">{selectedTable.name}</span>
                                <span className="text-[10px] text-muted-foreground">{selectedTable.columns.length} columns</span>
                            </div>
                            <div className="flex-1 overflow-y-auto">
                                <table className="w-full text-xs border-collapse">
                                    <thead className="sticky top-0 bg-muted/30 z-10">
                                        <tr className="border-b border-border/20">
                                            <th className="text-left py-2 px-3 font-medium text-muted-foreground w-8" aria-label="Key" />
                                            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Column</th>
                                            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Type</th>
                                            <th className="text-left py-2 px-3 font-medium text-muted-foreground w-16">Constraints</th>
                                            <th className="w-16" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedTable.columns.map((col) => {
                                            const fkTarget = col.foreign_key
                                                ? project.tables.find(t => t.id === col.foreign_key!.target_table_id)
                                                : null;
                                            const fkCol = fkTarget?.columns.find(c => c.id === col.foreign_key!.target_column_id);
                                            return (
                                                <tr
                                                    key={col.id}
                                                    className="border-b border-border/10 hover:bg-muted/15 group"
                                                >
                                                    <td className="py-1.5 px-3">
                                                        {col.is_primary_key && <Key className="h-3 w-3 text-amber-500" aria-label="Primary key" />}
                                                        {col.foreign_key && !col.is_primary_key && <Link className="h-3 w-3 text-blue-500" aria-label="Foreign key" />}
                                                    </td>
                                                    <td className="py-1.5 px-3 font-mono text-foreground">{col.name}</td>
                                                    <td className="py-1.5 px-3 font-mono text-muted-foreground/80">{col.data_type}</td>
                                                    <td className="py-1.5 px-3">
                                                        {!col.nullable && <span className="text-[9px] text-orange-500/80 font-medium">NN</span>}
                                                        {fkTarget && fkCol && (
                                                            <span className="text-[9px] text-blue-500/80" title={`→ ${fkTarget.name}.${fkCol.name}`}>
                                                                →{fkTarget.name}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="py-1.5 px-2">
                                                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={() => {
                                                                    setEditingColumn({ tableId: selectedTable.id, columnId: col.id });
                                                                    setEditForm({
                                                                        name: col.name,
                                                                        data_type: col.data_type,
                                                                        nullable: col.nullable,
                                                                        default_value: col.default_value,
                                                                        is_primary_key: col.is_primary_key,
                                                                    });
                                                                }}
                                                                className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
                                                                aria-label="Edit column"
                                                            >
                                                                <Pencil className="h-2.5 w-2.5" />
                                                            </button>
                                                            <button
                                                                onClick={() => deleteColumn(selectedTable.id, col.id)}
                                                                className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500"
                                                                aria-label="Delete column"
                                                            >
                                                                <Trash2 className="h-2.5 w-2.5" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                <div className="border-t border-border/10 p-2">
                                    <button
                                        onClick={() => setShowAddColumn(selectedTable.id)}
                                        className="w-full flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground/60 hover:text-emerald-500 hover:bg-muted/20 rounded-md transition-colors"
                                    >
                                        <Plus className="h-3 w-3" />
                                        Add column
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Add Table Dialog */}
            <Dialog open={showAddTable} onOpenChange={setShowAddTable}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Add Table</DialogTitle>
                    </DialogHeader>
                    <div className="py-2">
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                            Table Name
                        </label>
                        <Input
                            value={newTableName}
                            onChange={(e) => setNewTableName(e.target.value)}
                            placeholder="users"
                            className="bg-muted/30 font-mono"
                            autoFocus
                            onKeyDown={(e) => e.key === "Enter" && handleAddTable()}
                        />
                        <p className="text-[10px] text-muted-foreground/50 mt-1">
                            Will include id (UUID), created_at, updated_at by default.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowAddTable(false)}>Cancel</Button>
                        <Button onClick={handleAddTable} disabled={!newTableName.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                            Add
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Add Column Dialog */}
            <Dialog open={!!showAddColumn} onOpenChange={() => setShowAddColumn(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Add Column</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
                            <Input
                                value={newColForm.name}
                                onChange={(e) => setNewColForm(f => ({ ...f, name: e.target.value }))}
                                placeholder="email"
                                className="bg-muted/30 font-mono"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
                            <Select value={newColForm.data_type} onValueChange={(v) => setNewColForm(f => ({ ...f, data_type: v }))}>
                                <SelectTrigger className="bg-muted/30 font-mono text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PG_TYPES.map(t => (
                                        <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Default Value</label>
                            <Input
                                value={newColForm.default_value}
                                onChange={(e) => setNewColForm(f => ({ ...f, default_value: e.target.value }))}
                                placeholder="NULL"
                                className="bg-muted/30 font-mono text-xs"
                            />
                        </div>
                        <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={newColForm.nullable}
                                    onCheckedChange={(v: boolean) => setNewColForm(f => ({ ...f, nullable: !!v }))}
                                />
                                Nullable
                            </label>
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={newColForm.is_primary_key}
                                    onCheckedChange={(v: boolean) => setNewColForm(f => ({ ...f, is_primary_key: !!v }))}
                                />
                                Primary Key
                            </label>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowAddColumn(null)}>Cancel</Button>
                        <Button onClick={handleAddColumn} disabled={!newColForm.name.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                            Add
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Column Dialog */}
            <Dialog open={!!editingColumn} onOpenChange={() => setEditingColumn(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Edit Column</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
                            <Input
                                value={editForm.name ?? ""}
                                onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
                                className="bg-muted/30 font-mono"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
                            <Select value={editForm.data_type ?? "TEXT"} onValueChange={(v) => setEditForm(f => ({ ...f, data_type: v }))}>
                                <SelectTrigger className="bg-muted/30 font-mono text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PG_TYPES.map(t => (
                                        <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1 block">Default</label>
                            <Input
                                value={editForm.default_value ?? ""}
                                onChange={(e) => setEditForm(f => ({ ...f, default_value: e.target.value || null }))}
                                className="bg-muted/30 font-mono text-xs"
                            />
                        </div>
                        <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={editForm.nullable ?? true}
                                    onCheckedChange={(v: boolean) => setEditForm(f => ({ ...f, nullable: !!v }))}
                                />
                                Nullable
                            </label>
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={editForm.is_primary_key ?? false}
                                    onCheckedChange={(v: boolean) => setEditForm(f => ({ ...f, is_primary_key: !!v }))}
                                />
                                Primary Key
                            </label>
                        </div>

                        {/* Foreign Key */}
                        {editingColumn && (
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                                    Foreign Key (optional)
                                </label>
                                <div className="flex gap-2">
                                    <Select
                                        value={editForm.foreign_key ? `${editForm.foreign_key.target_table_id}::${editForm.foreign_key.target_column_id}` : "none"}
                                        onValueChange={(v) => {
                                            if (v === "none") {
                                                setEditForm(f => ({ ...f, foreign_key: null }));
                                            } else {
                                                const [tableId, colId] = v.split("::");
                                                setEditForm(f => ({
                                                    ...f,
                                                    foreign_key: { target_table_id: tableId, target_column_id: colId },
                                                }));
                                            }
                                        }}
                                    >
                                        <SelectTrigger className="bg-muted/30 font-mono text-xs">
                                            <SelectValue placeholder="None" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none" className="text-xs">None</SelectItem>
                                            {project?.tables
                                                .filter(t => t.id !== editingColumn.tableId)
                                                .flatMap(t =>
                                                    t.columns
                                                        .filter(c => c.is_primary_key)
                                                        .map(c => (
                                                            <SelectItem
                                                                key={`${t.id}::${c.id}`}
                                                                value={`${t.id}::${c.id}`}
                                                                className="font-mono text-xs"
                                                            >
                                                                {t.name}.{c.name}
                                                            </SelectItem>
                                                        ))
                                                )}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditingColumn(null)}>Cancel</Button>
                        <Button onClick={handleSaveColumnEdit} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
