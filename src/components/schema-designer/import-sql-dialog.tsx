"use client";

import { useState, useCallback } from "react";
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
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ImportSqlDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When true, offer "Replace current schema"; when false, only create new project */
    hasActiveProject?: boolean;
}

export function ImportSqlDialog({
    open,
    onOpenChange,
    hasActiveProject = false,
}: ImportSqlDialogProps) {
    const { createProjectFromSql, importSqlToCurrent } = useSchemaDesignerStore();
    const [sql, setSql] = useState("");
    const [projectName, setProjectName] = useState("");
    const [mode, setMode] = useState<"new" | "replace">("new");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleImport = useCallback(async () => {
        const trimmed = sql.trim();
        if (!trimmed) {
            toast.error("Paste a SQL script first");
            return;
        }

        setIsSubmitting(true);
        try {
            if (hasActiveProject && mode === "replace") {
                const ok = importSqlToCurrent(trimmed);
                if (ok) {
                    toast.success("Schema replaced with imported SQL");
                    onOpenChange(false);
                    setSql("");
                } else {
                    toast.error("Could not parse SQL. Check CREATE TABLE syntax.");
                }
            } else {
                const name = projectName.trim() || `Imported ${new Date().toLocaleDateString()}`;
                await createProjectFromSql(name, trimmed);
                toast.success("Project created from SQL");
                onOpenChange(false);
                setSql("");
                setProjectName("");
            }
        } catch (e) {
            toast.error(String(e));
        } finally {
            setIsSubmitting(false);
        }
    }, [
        sql,
        projectName,
        mode,
        hasActiveProject,
        createProjectFromSql,
        importSqlToCurrent,
        onOpenChange,
    ]);

    const handleOpenChange = useCallback(
        (next: boolean) => {
            if (!next) {
                setSql("");
                setProjectName("");
                setMode("new");
            }
            onOpenChange(next);
        },
        [onOpenChange]
    );

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FileUp className="h-4 w-4 text-emerald-500" />
                        Import from SQL
                    </DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">
                    Paste PostgreSQL CREATE TABLE statements. Tables will be parsed and added to the designer.
                </p>
                {hasActiveProject && (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                                mode === "new"
                                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "border-border/30 bg-muted/20 text-muted-foreground"
                            }`}
                            onClick={() => setMode("new")}
                        >
                            New project
                        </button>
                        <button
                            type="button"
                            className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                                mode === "replace"
                                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "border-border/30 bg-muted/20 text-muted-foreground"
                            }`}
                            onClick={() => setMode("replace")}
                        >
                            Replace current schema
                        </button>
                    </div>
                )}
                {mode === "new" && (
                    <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1 block">
                            Project name (optional)
                        </label>
                        <Input
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                            placeholder="Imported from SQL"
                            className="bg-muted/30 text-sm h-8"
                        />
                    </div>
                )}
                <div className="flex-1 min-h-0 flex flex-col">
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                        SQL script
                    </label>
                    <textarea
                        value={sql}
                        onChange={(e) => setSql(e.target.value)}
                        placeholder={'CREATE TABLE "users" (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);'}
                        className="flex-1 min-h-[200px] w-full rounded-md border border-border/30 bg-muted/20 p-3 font-mono text-xs resize-y"
                        spellCheck={false}
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleImport}
                        disabled={!sql.trim() || isSubmitting}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                        {isSubmitting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <FileUp className="h-3 w-3" />
                        )}
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
