/**
 * SQL helpers for Optimizer Lab — pg_stats + live rel stats for planner tuning.
 */

/** Unquoted identifiers only (avoids SQL injection in dynamic fragments). */
export function isSafePgIdent(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name);
}

function escapePgStringLiteral(s: string): string {
    return s.replace(/'/g, "''");
}

/** PostgreSQL major version from server_version string, e.g. "PostgreSQL 16.4 ..." → 16 */
export function pgMajorFromServerVersion(serverVersion: string): number {
    const m = /PostgreSQL\s+(\d+)/i.exec(serverVersion);
    if (m) return parseInt(m[1], 10);
    const loose = /^(\d+)/.exec(serverVersion.trim());
    return loose ? parseInt(loose[1], 10) : 16;
}

export function buildPgStatsSql(schema: string, table: string, includeCorrelation: boolean): string | null {
    if (!isSafePgIdent(schema) || !isSafePgIdent(table)) return null;
    const a = escapePgStringLiteral(schema);
    const b = escapePgStringLiteral(table);
    const corrCol = includeCorrelation ? ", s.correlation::float8 AS correlation" : "";
    return `SELECT s.schemaname,
       s.tablename,
       s.attname,
       s.inherited,
       s.null_frac::float8 AS null_frac,
       s.avg_width,
       s.n_distinct::float8 AS n_distinct,
       s.most_common_vals::text AS most_common_vals,
       s.most_common_freqs::text AS most_common_freqs,
       s.histogram_bounds::text AS histogram_bounds${corrCol}
FROM pg_stats s
WHERE s.schemaname = '${a}' AND s.tablename = '${b}'
ORDER BY s.attname, s.inherited`;
}

export function buildTableStatSql(schema: string, table: string): string | null {
    if (!isSafePgIdent(schema) || !isSafePgIdent(table)) return null;
    const a = escapePgStringLiteral(schema);
    const b = escapePgStringLiteral(table);
    return `SELECT c.reltuples::bigint AS reltuples_est,
       s.n_live_tup,
       s.n_dead_tup,
       s.last_vacuum,
       s.last_autovacuum,
       s.last_analyze,
       s.last_autoanalyze,
       s.seq_scan,
       s.seq_tup_read,
       s.idx_scan,
       s.idx_tup_fetch,
       s.n_tup_ins,
       s.n_tup_upd,
       s.n_tup_del,
       s.n_tup_hot_upd
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
WHERE n.nspname = '${a}'
  AND c.relname = '${b}'
  AND c.relkind IN ('r', 'p')
LIMIT 1`;
}

export function buildAnalyzeSql(schema: string, table: string): string | null {
    if (!isSafePgIdent(schema) || !isSafePgIdent(table)) return null;
    return `ANALYZE ${quoteIdent(schema)}.${quoteIdent(table)};`;
}

function quoteIdent(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
}

export interface PgStatsRowParsed {
    schemaname: string;
    tablename: string;
    attname: string;
    inherited: boolean;
    null_frac: number | null;
    avg_width: number | null;
    n_distinct: number | null;
    most_common_vals: string | null;
    most_common_freqs: string | null;
    histogram_bounds: string | null;
    correlation: number | null;
}

export interface TableStatParsed {
    reltuples_est: number | null;
    n_live_tup: number | null;
    n_dead_tup: number | null;
    last_vacuum: string | null;
    last_autovacuum: string | null;
    last_analyze: string | null;
    last_autoanalyze: string | null;
    seq_scan: number | null;
    seq_tup_read: number | null;
    idx_scan: number | null;
    idx_tup_fetch: number | null;
    n_tup_ins: number | null;
    n_tup_upd: number | null;
    n_tup_del: number | null;
    n_tup_hot_upd: number | null;
}

export type OptimizerInsightSeverity = "info" | "warn" | "risk";

export interface OptimizerInsight {
    severity: OptimizerInsightSeverity;
    title: string;
    detail: string;
}

function cellStr(v: unknown): string {
    if (v == null) return "";
    if (typeof v === "object" && v !== null && "type" in (v as object)) {
        const c = v as { type: string; value?: unknown };
        if (c.type === "Null") return "";
        return String(c.value ?? "");
    }
    return String(v);
}

function cellBool(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "object" && v !== null && "type" in (v as object)) {
        const c = v as { type: string; value?: unknown };
        if (c.type === "Null") return false;
        if (c.type === "Bool") return Boolean(c.value);
    }
    return false;
}

function cellFloat(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === "object" && v !== null && "type" in (v as object)) {
        const c = v as { type: string; value?: unknown };
        if (c.type === "Null") return null;
        const n = Number(c.value);
        return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function cellInt(v: unknown): number | null {
    const f = cellFloat(v);
    return f == null ? null : Math.trunc(f);
}

/** Map one query row to object by column names (lowercase PG names). */
export function rowObject(
    colNames: string[],
    row: unknown[]
): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < colNames.length; i++) {
        o[colNames[i].toLowerCase()] = row[i];
    }
    return o;
}

export function parsePgStatsRows(
    columns: { name: string }[],
    rows: unknown[][]
): PgStatsRowParsed[] {
    const names = columns.map((c) => c.name);
    return rows.map((row) => {
        const o = rowObject(names, row);
        return {
            schemaname: cellStr(o.schemaname),
            tablename: cellStr(o.tablename),
            attname: cellStr(o.attname),
            inherited: cellBool(o.inherited),
            null_frac: cellFloat(o.null_frac),
            avg_width: cellInt(o.avg_width),
            n_distinct: cellFloat(o.n_distinct),
            most_common_vals: cellStr(o.most_common_vals) || null,
            most_common_freqs: cellStr(o.most_common_freqs) || null,
            histogram_bounds: cellStr(o.histogram_bounds) || null,
            correlation: o.correlation !== undefined ? cellFloat(o.correlation) : null,
        };
    });
}

export function parseTableStatRow(
    columns: { name: string }[],
    rows: unknown[][]
): TableStatParsed | null {
    if (rows.length === 0) return null;
    const names = columns.map((c) => c.name);
    const o = rowObject(names, rows[0]!);
    return {
        reltuples_est: cellInt(o.reltuples_est),
        n_live_tup: cellInt(o.n_live_tup),
        n_dead_tup: cellInt(o.n_dead_tup),
        last_vacuum: cellStr(o.last_vacuum) || null,
        last_autovacuum: cellStr(o.last_autovacuum) || null,
        last_analyze: cellStr(o.last_analyze) || null,
        last_autoanalyze: cellStr(o.last_autoanalyze) || null,
        seq_scan: cellInt(o.seq_scan),
        seq_tup_read: cellInt(o.seq_tup_read),
        idx_scan: cellInt(o.idx_scan),
        idx_tup_fetch: cellInt(o.idx_tup_fetch),
        n_tup_ins: cellInt(o.n_tup_ins),
        n_tup_upd: cellInt(o.n_tup_upd),
        n_tup_del: cellInt(o.n_tup_del),
        n_tup_hot_upd: cellInt(o.n_tup_hot_upd),
    };
}

/** Human-readable interpretation of n_distinct from pg_stats. */
export function describeNDistinct(n: number | null): string {
    if (n == null) return "—";
    if (n === 0) return "constant (0 distinct in stats)";
    if (n < 0) return `~${Math.round(Math.abs(n) * 100)}% of rows are distinct`;
    return `~${Math.round(n)} distinct values (estimated)`;
}

function parsePgTimestamp(s: string | null): number | null {
    if (!s || !s.trim()) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

function newestAnalyzeMs(t: TableStatParsed): number | null {
    const a = parsePgTimestamp(t.last_analyze);
    const b = parsePgTimestamp(t.last_autoanalyze);
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
}

const STALE_ANALYZE_MS = 7 * 24 * 60 * 60 * 1000;

export function buildOptimizerInsights(
    tableStat: TableStatParsed | null,
    statsRows: PgStatsRowParsed[]
): OptimizerInsight[] {
    const out: OptimizerInsight[] = [];
    if (!tableStat) {
        out.push({
            severity: "warn",
            title: "Relation not found or not visible",
            detail: "No row in pg_stat_all_tables for this name. Check schema and privileges (pg_stats requires table owner or superuser for full stats).",
        });
        return out;
    }

    const live = tableStat.n_live_tup ?? 0;
    const dead = tableStat.n_dead_tup ?? 0;
    const total = live + dead;
    if (total > 100 && dead / total >= 0.15) {
        out.push({
            severity: "risk",
            title: "High dead-tuple ratio",
            detail: `${((dead / total) * 100).toFixed(1)}% dead tuples (${dead.toLocaleString()} / ${total.toLocaleString()}). Sequential scans and autovacuum pressure may hurt plan quality until VACUUM catches up.`,
        });
    }

    const analyzedAt = newestAnalyzeMs(tableStat);
    if (live > 10_000 && analyzedAt != null && Date.now() - analyzedAt > STALE_ANALYZE_MS) {
        out.push({
            severity: "warn",
            title: "Statistics may be stale",
            detail: `Last ANALYZE (manual or auto) is older than 7 days while the table has ${live.toLocaleString()} live rows. Fresh ANALYZE often fixes mis-estimated joins and filters.`,
        });
    }

    if (live > 1_000 && analyzedAt == null) {
        out.push({
            severity: "warn",
            title: "No ANALYZE timestamp recorded",
            detail: "pg_stat_all_tables shows no last_analyze / last_autoanalyze. Run ANALYZE if plans look wrong.",
        });
    }

    const baseRows = statsRows.filter((r) => !r.inherited);
    const highNull = baseRows
        .filter((r) => r.null_frac != null && r.null_frac >= 0.6)
        .sort((a, b) => (b.null_frac ?? 0) - (a.null_frac ?? 0));
    for (const r of highNull.slice(0, 3)) {
        const nf = r.null_frac!;
        out.push({
            severity: "info",
            title: `Column "${r.attname}" is mostly NULL`,
            detail: `null_frac ≈ ${(nf * 100).toFixed(0)}%. Partial indexes with WHERE col IS NOT NULL often help selective queries.`,
        });
    }
    if (highNull.length > 3) {
        out.push({
            severity: "info",
            title: `${highNull.length - 3} more high-null columns`,
            detail: "Open the stats grid and sort mentally by null_frac — consider partial indexes for hot nullable filters.",
        });
    }

    const constants = baseRows.filter((r) => r.n_distinct === 0);
    for (const r of constants.slice(0, 2)) {
        out.push({
            severity: "info",
            title: `Column "${r.attname}" looks constant in stats`,
            detail: "Planner will treat filters on this column as highly selective or redundant — verify with actual data if behavior surprises you.",
        });
    }

    const strongCorr = baseRows.filter(
        (r) => r.correlation != null && Math.abs(r.correlation) > 0.9
    );
    for (const r of strongCorr.slice(0, 2)) {
        const corr = r.correlation!;
        out.push({
            severity: "info",
            title: `Column "${r.attname}" is strongly correlated with physical order`,
            detail: `correlation ≈ ${corr.toFixed(2)}. Range scans may be cheaper or pricier than uniform distribution assumes; consider extended statistics for correlated columns.`,
        });
    }

    if (out.length === 0) {
        out.push({
            severity: "info",
            title: "No major red flags",
            detail: "Review null_frac, n_distinct, and histogram_bounds below when debugging a specific slow query.",
        });
    }

    return out;
}
