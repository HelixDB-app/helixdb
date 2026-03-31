import type { CellValue, QueryResult } from "@/lib/types";
import { formatCellValue } from "@/lib/types";

/** Single-query snapshot of PostgreSQL server configuration (pg_settings). */
export const PG_RUNTIME_CONFIG_SQL = `
SELECT
  name,
  setting,
  COALESCE(unit, '') AS unit,
  category,
  short_desc,
  context,
  vartype,
  source,
  boot_val,
  reset_val,
  pending_restart,
  COALESCE(min_val, '') AS min_val,
  COALESCE(max_val, '') AS max_val
FROM pg_settings
ORDER BY category, name
`.trim();

export interface PgRuntimeSettingRow {
    name: string;
    setting: string;
    unit: string;
    category: string;
    short_desc: string;
    context: string;
    vartype: string;
    source: string;
    boot_val: string;
    reset_val: string;
    pending_restart: boolean;
    min_val: string;
    max_val: string;
}

export function escapePgStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Format a GUC value for use in SET / ALTER SYSTEM (follows common PostgreSQL literal rules). */
export function formatGucSqlLiteral(raw: string, vartype: string): string {
    const t = vartype.toLowerCase();
    const s = raw.trim();
    if (t === "bool") {
        const lower = s.toLowerCase();
        if (lower === "on" || lower === "off" || lower === "true" || lower === "false") {
            return lower === "true" ? "on" : lower === "false" ? "off" : s;
        }
        return escapePgStringLiteral(s);
    }
    if (t === "integer" || t === "real") {
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return s;
        return escapePgStringLiteral(raw);
    }
    return escapePgStringLiteral(raw);
}

export function buildAlterSystemSet(row: PgRuntimeSettingRow): string {
    const rhs = formatGucSqlLiteral(row.setting, row.vartype);
    return `ALTER SYSTEM SET ${row.name} = ${rhs};`;
}

export function buildSessionSet(row: PgRuntimeSettingRow): string {
    const rhs = formatGucSqlLiteral(row.setting, row.vartype);
    return `SET ${row.name} = ${rhs};`;
}

export function buildResetToDefault(row: PgRuntimeSettingRow): string {
    return `ALTER SYSTEM RESET ${row.name};\n-- Then reload or restart as required for this parameter.`;
}

export function displaySettingValue(row: Pick<PgRuntimeSettingRow, "setting" | "unit">): string {
    const u = row.unit?.trim();
    if (!u) return row.setting;
    return `${row.setting} ${u}`;
}

function cellStr(row: CellValue[], idx: number): string {
    const c = row[idx];
    if (!c || c.type === "Null") return "";
    return formatCellValue(c);
}

function parseBoolCell(row: CellValue[], idx: number): boolean {
    const c = row[idx];
    if (!c || c.type === "Null") return false;
    if (c.type === "Bool") return Boolean(c.value);
    const s = String(c.value ?? "").toLowerCase();
    return s === "t" || s === "true" || s === "on" || s === "yes" || s === "1";
}

/** Map pg_settings query columns → typed rows. */
export function parsePgSettingsResult(result: QueryResult): PgRuntimeSettingRow[] {
    if (result.is_error || !result.columns.length) return [];
    const names = result.columns.map((c) => c.name.toLowerCase());
    const ix = (n: string) => names.indexOf(n.toLowerCase());
    const iName = ix("name");
    const iSetting = ix("setting");
    const iUnit = ix("unit");
    const iCategory = ix("category");
    const iShort = ix("short_desc");
    const iContext = ix("context");
    const iVartype = ix("vartype");
    const iSource = ix("source");
    const iBoot = ix("boot_val");
    const iReset = ix("reset_val");
    const iPending = ix("pending_restart");
    const iMin = ix("min_val");
    const iMax = ix("max_val");
    if (iName < 0 || iSetting < 0) return [];

    const out: PgRuntimeSettingRow[] = [];
    for (const row of result.rows) {
        out.push({
            name: cellStr(row, iName),
            setting: cellStr(row, iSetting),
            unit: iUnit >= 0 ? cellStr(row, iUnit) : "",
            category: iCategory >= 0 ? cellStr(row, iCategory) : "",
            short_desc: iShort >= 0 ? cellStr(row, iShort) : "",
            context: iContext >= 0 ? cellStr(row, iContext) : "",
            vartype: iVartype >= 0 ? cellStr(row, iVartype) : "string",
            source: iSource >= 0 ? cellStr(row, iSource) : "",
            boot_val: iBoot >= 0 ? cellStr(row, iBoot) : "",
            reset_val: iReset >= 0 ? cellStr(row, iReset) : "",
            pending_restart: iPending >= 0 ? parseBoolCell(row, iPending) : false,
            min_val: iMin >= 0 ? cellStr(row, iMin) : "",
            max_val: iMax >= 0 ? cellStr(row, iMax) : "",
        });
    }
    return out;
}

export type PgSettingContextTier = "restart" | "reload" | "superuser" | "session";

/** Rough scope hint for UI — helps developers avoid surprise reload/restart requirements. */
export function contextTier(context: string): PgSettingContextTier {
    const c = context.toLowerCase();
    if (c === "postmaster" || c === "internal") return "restart";
    if (c === "sighup") return "reload";
    if (c === "superuser" || c === "superuser-backend") return "superuser";
    return "session";
}

/** True when the parameter can be changed with SET for the current backend (user / superuser contexts). */
export function canSessionSetGuc(context: string): boolean {
    const c = context.toLowerCase();
    return c === "user" || c === "superuser";
}

/** Curated knobs PostgreSQL developers tune most often — drives “Spotlight” shortcuts in the UI. */
export const PG_RUNTIME_SPOTLIGHT: {
    id: string;
    label: string;
    description: string;
    names: string[];
}[] = [
    {
        id: "memory",
        label: "Memory",
        description: "Buffers and per-query workspace",
        names: [
            "shared_buffers",
            "effective_cache_size",
            "work_mem",
            "maintenance_work_mem",
            "temp_buffers",
            "hash_mem_multiplier",
            "logical_decoding_work_mem",
        ],
    },
    {
        id: "planner",
        label: "Planner",
        description: "Cost model and parallelism",
        names: [
            "random_page_cost",
            "seq_page_cost",
            "cpu_tuple_cost",
            "cpu_index_tuple_cost",
            "cpu_operator_cost",
            "effective_io_concurrency",
            "max_parallel_workers_per_gather",
            "max_parallel_workers",
            "max_worker_processes",
        ],
    },
    {
        id: "connections",
        label: "Connections",
        description: "Client limits and pooling headroom",
        names: [
            "max_connections",
            "superuser_reserved_connections",
            "reserved_connections",
            "tcp_keepalives_idle",
            "tcp_keepalives_interval",
            "tcp_keepalives_count",
        ],
    },
    {
        id: "wal",
        label: "WAL & checkpoints",
        description: "Durability and checkpoint pressure",
        names: [
            "wal_level",
            "max_wal_size",
            "min_wal_size",
            "checkpoint_timeout",
            "checkpoint_completion_target",
            "wal_buffers",
            "archive_mode",
            "archive_command",
        ],
    },
    {
        id: "replication",
        label: "Replication",
        description: "Standby and logical decoding",
        names: [
            "max_wal_senders",
            "max_replication_slots",
            "wal_keep_size",
            "hot_standby",
            "max_slot_wal_keep_size",
            "track_commit_timestamp",
        ],
    },
];

/** Copy-paste session recipes — safe defaults for local analytics / bulk load sessions (review before prod). */
export const PG_RUNTIME_RECIPES: { id: string; title: string; description: string; sql: string }[] = [
    {
        id: "analytics-session",
        title: "Analytics session",
        description: "Wider sort/hash workspace for heavy SELECTs (current session only).",
        sql: `-- Session-only — does not change postgresql.conf
SET work_mem = '256MB';
SET hash_mem_multiplier = 2.0;`,
    },
    {
        id: "bulk-load-session",
        title: "Bulk load helpers",
        description: "Disable synchronous commit for faster loads (risk: last transactions may be lost on crash).",
        sql: `-- Session-only — high durability risk; use only when you accept it
SET synchronous_commit = off;`,
    },
    {
        id: "debug-planner",
        title: "Planner introspection",
        description: "Enable detailed planner output for the current session.",
        sql: `SET client_min_messages = log;
SET log_min_messages = debug1;
-- Remember to RESET when finished.`,
    },
];
