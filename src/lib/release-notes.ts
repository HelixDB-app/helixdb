const WEB_BASE_URL =
    process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";

export interface ReleaseNote {
    id: string;
    version: string;
    title: string;
    summary?: string;
    content: Record<string, unknown>;
    tags: string[];
    majorUpdate: boolean;
    pinned: boolean;
    publishedAt: string;
    createdAt: string;
}

export interface ReleaseNotesResponse {
    notes: ReleaseNote[];
    nextCursor: string | null;
}

export async function fetchReleaseNotes(limit = 10, after?: string): Promise<ReleaseNotesResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);

    const res = await fetch(`${WEB_BASE_URL}/api/release-notes?${params.toString()}`);
    if (!res.ok) throw new Error(`Failed to fetch release notes: ${res.status}`);
    return res.json() as Promise<ReleaseNotesResponse>;
}

/** Extract plain-text summary from Novel JSON content */
export function extractTextSummary(content: Record<string, unknown>, maxChars = 200): string {
    try {
        const nodes = (content.content as Array<Record<string, unknown>>) ?? [];
        const texts: string[] = [];

        function walk(nodes: Array<Record<string, unknown>>) {
            for (const node of nodes) {
                if (node.type === "text" && node.text) {
                    texts.push(String(node.text));
                } else if (node.content) {
                    walk(node.content as Array<Record<string, unknown>>);
                }
            }
        }

        walk(nodes);
        const full = texts.join(" ").trim();
        return full.length > maxChars ? full.slice(0, maxChars) + "…" : full;
    } catch {
        return "";
    }
}

export const TAG_COLORS: Record<string, string> = {
    feature: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    bugfix: "bg-red-500/15 text-red-400 border-red-500/30",
    improvement: "bg-green-500/15 text-green-400 border-green-500/30",
    security: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    breaking: "bg-purple-500/15 text-purple-400 border-purple-500/30",
};
