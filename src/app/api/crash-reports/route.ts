import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCollection } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CrashReportDoc = {
    _id?: string;
    createdAt: Date;
    signature: string;
    appVersion: string;
    appChannel: string;
    platform: string | null;
    osVersion: string | null;
    deviceModel: string | null;
    userId: string | null;
    userEmail: string | null;
    sessionId: string | null;
    message: string;
    cause: string | null;
    stackTrace: string | null;
    possibleFixes: string[] | null;
    logs: string[] | null;
    diagnostics: Record<string, unknown> | null;
};

function safeString(value: unknown, fallback = ""): string {
    if (typeof value === "string") return value.trim();
    return fallback;
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.map((v) => String(v)).slice(0, 50);
}

function hashSignature(message: string, stack: string, cause: string): string {
    const input = `${message}::${stack.slice(0, 200)}::${cause}`;
    return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function ensureIndexes() {
    const collection = await getCollection<CrashReportDoc>("crash_reports");
    await collection.createIndexes([
        { key: { createdAt: -1 } },
        { key: { signature: 1, createdAt: -1 } },
        { key: { appVersion: 1, createdAt: -1 } },
    ]);
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const message = safeString(body.message);
        const stackTrace = safeString(body.stackTrace, body.stack || "");
        const cause = safeString(body.cause);

        if (!message && !stackTrace) {
            return NextResponse.json({ error: "message or stackTrace is required" }, { status: 400 });
        }

        const doc: CrashReportDoc = {
            createdAt: new Date(),
            message: message || stackTrace.slice(0, 140),
            stackTrace: stackTrace || null,
            cause: cause || null,
            signature: hashSignature(message, stackTrace, cause),
            appVersion: safeString(body.appVersion, "unknown"),
            appChannel: safeString(body.appChannel, "unknown"),
            platform: safeString(body.platform) || null,
            osVersion: safeString(body.osVersion) || null,
            deviceModel: safeString(body.deviceModel) || null,
            userId: safeString(body.userId) || null,
            userEmail: safeString(body.userEmail) || null,
            sessionId: safeString(body.sessionId) || null,
            possibleFixes: asStringArray(body.possibleFixes),
            logs: asStringArray(body.logs),
            diagnostics: (body.diagnostics && typeof body.diagnostics === "object") ? body.diagnostics : null,
        };

        const collection = await getCollection<CrashReportDoc>("crash_reports");
        await ensureIndexes();
        const result = await collection.insertOne(doc);

        return NextResponse.json({ id: result.insertedId, signature: doc.signature });
    } catch (error) {
        console.error("crash-report-insert-error", error);
        return NextResponse.json({ error: "Unable to store crash report" }, { status: 500 });
    }
}
