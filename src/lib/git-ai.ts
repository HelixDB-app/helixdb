import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import { getResolvedGeminiApiKey, resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import type { GitAiProvider } from "@/stores/settings-store";

interface CommitMessageInput {
    diffSummary: string;
    stagedCount: number;
    currentMessage?: string;
    rewrite?: boolean;
}

interface PullRequestDraftInput {
    diffSummary: string;
    headBranch: string;
    baseBranch: string;
    commitMessages: string[];
}

export interface PullRequestDraft {
    title: string;
    body: string;
}

const MAX_DIFF_CHARS = 8000;
const MAX_COMMITS = 12;
const CLOUDFLARE_DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function getGeminiConfig(): { model: GeminiModelId; apiKey: string } {
    const settings = useSettingsStore.getState();
    const apiKey = resolveGeminiApiKey(settings.geminiApiKey);
    if (!apiKey) {
        throw new Error("Gemini API key is missing. Add it in Settings or set NEXT_PUBLIC_GEMINI_API_KEY.");
    }
    const model = (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId;
    return { model, apiKey };
}

function getCloudflareConfig(): {
    accountId: string;
    apiToken: string;
    model: string;
} {
    const settings = useSettingsStore.getState();
    const accountId =
        settings.cloudflareAccountId?.trim() ||
        process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID?.trim() ||
        "";
    const apiToken =
        settings.cloudflareApiToken?.trim() ||
        process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN?.trim() ||
        "";
    const model =
        settings.cloudflareModel?.trim() ||
        process.env.NEXT_PUBLIC_CLOUDFLARE_MODEL?.trim() ||
        CLOUDFLARE_DEFAULT_MODEL;

    if (!accountId) {
        throw new Error("Cloudflare Account ID is missing. Set it in Settings → AI.");
    }
    if (!apiToken) {
        throw new Error("Cloudflare API token is missing. Set it in Settings → AI.");
    }

    return { accountId, apiToken, model };
}

function trimDiff(diffSummary: string): string {
    return diffSummary.slice(0, MAX_DIFF_CHARS).trim();
}

function stripMarkdownCodeFences(raw: string): string {
    return raw
        .trim()
        .replace(/^```(?:json|markdown|md|text)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();
}

function normalizeCommitMessage(raw: string): string {
    const text = stripMarkdownCodeFences(raw)
        .replace(/^["'`]|["'`]$/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^(commit message|message)\s*:\s*/i, ""));

    const firstLine = text[0] ?? "";
    return firstLine.slice(0, 120);
}

function tryParseJson(raw: string): Record<string, unknown> | null {
    const cleaned = stripMarkdownCodeFences(raw);
    try {
        const parsed = JSON.parse(cleaned) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through
    }

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const maybeJson = cleaned.slice(firstBrace, lastBrace + 1);
        try {
            const parsed = JSON.parse(maybeJson) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // ignore
        }
    }
    return null;
}

async function runGeminiPrompt(prompt: string, maxOutputTokens: number): Promise<string> {
    const { model, apiKey } = getGeminiConfig();
    const systemPrompt = [
        "You are an expert software engineer and Git assistant.",
        "You write concise, accurate, high-signal commit and pull-request text.",
        "Do not invent files or behavior. Use only provided changes.",
    ].join("\n");

    const response = await withGeminiLogging(
        () =>
            callGeminiSync(
                model,
                apiKey,
                [{ role: "user", parts: [{ text: prompt }] }],
                systemPrompt,
                undefined,
                { maxOutputTokens }
            ),
        { model, featureType: "git", endpoint: "generateContent" }
    );

    return response.trim();
}

function extractCloudflareText(result: unknown): string {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return "";
    const data = result as Record<string, unknown>;

    if (typeof data.response === "string") return data.response;
    if (typeof data.text === "string") return data.text;

    if (Array.isArray(data.output_text)) {
        return data.output_text.filter((v): v is string => typeof v === "string").join("\n");
    }

    if (Array.isArray(data.output)) {
        const chunks = data.output
            .map((item) => {
                if (!item || typeof item !== "object") return "";
                const row = item as Record<string, unknown>;
                if (typeof row.content === "string") return row.content;
                if (Array.isArray(row.content)) {
                    return row.content
                        .map((part) => {
                            if (!part || typeof part !== "object") return "";
                            const segment = part as Record<string, unknown>;
                            return typeof segment.text === "string" ? segment.text : "";
                        })
                        .join("");
                }
                if (typeof row.text === "string") return row.text;
                return "";
            })
            .filter(Boolean);
        return chunks.join("\n");
    }

    return "";
}

async function runCloudflarePrompt(prompt: string, maxOutputTokens: number): Promise<string> {
    const { accountId, apiToken, model } = getCloudflareConfig();
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${encodeURIComponent(model)}`;
    const systemPrompt = [
        "You are an expert software engineer and Git assistant.",
        "You write concise, accurate, high-signal commit and pull-request text.",
        "Do not invent files or behavior. Use only provided changes.",
    ].join("\n");

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
            max_tokens: maxOutputTokens,
            temperature: 0.2,
            stream: false,
        }),
    });

    const payload = await res.json().catch(() => null);
    const cloudflareError =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { errors?: unknown[] }).errors) &&
        (payload as { errors: unknown[] }).errors.length > 0
            ? String((payload as { errors: Array<{ message?: string }> }).errors[0]?.message ?? "")
            : "";
    const success =
        payload && typeof payload === "object" && typeof (payload as { success?: unknown }).success === "boolean"
            ? Boolean((payload as { success: boolean }).success)
            : true;

    if (!res.ok || !success) {
        throw new Error(
            cloudflareError ||
            `Cloudflare AI request failed (${res.status}). Check Account ID, token, and model.`
        );
    }

    const result = payload && typeof payload === "object" ? (payload as { result?: unknown }).result : null;
    const text = extractCloudflareText(result);
    if (!text.trim()) {
        throw new Error("Cloudflare AI returned an empty response.");
    }
    return text.trim();
}

async function runGitPrompt(prompt: string, maxOutputTokens: number): Promise<string> {
    const provider = (useSettingsStore.getState().gitAiProvider ?? "cloudflare") as GitAiProvider;
    if (provider === "cloudflare") {
        try {
            return await runCloudflarePrompt(prompt, maxOutputTokens);
        } catch (cloudflareError) {
            // Fallback to Gemini if the user already has Gemini configured.
            const hasGemini = Boolean(getResolvedGeminiApiKey());
            if (!hasGemini) throw cloudflareError;
            return runGeminiPrompt(prompt, maxOutputTokens);
        }
    }
    return runGeminiPrompt(prompt, maxOutputTokens);
}

export async function generateAiCommitMessage(input: CommitMessageInput): Promise<string> {
    const diff = trimDiff(input.diffSummary);
    if (!diff) {
        throw new Error("No staged changes available for AI commit generation.");
    }

    const rewritePrompt =
        input.rewrite && input.currentMessage?.trim()
            ? `Rewrite this draft commit message to be clearer and more precise while preserving intent:
${input.currentMessage.trim()}`
            : "Write a new commit message for these staged changes.";

    const prompt = [
        rewritePrompt,
        "",
        "Rules:",
        "- Use Conventional Commits format: type(scope): subject OR type: subject",
        "- Subject line in imperative mood, max 72 chars if possible",
        "- No markdown, no quotes, no bullet points",
        "- Return exactly one line",
        "",
        `Staged files count: ${input.stagedCount}`,
        "",
        "Diff summary:",
        diff,
    ].join("\n");

    const raw = await runGitPrompt(prompt, 160);
    const message = normalizeCommitMessage(raw);
    if (!message) {
        throw new Error("AI did not return a valid commit message.");
    }
    return message;
}

export async function generateAiPullRequestDraft(input: PullRequestDraftInput): Promise<PullRequestDraft> {
    const diff = trimDiff(input.diffSummary);
    const commitLines = input.commitMessages
        .slice(0, MAX_COMMITS)
        .map((msg) => `- ${msg.trim()}`)
        .join("\n");

    if (!diff && !commitLines) {
        throw new Error("No changes available to generate PR content.");
    }

    const prompt = [
        "Generate a pull request title and description.",
        `Branch flow: ${input.headBranch} -> ${input.baseBranch}`,
        "",
        "Output strictly as JSON with this exact shape:",
        '{"title":"...", "body":"..."}',
        "",
        "Title rules:",
        "- Specific, concise, reviewer-friendly",
        "- No trailing punctuation",
        "",
        "Body rules:",
        "- Markdown format",
        "- Include sections: ## Summary, ## Changes, ## Testing",
        "- Use concrete bullets under Changes",
        "- If testing info is unknown, include '- Not run (local changes only)'",
        "",
        "Commits:",
        commitLines || "- No recent commits available",
        "",
        "Diff summary:",
        diff || "No diff summary available",
    ].join("\n");

    const raw = await runGitPrompt(prompt, 1200);
    const parsed = tryParseJson(raw);

    const titleRaw = typeof parsed?.title === "string" ? parsed.title : "";
    const bodyRaw = typeof parsed?.body === "string" ? parsed.body : "";
    const title = titleRaw.trim();
    const body = bodyRaw.trim();

    if (title && body) {
        return { title, body };
    }

    const plain = stripMarkdownCodeFences(raw);
    const lines = plain.split("\n").map((line) => line.trim()).filter(Boolean);
    const fallbackTitle = (lines[0] ?? "Update code changes").replace(/^#*\s*/, "").slice(0, 120);
    const fallbackBody = body || `## Summary\n- Update ${input.headBranch} for merge into ${input.baseBranch}\n\n## Changes\n- See commit list and diff summary\n\n## Testing\n- Not run (local changes only)`;

    return {
        title: title || fallbackTitle,
        body: fallbackBody,
    };
}
