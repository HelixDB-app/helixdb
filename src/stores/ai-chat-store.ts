/**
 * AI Chat Zustand Store
 *
 * Manages conversations, messages, streaming state, model selection,
 * image attachments, prompt templates, and conversation pinning.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
    aiChatEngine,
    AIError,
    fetchSchemaMetadata,
    buildCompressedSchema,
    type GeminiModelId,
    type ImageAttachment,
} from "@/lib/ai-chat-engine";
import { useConnectionStore } from "@/stores/connection-store";
import { getResolvedGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import { useQueryStore } from "@/stores/query-store";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "error";
    content: string;
    timestamp: number;
    isStreaming?: boolean;
    images?: { mimeType: string; previewUrl: string }[]; // For display only (no base64 in store)
    context?: ChatContextItem[];
}

export interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    model: GeminiModelId;
    createdAt: number;
    updatedAt: number;
    pinned?: boolean;
}

export interface PromptTemplate {
    id: string;
    title: string;
    prompt: string;
    category: string;
    icon: string;
    isCustom?: boolean;
}

export interface ChatContextItem {
    id: string;
    label: string;
    kind: "sql" | "file" | "code" | "text";
    content?: string;
    language?: string;
    source?: string;
    size?: number;
    truncated?: boolean;
}

interface AIChatState {
    conversations: Conversation[];
    activeConversationId: string | null;
    isStreaming: boolean;
    error: string | null;
    cachedSchema: string | null;
    schemaTableCount: number;
    customTemplates: PromptTemplate[];

    // Actions
    createConversation: (model?: GeminiModelId) => string;
    setActiveConversation: (id: string) => void;
    deleteConversation: (id: string) => void;
    sendMessage: (content: string, images?: ImageAttachment[], context?: ChatContextItem[]) => Promise<void>;
    regenerateResponse: (messageId: string) => Promise<void>;
    editMessage: (messageId: string, newContent: string) => Promise<void>;
    switchModel: (model: GeminiModelId) => void;
    stopStreaming: () => void;
    insertSqlToEditor: (sql: string) => void;
    refreshSchema: () => Promise<void>;
    clearAll: () => void;
    togglePinConversation: (id: string) => void;
    exportConversation: (id: string) => string;
    addCustomTemplate: (template: Omit<PromptTemplate, "id" | "isCustom">) => void;
    deleteCustomTemplate: (id: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateTitle(firstMessage: string): string {
    const cleaned = firstMessage.trim().slice(0, 50);
    return cleaned.length < firstMessage.trim().length ? cleaned + "…" : cleaned;
}

const MAX_CONTEXT_ITEM_CHARS = 12000;
const MAX_CONTEXT_TOTAL_CHARS = 60000;

function buildContextBlock(items?: ChatContextItem[]): { text: string; summaries: ChatContextItem[] } {
    if (!items || items.length === 0) return { text: "", summaries: [] };

    const sections: string[] = [];
    const summaries: ChatContextItem[] = [];
    let remaining = MAX_CONTEXT_TOTAL_CHARS;

    for (const item of items) {
        const raw = (item.content ?? "").trim();
        if (!raw) continue;

        let text = raw;
        let truncated = false;

        if (text.length > MAX_CONTEXT_ITEM_CHARS) {
            text = text.slice(0, MAX_CONTEXT_ITEM_CHARS);
            truncated = true;
        }
        if (text.length > remaining) {
            text = text.slice(0, Math.max(0, remaining));
            truncated = true;
        }

        if (!text) break;

        remaining -= text.length;
        const header = item.source ? `${item.label} — ${item.source}` : item.label;
        const language = item.language ?? (item.kind === "sql" ? "sql" : "text");
        sections.push(`### ${header}\n\`\`\`${language}\n${text}\n\`\`\``);
        summaries.push({
            ...item,
            content: text,
            size: raw.length,
            truncated: truncated || item.truncated,
        });

        if (remaining <= 0) break;
    }

    if (sections.length === 0) return { text: "", summaries: [] };
    const text = `\n\nCONTEXT (project files & SQL scripts):\n${sections.join("\n\n")}\n`;
    return { text, summaries };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useAIChatStore = create<AIChatState>()(
    persist(
        (set, get) => ({
            conversations: [],
            activeConversationId: null,
            isStreaming: false,
            error: null,
            cachedSchema: null,
            schemaTableCount: 0,
            customTemplates: [],

            createConversation: (model?: GeminiModelId) => {
                const defaultModel = useSettingsStore.getState().defaultAiModel ?? "gemini-2.5-flash";
                const id = genId();
                const conv: Conversation = {
                    id,
                    title: "New Chat",
                    messages: [],
                    model: model ?? defaultModel,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                set((s) => ({
                    conversations: [conv, ...s.conversations],
                    activeConversationId: id,
                    error: null,
                }));
                return id;
            },

            setActiveConversation: (id) => {
                set({ activeConversationId: id, error: null });
            },

            deleteConversation: (id) => {
                aiChatEngine.clearConversation(id);
                set((s) => {
                    const conversations = s.conversations.filter((c) => c.id !== id);
                    const activeConversationId =
                        s.activeConversationId === id
                            ? conversations[0]?.id ?? null
                            : s.activeConversationId;
                    return { conversations, activeConversationId };
                });
            },

            sendMessage: async (content: string, images?: ImageAttachment[], context?: ChatContextItem[]) => {
                const state = get();
                let convId = state.activeConversationId;

                if (!convId) {
                    convId = get().createConversation();
                }

                const apiKey = getResolvedGeminiApiKey();
                const conv = get().conversations.find((c) => c.id === convId);
                if (!conv) return;

                if (!get().cachedSchema) {
                    await get().refreshSchema();
                }
                const schema = get().cachedSchema ?? "No schema available.";

                // Store image previews (not full base64) in the message for display
                const imageDisplayData = images?.map((img) => ({
                    mimeType: img.mimeType,
                    previewUrl: img.previewUrl ?? `data:${img.mimeType};base64,${img.base64.slice(0, 100)}`,
                }));

                const { text: contextBlock, summaries: contextSummary } = buildContextBlock(context);

                const userMsg: ChatMessage = {
                    id: genId(),
                    role: "user",
                    content,
                    timestamp: Date.now(),
                    images: imageDisplayData,
                    context: contextSummary.length > 0 ? contextSummary : undefined,
                };

                const assistantMsg: ChatMessage = {
                    id: genId(),
                    role: "assistant",
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                };

                const isFirstMessage = conv.messages.length === 0;

                set((s) => ({
                    isStreaming: true,
                    error: null,
                    conversations: s.conversations.map((c) =>
                        c.id === convId
                            ? {
                                ...c,
                                messages: [...c.messages, userMsg, assistantMsg],
                                title: isFirstMessage ? generateTitle(content) : c.title,
                                updatedAt: Date.now(),
                            }
                            : c
                    ),
                }));

                try {
                    const fullResponse = await aiChatEngine.sendMessage(
                        convId,
                        content,
                        schema,
                        conv.model,
                        apiKey,
                        (chunk) => {
                            set((s) => ({
                                conversations: s.conversations.map((c) =>
                                    c.id === convId
                                        ? {
                                            ...c,
                                            messages: c.messages.map((m) =>
                                                m.id === assistantMsg.id
                                                    ? { ...m, content: m.content + chunk }
                                                    : m
                                            ),
                                        }
                                        : c
                                ),
                            }));
                        },
                        images,
                        contextBlock
                    );

                    set((s) => ({
                        isStreaming: false,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? {
                                    ...c,
                                    messages: c.messages.map((m) =>
                                        m.id === assistantMsg.id
                                            ? { ...m, content: fullResponse, isStreaming: false }
                                            : m
                                    ),
                                }
                                : c
                        ),
                    }));
                } catch (error) {
                    const errorMessage =
                        error instanceof AIError
                            ? error.userMessage
                            : error instanceof DOMException && error.name === "AbortError"
                                ? "Request was stopped."
                                : "An unexpected error occurred. Please try again.";

                    set((s) => ({
                        isStreaming: false,
                        error: errorMessage,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? {
                                    ...c,
                                    messages: c.messages.map((m) =>
                                        m.id === assistantMsg.id
                                            ? { ...m, role: "error" as const, content: errorMessage, isStreaming: false }
                                            : m
                                    ),
                                }
                                : c
                        ),
                    }));
                }
            },

            regenerateResponse: async (messageId: string) => {
                const state = get();
                const convId = state.activeConversationId;
                if (!convId) return;
                const conv = state.conversations.find((c) => c.id === convId);
                if (!conv) return;

                const apiKey = getResolvedGeminiApiKey();
                const schema = get().cachedSchema ?? "No schema available.";
                const msgIndex = conv.messages.findIndex((m) => m.id === messageId);
                if (msgIndex < 0) return;

                const trimmedMessages = conv.messages.slice(0, msgIndex);
                const assistantMsg: ChatMessage = {
                    id: genId(),
                    role: "assistant",
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                };

                set((s) => ({
                    isStreaming: true,
                    error: null,
                    conversations: s.conversations.map((c) =>
                        c.id === convId
                            ? { ...c, messages: [...trimmedMessages, assistantMsg], updatedAt: Date.now() }
                            : c
                    ),
                }));

                try {
                    const lastUserMsg = [...trimmedMessages].reverse().find((m) => m.role === "user");
                    const { text: contextBlock } = buildContextBlock(lastUserMsg?.context);
                    const fullResponse = await aiChatEngine.regenerateLastResponse(
                        convId, schema, conv.model, apiKey,
                        (chunk) => {
                            set((s) => ({
                                conversations: s.conversations.map((c) =>
                                    c.id === convId
                                        ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m) }
                                        : c
                                ),
                            }));
                        },
                        contextBlock
                    );
                    set((s) => ({
                        isStreaming: false,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, content: fullResponse, isStreaming: false } : m) }
                                : c
                        ),
                    }));
                } catch (error) {
                    const errorMessage = error instanceof AIError ? error.userMessage : "Failed to regenerate.";
                    set((s) => ({
                        isStreaming: false,
                        error: errorMessage,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, role: "error" as const, content: errorMessage, isStreaming: false } : m) }
                                : c
                        ),
                    }));
                }
            },

            editMessage: async (messageId: string, newContent: string) => {
                const state = get();
                const convId = state.activeConversationId;
                if (!convId) return;
                const conv = state.conversations.find((c) => c.id === convId);
                if (!conv) return;

                const msgIndex = conv.messages.findIndex((m) => m.id === messageId);
                if (msgIndex < 0) return;

                const apiKey = getResolvedGeminiApiKey();
                const schema = get().cachedSchema ?? "No schema available.";

                const trimmedMessages = conv.messages.slice(0, msgIndex);
                const originalContext = conv.messages[msgIndex]?.context;
                const { text: contextBlock, summaries: contextSummary } = buildContextBlock(originalContext);
                const editedMsg: ChatMessage = {
                    ...conv.messages[msgIndex],
                    content: newContent,
                    context: contextSummary.length > 0 ? contextSummary : originalContext,
                };
                const assistantMsg: ChatMessage = {
                    id: genId(), role: "assistant", content: "", timestamp: Date.now(), isStreaming: true,
                };

                set((s) => ({
                    isStreaming: true, error: null,
                    conversations: s.conversations.map((c) =>
                        c.id === convId
                            ? { ...c, messages: [...trimmedMessages, editedMsg, assistantMsg], updatedAt: Date.now() }
                            : c
                    ),
                }));

                const engineIndex = trimmedMessages.filter((m) => m.role === "user" || m.role === "assistant").length;

                try {
                    const fullResponse = await aiChatEngine.editAndRegenerate(
                        convId, engineIndex, newContent, schema, conv.model, apiKey,
                        (chunk) => {
                            set((s) => ({
                                conversations: s.conversations.map((c) =>
                                    c.id === convId
                                        ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m) }
                                        : c
                                ),
                            }));
                        },
                        contextBlock
                    );
                    set((s) => ({
                        isStreaming: false,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, content: fullResponse, isStreaming: false } : m) }
                                : c
                        ),
                    }));
                } catch (error) {
                    const errorMessage = error instanceof AIError ? error.userMessage : "Failed to regenerate.";
                    set((s) => ({
                        isStreaming: false, error: errorMessage,
                        conversations: s.conversations.map((c) =>
                            c.id === convId
                                ? { ...c, messages: c.messages.map((m) => m.id === assistantMsg.id ? { ...m, role: "error" as const, content: errorMessage, isStreaming: false } : m) }
                                : c
                        ),
                    }));
                }
            },

            switchModel: (model) => {
                const convId = get().activeConversationId;
                if (!convId) return;
                set((s) => ({
                    conversations: s.conversations.map((c) => c.id === convId ? { ...c, model } : c),
                }));
            },

            stopStreaming: () => {
                aiChatEngine.stopStreaming();
                set((s) => ({
                    isStreaming: false,
                    conversations: s.conversations.map((c) =>
                        c.id === s.activeConversationId
                            ? { ...c, messages: c.messages.map((m) => m.isStreaming ? { ...m, isStreaming: false } : m) }
                            : c
                    ),
                }));
            },

            insertSqlToEditor: (sql: string) => {
                const queryStore = useQueryStore.getState();
                const activeTabId = queryStore.activeTabId;
                if (!activeTabId) {
                    queryStore.addTab("AI Generated", sql);
                    return;
                }
                queryStore.updateSql(activeTabId, sql);
            },

            refreshSchema: async () => {
                const connState = useConnectionStore.getState();
                if (!connState.connectionId || !connState.isConnected) {
                    set({ cachedSchema: null, schemaTableCount: 0 });
                    return;
                }
                try {
                    const allTables = connState.tables
                        .filter((t) => t.table_type !== "VIEW")
                        .map((t) => ({ schema: t.schema, name: t.name }));
                    if (allTables.length === 0) {
                        set({ cachedSchema: "No tables found.", schemaTableCount: 0 });
                        return;
                    }
                    const tablesToFetch = allTables.slice(0, 50);
                    const metadata = await fetchSchemaMetadata(connState.connectionId, tablesToFetch);
                    const compressed = buildCompressedSchema(metadata);
                    set({ cachedSchema: compressed, schemaTableCount: tablesToFetch.length });
                } catch {
                    set({ cachedSchema: "Failed to load schema.", schemaTableCount: 0 });
                }
            },

            clearAll: () => {
                aiChatEngine.clearAll();
                set({ conversations: [], activeConversationId: null, isStreaming: false, error: null });
            },

            togglePinConversation: (id: string) => {
                set((s) => ({
                    conversations: s.conversations.map((c) =>
                        c.id === id ? { ...c, pinned: !c.pinned } : c
                    ),
                }));
            },

            exportConversation: (id: string): string => {
                const conv = get().conversations.find((c) => c.id === id);
                if (!conv) return "";
                const lines = [`# ${conv.title}`, `*Model: ${conv.model} · ${new Date(conv.createdAt).toLocaleString()}*`, ""];
                for (const msg of conv.messages) {
                    if (msg.role === "user") {
                        lines.push(`## You`, "");
                        if (msg.context && msg.context.length > 0) {
                            lines.push(`*Context:* ${msg.context.map((c) => c.label).join(", ")}`, "");
                        }
                        lines.push(msg.content, "");
                    } else if (msg.role === "assistant") {
                        lines.push(`## Nova AI`, "", msg.content, "");
                    }
                }
                return lines.join("\n");
            },

            addCustomTemplate: (template) => {
                const newTemplate: PromptTemplate = {
                    ...template,
                    id: genId(),
                    isCustom: true,
                };
                set((s) => ({
                    customTemplates: [...s.customTemplates, newTemplate],
                }));
            },

            deleteCustomTemplate: (id: string) => {
                set((s) => ({
                    customTemplates: s.customTemplates.filter((t) => t.id !== id),
                }));
            },
        }),
        {
            name: "helix-ai-chat",
            version: 2,
            partialize: (state) => ({
                conversations: state.conversations.map((c) => ({
                    ...c,
                    messages: c.messages.map((m) => ({
                        ...m,
                        isStreaming: false,
                        context: m.context?.map(({ content, ...rest }) => rest),
                    })),
                })),
                activeConversationId: state.activeConversationId,
                customTemplates: state.customTemplates,
            }),
        }
    )
);
