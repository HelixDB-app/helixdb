import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CrashReportDoc = {
    createdAt: Date;
    signature: string;
    appVersion: string;
    platform: string | null;
    message: string;
};

export async function GET(_req: NextRequest) {
    try {
        const collection = await getCollection<CrashReportDoc>("crash_reports");
        const now = new Date();
        const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [totals, topSignatures, byVersion, byPlatform] = await Promise.all([
            collection.aggregate([
                {
                    $facet: {
                        total: [{ $count: "c" }],
                        last24h: [{ $match: { createdAt: { $gte: since24h } } }, { $count: "c" }],
                        last7d: [{ $match: { createdAt: { $gte: since7d } } }, { $count: "c" }],
                    },
                },
                {
                    $project: {
                        total: { $ifNull: [{ $first: "$total.c" }, 0] },
                        last24h: { $ifNull: [{ $first: "$last24h.c" }, 0] },
                        last7d: { $ifNull: [{ $first: "$last7d.c" }, 0] },
                    },
                },
            ]).toArray(),
            collection
                .aggregate([
                    { $match: { createdAt: { $gte: since30d } } },
                    {
                        $group: {
                            _id: "$signature",
                            count: { $sum: 1 },
                            lastSeen: { $max: "$createdAt" },
                            sampleMessage: { $first: "$message" },
                        },
                    },
                    { $sort: { count: -1 } },
                    { $limit: 5 },
                ])
                .toArray(),
            collection
                .aggregate([
                    { $match: { createdAt: { $gte: since30d } } },
                    {
                        $group: {
                            _id: "$appVersion",
                            count: { $sum: 1 },
                            lastSeen: { $max: "$createdAt" },
                        },
                    },
                    { $sort: { count: -1 } },
                    { $limit: 8 },
                ])
                .toArray(),
            collection
                .aggregate([
                    { $match: { createdAt: { $gte: since30d } } },
                    {
                        $group: {
                            _id: "$platform",
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1 } },
                ])
                .toArray(),
        ]);

        return NextResponse.json({
            totals: totals[0] ?? { total: 0, last24h: 0, last7d: 0 },
            topSignatures,
            byVersion,
            byPlatform,
        });
    } catch (error) {
        console.error("crash-report-summary-error", error);
        return NextResponse.json({ error: "Unable to load crash analytics" }, { status: 500 });
    }
}
