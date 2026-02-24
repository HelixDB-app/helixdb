"use client";

import { useState, useCallback, useRef } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import {
    generatePostgresScript,
    GEMINI_MODELS,
    type GeminiModelId,
} from "@/lib/schema-designer-engine";
import { sqlToSchemaDesignerTables } from "@/lib/sql-to-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Code2, Loader2, Copy, FileUp } from "lucide-react";
import { toast } from "sonner";

const MODEL_IDS = Object.keys(GEMINI_MODELS) as GeminiModelId[];

interface AIScriptPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function AIScriptPanel({ open, onOpenChange }: AIScriptPanelProps) {
    const { getActiveProject, setTables, importSqlToCurrent, createProjectFromSql } =
        useSchemaDesignerStore();
    const project = getActiveProject();

    const [prompt, setPrompt] = useState("");
    const [modelId, setModelId] = useState<GeminiModelId>("gemini-2.5-flash");
    const [script, setScript] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const handleGenerate = useCallback(async () => {
        if (!prompt.trim()) {
            toast.error("Enter a description for the script");
            return;
        }
        abortRef.current = new AbortController();
        setIsGenerating(true);
        setScript("");
        try {
            const full = await generatePostgresScript(
                prompt.trim(),
                (chunk) => setScript((s) => s + chunk),
                { model: modelId, signal: abortRef.current.signal }
            );
            setScript(full);
            toast.success("Script generated");
        } catch (err: unknown) {
            if (err instanceof Error && err.name !== "AbortError") {
                toast.error(err.message || "Failed to generate script");
            }
        } finally {
            setIsGenerating(false);
        }
    }, [prompt, modelId]);

    const handleCopy = useCallback(() => {
        if (!script) return;
        navigator.clipboard.writeText(script);
        toast.success("Copied to clipboard");
    }, [script]);

    const handleImportIntoDesigner = useCallback(() => {
        if (!script.trim()) return;
        try {
            const tables = sqlToSchemaDesignerTables(script);
            if (tables.length === 0) {
                toast.error("No CREATE TABLE statements found in the script");
                return;
            }
            if (project) {
                const ok = importSqlToCurrent(script);
                if (ok) {
                    toast.success(`Imported ${tables.length} tables into current project`);
                    onOpenChange(false);
                } else {
                    toast.error("Could not parse generated SQL");
                }
            } else {
                createProjectFromSql(`AI Generated ${new Date().toLocaleDateString()}`, script).then(
                    () => {
                        toast.success(`Created project with ${tables.length} tables`);
                        onOpenChange(false);
                    }
                );
            }
        } catch {
            toast.error("Could not parse SQL for import");
        }
    }, [script, project, importSqlToCurrent, createProjectFromSql, onOpenChange]);

    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        setIsGenerating(false);
    }, []);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Code2 className="h-4 w-4 text-emerald-500" />
                        Generate PostgreSQL with AI
                    </DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">
                    Describe the schema you need; Gemini will generate PostgreSQL DDL. Choose a model below.
                </p>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Model</label>
                    <Select value={modelId} onValueChange={(v) => setModelId(v as GeminiModelId)}>
                        <SelectTrigger className="bg-muted/30 h-9">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {MODEL_IDS.map((id) => (
                                <SelectItem key={id} value={id}>
                                    {GEMINI_MODELS[id].displayName}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Describe your schema</label>
                    <Input
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="e.g. Blog with users, posts, and comments. Users have email and name; posts have title, body, author_id FK; comments have body, post_id FK, user_id FK."
                        className="bg-muted/30 text-sm"
                        disabled={isGenerating}
                    />
                </div>

                <div className="flex gap-2">
                    <Button
                        onClick={isGenerating ? handleStop : handleGenerate}
                        disabled={!prompt.trim() && !isGenerating}
                        className={
                            isGenerating
                                ? "bg-red-600 hover:bg-red-700 text-white"
                                : "bg-emerald-600 hover:bg-emerald-700 text-white"
                        }
                    >
                        {isGenerating ? (
                            <>
                                <Loader2 className="h-3 w-3 animate-spin mr-2" />
                                Stop
                            </>
                        ) : (
                            <>
                                <Code2 className="h-3 w-3 mr-2" />
                                Generate
                            </>
                        )}
                    </Button>
                </div>

                {script && (
                    <div className="flex-1 min-h-0 flex flex-col border rounded-lg border-border/30 overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/20 bg-muted/20">
                            <span className="text-xs font-medium text-muted-foreground">Generated SQL</span>
                            <div className="flex gap-1">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs gap-1"
                                    onClick={handleCopy}
                                >
                                    <Copy className="h-3 w-3" />
                                    Copy
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs gap-1 text-emerald-600"
                                    onClick={handleImportIntoDesigner}
                                >
                                    <FileUp className="h-3 w-3" />
                                    Import into designer
                                </Button>
                            </div>
                        </div>
                        <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap bg-muted/10 max-h-[280px]">
                            {script}
                        </pre>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
