/**
 * Predictive performance insights from snapshot trends + optional Gemini analysis.
 */

import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import type {
    PerformanceForecastPayload,
    PgStatStatementEntry,
    SlowQuerySnapshotRecord,
    SlowQueryTrendRisk,
} from "@/lib/types";
import { resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";

function formatMsBrief(ms: number): string {
    if (!Number.isFinite(ms)) return "-";
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)}s`;
    return `${Math.round(ms)}ms`;
}

const MS_PER_DAY = 86400000;

function medianSorted(values: number[]): number {
    if (values.length === 0) return 0;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

function stddevSample(values: number[]): number {
    if (values.length < 2) return 0;
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const varSum = values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(varSum);
}

function linearSlopeMsPerDay(timestampsMs: number[], y: number[]): number {
    if (timestampsMs.length !== y.length || timestampsMs.length < 2) return 0;
    const t0 = timestampsMs[0];
    const x = timestampsMs.map((t) => (t - t0) / MS_PER_DAY);
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumXX = x.reduce((acc, xi) => acc + xi * xi, 0);
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return 0;
    return (n * sumXY - sumX * sumY) / denom;
}

/** Derive quantitative trend signals from local snapshot rows (chronological or any order). */
export function computeExecutionTrendMetrics(snapshots: SlowQuerySnapshotRecord[]): {
    snapshotCount: number;
    spanDays: number;
    slopeMsPerDay: number;
    lastMeanMs: number;
    baselineMedianMs: number;
    lastVsBaseline: number;
    volatilityMs: number;
    hitTrendDelta: number | null;
    riskLabel: "elevated" | "watch" | "stable";
} | null {
    if (snapshots.length < 3) return null;
    const sorted = [...snapshots].sort((a, b) => a.captured_at - b.captured_at);
    const ts = sorted.map((s) => s.captured_at);
    const means = sorted.map((s) => s.mean_exec_time_ms);
    const hits = sorted.map((s) => s.hit_percent);
    const t0 = ts[0];
    const spanDays = Math.max(0, (ts[ts.length - 1] - t0) / MS_PER_DAY);
    const slopeMsPerDay = linearSlopeMsPerDay(ts, means);
    const lastMeanMs = means[means.length - 1];
    const baseline = means.slice(0, -1);
    const baselineMedianMs = medianSorted(baseline);
    const lastVsBaseline = baselineMedianMs > 1e-6 ? lastMeanMs / baselineMedianMs : 1;
    const volatilityMs = stddevSample(means);
    const hitTrendDelta = hits.length >= 2 ? hits[hits.length - 1] - hits[0] : null;

    let riskLabel: "elevated" | "watch" | "stable" = "stable";
    if (slopeMsPerDay > 3 || lastVsBaseline >= 1.35 || (hitTrendDelta != null && hitTrendDelta < -5)) {
        riskLabel = "elevated";
    } else if (slopeMsPerDay > 0.8 || lastVsBaseline >= 1.18 || (hitTrendDelta != null && hitTrendDelta < -2)) {
        riskLabel = "watch";
    }

    return {
        snapshotCount: sorted.length,
        spanDays,
        slopeMsPerDay,
        lastMeanMs,
        baselineMedianMs,
        lastVsBaseline,
        volatilityMs,
        hitTrendDelta,
        riskLabel,
    };
}

function buildHeuristicForecast(args: {
    metrics: NonNullable<ReturnType<typeof computeExecutionTrendMetrics>>;
    pgStatEntry?: PgStatStatementEntry | null;
    connectionRisks?: SlowQueryTrendRisk[];
}): PerformanceForecastPayload {
    const { metrics, pgStatEntry, connectionRisks } = args;
    const trend_signals: string[] = [
        `Mean execution slope: ${metrics.slopeMsPerDay.toFixed(2)} ms/day over ${metrics.spanDays.toFixed(1)} day window`,
        `Latest mean ${formatMsBrief(metrics.lastMeanMs)} vs baseline median ${formatMsBrief(metrics.baselineMedianMs)} (${metrics.lastVsBaseline.toFixed(2)}×)`,
        `Volatility (stdev of means): ${formatMsBrief(metrics.volatilityMs)}`,
    ];
    if (metrics.hitTrendDelta != null) {
        trend_signals.push(
            `Cache hit rate moved ${metrics.hitTrendDelta >= 0 ? "+" : ""}${metrics.hitTrendDelta.toFixed(1)} pts across snapshots`
        );
    }
    if (pgStatEntry) {
        trend_signals.push(
            `Live pg_stat: ${pgStatEntry.calls.toLocaleString()} calls, max ${formatMsBrief(pgStatEntry.max_exec_time_ms)}, temp blocks written ${pgStatEntry.temp_blks_written.toLocaleString()}`
        );
    }

    const predicted_bottlenecks: PerformanceForecastPayload["predicted_bottlenecks"] = [];
    const preventive_actions: PerformanceForecastPayload["preventive_actions"] = [];
    const monitoring_suggestions: string[] = [
        "Keep recording hourly snapshots during peak load weeks.",
        "Alert if mean_ms_slope_per_day stays positive for 5+ consecutive captures.",
    ];

    if (metrics.slopeMsPerDay > 1) {
        predicted_bottlenecks.push({
            title: "Gradual latency creep",
            likelihood: metrics.slopeMsPerDay > 4 ? "high" : "medium",
            timeframe: metrics.spanDays >= 7 ? "next 2–4 weeks" : "as data volume grows",
            rationale: `Mean time is trending up by ~${metrics.slopeMsPerDay.toFixed(1)} ms/day; compounding growth often tracks table/index bloat or selective cardinality drift.`,
        });
        preventive_actions.push({
            action: "Validate selective indexes on hot filters; run EXPLAIN on representative parameters.",
            priority: "P1",
            effort: "low–medium",
            expected_impact: "Stops sequential growth before it dominates p95 latency.",
        });
    }

    if (metrics.lastVsBaseline >= 1.25) {
        predicted_bottlenecks.push({
            title: "Step-change vs historical baseline",
            likelihood: "medium",
            timeframe: "immediate to 1 week",
            rationale: "Latest snapshot mean is materially above the median of prior captures—often a plan flip, stale stats, or cache coldness.",
        });
        preventive_actions.push({
            action: "Capture EXPLAIN (ANALYZE, BUFFERS) now and compare to a known-good plan; consider ANALYZE on touched tables.",
            priority: "P0",
            effort: "low",
            expected_impact: "Rapidly confirms planner regression or missing stats.",
        });
    }

    if (metrics.hitTrendDelta != null && metrics.hitTrendDelta < -3) {
        predicted_bottlenecks.push({
            title: "Rising disk pressure",
            likelihood: "medium",
            timeframe: "next 1–2 weeks under growth",
            rationale: "Falling buffer hit rate in snapshots suggests working set is outgrowing shared_buffers or churn increased.",
        });
        preventive_actions.push({
            action: "Review shared_buffers vs working set; consider partial indexes or reducing scanned columns.",
            priority: "P1",
            effort: "medium",
            expected_impact: "Reduces read amplification before IO saturates.",
        });
    }

    if (pgStatEntry && pgStatEntry.temp_blks_written > 1000) {
        predicted_bottlenecks.push({
            title: "Sort/hash spill risk",
            likelihood: "medium",
            timeframe: "peak concurrency",
            rationale: "High temp_blks_written in pg_stat often precedes p99 spikes when memory pressure increases.",
        });
        preventive_actions.push({
            action: "Tune work_mem cautiously per role; narrow SELECT lists; add supporting sort keys to indexes.",
            priority: "P2",
            effort: "medium",
            expected_impact: "Fewer on-disk sorts under load.",
        });
    }

    if (predicted_bottlenecks.length === 0) {
        predicted_bottlenecks.push({
            title: "No strong deterioration signal yet",
            likelihood: "low",
            timeframe: "ongoing",
            rationale: "Trend metrics are relatively flat; continue periodic snapshots and watch for slope or baseline divergence.",
        });
        preventive_actions.push({
            action: "Maintain snapshot cadence; pin critical statements for visibility.",
            priority: "P2",
            effort: "low",
            expected_impact: "Earlier detection if workload shifts.",
        });
    }

    if (connectionRisks && connectionRisks.length > 0) {
        const top = connectionRisks[0];
        if (top && top.risk_level === "high") {
            trend_signals.push(`Connection-wide: another fingerprint scores high risk (${top.risk_score.toFixed(0)}); review fleet of statements.`);
        }
    }

    const confidence: PerformanceForecastPayload["confidence"] =
        metrics.riskLabel === "elevated" ? "medium" : metrics.riskLabel === "watch" ? "medium" : "low";

    return {
        headline:
            metrics.riskLabel === "elevated"
                ? "Elevated risk: execution time is trending worse—act before peak load."
                : metrics.riskLabel === "watch"
                  ? "Watch closely: early signs of drift; preventive work will pay off."
                  : "Stable for now: keep monitoring with regular snapshots.",
        horizon_weeks: metrics.spanDays >= 14 ? 4 : 2,
        confidence,
        predicted_bottlenecks,
        preventive_actions,
        monitoring_suggestions,
        trend_signals,
        generated_at: Date.now(),
        provider: "local-heuristic",
    };
}

const FORECAST_SYSTEM = `You are a senior PostgreSQL performance engineer focused on capacity and regression prevention.
Output a single JSON object only. No markdown fences.

Shape:
{
  "headline": string,
  "horizon_weeks": number,
  "confidence": "high"|"medium"|"low",
  "predicted_bottlenecks": [{"title": string, "likelihood": string, "timeframe": string, "rationale": string}],
  "preventive_actions": [{"action": string, "priority": "P0"|"P1"|"P2", "effort": string, "expected_impact": string}],
  "monitoring_suggestions": string[],
  "trend_signals": string[]
}

Rules:
- Ground predictions in the supplied trend numbers; do not invent exact query plans.
- Prefer preventive (indexes, stats, partitioning, cache sizing, query shape) over reactive firefighting.
- 2–5 bottlenecks max, 3–6 preventive actions max.`;

function parseForecastJson(raw: string): PerformanceForecastPayload | null {
    let text = raw.trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    try {
        const p = JSON.parse(text) as Record<string, unknown>;
        if (typeof p.headline !== "string") return null;
        const horizon = Number(p.horizon_weeks);
        const conf = p.confidence;
        const confidence =
            conf === "high" || conf === "medium" || conf === "low" ? conf : ("medium" as const);

        const bottlenecksRaw = Array.isArray(p.predicted_bottlenecks) ? p.predicted_bottlenecks : [];
        const predicted_bottlenecks = bottlenecksRaw
            .filter((b): b is Record<string, unknown> => b != null && typeof b === "object")
            .map((b) => ({
                title: String(b.title ?? ""),
                likelihood: String(b.likelihood ?? ""),
                timeframe: String(b.timeframe ?? ""),
                rationale: String(b.rationale ?? ""),
            }))
            .filter((b) => b.title.length > 0);

        const parsePriority = (pr: unknown): "P0" | "P1" | "P2" => {
            if (pr === "P0" || pr === "P1" || pr === "P2") return pr;
            return "P1";
        };

        const actionsRaw = Array.isArray(p.preventive_actions) ? p.preventive_actions : [];
        const preventive_actions = actionsRaw
            .filter((a): a is Record<string, unknown> => a != null && typeof a === "object")
            .map((a) => ({
                action: String(a.action ?? ""),
                priority: parsePriority(a.priority),
                effort: String(a.effort ?? ""),
                expected_impact: String(a.expected_impact ?? ""),
            }))
            .filter((a) => a.action.length > 0);

        const monitoring_suggestions = Array.isArray(p.monitoring_suggestions)
            ? p.monitoring_suggestions.map((s) => String(s)).filter(Boolean)
            : [];
        const trend_signals = Array.isArray(p.trend_signals)
            ? p.trend_signals.map((s) => String(s)).filter(Boolean)
            : [];

        return {
            headline: p.headline,
            horizon_weeks: Number.isFinite(horizon) ? Math.max(1, Math.round(horizon)) : 2,
            confidence,
            predicted_bottlenecks,
            preventive_actions,
            monitoring_suggestions,
            trend_signals,
            generated_at: Date.now(),
            provider: "gemini",
        };
    } catch {
        return null;
    }
}

export interface AnalyzePerformanceForecastArgs {
    snapshots: SlowQuerySnapshotRecord[];
    pgStatEntry?: PgStatStatementEntry | null;
    connectionTrendRisks?: SlowQueryTrendRisk[];
    explainJson?: string | null;
    signal?: AbortSignal;
    model?: GeminiModelId;
}

export async function analyzePerformanceForecast(
    args: AnalyzePerformanceForecastArgs
): Promise<PerformanceForecastPayload | null> {
    const metrics = computeExecutionTrendMetrics(args.snapshots);
    if (!metrics) return null;

    const heuristic = () =>
        buildHeuristicForecast({
            metrics,
            pgStatEntry: args.pgStatEntry,
            connectionRisks: args.connectionTrendRisks,
        });

    const settings = useSettingsStore.getState();
    const apiKey = resolveGeminiApiKey(settings.geminiApiKey);
    const modelId = (args.model ?? settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId;

    const userParts: string[] = [
        "Task: predict likely future bottlenecks and preventive optimizations from execution trends.",
        "",
        "Computed trend metrics:",
        JSON.stringify(metrics, null, 2),
    ];

    if (args.pgStatEntry) {
        userParts.push("", "Current pg_stat_statements row (aggregate):", JSON.stringify(args.pgStatEntry, null, 2));
    }
    if (args.connectionTrendRisks && args.connectionTrendRisks.length > 0) {
        userParts.push(
            "",
            "Other high-risk statements on this connection (summary):",
            JSON.stringify(args.connectionTrendRisks.slice(0, 8), null, 2)
        );
    }
    if (args.explainJson) {
        const trimmed =
            args.explainJson.length > 12_000
                ? `${args.explainJson.slice(0, 12_000)}\n…(truncated)`
                : args.explainJson;
        userParts.push("", "EXPLAIN JSON context:", trimmed);
    }

    const userText = userParts.join("\n");

    if (!apiKey) {
        return heuristic();
    }

    try {
        const response = await withGeminiLogging(
            () =>
                callGeminiSync(
                    modelId,
                    apiKey,
                    [{ role: "user", parts: [{ text: userText }] }],
                    FORECAST_SYSTEM,
                    args.signal,
                    { maxOutputTokens: 3072 }
                ),
            { model: modelId, featureType: "query-performance-forecast", endpoint: "generateContent" }
        );
        const parsed = parseForecastJson(response);
        if (parsed && parsed.predicted_bottlenecks.length > 0) return parsed;
    } catch {
        /* heuristic */
    }

    return heuristic();
}
