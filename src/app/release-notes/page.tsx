"use client";

import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Loader2, Star, Tag, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { fetchReleaseNotes, extractTextSummary, TAG_COLORS, type ReleaseNote } from "@/lib/release-notes";

function ReleaseNoteCard({ note }: { note: ReleaseNote }) {
    const summary = extractTextSummary(note.content, 300);
    const date = new Date(note.publishedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });

    return (
        <div className={`rounded-lg border bg-card p-5 space-y-3 transition-colors hover:border-primary/30 ${note.pinned ? "border-primary/40 bg-primary/5" : "border-border/50"}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span className="text-xs font-mono bg-primary/10 text-primary px-2 py-0.5 rounded border border-primary/20">
                            v{note.version}
                        </span>
                        {note.majorUpdate && (
                            <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                                <Star className="h-3 w-3 fill-current" /> Major
                            </span>
                        )}
                        {note.tags.map((tag) => (
                            <span key={tag} className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border capitalize ${TAG_COLORS[tag] ?? "bg-muted text-muted-foreground border-border"}`}>
                                <Tag className="h-2.5 w-2.5" /> {tag}
                            </span>
                        ))}
                    </div>
                    <h3 className="font-semibold text-sm leading-tight">{note.title}</h3>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{date}</span>
            </div>
            {summary && (
                <p className="text-sm text-muted-foreground leading-relaxed">{summary}</p>
            )}
        </div>
    );
}

export default function ReleaseNotesPage() {
    const router = useRouter();
    const [notes, setNotes] = useState<ReleaseNote[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);

    const loadNotes = useCallback(async (cursor?: string) => {
        try {
            const data = await fetchReleaseNotes(10, cursor);
            if (cursor) {
                setNotes((prev) => [...prev, ...data.notes]);
            } else {
                setNotes(data.notes);
            }
            setNextCursor(data.nextCursor);
        } catch {
            setError("Failed to load release notes. Please try again.");
        }
    }, []);

    useEffect(() => {
        setLoading(true);
        setError(null);
        loadNotes().finally(() => setLoading(false));
    }, [loadNotes]);

    async function loadMore() {
        if (!nextCursor || loadingMore) return;
        setLoadingMore(true);
        await loadNotes(nextCursor);
        setLoadingMore(false);
    }

    return (
        <div className="flex h-screen flex-col bg-background">
            {/* Header */}
            <header className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-sm shrink-0">
                <button
                    onClick={() => router.back()}
                    className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <h1 className="font-semibold text-sm">Release Notes</h1>
            </header>

            {/* Content */}
            <main className="flex-1 overflow-y-auto p-4 space-y-3 max-w-2xl mx-auto w-full">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <p className="text-sm">Loading release notes…</p>
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <p className="text-sm text-destructive">{error}</p>
                        <button
                            onClick={() => { setError(null); setLoading(true); loadNotes().finally(() => setLoading(false)); }}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <RefreshCw className="h-4 w-4" /> Retry
                        </button>
                    </div>
                ) : notes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
                        <p className="text-sm">No release notes yet.</p>
                    </div>
                ) : (
                    <>
                        {notes.map((note) => (
                            <ReleaseNoteCard key={note.id} note={note} />
                        ))}
                        {nextCursor && (
                            <button
                                onClick={loadMore}
                                disabled={loadingMore}
                                className="w-full py-3 text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                Load more
                            </button>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
