"use client";

import { useState, useMemo } from "react";
import { useAIChatStore } from "@/stores/ai-chat-store";
import { DEFAULT_TEMPLATES, TEMPLATE_CATEGORIES, getFeaturedTemplates, type PromptTemplate } from "@/lib/ai-prompt-templates";
import { cn } from "@/lib/utils";
import {
    Search, X, Plus, Trash2, Sparkles, BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Template Browser Modal ───────────────────────────────────────────────────

export function TemplateBrowserModal({
    open,
    onClose,
    onSelect,
}: {
    open: boolean;
    onClose: () => void;
    onSelect: (prompt: string) => void;
}) {
    const { customTemplates, addCustomTemplate, deleteCustomTemplate } = useAIChatStore();
    const [search, setSearch] = useState("");
    const [activeCategory, setActiveCategory] = useState("all");
    const [showCreate, setShowCreate] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    const [newPrompt, setNewPrompt] = useState("");
    const [newCategory, setNewCategory] = useState("query");
    const [newIcon, setNewIcon] = useState("✨");

    const allTemplates = useMemo(() => [...DEFAULT_TEMPLATES, ...customTemplates], [customTemplates]);

    const filtered = useMemo(() => {
        let items = allTemplates;
        if (activeCategory !== "all") {
            items = items.filter((t) => t.category === activeCategory);
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            items = items.filter(
                (t) => t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
            );
        }
        return items;
    }, [allTemplates, activeCategory, search]);

    const handleCreate = () => {
        if (!newTitle.trim() || !newPrompt.trim()) return;
        addCustomTemplate({ title: newTitle.trim(), prompt: newPrompt.trim(), category: newCategory, icon: newIcon });
        setNewTitle(""); setNewPrompt(""); setShowCreate(false);
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div className="w-[720px] max-h-[80vh] rounded-xl border border-border/30 bg-popover shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-border/20">
                    <div className="flex items-center gap-2.5">
                        <BookOpen className="h-5 w-5 text-emerald-400" />
                        <h2 className="text-base font-semibold text-foreground">Prompt Templates</h2>
                        <span className="text-xs text-muted-foreground/40 bg-muted/20 px-2 py-0.5 rounded-full">{allTemplates.length}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setShowCreate(!showCreate)} className="h-7 text-xs gap-1.5 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10">
                            <Plus className="h-3 w-3" /> Create
                        </Button>
                        <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Create Template Form */}
                {showCreate && (
                    <div className="px-5 py-3 border-b border-border/10 bg-emerald-500/3 space-y-2.5">
                        <div className="flex gap-2">
                            <select value={newIcon} onChange={(e) => setNewIcon(e.target.value)} className="h-8 w-16 rounded-md border border-border/30 bg-muted/20 px-2 text-sm">
                                {["✨", "📊", "🔍", "⚡", "🔗", "📝", "🛡️", "🐛", "🚀", "📋", "🔒", "📈"].map((e) => (
                                    <option key={e} value={e}>{e}</option>
                                ))}
                            </select>
                            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Template name" className="flex-1 h-8 rounded-md border border-border/30 bg-muted/20 px-3 text-sm placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                            <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="h-8 w-32 rounded-md border border-border/30 bg-muted/20 px-2 text-xs">
                                {TEMPLATE_CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                                    <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                            </select>
                        </div>
                        <textarea value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder="Write your prompt template..." rows={3} className="w-full rounded-md border border-border/30 bg-muted/20 px-3 py-2 text-sm resize-none placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                        <div className="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)} className="h-7 text-xs">Cancel</Button>
                            <Button size="sm" onClick={handleCreate} disabled={!newTitle.trim() || !newPrompt.trim()} className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">Save Template</Button>
                        </div>
                    </div>
                )}

                {/* Search + Categories */}
                <div className="px-5 py-3 border-b border-border/10 space-y-2.5">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
                        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..." className="w-full h-8 rounded-md border border-border/30 bg-muted/10 pl-9 pr-3 text-sm placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                    </div>
                    <div className="flex gap-1 flex-wrap">
                        {TEMPLATE_CATEGORIES.map((cat) => (
                            <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                                className={cn("px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                                    activeCategory === cat.id ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" : "text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 border border-transparent"
                                )}>
                                {cat.icon} {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Template List */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {filtered.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Search className="h-8 w-8 text-muted-foreground/15 mb-3" />
                            <p className="text-sm text-muted-foreground/40">No templates found</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-2">
                            {filtered.map((t) => (
                                <button
                                    key={t.id}
                                    onClick={() => { onSelect(t.prompt); onClose(); }}
                                    className="group flex flex-col items-start p-3 rounded-lg border border-border/15 hover:border-emerald-500/20 hover:bg-emerald-500/3 transition-all text-left relative"
                                >
                                    <div className="flex items-center gap-2 w-full">
                                        <span className="text-sm">{t.icon}</span>
                                        <span className="text-xs font-medium text-foreground/80 truncate flex-1">{t.title}</span>
                                        {t.isCustom && (
                                            <button onClick={(e) => { e.stopPropagation(); deleteCustomTemplate(t.id); }}
                                                className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground/30 hover:text-red-400 transition-all">
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-muted-foreground/40 mt-1 line-clamp-2 leading-relaxed">{t.prompt}</p>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
