import type { JSONContent } from "novel";

const DOC_EXTENSION = "doc";

type JsonObject = Record<string, unknown>;

export interface ParseDocContentResult {
    data: JSONContent;
    normalizedContent: string;
    wasNormalized: boolean;
    parseError: string | null;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null;
}

function sanitizeMarks(value: unknown): JSONContent["marks"] {
    if (!Array.isArray(value)) return undefined;

    const marks = value.flatMap((candidate) => {
        if (!isObject(candidate)) return [];
        const type = typeof candidate.type === "string" && candidate.type.trim().length > 0
            ? candidate.type
            : null;
        if (!type) return [];

        const next: NonNullable<JSONContent["marks"]>[number] = { type };
        if (isObject(candidate.attrs)) {
            next.attrs = candidate.attrs;
        }
        return [next];
    });

    return marks.length > 0 ? marks : undefined;
}

function sanitizeNode(value: unknown, depth = 0): JSONContent | null {
    if (!isObject(value) || depth > 40) return null;

    const nodeType = typeof value.type === "string" && value.type.trim().length > 0
        ? value.type
        : "paragraph";

    const node: JSONContent = {
        type: nodeType,
    };

    if (isObject(value.attrs)) {
        node.attrs = value.attrs;
    }

    if (typeof value.text === "string") {
        node.text = value.text;
    }

    const marks = sanitizeMarks(value.marks);
    if (marks && marks.length > 0) {
        node.marks = marks;
    }

    if (Array.isArray(value.content)) {
        const children = value.content
            .map((entry) => sanitizeNode(entry, depth + 1))
            .filter((entry): entry is JSONContent => entry !== null);
        if (children.length > 0) {
            node.content = children;
        }
    }

    return node;
}

function paragraphNode(text = ""): JSONContent {
    return {
        type: "paragraph",
        ...(text
            ? {
                content: [
                    {
                        type: "text",
                        text,
                    },
                ],
            }
            : {}),
    };
}

function normalizeDocData(value: unknown): JSONContent {
    if (!isObject(value)) {
        return createDefaultDocData();
    }

    const root = sanitizeNode(value);
    if (!root) {
        return createDefaultDocData();
    }

    const content = Array.isArray(root.content)
        ? root.content.filter((node): node is JSONContent => Boolean(node && typeof node.type === "string"))
        : [];

    return {
        ...root,
        type: "doc",
        content: content.length > 0 ? content : [paragraphNode()],
    };
}

function buildDocDataFromPlainText(content: string): JSONContent {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim());

    const paragraphs = lines
        .filter((line) => line.length > 0)
        .map((line) => paragraphNode(line));

    if (paragraphs.length === 0) {
        return createDefaultDocData();
    }

    return {
        type: "doc",
        content: paragraphs,
    };
}

export function createDefaultDocData(): JSONContent {
    return {
        type: "doc",
        content: [paragraphNode()],
    };
}

export function serializeDocData(data: JSONContent): string {
    return JSON.stringify(normalizeDocData(data));
}

export function parseDocContent(content: string): ParseDocContentResult {
    const raw = content ?? "";
    const trimmed = raw.trim();

    if (!trimmed) {
        const data = createDefaultDocData();
        const normalizedContent = serializeDocData(data);
        return {
            data,
            normalizedContent,
            wasNormalized: normalizedContent !== raw,
            parseError: null,
        };
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        const data = normalizeDocData(parsed);
        const normalizedContent = serializeDocData(data);
        return {
            data,
            normalizedContent,
            wasNormalized: normalizedContent !== raw,
            parseError: null,
        };
    } catch {
        const fallback = buildDocDataFromPlainText(raw);
        const normalizedContent = serializeDocData(fallback);
        return {
            data: fallback,
            normalizedContent,
            wasNormalized: true,
            parseError: "Document content was converted to Novel JSON blocks.",
        };
    }
}

export function isDocFileName(name: string | null | undefined): boolean {
    if (!name) return false;
    return name.trim().toLowerCase().endsWith(`.${DOC_EXTENSION}`);
}
