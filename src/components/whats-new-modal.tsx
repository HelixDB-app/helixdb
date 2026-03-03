"use client";

import { useState, useEffect } from "react";
import { X, Sparkles, Star } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { fetchReleaseNotes, extractTextSummary, TAG_COLORS, type ReleaseNote } from "@/lib/release-notes";

function isTauri(): boolean {
    return typeof window !== "undefined" &&
        !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

function ReleaseNoteContent({ note }: { note: ReleaseNote }) {
    const summary = extractTextSummary(note.content, 400);
    return (
        <div className="space-y-4">
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono bg-primary/10 text-primary px-2 py-0.5 rounded border border-primary/20">
                            v{note.version}
                        </span>
                        {note.majorUpdate && (
                            <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                                <Star className="h-3 w-3" /> Major Update
                            </span>
                        )}
                        {note.tags.map((tag) => (
                            <span key={tag} className={`text-xs px-2 py-0.5 rounded border capitalize ${TAG_COLORS[tag] ?? "bg-muted text-muted-foreground border-border"}`}>
                                {tag}
                            </span>
                        ))}
                    </div>
                    <h3 className="text-base font-semibold mt-2">{note.title}</h3>
                    {summary && (
                        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{summary}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

export function WhatsNewModal() {
    const { lastSeenVersion, updateSettings } = useSettingsStore();
    const [note, setNote] = useState<ReleaseNote | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!isTauri()) return;

        void (async () => {
            try {
                const { notes } = await fetchReleaseNotes(1);
                if (notes.length === 0) return;
                const latest = notes[0];

                // Simple version comparison (works for semver strings)
                if (latest.version !== lastSeenVersion) {
                    setNote(latest);
                    setOpen(true);
                }
            } catch {
                // Don't break app if release notes fail
            }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function dismiss() {
        if (note) updateSettings({ lastSeenVersion: note.version });
        setOpen(false);
    }

    if (!open || !note) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0">
            <div className="w-full max-w-md rounded-xl border border-border/50 bg-card shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-gradient-to-r from-primary/5 to-transparent">
                    <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                            <Sparkles className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                            <h2 className="font-semibold text-sm">What&apos;s New</h2>
                            <p className="text-xs text-muted-foreground">Latest updates for pgStudio</p>
                        </div>
                    </div>
                    <button
                        onClick={dismiss}
                        className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
                    >
                        <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-5">
                    <ReleaseNoteContent note={note} />
                </div>

                {/* Footer */}
                <div className="px-5 pb-5 flex justify-end gap-2">
                    <button
                        onClick={dismiss}
                        className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                    >
                        Got it
                    </button>
                </div>
            </div>
        </div>
    );
}
