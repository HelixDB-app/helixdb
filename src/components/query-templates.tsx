"use client";

import { useMemo, useState } from "react";
import { useQueryFilesStore, type SqlTemplate } from "@/stores/query-files-store";
import {
    ChevronRight,
    Layers,
    Loader2,
    Plus,
    Search,
    Sparkles,
    Trash2,
    Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { aiSuggestionEngine } from "@/lib/ai-suggestions";

const CATEGORY_COLORS: Record<string, string> = {
    Query: "text-sky-400 bg-sky-500/10 border-sky-500/20",
    DML: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    DDL: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    Performance: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    Custom: "text-rose-400 bg-rose-500/10 border-rose-500/20",
};

function getCategoryStyle(category: string): string {
    return CATEGORY_COLORS[category] ?? "text-muted-foreground bg-muted/20 border-border/20";
}

export interface QueryTemplatesProps {
    onUseTemplate: (sql: string, name: string) => void;
    schemaContext?: { tables: string[]; columns: Record<string, string[]> };
}

export function QueryTemplates({ onUseTemplate, schemaContext }: QueryTemplatesProps) {
    const { getAllTemplates, createTemplate, deleteTemplate } = useQueryFilesStore();
    const [search, setSearch] = useState("");
    const [activeCategory, setActiveCategory] = useState<string>("All");
    const [generating, setGenerating] = useState(false);
    const [aiPrompt, setAiPrompt] = useState("");
    const [showAiInput, setShowAiInput] = useState(false);

    const allTemplates = getAllTemplates();

    const categories = useMemo(() => {
        const cats = new Set(allTemplates.map((t) => t.category));
        return ["All", ...Array.from(cats)];
    }, [allTemplates]);

    const filtered = useMemo(() => {
        return allTemplates.filter((t) => {
            const matchesSearch =
                !search ||
                t.name.toLowerCase().includes(search.toLowerCase()) ||
                t.description.toLowerCase().includes(search.toLowerCase());
            const matchesCategory = activeCategory === "All" || t.category === activeCategory;
            return matchesSearch && matchesCategory;
        });
    }, [allTemplates, search, activeCategory]);

    const handleGenerateWithAI = async () => {
        if (!aiPrompt.trim()) return;
        setGenerating(true);
        try {
            const ctx = schemaContext ?? { tables: [], columns: {} };
            const sql = await aiSuggestionEngine.getNaturalLanguageSQL(aiPrompt, ctx);
            if (sql) {
                createTemplate(
                    aiPrompt.slice(0, 40),
                    `AI-generated: ${aiPrompt}`,
                    sql,
                    "Custom"
                );
                toast.success("Template created", { duration: 1500 });
                setAiPrompt("");
                setShowAiInput(false);
            } else {
                toast.error("AI couldn't generate SQL for this prompt", { duration: 2000 });
            }
        } catch {
            toast.error("AI generation failed", { duration: 2000 });
        } finally {
            setGenerating(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Search */}
            <div className="p-2 space-y-1.5 border-b border-border/20 shrink-0">
                <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search templates…"
                        className="w-full pl-6 pr-2 py-1.5 text-[11px] bg-muted/20 border border-border/20 rounded-md text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus:border-border/50 transition-colors"
                    />
                </div>

                {/* Category pills */}
                <div className="flex flex-wrap gap-1">
                    {categories.map((cat) => (
                        <button
                            key={cat}
                            onClick={() => setActiveCategory(cat)}
                            className={cn(
                                "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
                                activeCategory === cat
                                    ? cat === "All"
                                        ? "bg-primary/15 text-primary border-primary/30"
                                        : getCategoryStyle(cat)
                                    : "text-muted-foreground/50 border-transparent hover:border-border/30 hover:text-muted-foreground"
                            )}
                        >
                            {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* AI Generate */}
            <div className="px-2 py-1.5 border-b border-border/20 shrink-0">
                {showAiInput ? (
                    <div className="space-y-1.5">
                        <textarea
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder="Describe the SQL you need…"
                            className="w-full px-2 py-1.5 text-[11px] bg-muted/20 border border-border/20 rounded-md text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/50 transition-colors resize-none"
                            rows={2}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerateWithAI();
                                if (e.key === "Escape") setShowAiInput(false);
                            }}
                        />
                        <div className="flex gap-1.5">
                            <Button
                                size="sm"
                                className="flex-1 h-6 text-[10px] gap-1 bg-primary/90 hover:bg-primary text-primary-foreground"
                                onClick={handleGenerateWithAI}
                                disabled={!aiPrompt.trim() || generating}
                            >
                                {generating ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Sparkles className="h-3 w-3" />
                                )}
                                Generate
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[10px] px-2"
                                onClick={() => { setShowAiInput(false); setAiPrompt(""); }}
                            >
                                Cancel
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex gap-1">
                        <Button
                            size="sm"
                            variant="ghost"
                            className="flex-1 h-6 text-[10px] gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
                            onClick={() => setShowAiInput(true)}
                        >
                            <Sparkles className="h-3 w-3" />
                            AI Generate
                        </Button>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-muted-foreground hover:text-foreground"
                                    onClick={() => {
                                        const name = prompt("Template name:");
                                        if (!name?.trim()) return;
                                        createTemplate(name.trim(), "", "", "Custom");
                                        toast.success("Blank template created", { duration: 1200 });
                                    }}
                                >
                                    <Plus className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>New blank template</TooltipContent>
                        </Tooltip>
                    </div>
                )}
            </div>

            {/* Template list */}
            <ScrollArea className="flex-1 min-h-0">
                {filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                        <Layers className="h-7 w-7 text-muted-foreground/20 mb-2" />
                        <p className="text-xs text-muted-foreground/40">No templates found</p>
                    </div>
                ) : (
                    <div className="p-2 space-y-1">
                        {filtered.map((template) => (
                            <TemplateCard
                                key={template.id}
                                template={template}
                                onUse={() => onUseTemplate(template.sql, template.name)}
                                onDelete={template.isBuiltIn ? undefined : () => deleteTemplate(template.id)}
                            />
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}

function TemplateCard({
    template,
    onUse,
    onDelete,
}: {
    template: SqlTemplate;
    onUse: () => void;
    onDelete?: () => void;
}) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="group rounded-lg border border-border/20 bg-card/30 hover:bg-card/60 hover:border-border/40 transition-all overflow-hidden">
            <div
                className="flex items-start gap-2 px-3 py-2 cursor-pointer"
                onClick={() => setExpanded((v) => !v)}
            >
                <ChevronRight
                    className={cn(
                        "h-3.5 w-3.5 mt-0.5 text-muted-foreground/40 shrink-0 transition-transform",
                        expanded && "rotate-90"
                    )}
                />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium text-foreground/90 truncate">{template.name}</span>
                        <span
                            className={cn(
                                "text-[9px] px-1.5 py-0.5 rounded-full border font-medium shrink-0",
                                getCategoryStyle(template.category)
                            )}
                        >
                            {template.category}
                        </span>
                    </div>
                    {template.description && (
                        <p className="text-[10px] text-muted-foreground/50 truncate mt-0.5">{template.description}</p>
                    )}
                </div>
            </div>

            {expanded && (
                <div className="px-3 pb-3 space-y-2">
                    <pre className="text-[10px] font-mono text-foreground/70 bg-muted/20 rounded border border-border/20 p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-32">
                        {template.sql}
                    </pre>
                    <div className="flex gap-1.5">
                        <Button
                            size="sm"
                            className="flex-1 h-6 text-[10px] gap-1 bg-primary/90 hover:bg-primary text-primary-foreground"
                            onClick={(e) => { e.stopPropagation(); onUse(); }}
                        >
                            <Zap className="h-3 w-3" />
                            Use template
                        </Button>
                        {onDelete && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete template</TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
