import { callGeminiSync } from "@/lib/ai-chat-engine";
import type { GeminiModelId } from "@/lib/ai-chat-engine";
import { AIError } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import { getResolvedGeminiApiKey, useSettingsStore } from "@/stores/settings-store";
import {
    buildHotspotsAiJsonBlob,
    type PlanHierarchyNode,
    topHotspotNodes,
} from "@/lib/query-plan-hierarchy";

const SYSTEM = `You are a PostgreSQL query-plan performance expert. You receive JSON describing the top execution hotspots (by measured time or planner cost).

Respond with ONLY a JSON object (no markdown fences) of this exact shape:
{"insights":[{"pathId":"string","sentence":"string"}]}

Rules:
- Exactly one sentence per pathId, max 220 characters each.
- Explain WHY that node is expensive or risky (I/O, join strategy, bad row estimates, seq scan, sort spill, etc.).
- Use pathId values exactly as given; same array length and order as the hotspots in the user message.
- No preamble, no trailing text.`;

export interface PlanHotspotInsight {
    pathId: string;
    sentence: string;
}

export interface ExplainPlanInsightsOptions {
    model?: GeminiModelId;
    signal?: AbortSignal;
    /** Optional SQL for context (trimmed). */
    sql?: string;
}

function parseInsightsResponse(text: string): PlanHotspotInsight[] {
    const trimmed = text.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    try {
        const o = JSON.parse(jsonMatch[0]) as { insights?: unknown };
        if (!Array.isArray(o.insights)) return [];
        return o.insights
            .map((row) => {
                if (!row || typeof row !== "object") return null;
                const r = row as { pathId?: unknown; sentence?: unknown };
                if (typeof r.pathId !== "string" || typeof r.sentence !== "string") return null;
                return { pathId: r.pathId, sentence: r.sentence.trim() };
            })
            .filter((x): x is PlanHotspotInsight => x !== null);
    } catch {
        return [];
    }
}

/**
 * One Gemini call: one-sentence "why slow" per top-3 hotspot nodes.
 */
export async function explainPlanHotspotsWithGemini(
    hierarchyRoot: PlanHierarchyNode,
    options?: ExplainPlanInsightsOptions
): Promise<PlanHotspotInsight[]> {
    const settings = useSettingsStore.getState();
    const apiKey = getResolvedGeminiApiKey();
    const model: GeminiModelId = (options?.model ??
        settings.defaultAiModel ??
        "gemini-2.5-flash") as GeminiModelId;

    if (!apiKey) {
        throw new AIError(
            0,
            "No API key",
            "Add your Gemini API key in Settings → AI or set NEXT_PUBLIC_GEMINI_API_KEY.",
            false
        );
    }

    const hotspots = topHotspotNodes(hierarchyRoot, 3);
    if (hotspots.length === 0) return [];

    const payload = buildHotspotsAiJsonBlob(hotspots);
    const userParts = [
        "Hotspots (JSON):",
        payload,
        "",
        "Return {\"insights\":[{\"pathId\":\"...\",\"sentence\":\"...\"},...]} in the same order.",
    ];
    if (options?.sql?.trim()) {
        userParts.push("", "Query SQL (context):", options.sql.trim().slice(0, 6000));
    }
    const userPrompt = userParts.join("\n");

    const raw = await withGeminiLogging(
        () =>
            callGeminiSync(
                model,
                apiKey,
                [{ role: "user", parts: [{ text: userPrompt }] }],
                SYSTEM,
                options?.signal,
                { maxOutputTokens: 1024 }
            ),
        { model, featureType: "query-plan-insights", endpoint: "generateContent" }
    );

    const parsed = parseInsightsResponse(raw?.trim() ?? "");
    if (parsed.length === 0) return [];

    const byPath = new Map(parsed.map((p) => [p.pathId, p.sentence]));
    return hotspots.map((h) => ({
        pathId: h.pathId,
        sentence:
            byPath.get(h.pathId)?.slice(0, 400) ??
            "Could not generate an explanation for this node.",
    }));
}
