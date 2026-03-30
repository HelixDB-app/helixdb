import type { PgStatStatementEntry, SlowQueryTrendRisk } from "@/lib/types";

function clampPreview(text: string, max = 48): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max)}…`;
}

export interface PgStatAnalyticsKpis {
    statementsLoaded: number;
    totalCalls: number;
    totalExecMs: number;
    /** Weighted mean latency: Σ total_exec / Σ calls */
    weightedMeanMs: number;
    statementsMeanGe1s: number;
    statementsMeanGe100ms: number;
    weightedCacheHitPct: number;
    totalBlkReadMs: number;
    totalBlkWriteMs: number;
    highIoStatements: number;
}

export interface PgStatWorkloadRow {
    label: string;
    totalMs: number;
    meanMs: number;
    calls: number;
    queryId: string;
}

export interface PgStatLatencyBucket {
    bucket: string;
    count: number;
}

export interface PgStatCacheBucket {
    range: string;
    count: number;
}

export interface PgStatScatterPoint {
    calls: number;
    meanMs: number;
    totalMs: number;
    label: string;
    queryId: string;
}

export interface PgStatTimeShareSlice {
    /** Stable key for chart config / legend */
    sliceId: string;
    name: string;
    value: number;
}

export interface PgStatParetoPoint {
    rank: number;
    label: string;
    /** Cumulative % of total exec time (loaded set), 0–100 */
    cumulativePct: number;
    /** This statement's % of total exec time */
    sharePct: number;
}

export interface PgStatIoRow {
    label: string;
    readMs: number;
    writeMs: number;
    queryId: string;
}

export interface PgStatAnalytics {
    kpis: PgStatAnalyticsKpis;
    /** Sorted by total time desc; cumulative % for Pareto / area charts */
    pareto: PgStatParetoPoint[];
    /** Smallest rank (1-based) at which cumulative exec time reaches 80%; null if empty */
    paretoP80Rank: number | null;
    workloadTop: PgStatWorkloadRow[];
    latencyBuckets: PgStatLatencyBucket[];
    cacheBuckets: PgStatCacheBucket[];
    scatter: PgStatScatterPoint[];
    timeShare: PgStatTimeShareSlice[];
    ioTop: PgStatIoRow[];
    riskSummary: { high: number; medium: number; low: number };
}

const CHART_COLORS = ["#22d3ee", "#34d399", "#a78bfa", "#fbbf24", "#fb7185", "#94a3b8"];

export function pgStatChartColors(): string[] {
    return CHART_COLORS;
}

export function buildPgStatAnalytics(
    items: PgStatStatementEntry[],
    trendRisks: SlowQueryTrendRisk[]
): PgStatAnalytics {
    let totalCalls = 0;
    let totalExecMs = 0;
    let weightedCacheNumerator = 0;
    let totalBlkReadMs = 0;
    let totalBlkWriteMs = 0;
    let statementsMeanGe1s = 0;
    let statementsMeanGe100ms = 0;
    let highIoStatements = 0;

    for (const row of items) {
        totalCalls += row.calls;
        totalExecMs += row.total_exec_time_ms;
        weightedCacheNumerator += row.hit_percent * row.total_exec_time_ms;
        totalBlkReadMs += row.blk_read_time_ms ?? 0;
        totalBlkWriteMs += row.blk_write_time_ms ?? 0;
        if (row.mean_exec_time_ms >= 1000) statementsMeanGe1s += 1;
        if (row.mean_exec_time_ms >= 100) statementsMeanGe100ms += 1;
        if ((row.blk_read_time_ms ?? 0) + (row.blk_write_time_ms ?? 0) > row.mean_exec_time_ms * 0.2 && row.mean_exec_time_ms > 0) {
            highIoStatements += 1;
        }
    }

    const weightedMeanMs = totalCalls > 0 ? totalExecMs / totalCalls : 0;
    const weightedCacheHitPct = totalExecMs > 0 ? weightedCacheNumerator / totalExecMs : 0;

    const sortedByTotal = [...items].sort((a, b) => b.total_exec_time_ms - a.total_exec_time_ms);

    let cumMs = 0;
    let paretoP80Rank: number | null = null;
    const pareto: PgStatParetoPoint[] = sortedByTotal.slice(0, 48).map((row, i) => {
        cumMs += row.total_exec_time_ms;
        const cumulativePct = totalExecMs > 0 ? Math.min(100, (cumMs / totalExecMs) * 100) : 0;
        const sharePct = totalExecMs > 0 ? (row.total_exec_time_ms / totalExecMs) * 100 : 0;
        if (paretoP80Rank === null && totalExecMs > 0 && cumMs / totalExecMs >= 0.8) {
            paretoP80Rank = i + 1;
        }
        return {
            rank: i + 1,
            label: clampPreview(row.query, 32),
            cumulativePct,
            sharePct,
        };
    });

    const workloadTop = sortedByTotal.slice(0, 12).map((row) => ({
        label: clampPreview(row.query, 44),
        totalMs: row.total_exec_time_ms,
        meanMs: row.mean_exec_time_ms,
        calls: row.calls,
        queryId: row.query_id,
    }));

    const buckets: Record<string, number> = {
        "<1ms": 0,
        "1–10ms": 0,
        "10–100ms": 0,
        "100ms–1s": 0,
        "≥1s": 0,
    };
    for (const row of items) {
        const m = row.mean_exec_time_ms;
        if (m < 1) buckets["<1ms"] += 1;
        else if (m < 10) buckets["1–10ms"] += 1;
        else if (m < 100) buckets["10–100ms"] += 1;
        else if (m < 1000) buckets["100ms–1s"] += 1;
        else buckets["≥1s"] += 1;
    }
    const latencyBuckets: PgStatLatencyBucket[] = Object.entries(buckets).map(([bucket, count]) => ({
        bucket,
        count,
    }));

    const cacheB: Record<string, number> = {
        "≥99%": 0,
        "95–99%": 0,
        "90–95%": 0,
        "<90%": 0,
    };
    for (const row of items) {
        const h = row.hit_percent;
        if (h >= 99) cacheB["≥99%"] += 1;
        else if (h >= 95) cacheB["95–99%"] += 1;
        else if (h >= 90) cacheB["90–95%"] += 1;
        else cacheB["<90%"] += 1;
    }
    const cacheBuckets: PgStatCacheBucket[] = Object.entries(cacheB).map(([range, count]) => ({ range, count }));

    const scatter = sortedByTotal.slice(0, 36).map((row) => ({
        calls: row.calls,
        meanMs: row.mean_exec_time_ms,
        totalMs: row.total_exec_time_ms,
        label: clampPreview(row.query, 36),
        queryId: row.query_id,
    }));

    const top5 = sortedByTotal.slice(0, 5);
    const top5Sum = top5.reduce((a, r) => a + r.total_exec_time_ms, 0);
    const otherMs = Math.max(0, totalExecMs - top5Sum);
    const timeShare: PgStatTimeShareSlice[] = [
        ...top5.map((row, i) => ({
            sliceId: `top${i}`,
            name: clampPreview(row.query, 28) || `Statement ${i + 1}`,
            value: row.total_exec_time_ms,
        })),
    ];
    if (otherMs > 0 && items.length > 5) {
        timeShare.push({ sliceId: "other", name: "Other statements", value: otherMs });
    }

    const ioTop = [...items]
        .map((row) => ({
            label: clampPreview(row.query, 44),
            readMs: row.blk_read_time_ms ?? 0,
            writeMs: row.blk_write_time_ms ?? 0,
            queryId: row.query_id,
            io: (row.blk_read_time_ms ?? 0) + (row.blk_write_time_ms ?? 0),
        }))
        .sort((a, b) => b.io - a.io)
        .slice(0, 10)
        .map(({ label, readMs, writeMs, queryId }) => ({ label, readMs, writeMs, queryId }));

    const riskSummary = {
        high: trendRisks.filter((r) => r.risk_level === "high").length,
        medium: trendRisks.filter((r) => r.risk_level === "medium").length,
        low: trendRisks.filter((r) => r.risk_level === "low").length,
    };

    return {
        kpis: {
            statementsLoaded: items.length,
            totalCalls,
            totalExecMs,
            weightedMeanMs,
            statementsMeanGe1s,
            statementsMeanGe100ms,
            weightedCacheHitPct,
            totalBlkReadMs,
            totalBlkWriteMs,
            highIoStatements,
        },
        pareto,
        paretoP80Rank,
        workloadTop,
        latencyBuckets,
        cacheBuckets,
        scatter,
        timeShare,
        ioTop,
        riskSummary,
    };
}
