"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useAIChatStore, type ChatMessage, type Conversation, type ChatContextItem } from "@/stores/ai-chat-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useQueryStore } from "@/stores/query-store";
import { useQueryFilesStore, type SqlFile } from "@/stores/query-files-store";
import { useIdeFsStore, type FsNode } from "@/stores/ide-fs-store";
import { useShallow } from "zustand/react/shallow";
import { GEMINI_MODELS, type GeminiModelId, type ImageAttachment } from "@/lib/ai-chat-engine";
import { getFeaturedTemplates } from "@/lib/ai-prompt-templates";
import { TemplateBrowserModal } from "@/components/ai-template-browser";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Sparkles, Send, Square, Plus, Trash2, Copy, Check, PlayCircle,
    RefreshCw, Pencil, ChevronDown, Database, AlertCircle, Zap,
    MessageSquare, X, PanelLeftClose, PanelLeftOpen, Clock, Search,
    Image as ImageIcon, Pin, PinOff, BookOpen, Paperclip, FileText,
    Layers, MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";

// ── Relative Time ────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
    if (m < 1) return "Just now";
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function groupByDate(convs: Conversation[]): { label: string; conversations: Conversation[] }[] {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t = today.getTime(), y = t - 864e5, w = t - 7 * 864e5, mo = t - 30 * 864e5;
    const g = [
        { label: "Pinned", conversations: [] as Conversation[] },
        { label: "Today", conversations: [] as Conversation[] },
        { label: "Yesterday", conversations: [] as Conversation[] },
        { label: "This Week", conversations: [] as Conversation[] },
        { label: "This Month", conversations: [] as Conversation[] },
        { label: "Older", conversations: [] as Conversation[] },
    ];
    for (const c of convs) {
        if (c.pinned) { g[0].conversations.push(c); continue; }
        const ts = c.updatedAt;
        if (ts >= t) g[1].conversations.push(c);
        else if (ts >= y) g[2].conversations.push(c);
        else if (ts >= w) g[3].conversations.push(c);
        else if (ts >= mo) g[4].conversations.push(c);
        else g[5].conversations.push(c);
    }
    return g.filter((gr) => gr.conversations.length > 0);
}

// ── Context Helpers ────────────────────────────────────────────────────────

const CONTEXT_TEXT_EXTS = new Set([
    "sql", "txt", "md", "json", "yaml", "yml", "csv", "log", "ts", "tsx", "js", "jsx", "py", "go", "rs", "java",
    "c", "cpp", "h", "hpp", "css", "scss", "html", "xml", "toml", "env",
]);

function getFileExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function inferLanguage(name: string): string {
    const ext = getFileExtension(name);
    if (!ext) return "text";
    if (ext === "sql") return "sql";
    if (ext === "md") return "markdown";
    if (ext === "yml" || ext === "yaml") return "yaml";
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "js" || ext === "jsx") return "javascript";
    if (ext === "py") return "python";
    if (ext === "rs") return "rust";
    if (ext === "go") return "go";
    if (ext === "java") return "java";
    if (ext === "cpp" || ext === "hpp" || ext === "cc") return "cpp";
    if (ext === "c" || ext === "h") return "c";
    if (ext === "json") return "json";
    if (ext === "toml") return "toml";
    if (ext === "css" || ext === "scss") return "css";
    if (ext === "html") return "html";
    if (ext === "xml") return "xml";
    if (ext === "csv") return "csv";
    return "text";
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
}

function formatLineRange(text: string): string {
    const lines = Math.max(1, text.split("\n").length);
    return lines === 1 ? " (1)" : ` (1-${lines})`;
}

// ── SQL Highlighting ─────────────────────────────────────────────────────────

const SQL_KW = new Set(["SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "ON", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS", "NULL", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN", "INDEX", "UNIQUE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CASCADE", "CONSTRAINT", "RETURNING", "WITH", "RECURSIVE", "UNION", "ALL", "EXCEPT", "INTERSECT", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "ASC", "DESC", "TRUE", "FALSE", "DEFAULT", "CHECK", "USING", "EXPLAIN", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE", "COALESCE", "NULLIF", "CAST", "OVER", "PARTITION", "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "COUNT", "SUM", "AVG", "MIN", "MAX", "ARRAY", "JSONB", "JSON"]);
const SQL_TY = new Set(["INTEGER", "INT", "BIGINT", "SMALLINT", "SERIAL", "BIGSERIAL", "TEXT", "VARCHAR", "CHAR", "CHARACTER", "BOOLEAN", "BOOL", "TIMESTAMP", "TIMESTAMPTZ", "DATE", "TIME", "INTERVAL", "NUMERIC", "DECIMAL", "FLOAT", "REAL", "DOUBLE", "PRECISION", "UUID", "BYTEA", "INET", "CIDR", "MACADDR", "MONEY", "VARYING"]);

function highlightSQL(sql: string): string {
    return sql
        .replace(/'([^']*)'/g, '<span class="sql-str">\'$1\'</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="sql-num">$1</span>')
        .replace(/\b([A-Z_]+)\b/g, (m) => SQL_KW.has(m) ? `<span class="sql-kw">${m}</span>` : SQL_TY.has(m) ? `<span class="sql-type">${m}</span>` : m)
        .replace(/--(.*?)$/gm, '<span class="sql-comment">--$1</span>');
}

// ── SQL Code Block ───────────────────────────────────────────────────────────

function SQLCodeBlock({ sql, onInsert }: { sql: string; onInsert: (s: string) => void }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="group relative rounded-lg border border-border bg-[var(--sql-bg)] overflow-hidden my-2">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted/20">
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">SQL</span>
                <div className="flex items-center gap-1">
                    <button onClick={async () => { await navigator.clipboard.writeText(sql); setCopied(true); toast.success("Copied"); setTimeout(() => setCopied(false), 2000); }}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all">
                        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
                    </button>
                    <button onClick={() => { onInsert(sql); toast.success("Inserted"); }} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-primary hover:bg-primary/10 transition-all">
                        <PlayCircle className="h-3 w-3" /> Insert
                    </button>
                </div>
            </div>
            <pre className="p-3 text-sm font-mono leading-relaxed overflow-x-auto"><code dangerouslySetInnerHTML={{ __html: highlightSQL(sql) }} /></pre>
        </div>
    );
}

// ── Message Content ──────────────────────────────────────────────────────────

function MessageContent({ content, onInsertSql }: { content: string; onInsertSql: (s: string) => void }) {
    const parts: { type: "text" | "sql"; content: string }[] = [];
    const re = /```sql\n([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = re.exec(content)) !== null) {
        if (m.index > last) parts.push({ type: "text", content: content.slice(last, m.index) });
        parts.push({ type: "sql", content: m[1].trim() });
        last = m.index + m[0].length;
    }
    if (last < content.length) parts.push({ type: "text", content: content.slice(last) });
    if (!parts.length) parts.push({ type: "text", content });

    return (
        <div className="space-y-1">
            {parts.map((p, i) => p.type === "sql"
                ? <SQLCodeBlock key={i} sql={p.content} onInsert={onInsertSql} />
                : <div key={i} className="text-sm leading-relaxed whitespace-pre-wrap prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: formatMd(p.content) }} />
            )}
        </div>
    );
}

function formatMd(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-muted text-primary text-xs font-mono">$1</code>');
}

// ── Chat Message Bubble ──────────────────────────────────────────────────────

function ChatMessageBubble({ message, onRegenerate, onEdit, onInsertSql, isLast }: {
    message: ChatMessage; onRegenerate?: () => void; onEdit?: (c: string) => void; onInsertSql: (s: string) => void; isLast: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [editVal, setEditVal] = useState(message.content);
    const editRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { if (editing && editRef.current) { editRef.current.focus(); editRef.current.setSelectionRange(editVal.length, editVal.length); } }, [editing]);

    if (message.role === "error") {
        return (
            <div className="flex gap-3 px-4 py-3 ai-message-in">
                <div className="shrink-0 mt-0.5"><div className="h-7 w-7 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center justify-center"><AlertCircle className="h-3.5 w-3.5 text-destructive" /></div></div>
                <div className="flex-1 min-w-0">
                    <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5"><p className="text-sm text-destructive">{message.content}</p></div>
                    {onRegenerate && <button onClick={onRegenerate} className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-foreground transition-colors"><RefreshCw className="h-3 w-3" /> Retry</button>}
                </div>
            </div>
        );
    }

    if (message.role === "user") {
        return (
            <div className="flex gap-3 px-4 py-3 group ai-message-in">
                <div className="shrink-0 mt-0.5"><div className="h-7 w-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center"><MessageSquare className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" /></div></div>
                <div className="flex-1 min-w-0">
                    {/* Context chips */}
                    {message.context && message.context.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {message.context.map((ctx) => {
                                const Icon = ctx.kind === "sql" ? Database : FileText;
                                return (
                                    <div key={ctx.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground/80">
                                        <Icon className="h-3 w-3" />
                                        <span className="truncate max-w-[160px]">{ctx.label}</span>
                                        {ctx.truncated && <span className="text-[9px] text-amber-500/80">truncated</span>}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {/* Image previews */}
                    {message.images && message.images.length > 0 && (
                        <div className="flex gap-2 mb-2 flex-wrap">
                            {message.images.map((img, i) => (
                                <div key={i} className="w-20 h-20 rounded-lg border border-border/20 overflow-hidden bg-muted/10">
                                    <img src={img.previewUrl} alt="Attached" className="w-full h-full object-cover" />
                                </div>
                            ))}
                        </div>
                    )}
                    {editing ? (
                        <div className="space-y-2">
                            <textarea ref={editRef} value={editVal} onChange={(e) => setEditVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (editVal.trim() && editVal.trim() !== message.content.trim()) onEdit?.(editVal.trim()); setEditing(false); } if (e.key === "Escape") { setEditVal(message.content); setEditing(false); } }}
                                className="w-full rounded-md border border-border/30 bg-muted/15 px-2.5 py-1.5 text-[13px] leading-snug resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500/35" rows={2} />
                            <div className="flex items-center gap-2">
                                <Button size="sm" onClick={() => { if (editVal.trim() && editVal.trim() !== message.content.trim()) onEdit?.(editVal.trim()); setEditing(false); }} className="h-6 px-2 text-xs bg-emerald-600 hover:bg-emerald-700">Save & Regenerate</Button>
                                <Button size="sm" variant="ghost" onClick={() => { setEditVal(message.content); setEditing(false); }} className="h-6 px-2 text-xs">Cancel</Button>
                            </div>
                        </div>
                    ) : (
                        <div className="relative">
                            <p className="text-sm leading-relaxed text-foreground/90">{message.content}</p>
                            {onEdit && <button onClick={() => setEditing(true)} className="absolute -right-1 -top-1 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted/50 text-muted-foreground/40 hover:text-foreground transition-all"><Pencil className="h-3 w-3" /></button>}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3 px-4 py-3 ai-message-in">
            <div className="shrink-0 mt-0.5"><div className="h-7 w-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center"><Sparkles className="h-3.5 w-3.5 text-primary" /></div></div>
            <div className="flex-1 min-w-0">
                {message.isStreaming && !message.content ? (
                    <div className="flex items-center gap-2 py-2">
                        <div className="flex gap-1">
                            <div className="h-1.5 w-1.5 rounded-full bg-primary ai-typing-dot" style={{ animationDelay: "0ms" }} />
                            <div className="h-1.5 w-1.5 rounded-full bg-primary ai-typing-dot" style={{ animationDelay: "150ms" }} />
                            <div className="h-1.5 w-1.5 rounded-full bg-primary ai-typing-dot" style={{ animationDelay: "300ms" }} />
                        </div>
                        <span className="text-xs text-muted-foreground/50">Generating...</span>
                    </div>
                ) : <MessageContent content={message.content} onInsertSql={onInsertSql} />}
                {!message.isStreaming && message.content && (
                    <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {onRegenerate && <button onClick={onRegenerate} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-all"><RefreshCw className="h-3 w-3" /> Regenerate</button>}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Model Selector ───────────────────────────────────────────────────────────

function ModelSelector({ model, onChange, disabled, compact }: { model: GeminiModelId; onChange: (m: GeminiModelId) => void; disabled: boolean; compact?: boolean }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => !disabled && setOpen(!open)}
                disabled={disabled}
                className={cn(
                    "flex items-center rounded-md border font-medium transition-colors bg-background/30 text-muted-foreground/75 hover:text-foreground hover:border-border/55",
                    compact ? "h-6 gap-0.5 border-border/35 px-1.5 text-[10px]" : "gap-1.5 border-border/30 px-2 py-1 text-xs",
                    disabled && "opacity-50 cursor-not-allowed"
                )}
            >
                <Zap className={cn("text-amber-600 dark:text-amber-400 shrink-0", compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
                <span className={cn(compact && "max-w-[5rem] truncate text-left")}>{GEMINI_MODELS[model].displayName}</span>
                <ChevronDown className={cn("opacity-50 shrink-0", compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border/40 bg-popover shadow-xl z-50 overflow-hidden">
                    {(Object.values(GEMINI_MODELS) as { id: GeminiModelId; displayName: string; description: string }[]).map((m) => (
                        <button key={m.id} onClick={() => { onChange(m.id); setOpen(false); }}
                            className={cn("w-full flex flex-col items-start px-3 py-2.5 text-left transition-colors", model === m.id ? "bg-primary/10 text-foreground" : "hover:bg-muted/50 text-muted-foreground")}>
                            <div className="flex items-center gap-2">{model === m.id && <Check className="h-3 w-3 text-primary" />}<span className="text-sm font-medium">{m.displayName}</span></div>
                            <span className="text-[10px] text-muted-foreground/50 mt-0.5 ml-5">{m.description}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── History Sidebar ──────────────────────────────────────────────────────────

function HistorySidebar({ conversations, activeId, onSelect, onDelete, onCreate, onClearAll, onTogglePin, collapsed, onToggle }: {
    conversations: Conversation[]; activeId: string | null; onSelect: (id: string) => void; onDelete: (id: string) => void; onCreate: () => void;
    onClearAll: () => void; onTogglePin: (id: string) => void; collapsed: boolean; onToggle: () => void;
}) {
    const [search, setSearch] = useState("");
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        if (!search.trim()) return conversations;
        const q = search.toLowerCase();
        return conversations.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
    }, [conversations, search]);

    const groups = useMemo(() => groupByDate(filtered), [filtered]);

    if (collapsed) {
        return (
            <div className="flex flex-col items-center py-2 w-10 border-r border-border/10 shrink-0 bg-card/5">
                <button onClick={onToggle} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/30 transition-all" title="Show history"><PanelLeftOpen className="h-4 w-4" /></button>
                <button onClick={onCreate} className="mt-3 p-1.5 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-all" title="New chat"><Plus className="h-3.5 w-3.5" /></button>
                <div className="mt-3 flex flex-col items-center gap-1 overflow-y-auto flex-1">
                    {conversations.slice(0, 12).map((c) => (
                        <button key={c.id} onClick={() => onSelect(c.id)}
                            className={cn("w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-semibold transition-all",
                                c.id === activeId ? "bg-primary/15 text-primary border border-primary/20" : "text-muted-foreground/30 hover:text-muted-foreground/60 hover:bg-muted/20"
                            )} title={c.title}>
                            {c.pinned ? <Pin className="h-2.5 w-2.5" /> : c.title.charAt(0).toUpperCase()}
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col w-64 border-r border-border/10 shrink-0 bg-card/5">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/10">
                <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground/40" />
                    <span className="text-xs font-semibold text-foreground/70">History</span>
                    <span className="text-[10px] text-muted-foreground/30 bg-muted/20 px-1.5 py-0.5 rounded-full">{conversations.length}</span>
                </div>
                <div className="flex items-center gap-0.5">
                    <button onClick={onCreate} className="p-1 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-all" title="New chat"><Plus className="h-3.5 w-3.5" /></button>
                    <button onClick={onToggle} className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/30 transition-all" title="Collapse"><PanelLeftClose className="h-3.5 w-3.5" /></button>
                </div>
            </div>
            {conversations.length > 3 && (
                <div className="px-2.5 py-2 border-b border-border/5">
                    <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/30" />
                        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats..." className="w-full h-7 rounded-md border border-border/20 bg-muted/10 pl-7 pr-2 text-xs text-foreground/80 placeholder:text-muted-foreground/25 focus:outline-none focus:ring-1 focus:ring-emerald-500/30" />
                        {search && <button onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/30 hover:text-foreground"><X className="h-3 w-3" /></button>}
                    </div>
                </div>
            )}
            <div className="flex-1 overflow-y-auto">
                {conversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full px-4 py-8">
                        <MessageSquare className="h-8 w-8 text-muted-foreground/15 mb-2" />
                        <p className="text-xs text-muted-foreground/30 text-center">No conversations yet</p>
                    </div>
                ) : (
                    <div className="py-1">
                        {groups.map((g) => (
                            <div key={g.label}>
                                <div className="px-3 py-1.5 mt-1"><span className="text-[10px] font-semibold text-muted-foreground/25 uppercase tracking-wider">{g.label}</span></div>
                                {g.conversations.map((c) => (
                                    <div key={c.id} className="relative" onMouseEnter={() => setHoveredId(c.id)} onMouseLeave={() => setHoveredId(null)}>
                                        <button onClick={() => onSelect(c.id)}
                                            className={cn("w-full flex flex-col items-start px-3 py-2 text-left transition-all rounded-md mx-1 hover:bg-muted/20",
                                                c.id === activeId ? "bg-primary/10 border-l-2 border-l-primary" : "border-l-2 border-l-transparent"
                                            )} style={{ width: "calc(100% - 8px)" }}>
                                            <div className="flex items-center gap-1.5 w-full">
                                                {c.pinned && <Pin className="h-2.5 w-2.5 text-amber-600/70 dark:text-amber-400/60 shrink-0" />}
                                                <span className={cn("text-xs font-medium truncate flex-1", c.id === activeId ? "text-foreground/90" : "text-foreground/60")}>{c.title}</span>
                                            </div>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-[10px] text-muted-foreground/25">{formatRelativeTime(c.updatedAt)}</span>
                                                <span className="text-[9px] text-muted-foreground/20">{c.messages.filter((m) => m.role === "user").length} msgs</span>
                                                <span className="text-[9px] text-muted-foreground/20 flex items-center gap-0.5"><Zap className="h-2.5 w-2.5" />{c.model === "gemini-2.5-pro" ? "Pro" : "Flash"}</span>
                                            </div>
                                        </button>
                                        {hoveredId === c.id && (
                                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                                <button onClick={(e) => { e.stopPropagation(); onTogglePin(c.id); }} className="p-1 rounded text-muted-foreground/30 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 transition-all" title={c.pinned ? "Unpin" : "Pin"}>
                                                    {c.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.title}"?`)) onDelete(c.id); }} className="p-1 rounded text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all" title="Delete"><Trash2 className="h-3 w-3" /></button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {conversations.length > 0 && (
                <div className="border-t border-border/10 px-3 py-2">
                    <button onClick={() => { if (confirm("Delete all conversations?")) onClearAll(); }} className="flex items-center gap-1.5 text-[10px] text-muted-foreground/25 hover:text-destructive transition-colors w-full"><Trash2 className="h-3 w-3" /> Clear all history</button>
                </div>
            )}
        </div>
    );
}

// ── Main Chat Panel ──────────────────────────────────────────────────────────

type CursorContextResult = {
    text: string;
    kind: "selection" | "statement" | "full";
    range?: { startLine: number; endLine: number };
};

export function AIChatPanel({
    variant = "full",
    getCursorContext,
    registerAddContextHandler,
}: {
    variant?: "full" | "sidebar";
    getCursorContext?: () => CursorContextResult | null;
    registerAddContextHandler?: (handler: (() => void) | null) => void;
}) {
    const {
        conversations, activeConversationId, isStreaming, schemaTableCount,
        createConversation, setActiveConversation, deleteConversation,
        sendMessage, regenerateResponse, editMessage, switchModel,
        stopStreaming, insertSqlToEditor, refreshSchema, clearAll,
        togglePinConversation, exportConversation,
    } = useAIChatStore();
    const { isConnected, connectionId } = useConnectionStore(useShallow((s) => ({
        isConnected: s.isConnected,
        connectionId: s.connectionId,
    })));
    const { tabs, activeTabId } = useQueryStore(useShallow((s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
    })));
    const { queryFiles, activeSqlFileId } = useQueryFilesStore(useShallow((s) => ({
        queryFiles: s.files,
        activeSqlFileId: s.activeFileId,
    })));
    const { ideNodes, getActiveWorkspaceFile } = useIdeFsStore(useShallow((s) => ({
        ideNodes: s.nodes,
        getActiveWorkspaceFile: s.getActiveFile,
    })));

    const activeConv = conversations.find((c) => c.id === activeConversationId);
    const messages = activeConv?.messages ?? [];

    const [inputValue, setInputValue] = useState("");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(variant === "sidebar");
    const [templateBrowserOpen, setTemplateBrowserOpen] = useState(false);
    const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
    const [contextItems, setContextItems] = useState<ChatContextItem[]>([]);
    const [contextSearch, setContextSearch] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const contextFileInputRef = useRef<HTMLInputElement>(null);
    const featured = useMemo(() => getFeaturedTemplates(), []);
    const isSidebar = variant === "sidebar";
    const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
    const activeSqlFile = useMemo(() => queryFiles.find((f) => f.id === activeSqlFileId) ?? null, [queryFiles, activeSqlFileId]);
    const activeWorkspaceFile = useMemo(() => {
        if (!connectionId) return null;
        const activeId = getActiveWorkspaceFile(connectionId);
        return activeId ? (ideNodes[activeId] ?? null) : null;
    }, [connectionId, getActiveWorkspaceFile, ideNodes]);

    const openTabs = useMemo(() => tabs.filter((t) => t.sql?.trim().length > 0), [tabs]);
    const workspaceFiles = useMemo(() => {
        if (!connectionId) return [] as FsNode[];
        return Object.values(ideNodes)
            .filter((n) => n.connectionId === connectionId && n.type === "file")
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [ideNodes, connectionId]);

    const normalizedSearch = contextSearch.trim().toLowerCase();
    const matchesSearch = useCallback((value: string) => {
        if (!normalizedSearch) return true;
        return value.toLowerCase().includes(normalizedSearch);
    }, [normalizedSearch]);

    const filteredTabs = useMemo(
        () => openTabs.filter((t) => matchesSearch(t.title)),
        [openTabs, matchesSearch]
    );
    const filteredSqlFiles = useMemo(
        () => queryFiles.filter((f) => matchesSearch(f.name)),
        [queryFiles, matchesSearch]
    );
    const filteredWorkspaceFiles = useMemo(
        () => workspaceFiles.filter((f) => matchesSearch(f.name)),
        [workspaceFiles, matchesSearch]
    );

    const contextStats = useMemo(() => {
        const totalChars = contextItems.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
        return { count: contextItems.length, totalChars };
    }, [contextItems]);
    const contextIdSet = useMemo(() => new Set(contextItems.map((item) => item.id)), [contextItems]);

    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, isStreaming]);
    useEffect(() => { if (isConnected) refreshSchema(); }, [isConnected, refreshSchema]);
    useEffect(() => {
        if (!inputRef.current) return;
        const max = isSidebar ? 72 : 96;
        inputRef.current.style.height = "auto";
        inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, max)}px`;
    }, [inputValue, isSidebar]);

    useEffect(() => {
        if (!isSidebar) return;
        const t = window.setTimeout(() => {
            const el = inputRef.current;
            if (el && !el.disabled) {
                el.focus({ preventScroll: true });
            }
        }, 0);
        return () => window.clearTimeout(t);
    }, [isSidebar]);

    const MAX_CONTEXT_FILE_BYTES = 300 * 1024;
    const MAX_CONTEXT_FILE_CHARS = 200_000;

    const upsertContextItem = useCallback((item: ChatContextItem) => {
        setContextItems((prev) => {
            const idx = prev.findIndex((p) => p.id === item.id);
            if (idx === -1) return [...prev, item];
            const next = [...prev];
            next[idx] = { ...prev[idx], ...item };
            return next;
        });
    }, []);

    const removeContextItem = useCallback((id: string) => {
        setContextItems((prev) => prev.filter((item) => item.id !== id));
    }, []);

    const normalizeContextContent = useCallback((content: string) => {
        const trimmed = content.trim();
        if (trimmed.length <= MAX_CONTEXT_FILE_CHARS) return { text: trimmed, truncated: false };
        return { text: trimmed.slice(0, MAX_CONTEXT_FILE_CHARS), truncated: true };
    }, []);

    const addActiveQueryContext = useCallback(() => {
        if (!activeTab?.sql?.trim()) { toast.error("No active query to attach"); return; }
        const cursorContext = getCursorContext?.();
        const content = cursorContext?.text?.trim() ? cursorContext.text : activeTab.sql;
        const rangeSuffix = cursorContext?.range
            ? ` (${cursorContext.range.startLine}-${cursorContext.range.endLine})`
            : "";
        const label = `${activeTab.title}${rangeSuffix}`;
        const { text, truncated } = normalizeContextContent(content);
        upsertContextItem({
            id: `tab:${activeTab.id}`,
            label,
            kind: "sql",
            content: text,
            language: "sql",
            source: activeTab.title,
            truncated,
        });
        if (cursorContext?.kind === "selection") {
            toast.success("Selection added to context");
        } else if (cursorContext?.kind === "statement") {
            toast.success("Cursor statement added to context");
        } else {
            toast.success("Active query added to context");
        }
    }, [activeTab, getCursorContext, normalizeContextContent, upsertContextItem]);

    useEffect(() => {
        registerAddContextHandler?.(addActiveQueryContext);
        return () => registerAddContextHandler?.(null);
    }, [addActiveQueryContext, registerAddContextHandler]);

    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            const key = e.key.toLowerCase();
            if ((e.metaKey || e.ctrlKey) && key === "j") {
                e.preventDefault();
                inputRef.current?.focus();
            }
            if ((e.metaKey || e.ctrlKey) && key === "l") {
                e.preventDefault();
                addActiveQueryContext();
            }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [addActiveQueryContext]);

    const addTabContext = useCallback((tabId: string, title: string, sql: string) => {
        if (!sql.trim()) { toast.warning(`"${title}" is empty`); return; }
        const { text, truncated } = normalizeContextContent(sql);
        const rangeSuffix = formatLineRange(text);
        upsertContextItem({
            id: `tab:${tabId}`,
            label: `${title}${rangeSuffix}`,
            kind: "sql",
            content: text,
            language: "sql",
            source: title,
            truncated,
        });
    }, [normalizeContextContent, upsertContextItem]);

    const addSqlFileContext = useCallback((file: SqlFile) => {
        if (!file.sql.trim()) { toast.warning(`"${file.name}" is empty`); return; }
        const { text, truncated } = normalizeContextContent(file.sql);
        const rangeSuffix = formatLineRange(text);
        upsertContextItem({
            id: `sqlfile:${file.id}`,
            label: `${file.name}${rangeSuffix}`,
            kind: "sql",
            content: text,
            language: "sql",
            source: file.name,
            truncated,
        });
    }, [normalizeContextContent, upsertContextItem]);

    const addWorkspaceFileContext = useCallback((file: FsNode) => {
        if (!file.content.trim()) { toast.warning(`"${file.name}" is empty`); return; }
        const { text, truncated } = normalizeContextContent(file.content);
        const rangeSuffix = formatLineRange(text);
        upsertContextItem({
            id: `wsfile:${file.id}`,
            label: `${file.name}${rangeSuffix}`,
            kind: "file",
            content: text,
            language: inferLanguage(file.name),
            source: file.name,
            truncated,
        });
    }, [normalizeContextContent, upsertContextItem]);

    const handleAddAllSqlFiles = useCallback(() => {
        if (queryFiles.length === 0) { toast.error("No SQL files available"); return; }
        queryFiles.forEach((file) => {
            if (!file.sql.trim()) return;
            const { text, truncated } = normalizeContextContent(file.sql);
            const rangeSuffix = formatLineRange(text);
            upsertContextItem({
                id: `sqlfile:${file.id}`,
                label: `${file.name}${rangeSuffix}`,
                kind: "sql",
                content: text,
                language: "sql",
                source: file.name,
                truncated,
            });
        });
        toast.success("SQL files added to context");
    }, [normalizeContextContent, queryFiles, upsertContextItem]);

    const handleAddAllOpenTabs = useCallback(() => {
        if (openTabs.length === 0) { toast.error("No open query tabs"); return; }
        openTabs.forEach((tab) => {
            if (!tab.sql.trim()) return;
            const { text, truncated } = normalizeContextContent(tab.sql);
            const rangeSuffix = formatLineRange(text);
            upsertContextItem({
                id: `tab:${tab.id}`,
                label: `${tab.title}${rangeSuffix}`,
                kind: "sql",
                content: text,
                language: "sql",
                source: tab.title,
                truncated,
            });
        });
        toast.success("Open tabs added to context");
    }, [normalizeContextContent, openTabs, upsertContextItem]);

    const handleContextFileUpload = useCallback((files: File[] | FileList | null) => {
        if (!files) return;
        Array.from(files).forEach((file) => {
            const ext = getFileExtension(file.name);
            const isTextType = file.type.startsWith("text/") || CONTEXT_TEXT_EXTS.has(ext);
            if (!isTextType) { toast.error(`Unsupported file: ${file.name}`); return; }
            if (file.size > MAX_CONTEXT_FILE_BYTES) { toast.error(`"${file.name}" exceeds ${formatBytes(MAX_CONTEXT_FILE_BYTES)}`); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const content = String(reader.result ?? "");
                if (!content.trim()) { toast.warning(`"${file.name}" is empty`); return; }
                const { text, truncated } = normalizeContextContent(content);
                const rangeSuffix = formatLineRange(text);
                upsertContextItem({
                    id: `upload:${file.name}:${Date.now()}`,
                    label: `${file.name}${rangeSuffix}`,
                    kind: "file",
                    content: text,
                    language: inferLanguage(file.name),
                    source: file.name,
                    truncated,
                });
                toast.success(`Added ${file.name} to context`);
            };
            reader.readAsText(file);
        });
    }, [normalizeContextContent, upsertContextItem]);

    const hasContext = useMemo(
        () => contextItems.some((item) => item.content && item.content.trim()),
        [contextItems]
    );

    const handleSend = useCallback(async () => {
        let content = inputValue.trim();
        if (!content && hasContext) {
            content = "Analyze the attached context and respond with clear, actionable guidance.";
        }
        if (!content || isStreaming) return;
        setInputValue("");
        const imgs = pendingImages.length > 0 ? [...pendingImages] : undefined;
        setPendingImages([]);
        await sendMessage(content, imgs, contextItems);
    }, [contextItems, hasContext, inputValue, isStreaming, sendMessage, pendingImages]);

    const handleImageUpload = useCallback((files: FileList | null) => {
        if (!files) return;
        Array.from(files).forEach((file) => {
            if (!file.type.startsWith("image/")) return;
            if (file.size > 10 * 1024 * 1024) { toast.error("Image must be under 10MB"); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(",")[1];
                setPendingImages((prev) => [...prev, { mimeType: file.type, base64, previewUrl: result }]);
            };
            reader.readAsDataURL(file);
        });
    }, []);

    const handlePaste = useCallback((e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
            if (item.type.startsWith("image/")) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) handleImageUpload(new DataTransfer().files.length ? null : (() => { const dt = new DataTransfer(); dt.items.add(file); return dt.files; })());
            }
        }
    }, [handleImageUpload]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files ?? []);
        const imageFiles = files.filter((f) => f.type.startsWith("image/"));
        const textFiles = files.filter((f) => !f.type.startsWith("image/"));
        if (imageFiles.length > 0) {
            const dt = new DataTransfer();
            imageFiles.forEach((f) => dt.items.add(f));
            handleImageUpload(dt.files);
        }
        if (textFiles.length > 0) {
            handleContextFileUpload(textFiles);
        }
    }, [handleContextFileUpload, handleImageUpload]);

    const handleExport = useCallback(() => {
        if (!activeConversationId) return;
        const md = exportConversation(activeConversationId);
        navigator.clipboard.writeText(md);
        toast.success("Conversation exported to clipboard as Markdown");
    }, [activeConversationId, exportConversation]);

    const canSend = Boolean(inputValue.trim() || pendingImages.length > 0 || hasContext);

    return (
        <div className="flex h-full bg-background">
            <HistorySidebar conversations={conversations} activeId={activeConversationId}
                onSelect={setActiveConversation} onDelete={deleteConversation} onCreate={() => createConversation()}
                onClearAll={clearAll} onTogglePin={togglePinConversation} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />

            <div className="flex flex-col flex-1 min-w-0">
                {/* Header — single dense row, title detail in tooltip */}
                <div
                    className={cn(
                        "flex items-center gap-2 border-b border-border/25 shrink-0",
                        isSidebar ? "px-2.5 py-1.5" : "px-3 py-2"
                    )}
                >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 ring-1 ring-primary/15">
                        <Sparkles className="h-3 w-3 text-primary" aria-hidden />
                    </div>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="min-w-0 flex-1 text-left">
                                <h2
                                    className={cn(
                                        "font-semibold text-foreground/90 truncate leading-tight",
                                        isSidebar ? "text-[11px]" : "text-xs"
                                    )}
                                >
                                    {activeConv ? activeConv.title : "Nova AI"}
                                </h2>
                                {activeConv && !isSidebar && (
                                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground/45 leading-tight">
                                        {activeConv.messages.filter((m) => m.role === "user").length} messages · {formatRelativeTime(activeConv.updatedAt)}
                                    </p>
                                )}
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="start" className="max-w-[min(280px,70vw)]">
                            <p className="text-xs font-medium">{activeConv ? activeConv.title : "Nova AI"}</p>
                            {activeConv ? (
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                    {activeConv.messages.filter((m) => m.role === "user").length} messages · {formatRelativeTime(activeConv.updatedAt)}
                                </p>
                            ) : (
                                <p className="mt-1 text-[10px] text-muted-foreground">SQL and schema assistant</p>
                            )}
                        </TooltipContent>
                    </Tooltip>
                    <div className="flex shrink-0 items-center gap-0.5">
                        {activeConv && (
                            <ModelSelector
                                model={activeConv.model}
                                onChange={switchModel}
                                disabled={isStreaming}
                                compact={isSidebar}
                            />
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn("p-0 text-muted-foreground/45 hover:text-foreground", isSidebar ? "h-6 w-6" : "h-7 w-7")}
                                    title="More options"
                                >
                                    <MoreHorizontal className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem onClick={() => setSidebarCollapsed((v) => !v)}>
                                    {sidebarCollapsed ? "Show history" : "Hide history"}
                                </DropdownMenuItem>
                                {activeConv && (
                                    <DropdownMenuItem onClick={handleExport}>
                                        Export Markdown
                                    </DropdownMenuItem>
                                )}
                                {activeConv && (
                                    <DropdownMenuItem onClick={() => { if (confirm(`Delete "${activeConv.title}"?`)) deleteConversation(activeConv.id); }}>
                                        Delete conversation
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => { if (confirm("Clear all conversations?")) clearAll(); }}>
                                    Clear all history
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={cn("p-0 text-muted-foreground/45 hover:text-foreground", isSidebar ? "h-6 w-6" : "h-7 w-7")}
                            onClick={() => createConversation()}
                            title="New chat"
                        >
                            <Plus className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                        </Button>
                    </div>
                </div>

                {/* Messages */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto">
                    {messages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full px-6 py-8">
                            <div className="h-16 w-16 rounded-2xl bg-primary/10 border border-primary/10 flex items-center justify-center mb-4"><Sparkles className="h-7 w-7 text-primary/70" /></div>
                            <h3 className="text-lg font-semibold text-foreground/80 mb-1">Ask Nova anything</h3>
                            <p className="text-xs text-muted-foreground/50 text-center max-w-[280px] mb-6">Generate SQL queries, analyze your schema, optimize performance, and more.</p>
                            <div className={cn("grid gap-2 max-w-md w-full", isSidebar ? "grid-cols-1" : "grid-cols-2")}>
                                {featured.map((t) => (
                                    <button key={t.id} onClick={() => { setInputValue(t.prompt); setTimeout(() => sendMessage(t.prompt, undefined, contextItems), 50); }} disabled={isStreaming}
                                        className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-border/20 bg-card/30 hover:bg-card/60 hover:border-border/40 transition-all text-left group">
                                        <span className="text-sm shrink-0 mt-0.5">{t.icon}</span>
                                        <span className="text-xs text-muted-foreground/70 group-hover:text-foreground/80 leading-relaxed">{t.title}</span>
                                    </button>
                                ))}
                            </div>
                            <button onClick={() => setTemplateBrowserOpen(true)} className="mt-4 flex items-center gap-1.5 text-xs text-primary hover:underline transition-colors">
                                <BookOpen className="h-3.5 w-3.5" /> Browse all {40}+ prompt templates
                            </button>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/10">
                            {messages.map((msg, idx) => (
                                <ChatMessageBubble key={msg.id} message={msg} onInsertSql={insertSqlToEditor} isLast={idx === messages.length - 1}
                                    onRegenerate={msg.role === "assistant" || msg.role === "error" ? () => regenerateResponse(msg.id) : undefined}
                                    onEdit={msg.role === "user" ? (c) => editMessage(msg.id, c) : undefined} />
                            ))}
                        </div>
                    )}
                </div>

                {/* Input Area */}
                <div className="shrink-0 border-t border-border/20 bg-muted/5 dark:bg-card/25" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
                    {pendingImages.length > 0 && (
                        <div className="px-2.5 pt-2">
                            <div className="flex gap-2 flex-wrap">
                                {pendingImages.map((img, i) => (
                                    <div key={i} className="relative w-16 h-16 rounded-lg border border-border/30 overflow-hidden bg-muted/10">
                                        <img src={img.previewUrl} alt="Upload" className="w-full h-full object-cover" />
                                        <button onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}
                                            className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"><X className="h-3 w-3" /></button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className={cn("px-2.5 sm:px-3", "pb-1.5 pt-1.5")}>
                        {contextItems.length > 0 && (
                            <div className="mb-1.5 flex flex-wrap gap-1">
                                {contextItems.map((item) => {
                                    const Icon = item.kind === "sql" ? Database : FileText;
                                    return (
                                        <div
                                            key={item.id}
                                            className="group flex max-w-full items-center gap-1 rounded-md border border-border/35 bg-muted/15 px-1.5 py-0.5 text-[10px] text-muted-foreground/80"
                                        >
                                            <Icon className="h-2.5 w-2.5 shrink-0" />
                                            <span className={cn("truncate", isSidebar ? "max-w-[7rem]" : "max-w-[200px]")}>{item.label}</span>
                                            {item.truncated && (
                                                <span className="shrink-0 text-[9px] text-amber-500/75">trunc.</span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => removeContextItem(item.id)}
                                                className="ml-0.5 rounded p-0.5 text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground"
                                                aria-label="Remove context"
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div className="rounded-lg border border-border/50 bg-background/90 shadow-sm transition-[border-color,box-shadow] focus-within:border-primary/35 focus-within:ring-1 focus-within:ring-primary/12 dark:bg-background/50">
                            <textarea
                                ref={inputRef}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onPaste={handlePaste}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSend();
                                    }
                                }}
                                placeholder={isSidebar ? "Message…  ⌘L = editor query" : "Ask about schema, SQL, or data…"}
                                rows={1}
                                disabled={isStreaming}
                                className={cn(
                                    "w-full resize-none border-0 bg-transparent focus:outline-none placeholder:text-muted-foreground/35 disabled:opacity-50",
                                    isSidebar
                                        ? "min-h-[34px] max-h-[72px] px-2.5 py-2 text-xs leading-relaxed"
                                        : "min-h-[40px] max-h-[96px] px-3 py-2 text-[13px] leading-snug"
                                )}
                            />
                            <div className="flex items-center gap-0.5 border-t border-border/30 px-1 py-0.5">
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(
                                                "flex shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground",
                                                isSidebar ? "h-6 w-6" : "h-7 w-7"
                                            )}
                                            title="Attach context"
                                        >
                                            <Layers className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                                        </button>
                                    </PopoverTrigger>
                                    <PopoverContent align="start" className="w-96 p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-semibold text-foreground/80">Context</span>
                                        <button onClick={() => setContextItems([])} className="text-[10px] text-muted-foreground/60 hover:text-foreground">Clear</button>
                                    </div>
                                    <div className="mt-2 grid grid-cols-2 gap-2">
                                        <Button size="sm" variant="outline" className="h-7 text-[11px] justify-between" onClick={addActiveQueryContext} disabled={!activeTab?.sql?.trim()}>
                                            <span>Active Query</span>
                                            <kbd className="ml-2 inline-flex h-4 items-center rounded border border-border/30 bg-muted/20 px-1 font-mono text-[9px]">⌘L</kbd>
                                        </Button>
                                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => activeSqlFile && addSqlFileContext(activeSqlFile)} disabled={!activeSqlFile}>
                                            Active SQL File
                                        </Button>
                                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => activeWorkspaceFile && addWorkspaceFileContext(activeWorkspaceFile)} disabled={!activeWorkspaceFile}>
                                            Active Workspace File
                                        </Button>
                                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handleAddAllSqlFiles} disabled={queryFiles.length === 0}>
                                            All SQL Files
                                        </Button>
                                    </div>
                                    <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-[11px]" onClick={handleAddAllOpenTabs} disabled={openTabs.length === 0}>
                                        All Open Tabs
                                    </Button>
                                    <Separator className="my-2" />
                                    <Input
                                        value={contextSearch}
                                        onChange={(e) => setContextSearch(e.target.value)}
                                        placeholder="Search tabs or files..."
                                        className="h-7 text-xs"
                                    />
                                    {filteredTabs.length > 0 && (
                                        <div className="mt-2">
                                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-1">Open tabs</p>
                                            <ScrollArea className="h-20 pr-2">
                                                <div className="space-y-1">
                                                    {filteredTabs.slice(0, 8).map((tab) => {
                                                        const id = `tab:${tab.id}`;
                                                        const selected = contextIdSet.has(id);
                                                        return (
                                                            <button
                                                                key={tab.id}
                                                                onClick={() => addTabContext(tab.id, tab.title, tab.sql)}
                                                                className={cn(
                                                                    "w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs transition-colors",
                                                                    selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-muted-foreground/80"
                                                                )}
                                                            >
                                                                <FileText className="h-3 w-3" />
                                                                <span className="truncate flex-1">{tab.title}</span>
                                                                {selected && <Check className="h-3 w-3 text-primary" />}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </ScrollArea>
                                        </div>
                                    )}
                                    {filteredSqlFiles.length > 0 && (
                                        <div className="mt-2">
                                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-1">SQL files</p>
                                            <ScrollArea className="h-20 pr-2">
                                                <div className="space-y-1">
                                                    {filteredSqlFiles.slice(0, 8).map((file) => {
                                                        const id = `sqlfile:${file.id}`;
                                                        const selected = contextIdSet.has(id);
                                                        return (
                                                            <button
                                                                key={file.id}
                                                                onClick={() => addSqlFileContext(file)}
                                                                className={cn(
                                                                    "w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs transition-colors",
                                                                    selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-muted-foreground/80"
                                                                )}
                                                            >
                                                                <FileText className="h-3 w-3" />
                                                                <span className="truncate flex-1">{file.name}</span>
                                                                {selected && <Check className="h-3 w-3 text-primary" />}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </ScrollArea>
                                        </div>
                                    )}
                                    {filteredWorkspaceFiles.length > 0 && (
                                        <div className="mt-2">
                                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-1">Workspace files</p>
                                            <ScrollArea className="h-24 pr-2">
                                                <div className="space-y-1">
                                                    {filteredWorkspaceFiles.slice(0, 8).map((file) => {
                                                        const id = `wsfile:${file.id}`;
                                                        const selected = contextIdSet.has(id);
                                                        return (
                                                            <button
                                                                key={file.id}
                                                                onClick={() => addWorkspaceFileContext(file)}
                                                                className={cn(
                                                                    "w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs transition-colors",
                                                                    selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-muted-foreground/80"
                                                                )}
                                                            >
                                                                <FileText className="h-3 w-3" />
                                                                <span className="truncate flex-1">{file.name}</span>
                                                                {selected && <Check className="h-3 w-3 text-primary" />}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </ScrollArea>
                                        </div>
                                    )}
                                    </PopoverContent>
                                </Popover>
                            <button
                                type="button"
                                onClick={() => contextFileInputRef.current?.click()}
                                className={cn(
                                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground",
                                    isSidebar ? "h-6 w-6" : "h-7 w-7"
                                )}
                                title="Attach file"
                            >
                                <Paperclip className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                            </button>
                            <input
                                ref={contextFileInputRef}
                                type="file"
                                accept=".sql,.txt,.md,.json,.yaml,.yml,.csv,.log,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.hpp,.css,.scss,.html,.xml,.toml,.env,text/*"
                                multiple
                                className="hidden"
                                onChange={(e) => { handleContextFileUpload(e.target.files); e.target.value = ""; }}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className={cn(
                                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground",
                                    isSidebar ? "h-6 w-6" : "h-7 w-7"
                                )}
                                title="Attach image"
                            >
                                <ImageIcon className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                            </button>
                            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleImageUpload(e.target.files); e.target.value = ""; }} />
                            <button
                                type="button"
                                onClick={() => setTemplateBrowserOpen(true)}
                                className={cn(
                                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/55 hover:text-primary",
                                    isSidebar ? "h-6 w-6" : "h-7 w-7"
                                )}
                                title="Prompt templates"
                            >
                                <BookOpen className={cn(isSidebar ? "h-3 w-3" : "h-3.5 w-3.5")} />
                            </button>
                            <div className="min-w-2 flex-1" />
                            {isStreaming ? (
                                <Button size="sm" variant="ghost" onClick={stopStreaming} className={cn("p-0 shrink-0 text-destructive hover:bg-destructive/10", isSidebar ? "h-6 w-6" : "h-7 w-7")}><Square className={cn(isSidebar ? "h-3 w-3" : "h-4 w-4")} /></Button>
                            ) : (
                                <Button size="sm" onClick={handleSend} disabled={!canSend}
                                    className={cn("p-0 shrink-0 transition-all", isSidebar ? "h-6 w-6" : "h-7 w-7", canSend ? "bg-primary hover:bg-primary/90 text-primary-foreground" : "bg-muted/30 text-muted-foreground/30")}>
                                    <Send className={cn(isSidebar ? "h-3 w-3" : "h-4 w-4")} />
                                </Button>
                            )}
                            </div>
                        </div>
                        {contextStats.count > 0 && (
                            <div className="mt-1 flex items-center gap-2 px-0.5 text-[9px] text-muted-foreground/45">
                                <Layers className="h-2.5 w-2.5 shrink-0" />
                                <span>{contextStats.count} attached · {contextStats.totalChars.toLocaleString()} chars</span>
                                <button type="button" onClick={() => setContextItems([])} className="ml-auto hover:text-foreground">
                                    Clear
                                </button>
                            </div>
                        )}
                    </div>
                    <div
                        className={cn(
                            "flex items-center justify-between gap-2 border-t border-border/10 text-muted-foreground/40",
                            isSidebar ? "px-2.5 py-1 text-[9px]" : "px-3 py-1.5 text-[10px]"
                        )}
                    >
                        {isConnected ? (
                            <span className="flex min-w-0 items-center gap-1 truncate">
                                <Database className="h-2.5 w-2.5 shrink-0 opacity-60" />
                                <span className="truncate">{schemaTableCount} tables</span>
                            </span>
                        ) : (
                            <span />
                        )}
                        <span className="flex shrink-0 items-center gap-1.5">
                            <span className={cn("hidden text-muted-foreground/30", !isSidebar && "sm:inline")}>Drop files</span>
                            <kbd className="inline-flex h-3.5 min-w-0 items-center rounded border border-border/25 bg-muted/25 px-1 font-mono text-[9px] leading-none">
                                ⌘J
                            </kbd>
                            <kbd className="inline-flex h-3.5 min-w-0 items-center rounded border border-border/25 bg-muted/25 px-1 font-mono text-[9px] leading-none">
                                ⌘L
                            </kbd>
                        </span>
                    </div>
                </div>
            </div>

            <TemplateBrowserModal open={templateBrowserOpen} onClose={() => setTemplateBrowserOpen(false)} onSelect={(prompt) => { setInputValue(prompt); inputRef.current?.focus(); }} />
        </div>
    );
}
