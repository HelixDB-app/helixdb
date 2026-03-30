/**
 * Query performance optimization — Gemini when configured, else local heuristics.
 */

import { callGeminiSync, type GeminiModelId } from "@/lib/ai-chat-engine";
import { withGeminiLogging } from "@/lib/gemini-logger";
import type { PgStatStatementEntry, QueryHistorySummary, QueryOptimizationPayload } from "@/lib/types";
import { resolveGeminiApiKey, useSettingsStore } from "@/stores/settings-store";

function formatMsBrief(ms: number): string {
    if (!Number.isFinite(ms)) return "-";
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)}s`;
    return `${Math.round(ms)}ms`;
}

function detectQueryType(sql: string): string {
    const t = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "UNKNOWN";
    if (t === "WITH") {
        const second = sql.trim().split(/\s+/)[1]?.toUpperCase() ?? "";
        return second || "SELECT";
    }
    return t;
}

function heuristicIndexesAndChanges(args: {
    queryText: string;
    queryType: string;
    currentMs: number;
    rowsReturnedOrPerCall: number;
    blksRead: number;
    hasLimit: boolean;
}): Pick<QueryOptimizationPayload, "changes_made" | "required_indexes" | "optimized_sql"> {
    const { queryText, queryType, currentMs, rowsReturnedOrPerCall, blksRead, hasLimit } = args;
    let optimizedSql = queryText.trim();
    const changes: QueryOptimizationPayload["changes_made"] = [];
    const requiredIndexes: QueryOptimizationPayload["required_indexes"] = [];

    const whereMatch = queryText.match(/\bwhere\s+([\s\S]+?)(\border\s+by\b|\bgroup\s+by\b|\blimit\b|$)/i);
    const whereClause = whereMatch?.[1] ?? "";
    const colMatch = whereClause.match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s*(=|>|<|>=|<=|LIKE|ILIKE|IN)/i);
    const whereColumn = colMatch?.[1]?.split(".").pop()?.replace(/"/g, "") ?? "created_at";

    const fromMatch = queryText.match(/\bfrom\s+"?([\w]+)"?\."?([\w]+)"?/i);
    const primaryTable = fromMatch?.[2] ?? fromMatch?.[1] ?? "your_table";

    if (queryType === "SELECT" && !hasLimit && rowsReturnedOrPerCall >= 1000) {
        optimizedSql = `${optimizedSql.replace(/;\s*$/, "")}\nLIMIT 100;`;
        changes.push({
            change: "Added LIMIT 100",
            reason: `${Math.round(rowsReturnedOrPerCall).toLocaleString()} rows per call (or returned) suggests unbounded reads`,
            impact: "Reduces transfer and memory for exploratory queries",
        });
    }

    const addIndex = currentMs >= 1000 || blksRead > 1000 || rowsReturnedOrPerCall > 10_000;
    if (addIndex) {
        const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${primaryTable}_${whereColumn}_perf ON \"${primaryTable}\"(\"${whereColumn}\");`;
        requiredIndexes.push({
            sql,
            estimated_size_mb: Math.max(16, Math.round(rowsReturnedOrPerCall / 2000)),
            build_time_minutes: Math.max(1, Math.round((rowsReturnedOrPerCall + 50_000) / 250_000)),
            locks_table: false,
        });
        changes.push({
            change: `Recommended index on ${primaryTable}.${whereColumn}`,
            reason: "Execution profile suggests scan-heavy filtering",
            impact: "Expected large reduction in repeated execution time",
        });
    }

    if (changes.length === 0) {
        changes.push({
            change: "No structural rewrite required",
            reason: "Query is within an acceptable latency band for the given signals",
            impact: "Monitor for regressions over time",
        });
    }

    return { optimized_sql: optimizedSql, changes_made: changes, required_indexes: requiredIndexes };
}

export function buildHeuristicQueryOptimizationFromLocal(item: QueryHistorySummary): QueryOptimizationPayload {
    const rowsReturned = item.rows_returned ?? 0;
    const hasLimit = /\blimit\b/i.test(item.query_text);
    const tables = item.tables_touched;

    const { optimized_sql, changes_made, required_indexes } = heuristicIndexesAndChanges({
        queryText: item.query_text,
        queryType: item.query_type,
        currentMs: item.total_ms,
        rowsReturnedOrPerCall: rowsReturned,
        blksRead: item.blks_read ?? 0,
        hasLimit,
    });

    const confidence: "high" | "medium" | "low" =
        item.total_ms >= 3000 ? "high" : item.total_ms >= 800 ? "medium" : "low";
    const projectedMs = Math.max(8, item.total_ms / (1 + changes_made.length * (confidence === "high" ? 4.5 : 2.0)));

    return {
        explanation:
            `This ${item.query_type} query runs in ${formatMsBrief(item.total_ms)} and touches ${tables.join(", ") || "no detected tables"}. ` +
            `Focus on reducing row volume and improving index coverage for the filtering path.`,
        optimized_sql,
        changes_made,
        required_indexes,
        estimated_improvement: {
            current_ms: Math.round(item.total_ms),
            optimized_ms: Math.round(projectedMs),
            speedup_factor: Math.max(1, Math.round(item.total_ms / projectedMs)),
            confidence,
        },
        generated_at: Date.now(),
        provider: "local-heuristic",
    };
}

export function buildHeuristicQueryOptimizationFromPgStat(entry: PgStatStatementEntry): QueryOptimizationPayload {
    const rowsPerCall = entry.calls > 0 ? entry.rows / entry.calls : 0;
    const hasLimit = /\blimit\b/i.test(entry.query);
    const queryType = detectQueryType(entry.query);
    const currentMs = entry.mean_exec_time_ms;

    const { optimized_sql, changes_made, required_indexes } = heuristicIndexesAndChanges({
        queryText: entry.query,
        queryType,
        currentMs,
        rowsReturnedOrPerCall: rowsPerCall,
        blksRead: entry.shared_blks_read,
        hasLimit,
    });

    const confidence: "high" | "medium" | "low" =
        currentMs >= 3000 ? "high" : currentMs >= 800 ? "medium" : "low";
    const projectedMs = Math.max(8, currentMs / (1 + changes_made.length * (confidence === "high" ? 4.5 : 2.0)));

    return {
        explanation:
            `Server aggregate: mean ${formatMsBrief(currentMs)} over ${entry.calls.toLocaleString()} calls, ` +
            `max ${formatMsBrief(entry.max_exec_time_ms)}, cache hit ${entry.hit_percent.toFixed(1)}%. ` +
            `High shared_blks_read (${entry.shared_blks_read.toLocaleString()}) often means cold or sequential access.`,
        optimized_sql,
        changes_made,
        required_indexes,
        estimated_improvement: {
            current_ms: Math.round(currentMs),
            optimized_ms: Math.round(projectedMs),
            speedup_factor: Math.max(1, Math.round(currentMs / projectedMs)),
            confidence,
        },
        generated_at: Date.now(),
        provider: "local-heuristic",
    };
}

const GEMINI_SYSTEM = `You are an expert PostgreSQL performance engineer.
Output a single JSON object only. No markdown fences, no commentary outside JSON.

Required shape:
{
  "explanation": string,
  "optimized_sql": string,
  "changes_made": [{"change": string, "reason": string, "impact": string}],
  "required_indexes": [{"sql": string, "estimated_size_mb": number, "build_time_minutes": number, "locks_table": boolean}],
  "estimated_improvement": {"current_ms": number, "optimized_ms": number, "speedup_factor": number, "confidence": "high"|"medium"|"low"}
}

Rules:
- Preserve semantics; prefer CONCURRENTLY for new btree indexes when suggesting CREATE INDEX.
- If the query is already optimal, say so with empty required_indexes and realistic estimated_improvement.
- Use plausible estimated_size_mb and build_time_minutes (integers).`;

function buildGeminiUserPrompt(args: {
    source: "local" | "pg_stat";
    sql: string;
    explainJson?: string | null;
    localItem?: QueryHistorySummary;
    pgStatEntry?: PgStatStatementEntry;
}): string {
    const lines: string[] = [`Source: ${args.source}`, "", "SQL:", args.sql];

    if (args.source === "local" && args.localItem) {
        const i = args.localItem;
        lines.push(
            "",
            "Local execution sample:",
            `- total_ms: ${i.total_ms}, execution_ms: ${i.execution_ms}, planning_ms: ${i.planning_ms ?? "null"}`,
            `- rows_returned: ${i.rows_returned ?? "null"}, blks_read: ${i.blks_read ?? "null"}, query_type: ${i.query_type}`,
            `- tables_touched: ${i.tables_touched.join(", ") || "(none)"}`
        );
    }

    if (args.source === "pg_stat" && args.pgStatEntry) {
        const e = args.pgStatEntry;
        lines.push(
            "",
            "pg_stat_statements aggregate:",
            `- calls: ${e.calls}, mean_exec_time_ms: ${e.mean_exec_time_ms}, max: ${e.max_exec_time_ms}, min: ${e.min_exec_time_ms}`,
            `- total_exec_time_ms: ${e.total_exec_time_ms}, rows: ${e.rows}, stddev_ms: ${e.stddev_exec_time_ms ?? "null"}`,
            `- shared_blks_hit: ${e.shared_blks_hit}, shared_blks_read: ${e.shared_blks_read}, temp_blks_written: ${e.temp_blks_written}`,
            `- hit_percent: ${e.hit_percent}, slow_call_estimate: ${e.slow_call_estimate}`,
            e.pg_query_id != null && e.pg_query_id !== "" ? `- pg_query_id: ${e.pg_query_id}` : ""
        );
    }

    if (args.explainJson) {
        const trimmed =
            args.explainJson.length > 14_000
                ? `${args.explainJson.slice(0, 14_000)}\n…(truncated)`
                : args.explainJson;
        lines.push("", "EXPLAIN (ANALYZE) JSON (may be partial):", trimmed);
    }

    return lines.filter(Boolean).join("\n");
}

function parseOptimizationJson(raw: string): QueryOptimizationPayload | null {
    let text = raw.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];
    try {
        const p = JSON.parse(text) as Record<string, unknown>;
        if (!p || typeof p.explanation !== "string" || typeof p.optimized_sql !== "string") return null;
        const est = p.estimated_improvement as Record<string, unknown> | undefined;
        if (
            !est ||
            typeof est.current_ms !== "number" ||
            typeof est.optimized_ms !== "number" ||
            typeof est.speedup_factor !== "number"
        ) {
            return null;
        }
        const conf = est.confidence;
        const confidence =
            conf === "high" || conf === "medium" || conf === "low" ? conf : ("medium" as const);

        const changesRaw = Array.isArray(p.changes_made) ? p.changes_made : [];
        const changes_made = changesRaw
            .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
            .map((c) => ({
                change: String(c.change ?? ""),
                reason: String(c.reason ?? ""),
                impact: String(c.impact ?? ""),
            }));

        const idxRaw = Array.isArray(p.required_indexes) ? p.required_indexes : [];
        const required_indexes = idxRaw
            .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
            .map((c) => ({
                sql: String(c.sql ?? ""),
                estimated_size_mb: Number(c.estimated_size_mb) || 0,
                build_time_minutes: Number(c.build_time_minutes) || 0,
                locks_table: Boolean(c.locks_table),
            }))
            .filter((x) => x.sql.length > 0);

        return {
            explanation: p.explanation as string,
            optimized_sql: p.optimized_sql as string,
            changes_made,
            required_indexes,
            estimated_improvement: {
                current_ms: Math.round(est.current_ms as number),
                optimized_ms: Math.round(est.optimized_ms as number),
                speedup_factor: Math.max(1, Math.round(est.speedup_factor as number)),
                confidence,
            },
            generated_at: Date.now(),
            provider: "gemini",
        };
    } catch {
        return null;
    }
}

function getApiKeyAndModel(): { apiKey: string; model: GeminiModelId } {
    const settings = useSettingsStore.getState();
    return {
        apiKey: resolveGeminiApiKey(settings.geminiApiKey),
        model: (settings.defaultAiModel ?? "gemini-2.5-flash") as GeminiModelId,
    };
}

export interface AnalyzeQueryPerformanceArgs {
    source: "local" | "pg_stat";
    localItem?: QueryHistorySummary;
    pgStatEntry?: PgStatStatementEntry;
    explainJson?: string | null;
    signal?: AbortSignal;
    model?: GeminiModelId;
}

export async function analyzeQueryPerformance(args: AnalyzeQueryPerformanceArgs): Promise<QueryOptimizationPayload> {
    const heuristic = (): QueryOptimizationPayload => {
        if (args.source === "local" && args.localItem) {
            return buildHeuristicQueryOptimizationFromLocal(args.localItem);
        }
        if (args.source === "pg_stat" && args.pgStatEntry) {
            return buildHeuristicQueryOptimizationFromPgStat(args.pgStatEntry);
        }
        throw new Error("Missing query context for optimization.");
    };

    const { apiKey, model } = getApiKeyAndModel();
    const modelId = args.model ?? model;
    if (!apiKey) {
        return heuristic();
    }

    const sql =
        args.source === "local"
            ? (args.localItem?.query_text ?? "")
            : (args.pgStatEntry?.query ?? "");
    if (!sql.trim()) {
        return heuristic();
    }

    const userText = buildGeminiUserPrompt({
        source: args.source,
        sql,
        explainJson: args.explainJson,
        localItem: args.localItem,
        pgStatEntry: args.pgStatEntry,
    });

    try {
        const response = await withGeminiLogging(
            () =>
                callGeminiSync(
                    modelId,
                    apiKey,
                    [{ role: "user", parts: [{ text: userText }] }],
                    GEMINI_SYSTEM,
                    args.signal,
                    { maxOutputTokens: 4096 }
                ),
            { model: modelId, featureType: "query-optimization", endpoint: "generateContent" }
        );
        const parsed = parseOptimizationJson(response);
        if (parsed) return parsed;
    } catch {
        /* fall through */
    }

    return heuristic();
}

export function parseQueryOptimizationPayload(raw: string | null): QueryOptimizationPayload | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as QueryOptimizationPayload;
        if (!parsed || typeof parsed !== "object") return null;
        if (!parsed.optimized_sql || !parsed.estimated_improvement) return null;
        if (parsed.provider !== "local-heuristic" && parsed.provider !== "gemini") {
            (parsed as QueryOptimizationPayload).provider = "local-heuristic";
        }
        return parsed;
    } catch {
        return null;
    }
}
