//! Local SQLite-backed query history and performance analytics.
//! Data stays on device (app data directory) and is optimized for read-heavy UI workloads.

use chrono::{Duration, Local, TimeZone};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const SUBDIR: &str = "pgstudio";
const HISTORY_DB_FILE: &str = "query_history.db";
const MAX_LIMIT: u32 = 1000;
const DEFAULT_LIMIT: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryRecordInput {
    pub query_text: String,
    pub connection_id: String,
    pub connection_label: String,
    pub environment: Option<String>,
    pub guard_reason: Option<String>,
    pub executed_at: i64,
    pub planning_ms: Option<f64>,
    pub execution_ms: f64,
    pub total_ms: f64,
    pub rows_returned: Option<i64>,
    pub rows_affected: Option<i64>,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub explain_json: Option<String>,
    pub blks_hit: Option<i64>,
    pub blks_read: Option<i64>,
    pub temp_blks_written: Option<i64>,
    pub query_type: Option<String>,
    pub tables_touched: Option<Vec<String>>,
    pub was_cached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueryHistoryFilter {
    pub search_text: Option<String>,
    pub connection_id: Option<String>,
    pub status: Option<String>,
    pub query_type: Option<String>,
    pub was_cached: Option<bool>,
    pub bookmark_only: Option<bool>,
    pub min_time_ms: Option<f64>,
    pub max_time_ms: Option<f64>,
    pub from_time: Option<i64>,
    pub to_time: Option<i64>,
    pub tables: Option<Vec<String>>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistorySummary {
    pub id: i64,
    pub query_text: String,
    pub query_hash: i64,
    pub connection_id: String,
    pub connection_label: String,
    pub executed_at: i64,
    pub planning_ms: Option<f64>,
    pub execution_ms: f64,
    pub total_ms: f64,
    pub rows_returned: Option<i64>,
    pub rows_affected: Option<i64>,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub blks_hit: Option<i64>,
    pub blks_read: Option<i64>,
    pub temp_blks_written: Option<i64>,
    pub query_type: String,
    pub tables_touched: Vec<String>,
    pub was_cached: bool,
    pub run_count: i64,
    pub avg_ms: f64,
    pub fastest_ms: f64,
    pub slowest_ms: f64,
    pub bookmark: bool,
    pub note: Option<String>,
    pub environment: Option<String>,
    pub guard_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryPeer {
    pub id: i64,
    pub query_text: String,
    pub executed_at: i64,
    pub total_ms: f64,
    pub status: String,
    pub connection_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryDetail {
    pub item: QueryHistorySummary,
    pub query_normalized: String,
    pub explain_json: Option<String>,
    pub ai_analysis: Option<String>,
    pub similar_by_hash: Vec<QueryHistoryPeer>,
    pub similar_by_table: Vec<QueryHistoryPeer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryStats {
    pub total_queries: i64,
    pub avg_time_ms: f64,
    pub slowest_ms: f64,
    pub failed_count: i64,
    pub cached_count: i64,
    pub today_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryConnectionInfo {
    pub connection_id: String,
    pub connection_label: String,
    pub query_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryListResponse {
    pub items: Vec<QueryHistorySummary>,
    pub total_count: i64,
    pub stats: QueryHistoryStats,
    pub connections: Vec<QueryHistoryConnectionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryDashboardFilter {
    pub connection_id: Option<String>,
    pub from_time: Option<i64>,
    pub to_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDashboardPoint {
    pub bucket_start: i64,
    pub avg_ms: f64,
    pub total_count: i64,
    pub failed_count: i64,
    pub error_rate: f64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryVolumeHourPoint {
    pub hour: i32,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDashboardSlowItem {
    pub query_hash: i64,
    pub query_text: String,
    pub slowest_ms: f64,
    pub avg_ms: f64,
    pub run_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDashboardTableFrequency {
    pub table_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryAnomaly {
    pub query_hash: i64,
    pub query_text: String,
    pub previous_avg_ms: f64,
    pub recent_avg_ms: f64,
    pub delta_factor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryDashboard {
    pub trend: Vec<QueryDashboardPoint>,
    pub volume_by_hour: Vec<QueryVolumeHourPoint>,
    pub top_slowest: Vec<QueryDashboardSlowItem>,
    pub table_frequency: Vec<QueryDashboardTableFrequency>,
    pub anomalies: Vec<QueryAnomaly>,
}

#[derive(Debug, Clone)]
struct SearchOverrides {
    min_time_ms: Option<f64>,
    max_time_ms: Option<f64>,
    from_time: Option<i64>,
    to_time: Option<i64>,
    fts_text: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SqlFilterParts {
    where_sql: String,
    params: Vec<Value>,
}

fn history_db_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create history directory: {}", e))?;
    Ok(dir.join(HISTORY_DB_FILE))
}

fn open_history_db(app_data_dir: Option<PathBuf>) -> Result<Connection, String> {
    let path = history_db_path(app_data_dir)?;
    let conn =
        Connection::open(path).map_err(|e| format!("Failed to open query history DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to tune synchronous mode: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to tune temp_store: {}", e))?;

    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS query_history (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          query_text         TEXT    NOT NULL,
          query_hash         INTEGER NOT NULL,
          query_normalized   TEXT    NOT NULL,
          connection_id      TEXT    NOT NULL,
          connection_label   TEXT    NOT NULL,
          executed_at        INTEGER NOT NULL,
          planning_ms        REAL,
          execution_ms       REAL    NOT NULL,
          total_ms           REAL    NOT NULL,
          rows_returned      INTEGER,
          rows_affected      INTEGER,
          status             TEXT    NOT NULL,
          error_code         TEXT,
          error_message      TEXT,
          explain_json       TEXT,
          blks_hit           INTEGER,
          blks_read          INTEGER,
          temp_blks_written  INTEGER,
          query_type         TEXT    NOT NULL,
          tables_touched     TEXT,
          was_cached         INTEGER NOT NULL DEFAULT 0,
          ai_analysis        TEXT,
          bookmark           INTEGER NOT NULL DEFAULT 0,
          note               TEXT,
          environment        TEXT,
          guard_reason       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_qh_executed_at  ON query_history(executed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_qh_total_ms     ON query_history(total_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_qh_query_hash   ON query_history(query_hash);
        CREATE INDEX IF NOT EXISTS idx_qh_status       ON query_history(status);
        CREATE INDEX IF NOT EXISTS idx_qh_connection   ON query_history(connection_id);
        CREATE INDEX IF NOT EXISTS idx_qh_query_type   ON query_history(query_type);

        CREATE VIRTUAL TABLE IF NOT EXISTS query_history_fts
          USING fts5(query_text, connection_label, error_message);
        "#,
    )
    .map_err(|e| format!("Failed to initialize query history schema: {}", e))?;

    // Backward-compatible migrations for existing local DBs.
    match conn.execute("ALTER TABLE query_history ADD COLUMN environment TEXT", []) {
        Ok(_) => {}
        Err(err) => {
            let msg = err.to_string().to_ascii_lowercase();
            if !msg.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate query history (environment column): {}",
                    err
                ));
            }
        }
    }

    match conn.execute("ALTER TABLE query_history ADD COLUMN guard_reason TEXT", []) {
        Ok(_) => {}
        Err(err) => {
            let msg = err.to_string().to_ascii_lowercase();
            if !msg.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate query history (guard_reason column): {}",
                    err
                ));
            }
        }
    }

    Ok(())
}

fn to_json_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn parse_json_array(value: Option<String>) -> Vec<String> {
    value
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn normalize_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut prev_space = false;
    let mut in_single = false;
    let mut in_double = false;

    for ch in sql.chars() {
        if ch == '\'' && !in_double {
            in_single = !in_single;
            out.push(' ');
            prev_space = true;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
        }

        if in_single {
            continue;
        }

        let c = ch.to_ascii_lowercase();
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }

    out.trim().to_string()
}

fn fnv1a_hash_i64(input: &str) -> i64 {
    const OFFSET_BASIS: u64 = 14695981039346656037;
    const PRIME: u64 = 1099511628211;

    let mut hash = OFFSET_BASIS;
    for b in input.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(PRIME);
    }

    hash as i64
}

fn detect_query_type(sql: &str) -> String {
    let mut tokens = sql
        .split_whitespace()
        .map(|s| s.trim_matches(|c: char| !c.is_ascii_alphabetic()))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_uppercase());

    let first = tokens.next().unwrap_or_default();
    if first == "WITH" {
        let second = tokens.next().unwrap_or_default();
        if second == "SELECT" {
            return "SELECT".to_string();
        }
        if second == "INSERT" {
            return "INSERT".to_string();
        }
        if second == "UPDATE" {
            return "UPDATE".to_string();
        }
        if second == "DELETE" {
            return "DELETE".to_string();
        }
    }

    match first.as_str() {
        "SELECT" | "SHOW" | "EXPLAIN" | "TABLE" | "VALUES" => "SELECT".to_string(),
        "INSERT" => "INSERT".to_string(),
        "UPDATE" => "UPDATE".to_string(),
        "DELETE" => "DELETE".to_string(),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "REINDEX" => "DDL".to_string(),
        _ => "OTHER".to_string(),
    }
}

fn strip_identifier_quotes(raw: &str) -> String {
    raw.trim_matches('"')
        .trim_matches('`')
        .trim_matches('[')
        .trim_matches(']')
        .trim_matches('(')
        .trim_matches(')')
        .trim_matches(',')
        .trim_matches(';')
        .to_string()
}

fn extract_tables(sql: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in sql.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '"' {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let mut i = 0usize;
    while i < tokens.len() {
        let tk = tokens[i].to_ascii_lowercase();
        let follows_object_keyword =
            matches!(tk.as_str(), "from" | "join" | "update" | "into" | "table");

        if follows_object_keyword && i + 1 < tokens.len() {
            let mut raw = strip_identifier_quotes(&tokens[i + 1]);
            if raw.is_empty() {
                i += 1;
                continue;
            }

            if let Some(last) = raw.split('.').last() {
                raw = strip_identifier_quotes(last);
            }

            let lower = raw.to_ascii_lowercase();
            if !lower.is_empty()
                && !matches!(
                    lower.as_str(),
                    "select"
                        | "where"
                        | "set"
                        | "on"
                        | "group"
                        | "order"
                        | "limit"
                        | "offset"
                        | "values"
                        | "returning"
                        | "as"
                )
                && seen.insert(lower.clone())
            {
                out.push(lower);
            }
            i += 1;
        }

        i += 1;
    }

    out
}

fn numeric_search_bound(input: &str) -> Option<(char, f64)> {
    let trimmed = input.trim();
    let first = trimmed.chars().next()?;
    if first != '>' && first != '<' {
        return None;
    }
    let value = trimmed[1..].trim().parse::<f64>().ok()?;
    Some((first, value))
}

fn start_of_today_ms() -> i64 {
    let now = Local::now();
    let date = now.date_naive();
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .unwrap_or_else(|| now.naive_local());
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .unwrap_or(now)
        .timestamp_millis()
}

fn parse_search_overrides(search_text: Option<&str>) -> SearchOverrides {
    let mut out = SearchOverrides {
        min_time_ms: None,
        max_time_ms: None,
        from_time: None,
        to_time: None,
        fts_text: None,
    };

    let Some(raw) = search_text.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return out;
    };

    if let Some((op, value)) = numeric_search_bound(raw) {
        if op == '>' {
            out.min_time_ms = Some(value);
        } else {
            out.max_time_ms = Some(value);
        }
        return out;
    }

    let lower = raw.to_ascii_lowercase();
    let now_ms = Local::now().timestamp_millis();

    match lower.as_str() {
        "today" => {
            out.from_time = Some(start_of_today_ms());
            out.to_time = Some(now_ms);
        }
        "yesterday" => {
            let today = start_of_today_ms();
            out.from_time = Some(today - Duration::days(1).num_milliseconds());
            out.to_time = Some(today - 1);
        }
        "last week" | "last 7 days" => {
            out.from_time = Some(now_ms - Duration::days(7).num_milliseconds());
            out.to_time = Some(now_ms);
        }
        "last 30 days" => {
            out.from_time = Some(now_ms - Duration::days(30).num_milliseconds());
            out.to_time = Some(now_ms);
        }
        _ => {
            out.fts_text = Some(raw.to_string());
        }
    }

    out
}

fn to_fts_query(input: &str) -> String {
    let mut terms = Vec::new();
    for token in input.split_whitespace().filter(|s| !s.is_empty()) {
        let cleaned = token
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<String>();
        if !cleaned.is_empty() {
            terms.push(format!("\"{}\"*", cleaned));
        }
    }

    if terms.is_empty() {
        input
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || c.is_whitespace())
            .collect::<String>()
    } else {
        terms.join(" AND ")
    }
}

fn build_filter_parts(filter: &QueryHistoryFilter) -> SqlFilterParts {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    let search_overrides = parse_search_overrides(filter.search_text.as_deref());

    if let Some(conn_id) = filter
        .connection_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        clauses.push("connection_id = ?".to_string());
        params.push(Value::Text(conn_id.trim().to_string()));
    }

    if let Some(status) = filter.status.as_ref().filter(|s| !s.trim().is_empty()) {
        clauses.push("status = ?".to_string());
        params.push(Value::Text(status.trim().to_ascii_lowercase()));
    }

    if let Some(query_type) = filter.query_type.as_ref().filter(|s| !s.trim().is_empty()) {
        let normalized = query_type.trim().to_ascii_uppercase();
        if normalized == "DML" {
            clauses.push("query_type IN ('INSERT', 'UPDATE', 'DELETE')".to_string());
        } else {
            clauses.push("query_type = ?".to_string());
            params.push(Value::Text(normalized));
        }
    }

    if let Some(was_cached) = filter.was_cached {
        clauses.push("was_cached = ?".to_string());
        params.push(Value::Integer(if was_cached { 1 } else { 0 }));
    }

    if filter.bookmark_only.unwrap_or(false) {
        clauses.push("bookmark = 1".to_string());
    }

    let min_time = filter.min_time_ms.or(search_overrides.min_time_ms);
    if let Some(min_ms) = min_time {
        clauses.push("total_ms >= ?".to_string());
        params.push(Value::Real(min_ms));
    }

    let max_time = filter.max_time_ms.or(search_overrides.max_time_ms);
    if let Some(max_ms) = max_time {
        clauses.push("total_ms <= ?".to_string());
        params.push(Value::Real(max_ms));
    }

    let from_time = filter.from_time.or(search_overrides.from_time);
    if let Some(from) = from_time {
        clauses.push("executed_at >= ?".to_string());
        params.push(Value::Integer(from));
    }

    let to_time = filter.to_time.or(search_overrides.to_time);
    if let Some(to) = to_time {
        clauses.push("executed_at <= ?".to_string());
        params.push(Value::Integer(to));
    }

    if let Some(tables) = filter.tables.as_ref() {
        let cleaned: Vec<String> = tables
            .iter()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        if !cleaned.is_empty() {
            let mut table_clauses = Vec::new();
            for table in cleaned {
                table_clauses.push("tables_touched LIKE ?".to_string());
                params.push(Value::Text(format!("%\"{}\"%", table)));
            }
            clauses.push(format!("({})", table_clauses.join(" OR ")));
        }
    }

    if let Some(search_text) = search_overrides.fts_text.filter(|s| !s.trim().is_empty()) {
        let fts_query = to_fts_query(&search_text);
        if !fts_query.trim().is_empty() {
            clauses.push(
                "id IN (SELECT rowid FROM query_history_fts WHERE query_history_fts MATCH ?)"
                    .to_string(),
            );
            params.push(Value::Text(fts_query));
        }
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    SqlFilterParts { where_sql, params }
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueryHistorySummary> {
    let tables_raw: Option<String> = row.get(19)?;
    Ok(QueryHistorySummary {
        id: row.get(0)?,
        query_text: row.get(1)?,
        query_hash: row.get(2)?,
        connection_id: row.get(3)?,
        connection_label: row.get(4)?,
        executed_at: row.get(5)?,
        planning_ms: row.get(6)?,
        execution_ms: row.get(7)?,
        total_ms: row.get(8)?,
        rows_returned: row.get(9)?,
        rows_affected: row.get(10)?,
        status: row.get(11)?,
        error_code: row.get(12)?,
        error_message: row.get(13)?,
        blks_hit: row.get(15)?,
        blks_read: row.get(16)?,
        temp_blks_written: row.get(17)?,
        query_type: row.get(18)?,
        tables_touched: parse_json_array(tables_raw),
        was_cached: row.get::<_, i64>(20)? == 1,
        run_count: row.get(23)?,
        avg_ms: row.get(24)?,
        fastest_ms: row.get(25)?,
        slowest_ms: row.get(26)?,
        bookmark: row.get::<_, i64>(27)? == 1,
        note: row.get(28)?,
        environment: row.get(29)?,
        guard_reason: row.get(30)?,
    })
}

fn sort_clause(sort_by: Option<&str>, sort_dir: Option<&str>) -> String {
    let dir = match sort_dir.map(|d| d.to_ascii_uppercase()) {
        Some(d) if d == "ASC" => "ASC",
        _ => "DESC",
    };

    match sort_by.unwrap_or("slowest").to_ascii_lowercase().as_str() {
        "recent" | "executed_at" => format!("executed_at {}", dir),
        "frequency" | "most_frequent" => format!("run_count {}", dir),
        "disk" | "blks_read" => format!("COALESCE(blks_read, 0) {}", dir),
        "rows" | "rows_returned" => format!("COALESCE(rows_returned, 0) {}", dir),
        "errors" => format!("CASE WHEN status = 'failed' THEN 1 ELSE 0 END {}", dir),
        "table" | "alphabetical" => format!("LOWER(COALESCE(tables_touched, '')) {}", dir),
        _ => format!("total_ms {}", dir),
    }
}

pub fn record_query(
    app_data_dir: Option<PathBuf>,
    entry: QueryHistoryRecordInput,
) -> Result<i64, String> {
    let conn = open_history_db(app_data_dir)?;

    let normalized = normalize_sql(&entry.query_text);
    let query_hash = fnv1a_hash_i64(&normalized);
    let query_type = entry
        .query_type
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| detect_query_type(&entry.query_text));
    let tables_touched = entry
        .tables_touched
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| extract_tables(&entry.query_text));
    let tables_json = to_json_array(&tables_touched);

    conn.execute(
        r#"
        INSERT INTO query_history (
            query_text, query_hash, query_normalized, connection_id, connection_label,
            executed_at, planning_ms, execution_ms, total_ms, rows_returned, rows_affected,
            status, error_code, error_message, explain_json, blks_hit, blks_read,
            temp_blks_written, query_type, tables_touched, was_cached, ai_analysis,
            environment, guard_reason
        ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, NULL,
            ?, ?
        )
        "#,
        params![
            entry.query_text,
            query_hash,
            normalized,
            entry.connection_id,
            entry.connection_label,
            entry.executed_at,
            entry.planning_ms,
            entry.execution_ms,
            entry.total_ms,
            entry.rows_returned,
            entry.rows_affected,
            entry.status,
            entry.error_code,
            entry.error_message,
            entry.explain_json,
            entry.blks_hit,
            entry.blks_read,
            entry.temp_blks_written,
            query_type,
            tables_json,
            if entry.was_cached { 1_i64 } else { 0_i64 },
            entry.environment,
            entry.guard_reason,
        ],
    )
    .map_err(|e| format!("Failed to insert query history row: {}", e))?;

    let row_id = conn.last_insert_rowid();

    let _ = conn.execute(
        "INSERT INTO query_history_fts(rowid, query_text, connection_label, error_message) VALUES(?, ?, ?, ?)",
        params![
            row_id,
            &entry.query_text,
            &entry.connection_label,
            entry.error_message.unwrap_or_default(),
        ],
    );

    Ok(row_id)
}

pub fn list_queries(
    app_data_dir: Option<PathBuf>,
    filter: QueryHistoryFilter,
) -> Result<QueryHistoryListResponse, String> {
    let conn = open_history_db(app_data_dir)?;
    let filter_parts = build_filter_parts(&filter);

    let limit = filter.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = filter.offset.unwrap_or(0);

    let order_by = sort_clause(filter.sort_by.as_deref(), filter.sort_dir.as_deref());

    let mut list_params = filter_parts.params.clone();
    list_params.push(Value::Integer(limit as i64));
    list_params.push(Value::Integer(offset as i64));

    let list_sql = format!(
        r#"
        SELECT
            id,
            query_text,
            query_hash,
            connection_id,
            connection_label,
            executed_at,
            planning_ms,
            execution_ms,
            total_ms,
            rows_returned,
            rows_affected,
            status,
            error_code,
            error_message,
            explain_json,
            blks_hit,
            blks_read,
            temp_blks_written,
            query_type,
            tables_touched,
            was_cached,
            ai_analysis,
            query_normalized,
            COUNT(*) OVER (PARTITION BY query_hash) AS run_count,
            AVG(total_ms) OVER (PARTITION BY query_hash) AS avg_ms,
            MIN(total_ms) OVER (PARTITION BY query_hash) AS fastest_ms,
            MAX(total_ms) OVER (PARTITION BY query_hash) AS slowest_ms,
            bookmark,
            note,
            environment,
            guard_reason
        FROM query_history
        {}
        ORDER BY {}, executed_at DESC
        LIMIT ? OFFSET ?
        "#,
        filter_parts.where_sql, order_by,
    );

    let mut stmt = conn
        .prepare(&list_sql)
        .map_err(|e| format!("Failed to prepare query history list SQL: {}", e))?;

    let items = stmt
        .query_map(params_from_iter(list_params.iter()), row_to_summary)
        .map_err(|e| format!("Failed to query query history rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read query history rows: {}", e))?;

    let count_sql = format!(
        "SELECT COUNT(*) FROM query_history {}",
        filter_parts.where_sql
    );
    let total_count: i64 = conn
        .query_row(
            &count_sql,
            params_from_iter(filter_parts.params.iter()),
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to compute query history count: {}", e))?;

    let stats_sql = format!(
        r#"
        SELECT
            COUNT(*),
            COALESCE(AVG(total_ms), 0.0),
            COALESCE(MAX(total_ms), 0.0),
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN was_cached = 1 THEN 1 ELSE 0 END), 0)
        FROM query_history
        {}
        "#,
        filter_parts.where_sql,
    );

    let (total_queries, avg_time_ms, slowest_ms, failed_count, cached_count): (
        i64,
        f64,
        f64,
        i64,
        i64,
    ) = conn
        .query_row(
            &stats_sql,
            params_from_iter(filter_parts.params.iter()),
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to compute query history stats: {}", e))?;

    let today_start = start_of_today_ms();

    let mut today_params = filter_parts.params.clone();
    today_params.push(Value::Integer(today_start));

    let today_where = if filter_parts.where_sql.is_empty() {
        "WHERE executed_at >= ?".to_string()
    } else {
        format!("{} AND executed_at >= ?", filter_parts.where_sql)
    };

    let today_sql = format!("SELECT COUNT(*) FROM query_history {}", today_where);
    let today_count: i64 = conn
        .query_row(&today_sql, params_from_iter(today_params.iter()), |row| {
            row.get(0)
        })
        .map_err(|e| format!("Failed to compute today query history count: {}", e))?;

    let mut conn_stmt = conn
        .prepare(
            r#"
            SELECT connection_id, connection_label, COUNT(*) AS c
            FROM query_history
            GROUP BY connection_id, connection_label
            ORDER BY MAX(executed_at) DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare connection list SQL: {}", e))?;

    let connections = conn_stmt
        .query_map([], |row| {
            Ok(QueryHistoryConnectionInfo {
                connection_id: row.get(0)?,
                connection_label: row.get(1)?,
                query_count: row.get(2)?,
            })
        })
        .map_err(|e| format!("Failed to query connection list: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read connection list: {}", e))?;

    Ok(QueryHistoryListResponse {
        items,
        total_count,
        stats: QueryHistoryStats {
            total_queries,
            avg_time_ms,
            slowest_ms,
            failed_count,
            cached_count,
            today_count,
        },
        connections,
    })
}

pub fn get_query_detail(
    app_data_dir: Option<PathBuf>,
    id: i64,
) -> Result<QueryHistoryDetail, String> {
    let conn = open_history_db(app_data_dir)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                id,
                query_text,
                query_hash,
                connection_id,
                connection_label,
                executed_at,
                planning_ms,
                execution_ms,
                total_ms,
                rows_returned,
                rows_affected,
                status,
                error_code,
                error_message,
                explain_json,
                blks_hit,
                blks_read,
                temp_blks_written,
                query_type,
                tables_touched,
                was_cached,
                ai_analysis,
                query_normalized,
                (SELECT COUNT(*) FROM query_history q2 WHERE q2.query_hash = query_history.query_hash) AS run_count,
                (SELECT COALESCE(AVG(q2.total_ms), 0.0) FROM query_history q2 WHERE q2.query_hash = query_history.query_hash) AS avg_ms,
                (SELECT COALESCE(MIN(q2.total_ms), 0.0) FROM query_history q2 WHERE q2.query_hash = query_history.query_hash) AS fastest_ms,
                (SELECT COALESCE(MAX(q2.total_ms), 0.0) FROM query_history q2 WHERE q2.query_hash = query_history.query_hash) AS slowest_ms,
                bookmark,
                note,
                environment,
                guard_reason
            FROM query_history
            WHERE id = ?
            "#,
        )
        .map_err(|e| format!("Failed to prepare query detail SQL: {}", e))?;

    let mut rows = stmt
        .query(params![id])
        .map_err(|e| format!("Failed to execute query detail SQL: {}", e))?;

    let row = rows
        .next()
        .map_err(|e| format!("Failed to read query detail row: {}", e))?
        .ok_or_else(|| format!("No query history record found with id {}", id))?;

    let item =
        row_to_summary(row).map_err(|e| format!("Failed to parse query detail row: {}", e))?;
    let explain_json: Option<String> = row.get(14).ok();
    let ai_analysis: Option<String> = row.get(21).ok();
    let query_normalized: String = row.get(22).unwrap_or_default();

    let mut similar_by_hash_stmt = conn
        .prepare(
            r#"
            SELECT id, query_text, executed_at, total_ms, status, connection_label
            FROM query_history
            WHERE query_hash = ? AND id != ?
            ORDER BY executed_at DESC
            LIMIT 20
            "#,
        )
        .map_err(|e| format!("Failed to prepare similar-by-hash SQL: {}", e))?;

    let similar_by_hash = similar_by_hash_stmt
        .query_map(params![item.query_hash, item.id], |row| {
            Ok(QueryHistoryPeer {
                id: row.get(0)?,
                query_text: row.get(1)?,
                executed_at: row.get(2)?,
                total_ms: row.get(3)?,
                status: row.get(4)?,
                connection_label: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query similar-by-hash rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read similar-by-hash rows: {}", e))?;

    let similar_by_table = if item.tables_touched.is_empty() {
        Vec::new()
    } else {
        let mut table_clauses = Vec::new();
        let mut table_params: Vec<Value> = vec![Value::Integer(item.id)];
        for table in &item.tables_touched {
            table_clauses.push("tables_touched LIKE ?".to_string());
            table_params.push(Value::Text(format!("%\"{}\"%", table.to_ascii_lowercase())));
        }

        let sql = format!(
            "SELECT id, query_text, executed_at, total_ms, status, connection_label\n             FROM query_history\n             WHERE id != ? AND ({})\n             ORDER BY executed_at DESC\n             LIMIT 20",
            table_clauses.join(" OR ")
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare similar-by-table SQL: {}", e))?;

        let mapped_rows = stmt
            .query_map(params_from_iter(table_params.iter()), |row| {
                Ok(QueryHistoryPeer {
                    id: row.get(0)?,
                    query_text: row.get(1)?,
                    executed_at: row.get(2)?,
                    total_ms: row.get(3)?,
                    status: row.get(4)?,
                    connection_label: row.get(5)?,
                })
            })
            .map_err(|e| format!("Failed to query similar-by-table rows: {}", e))?;
        mapped_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read similar-by-table rows: {}", e))?
    };

    Ok(QueryHistoryDetail {
        item,
        query_normalized,
        explain_json,
        ai_analysis,
        similar_by_hash,
        similar_by_table,
    })
}

fn range_or_default(range: &QueryHistoryDashboardFilter) -> (i64, i64) {
    let now = Local::now().timestamp_millis();
    let to = range.to_time.unwrap_or(now);
    let from = range
        .from_time
        .unwrap_or_else(|| to - Duration::days(7).num_milliseconds());
    (from, to)
}

fn dashboard_where(range: &QueryHistoryDashboardFilter) -> (String, Vec<Value>) {
    let (from, to) = range_or_default(range);
    let mut clauses = vec![
        "executed_at >= ?".to_string(),
        "executed_at <= ?".to_string(),
    ];
    let mut params = vec![Value::Integer(from), Value::Integer(to)];

    if let Some(conn) = range
        .connection_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        clauses.push("connection_id = ?".to_string());
        params.push(Value::Text(conn.trim().to_string()));
    }

    (format!("WHERE {}", clauses.join(" AND ")), params)
}

pub fn get_dashboard(
    app_data_dir: Option<PathBuf>,
    range: QueryHistoryDashboardFilter,
) -> Result<QueryHistoryDashboard, String> {
    let conn = open_history_db(app_data_dir)?;
    let (from, to) = range_or_default(&range);
    let (where_sql, base_params) = dashboard_where(&range);

    let bucket_size_ms = if to - from <= Duration::days(2).num_milliseconds() {
        Duration::hours(1).num_milliseconds()
    } else {
        Duration::days(1).num_milliseconds()
    };

    let trend_sql = format!(
        r#"
        SELECT
            (executed_at / ?) * ? AS bucket,
            COUNT(*) AS total_count,
            COALESCE(AVG(total_ms), 0.0) AS avg_ms,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
            COALESCE(SUM(CASE WHEN was_cached = 1 THEN 1 ELSE 0 END), 0) AS cached_count
        FROM query_history
        {}
        GROUP BY bucket
        ORDER BY bucket ASC
        "#,
        where_sql
    );

    let mut trend_params = vec![
        Value::Integer(bucket_size_ms),
        Value::Integer(bucket_size_ms),
    ];
    trend_params.extend(base_params.clone());

    let mut trend_stmt = conn
        .prepare(&trend_sql)
        .map_err(|e| format!("Failed to prepare trend SQL: {}", e))?;

    let trend = trend_stmt
        .query_map(params_from_iter(trend_params.iter()), |row| {
            let bucket_start: i64 = row.get(0)?;
            let total_count: i64 = row.get(1)?;
            let avg_ms: f64 = row.get(2)?;
            let failed_count: i64 = row.get(3)?;
            let cached_count: i64 = row.get(4)?;
            let error_rate = if total_count > 0 {
                (failed_count as f64 / total_count as f64) * 100.0
            } else {
                0.0
            };
            let cache_hit_rate = if total_count > 0 {
                (cached_count as f64 / total_count as f64) * 100.0
            } else {
                0.0
            };

            Ok(QueryDashboardPoint {
                bucket_start,
                avg_ms,
                total_count,
                failed_count,
                error_rate,
                cache_hit_rate,
            })
        })
        .map_err(|e| format!("Failed to query trend rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read trend rows: {}", e))?;

    let today_start = start_of_today_ms();
    let mut volume_params = base_params.clone();
    volume_params.push(Value::Integer(today_start));
    let volume_where = format!("{} AND executed_at >= ?", where_sql);

    let volume_sql = format!(
        r#"
        SELECT CAST(strftime('%H', executed_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
               COUNT(*)
        FROM query_history
        {}
        GROUP BY h
        ORDER BY h ASC
        "#,
        volume_where
    );

    let mut volume_stmt = conn
        .prepare(&volume_sql)
        .map_err(|e| format!("Failed to prepare volume-by-hour SQL: {}", e))?;

    let volume_by_hour = volume_stmt
        .query_map(params_from_iter(volume_params.iter()), |row| {
            Ok(QueryVolumeHourPoint {
                hour: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to query volume-by-hour rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read volume-by-hour rows: {}", e))?;

    let top_slowest_sql = format!(
        r#"
        SELECT
            q1.query_hash,
            (SELECT q2.query_text FROM query_history q2 WHERE q2.query_hash = q1.query_hash ORDER BY q2.executed_at DESC LIMIT 1) AS query_text,
            MAX(q1.total_ms) AS slowest_ms,
            AVG(q1.total_ms) AS avg_ms,
            COUNT(*) AS run_count
        FROM query_history q1
        {}
        GROUP BY q1.query_hash
        ORDER BY slowest_ms DESC
        LIMIT 10
        "#,
        where_sql
    );

    let mut top_stmt = conn
        .prepare(&top_slowest_sql)
        .map_err(|e| format!("Failed to prepare top-slowest SQL: {}", e))?;

    let top_slowest = top_stmt
        .query_map(params_from_iter(base_params.iter()), |row| {
            Ok(QueryDashboardSlowItem {
                query_hash: row.get(0)?,
                query_text: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                slowest_ms: row.get(2)?,
                avg_ms: row.get(3)?,
                run_count: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query top-slowest rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read top-slowest rows: {}", e))?;

    let table_freq_sql = format!(
        "SELECT tables_touched FROM query_history {} AND tables_touched IS NOT NULL AND tables_touched != '' ORDER BY executed_at DESC LIMIT 5000",
        where_sql
    );

    let mut table_freq_stmt = conn
        .prepare(&table_freq_sql)
        .map_err(|e| format!("Failed to prepare table-frequency SQL: {}", e))?;

    let table_rows = table_freq_stmt
        .query_map(params_from_iter(base_params.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("Failed to query table-frequency rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read table-frequency rows: {}", e))?;

    let mut table_counts: HashMap<String, i64> = HashMap::new();
    for raw in table_rows {
        for table in parse_json_array(Some(raw)) {
            *table_counts.entry(table).or_insert(0) += 1;
        }
    }

    let mut table_frequency: Vec<QueryDashboardTableFrequency> = table_counts
        .into_iter()
        .map(|(table_name, count)| QueryDashboardTableFrequency { table_name, count })
        .collect();
    table_frequency.sort_by(|a, b| b.count.cmp(&a.count));
    table_frequency.truncate(10);

    // Recent-vs-baseline anomaly detection in a bounded window for predictable performance.
    let baseline_from = to - Duration::days(8).num_milliseconds();
    let recent_from = to - Duration::hours(24).num_milliseconds();

    let mut anomaly_clauses = vec![
        "executed_at >= ?".to_string(),
        "executed_at <= ?".to_string(),
    ];
    let mut anomaly_params = vec![Value::Integer(baseline_from), Value::Integer(to)];
    if let Some(conn_id) = range
        .connection_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        anomaly_clauses.push("connection_id = ?".to_string());
        anomaly_params.push(Value::Text(conn_id.trim().to_string()));
    }

    let anomaly_sql = format!(
        "SELECT query_hash, query_text, total_ms, executed_at FROM query_history WHERE {} ORDER BY executed_at DESC LIMIT 10000",
        anomaly_clauses.join(" AND ")
    );

    let mut anomaly_stmt = conn
        .prepare(&anomaly_sql)
        .map_err(|e| format!("Failed to prepare anomaly SQL: {}", e))?;

    let anomaly_rows = anomaly_stmt
        .query_map(params_from_iter(anomaly_params.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("Failed to query anomaly rows: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read anomaly rows: {}", e))?;

    #[derive(Default)]
    struct Bucket {
        recent_sum: f64,
        recent_count: i64,
        previous_sum: f64,
        previous_count: i64,
        sample_query: String,
    }

    let mut buckets: HashMap<i64, Bucket> = HashMap::new();

    for (hash, query_text, ms, executed_at) in anomaly_rows {
        let entry = buckets.entry(hash).or_default();
        if entry.sample_query.is_empty() {
            entry.sample_query = query_text;
        }
        if executed_at >= recent_from {
            entry.recent_sum += ms;
            entry.recent_count += 1;
        } else {
            entry.previous_sum += ms;
            entry.previous_count += 1;
        }
    }

    let mut anomalies = Vec::new();
    for (hash, b) in buckets {
        if b.recent_count < 2 || b.previous_count < 3 {
            continue;
        }
        let recent_avg = b.recent_sum / b.recent_count as f64;
        let previous_avg = b.previous_sum / b.previous_count as f64;
        if previous_avg <= 0.0 {
            continue;
        }
        let factor = recent_avg / previous_avg;
        if factor >= 2.0 && (recent_avg - previous_avg) >= 100.0 {
            anomalies.push(QueryAnomaly {
                query_hash: hash,
                query_text: b.sample_query,
                previous_avg_ms: previous_avg,
                recent_avg_ms: recent_avg,
                delta_factor: factor,
            });
        }
    }

    anomalies.sort_by(|a, b| {
        b.delta_factor
            .partial_cmp(&a.delta_factor)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    anomalies.truncate(10);

    Ok(QueryHistoryDashboard {
        trend,
        volume_by_hour,
        top_slowest,
        table_frequency,
        anomalies,
    })
}

pub fn save_ai_analysis(
    app_data_dir: Option<PathBuf>,
    id: i64,
    analysis_json: String,
) -> Result<(), String> {
    let conn = open_history_db(app_data_dir)?;
    conn.execute(
        "UPDATE query_history SET ai_analysis = ? WHERE id = ?",
        params![analysis_json, id],
    )
    .map_err(|e| format!("Failed to save AI analysis: {}", e))?;
    Ok(())
}

pub fn save_explain_json(
    app_data_dir: Option<PathBuf>,
    id: i64,
    explain_json: String,
) -> Result<(), String> {
    let conn = open_history_db(app_data_dir)?;
    conn.execute(
        "UPDATE query_history SET explain_json = ? WHERE id = ?",
        params![explain_json, id],
    )
    .map_err(|e| format!("Failed to save explain JSON: {}", e))?;
    Ok(())
}

pub fn toggle_bookmark(
    app_data_dir: Option<PathBuf>,
    id: i64,
    bookmark: bool,
) -> Result<(), String> {
    let conn = open_history_db(app_data_dir)?;
    conn.execute(
        "UPDATE query_history SET bookmark = ? WHERE id = ?",
        params![if bookmark { 1_i64 } else { 0_i64 }, id],
    )
    .map_err(|e| format!("Failed to update bookmark: {}", e))?;
    Ok(())
}

pub fn save_note(
    app_data_dir: Option<PathBuf>,
    id: i64,
    note: Option<String>,
) -> Result<(), String> {
    let conn = open_history_db(app_data_dir)?;
    conn.execute(
        "UPDATE query_history SET note = ? WHERE id = ?",
        params![note, id],
    )
    .map_err(|e| format!("Failed to save note: {}", e))?;
    Ok(())
}

pub fn export_csv(
    app_data_dir: Option<PathBuf>,
    filter: QueryHistoryFilter,
) -> Result<String, String> {
    let conn = open_history_db(app_data_dir)?;
    let filter_parts = build_filter_parts(&filter);

    let sql = format!(
        r#"
        SELECT
            id,
            query_text,
            query_hash,
            connection_label,
            executed_at,
            query_type,
            total_ms,
            execution_ms,
            planning_ms,
            rows_returned,
            rows_affected,
            status,
            error_code,
            error_message,
            blks_hit,
            blks_read,
            temp_blks_written,
            tables_touched,
            was_cached,
            environment,
            guard_reason
        FROM query_history
        {}
        ORDER BY executed_at DESC
        "#,
        filter_parts.where_sql
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare CSV export SQL: {}", e))?;

    let mut rows = stmt
        .query(params_from_iter(filter_parts.params.iter()))
        .map_err(|e| format!("Failed to execute CSV export SQL: {}", e))?;

    let mut csv = String::from("id,query_text,query_hash,connection_label,executed_at,query_type,total_ms,execution_ms,planning_ms,rows_returned,rows_affected,status,error_code,error_message,blks_hit,blks_read,temp_blks_written,tables_touched,was_cached,environment,guard_reason\n");

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Failed to read CSV export rows: {}", e))?
    {
        let query_text: String = row.get(1).unwrap_or_default();
        let error_message: Option<String> = row.get(13).unwrap_or(None);
        let tables_touched: Option<String> = row.get(17).unwrap_or(None);
        let environment: Option<String> = row.get(19).unwrap_or(None);
        let guard_reason: Option<String> = row.get(20).unwrap_or(None);

        let cols = vec![
            row.get::<_, i64>(0).unwrap_or_default().to_string(),
            csv_escape(&query_text),
            row.get::<_, i64>(2).unwrap_or_default().to_string(),
            csv_escape(&row.get::<_, String>(3).unwrap_or_default()),
            row.get::<_, i64>(4).unwrap_or_default().to_string(),
            csv_escape(&row.get::<_, String>(5).unwrap_or_default()),
            row.get::<_, f64>(6).unwrap_or_default().to_string(),
            row.get::<_, f64>(7).unwrap_or_default().to_string(),
            row.get::<_, Option<f64>>(8)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            row.get::<_, Option<i64>>(9)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            row.get::<_, Option<i64>>(10)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            csv_escape(&row.get::<_, String>(11).unwrap_or_default()),
            csv_escape(
                &row.get::<_, Option<String>>(12)
                    .unwrap_or(None)
                    .unwrap_or_default(),
            ),
            csv_escape(&error_message.unwrap_or_default()),
            row.get::<_, Option<i64>>(14)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            row.get::<_, Option<i64>>(15)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            row.get::<_, Option<i64>>(16)
                .unwrap_or(None)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            csv_escape(&tables_touched.unwrap_or_default()),
            row.get::<_, i64>(18).unwrap_or_default().to_string(),
            csv_escape(&environment.unwrap_or_default()),
            csv_escape(&guard_reason.unwrap_or_default()),
        ];
        csv.push_str(&cols.join(","));
        csv.push('\n');
    }

    Ok(csv)
}

fn csv_escape(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}
