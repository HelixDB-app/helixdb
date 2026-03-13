"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AIError } from "@/lib/ai-chat-engine";
import {
    generateDocAssistContent,
    mergeDocContent,
    type DocAssistContextInput,
} from "@/lib/ai-doc-assist";

export interface DocAiAssistDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentValue: string;
    docTitle?: string | null;
    getContext: (doc: { content: string; title?: string | null }) => Promise<DocAssistContextInput>;
    contextStats?: {
        tableCount: number;
        fileCount: number;
        docCount: number;
    };
    onApply: (nextValue: string) => void;
}

export function DocAiAssistDialog({
    open,
    onOpenChange,
    currentValue,
    docTitle,
    getContext,
    contextStats,
    onApply,
}: DocAiAssistDialogProps) {
    const [prompt, setPrompt] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (open) return;
        setPrompt("");
        setError(null);
        setIsGenerating(false);
        abortRef.current?.abort();
        abortRef.current = null;
    }, [open]);

    const contextSummary = useMemo(() => {
        if (!contextStats) return "";
        const parts: string[] = [];
        if (contextStats.tableCount > 0) parts.push(`${contextStats.tableCount} tables`);
        if (contextStats.fileCount > 0) parts.push(`${contextStats.fileCount} files`);
        if (contextStats.docCount > 0) parts.push(`${contextStats.docCount} docs`);
        return parts.join(" • ");
    }, [contextStats]);

    const handleGenerate = useCallback(async () => {
        const trimmed = prompt.trim();
        if (!trimmed) {
            toast.info("Describe what you want the AI to generate.");
            return;
        }

        setIsGenerating(true);
        setError(null);
        const abort = new AbortController();
        abortRef.current = abort;

        try {
            const context = await getContext({ content: currentValue, title: docTitle ?? null });
            const result = await generateDocAssistContent({
                prompt: trimmed,
                context,
                signal: abort.signal,
            });

            const nextValue = mergeDocContent(currentValue, result.doc);
            onApply(nextValue);
            toast.success("AI Assist inserted into the document.");
            onOpenChange(false);
        } catch (err) {
            if (err instanceof AIError) {
                setError(err.userMessage);
                toast.error(err.userMessage);
            } else {
                const message = err instanceof Error ? err.message : "AI Assist failed.";
                setError(message);
                toast.error(message);
            }
        } finally {
            setIsGenerating(false);
        }
    }, [prompt, getContext, currentValue, docTitle, onApply, onOpenChange]);

    const handleCancel = useCallback(() => {
        if (isGenerating) {
            abortRef.current?.abort();
        }
        onOpenChange(false);
    }, [isGenerating, onOpenChange]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-emerald-500" />
                        AI Assist
                    </DialogTitle>
                    <DialogDescription>
                        Generate documentation from your schema and project files. Output is inserted directly into the editor.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Request</label>
                        <Textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="e.g. Create documentation for the Users table"
                            rows={5}
                            className="text-sm"
                            disabled={isGenerating}
                        />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-[11px]">Context-aware</Badge>
                        {contextSummary && (
                            <span className="text-[11px] text-muted-foreground">{contextSummary}</span>
                        )}
                        {docTitle && (
                            <span className="text-[11px] text-muted-foreground">Document: {docTitle}</span>
                        )}
                    </div>

                    {error && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {error}
                        </div>
                    )}
                </div>

                <DialogFooter className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                        {isGenerating ? "Generating…" : "AI output will be appended if the document already has content."}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={handleCancel} disabled={isGenerating}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={handleGenerate} disabled={isGenerating || !prompt.trim()}>
                            {isGenerating ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Working…
                                </>
                            ) : (
                                "Generate"
                            )}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
