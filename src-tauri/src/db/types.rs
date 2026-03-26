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
    /// `GENERATED ALWAYS AS ... STORED` / PG `attgenerated` — cannot INSERT/UPDATE values directly.
    #[serde(default)]
    pub is_generated: bool,
    pub comment: Option<String>,
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
    pub table_comment: Option<String>,
}

/// Recently opened table/view in the UI (connection-scoped)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentTableOpen {
    pub schema: String,
    pub table: String,
    /// "BASE TABLE" or "VIEW"
    pub table_type: String,
    /// Unix epoch (milliseconds)
    pub opened_at: i64,
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
    /// For enum columns, ordered list of allowed values (from pg_enum). Enables dropdown in UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_labels: Option<Vec<String>>,
}

/// Sort direction for table data requests
#[allow(dead_code)]
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

/// Access capabilities of the currently connected PostgreSQL role.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseAccessProfile {
    pub current_user: String,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub can_create_in_database: bool,
    pub is_admin: bool,
}

/// One extension in pg_available_extensions plus install permissions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseExtensionInfo {
    pub name: String,
    pub default_version: Option<String>,
    pub installed_version: Option<String>,
    pub comment: Option<String>,
    pub requires_superuser: bool,
    pub trusted: bool,
    pub can_install: bool,
    pub install_block_reason: Option<String>,
}

/// A database role (login or group) with RBAC assignment capability metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRoleInfo {
    pub name: String,
    pub can_login: bool,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub is_system_role: bool,
    pub is_assignable: bool,
}

/// One member attached to a role (for detailed RBAC views).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRoleMemberInfo {
    pub name: String,
    pub can_login: bool,
    pub is_superuser: bool,
    pub is_system_role: bool,
    pub admin_option: bool,
}

/// Rich metadata for one role in RBAC management views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRoleDetail {
    pub name: String,
    pub can_login: bool,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub can_replicate: bool,
    pub can_bypass_rls: bool,
    pub inherit: bool,
    pub valid_until: Option<String>,
    pub comment: Option<String>,
    pub is_system_role: bool,
    pub is_assignable: bool,
    pub can_grant_membership: bool,
    pub can_revoke_membership: bool,
    pub manage_block_reason: Option<String>,
    pub member_of: Vec<String>,
    pub members: Vec<DatabaseRoleMemberInfo>,
}

/// A login account with role attributes and memberships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseUserInfo {
    pub username: String,
    pub can_login: bool,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub can_replicate: bool,
    pub can_bypass_rls: bool,
    pub is_system_role: bool,
    pub valid_until: Option<String>,
    pub member_of: Vec<String>,
}

/// Rich metadata for one extension detail view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseExtensionDetail {
    pub name: String,
    pub default_version: Option<String>,
    pub installed_version: Option<String>,
    pub installed_schema: Option<String>,
    pub installed_owner: Option<String>,
    pub comment: Option<String>,
    pub requires_superuser: bool,
    pub trusted: bool,
    pub available_versions: Vec<String>,
    pub can_install: bool,
    pub can_uninstall: bool,
    pub can_update: bool,
    pub install_block_reason: Option<String>,
    pub uninstall_block_reason: Option<String>,
    pub update_block_reason: Option<String>,
}

/// Request payload for creating a database user through GUI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDatabaseUserRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub role_memberships: Vec<String>,
    #[serde(default)]
    pub can_create_db: bool,
    #[serde(default)]
    pub can_create_role: bool,
    #[serde(default)]
    pub is_superuser: bool,
    #[serde(default = "default_true")]
    pub inherit: bool,
    #[serde(default)]
    pub replication: bool,
    #[serde(default)]
    pub bypass_rls: bool,
    pub valid_until: Option<String>,
    pub password_reminder: Option<String>,
}

/// Request payload for creating a custom NOLOGIN RBAC role.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDatabaseRoleRequest {
    pub role_name: String,
    #[serde(default = "default_true")]
    pub inherit: bool,
    #[serde(default)]
    pub memberships: Vec<String>,
}

fn default_true() -> bool {
    true
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
    pub comment: Option<String>,
}

/// Documentation context for a table object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentationTable {
    pub schema: String,
    pub table: String,
    pub table_type: String,
    pub comment: Option<String>,
}

/// Documentation context for a column object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentationColumn {
    pub schema: String,
    pub table: String,
    pub table_type: String,
    pub ordinal_position: i32,
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub foreign_key_target: Option<String>,
    pub comment: Option<String>,
}

/// Documentation context for an index object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentationIndex {
    pub schema: String,
    pub table: String,
    pub table_type: String,
    pub name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub index_type: String,
    pub columns: Vec<String>,
    pub definition: String,
    pub comment: Option<String>,
}

/// Full context payload for AI doc generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentationContext {
    pub database_name: String,
    pub tables: Vec<DocumentationTable>,
    pub columns: Vec<DocumentationColumn>,
    pub indexes: Vec<DocumentationIndex>,
    pub undocumented_tables: usize,
    pub undocumented_columns: usize,
    pub undocumented_indexes: usize,
}

/// A documentation comment patch to apply with COMMENT ON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentationCommentPatch {
    /// table | column | index
    pub kind: String,
    pub schema: String,
    pub table: Option<String>,
    pub column: Option<String>,
    pub index: Option<String>,
    pub comment: String,
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

/// Sample query from pg_stat_statements for a table (for AI index optimization context)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuerySample {
    pub query: String,
    pub calls: i64,
    pub mean_exec_time_ms: f64,
}

/// Runtime status of pg_stat_statements on the connected database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgStatStatementsStatus {
    pub extension_installed: bool,
    pub preload_enabled: bool,
    pub can_query: bool,
    pub shared_preload_libraries: Option<String>,
    pub message: Option<String>,
}

/// Search/sort/pagination parameters for pg_stat_statements list view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgStatStatementsFilter {
    pub search_text: Option<String>,
    pub min_mean_ms: Option<f64>,
    /// slowest | max | total | calls | rows | disk
    pub sort_by: Option<String>,
    /// ASC | DESC
    pub sort_dir: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// One aggregated query entry from pg_stat_statements.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgStatStatementEntry {
    pub query_id: String,
    pub query: String,
    pub calls: i64,
    pub total_exec_time_ms: f64,
    pub mean_exec_time_ms: f64,
    pub min_exec_time_ms: f64,
    pub max_exec_time_ms: f64,
    pub stddev_exec_time_ms: Option<f64>,
    pub rows: i64,
    pub shared_blks_hit: i64,
    pub shared_blks_read: i64,
    pub temp_blks_written: i64,
    pub blk_read_time_ms: Option<f64>,
    pub blk_write_time_ms: Option<f64>,
    pub hit_percent: f64,
    /// Estimated number of calls that likely exceeded 1 second.
    pub slow_call_estimate: i64,
}

/// Paged response for pg_stat_statements list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgStatStatementsPage {
    pub items: Vec<PgStatStatementEntry>,
    pub total_count: i64,
    pub limit: u32,
    pub offset: u32,
    pub has_more: bool,
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

/// Single column within a topology node (includes type + key info)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
}

/// Single table node for schema topology (ER diagram)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyNode {
    pub schema: String,
    pub table_name: String,
    pub row_count: i64,
    pub columns: Vec<TopologyColumn>,
}

/// Foreign key edge for schema topology
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyEdge {
    pub constraint_name: String,
    pub from_schema: String,
    pub from_table: String,
    pub from_column: String,
    pub to_schema: String,
    pub to_table: String,
    pub to_column: String,
}

/// Full topology payload: nodes + edges for one schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyData {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
}

/// Column metadata for ALTER TABLE impact previews.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTablePreviewColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
    /// unchanged | added | removed | modified | renamed
    pub status: String,
    pub detail: Option<String>,
}

/// One table card rendered in the ALTER TABLE impact preview graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTablePreviewNode {
    pub id: String,
    pub schema: String,
    pub table_name: String,
    pub row_count: i64,
    /// current | proposed | dependency | dependent | related
    pub role: String,
    pub note: Option<String>,
    pub columns: Vec<AlterTablePreviewColumn>,
}

/// One relationship edge rendered in the ALTER TABLE impact preview graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTablePreviewEdge {
    pub id: String,
    pub constraint_name: String,
    pub from_node_id: String,
    pub from_column: String,
    pub to_node_id: String,
    pub to_column: String,
    /// current | proposed
    pub phase: String,
    /// unchanged | added | removed | changed
    pub impact: String,
}

/// Human-readable change extracted from an ALTER TABLE statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTableChange {
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub column: Option<String>,
    pub next_column: Option<String>,
    pub destructive: bool,
    pub impacts_data: bool,
}

/// Risk finding produced by the ALTER TABLE assessment engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTableRisk {
    /// info | warn | block
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub mitigation: Option<String>,
}

/// Safer or more operationally-friendly migration alternative.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTableAlternative {
    pub title: String,
    pub summary: String,
    pub sql: String,
    pub reason: String,
}

/// Summary metrics for an ALTER TABLE preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTableImpactSummary {
    pub table_type: String,
    pub row_count: i64,
    pub total_size: String,
    pub table_size: String,
    pub indexes_size: String,
    pub index_count: usize,
    pub trigger_count: usize,
    pub incoming_relations: usize,
    pub outgoing_relations: usize,
    pub operation_count: usize,
    /// low | medium | high | critical
    pub risk_level: String,
    pub risk_score: u8,
}

/// Full payload for the interactive ALTER TABLE preview experience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTablePreview {
    pub focus_schema: String,
    pub focus_table: String,
    pub focus_schema_after: String,
    pub focus_table_after: String,
    pub summary: AlterTableImpactSummary,
    pub nodes: Vec<AlterTablePreviewNode>,
    pub edges: Vec<AlterTablePreviewEdge>,
    pub changes: Vec<AlterTableChange>,
    pub risks: Vec<AlterTableRisk>,
    pub alternatives: Vec<AlterTableAlternative>,
    pub warnings: Vec<String>,
}

// ─── SQL Export ─────────────────────────────────────────────────────────────────

/// What to include in the SQL export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportContentType {
    StructureOnly,
    DataOnly,
    StructureAndData,
}

/// Schema and table pair for export target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTableRef {
    pub schema: String,
    pub table: String,
}

/// Request for db_export_sql. Tables list is explicit; columns/where use "schema.table" keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub connection_id: String,
    /// Schemas to consider (used when resolving "all tables in schemas" on frontend).
    pub schemas: Vec<String>,
    /// Explicit list of (schema, table) to export.
    pub tables: Vec<ExportTableRef>,
    pub content_type: ExportContentType,
    pub compress: bool,
    /// Optional column whitelist per table. Key: "schema.table", value: column names.
    #[serde(default)]
    pub columns: Option<std::collections::HashMap<String, Vec<String>>>,
    /// Optional WHERE clause per table. Key: "schema.table". Value: SQL expression (validated on backend).
    #[serde(default)]
    pub where_clause: Option<std::collections::HashMap<String, String>>,
    /// If set, write to this path; otherwise temp dir.
    #[serde(default)]
    pub output_path: Option<String>,
}

/// Result of a successful export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub output_path: String,
    pub bytes_written: u64,
}

/// Progress event payload for db-export-progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportProgressPayload {
    pub phase: String, // "schema" | "table" | "rows"
    pub message: String,
    pub current: u32,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_exported: Option<u64>,
}

// ── Schema import types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedTable {
    pub name: String,
    pub estimated_rows: i64,
    pub comment: Option<String>,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedView {
    pub name: String,
    pub is_materialized: bool,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedIndex {
    pub name: String,
    pub table_name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedFunction {
    pub name: String,
    pub kind: String,
    pub arguments: String,
    pub return_type: String,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedTrigger {
    pub name: String,
    pub table_name: String,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedSequence {
    pub name: String,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaImportResult {
    pub schema: String,
    pub tables: Vec<ImportedTable>,
    pub views: Vec<ImportedView>,
    pub indexes: Vec<ImportedIndex>,
    pub functions: Vec<ImportedFunction>,
    pub triggers: Vec<ImportedTrigger>,
    pub sequences: Vec<ImportedSequence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbImportResult {
    pub database: String,
    pub schemas: Vec<SchemaImportResult>,
    pub total_tables: usize,
    pub total_views: usize,
    pub total_functions: usize,
    pub total_indexes: usize,
    pub total_triggers: usize,
    pub total_sequences: usize,
}

/// Progress event for schema import
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaImportProgress {
    pub phase: String, // "scanning" | "tables" | "views" | "functions" | "indexes" | "triggers" | "sequences" | "done"
    pub schema: String,
    pub message: String,
    pub current: u32,
    pub total: u32,
}
