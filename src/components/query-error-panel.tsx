"use client";

import { useCallback, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Copy, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { explainQueryErrorWithAI } from "@/lib/query-error-ai";
import { AIError } from "@/lib/ai-chat-engine";
import { isDbInfrastructureError } from "@/lib/db-errors";
import { DbInfrastructureErrorState } from "@/components/db-infrastructure-error-state";

function extractObjectName(raw: string, prefix: string): string | null {
    const lower = raw.toLowerCase();
    const i = lower.indexOf(prefix);
    if (i === -1) return null;
    const after = raw.slice(i + prefix.length).trim();
    const match = after.match(/^["']?([a-z_][a-z0-9_]*)/i) || after.match(/^([a-z_][a-z0-9_]*)\s*\(/i);
    return match ? match[1] : null;
}

function explainQueryError(raw: string): { summary: string; fix: string } | null {
    const lower = raw.toLowerCase();
    if (lower.includes("function") && (lower.includes("does not exist") || lower.includes("no function matches"))) {
        const name = extractObjectName(raw, "function");
        const withName = name ? ` The function \`${name}\` is not defined or has different argument types.` : "";
        let fix = "Create the function with CREATE FUNCTION, fix the name/schema, or call an existing overload.";
        if (lower.includes("argument type") || lower.includes("type cast") || lower.includes("explicit type")) {
            fix = "No function matches the name and argument types. Create the function with the right signature, or add explicit casts (e.g. mycol::date).";
        }
        return { summary: `A function you're calling doesn't exist in this database.${withName}`, fix };
    }
    if (lower.includes("column") && (lower.includes("does not exist") || lower.includes("undefined"))) {
        return {
            summary: "A column in your query doesn't exist on the table.",
            fix: "Check spelling and that the column exists. Use the correct column names from the table definition.",
        };
    }
    if (lower.includes("relation") && lower.includes("does not exist") || (lower.includes("does not exist") && !lower.includes("schema"))) {
        return {
            summary: "The table or view you're referring to doesn't exist.",
            fix: "Check the table name and schema (e.g. public.mytable). Use CREATE TABLE or fix the typo.",
        };
    }
    if (lower.includes("schema") && lower.includes("does not exist")) {
        return {
            summary: "The schema doesn't exist.",
            fix: "Check the schema name (e.g. public). Use CREATE SCHEMA or fix the typo.",
        };
    }
    if (lower.includes("syntax error") || lower.includes("parse error")) {
        return {
            summary: "PostgreSQL couldn't parse your SQL.",
            fix: "Check brackets, commas, quotes, and keywords. Common issues: missing comma, unclosed quote, wrong keyword order.",
        };
    }
    if (lower.includes("permission denied") || lower.includes("access denied")) {
        return {
            summary: "Your database user doesn't have permission for this operation.",
            fix: "Use a user with the right privileges, or GRANT the needed permissions.",
        };
    }
    if (lower.includes("duplicate key") || lower.includes("unique constraint")) {
        return {
            summary: "A unique or primary key constraint would be violated.",
            fix: "Change the value for the unique/PK column so it doesn't match an existing row.",
        };
    }
    if (lower.includes("foreign key") || lower.includes("violates foreign key")) {
        return {
            summary: "A foreign key constraint failed.",
            fix: "Insert the referenced row first, or use a valid foreign key value.",
        };
    }
    if (lower.includes("null value") && lower.includes("violates not-null")) {
        return {
            summary: "A NOT NULL column received a NULL value.",
            fix: "Provide a non-NULL value, or alter the column to allow NULL.",
        };
    }
    if (lower.includes("connection") || lower.includes("pool")) {
        return {
            summary: "The connection to the database was lost.",
            fix: "Check your network and DB server. Try reconnecting.",
        };
    }
    return null;
}

export interface QueryErrorPanelProps {
    message: string;
    sql?: string;
    schemaContextForAi?: string;
    /** Re-run the current query (shown for connection / transport failures). */
    onRetry?: () => void;
    isRetrying?: boolean;
}

export function QueryErrorPanel({ message, sql, schemaContextForAi, onRetry, isRetrying }: QueryErrorPanelProps) {
    const [copied, setCopied] = useState(false);
    const [showTechnical, setShowTechnical] = useState(false);
    const [aiExplanation, setAiExplanation] = useState<string | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const explanation = explainQueryError(message);
    const shortMessage = message.split(/\n/)[0]?.trim() || message;
    const canUseAi = Boolean(sql?.trim() && schemaContextForAi?.trim());

    const handleAiExplain = useCallback(async () => {
        if (!sql?.trim() || !schemaContextForAi?.trim()) return;
        setAiLoading(true);
        setAiError(null);
        setAiExplanation(null);
        try {
            const result = await explainQueryErrorWithAI(sql, message, schemaContextForAi);
            setAiExplanation(result);
        } catch (err) {
            const msg = err instanceof AIError ? err.userMessage : err instanceof Error ? err.message : "Could not get AI explanation.";
            setAiError(msg);
        } finally {
            setAiLoading(false);
        }
    }, [sql, message, schemaContextForAi]);

    if (isDbInfrastructureError(message)) {
        const infraExplain = explainQueryError(message);
        return (
            <div className="flex h-full min-h-0 flex-col animate-in fade-in slide-in-from-bottom-2 duration-200">
                <DbInfrastructureErrorState
                    className="flex-1"
                    headline="Couldn’t reach the database"
                    description={
                        infraExplain?.summary ??
                        "Your app couldn’t complete the request to PostgreSQL. Check the server, network, and credentials, then try again."
                    }
                    hint={infraExplain?.fix}
                    technicalMessage={message}
                    onRetry={onRetry}
                    isRetrying={isRetrying}
                    retryLabel="Retry query"
                    compact
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="p-4 space-y-3">
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden shadow-sm">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-destructive/10">
                        <div className="flex items-center gap-2 min-w-0">
                            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-destructive">Query failed</p>
                                {!explanation && (
                                    <p className="text-xs text-muted-foreground truncate mt-0.5" title={shortMessage}>
                                        {shortMessage}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            {canUseAi && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs border-primary/30 text-primary hover:bg-primary/10"
                                    onClick={handleAiExplain}
                                    disabled={aiLoading}
                                >
                                    {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                    AI Explain
                                </Button>
                            )}
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => {
                                    navigator.clipboard.writeText(message);
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                }}
                            >
                                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                    </div>

                    {explanation && (
                        <div className="px-4 py-3 space-y-3">
                            <p className="text-sm text-foreground/95">{explanation.summary}</p>
                            <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-2.5">
                                <Lightbulb className="h-4 w-4 text-amber-500/80 mt-0.5 shrink-0" />
                                <div className="text-xs">
                                    <span className="font-medium text-foreground/90">How to fix: </span>
                                    <span className="text-muted-foreground">{explanation.fix}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {(aiExplanation || aiError) && (
                        <div className="px-4 py-3 border-t border-destructive/10 space-y-2">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">AI analysis</p>
                            {aiError && <p className="text-xs text-destructive/90">{aiError}</p>}
                            {aiExplanation && (
                                <ScrollArea className="max-h-56 rounded-lg border border-border/30 bg-background/90 p-3">
                                    <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-words font-sans">{aiExplanation}</pre>
                                </ScrollArea>
                            )}
                        </div>
                    )}

                    <div className="border-t border-destructive/10">
                        <button
                            type="button"
                            onClick={() => setShowTechnical((v) => !v)}
                            className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                        >
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${showTechnical ? "rotate-180" : ""}`} />
                            {showTechnical ? "Hide" : "Show"} technical details
                        </button>
                        {showTechnical && (
                            <div className="px-4 pb-4 pt-0">
                                <ScrollArea className="max-h-48 rounded-lg border border-border/30 bg-background/90 p-3">
                                    <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/80">{message}</pre>
                                </ScrollArea>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
