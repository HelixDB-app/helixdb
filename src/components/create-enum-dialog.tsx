"use client";

import { useState, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connection-store";
import { dbCreateEnum } from "@/lib/db-platform";
import { Plus, Trash2, Loader2, Type } from "lucide-react";
import { toast } from "sonner";

function validateIdentifier(name: string): string | null {
    if (!name.trim()) return "Required";
    if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name.trim()))
        return "Must start with a letter or underscore; only letters, digits, underscore, or $";
    if (name.length > 63) return "Max 63 characters";
    return null;
}

interface CreateEnumDialogProps {
    open: boolean;
    onClose: () => void;
    defaultSchema: string;
    schemas: string[];
    onCreated: (schema: string, name: string) => void;
}

export function CreateEnumDialog({
    open,
    onClose,
    defaultSchema,
    schemas,
    onCreated,
}: CreateEnumDialogProps) {
    const connectionId = useConnectionStore((s) => s.connectionId);
    const selectPreview = useConnectionStore((s) => s.selectPreview);

    const [schema, setSchema] = useState(defaultSchema);
    const [name, setName] = useState("");
    const [values, setValues] = useState<string[]>(["NEW"]);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = useCallback(() => {
        setSchema(defaultSchema);
        setName("");
        setValues(["NEW"]);
        setError(null);
    }, [defaultSchema]);

    const handleOpenChange = useCallback(
        (next: boolean) => {
            if (!next) {
                reset();
                onClose();
            }
        },
        [onClose, reset]
    );

    const addValue = () => setValues((prev) => [...prev, ""]);
    const removeValue = (i: number) =>
        setValues((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)));
    const setValue = (i: number, v: string) =>
        setValues((prev) => {
            const next = [...prev];
            next[i] = v;
            return next;
        });

    const handleCreate = useCallback(async () => {
        if (!connectionId) return;
        const nameErr = validateIdentifier(name);
        if (nameErr) {
            setError(`Name: ${nameErr}`);
            return;
        }
        const trimmed = values.map((v) => v.trim()).filter(Boolean);
        if (trimmed.length === 0) {
            setError("Add at least one enum value.");
            return;
        }
        const uniq = new Set(trimmed);
        if (uniq.size !== trimmed.length) {
            setError("Duplicate values are not allowed.");
            return;
        }
        setError(null);
        setCreating(true);
        try {
            await dbCreateEnum(connectionId, schema, name.trim(), trimmed);
            toast.success(`Enum "${name}" created`);
            onCreated(schema, name.trim());
            selectPreview({ kind: "type", schema, name: name.trim() });
            reset();
            onClose();
        } catch (e) {
            setError(String(e));
            toast.error(String(e));
        } finally {
            setCreating(false);
        }
    }, [connectionId, schema, name, values, onCreated, selectPreview, reset, onClose]);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Type className="h-4 w-4 text-rose-400" />
                        Create enum type
                    </DialogTitle>
                    <DialogDescription>
                        Add a new enum type to the schema. You can edit values later from the type preview.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Schema</label>
                            <Select value={schema} onValueChange={setSchema}>
                                <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {schemas.map((s) => (
                                        <SelectItem key={s} value={s} className="text-xs">
                                            {s}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Name</label>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Status"
                                className="h-8 text-xs font-mono"
                            />
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Values</label>
                        <div className="space-y-1.5 max-h-48 overflow-auto rounded border border-border/30 bg-muted/10 p-2">
                            {values.map((v, i) => (
                                <div key={i} className="flex items-center gap-1.5">
                                    <Input
                                        value={v}
                                        onChange={(e) => setValue(i, e.target.value)}
                                        className="h-7 text-[11px] font-mono flex-1"
                                        placeholder="Value"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => removeValue(i)}
                                        disabled={values.length <= 1}
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </Button>
                                </div>
                            ))}
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="w-full h-7 text-[11px] text-muted-foreground"
                                onClick={addValue}
                            >
                                <Plus className="h-3 w-3 mr-1" /> Add value
                            </Button>
                        </div>
                    </div>
                    {error && (
                        <p className="text-xs text-destructive rounded bg-destructive/10 px-2 py-1.5">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter className="gap-2 sm:gap-0">
                    <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={handleCreate} disabled={creating}>
                        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                        Create enum
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
