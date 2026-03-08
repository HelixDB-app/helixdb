"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Color,
    Command,
    EditorBubble,
    EditorBubbleItem,
    EditorCommand,
    EditorCommandEmpty,
    EditorCommandItem,
    EditorCommandList,
    EditorContent,
    EditorRoot,
    GlobalDragHandle,
    HighlightExtension,
    HorizontalRule,
    ImageResizer,
    Placeholder,
    StarterKit,
    TaskItem,
    TaskList,
    TextStyle,
    TiptapImage,
    TiptapLink,
    TiptapUnderline,
    Twitter,
    UploadImagesPlugin,
    Youtube,
    createImageUpload,
    createSuggestionItems,
    getUrlFromString,
    handleCommandNavigation,
    handleImageDrop,
    handleImagePaste,
    renderItems,
    type EditorInstance,
} from "novel";
import {
    AlertCircle,
    Bold,
    Code2,
    Heading1,
    Heading2,
    Heading3,
    Highlighter,
    Image as ImageIcon,
    Italic,
    Link2,
    List,
    ListOrdered,
    Loader2,
    Minus,
    Quote,
    Save,
    Strikethrough,
    Underline,
    Youtube as YoutubeIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getCollaboratorColor } from "@/lib/collaboration/palette";
import { parseDocContent, serializeDocData } from "@/lib/doc-editor";

const AUTOSAVE_DEBOUNCE_MS = 450;
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

type SaveState = "loading" | "saving" | "saved" | "error";

interface DocumentCollaborator {
    id: string;
    name: string;
    initials: string;
    colorIndex: number;
}

export interface DocumentBlockEditorProps {
    value: string;
    onChange: (content: string) => void;
    readOnly?: boolean;
    className?: string;
    collaborators?: DocumentCollaborator[];
    placeholder?: string;
}

function formatSaveStateLabel(state: SaveState, lastSavedAt: number | null): string {
    if (state === "loading") return "Loading document editor...";
    if (state === "saving") return "Auto-saving...";
    if (state === "error") return "Auto-save failed";
    if (!lastSavedAt) return "Ready";
    return `Saved ${new Date(lastSavedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result === "string") {
                resolve(result);
                return;
            }
            reject(new Error("Unable to read image file."));
        };
        reader.onerror = () => reject(new Error("Unable to read image file."));
        reader.readAsDataURL(file);
    });
}

function pickImageFile(onPick: (file: File) => void) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) {
            onPick(file);
        }
    };
    input.click();
}

function countWords(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
}

export function DocumentBlockEditor({
    value,
    onChange,
    readOnly = false,
    className,
    collaborators = [],
    placeholder = "Write your notes, plan, or docs here...",
}: DocumentBlockEditorProps) {
    const initialParsedRef = useRef(parseDocContent(value));
    const editorRef = useRef<EditorInstance | null>(null);
    const readyRef = useRef(false);
    const mountedRef = useRef(true);
    const normalizedInitialPublishedRef = useRef(false);
    const suppressSaveRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSerializedRef = useRef(initialParsedRef.current.normalizedContent);

    const [saveState, setSaveState] = useState<SaveState>("loading");
    const [saveError, setSaveError] = useState<string | null>(null);
    const [parseWarning, setParseWarning] = useState<string | null>(initialParsedRef.current.parseError);
    const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
    const [, forceEditorRerender] = useState(0);

    const saveLabel = useMemo(() => formatSaveStateLabel(saveState, lastSavedAt), [saveState, lastSavedAt]);

    const imageUpload = useMemo(
        () =>
            createImageUpload({
                validateFn: (file) => {
                    const isImage = file.type.startsWith("image/");
                    if (!isImage) {
                        toast.error("Only image uploads are supported.");
                        return false;
                    }
                    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
                        toast.error("Image too large. Please use files up to 10MB.");
                        return false;
                    }
                    return true;
                },
                onUpload: async (file) => readFileAsDataUrl(file),
            }),
        []
    );

    const suggestionItems = useMemo(
        () =>
            createSuggestionItems([
                {
                    title: "Text",
                    description: "Start writing plain text",
                    icon: <List className="h-4 w-4" />,
                    searchTerms: ["paragraph", "text"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).setParagraph().run();
                    },
                },
                {
                    title: "Heading 1",
                    description: "Large section title",
                    icon: <Heading1 className="h-4 w-4" />,
                    searchTerms: ["title", "h1"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run();
                    },
                },
                {
                    title: "Heading 2",
                    description: "Medium section title",
                    icon: <Heading2 className="h-4 w-4" />,
                    searchTerms: ["subtitle", "h2"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run();
                    },
                },
                {
                    title: "Heading 3",
                    description: "Small section title",
                    icon: <Heading3 className="h-4 w-4" />,
                    searchTerms: ["heading", "h3"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run();
                    },
                },
                {
                    title: "Bullet list",
                    description: "Create a bulleted list",
                    icon: <List className="h-4 w-4" />,
                    searchTerms: ["unordered", "list"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleBulletList().run();
                    },
                },
                {
                    title: "Numbered list",
                    description: "Create an ordered list",
                    icon: <ListOrdered className="h-4 w-4" />,
                    searchTerms: ["ordered", "list"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
                    },
                },
                {
                    title: "Task list",
                    description: "Track todo items",
                    icon: <Highlighter className="h-4 w-4" />,
                    searchTerms: ["todo", "tasks", "checklist"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleTaskList().run();
                    },
                },
                {
                    title: "Quote",
                    description: "Highlight a quote",
                    icon: <Quote className="h-4 w-4" />,
                    searchTerms: ["blockquote", "quote"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
                    },
                },
                {
                    title: "Code block",
                    description: "Insert a formatted code block",
                    icon: <Code2 className="h-4 w-4" />,
                    searchTerms: ["code", "snippet"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
                    },
                },
                {
                    title: "Divider",
                    description: "Insert a horizontal divider",
                    icon: <Minus className="h-4 w-4" />,
                    searchTerms: ["separator", "line", "hr"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
                    },
                },
                {
                    title: "Image",
                    description: "Upload and embed an image",
                    icon: <ImageIcon className="h-4 w-4" />,
                    searchTerms: ["photo", "media", "upload"],
                    command: ({ editor, range }) => {
                        editor.chain().focus().deleteRange(range).run();
                        pickImageFile((file) => {
                            imageUpload(file, editor.view, editor.state.selection.from);
                        });
                    },
                },
                {
                    title: "YouTube",
                    description: "Embed a YouTube video",
                    icon: <YoutubeIcon className="h-4 w-4" />,
                    searchTerms: ["video", "embed", "youtube"],
                    command: ({ editor, range }) => {
                        const rawUrl = window.prompt("Enter YouTube URL");
                        if (!rawUrl) return;
                        const normalized = getUrlFromString(rawUrl.trim());
                        if (!normalized) {
                            toast.error("Please provide a valid URL.");
                            return;
                        }
                        editor.chain().focus().deleteRange(range).setYoutubeVideo({ src: normalized }).run();
                    },
                },
                {
                    title: "Tweet",
                    description: "Embed an X/Twitter post",
                    icon: <Link2 className="h-4 w-4" />,
                    searchTerms: ["x", "twitter", "tweet", "embed"],
                    command: ({ editor, range }) => {
                        const rawUrl = window.prompt("Enter tweet URL");
                        if (!rawUrl) return;
                        const normalized = getUrlFromString(rawUrl.trim());
                        if (!normalized) {
                            toast.error("Please provide a valid URL.");
                            return;
                        }
                        editor.chain().focus().deleteRange(range).setTweet({ src: normalized }).run();
                    },
                },
            ]),
        [imageUpload]
    );

    const extensions = useMemo(() => {
        const slashCommand = Command.configure({
            suggestion: {
                items: () => suggestionItems,
                ...renderItems(),
            },
        });

        const imageExtension = TiptapImage.extend({
            addProseMirrorPlugins() {
                return [UploadImagesPlugin({ imageClass: "helix-doc-image" })];
            },
        }).configure({
            allowBase64: true,
            inline: false,
        });

        return [
            StarterKit.configure({
                horizontalRule: false,
            }),
            Placeholder.configure({
                placeholder,
                includeChildren: true,
            }),
            TextStyle,
            Color,
            TiptapUnderline,
            HighlightExtension.configure({
                multicolor: true,
            }),
            TiptapLink.configure({
                openOnClick: false,
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
                addPasteHandler: true,
            }),
            GlobalDragHandle,
            imageExtension,
            slashCommand,
        ];
    }, [placeholder, suggestionItems]);

    const flushSave = useCallback(
        (editorArg?: EditorInstance | null) => {
            if (readOnly) return;
            const editor = editorArg ?? editorRef.current;
            if (!editor || !readyRef.current) return;

            try {
                const serialized = serializeDocData(editor.getJSON());
                if (serialized === lastSerializedRef.current) {
                    if (mountedRef.current) {
                        setSaveState("saved");
                        setSaveError(null);
                    }
                    return;
                }

                lastSerializedRef.current = serialized;
                onChange(serialized);
                if (mountedRef.current) {
                    setSaveState("saved");
                    setSaveError(null);
                    setLastSavedAt(Date.now());
                }
            } catch (error) {
                if (!mountedRef.current) return;
                setSaveState("error");
                setSaveError(error instanceof Error ? error.message : "Failed to save document.");
            }
        },
        [onChange, readOnly]
    );

    const scheduleSave = useCallback(
        (editor: EditorInstance) => {
            if (readOnly || suppressSaveRef.current) return;
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
            setSaveState("saving");
            saveTimerRef.current = setTimeout(() => {
                flushSave(editor);
            }, AUTOSAVE_DEBOUNCE_MS);
        },
        [flushSave, readOnly]
    );

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (normalizedInitialPublishedRef.current || readOnly) return;
        const initial = initialParsedRef.current;
        if (initial.wasNormalized) {
            onChange(initial.normalizedContent);
        }
        normalizedInitialPublishedRef.current = true;
    }, [onChange, readOnly]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor || !readyRef.current) return;

        const parsed = parseDocContent(value);
        setParseWarning(parsed.parseError);

        if (!readOnly && parsed.wasNormalized) {
            onChange(parsed.normalizedContent);
        }

        if (parsed.normalizedContent === lastSerializedRef.current) {
            return;
        }

        suppressSaveRef.current = true;
        try {
            editor.commands.setContent(parsed.data, false);
            lastSerializedRef.current = parsed.normalizedContent;
            if (mountedRef.current) {
                setSaveState("saved");
                setSaveError(null);
            }
        } catch (error) {
            if (mountedRef.current) {
                setSaveState("error");
                setSaveError(error instanceof Error ? error.message : "Failed to sync document content.");
            }
        } finally {
            setTimeout(() => {
                suppressSaveRef.current = false;
            }, 0);
        }
    }, [value, onChange, readOnly]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor || !readyRef.current) return;
        editor.setEditable(!readOnly, false);
    }, [readOnly]);

    const activeEditor = editorRef.current;
    const wordCount = activeEditor ? countWords(activeEditor.getText()) : 0;

    const commandButtonClass = "inline-flex h-7 items-center justify-center rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground transition hover:border-border hover:bg-accent hover:text-accent-foreground";
    const bubbleButtonClass = "inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted-foreground transition hover:bg-accent hover:text-accent-foreground";

    return (
        <div className={cn("doc-editor-shell flex h-full min-h-0 flex-col bg-muted/5", className)}>
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-2">
                    {saveState === "loading" || saveState === "saving" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                    ) : saveState === "error" ? (
                        <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                    ) : (
                        <Save className="h-3.5 w-3.5 text-emerald-400" />
                    )}
                    <span>{saveLabel}</span>
                    <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px]">{wordCount} words</span>
                    {readOnly && (
                        <span className="rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300 dark:text-cyan-200">
                            Read-only
                        </span>
                    )}
                </div>
                {collaborators.length > 0 && (
                    <div className="flex items-center gap-1.5">
                        {collaborators.slice(0, 4).map((participant) => (
                            <div
                                key={participant.id}
                                title={participant.name}
                                className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold text-foreground"
                                style={{
                                    borderColor: getCollaboratorColor(participant.colorIndex),
                                    backgroundColor: `${getCollaboratorColor(participant.colorIndex)}22`,
                                }}
                            >
                                {participant.initials.slice(0, 2)}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="relative flex-1 overflow-auto">
                <EditorRoot>
                    <EditorContent
                        className="mx-auto h-full w-full max-w-[980px] px-4 pb-12 pt-6 sm:px-8"
                        initialContent={initialParsedRef.current.data}
                        extensions={extensions}
                        immediatelyRender={false}
                        onCreate={({ editor }) => {
                            editorRef.current = editor;
                            readyRef.current = true;
                            editor.setEditable(!readOnly, false);
                            if (mountedRef.current) {
                                setSaveState("saved");
                                setSaveError(null);
                                forceEditorRerender((prev) => prev + 1);
                            }
                        }}
                        onUpdate={({ editor }) => {
                            if (suppressSaveRef.current) return;
                            scheduleSave(editor);
                            forceEditorRerender((prev) => prev + 1);
                        }}
                        onSelectionUpdate={() => {
                            forceEditorRerender((prev) => prev + 1);
                        }}
                        onBlur={({ editor }) => {
                            if (saveTimerRef.current) {
                                clearTimeout(saveTimerRef.current);
                                saveTimerRef.current = null;
                            }
                            flushSave(editor);
                        }}
                        onDestroy={() => {
                            readyRef.current = false;
                            editorRef.current = null;
                        }}
                        editorProps={{
                            attributes: {
                                class: "helix-doc-editor min-h-[420px] w-full max-w-none text-foreground focus:outline-none",
                            },
                            handleDOMEvents: {
                                keydown: (_view, event) => handleCommandNavigation(event as KeyboardEvent) === true,
                            },
                            handlePaste: (view, event) => handleImagePaste(view, event, imageUpload),
                            handleDrop: (view, event, _slice, moved) => handleImageDrop(view, event, moved, imageUpload),
                        }}
                    >
                        {!readOnly && (
                            <EditorCommand className="doc-command-menu max-h-[320px] w-[360px] overflow-y-auto rounded-xl border border-border/70 bg-popover p-2 shadow-xl">
                                <EditorCommandEmpty className="px-2 py-3 text-sm text-muted-foreground">
                                    No matching commands
                                </EditorCommandEmpty>
                                <EditorCommandList>
                                    {suggestionItems.map((item) => (
                                        <EditorCommandItem
                                            key={item.title}
                                            value={item.title}
                                            className="doc-command-item mb-1 flex cursor-pointer items-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-sm data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                                            onCommand={({ editor, range }) => {
                                                item.command?.({ editor, range });
                                            }}
                                        >
                                            <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground">
                                                {item.icon}
                                            </span>
                                            <span className="flex-1">
                                                <span className="block font-medium text-foreground">{item.title}</span>
                                                <span className="block text-xs text-muted-foreground">{item.description}</span>
                                            </span>
                                        </EditorCommandItem>
                                    ))}
                                </EditorCommandList>
                            </EditorCommand>
                        )}

                        {!readOnly && (
                            <EditorBubble className="doc-bubble-menu rounded-xl border border-border/70 bg-popover p-1.5 shadow-xl">
                                <div className="flex items-center gap-1">
                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("bold") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => editor.chain().focus().toggleBold().run()}
                                    >
                                        <Bold className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>
                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("italic") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => editor.chain().focus().toggleItalic().run()}
                                    >
                                        <Italic className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>
                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("underline") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => editor.chain().focus().toggleUnderline().run()}
                                    >
                                        <Underline className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>
                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("strike") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => editor.chain().focus().toggleStrike().run()}
                                    >
                                        <Strikethrough className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>
                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("code") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => editor.chain().focus().toggleCode().run()}
                                    >
                                        <Code2 className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>

                                    <div className="mx-0.5 h-5 w-px bg-border/70" />

                                    <EditorBubbleItem
                                        className={cn(
                                            bubbleButtonClass,
                                            activeEditor?.isActive("link") && "border-border bg-accent text-accent-foreground"
                                        )}
                                        onSelect={(editor) => {
                                            if (editor.isActive("link")) {
                                                editor.chain().focus().unsetLink().run();
                                                return;
                                            }
                                            const raw = window.prompt("Enter link URL");
                                            if (!raw) return;
                                            const url = getUrlFromString(raw.trim());
                                            if (!url) {
                                                toast.error("Please provide a valid URL.");
                                                return;
                                            }
                                            editor.chain().focus().setLink({ href: url }).run();
                                        }}
                                    >
                                        <Link2 className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>
                                    <EditorBubbleItem
                                        className={bubbleButtonClass}
                                        onSelect={(editor) => editor.chain().focus().toggleHighlight().run()}
                                    >
                                        <Highlighter className="h-3.5 w-3.5" />
                                    </EditorBubbleItem>

                                    <div className="mx-0.5 h-5 w-px bg-border/70" />

                                    <EditorBubbleItem className={commandButtonClass} onSelect={(editor) => editor.chain().focus().setParagraph().run()}>
                                        P
                                    </EditorBubbleItem>
                                    <EditorBubbleItem className={commandButtonClass} onSelect={(editor) => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                                        H1
                                    </EditorBubbleItem>
                                    <EditorBubbleItem className={commandButtonClass} onSelect={(editor) => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                                        H2
                                    </EditorBubbleItem>
                                </div>
                            </EditorBubble>
                        )}

                        {!readOnly && <ImageResizer />}
                    </EditorContent>
                </EditorRoot>
            </div>

            {(saveError || parseWarning) && (
                <div className="border-t border-border/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300 dark:text-red-200">
                    {saveError ?? parseWarning}
                </div>
            )}

        </div>
    );
}
