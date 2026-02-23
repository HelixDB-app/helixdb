"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNotesStore } from "@/stores/notes-store";
import type { QueryNote } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    Search,
    Copy,
    Pencil,
    Trash2,
    ArrowDownToLine,
    StickyNote,
    Loader2,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
    const ms = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString();
}

// ── Notes Panel ─────────────────────────────────────────────────────────────

interface NotesPanelProps {
    onInsertSql: (sql: string) => void;
    onClose: () => void;
}

export function NotesPanel({ onInsertSql, onClose }: NotesPanelProps) {
    const {
        isLoading,
        searchQuery,
        setSearch,
        loadNotes,
        deleteNote,
        saveNote,
        visibleNotes,
        hasMore,
        loadMore,
        resetScroll,
    } = useNotesStore();

    const visible = visibleNotes();
    const canLoadMore = hasMore();

    // Edit dialog state
    const [editingNote, setEditingNote] = useState<QueryNote | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editSql, setEditSql] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // Sentinel ref for infinite scroll
    const sentinelRef = useRef<HTMLDivElement>(null);

    // Load notes on mount
    useEffect(() => {
        loadNotes();
        return () => resetScroll();
    }, [loadNotes, resetScroll]);

    // Infinite scroll via IntersectionObserver
    useEffect(() => {
        if (!sentinelRef.current) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && canLoadMore) {
                    loadMore();
                }
            },
            { threshold: 0.1 }
        );
        observer.observe(sentinelRef.current);
        return () => observer.disconnect();
    }, [canLoadMore, loadMore]);

    const handleCopy = useCallback((sql: string) => {
        navigator.clipboard.writeText(sql);
        toast.success("SQL copied", { duration: 1500 });
    }, []);

    const handleDelete = useCallback(
        async (id: string) => {
            try {
                await deleteNote(id);
                toast.success("Note deleted", { duration: 1500 });
            } catch {
                toast.error("Failed to delete note", { duration: 2000 });
            }
        },
        [deleteNote]
    );

    const handleInsert = useCallback(
        (sql: string) => {
            onInsertSql(sql);
            toast.success("Note inserted into editor", { duration: 1500 });
        },
        [onInsertSql]
    );

    const openEdit = useCallback((note: QueryNote) => {
        setEditingNote(note);
        setEditTitle(note.title);
        setEditSql(note.sql);
    }, []);

    const handleSaveEdit = useCallback(async () => {
        if (!editingNote || !editTitle.trim()) return;
        setIsSaving(true);
        try {
            await saveNote({
                ...editingNote,
                title: editTitle.trim(),
                sql: editSql,
                updated_at: new Date().toISOString(),
            });
            setEditingNote(null);
            toast.success("Note updated", { duration: 1500 });
        } catch {
            toast.error("Failed to update note", { duration: 2000 });
        } finally {
            setIsSaving(false);
        }
    }, [editingNote, editTitle, editSql, saveNote]);

    return (
        <div className="flex flex-col h-full bg-card/30">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 shrink-0">
                <StickyNote className="h-3.5 w-3.5 text-amber-400/70" />
                <span className="text-xs font-medium text-foreground/80">
                    Notes
                </span>
                <span className="text-[10px] text-muted-foreground/50 font-mono">
                    {visible.length} note{visible.length !== 1 ? "s" : ""}
                </span>
                <div className="flex-1" />
                <div className="relative flex-1 max-w-[220px]">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40" />
                    <Input
                        value={searchQuery}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search notes…"
                        className="h-7 pl-7 text-xs bg-background/50 border-border/30 focus-visible:ring-1 focus-visible:ring-amber-500/30"
                    />
                    {searchQuery && (
                        <button
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted/60 text-muted-foreground/40 hover:text-foreground transition-colors"
                            onClick={() => setSearch("")}
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/60 transition-colors"
                            onClick={onClose}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>Close notes</TooltipContent>
                </Tooltip>
            </div>

            {/* List */}
            <ScrollArea className="flex-1">
                {isLoading && visible.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
                    </div>
                ) : visible.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/40">
                        <StickyNote className="h-8 w-8 mb-2 opacity-30" />
                        <p className="text-xs">
                            {searchQuery
                                ? "No notes match your search"
                                : "No saved notes yet"}
                        </p>
                        <p className="text-[10px] mt-1 opacity-60">
                            {searchQuery
                                ? "Try different keywords"
                                : 'Click "Save Note" to save your SQL snippets'}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border/10">
                        {visible.map((note) => (
                            <div
                                key={note.id}
                                className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-accent/30 transition-colors cursor-default"
                            >
                                {/* Icon */}
                                <StickyNote className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400/50" />

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-foreground/90 truncate leading-relaxed">
                                        {note.title}
                                    </p>
                                    <p className="text-[11px] font-mono text-foreground/50 truncate leading-relaxed mt-0.5">
                                        {note.sql
                                            .replace(/\s+/g, " ")
                                            .slice(0, 100)}
                                        {note.sql.length > 100 ? "…" : ""}
                                    </p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] text-muted-foreground/40">
                                            {timeAgo(note.updated_at)}
                                        </span>
                                        {note.tags.length > 0 && (
                                            <>
                                                <span className="text-muted-foreground/20">
                                                    ·
                                                </span>
                                                {note.tags
                                                    .slice(0, 2)
                                                    .map((tag) => (
                                                        <span
                                                            key={tag}
                                                            className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70"
                                                        >
                                                            {tag}
                                                        </span>
                                                    ))}
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Hover actions */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                                                onClick={() =>
                                                    handleInsert(note.sql)
                                                }
                                            >
                                                <ArrowDownToLine className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Insert into editor
                                        </TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/60 transition-colors"
                                                onClick={() =>
                                                    handleCopy(note.sql)
                                                }
                                            >
                                                <Copy className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Copy SQL
                                        </TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                                                onClick={() =>
                                                    openEdit(note)
                                                }
                                            >
                                                <Pencil className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Edit note
                                        </TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="p-1 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                onClick={() =>
                                                    handleDelete(note.id)
                                                }
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Delete note
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                            </div>
                        ))}

                        {/* Infinite scroll sentinel */}
                        {canLoadMore && (
                            <div
                                ref={sentinelRef}
                                className="flex items-center justify-center py-3"
                            >
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/20" />
                            </div>
                        )}
                    </div>
                )}
            </ScrollArea>

            {/* Edit dialog */}
            <Dialog
                open={!!editingNote}
                onOpenChange={(open) => {
                    if (!open) setEditingNote(null);
                }}
            >
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-sm font-medium">
                            Edit Note
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">
                                Title
                            </label>
                            <Input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                placeholder="Note title…"
                                className="h-8 text-sm"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">
                                SQL
                            </label>
                            <textarea
                                value={editSql}
                                onChange={(e) => setEditSql(e.target.value)}
                                className={cn(
                                    "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                                    "ring-offset-background font-mono",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                    "min-h-[120px] resize-y"
                                )}
                                placeholder="SELECT * FROM ..."
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingNote(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white"
                            onClick={handleSaveEdit}
                            disabled={!editTitle.trim() || isSaving}
                        >
                            {isSaving ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                            ) : null}
                            Save Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
