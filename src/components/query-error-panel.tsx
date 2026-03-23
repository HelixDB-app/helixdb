"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Copy, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { explainQueryErrorWithAI } from "@/lib/query-error-ai";
import { AIError } from "@/lib/ai-chat-engine";
import { isDbInfrastructureError } from "@/lib/db-errors";
import { DbInfrastructureErrorState } from "@/components/db-infrastructure-error-state";
import { highlightSqlForDisplay, parsePgErrorMessage } from "@/lib/parse-pg-error";

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
    if (lower.includes("insert") && lower.includes("more expressions than target columns")) {
        return {
            summary: "The INSERT has a different number of values than target columns.",
            fix: "Align VALUES (…) with the column list: same count and order, or add/remove columns in the INSERT clause.",
        };
    }
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

function Section({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
    return (
        <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/90">{label}</p>
            <div className={mono ? "text-xs font-mono text-foreground/90 whitespace-pre-wrap break-words" : "text-xs text-foreground/90 whitespace-pre-wrap break-words"}>
                {children}
            </div>
        </div>
    );
}

export interface QueryErrorPanelProps {
    message: string;
    sql?: string;
    /** SQL as recorded on the query result (full script sent to the runner). */
    resultQuery?: string;
    schemaContextForAi?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
}

export function QueryErrorPanel({ message, sql, resultQuery, schemaContextForAi, onRetry, isRetrying }: QueryErrorPanelProps) {
    const [copied, setCopied] = useState(false);
    const [showRawMessage, setShowRawMessage] = useState(false);
    const [expandNotices, setExpandNotices] = useState(false);
    const [aiExplanation, setAiExplanation] = useState<string | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);

    const parsed = useMemo(() => parsePgErrorMessage(message), [message]);
    const explanation = explainQueryError(message);
    const canUseAi = Boolean(sql?.trim() && schemaContextForAi?.trim());

    const displaySql = useMemo(() => {
        const fromServer = parsed.queryFromError?.trim();
        const rq = resultQuery?.trim();
        const ed = sql?.trim();
        if (fromServer) return { text: fromServer, label: "Failed statement (server)" as const };
        if (rq) return { text: rq, label: "Executed query" as const };
        if (ed) return { text: ed, label: "SQL in editor" as const };
        return null;
    }, [parsed.queryFromError, resultQuery, sql]);

    const highlightedSql = useMemo(() => (displaySql ? highlightSqlForDisplay(displaySql.text) : ""), [displaySql]);

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

    const noticeLimit = 4;
    const noticesShown = expandNotices ? parsed.notices : parsed.notices.slice(0, noticeLimit);
    const hasMoreNotices = parsed.notices.length > noticeLimit;

    return (
        <div className="flex h-full min-h-0 flex-col p-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden shadow-sm">
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-destructive/10">
                    <div className="flex items-center gap-2 min-w-0">
                        <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-destructive">Query failed</p>
                            {parsed.statementPrefix && (
                                <p className="text-[11px] text-muted-foreground mt-0.5 font-medium">{parsed.statementPrefix}</p>
                            )}
                            <p className="text-sm text-foreground/95 mt-1 font-medium leading-snug break-words" title={parsed.primaryError}>
                                {parsed.primaryError}
                            </p>
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

                <ScrollArea className="flex-1 min-h-0">
                    <div className="p-4 space-y-4">
                    {parsed.notices.length > 0 && (
                        <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5 space-y-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-700/90 dark:text-sky-300/90">Notices</p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                                {noticesShown.map((n, i) => (
                                    <li key={i} className="break-words">
                                        {n}
                                    </li>
                                ))}
                            </ul>
                            {hasMoreNotices && (
                                <button
                                    type="button"
                                    className="text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline"
                                    onClick={() => setExpandNotices((v) => !v)}
                                >
                                    {expandNotices ? "Show fewer" : `Show all ${parsed.notices.length} notices`}
                                </button>
                            )}
                        </div>
                    )}

                    {explanation && (
                        <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 space-y-2">
                            <p className="text-sm text-foreground/95">{explanation.summary}</p>
                            <div className="flex items-start gap-2 rounded-md bg-muted/40 p-2">
                                <Lightbulb className="h-4 w-4 text-amber-500/80 mt-0.5 shrink-0" />
                                <div className="text-xs">
                                    <span className="font-medium text-foreground/90">How to fix: </span>
                                    <span className="text-muted-foreground">{explanation.fix}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {parsed.lineCaret && (
                        <div className="rounded-lg border border-destructive/15 bg-muted/40 overflow-hidden">
                            <div className="px-3 py-1.5 border-b border-border/40 bg-muted/30">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Location</p>
                            </div>
                            <div className="px-3 py-2.5 font-mono text-xs text-foreground/90 overflow-x-auto">
                                <div>
                                    LINE {parsed.lineCaret.lineNumber}: {parsed.lineCaret.lineContent}
                                </div>
                                <div className="text-destructive whitespace-pre select-none">{parsed.lineCaret.caret}</div>
                            </div>
                        </div>
                    )}

                    {displaySql && (
                        <div className="rounded-lg border border-border/50 overflow-hidden bg-[var(--sql-bg)]">
                            <div className="px-3 py-1.5 border-b border-border/40 bg-muted/25 flex items-center justify-between gap-2">
                                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{displaySql.label}</span>
                            </div>
                            <pre className="p-3 text-xs leading-relaxed overflow-x-auto m-0">
                                <code dangerouslySetInnerHTML={{ __html: highlightedSql }} />
                            </pre>
                        </div>
                    )}

                    {(parsed.detail ||
                        parsed.hint ||
                        parsed.context ||
                        parsed.position ||
                        parsed.sqlState) && (
                    <div className="rounded-lg border border-border/40 bg-background/60 divide-y divide-border/30">
                        {parsed.detail && (
                            <div className="p-3">
                                <Section label="Detail" mono>
                                    {parsed.detail}
                                </Section>
                            </div>
                        )}
                        {parsed.hint && (
                            <div className="p-3">
                                <Section label="Hint" mono>
                                    {parsed.hint}
                                </Section>
                            </div>
                        )}
                        {parsed.context && (
                            <div className="p-3">
                                <Section label="Context" mono>
                                    {parsed.context}
                                </Section>
                            </div>
                        )}
                        {parsed.position && (
                            <div className="p-3">
                                <Section label="Position" mono>
                                    {parsed.position}
                                </Section>
                            </div>
                        )}
                        {parsed.sqlState && (
                            <div className="p-3 flex items-baseline gap-2 flex-wrap">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">SQL state</span>
                                <code className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted/80 text-foreground/90">{parsed.sqlState}</code>
                            </div>
                        )}
                    </div>
                    )}

                    {(aiExplanation || aiError) && (
                        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">AI analysis</p>
                            {aiError && <p className="text-xs text-destructive/90">{aiError}</p>}
                            {aiExplanation && (
                                <ScrollArea className="max-h-56 rounded-md border border-border/30 bg-background/90 p-3">
                                    <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-words font-sans">{aiExplanation}</pre>
                                </ScrollArea>
                            )}
                        </div>
                    )}

                    <div className="rounded-lg border border-border/30 overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setShowRawMessage((v) => !v)}
                            className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                        >
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${showRawMessage ? "rotate-180" : ""}`} />
                            {showRawMessage ? "Hide" : "Show"} full server message
                        </button>
                        {showRawMessage && (
                            <div className="px-3 pb-3 pt-0">
                                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground bg-muted/30 rounded-md p-3 max-h-48 overflow-y-auto border border-border/20">
                                    {message}
                                </pre>
                            </div>
                        )}
                    </div>
                    </div>
                </ScrollArea>
            </div>
        </div>
    );
}
