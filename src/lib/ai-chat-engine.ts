/**
 * AI Chat Engine — Gemini API Integration for pgStudio
 *
 * Core engine handling:
 * - Compressed schema context injection for token efficiency
 * - Streaming Gemini API communication via SSE
 * - Conversation memory with configurable max turns
 * - Model abstraction (Pro / Flash)
 * - Robust error handling with user-friendly messages
 */

import type { ColumnInfo, TableDetails } from "@/lib/types";
import { dbGetColumns, dbGetTableDetails } from "@/lib/db-platform";
import {
    isNoInternetError,
    notifyNoInternetDetected,
} from "@/lib/network-errors";
import { geminiLogger } from "@/lib/gemini-logger";
import { getWebAppBaseUrl } from "@/lib/web-app-url";

// ── Model Configuration ──────────────────────────────────────────────────────

export type GeminiModelId = "gemini-2.5-pro" | "gemini-2.5-flash" | "gemma3-4b" | "gemma3-12b" | "gemma3-27b" | "gemini-2.5-flash-lite" | "gemini-2.5-pro-lite";

export interface GeminiModelConfig {
    id: GeminiModelId;
    displayName: string;
    description: string;
}

export const GEMINI_MODELS: Record<GeminiModelId, GeminiModelConfig> = {
    "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        description: "Most capable — best for complex queries",
    },
    "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        displayName: "Gemini Flash",
        description: "Fast & efficient — great for quick queries",
    },
    "gemini-2.5-flash-lite": {
        id: "gemini-2.5-flash-lite",
        displayName: "Gemini Flash Lite",
        description: "Fast & efficient — great for quick queries",
    },
    "gemini-2.5-pro-lite": {
        id: "gemini-2.5-pro-lite",
        displayName: "Gemini Pro Lite",
        description: "Fast & efficient — great for quick queries",
    },
    "gemma3-4b": {
        id: "gemma3-4b",
        displayName: "Gemma 3 4B",
        description: "Fast & efficient — great for quick queries",
    },
    "gemma3-12b": {
        id: "gemma3-12b",
        displayName: "Gemma 3 12B",
        description: "Fast & efficient — great for quick queries",
    },
    "gemma3-27b": {
        id: "gemma3-27b",
        displayName: "Gemma 3 27B",
        description: "Fast & efficient — great for quick queries",
    },
};

// ── Schema Compression ───────────────────────────────────────────────────────

export interface SchemaTableMeta {
    name: string;
    schema: string;
    columns: ColumnInfo[];
    constraints?: {
        foreignKeys: { column: string; refTable: string; refColumn: string }[];
    };
}

/**
 * Builds a compressed, token-efficient schema representation for the AI.
 * Format: T:table_name|C:col1(type,pk),col2(type,fk→ref),...
 */
export function buildCompressedSchema(tables: SchemaTableMeta[]): string {
    if (tables.length === 0) return "No tables available.";

    const lines = tables.map((t) => {
        const colParts = t.columns.map((col) => {
            const flags: string[] = [];
            if (col.is_primary_key) flags.push("pk");

            // Check if this column is a FK
            const fk = t.constraints?.foreignKeys.find(
                (f) => f.column === col.name
            );
            if (fk) flags.push(`fk→${fk.refTable}.${fk.refColumn}`);

            if (col.is_nullable) flags.push("null");

            const type = col.data_type.toLowerCase().replace("character varying", "varchar");
            const flagStr = flags.length > 0 ? `,${flags.join(",")}` : "";
            return `${col.name}(${type}${flagStr})`;
        });

        return `T:${t.schema}.${t.name}|C:${colParts.join(",")}`;
    });

    return lines.join("\n");
}

/**
 * Fetches full schema metadata for all tables using Tauri commands.
 * Returns compressed schema tables with column info and FK relationships.
 */
export async function fetchSchemaMetadata(
    connectionId: string,
    schemaTables: { schema: string; name: string }[]
): Promise<SchemaTableMeta[]> {
    const results: SchemaTableMeta[] = [];

    // Fetch in parallel batches to avoid overwhelming the backend
    const BATCH_SIZE = 8;
    for (let i = 0; i < schemaTables.length; i += BATCH_SIZE) {
        const batch = schemaTables.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
            batch.map(async (t) => {
                const [columns, details] = await Promise.all([
                    dbGetColumns(connectionId, t.schema, t.name),
                    dbGetTableDetails(connectionId, t.schema, t.name).catch(() => null),
                ]);

                const foreignKeys: SchemaTableMeta["constraints"] = { foreignKeys: [] };
                if (details?.constraints) {
                    for (const c of details.constraints) {
                        if (
                            c.constraint_type === "FOREIGN KEY" &&
                            c.foreign_table &&
                            c.columns.length > 0
                        ) {
                            c.columns.forEach((col, idx) => {
                                foreignKeys.foreignKeys.push({
                                    column: col,
                                    refTable: c.foreign_table!,
                                    refColumn: c.foreign_columns?.[idx] ?? col,
                                });
                            });
                        }
                    }
                }

                return {
                    name: t.name,
                    schema: t.schema,
                    columns,
                    constraints: foreignKeys,
                } satisfies SchemaTableMeta;
            })
        );

        for (const result of settled) {
            if (result.status === "fulfilled") {
                results.push(result.value);
            }
        }
    }

    return results;
}

// ── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(compressedSchema: string, extraContext?: string): string {
    const contextBlock = extraContext?.trim() ? `\n${extraContext.trim()}\n` : "";
    return `You are Nova, an expert PostgreSQL assistant embedded inside pgStudio (HelixDB).
You help developers write, debug, optimize, and understand SQL queries.

DATABASE SCHEMA (compressed format — T:schema.table|C:column(type,flags)):
═══════════════════════════════════════════════════════════════════════════
${compressedSchema}
═══════════════════════════════════════════════════════════════════════════
${contextBlock}

FLAGS LEGEND: pk=primary key, fk→table.col=foreign key reference, null=nullable

YOUR CAPABILITIES:
1. Generate SQL queries from natural language descriptions
2. Explain, debug, and optimize existing queries
3. Suggest schema improvements and indexes
4. Understand table relationships via foreign keys
5. Write complex JOINs, CTEs, window functions, and aggregations

OUTPUT RULES:
1. When generating SQL, wrap it in a \`\`\`sql code block.
2. ONLY use tables and columns that exist in the schema above. Never invent names.
3. Use standard PostgreSQL syntax (not MySQL/SQLite/MSSQL).
4. Add LIMIT 200 to SELECT queries unless the user specifies otherwise.
5. Provide brief, clear explanations alongside generated SQL.
6. For complex queries, break down the logic step by step.
7. If the user's request is ambiguous, ask a clarifying question.
8. When suggesting improvements, explain WHY they help.
9. If the user provides a CONTEXT section with SQL or code, treat it as authoritative and base your answer on it.

RESPONSE STYLE:
- Be concise and professional
- Lead with the SQL when the user asks for a query
- Use markdown formatting for readability
- Keep explanations focused and practical`;
}

// ── Gemini API Communication ─────────────────────────────────────────────────

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const GOOGLE_API_KEY_HEADER = "x-goog-api-key";

function geminiProxyEnabled(): boolean {
    return process.env.NEXT_PUBLIC_GEMINI_USE_PROXY !== "false";
}

/** Control-plane Gemini proxy (rate-limited per IP). Null when direct Google access is enabled. */
function getGeminiProxyBaseUrl(): string | null {
    if (!geminiProxyEnabled()) return null;
    const override = process.env.NEXT_PUBLIC_GEMINI_PROXY_BASE?.trim();
    if (override) return override.replace(/\/+$/, "");
    return `${getWebAppBaseUrl()}/api/gemini`;
}

interface GeminiPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string; // base64
    };
}

interface GeminiMessage {
    role: "user" | "model";
    parts: GeminiPart[];
}

interface GeminiError {
    code: number;
    message: string;
    status: string;
}

export class AIError extends Error {
    public readonly code: number;
    public readonly isRetryable: boolean;
    public readonly userMessage: string;

    constructor(code: number, message: string, userMessage: string, isRetryable: boolean) {
        super(message);
        this.name = "AIError";
        this.code = code;
        this.isRetryable = isRetryable;
        this.userMessage = userMessage;
    }
}

const NO_INTERNET_AI_MESSAGE =
    "No internet connection. Reconnect and try again.";

function parseGeminiError(status: number, body: string): AIError {
    try {
        const parsed = JSON.parse(body);
        const error: GeminiError = parsed.error ?? parsed;
        const msg = error.message ?? "Unknown error";

        if (status === 429) {
            return new AIError(
                429,
                msg,
                "⏳ Rate limit reached. Please wait a moment and try again.",
                true
            );
        }
        if (status === 403) {
            if (msg.toLowerCase().includes("quota")) {
                return new AIError(
                    403,
                    msg,
                    "📊 API quota exceeded. Check your Google AI Studio billing or wait for the quota to reset.",
                    false
                );
            }
            return new AIError(
                403,
                msg,
                "🔑 Invalid API key. Please check your Gemini API key in Settings → AI.",
                false
            );
        }
        if (status === 400) {
            return new AIError(
                400,
                msg,
                "⚠️ Invalid request. The query may be too long or contain unsupported content.",
                false
            );
        }
        if (status >= 500) {
            return new AIError(
                status,
                msg,
                "🔧 Gemini API is temporarily unavailable. Please try again in a few seconds.",
                true
            );
        }
        return new AIError(status, msg, `❌ API error: ${msg}`, false);
    } catch {
        return new AIError(
            status,
            body,
            `❌ Unexpected error (HTTP ${status}). Please try again.`,
            true
        );
    }
}

async function throwIfGeminiResponseNotOk(res: Response): Promise<void> {
    if (res.ok) return;
    const errorBody = await res.text();
    if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        const sec = ra ? parseInt(ra, 10) : NaN;
        const hint = Number.isFinite(sec) && sec > 0 ? ` Try again in about ${sec}s.` : "";
        throw new AIError(
            429,
            errorBody,
            `⏳ Rate limit reached.${hint}`,
            true
        );
    }
    throw parseGeminiError(res.status, errorBody);
}

function mapNoInternetError(error: unknown): AIError | null {
    if (!isNoInternetError(error)) return null;
    notifyNoInternetDetected(error);
    return new AIError(0, NO_INTERNET_AI_MESSAGE, NO_INTERNET_AI_MESSAGE, true);
}

/**
 * Streaming call to Gemini API with SSE parsing.
 * Calls onChunk for each text delta received.
 */
export async function callGeminiStream(
    model: GeminiModelId,
    apiKey: string,
    messages: GeminiMessage[],
    systemPrompt: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal
): Promise<string> {
    const proxyBase = getGeminiProxyBaseUrl();
    const url = proxyBase
        ? `${proxyBase}/stream-generate-content?model=${encodeURIComponent(model)}`
        : `${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }],
        },
        contents: messages,
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096,
            topP: 0.95,
            topK: 40,
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
    };

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: proxyBase
                ? {
                      "Content-Type": "application/json",
                      [GOOGLE_API_KEY_HEADER]: apiKey,
                  }
                : { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        const noInternetError = mapNoInternetError(error);
        if (noInternetError) throw noInternetError;
        throw error;
    }

    await throwIfGeminiResponseNotOk(res);

    if (!res.body) {
        throw new AIError(0, "No response body", "❌ Empty response from Gemini API.", true);
    }

    let fullResponse = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = line.slice(6).trim();
                    if (!data || data === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(data);
                        const text =
                            parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                        if (text) {
                            fullResponse += text;
                            onChunk(text);
                        }
                    } catch {
                        // Skip malformed JSON chunks
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    return fullResponse;
}

/**
 * Non-streaming call to Gemini API for quick operations.
 * Pass options.maxOutputTokens to allow longer responses (e.g. 8192 for full schema JSON).
 */
export async function callGeminiSync(
    model: GeminiModelId,
    apiKey: string,
    messages: GeminiMessage[],
    systemPrompt: string,
    signal?: AbortSignal,
    options?: { maxOutputTokens?: number }
): Promise<string> {
    const proxyBase = getGeminiProxyBaseUrl();
    const url = proxyBase
        ? `${proxyBase}/generate-content?model=${encodeURIComponent(model)}`
        : `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }],
        },
        contents: messages,
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: options?.maxOutputTokens ?? 4096,
            topP: 0.95,
            topK: 40,
        },
    };

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: proxyBase
                ? {
                      "Content-Type": "application/json",
                      [GOOGLE_API_KEY_HEADER]: apiKey,
                  }
                : { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        const noInternetError = mapNoInternetError(error);
        if (noInternetError) throw noInternetError;
        throw error;
    }

    await throwIfGeminiResponseNotOk(res);

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ── Conversation Memory ──────────────────────────────────────────────────────

export interface ImageAttachment {
    mimeType: string;
    base64: string;
    previewUrl?: string; // data: URL for display
}

interface ConversationTurn {
    role: "user" | "model";
    content: string;
    images?: ImageAttachment[];
}

const MAX_CONVERSATION_TURNS = 20;

/** Build GeminiMessage parts from a turn, including images */
function buildParts(turn: ConversationTurn): GeminiPart[] {
    const parts: GeminiPart[] = [];
    if (turn.images?.length) {
        for (const img of turn.images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
    }
    parts.push({ text: turn.content });
    return parts;
}

// ── AIChatEngine (Singleton) ─────────────────────────────────────────────────

export class AIChatEngine {
    private static instance: AIChatEngine;
    private conversations: Map<string, ConversationTurn[]> = new Map();
    private abortController: AbortController | null = null;

    private constructor() { }

    static getInstance(): AIChatEngine {
        if (!AIChatEngine.instance) {
            AIChatEngine.instance = new AIChatEngine();
        }
        return AIChatEngine.instance;
    }

    /**
     * Send a message and stream the AI response.
     */
    async sendMessage(
        conversationId: string,
        userMessage: string,
        compressedSchema: string,
        model: GeminiModelId,
        apiKey: string,
        onChunk: (text: string) => void,
        images?: ImageAttachment[],
        contextText?: string
    ): Promise<string> {
        if (!apiKey) {
            throw new AIError(
                0,
                "No API key",
                "🔑 Please add your Gemini API key in Settings → AI to start using the AI assistant.",
                false
            );
        }

        // Get or create conversation history
        if (!this.conversations.has(conversationId)) {
            this.conversations.set(conversationId, []);
        }
        const history = this.conversations.get(conversationId)!;

        // Add user message to history
        history.push({ role: "user", content: userMessage, images });

        // Trim history to max turns
        while (history.length > MAX_CONVERSATION_TURNS * 2) {
            history.shift();
        }

        // Build Gemini messages from conversation history
        const geminiMessages: GeminiMessage[] = history.map((turn) => ({
            role: turn.role,
            parts: buildParts(turn),
        }));

        const systemPrompt = buildSystemPrompt(compressedSchema, contextText);

        // Cancel any in-flight request
        this.abortController?.abort();
        this.abortController = new AbortController();

        const _logStart = Date.now();
        const _logTs = new Date().toISOString();
        try {
            const response = await callGeminiStream(
                model,
                apiKey,
                geminiMessages,
                systemPrompt,
                onChunk,
                this.abortController.signal
            );

            // Add AI response to history
            history.push({ role: "model", content: response });

            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _logTs,
                responseTime: Date.now() - _logStart,
                status: "success",
                provider: "google_gemini",
                stream: true,
            });

            return response;
        } catch (error) {
            // Remove the user message if the request failed
            history.pop();

            const isAbort = error instanceof DOMException && error.name === "AbortError";
            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _logTs,
                responseTime: Date.now() - _logStart,
                status: isAbort ? "aborted" : "error",
                errorMessage: error instanceof Error ? error.message : String(error),
                errorCode: (error as { code?: number })?.code,
                provider: "google_gemini",
                stream: true,
            });

            if (isAbort) {
                throw new AIError(0, "Aborted", "Request was cancelled.", false);
            }
            throw error;
        }
    }

    /**
     * Regenerate the last AI response.
     */
    async regenerateLastResponse(
        conversationId: string,
        compressedSchema: string,
        model: GeminiModelId,
        apiKey: string,
        onChunk: (text: string) => void,
        contextText?: string
    ): Promise<string> {
        const history = this.conversations.get(conversationId);
        if (!history || history.length < 2) {
            throw new AIError(0, "No history", "Nothing to regenerate.", false);
        }

        // Remove the last AI response
        if (history[history.length - 1].role === "model") {
            history.pop();
        }

        // Get the last user message
        const lastUserMsg = history[history.length - 1];
        if (lastUserMsg.role !== "user") {
            throw new AIError(0, "Invalid state", "Cannot regenerate from this point.", false);
        }

        // Re-send with the existing history (which now ends with the user message)
        const geminiMessages: GeminiMessage[] = history.map((turn) => ({
            role: turn.role,
            parts: buildParts(turn),
        }));

        const systemPrompt = buildSystemPrompt(compressedSchema, contextText);

        this.abortController?.abort();
        this.abortController = new AbortController();

        const _regenStart = Date.now();
        const _regenTs = new Date().toISOString();
        try {
            const response = await callGeminiStream(
                model,
                apiKey,
                geminiMessages,
                systemPrompt,
                onChunk,
                this.abortController.signal
            );

            history.push({ role: "model", content: response });
            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _regenTs,
                responseTime: Date.now() - _regenStart,
                status: "success",
                provider: "google_gemini",
                stream: true,
            });
            return response;
        } catch (error) {
            const isAbort = error instanceof DOMException && error.name === "AbortError";
            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _regenTs,
                responseTime: Date.now() - _regenStart,
                status: isAbort ? "aborted" : "error",
                errorMessage: error instanceof Error ? error.message : String(error),
                errorCode: (error as { code?: number })?.code,
                provider: "google_gemini",
                stream: true,
            });
            if (isAbort) {
                throw new AIError(0, "Aborted", "Request was cancelled.", false);
            }
            throw error;
        }
    }

    /**
     * Edit a user message and regenerate from that point.
     */
    async editAndRegenerate(
        conversationId: string,
        messageIndex: number,
        newContent: string,
        compressedSchema: string,
        model: GeminiModelId,
        apiKey: string,
        onChunk: (text: string) => void,
        contextText?: string
    ): Promise<string> {
        const history = this.conversations.get(conversationId);
        if (!history) {
            throw new AIError(0, "No history", "No conversation found.", false);
        }

        // Truncate history to the edited message and update it
        history.length = messageIndex + 1;
        history[messageIndex] = { role: "user", content: newContent };

        // Build messages and stream
        const geminiMessages: GeminiMessage[] = history.map((turn) => ({
            role: turn.role,
            parts: buildParts(turn),
        }));

        const systemPrompt = buildSystemPrompt(compressedSchema, contextText);

        this.abortController?.abort();
        this.abortController = new AbortController();

        const _editStart = Date.now();
        const _editTs = new Date().toISOString();
        try {
            const response = await callGeminiStream(
                model,
                apiKey,
                geminiMessages,
                systemPrompt,
                onChunk,
                this.abortController.signal
            );

            history.push({ role: "model", content: response });
            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _editTs,
                responseTime: Date.now() - _editStart,
                status: "success",
                provider: "google_gemini",
                stream: true,
            });
            return response;
        } catch (error) {
            const isAbort = error instanceof DOMException && error.name === "AbortError";
            geminiLogger.log({
                model,
                featureType: "chat",
                endpoint: "streamGenerateContent",
                requestTimestamp: _editTs,
                responseTime: Date.now() - _editStart,
                status: isAbort ? "aborted" : "error",
                errorMessage: error instanceof Error ? error.message : String(error),
                errorCode: (error as { code?: number })?.code,
                provider: "google_gemini",
                stream: true,
            });
            if (isAbort) {
                throw new AIError(0, "Aborted", "Request was cancelled.", false);
            }
            throw error;
        }
    }

    /**
     * Stop the current streaming request.
     */
    stopStreaming(): void {
        this.abortController?.abort();
        this.abortController = null;
    }

    /**
     * Clear conversation memory for a specific conversation.
     */
    clearConversation(conversationId: string): void {
        this.conversations.delete(conversationId);
    }

    /**
     * Clear all conversation memory.
     */
    clearAll(): void {
        this.conversations.clear();
    }

    /**
     * Sync engine memory with persisted conversation history.
     * Called when loading conversations from localStorage.
     */
    syncHistory(conversationId: string, turns: ConversationTurn[]): void {
        this.conversations.set(conversationId, [...turns]);
    }
}

// Export singleton
export const aiChatEngine = AIChatEngine.getInstance();
