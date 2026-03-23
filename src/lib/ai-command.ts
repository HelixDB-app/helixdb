import { callGeminiSync, type GeminiModelId, GEMINI_MODELS } from "@/lib/ai-chat-engine";
import { AIError } from "@/lib/ai-chat-engine";
import { geminiLogger, withGeminiLogging } from "@/lib/gemini-logger";
import { notifyNoInternetDetected } from "@/lib/network-errors";
import { isTauriRuntime } from "@/lib/runtime";
import { aiSuggestionsWorkerPost } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settings-store";

export type AiCommandModel = "auto" | "cloudflare" | GeminiModelId;

export type AiCommandContext = {
    instruction: string;
    fullText: string;
    selectionText?: string;
    selectionStart?: number;
    selectionEnd?: number;
    language?: string;
    model: AiCommandModel;
    signal?: AbortSignal;
    maxContextChars?: number;
};

export type AiCommandResponse = {
    text: string;
    modelUsed: string;
};

export const AI_COMMAND_MODEL_OPTIONS: Array<{ id: AiCommandModel; label: string; description?: string }> = [
    { id: "auto", label: "Auto" },
    ...Object.values(GEMINI_MODELS).map((model) => ({
        id: model.id,
        label: model.displayName,
        description: model.description,
    })),
    { id: "cloudflare", label: "Cloudflare AI", description: "Use your Cloudflare Worker" },
];

const RESPONSE_START = "<RESPONSE>";
const RESPONSE_END = "</RESPONSE>";

function stripCodeFences(text: string): string {
    const fenceMatch = text.match(/```(?:sql|text|plaintext)?\n([\s\S]*?)```/i);
    if (fenceMatch) return fenceMatch[1].trim();
    return text.replace(/^```+/, "").replace(/```+$/, "").trim();
}

function extractAiResponse(text: string): string {
    if (!text) return "";
    const tagged = text.match(/<RESPONSE>([\s\S]*?)<\/RESPONSE>/i);
    if (tagged) return tagged[1].trim();
    return stripCodeFences(text).trim();
}

function sliceAround(fullText: string, start: number, end: number, maxChars: number): string {
    if (fullText.length <= maxChars) return fullText;
    const midpoint = Math.floor((start + end) / 2);
    const half = Math.floor(maxChars / 2);
    let from = Math.max(0, midpoint - half);
    let to = Math.min(fullText.length, from + maxChars);
    if (to - from < maxChars) {
        from = Math.max(0, to - maxChars);
    }
    const prefix = from > 0 ? "...\n" : "";
    const suffix = to < fullText.length ? "\n..." : "";
    return `${prefix}${fullText.slice(from, to)}${suffix}`;
}

function sliceHeadTail(fullText: string, maxChars: number): string {
    if (fullText.length <= maxChars) return fullText;
    const headSize = Math.max(1000, Math.floor(maxChars * 0.6));
    const tailSize = Math.max(600, maxChars - headSize - 10);
    const head = fullText.slice(0, headSize).trimEnd();
    const tail = fullText.slice(-tailSize).trimStart();
    return `${head}\n...\n${tail}`;
}

function buildSystemPrompt(hasSelection: boolean, language: string): string {
    const scope = hasSelection
        ? "You will receive a full file and a selection. Return ONLY the replacement text for the selection."
        : "You will receive a full file. Return the FULL updated file text.";
    return `You are an expert code editor assistant inside a database IDE.\n${scope}\n\nRules:\n- Output ONLY the updated code between ${RESPONSE_START} and ${RESPONSE_END}.\n- No markdown fences, no explanations.\n- Preserve indentation and formatting.\n- Keep changes minimal and relevant.\n- Language: ${language}.`;
}

function buildUserPrompt(instruction: string, fullText: string, selectionText: string | undefined): string {
    const parts = [
        `Instruction:\n${instruction.trim()}`,
        "\nFull file context:",
        fullText.trimEnd(),
    ];
    if (selectionText !== undefined) {
        parts.push("\nSelected text:");
        parts.push(selectionText.trimEnd());
    }
    parts.push(`\nRespond with ${RESPONSE_START}...${RESPONSE_END} only.`);
    return parts.join("\n");
}

function extractWorkerResponseText(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const d = data as Record<string, unknown>;
    const result = d.result;
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
        const rObj = result as { response?: unknown; text?: unknown; output?: unknown; completion?: unknown };
        if (typeof rObj.response === "string") return rObj.response;
        if (typeof rObj.text === "string") return rObj.text;
        if (typeof rObj.output === "string") return rObj.output;
        if (typeof rObj.completion === "string") return rObj.completion;
    }
    if (typeof d.response === "string") return d.response;
    if (typeof d.output === "string") return d.output;
    if (typeof d.text === "string") return d.text;
    if (typeof d.completion === "string") return d.completion;
    const choices = d.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const msg = (choices[0] as { message?: { content?: unknown } }).message;
        if (msg && typeof msg.content === "string") return msg.content;
    }
    return "";
}

async function postJson(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (isTauriRuntime()) {
        const raw = await aiSuggestionsWorkerPost(url, body);
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AI request failed (${res.status}): ${text}`);
    }
    return res.json();
}

async function runCloudflareCommand(
    instruction: string,
    fullText: string,
    selectionText: string | undefined,
    language: string,
    signal?: AbortSignal
): Promise<string> {
    const settings = useSettingsStore.getState();
    const workerUrl = settings.aiWorkerUrl?.trim() ?? "";
    if (!workerUrl) {
        throw new AIError(0, "Missing AI worker URL", "Set an AI Worker URL in Settings → AI.", false);
    }
    const model = settings.cloudflareModel?.trim() || "@cf/meta/llama-3.1-8b-instruct";
    const systemPrompt = buildSystemPrompt(Boolean(selectionText), language);
    const userPrompt = buildUserPrompt(instruction, fullText, selectionText);
    const body = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 2048,
        stream: false,
        skipCache: true,
    };

    const requestTimestamp = new Date().toISOString();
    const start = Date.now();
    try {
        const data = await postJson(workerUrl, body, signal);
        const raw = typeof data === "string" ? data : extractWorkerResponseText(data);
        const workerProvider =
            model.startsWith("@cf/") ? "cloudflare_workers" : "custom_http_worker";
        geminiLogger.log({
            model,
            featureType: "ai_command",
            endpoint: "worker_chat",
            requestTimestamp,
            responseTime: Date.now() - start,
            status: "success",
            provider: workerProvider,
            stream: false,
        });
        return extractAiResponse(raw);
    } catch (error: unknown) {
        const isAbort = error instanceof DOMException && error.name === "AbortError";
        const workerProvider =
            model.startsWith("@cf/") ? "cloudflare_workers" : "custom_http_worker";
        geminiLogger.log({
            model,
            featureType: "ai_command",
            endpoint: "worker_chat",
            requestTimestamp,
            responseTime: Date.now() - start,
            status: isAbort ? "aborted" : "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            provider: workerProvider,
            stream: false,
        });
        throw error;
    }
}

async function runGeminiCommand(
    model: GeminiModelId,
    instruction: string,
    fullText: string,
    selectionText: string | undefined,
    language: string,
    signal?: AbortSignal
): Promise<string> {
    const settings = useSettingsStore.getState();
    const apiKey = settings.geminiApiKey?.trim() ?? "";
    if (!apiKey) {
        throw new AIError(0, "No API key", "Add your Gemini API key in Settings → AI to use Gemini.", false);
    }
    const systemPrompt = buildSystemPrompt(Boolean(selectionText), language);
    const userPrompt = buildUserPrompt(instruction, fullText, selectionText);

    const raw = await withGeminiLogging(
        () =>
            callGeminiSync(
                model,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                systemPrompt,
                signal,
                { maxOutputTokens: 4096 }
            ),
        {
            model,
            featureType: "ai_command",
            endpoint: "generateContent",
            provider: "google_gemini",
        }
    );
    return extractAiResponse(raw);
}

export async function runAiCommand(context: AiCommandContext): Promise<AiCommandResponse> {
    const settings = useSettingsStore.getState();
    const instruction = context.instruction.trim();
    if (!instruction) {
        throw new Error("Instruction is required.");
    }

    const language = context.language ?? "SQL";
    const maxContext = Math.max(2000, Math.min(context.maxContextChars ?? 8000, 20000));

    const fullText = context.fullText ?? "";
    const selectionText = context.selectionText;

    const hasSelection = Boolean(selectionText);
    const start = context.selectionStart ?? 0;
    const end = context.selectionEnd ?? start;
    const resolvedFullText = hasSelection
        ? sliceAround(fullText, start, end, maxContext)
        : sliceHeadTail(fullText, maxContext);

    let modelUsed: string = context.model;
    try {
        if (context.model === "cloudflare") {
            const text = await runCloudflareCommand(instruction, resolvedFullText, selectionText, language, context.signal);
            return { text, modelUsed: "cloudflare" };
        }

        if (context.model === "auto") {
            const apiKey = settings.geminiApiKey?.trim() ?? "";
            if (!apiKey && settings.aiWorkerUrl?.trim()) {
                const text = await runCloudflareCommand(instruction, resolvedFullText, selectionText, language, context.signal);
                return { text, modelUsed: "cloudflare" };
            }
            const defaultModel = settings.defaultAiModel as GeminiModelId;
            modelUsed = defaultModel;
            const text = await runGeminiCommand(defaultModel, instruction, resolvedFullText, selectionText, language, context.signal);
            return { text, modelUsed };
        }

        const model = context.model as GeminiModelId;
        modelUsed = model;
        const text = await runGeminiCommand(model, instruction, resolvedFullText, selectionText, language, context.signal);
        return { text, modelUsed };
    } catch (error) {
        if (notifyNoInternetDetected(error)) {
            throw new Error("No internet connection detected.");
        }
        throw error;
    }
}
