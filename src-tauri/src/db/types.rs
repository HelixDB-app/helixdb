use serde::{Deserialize, Serialize};

/// Represents a single cell value from a PostgreSQL query result.
/// Covers all major PG types, serialized as JSON-friendly variants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum CellValue {
    Null,
    Bool(bool),
    Int16(i16),
    Int32(i32),
    Int64(i64),
    Float32(f32),
    Float64(f64),
    String(String),
    Json(serde_json::Value),
    DateTime(String), // ISO 8601
    Date(String),
    Time(String),
    Uuid(String),
    Bytes(Vec<u8>),
}

/// Column metadata for query results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub ordinal_position: i32,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
}

/// Schema metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub table_count: i64,
}

/// Table metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: String,
    pub row_count: i64,
    pub table_type: String, // "BASE TABLE" or "VIEW"
}

/// Query result with rows, columns, timing, and pagination info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: usize,
    pub total_rows: Option<i64>,
    pub execution_time_ms: f64,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub query: String,
    pub is_error: bool,
    pub error_message: Option<String>,
}

/// Column info within a query result (lighter than ColumnInfo)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
}

/// Sort direction for table data requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SortDirection {
    Asc,
    Desc,
}

/// Connection response returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResponse {
    pub connection_id: String,
    pub database_name: String,
    /// Full version string, e.g. "PostgreSQL 16.4 on ..."
    pub server_version: String,
    /// Numeric version, e.g. 160004 for PG 16.4. Useful for feature detection on the UI.
    pub pg_version_num: u32,
}

/// Event trigger (cluster/database level) — available since PG 9.3
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventTriggerInfo {
    pub name: String,
    /// DDL event: ddl_command_start | ddl_command_end | sql_drop | table_rewrite
    pub event: String,
    /// Firing state: origin | disabled | replica | always
    pub enabled: String,
    /// Name of the trigger function
    pub function_name: String,
}

/// Function or procedure in a schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub arguments: String,
    pub return_type: String,
    pub is_trigger_function: bool,
    /// function | procedure | aggregate | window
    pub kind: String,
    /// Procedural language, e.g. plpgsql, sql, c, internal
    pub language: String,
    /// Whether the function runs with the privileges of the definer
    pub security_definer: bool,
    /// Whether the function returns NULL on any NULL argument (STRICT)
    pub is_strict: bool,
}

/// User-defined type in a schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeInfo {
    pub name: String,
    /// enum | composite | domain | range | multirange
    pub kind: String,
}

/// Table constraint (primary key, foreign key, unique, check)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableConstraint {
    pub name: String,
    /// p = primary key, f = foreign key, u = unique, c = check, x = exclusion
    pub constraint_type: String,
    pub columns: Vec<String>,
    /// For foreign keys: referenced table
    pub foreign_table: Option<String>,
    /// For foreign keys: referenced columns
    pub foreign_columns: Option<Vec<String>>,
    /// For check constraints: expression
    pub check_clause: Option<String>,
}

/// Table index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableIndex {
    pub name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub index_type: String,
    pub columns: Vec<String>,
    pub definition: String,
}

/// Table trigger
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableTriggerInfo {
    pub name: String,
    pub timing: String,
    pub events: Vec<String>,
    pub function_name: String,
    pub enabled: bool,
}

/// Column definition used when creating a new table
#[derive(Debug, Clone, Deserialize)]
pub struct CreateColumnDef {
    pub name: String,
    /// Base PostgreSQL type, e.g. "varchar", "integer", "numeric"
    pub data_type: String,
    /// Optional length/precision string, e.g. "255" or "10,2"
    pub length: Option<String>,
    pub is_nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub check_constraint: Option<String>,
}

/// Full table details (columns + constraints + indexes + triggers + stats)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDetails {
    pub schema: String,
    pub name: String,
    pub table_type: String,
    pub columns: Vec<ColumnInfo>,
    pub constraints: Vec<TableConstraint>,
    pub indexes: Vec<TableIndex>,
    pub triggers: Vec<TableTriggerInfo>,
    pub row_count: i64,
    pub total_size: String,
    pub table_size: String,
    pub indexes_size: String,
    pub comment: Option<String>,
}

/// Statistics for a single column (fetched on demand).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnStats {
    pub column: String,
    pub total_rows: i64,
    pub null_count: i64,
    pub non_null_count: i64,
    pub distinct_count: i64,
    pub null_pct: f64,
    /// Min value as text (works for all types via ::text cast)
    pub min_value: Option<String>,
    /// Max value as text
    pub max_value: Option<String>,
    /// Average — Some only for numeric columns
    pub avg_value: Option<f64>,
    /// Top 5 most frequent (value_text, count) pairs
    pub top_values: Vec<(String, i64)>,
}

/// A single filter condition used for multi-condition table search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCondition {
    pub column: String,
    /// Whitelisted SQL operator: =, !=, >, <, >=, <=, LIKE, NOT LIKE, ILIKE, NOT ILIKE, IS NULL, IS NOT NULL
    pub operator: String,
    /// None for IS NULL / IS NOT NULL operators
    pub value: Option<String>,
    /// How to join with the previous condition: "AND" | "OR". Ignored for index 0.
    pub logical_op: String,
}

/// A live PostgreSQL session row from pg_stat_activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgSession {
    pub pid: i32,
    pub usename: Option<String>,
    pub application_name: Option<String>,
    pub datname: Option<String>,
    pub client_addr: Option<String>,
    pub client_port: Option<i32>,
    pub backend_start: Option<String>,
    pub xact_start: Option<String>,
    pub query_start: Option<String>,
    pub state_change: Option<String>,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    pub state: Option<String>,
    pub query: Option<String>,
    pub backend_type: Option<String>,
    pub blocking_pids: Vec<i32>,
    pub query_duration_secs: Option<f64>,
    pub xact_duration_secs: Option<f64>,
    pub backend_duration_secs: Option<f64>,
}

/// Extended index info with live usage statistics from pg_stat_user_indexes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStats {
    pub schema: String,
    pub table_name: String,
    pub index_name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    /// Access method: btree, hash, gin, gist, brin, spgist
    pub index_type: String,
    pub columns: Vec<String>,
    /// Full CREATE INDEX definition from pg_indexes
    pub definition: String,
    /// Human-readable size, e.g. "12 MB"
    pub size_pretty: String,
    pub size_bytes: i64,
    /// Total index scans since stats reset
    pub idx_scans: i64,
    /// Estimated scans per day based on stats_reset time
    pub scans_per_day: f64,
    /// True if idx_scans == 0 (candidate for removal)
    pub is_unused: bool,
    /// When pg_stat_user_indexes stats were last reset
    pub stats_reset: Option<String>,
}

/// A query from pg_stat_statements that would benefit from a proposed index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexImpactQuery {
    pub query: String,
    pub calls: i64,
    pub mean_exec_time_ms: f64,
    pub total_exec_time_ms: f64,
    /// Estimated execution time after index (based on seq scan / index scan cost ratio)
    pub estimated_time_after_ms: f64,
    /// Human description of why this query benefits, e.g. "Seq Scan on orders filtering user_id"
    pub benefit_reason: String,
}

/// Progress of a CONCURRENTLY-built index from pg_stat_progress_create_index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexBuildProgress {
    pub index_name: String,
    pub phase: String,
    pub blocks_done: i64,
    pub blocks_total: i64,
    pub tuples_done: i64,
    pub tuples_total: i64,
    /// 0.0–100.0 progress percentage
    pub percent_done: f64,
    pub is_complete: bool,
}

/// Parameters for creating a new index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIndexRequest {
    pub schema: String,
    pub table_name: String,
    /// If None, auto-generated as idx_{table}_{cols}
    pub index_name: Option<String>,
    pub columns: Vec<String>,
    /// BTREE, HASH, GIN, GIST, BRIN, SPGIST
    pub index_type: String,
    pub is_unique: bool,
    /// Optional predicate for partial index, e.g. "deleted_at IS NULL"
    pub where_clause: Option<String>,
}

/// Detailed type definition for preview (enum labels, composite attrs, domain info, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeDefinitionDetail {
    pub schema: String,
    pub name: String,
    pub kind: String,
    /// Enum: ordered list of labels
    pub enum_labels: Option<Vec<String>>,
    /// Composite: (attribute_name, type_name)
    pub composite_attrs: Option<Vec<(String, String)>>,
    /// Domain: base type name
    pub domain_base_type: Option<String>,
    /// Domain: check constraint expression if any
    pub domain_check: Option<String>,
    /// Range: subtype name
    pub range_subtype: Option<String>,
}
