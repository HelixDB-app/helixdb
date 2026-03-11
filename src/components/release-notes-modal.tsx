"use client";

import { useMemo } from "react";
import {
  Color,
  EditorContent,
  EditorRoot,
  HighlightExtension,
  HorizontalRule,
  StarterKit,
  TaskItem,
  TaskList,
  TextStyle,
  TiptapImage,
  TiptapLink,
  TiptapUnderline,
  Twitter,
  Youtube,
} from "novel";
import { Loader2, Sparkles, Star, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { parseDocContent } from "@/lib/doc-editor";
import { TAG_COLORS, type ReleaseNote } from "@/lib/release-notes";

interface ReleaseNotesModalProps {
  open: boolean;
  note: ReleaseNote | null;
  loading?: boolean;
  onClose: () => void;
}

function ReleaseNotesContent({ note }: { note: ReleaseNote }) {
  const parsed = useMemo(() => {
    const raw = typeof note.content === "string"
      ? note.content
      : JSON.stringify(note.content ?? {});
    return parseDocContent(raw).data;
  }, [note.content]);

  const extensions = useMemo(() => {
    return [
      StarterKit.configure({
        horizontalRule: false,
      }),
      TextStyle,
      Color,
      TiptapUnderline,
      HighlightExtension.configure({
        multicolor: true,
      }),
      TiptapLink.configure({
        openOnClick: true,
        autolink: true,
        linkOnPaste: true,
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      HorizontalRule,
      Youtube.configure({
        controls: true,
        nocookie: true,
        modestBranding: true,
        width: 720,
        height: 405,
      }),
      Twitter.configure({
        addPasteHandler: false,
      }),
      TiptapImage.configure({
        allowBase64: true,
        inline: false,
      }),
    ];
  }, []);

  return (
    <div className="doc-editor-shell">
      <EditorRoot>
        <EditorContent
          key={note.id}
          className="helix-doc-editor min-h-[160px] w-full text-foreground focus:outline-none"
          initialContent={parsed}
          extensions={extensions}
          immediatelyRender={false}
          onCreate={({ editor }) => {
            editor.setEditable(false, false);
          }}
          editorProps={{
            attributes: {
              class: "helix-doc-editor",
            },
          }}
        />
      </EditorRoot>
    </div>
  );
}

export function ReleaseNotesModal({ open, note, loading, onClose }: ReleaseNotesModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-border/40 bg-gradient-to-r from-primary/10 via-transparent to-transparent">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold">What&apos;s New</h2>
                {note?.majorUpdate && (
                  <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                    <Star className="h-3 w-3" /> Major Update
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {note ? `Version ${note.version}` : "Loading release notes"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-6 pt-4 pb-5">
          {note && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Badge variant="secondary" className="font-mono text-xs">
                v{note.version}
              </Badge>
              {note.tags.map((tag) => (
                <span
                  key={tag}
                  className={`text-[10px] px-2 py-0.5 rounded border capitalize ${TAG_COLORS[tag] ?? "bg-muted text-muted-foreground border-border"}`}
                >
                  {tag}
                </span>
              ))}
              <span className="text-[10px] text-muted-foreground">
                {new Date(note.publishedAt).toLocaleDateString()}
              </span>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading release notes…
            </div>
          )}

          {!loading && note && note.title && (
            <h3 className="text-lg font-semibold text-foreground mb-2">{note.title}</h3>
          )}

          {!loading && note && note.summary && (
            <p className="text-sm text-muted-foreground mb-4">{note.summary}</p>
          )}

          {!loading && note && (
            <ScrollArea className="h-[55vh] pr-4">
              <ReleaseNotesContent note={note} />
            </ScrollArea>
          )}

          {!loading && !note && (
            <p className="text-sm text-muted-foreground py-8">Release notes unavailable.</p>
          )}
        </div>
      </div>
    </div>
  );
}
