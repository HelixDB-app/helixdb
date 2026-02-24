"use client";

import { useState, useCallback, useRef, type ReactNode } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { generateSchema, chatAboutSchema, type GeneratedSchema } from "@/lib/schema-designer-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Sparkles,
    Send,
    Loader2,
    CheckCircle2,
    XCircle,
    Wand2,
    MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import type { SchemaDesignerTable, SchemaDesignerColumn } from "@/lib/types";

// ── Formatted chat message (markdown-like: headings, bold, code blocks) ─────

function ChatMessageContent({ content, isUser }: { content: string; isUser: boolean }) {
    if (isUser) {
        return <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{content}</p>;
    }
    const segments: ({ type: "code"; lang: string; text: string } | { type: "text"; text: string })[] = [];
    const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    let lastEnd = 0;
    let m;
    while ((m = codeBlockRe.exec(content)) !== null) {
        if (m.index > lastEnd) {
            segments.push({ type: "text", text: content.slice(lastEnd, m.index) });
        }
        segments.push({ type: "code", lang: m[1] || "text", text: m[2].trimEnd() });
        lastEnd = m.index + m[0].length;
    }
    if (lastEnd < content.length) {
        segments.push({ type: "text", text: content.slice(lastEnd) });
    }
    if (segments.length === 0) {
        segments.push({ type: "text", text: content });
    }

    return (
        <div className="space-y-3 text-xs leading-relaxed">
            {segments.map((seg, i) => {
                if (seg.type === "code") {
                    return (
                        <pre
                            key={i}
                            className="rounded-md border border-border/30 bg-muted/40 p-3 overflow-x-auto text-[11px] font-mono text-foreground/90"
                        >
                            <code className={seg.lang === "sql" ? "text-emerald-400/90" : ""}>
                                {seg.text}
                            </code>
                        </pre>
                    );
                }
                return (
                    <div key={i} className="space-y-2">
                        {seg.text.split(/\n\n+/).map((para, j) => {
                            const line = para.trim();
                            if (!line) return null;
                            if (line.startsWith("#### ")) {
                                return (
                                    <h4 key={j} className="font-medium text-foreground/90 mt-2 mb-0.5 text-[11px]">
                                        {formatInline(line.slice(5))}
                                    </h4>
                                );
                            }
                            if (line.startsWith("### ")) {
                                return (
                                    <h3 key={j} className="font-semibold text-foreground mt-3 mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                                        {formatInline(line.slice(4))}
                                    </h3>
                                );
                            }
                            if (line.startsWith("## ")) {
                                return (
                                    <h2 key={j} className="font-semibold text-foreground mt-3 mb-1">
                                        {formatInline(line.slice(3))}
                                    </h2>
                                );
                            }
                            if (line.startsWith("# ")) {
                                return (
                                    <h1 key={j} className="font-semibold text-foreground mt-3 mb-1 text-sm">
                                        {formatInline(line.slice(2))}
                                    </h1>
                                );
                            }
                            return (
                                <p key={j} className="text-muted-foreground/90 first:mt-0 whitespace-pre-wrap break-words">
                                    {formatInline(line)}
                                </p>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}

function formatInline(text: string): ReactNode {
    const parts: ReactNode[] = [];
    let remaining = text;
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let lastEnd = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > lastEnd) {
            parts.push(remaining.slice(lastEnd, m.index));
        }
        if (m[1] !== undefined) {
            parts.push(<strong key={m.index} className="font-semibold text-foreground">{m[1]}</strong>);
        } else if (m[2] !== undefined) {
            parts.push(
                <code key={m.index} className="px-1 py-0.5 rounded bg-muted/50 text-emerald-400/90 font-mono text-[11px]">
                    {m[2]}
                </code>
            );
        }
        lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) parts.push(remaining.slice(lastEnd));
    if (parts.length === 0) return text;
    return <>{parts}</>;
}

type PanelMode = "generate" | "chat";

function genId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function convertAIToTables(schema: GeneratedSchema, existingTables: SchemaDesignerTable[]): SchemaDesignerTable[] {
    // First pass: create tables with columns (no FK yet)
    const tableMap = new Map<string, SchemaDesignerTable>();
    const tables: SchemaDesignerTable[] = [];

    for (let i = 0; i < schema.tables.length; i++) {
        const aiTable = schema.tables[i];
        const tableId = genId();
        const columns: SchemaDesignerColumn[] = aiTable.columns.map(col => ({
            id: genId(),
            name: col.name,
            data_type: col.data_type.toUpperCase(),
            nullable: col.nullable,
            default_value: col.default_value,
            is_primary_key: col.is_primary_key,
            foreign_key: null, // Set in second pass
        }));

        const table: SchemaDesignerTable = {
            id: tableId,
            name: aiTable.name,
            columns,
            indexes: [],
            position: { x: 50 + (i % 4) * 280, y: 50 + Math.floor(i / 4) * 300 },
        };
        tableMap.set(aiTable.name, table);
        tables.push(table);
    }

    // Second pass: resolve foreign keys
    for (let i = 0; i < schema.tables.length; i++) {
        const aiTable = schema.tables[i];
        const table = tables[i];

        for (let j = 0; j < aiTable.columns.length; j++) {
            const aiCol = aiTable.columns[j];
            if (aiCol.foreign_key) {
                const targetTable = tableMap.get(aiCol.foreign_key.target_table);
                if (targetTable) {
                    const targetCol = targetTable.columns.find(c => c.name === aiCol.foreign_key!.target_column);
                    if (targetCol) {
                        table.columns[j].foreign_key = {
                            target_table_id: targetTable.id,
                            target_column_id: targetCol.id,
                        };
                    }
                }
            }
        }
    }

    return tables;
}

export function AISchemaPanel() {
    const {
        getActiveProject,
        setTables,
        isAiStreaming,
        setAiStreaming,
        aiStreamText,
        setAiStreamText,
    } = useSchemaDesignerStore();

    const project = getActiveProject();

    const [mode, setMode] = useState<PanelMode>("generate");
    const [appType, setAppType] = useState("");
    const [features, setFeatures] = useState("");
    const [scale, setScale] = useState("medium");
    const [projectDescription, setProjectDescription] = useState("");
    const [chatMessage, setChatMessage] = useState("");
    const [chatHistory, setChatHistory] = useState<{ role: "user" | "ai"; content: string }[]>([]);
    const [pendingSchema, setPendingSchema] = useState<GeneratedSchema | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    const handleGenerate = useCallback(async () => {
        if (!appType.trim() && !projectDescription.trim()) {
            toast.error("Enter an app type or describe your project");
            return;
        }

        abortRef.current = new AbortController();
        setAiStreaming(true);
        setAiStreamText("");
        setPendingSchema(null);
        let accumulated = "";

        try {
            const schema = await generateSchema(
                appType,
                features,
                scale,
                (chunk) => {
                    accumulated += chunk;
                    setAiStreamText(accumulated);
                },
                abortRef.current.signal,
                projectDescription
            );
            setPendingSchema(schema);
            toast.success(`Generated ${schema.tables.length} tables!`);
        } catch (err: any) {
            if (err.name !== "AbortError") {
                toast.error(err.message || "Failed to generate schema");
            }
        } finally {
            setAiStreaming(false);
        }
    }, [appType, features, scale, projectDescription, setAiStreaming, setAiStreamText]);

    const handleApplySchema = useCallback(() => {
        if (!pendingSchema || !project) return;
        const tables = convertAIToTables(pendingSchema, project.tables);
        setTables(tables);
        setPendingSchema(null);
        setAiStreamText("");
        toast.success("Schema applied!");
    }, [pendingSchema, project, setTables, setAiStreamText]);

    const handleChat = useCallback(async () => {
        if (!chatMessage.trim() || !project) return;

        const userMsg = chatMessage.trim();
        setChatMessage("");
        setChatHistory(prev => [...prev, { role: "user", content: userMsg }]);

        abortRef.current = new AbortController();
        setAiStreaming(true);
        let aiResponse = "";

        try {
            await chatAboutSchema(
                project.tables,
                userMsg,
                (chunk) => {
                    aiResponse += chunk;
                    setChatHistory(prev => {
                        const copy = [...prev];
                        const lastAi = copy.findIndex((m, i) => m.role === "ai" && i === copy.length - 1);
                        if (lastAi >= 0) {
                            copy[lastAi] = { role: "ai", content: aiResponse };
                        } else {
                            copy.push({ role: "ai", content: aiResponse });
                        }
                        return copy;
                    });
                },
                abortRef.current.signal
            );
        } catch (err: any) {
            if (err.name !== "AbortError") {
                setChatHistory(prev => [...prev, { role: "ai", content: `Error: ${err.message}` }]);
            }
        } finally {
            setAiStreaming(false);
            setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        }
    }, [chatMessage, project, setAiStreaming]);

    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        setAiStreaming(false);
    }, [setAiStreaming]);

    if (!project) return null;

    return (
        <div className="h-full flex flex-col border-l border-border/10">
            {/* Panel header */}
            <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2 shrink-0">
                <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-xs font-semibold text-foreground">AI Assistant</span>
                <div className="flex-1" />
                <div className="flex items-center rounded-md bg-muted/40 p-0.5">
                    <button
                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${mode === "generate" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                            }`}
                        onClick={() => setMode("generate")}
                    >
                        <Wand2 className="h-3 w-3 inline mr-1" />
                        Generate
                    </button>
                    <button
                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${mode === "chat" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                            }`}
                        onClick={() => setMode("chat")}
                    >
                        <MessageSquare className="h-3 w-3 inline mr-1" />
                        Chat
                    </button>
                </div>
            </div>

            {mode === "generate" ? (
                <>
                    {/* Generate Form */}
                    <div className="p-3 space-y-3 border-b border-border/10">
                        <div>
                            <label className="text-[10px] font-medium text-muted-foreground mb-1 block uppercase tracking-wider">
                                App Type
                            </label>
                            <Input
                                value={appType}
                                onChange={(e) => setAppType(e.target.value)}
                                placeholder="eCommerce, CRM, Social Network…"
                                className="bg-muted/30 text-xs h-8"
                                disabled={isAiStreaming}
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-medium text-muted-foreground mb-1 block uppercase tracking-wider">
                                Features
                            </label>
                            <Input
                                value={features}
                                onChange={(e) => setFeatures(e.target.value)}
                                placeholder="User auth, products, orders, payments…"
                                className="bg-muted/30 text-xs h-8"
                                disabled={isAiStreaming}
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-medium text-muted-foreground mb-1 block uppercase tracking-wider">
                                Scale
                            </label>
                            <select
                                value={scale}
                                onChange={(e) => setScale(e.target.value)}
                                className="w-full rounded-md border border-border/30 bg-muted/30 px-2 py-1.5 text-xs"
                                disabled={isAiStreaming}
                            >
                                <option value="small">Small (under 10K users)</option>
                                <option value="medium">Medium (10K–100K users)</option>
                                <option value="large">Large (100K–1M users)</option>
                                <option value="enterprise">Enterprise (1M+ users)</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-[10px] font-medium text-muted-foreground mb-1 block uppercase tracking-wider">
                                Project description
                            </label>
                            <textarea
                                value={projectDescription}
                                onChange={(e) => setProjectDescription(e.target.value)}
                                placeholder="Explain your project: goals, main entities, relationships, and any constraints. The more detail you provide, the better the generated schema."
                                className="w-full min-h-[88px] rounded-md border border-border/30 bg-muted/30 px-2.5 py-2 text-xs placeholder:text-muted-foreground/60 resize-y focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50 disabled:opacity-50"
                                disabled={isAiStreaming}
                                rows={4}
                            />
                            <p className="text-[10px] text-muted-foreground/70 mt-1">
                                Optional but recommended — helps AI understand context and produce a more accurate schema.
                            </p>
                        </div>
                        <Button
                            onClick={isAiStreaming ? handleStop : handleGenerate}
                            className={`w-full text-xs h-8 gap-1.5 ${isAiStreaming
                                ? "bg-red-600 hover:bg-red-700"
                                : "bg-emerald-600 hover:bg-emerald-700"
                                } text-white`}
                            disabled={!appType.trim() && !projectDescription.trim()}
                        >
                            {isAiStreaming ? (
                                <>
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    Stop
                                </>
                            ) : (
                                <>
                                    <Wand2 className="h-3 w-3" />
                                    Generate Schema
                                </>
                            )}
                        </Button>
                    </div>

                    {/* Stream Output / Result */}
                    <div className="flex-1 overflow-y-auto p-3">
                        {aiStreamText && (
                            <div className="space-y-3">
                                <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-all bg-muted/20 rounded-lg p-3 max-h-60 overflow-y-auto">
                                    {aiStreamText}
                                </pre>
                                {pendingSchema && (
                                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                        <div className="flex items-center gap-2 mb-2">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                            <span className="text-xs font-medium text-emerald-500">
                                                {pendingSchema.tables.length} tables ready
                                            </span>
                                        </div>
                                        <div className="space-y-1 mb-3">
                                            {pendingSchema.tables.map(t => (
                                                <div key={t.name} className="text-[10px] text-muted-foreground font-mono">
                                                    {t.name} ({t.columns.length} columns)
                                                </div>
                                            ))}
                                        </div>
                                        <div className="flex gap-2">
                                            <Button
                                                onClick={handleApplySchema}
                                                size="sm"
                                                className="text-xs h-7 bg-emerald-600 hover:bg-emerald-700 text-white"
                                            >
                                                <CheckCircle2 className="h-3 w-3 mr-1" />
                                                Apply Schema
                                            </Button>
                                            <Button
                                                onClick={() => { setPendingSchema(null); setAiStreamText(""); }}
                                                variant="outline"
                                                size="sm"
                                                className="text-xs h-7"
                                            >
                                                <XCircle className="h-3 w-3 mr-1" />
                                                Discard
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        {isAiStreaming && !aiStreamText && (
                            <div className="flex flex-col items-center justify-center h-full text-center py-8">
                                <Loader2 className="h-8 w-8 text-emerald-500/70 animate-spin mb-3" />
                                <p className="text-xs text-muted-foreground">
                                    Generating full schema…
                                </p>
                                <p className="text-[10px] text-muted-foreground/60 mt-1">
                                    Using a single request so the schema is not cut off.
                                </p>
                            </div>
                        )}
                        {!aiStreamText && !isAiStreaming && (
                            <div className="flex flex-col items-center justify-center h-full text-center">
                                <Wand2 className="h-8 w-8 text-muted-foreground/20 mb-3" />
                                <p className="text-xs text-muted-foreground/50">
                                    Use app type, features, and project description above. AI will generate a complete PostgreSQL schema from your context.
                                </p>
                            </div>
                        )}
                    </div>
                </>
            ) : (
                <>
                    {/* Chat messages */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-3">
                        {chatHistory.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-full text-center">
                                <MessageSquare className="h-8 w-8 text-muted-foreground/20 mb-3" />
                                <p className="text-xs text-muted-foreground/50">
                                    Ask AI about your schema — optimize, add tables, fix relationships…
                                </p>
                            </div>
                        )}
                        {chatHistory.map((msg, i) => (
                            <div
                                key={i}
                                className={`rounded-xl p-4 text-xs shadow-sm ${msg.role === "user"
                                    ? "bg-emerald-500/10 border border-emerald-500/20 ml-4 max-w-[90%]"
                                    : "bg-card/60 border border-border/20 mr-4 max-w-[95%]"
                                    }`}
                            >
                                <div className="flex items-center gap-2 mb-2.5">
                                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${msg.role === "user" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                                        {msg.role === "user" ? "You" : "AI"}
                                    </span>
                                </div>
                                <ChatMessageContent content={msg.content} isUser={msg.role === "user"} />
                            </div>
                        ))}
                        <div ref={chatEndRef} />
                    </div>

                    {/* Chat input */}
                    <div className="border-t border-border/20 p-3">
                        <div className="flex gap-2">
                            <Input
                                value={chatMessage}
                                onChange={(e) => setChatMessage(e.target.value)}
                                placeholder="Ask about your schema…"
                                className="bg-muted/30 text-xs h-8"
                                disabled={isAiStreaming}
                                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleChat()}
                            />
                            <Button
                                onClick={isAiStreaming ? handleStop : handleChat}
                                size="icon"
                                className={`h-8 w-8 shrink-0 ${isAiStreaming ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"} text-white`}
                                disabled={!chatMessage.trim() && !isAiStreaming}
                            >
                                {isAiStreaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                            </Button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
